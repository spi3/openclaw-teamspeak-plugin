import { spawn } from "node:child_process";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createChannelPluginBase,
  createChatChannelPlugin,
  defineChannelPluginEntry
} from "openclaw/plugin-sdk/core";
import { loadSessionStore, resolveSessionStoreEntry } from "openclaw/plugin-sdk/config-runtime";
import { dispatchInboundReplyWithBase } from "openclaw/plugin-sdk/inbound-reply-dispatch";
import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";
import { readJsonWebhookBodyOrReject } from "openclaw/plugin-sdk/webhook-ingress";

const CHANNEL_ID = "teamspeak";
const DEFAULT_ACCOUNT_ID = "default";
const DEFAULT_TS_CLI_COMMAND = "ts";
const DEFAULT_DAEMON_POLL_MS = 1000;
const DEFAULT_INGRESS_PATH = "/plugins/teamspeak/inbound";
const TEAMSPEAK_CLI_ENV_VARS = ["OPENCLAW_TEAMSPEAK_CLI_PATH", "TEAMSPEAK_CLI_PATH", "TS_CLI_PATH"];
const ROUTE_CACHE_LIMIT = 256;
const DEDUPE_TTL_MS = 60 * 1000;
const DAEMON_RESTART_DELAY_MS = 2000;
const VOICE_RECONNECT_DELAY_MS = 2000;
const VOICE_RECONNECT_MAX_DELAY_MS = 60 * 1000;
const VOICE_RECONNECT_LOG_INTERVAL_MS = 30 * 1000;
const VOICE_START_DELAY_MS = 5000;
const VOICE_DEFAULT_SILENCE_TIMEOUT_MS = 1200;
const VOICE_WAKE_CACHE_TTL_MS = 30 * 1000;
const PLAYBACK_SAMPLE_RATE = 48000;
const PLAYBACK_CHANNELS = 1;
const PLAYBACK_FORMAT = "pcm_s16le";
const PLAYBACK_CHUNK_FRAMES = 960;
const PLAYBACK_CHUNK_DURATION_MS = Math.round((PLAYBACK_CHUNK_FRAMES * 1000) / PLAYBACK_SAMPLE_RATE);
const PLAYBACK_TARGET_BUFFER_MS = 120;
const PLAYBACK_MAX_QUEUE_BUFFER_MS = 220;
const PLAYBACK_STATUS_POLL_INTERVAL_MS = 80;
const PLAYBACK_QUEUE_WAIT_SLICE_MS = 10;
const VOICE_REPLY_FIRST_CHUNK_MIN_CHARS = 24;
const VOICE_REPLY_CHUNK_MIN_CHARS = 48;
const VOICE_REPLY_CHUNK_SOFT_MAX_CHARS = 160;
const TEAMSPEAK_CHANNEL_SESSION_ID = "all";
const TEAMSPEAK_CHANNEL_CONVERSATION_LABEL = "TeamSpeak channel";
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const HOOK_RELAY_PATH = path.join(MODULE_DIR, "hook-relay.js");

const runtimeStore = createPluginRuntimeStore({
  pluginId: CHANNEL_ID,
  errorMessage: "TeamSpeak plugin runtime is not initialized"
});

const SELF_IDENTITY_TTL_MS = 15 * 1000;

const sharedState = {
  daemonChild: null,
  daemonOwned: false,
  daemonRestartTimer: null,
  ingressSecret: "",
  routeStateDir: "",
  serviceConfig: null,
  stopping: false,
  routeCache: {
    dmByUid: new Map(),
    channelById: new Map()
  },
  dedupeSeenAt: new Map(),
  selfIdentity: {
    refreshedAt: 0,
    uid: "",
    clientId: "",
    nickname: ""
  },
  voice: {
    socket: null,
    startTimer: null,
    reconnectTimer: null,
    reconnectDelayMs: VOICE_RECONNECT_DELAY_MS,
    reconnectAttempt: 0,
    lastReconnectDelayMs: 0,
    lastConnectionFailureKey: "",
    lastConnectionFailureLogAt: 0,
    suppressedConnectionFailures: 0,
    buffer: Buffer.alloc(0),
    startupError: "",
    connected: false,
    connecting: false,
    mediaSocketPath: "",
    mediaFormat: "",
    mediaTransport: "",
    lastHelloAt: 0,
    lastStatusAt: 0,
    playbackActive: false,
    queuedPlaybackSamples: 0,
    playbackErrorSeq: 0,
    activeSpeakerCount: 0,
    droppedIngressChunks: 0,
    droppedPlaybackChunks: 0,
    lastError: "",
    wakeTriggers: [],
    wakeFetchedAt: 0,
    speakers: new Map(),
    utteranceSeq: 0,
    playbackGeneration: 0,
    lastPlaybackMetrics: null,
    lastTranscriptionMetrics: null,
    lastPromptGuidance: null,
    stateDir: ""
  }
};

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeOptionalString(value) {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim();
}

function normalizeBoolean(value, fallback) {
  return typeof value === "boolean" ? value : fallback;
}

function normalizePositiveInteger(value, fallback) {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isInteger(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return fallback;
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => normalizeOptionalString(entry))
    .filter(Boolean);
}

function normalizeTeamspeakVoiceMode(value) {
  const normalized = normalizeOptionalString(value).toLowerCase();
  if (
    normalized === "always_on" ||
    normalized === "wake_word" ||
    normalized === "push_to_talk" ||
    normalized === "wake_or_ptt"
  ) {
    return normalized;
  }
  return "wake_word";
}

function normalizeTeamspeakInterruptMode(value) {
  const normalized = normalizeOptionalString(value).toLowerCase();
  if (normalized === "wake_word" || normalized === "any_speech") {
    return normalized;
  }
  return "any_speech";
}

function normalizeTeamspeakVoiceConfig(value) {
  const voiceConfig = isRecord(value) ? value : {};
  return {
    enabled: normalizeBoolean(voiceConfig.enabled, false),
    mode: normalizeTeamspeakVoiceMode(voiceConfig.mode),
    silenceTimeoutMs: normalizePositiveInteger(
      voiceConfig.silenceTimeoutMs,
      VOICE_DEFAULT_SILENCE_TIMEOUT_MS
    ),
    interruptOnSpeech: normalizeBoolean(voiceConfig.interruptOnSpeech, true),
    interruptMode: normalizeTeamspeakInterruptMode(voiceConfig.interruptMode),
    stripWakeWord: normalizeBoolean(voiceConfig.stripWakeWord, true),
    allowedHandlers: normalizeStringArray(voiceConfig.allowedHandlers),
    allowedChannels: normalizeStringArray(voiceConfig.allowedChannels),
    allowedUsers: normalizeStringArray(voiceConfig.allowedUsers),
    mediaSocketPath: normalizeOptionalString(voiceConfig.mediaSocketPath),
    mirrorTextReplies: normalizeBoolean(voiceConfig.mirrorTextReplies, false),
    transcriptionLanguage: normalizeOptionalString(voiceConfig.transcriptionLanguage),
    raw: voiceConfig
  };
}

function normalizeTeamspeakSessionDefaults(value) {
  const sessionDefaults = isRecord(value) ? value : {};
  const thinkingLevel = normalizeOptionalString(sessionDefaults.thinkingLevel).toLowerCase();
  return {
    model: normalizeOptionalString(sessionDefaults.model),
    fastMode: typeof sessionDefaults.fastMode === "boolean" ? sessionDefaults.fastMode : null,
    thinkingLevel,
    raw: sessionDefaults
  };
}

function normalizeIngressPath(value) {
  const trimmed = normalizeOptionalString(value);
  if (!trimmed) {
    return DEFAULT_INGRESS_PATH;
  }
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function resolveTeamspeakCliPath(channelConfig) {
  const configured = normalizeOptionalString(channelConfig?.cliPath);
  if (configured) {
    return configured;
  }
  for (const envName of TEAMSPEAK_CLI_ENV_VARS) {
    const envValue = normalizeOptionalString(process.env[envName]);
    if (envValue) {
      return envValue;
    }
  }
  return DEFAULT_TS_CLI_COMMAND;
}

function executableExists(command) {
  const normalized = normalizeOptionalString(command);
  if (!normalized) {
    return false;
  }
  if (normalized.includes(path.sep) || path.isAbsolute(normalized)) {
    return fs.existsSync(normalized);
  }
  const pathValue = normalizeOptionalString(process.env.PATH);
  if (!pathValue) {
    return false;
  }
  for (const entry of pathValue.split(path.delimiter)) {
    const base = normalizeOptionalString(entry);
    if (!base) {
      continue;
    }
    if (fs.existsSync(path.join(base, normalized))) {
      return true;
    }
  }
  return false;
}

function resolveTeamspeakChannelConfig(cfg) {
  const channelConfig = isRecord(cfg?.channels?.[CHANNEL_ID]) ? cfg.channels[CHANNEL_ID] : {};
  const cliPath = resolveTeamspeakCliPath(channelConfig);
  return {
    accountId: DEFAULT_ACCOUNT_ID,
    enabled: normalizeBoolean(channelConfig.enabled, true),
    configured: executableExists(cliPath),
    cliPath,
    profile: normalizeOptionalString(channelConfig.profile),
    server: normalizeOptionalString(channelConfig.server),
    nickname: normalizeOptionalString(channelConfig.nickname),
    identity: normalizeOptionalString(channelConfig.identity),
    configPath: normalizeOptionalString(channelConfig.configPath),
    defaultTo: normalizeOptionalString(channelConfig.defaultTo),
    ingressPath: normalizeIngressPath(channelConfig.ingressPath),
    daemonPollMs: normalizePositiveInteger(channelConfig.daemonPollMs, DEFAULT_DAEMON_POLL_MS),
    sessionDefaults: normalizeTeamspeakSessionDefaults(channelConfig.sessionDefaults),
    voice: normalizeTeamspeakVoiceConfig(channelConfig.voice),
    raw: channelConfig
  };
}

function buildSessionDefaultsPatchParams(sessionDefaults) {
  if (!isRecord(sessionDefaults)) {
    return null;
  }
  const params = {};
  const model = normalizeOptionalString(sessionDefaults.model);
  if (model) {
    params.model = model;
  }
  if (typeof sessionDefaults.fastMode === "boolean") {
    params.fastMode = sessionDefaults.fastMode;
  }
  const thinkingLevel = normalizeOptionalString(sessionDefaults.thinkingLevel).toLowerCase();
  if (thinkingLevel) {
    params.thinkingLevel = thinkingLevel;
  }
  return Object.keys(params).length > 0 ? params : null;
}

async function maybeApplyTeamspeakSessionDefaults({ storePath, sessionKey, sessionDefaults, logger }) {
  const patchParams = buildSessionDefaultsPatchParams(sessionDefaults);
  if (!storePath || !sessionKey || !patchParams) {
    return;
  }
  const existingEntry = resolveSessionStoreEntry({
    store: loadSessionStore(storePath),
    sessionKey
  }).existing;
  const currentModel = normalizeOptionalString(existingEntry?.modelOverride) || normalizeOptionalString(existingEntry?.model);
  const currentThinkingLevel = normalizeOptionalString(existingEntry?.thinkingLevel).toLowerCase();
  const currentFastMode = typeof existingEntry?.fastMode === "boolean" ? existingEntry.fastMode : null;
  const needsPatch =
    (typeof patchParams.model === "string" && patchParams.model !== currentModel) ||
    (typeof patchParams.thinkingLevel === "string" && patchParams.thinkingLevel !== currentThinkingLevel) ||
    (typeof patchParams.fastMode === "boolean" && patchParams.fastMode !== currentFastMode);
  if (!needsPatch) {
    return;
  }
  try {
    await callGatewayJson("sessions.patch", {
      key: sessionKey,
      ...patchParams
    });
  } catch (error) {
    logger.error?.(`[teamspeak] failed to apply session defaults for ${sessionKey}: ${String(error)}`);
  }
}

function buildTsGlobalArgs(account, options = {}) {
  const args = [];
  if (options.json) {
    args.push("--json");
  }
  if (account.profile) {
    args.push("--profile", account.profile);
  }
  if (account.server) {
    args.push("--server", account.server);
  }
  if (account.nickname) {
    args.push("--nickname", account.nickname);
  }
  if (account.identity) {
    args.push("--identity", account.identity);
  }
  if (account.configPath) {
    args.push("--config", account.configPath);
  }
  return args;
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      ...options.spawnOptions
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({
          code,
          stdout,
          stderr
        });
        return;
      }
      const error = new Error(
        `${command} ${args.join(" ")} failed with exit code ${code ?? "unknown"}: ${stderr.trim() || stdout.trim()}`
      );
      error.stdout = stdout;
      error.stderr = stderr;
      reject(error);
    });
    if (options.stdin !== undefined) {
      child.stdin.end(options.stdin);
      return;
    }
    child.stdin.end();
  });
}

async function runTsJson(account, subcommandArgs) {
  const result = await runCommand(account.cliPath, [
    ...buildTsGlobalArgs(account, { json: true }),
    ...subcommandArgs
  ]);
  const stdout = result.stdout.trim();
  return stdout ? JSON.parse(stdout) : null;
}

async function runTsText(account, subcommandArgs) {
  return await runCommand(account.cliPath, [
    ...buildTsGlobalArgs(account),
    ...subcommandArgs
  ]);
}

async function callGatewayJsonViaCli(method, params) {
  const args = ["gateway", "call", method, "--json", "--timeout", "30000"];
  if (params !== undefined) {
    args.push("--params", JSON.stringify(params));
  }
  const result = await runCommand("openclaw", args);
  const stdout = result.stdout.trim();
  return stdout ? JSON.parse(stdout) : null;
}

async function callGatewayJson(method, params) {
  return await callGatewayJsonViaCli(method, params);
}

function hexEncode(value) {
  return Buffer.from(String(value ?? ""), "utf8").toString("hex");
}

function hexDecode(value) {
  const normalized = normalizeOptionalString(value);
  if (!normalized) {
    return "";
  }
  try {
    return Buffer.from(normalized, "hex").toString("utf8");
  } catch {
    return "";
  }
}

function deriveMediaSocketPathFromControlPath(controlSocketPath) {
  const control =
    normalizeOptionalString(controlSocketPath) ||
    process.env.TS_CONTROL_SOCKET_PATH ||
    (process.env.XDG_RUNTIME_DIR
      ? path.join(process.env.XDG_RUNTIME_DIR, "ts3cli.sock")
      : process.env.TMPDIR
        ? path.join(process.env.TMPDIR, `ts3cli-${process.getuid?.() ?? "unknown"}.sock`)
        : `/tmp/ts3cli-${process.getuid?.() ?? "unknown"}.sock`);
  if (control.endsWith(".sock")) {
    return `${control.slice(0, -5)}-media.sock`;
  }
  return `${control}.media`;
}

async function resolveTeamspeakPluginInfo(cfg, logger) {
  const account = resolveTeamspeakChannelConfig(cfg);
  const configuredVoicePath = normalizeOptionalString(account.voice.mediaSocketPath);
  if (configuredVoicePath) {
    return {
      mediaSocketPath: configuredVoicePath,
      mediaFormat: `${PLAYBACK_FORMAT}_${PLAYBACK_SAMPLE_RATE}_${PLAYBACK_CHANNELS}`,
      mediaTransport: "unix-stream/frame-v1"
    };
  }
  try {
    const pluginInfo = await runTsJson(account, ["plugin", "info"]);
    if (isRecord(pluginInfo)) {
      const mediaSocketPath = normalizeOptionalString(pluginInfo.media_socket_path);
      if (mediaSocketPath) {
        return {
          mediaSocketPath,
          mediaFormat: normalizeOptionalString(pluginInfo.media_format),
          mediaTransport: normalizeOptionalString(pluginInfo.media_transport)
        };
      }
    }
  } catch (error) {
    logger.warn?.(`[teamspeak voice] ts plugin info failed, falling back to config/env: ${String(error)}`);
  }
  try {
    const configView = await runTsJson(account, ["config", "view"]);
    if (isRecord(configView)) {
      const activeProfile = normalizeOptionalString(configView.active_profile);
      const profiles = Array.isArray(configView.profiles) ? configView.profiles : [];
      const active = profiles.find((entry) => isRecord(entry) && normalizeOptionalString(entry.name) === activeProfile);
      const controlSocketPath = isRecord(active) ? normalizeOptionalString(active.control_socket_path) : "";
      return {
        mediaSocketPath: process.env.TS_MEDIA_SOCKET_PATH || deriveMediaSocketPathFromControlPath(controlSocketPath),
        mediaFormat: `${PLAYBACK_FORMAT}_${PLAYBACK_SAMPLE_RATE}_${PLAYBACK_CHANNELS}`,
        mediaTransport: "unix-stream/frame-v1"
      };
    }
  } catch (error) {
    logger.warn?.(`[teamspeak voice] ts config view fallback failed: ${String(error)}`);
  }
  const mediaSocketPath = process.env.TS_MEDIA_SOCKET_PATH || deriveMediaSocketPathFromControlPath("");
  return {
    mediaSocketPath,
    mediaFormat: `${PLAYBACK_FORMAT}_${PLAYBACK_SAMPLE_RATE}_${PLAYBACK_CHANNELS}`,
    mediaTransport: "unix-stream/frame-v1"
  };
}

function ensureVoiceStateDir(stateDir) {
  const target = path.join(stateDir, "voice");
  fs.mkdirSync(target, { recursive: true });
  return target;
}

function clearVoiceReconnectTimer() {
  if (sharedState.voice.reconnectTimer) {
    clearTimeout(sharedState.voice.reconnectTimer);
    sharedState.voice.reconnectTimer = null;
  }
}

function clearVoiceStartTimer() {
  if (sharedState.voice.startTimer) {
    clearTimeout(sharedState.voice.startTimer);
    sharedState.voice.startTimer = null;
  }
}

function getVoiceReconnectDelayMs() {
  const baseDelayMs = Math.max(1, sharedState.voice.reconnectDelayMs || VOICE_RECONNECT_DELAY_MS);
  const attempt = Math.max(0, sharedState.voice.reconnectAttempt);
  const multiplier = 2 ** Math.min(attempt, 6);
  return Math.min(VOICE_RECONNECT_MAX_DELAY_MS, baseDelayMs * multiplier);
}

function formatVoiceReconnectDelay(delayMs) {
  return delayMs >= 1000 ? `${Math.round(delayMs / 1000)}s` : `${delayMs}ms`;
}

function resetVoiceReconnectBackoff() {
  sharedState.voice.reconnectAttempt = 0;
  sharedState.voice.lastReconnectDelayMs = 0;
  sharedState.voice.lastConnectionFailureKey = "";
  sharedState.voice.lastConnectionFailureLogAt = 0;
  sharedState.voice.suppressedConnectionFailures = 0;
}

function logVoiceConnectionFailure(logger, message, delayMs) {
  const failureKey = normalizeOptionalString(message) || "media socket connection failed";
  const now = Date.now();
  const sameFailure = sharedState.voice.lastConnectionFailureKey === failureKey;
  const recentFailure =
    sameFailure && now - sharedState.voice.lastConnectionFailureLogAt < VOICE_RECONNECT_LOG_INTERVAL_MS;
  if (recentFailure) {
    sharedState.voice.suppressedConnectionFailures += 1;
    return;
  }
  const suppressed = sameFailure ? sharedState.voice.suppressedConnectionFailures : 0;
  sharedState.voice.lastConnectionFailureKey = failureKey;
  sharedState.voice.lastConnectionFailureLogAt = now;
  sharedState.voice.suppressedConnectionFailures = 0;
  const suppressedText = suppressed > 0 ? ` (${suppressed} repeated failures suppressed)` : "";
  const retryText = delayMs > 0 ? `; retrying in ${formatVoiceReconnectDelay(delayMs)}` : "";
  logger.warn?.(`[teamspeak voice] ${failureKey}${suppressedText}${retryText}`);
}

function scheduleTeamspeakVoiceManagerStart(cfg, stateDir, logger) {
  clearVoiceStartTimer();
  sharedState.voice.startTimer = setTimeout(() => {
    sharedState.voice.startTimer = null;
    if (sharedState.stopping || !resolveTeamspeakChannelConfig(cfg).voice.enabled) {
      return;
    }
    startTeamspeakVoiceManager(cfg, stateDir, logger).catch((error) => {
      const failureMessage = `delayed voice manager start failed: ${String(error)}`;
      sharedState.voice.startupError = failureMessage;
      logger.warn?.(`[teamspeak voice] ${failureMessage}`);
      scheduleVoiceReconnect(cfg, logger, failureMessage);
    });
  }, VOICE_START_DELAY_MS);
  sharedState.voice.startTimer.unref?.();
  logger.info?.(`[teamspeak voice] scheduled voice manager start in ${formatVoiceReconnectDelay(VOICE_START_DELAY_MS)}`);
}

function clearSpeakerFinalizeTimer(speakerState) {
  if (speakerState?.finalizeTimer) {
    clearTimeout(speakerState.finalizeTimer);
    speakerState.finalizeTimer = null;
  }
}

function speakerKeyForFrame(frame) {
  return [frame.handlerId, frame.clientId || frame.uid || frame.nickname || "unknown"].join(":");
}

function parseMediaFrameFields(fields) {
  return {
    type: fields[1] || "",
    timestamp: Number.parseInt(fields[2] || "", 10) || Date.now(),
    handlerId: normalizeOptionalString(fields[3]),
    clientId: normalizeOptionalString(fields[4]),
    uid: hexDecode(fields[5]),
    nickname: hexDecode(fields[6]),
    channelId: normalizeOptionalString(fields[7]),
    sampleRate: Number.parseInt(fields[8] || "", 10) || PLAYBACK_SAMPLE_RATE,
    channels: Number.parseInt(fields[9] || "", 10) || 1,
    frameCount: Number.parseInt(fields[10] || "", 10) || 0,
    payloadBytes: Number.parseInt(fields[11] || "", 10) || 0
  };
}

function parseWavPcmToFloat32(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 44) {
    throw new Error("audio buffer is not a valid WAV file");
  }
  if (buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("only WAV output is supported for TeamSpeak playback");
  }
  let offset = 12;
  let fmt = null;
  let data = null;
  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString("ascii", offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const chunkStart = offset + 8;
    const chunkEnd = chunkStart + chunkSize;
    if (chunkEnd > buffer.length) {
      break;
    }
    if (chunkId === "fmt ") {
      fmt = {
        audioFormat: buffer.readUInt16LE(chunkStart),
        channels: buffer.readUInt16LE(chunkStart + 2),
        sampleRate: buffer.readUInt32LE(chunkStart + 4),
        bitsPerSample: buffer.readUInt16LE(chunkStart + 14)
      };
    } else if (chunkId === "data") {
      data = buffer.subarray(chunkStart, chunkEnd);
    }
    offset = chunkEnd + (chunkSize % 2);
  }
  if (!fmt || !data) {
    throw new Error("WAV output is missing fmt or data chunks");
  }
  const bytesPerSample = Math.max(1, Math.floor(fmt.bitsPerSample / 8));
  const frameCount = Math.floor(data.length / Math.max(1, bytesPerSample * fmt.channels));
  const samples = new Float32Array(frameCount * fmt.channels);
  for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
    for (let channelIndex = 0; channelIndex < fmt.channels; channelIndex += 1) {
      const sampleOffset = frameIndex * fmt.channels * bytesPerSample + channelIndex * bytesPerSample;
      let sample = 0;
      if (fmt.audioFormat === 1 && fmt.bitsPerSample === 16) {
        sample = data.readInt16LE(sampleOffset) / 32768;
      } else if (fmt.audioFormat === 1 && fmt.bitsPerSample === 8) {
        sample = (data.readUInt8(sampleOffset) - 128) / 128;
      } else if (fmt.audioFormat === 1 && fmt.bitsPerSample === 24) {
        sample = data.readIntLE(sampleOffset, 3) / 8388608;
      } else if (fmt.audioFormat === 1 && fmt.bitsPerSample === 32) {
        sample = data.readInt32LE(sampleOffset) / 2147483648;
      } else if (fmt.audioFormat === 3 && fmt.bitsPerSample === 32) {
        sample = data.readFloatLE(sampleOffset);
      } else {
        throw new Error(`unsupported WAV format ${fmt.audioFormat}/${fmt.bitsPerSample}`);
      }
      samples[frameIndex * fmt.channels + channelIndex] = Math.max(-1, Math.min(1, sample));
    }
  }
  return {
    samples,
    sampleRate: fmt.sampleRate,
    channels: fmt.channels
  };
}

function mixToMono(samples, channels) {
  if (channels <= 1) {
    return samples;
  }
  const frameCount = Math.floor(samples.length / channels);
  const mono = new Float32Array(frameCount);
  for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
    let sum = 0;
    for (let channelIndex = 0; channelIndex < channels; channelIndex += 1) {
      sum += samples[frameIndex * channels + channelIndex];
    }
    mono[frameIndex] = sum / channels;
  }
  return mono;
}

function resampleFloat32Mono(samples, inputSampleRate, outputSampleRate) {
  if (inputSampleRate === outputSampleRate) {
    return samples;
  }
  const outputLength = Math.max(1, Math.round((samples.length * outputSampleRate) / inputSampleRate));
  const output = new Float32Array(outputLength);
  for (let index = 0; index < outputLength; index += 1) {
    const position = (index * inputSampleRate) / outputSampleRate;
    const left = Math.floor(position);
    const right = Math.min(samples.length - 1, left + 1);
    const mix = position - left;
    output[index] = samples[left] * (1 - mix) + samples[right] * mix;
  }
  return output;
}

function float32ToPcm16Buffer(samples) {
  const output = Buffer.alloc(samples.length * 2);
  for (let index = 0; index < samples.length; index += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[index]));
    const value = clamped < 0 ? Math.round(clamped * 32768) : Math.round(clamped * 32767);
    output.writeInt16LE(value, index * 2);
  }
  return output;
}

function convertWavToTeamspeakPlayback(buffer) {
  const parsed = parseWavPcmToFloat32(buffer);
  const mono = mixToMono(parsed.samples, parsed.channels);
  const resampled = resampleFloat32Mono(mono, parsed.sampleRate, PLAYBACK_SAMPLE_RATE);
  return float32ToPcm16Buffer(resampled);
}

function buildWavBufferFromPcm({ pcmBuffer, sampleRate, channels }) {
  const byteRate = sampleRate * channels * 2;
  const blockAlign = channels * 2;
  const buffer = Buffer.alloc(44 + pcmBuffer.length);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + pcmBuffer.length, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(pcmBuffer.length, 40);
  pcmBuffer.copy(buffer, 44);
  return buffer;
}

function buildMediaHeader(fields) {
  return Buffer.from(`${fields.join("\t")}\n`, "utf8");
}

function writeMediaFrame(fields, payload = null, socketOverride = null) {
  const socket = socketOverride || sharedState.voice.socket;
  if (!socket || socket.destroyed) {
    throw new Error("TeamSpeak voice media socket is not connected");
  }
  socket.write(buildMediaHeader(fields));
  if (payload?.length) {
    socket.write(payload);
  }
}

function requestMediaStatus(socketOverride = null) {
  writeMediaFrame(["tsmedia1", "status.request"], null, socketOverride);
}

async function refreshVoiceWakeTriggers(logger, force = false) {
  const now = Date.now();
  if (!force && now - sharedState.voice.wakeFetchedAt < VOICE_WAKE_CACHE_TTL_MS) {
    return sharedState.voice.wakeTriggers;
  }
  try {
    const payload = await callGatewayJson("voicewake.get");
    sharedState.voice.wakeTriggers = Array.isArray(payload?.triggers)
      ? payload.triggers.map((entry) => normalizeOptionalString(entry)).filter(Boolean)
      : [];
    sharedState.voice.wakeFetchedAt = now;
  } catch (error) {
    logger.warn?.(`[teamspeak voice] failed to refresh voicewake triggers: ${String(error)}`);
  }
  return sharedState.voice.wakeTriggers;
}

function findWakeWordMatch(text, triggers) {
  const normalizedText = normalizeOptionalString(text);
  const loweredText = normalizedText.toLowerCase();
  for (const trigger of triggers) {
    const normalizedTrigger = normalizeOptionalString(trigger).toLowerCase();
    if (!normalizedTrigger) {
      continue;
    }
    if (!loweredText.startsWith(normalizedTrigger)) {
      continue;
    }
    const nextChar = loweredText.charAt(normalizedTrigger.length);
    if (nextChar && /[a-z0-9]/i.test(nextChar)) {
      continue;
    }
    const stripped = normalizedText
      .slice(normalizedTrigger.length)
      .replace(/^[\s,.:;!?-]+/, "")
      .trim();
    return {
      trigger,
      stripped
    };
  }
  return null;
}

async function evaluateVoiceAcceptance({ cfg, speaker, transcript, logger }) {
  const account = resolveTeamspeakChannelConfig(cfg);
  const voiceConfig = account.voice;
  const trimmedTranscript = normalizeOptionalString(transcript);
  if (!trimmedTranscript) {
    return {
      accepted: false,
      reason: "empty-transcript"
    };
  }
  if (voiceConfig.allowedHandlers.length > 0 && !voiceConfig.allowedHandlers.includes(speaker.handlerId)) {
    return {
      accepted: false,
      reason: "handler-not-allowed"
    };
  }
  if (voiceConfig.allowedChannels.length > 0) {
    const channelId = normalizeOptionalString(speaker.channelId);
    if (!channelId || !voiceConfig.allowedChannels.includes(channelId)) {
      return {
        accepted: false,
        reason: "channel-not-allowed"
      };
    }
  }
  if (voiceConfig.allowedUsers.length > 0) {
    const userCandidates = [speaker.uid, `uid:${speaker.uid}`, speaker.clientId, `client:${speaker.clientId}`]
      .map((entry) => normalizeOptionalString(entry))
      .filter(Boolean);
    if (!userCandidates.some((entry) => voiceConfig.allowedUsers.includes(entry))) {
      return {
        accepted: false,
        reason: "user-not-allowed"
      };
    }
  }
  if (voiceConfig.mode === "always_on") {
    return {
      accepted: true,
      text: trimmedTranscript,
      wakeMatched: false
    };
  }
  if (voiceConfig.mode === "push_to_talk") {
    logger.warn?.("[teamspeak voice] push_to_talk mode is configured, but TeamSpeak V1 media frames do not expose PTT state; dropping utterance");
    return {
      accepted: false,
      reason: "push-to-talk-not-supported"
    };
  }
  const triggers = await refreshVoiceWakeTriggers(logger);
  const wakeMatch = findWakeWordMatch(trimmedTranscript, triggers);
  if (!wakeMatch) {
    return {
      accepted: false,
      reason: "wake-word-not-matched"
    };
  }
  return {
    accepted: true,
    text: voiceConfig.stripWakeWord ? wakeMatch.stripped || trimmedTranscript : trimmedTranscript,
    wakeMatched: true,
    trigger: wakeMatch.trigger
  };
}

function isRetriableGoogleTtsError(error) {
  const message = normalizeOptionalString(error?.message || error).toLowerCase();
  return message.includes("google tts response missing audio data");
}

async function sleepMs(delayMs) {
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}

function pcmBufferDurationMs(pcmBuffer, sampleRate = PLAYBACK_SAMPLE_RATE, channels = PLAYBACK_CHANNELS) {
  if (!Buffer.isBuffer(pcmBuffer) || pcmBuffer.length === 0 || sampleRate <= 0 || channels <= 0) {
    return 0;
  }
  const frameCount = pcmBuffer.length / Math.max(1, channels * 2);
  return Math.round((frameCount * 1000) / sampleRate);
}

function queuedPlaybackBufferMs() {
  return Math.max(0, Math.round((sharedState.voice.queuedPlaybackSamples * 1000) / PLAYBACK_SAMPLE_RATE));
}

function resolveConfiguredAudioTranscriptionTarget(cfg) {
  const audioConfig = isRecord(cfg?.tools?.media?.audio) ? cfg.tools.media.audio : {};
  const modelEntry = Array.isArray(audioConfig.models) ? audioConfig.models.find((entry) => isRecord(entry)) : null;
  const provider = normalizeOptionalString(modelEntry?.provider) || undefined;
  const providerConfig = provider && isRecord(cfg?.models?.providers?.[provider]) ? cfg.models.providers[provider] : {};
  const requestConfig = isRecord(modelEntry?.request)
    ? modelEntry.request
    : isRecord(audioConfig.request)
      ? audioConfig.request
      : isRecord(providerConfig?.request)
        ? providerConfig.request
        : {};
  const model = normalizeOptionalString(modelEntry?.model) || undefined;
  const baseUrl =
    normalizeOptionalString(modelEntry?.baseUrl) ||
    normalizeOptionalString(audioConfig.baseUrl) ||
    normalizeOptionalString(providerConfig?.baseUrl) ||
    undefined;
  const allowPrivateNetwork = requestConfig.allowPrivateNetwork === true ? true : undefined;
  const providerModel = provider && model ? `${provider}/${model}` : provider || model;
  return {
    provider,
    model,
    baseUrl,
    allowPrivateNetwork,
    hint: providerModel && baseUrl ? `${providerModel} @ ${baseUrl}` : providerModel || baseUrl
  };
}

async function waitForSocketDrain(socket) {
  if (!socket || socket.destroyed) {
    throw new Error("TeamSpeak voice media socket disconnected while waiting for drain");
  }
  try {
    await once(socket, "drain");
  } catch (error) {
    throw new Error(`TeamSpeak voice media socket drain wait failed: ${String(error)}`);
  }
  if (socket.destroyed) {
    throw new Error("TeamSpeak voice media socket disconnected before drain completed");
  }
}

async function writeMediaFrameWithBackpressure(fields, payload = null, socketOverride = null) {
  const socket = socketOverride || sharedState.voice.socket;
  if (!socket || socket.destroyed) {
    throw new Error("TeamSpeak voice media socket is not connected");
  }
  let backpressureWaits = 0;
  const header = buildMediaHeader(fields);
  if (!socket.write(header)) {
    backpressureWaits += 1;
    await waitForSocketDrain(socket);
  }
  if (payload?.length && !socket.write(payload)) {
    backpressureWaits += 1;
    await waitForSocketDrain(socket);
  }
  return {
    backpressureWaits
  };
}

async function synthesizeTeamspeakReplyAudio(text, logger = null) {
  const startedAt = Date.now();
  const maxAttempts = 2;
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const payload = await callGatewayJson("talk.speak", { text });
      const audioBase64 = normalizeOptionalString(payload?.audioBase64);
      if (!audioBase64) {
        throw new Error("talk.speak returned no audio payload");
      }
      const audioBuffer = Buffer.from(audioBase64, "base64");
      const outputFormat = normalizeOptionalString(payload?.outputFormat).toLowerCase();
      const fileExtension = normalizeOptionalString(payload?.fileExtension).toLowerCase();
      if (outputFormat !== "wav" && fileExtension !== "wav") {
        throw new Error(`talk.speak returned unsupported format ${outputFormat || fileExtension || "unknown"}; only wav is supported for TeamSpeak playback right now`);
      }
      const pcmBuffer = convertWavToTeamspeakPlayback(audioBuffer);
      if (attempt > 1) {
        logger?.info?.(`[teamspeak voice] talk.speak succeeded on retry ${attempt}/${maxAttempts}`);
      }
      return {
        pcmBuffer,
        ttsMs: Date.now() - startedAt,
        wavBytes: audioBuffer.length,
        audioDurationMs: pcmBufferDurationMs(pcmBuffer)
      };
    } catch (error) {
      lastError = error;
      if (attempt >= maxAttempts || !isRetriableGoogleTtsError(error)) {
        throw error;
      }
      logger?.warn?.(`[teamspeak voice] talk.speak returned empty Google audio; retrying (${attempt}/${maxAttempts})`);
      await sleepMs(400);
    }
  }
  throw lastError || new Error("talk.speak failed");
}

async function waitForTeamspeakPlaybackStart(logger, generation, expectedErrorSeq, timeoutMs = 750) {
  const deadlineAt = Date.now() + timeoutMs;
  let statusRequested = false;
  while (Date.now() < deadlineAt) {
    if (generation !== sharedState.voice.playbackGeneration) {
      throw new Error("TeamSpeak playback was interrupted before the bridge acknowledged playback.start");
    }
    if (!sharedState.voice.connected || !sharedState.voice.socket || sharedState.voice.socket.destroyed) {
      throw new Error("TeamSpeak voice media socket disconnected before playback started");
    }
    if (sharedState.voice.playbackActive) {
      return;
    }
    if (sharedState.voice.playbackErrorSeq !== expectedErrorSeq) {
      throw new Error(`TeamSpeak media bridge rejected playback.start: ${sharedState.voice.lastError || "unknown playback error"}`);
    }
    if (!statusRequested || Date.now() + 150 >= deadlineAt) {
      statusRequested = true;
      try {
        requestMediaStatus();
      } catch {
      }
    }
    await sleepMs(25);
  }
  throw new Error(`TeamSpeak media bridge did not acknowledge playback.start within ${timeoutMs}ms`);
}

async function playbackTeamspeakAudioBuffer(pcmBuffer, logger, generation) {
  if (generation !== sharedState.voice.playbackGeneration) {
    return null;
  }
  const playbackStartedAt = Date.now();
  const startingDroppedPlaybackChunks = sharedState.voice.droppedPlaybackChunks;
  let queuePeakMs = queuedPlaybackBufferMs();
  let throttledMs = 0;
  let statusRequests = 0;
  let socketBackpressureCount = 0;
  let lastStatusRequestAt = 0;
  const chunkSizeBytes = PLAYBACK_CHUNK_FRAMES * 2;
  const chunkCount = Math.ceil(pcmBuffer.length / Math.max(1, chunkSizeBytes));
  sharedState.voice.lastError = "";
  const expectedErrorSeq = sharedState.voice.playbackErrorSeq;
  writeMediaFrame([
    "tsmedia1",
    "playback.start",
    hexEncode(PLAYBACK_FORMAT),
    String(PLAYBACK_SAMPLE_RATE),
    String(PLAYBACK_CHANNELS)
  ]);
  await waitForTeamspeakPlaybackStart(logger, generation, expectedErrorSeq);
  const streamStartedAt = Date.now();
  for (let offset = 0; offset < pcmBuffer.length; offset += chunkSizeBytes) {
    const chunkIndex = Math.floor(offset / Math.max(1, chunkSizeBytes));
    if (generation !== sharedState.voice.playbackGeneration) {
      logger.info?.("[teamspeak voice] playback generation changed; abandoning queued playback");
      return null;
    }
    if (!sharedState.voice.playbackActive) {
      throw new Error(`TeamSpeak media bridge lost playback state before chunk ${Math.floor(offset / Math.max(1, PLAYBACK_CHUNK_FRAMES * 2)) + 1}: ${sharedState.voice.lastError || "playback became inactive"}`);
    }
    if (sharedState.voice.playbackErrorSeq !== expectedErrorSeq) {
      throw new Error(`TeamSpeak media bridge rejected playback while streaming: ${sharedState.voice.lastError || "unknown playback error"}`);
    }
    while (true) {
      queuePeakMs = Math.max(queuePeakMs, queuedPlaybackBufferMs());
      const now = Date.now();
      const targetAt = streamStartedAt + Math.max(0, chunkIndex * PLAYBACK_CHUNK_DURATION_MS - PLAYBACK_TARGET_BUFFER_MS);
      const realtimeWaitMs = Math.max(0, targetAt - now);
      const queueWaitMs = queuedPlaybackBufferMs() >= PLAYBACK_MAX_QUEUE_BUFFER_MS ? PLAYBACK_QUEUE_WAIT_SLICE_MS : 0;
      const waitMs = realtimeWaitMs > 0 ? Math.min(realtimeWaitMs, PLAYBACK_CHUNK_DURATION_MS) : queueWaitMs;
      if (waitMs <= 0) {
        break;
      }
      if (!lastStatusRequestAt || now - lastStatusRequestAt >= PLAYBACK_STATUS_POLL_INTERVAL_MS) {
        requestMediaStatus();
        lastStatusRequestAt = now;
        statusRequests += 1;
      }
      await sleepMs(waitMs);
      throttledMs += waitMs;
      if (generation !== sharedState.voice.playbackGeneration) {
        logger.info?.("[teamspeak voice] playback generation changed while pacing chunks; abandoning queued playback");
        return null;
      }
      if (!sharedState.voice.connected || !sharedState.voice.socket || sharedState.voice.socket.destroyed) {
        throw new Error("TeamSpeak voice media socket disconnected while pacing playback");
      }
      if (!sharedState.voice.playbackActive) {
        throw new Error(`TeamSpeak media bridge lost playback state before chunk ${chunkIndex + 1}: ${sharedState.voice.lastError || "playback became inactive"}`);
      }
      if (sharedState.voice.playbackErrorSeq !== expectedErrorSeq) {
        throw new Error(`TeamSpeak media bridge rejected playback while pacing: ${sharedState.voice.lastError || "unknown playback error"}`);
      }
    }
    const chunk = pcmBuffer.subarray(offset, Math.min(pcmBuffer.length, offset + PLAYBACK_CHUNK_FRAMES * 2));
    const writeResult = await writeMediaFrameWithBackpressure([
      "tsmedia1",
      "playback.chunk",
      String(Math.floor(chunk.length / 2)),
      String(chunk.length)
    ], chunk);
    socketBackpressureCount += writeResult.backpressureWaits;
    queuePeakMs = Math.max(queuePeakMs, queuedPlaybackBufferMs());
    if (!lastStatusRequestAt || Date.now() - lastStatusRequestAt >= PLAYBACK_STATUS_POLL_INTERVAL_MS) {
      requestMediaStatus();
      lastStatusRequestAt = Date.now();
      statusRequests += 1;
    }
  }
  if (generation === sharedState.voice.playbackGeneration && sharedState.voice.playbackActive) {
    await writeMediaFrameWithBackpressure(["tsmedia1", "playback.stop"]);
  }
  requestMediaStatus();
  return {
    ackMs: streamStartedAt - playbackStartedAt,
    streamMs: Date.now() - streamStartedAt,
    totalMs: Date.now() - playbackStartedAt,
    audioDurationMs: pcmBufferDurationMs(pcmBuffer),
    chunkCount,
    queuePeakMs,
    throttledMs,
    statusRequests,
    socketBackpressureCount,
    droppedPlaybackChunksDelta: Math.max(0, sharedState.voice.droppedPlaybackChunks - startingDroppedPlaybackChunks)
  };
}

async function clearTeamspeakPlayback(logger, reason = "") {
  sharedState.voice.playbackGeneration += 1;
  if (!sharedState.voice.connected || !sharedState.voice.socket || sharedState.voice.socket.destroyed) {
    return;
  }
  try {
    writeMediaFrame(["tsmedia1", "playback.clear"]);
    if (reason) {
      logger.info?.(`[teamspeak voice] cleared playback (${reason})`);
    }
  } catch (error) {
    logger.warn?.(`[teamspeak voice] failed to clear playback: ${String(error)}`);
  }
}

function shellQuote(argument) {
  if (!argument) {
    return "''";
  }
  return `'${String(argument).replace(/'/g, `'\"'\"'`)}'`;
}

function resolveGatewayBaseUrl(cfg) {
  const port =
    typeof cfg?.gateway?.port === "number" && Number.isFinite(cfg.gateway.port)
      ? cfg.gateway.port
      : 18789;
  return `http://127.0.0.1:${port}`;
}

function ensureTeamspeakStateDir(stateDir) {
  const target = path.join(stateDir, CHANNEL_ID);
  fs.mkdirSync(target, {
    recursive: true
  });
  return target;
}

function readTextFileIfExists(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

function writeJsonFile(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), {
    recursive: true
  });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function ensureIngressSecret(stateDir) {
  const filePath = path.join(stateDir, "ingress-secret.txt");
  const existing = readTextFileIfExists(filePath).trim();
  if (existing) {
    return existing;
  }
  const created = randomBytes(24).toString("hex");
  fs.writeFileSync(filePath, `${created}\n`, {
    mode: 0o600
  });
  return created;
}

function routeCacheFilePath() {
  return sharedState.routeStateDir ? path.join(sharedState.routeStateDir, "routes.json") : "";
}

function loadRouteCache() {
  sharedState.routeCache.dmByUid.clear();
  sharedState.routeCache.channelById.clear();
  const filePath = routeCacheFilePath();
  if (!filePath || !fs.existsSync(filePath)) {
    return;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const dmEntries = Array.isArray(parsed?.dmByUid) ? parsed.dmByUid : [];
    for (const entry of dmEntries) {
      if (!isRecord(entry)) {
        continue;
      }
      const uid = normalizeOptionalString(entry.uid);
      const clientId = normalizeOptionalString(entry.clientId);
      if (!uid || !clientId) {
        continue;
      }
      sharedState.routeCache.dmByUid.set(uid, {
        uid,
        clientId,
        senderName: normalizeOptionalString(entry.senderName),
        sessionKey: normalizeOptionalString(entry.sessionKey),
        updatedAt: normalizePositiveInteger(entry.updatedAt, Date.now())
      });
    }
    const channelEntries = Array.isArray(parsed?.channelById) ? parsed.channelById : [];
    for (const entry of channelEntries) {
      if (!isRecord(entry)) {
        continue;
      }
      const channelId = normalizeOptionalString(entry.channelId);
      if (!channelId) {
        continue;
      }
      sharedState.routeCache.channelById.set(channelId, {
        channelId,
        sessionKey: normalizeOptionalString(entry.sessionKey),
        updatedAt: normalizePositiveInteger(entry.updatedAt, Date.now())
      });
    }
  } catch {
    // Ignore a broken cache file and rebuild it from fresh traffic.
  }
}

function trimMapToLimit(map, limit) {
  while (map.size > limit) {
    const oldestKey = map.keys().next().value;
    map.delete(oldestKey);
  }
}

function persistRouteCache() {
  const filePath = routeCacheFilePath();
  if (!filePath) {
    return;
  }
  writeJsonFile(filePath, {
    dmByUid: [...sharedState.routeCache.dmByUid.values()],
    channelById: [...sharedState.routeCache.channelById.values()]
  });
}

function updateDmRouteCache(entry) {
  sharedState.routeCache.dmByUid.set(entry.uid, entry);
  trimMapToLimit(sharedState.routeCache.dmByUid, ROUTE_CACHE_LIMIT);
  persistRouteCache();
}

function updateChannelRouteCache(entry) {
  sharedState.routeCache.channelById.set(entry.channelId, entry);
  trimMapToLimit(sharedState.routeCache.channelById, ROUTE_CACHE_LIMIT);
  persistRouteCache();
}

function pruneDedupeCache(now) {
  for (const [key, seenAt] of sharedState.dedupeSeenAt.entries()) {
    if (now - seenAt > DEDUPE_TTL_MS) {
      sharedState.dedupeSeenAt.delete(key);
    }
  }
}

function claimInboundFingerprint(fingerprint) {
  const now = Date.now();
  pruneDedupeCache(now);
  if (sharedState.dedupeSeenAt.has(fingerprint)) {
    return false;
  }
  sharedState.dedupeSeenAt.set(fingerprint, now);
  trimMapToLimit(sharedState.dedupeSeenAt, ROUTE_CACHE_LIMIT * 4);
  return true;
}

function parseTimestamp(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  const normalized = normalizeOptionalString(value);
  if (!normalized) {
    return Date.now();
  }
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function normalizeMessageKind(value) {
  if (value === 1 || value === "1") {
    return "client";
  }
  if (value === 2 || value === "2") {
    return "channel";
  }
  if (value === 3 || value === "3") {
    return "server";
  }
  const normalized = normalizeOptionalString(value).toLowerCase();
  if (normalized === "client" || normalized === "channel" || normalized === "server") {
    return normalized;
  }
  return "";
}

function normalizeInboundPayload(body) {
  const root = isRecord(body?.event) ? body.event : body;
  const env = isRecord(body?.env) ? body.env : {};
  const fields = isRecord(root?.fields) ? root.fields : {};
  const eventType = normalizeOptionalString(root?.type);
  if (eventType !== "message.received") {
    return {
      ok: false,
      ignored: eventType ? `unsupported event type ${eventType}` : "missing event type"
    };
  }
  const messageKind =
    normalizeMessageKind(fields.message_kind) ||
    normalizeMessageKind(root?.message_kind) ||
    normalizeMessageKind(env.TS_MESSAGE_KIND) ||
    normalizeMessageKind(fields.target_mode);
  if (messageKind === "server") {
    return {
      ok: false,
      ignored: "server chat is not routed"
    };
  }
  if (messageKind !== "client" && messageKind !== "channel") {
    return {
      ok: false,
      ignored: "unsupported message kind"
    };
  }
  const text = normalizeOptionalString(fields.text) || normalizeOptionalString(env.TS_MESSAGE_TEXT);
  if (!text) {
    return {
      ok: false,
      ignored: "empty message text"
    };
  }
  const senderId = normalizeOptionalString(fields.from_id) || normalizeOptionalString(env.TS_MESSAGE_FROM);
  const senderName = normalizeOptionalString(fields.from_name);
  const senderUid = normalizeOptionalString(fields.from_unique_identifier);
  const targetId = normalizeOptionalString(fields.to_id);
  if (messageKind === "client" && !senderId && !senderUid) {
    return {
      ok: false,
      ignored: "dm event missing sender identity"
    };
  }
  if (messageKind === "channel" && !targetId) {
    return {
      ok: false,
      ignored: "channel event missing channel id"
    };
  }
  const timestamp = parseTimestamp(root?.timestamp);
  const fingerprint = createHash("sha1")
    .update(
      JSON.stringify({
        eventType,
        messageKind,
        timestamp,
        senderId,
        senderUid,
        targetId,
        text,
        handler: normalizeOptionalString(fields.handler)
      })
    )
    .digest("hex");
  return {
    ok: true,
    value: {
      eventType,
      messageKind,
      sender: {
        id: senderId,
        name: senderName,
        uid: senderUid
      },
      target: {
        id: targetId,
        mode: messageKind === "client" ? "client" : "channel"
      },
      text,
      timestamp,
      handler: normalizeOptionalString(fields.handler),
      fingerprint,
      raw: root
    }
  };
}

function safeEqualText(left, right) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(a, b);
}

function parseTeamspeakTarget(raw) {
  const value = normalizeOptionalString(raw);
  if (!value) {
    return null;
  }
  if (value.startsWith("teamspeak:channel:")) {
    return {
      kind: "channel",
      id: value.slice("teamspeak:channel:".length)
    };
  }
  if (value.startsWith("teamspeak:client:")) {
    return {
      kind: "client",
      id: value.slice("teamspeak:client:".length)
    };
  }
  if (value.startsWith("teamspeak:dm:")) {
    return {
      kind: "dm",
      uid: value.slice("teamspeak:dm:".length)
    };
  }
  if (value.startsWith("channel:")) {
    return {
      kind: "channel",
      id: value.slice("channel:".length)
    };
  }
  if (value.startsWith("client:")) {
    return {
      kind: "client",
      id: value.slice("client:".length)
    };
  }
  return null;
}

function resolveTeamspeakOutboundTarget(raw) {
  const parsed = parseTeamspeakTarget(raw);
  if (!parsed) {
    throw new Error(
      "unsupported TeamSpeak target; expected teamspeak:dm:<uid>, teamspeak:client:<id>, or teamspeak:channel:<id>"
    );
  }
  if (parsed.kind === "channel") {
    const channelId = normalizeOptionalString(parsed.id);
    if (!channelId) {
      throw new Error("missing TeamSpeak channel id");
    }
    return {
      cliTarget: "channel",
      id: channelId,
      targetKey: `teamspeak:channel:${channelId}`
    };
  }
  if (parsed.kind === "client") {
    const clientId = normalizeOptionalString(parsed.id);
    if (!clientId) {
      throw new Error("missing TeamSpeak client id");
    }
    return {
      cliTarget: "client",
      id: clientId,
      targetKey: `teamspeak:client:${clientId}`
    };
  }
  const uid = normalizeOptionalString(parsed.uid);
  if (!uid) {
    throw new Error("missing TeamSpeak unique identifier");
  }
  const cached = sharedState.routeCache.dmByUid.get(uid);
  if (!cached?.clientId) {
    throw new Error(`no recent TeamSpeak client id is known for ${uid}`);
  }
  return {
    cliTarget: "client",
    id: cached.clientId,
    targetKey: `teamspeak:dm:${uid}`,
    uid
  };
}

async function sendTeamspeakText(account, targetRef, text) {
  const trimmedText = String(text ?? "").trim();
  if (!trimmedText) {
    throw new Error("refusing to send an empty TeamSpeak message");
  }
  const target = resolveTeamspeakOutboundTarget(targetRef);
  await runTsText(account, [
    "message",
    "send",
    "--target",
    target.cliTarget,
    "--id",
    target.id,
    "--text",
    trimmedText
  ]);
  return {
    channel: CHANNEL_ID,
    messageId: `teamspeak-${Date.now()}`,
    chatId: target.id,
    conversationId: target.targetKey,
    meta: {
      teamspeakTarget: target.cliTarget,
      ...(target.uid ? { teamspeakUid: target.uid } : {})
    }
  };
}

function extractReplyText(payload) {
  if (isRecord(payload) && typeof payload.text === "string") {
    return payload.text;
  }
  return "";
}

function normalizeTeamspeakVoiceReplyText(text) {
  return String(text ?? "")
    .replace(/^\s*MEDIA:.*$/gim, " ")
    .replace(/\[embed[^\]]*\/\]/g, " ")
    .replace(/\[\[\s*reply_to:[^\]]+\]\]|\[\[\s*reply_to_current\s*\]\]/gi, " ")
    .replace(/\[\[audio_as_voice\]\]/gi, " ")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1")
    .replace(/^\s{0,3}>\s?/gm, "")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s{0,3}[-*+]\s+/gm, "")
    .replace(/^\s{0,3}\d+[.)]\s+/gm, "")
    .replace(/[*_~`#]+/g, "")
    .replace(/\|/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function joinTeamspeakVoiceReplyText(prefix, suffix) {
  const left = normalizeTeamspeakVoiceReplyText(prefix);
  const right = normalizeTeamspeakVoiceReplyText(suffix);
  if (!left) {
    return right;
  }
  if (!right) {
    return left;
  }
  return `${left} ${right}`.replace(/\s+/g, " ").trim();
}

function findTeamspeakVoiceReplyBoundary(text, flushedChars, hasQueuedChunks, isFinal = false) {
  const remaining = text.slice(flushedChars);
  if (!remaining) {
    return 0;
  }
  const minChars = hasQueuedChunks ? VOICE_REPLY_CHUNK_MIN_CHARS : VOICE_REPLY_FIRST_CHUNK_MIN_CHARS;
  if (isFinal) {
    return remaining.length;
  }
  if (remaining.length < minChars) {
    return 0;
  }
  const hardLimit = Math.min(remaining.length, VOICE_REPLY_CHUNK_SOFT_MAX_CHARS);
  let boundary = 0;
  const punctuationPattern = /[.!?](?=(?:\s|$))|[:;](?=(?:\s|$))/g;
  for (const match of remaining.slice(0, hardLimit).matchAll(punctuationPattern)) {
    const candidate = (match.index || 0) + match[0].length;
    if (candidate >= minChars) {
      boundary = candidate;
    }
  }
  if (boundary > 0) {
    return boundary;
  }
  if (remaining.length < VOICE_REPLY_CHUNK_SOFT_MAX_CHARS) {
    return 0;
  }
  const whitespaceBoundary = remaining.slice(0, hardLimit).search(/\s[^\s]*$/);
  if (whitespaceBoundary >= minChars) {
    return whitespaceBoundary + 1;
  }
  return hardLimit;
}

function createTeamspeakVoiceReplyStreamController(context) {
  const generation = sharedState.voice.playbackGeneration;
  let partialText = "";
  let flushedChars = 0;
  let spokenText = "";
  let queuedChunkCount = 0;
  let queue = Promise.resolve();
  let finalized = false;
  let toolAckQueued = false;

  const enqueueChunk = (chunkText, source) => {
    const cleaned = normalizeTeamspeakVoiceReplyText(chunkText);
    if (!cleaned) {
      return;
    }
    queuedChunkCount += 1;
    spokenText = joinTeamspeakVoiceReplyText(spokenText, cleaned);
    queue = queue
      .catch(() => {})
      .then(async () => {
        if (generation !== sharedState.voice.playbackGeneration) {
          return;
        }
        const synthesis = await synthesizeTeamspeakReplyAudio(cleaned, context.logger);
        if (generation !== sharedState.voice.playbackGeneration) {
          return;
        }
        const playbackMetrics = await playbackTeamspeakAudioBuffer(synthesis.pcmBuffer, context.logger, generation);
        sharedState.voice.lastPlaybackMetrics = {
          source,
          updatedAt: Date.now(),
          replyChars: cleaned.length,
          ttsMs: synthesis.ttsMs,
          wavBytes: synthesis.wavBytes,
          audioDurationMs: synthesis.audioDurationMs,
          ...(playbackMetrics || {})
        };
      })
      .catch((error) => {
        sharedState.voice.lastPlaybackMetrics = {
          source,
          updatedAt: Date.now(),
          replyChars: cleaned.length,
          error: String(error)
        };
        context.logger.error?.(`[teamspeak voice] streamed voice reply chunk failed: ${String(error)}`);
      });
  };

  const flushAvailableChunks = (isFinal = false) => {
    while (true) {
      const boundary = findTeamspeakVoiceReplyBoundary(partialText, flushedChars, queuedChunkCount > 0, isFinal);
      if (boundary <= 0) {
        return;
      }
      const nextText = partialText.slice(flushedChars, flushedChars + boundary);
      flushedChars += boundary;
      enqueueChunk(nextText, isFinal ? "reply-stream-final" : "reply-stream");
      if (!isFinal) {
        return;
      }
    }
  };

  return {
    onAssistantMessageStart() {
      if (finalized) {
        return;
      }
      if (partialText.length > flushedChars) {
        flushAvailableChunks(true);
      }
      partialText = "";
      flushedChars = 0;
    },
    onPartialReply(text) {
      if (finalized) {
        return;
      }
      const cleaned = normalizeTeamspeakVoiceReplyText(text);
      if (!cleaned) {
        return;
      }
      if (partialText && partialText.startsWith(cleaned) && cleaned.length < partialText.length) {
        return;
      }
      partialText = cleaned;
      flushAvailableChunks(false);
    },
    onToolStart() {
      if (finalized || toolAckQueued || queuedChunkCount > 0 || flushedChars > 0 || partialText) {
        return;
      }
      toolAckQueued = true;
      enqueueChunk("One moment.", "reply-stream-tool-ack");
    },
    async finalize(finalText) {
      finalized = true;
      const cleanedFinal = normalizeTeamspeakVoiceReplyText(finalText);
      if (cleanedFinal) {
        if (!partialText || cleanedFinal.length >= partialText.length) {
          partialText = cleanedFinal;
        }
        flushAvailableChunks(true);
      }
      await queue.catch(() => {});
      const alreadySpoken = normalizeTeamspeakVoiceReplyText(spokenText);
      if (!cleanedFinal) {
        return { streamed: queuedChunkCount > 0, remainingText: "" };
      }
      if (alreadySpoken && cleanedFinal.startsWith(alreadySpoken)) {
        return {
          streamed: queuedChunkCount > 0,
          remainingText: normalizeTeamspeakVoiceReplyText(cleanedFinal.slice(alreadySpoken.length))
        };
      }
      return {
        streamed: queuedChunkCount > 0,
        remainingText: queuedChunkCount > 0 ? "" : cleanedFinal
      };
    }
  };
}

function sendJson(res, statusCode, body) {
  res.statusCode = statusCode;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function hookUrlForConfig(cfg) {
  const account = resolveTeamspeakChannelConfig(cfg);
  const baseUrl = resolveGatewayBaseUrl(cfg);
  return `${baseUrl}${account.ingressPath}`;
}

function buildHookExecCommand(cfg) {
  return [
    shellQuote(process.execPath),
    shellQuote(HOOK_RELAY_PATH),
    "--url",
    shellQuote(hookUrlForConfig(cfg)),
    "--secret",
    shellQuote(sharedState.ingressSecret)
  ].join(" ");
}

function normalizeHookRecord(entry) {
  if (!isRecord(entry)) {
    return null;
  }
  const id = normalizeOptionalString(entry.id) || normalizeOptionalString(entry.hook_id) || normalizeOptionalString(entry.hookId);
  const type =
    normalizeOptionalString(entry.type) ||
    normalizeOptionalString(entry.event_type) ||
    normalizeOptionalString(entry.eventType);
  const exec =
    normalizeOptionalString(entry.exec) ||
    normalizeOptionalString(entry.command) ||
    normalizeOptionalString(entry.command_line) ||
    normalizeOptionalString(entry.commandLine);
  const messageKind =
    normalizeMessageKind(entry.message_kind) || normalizeMessageKind(entry.messageKind);
  if (!type) {
    return null;
  }
  return {
    id,
    type,
    exec,
    messageKind
  };
}

async function reconcileHooks(cfg, logger) {
  const account = resolveTeamspeakChannelConfig(cfg);
  if (!account.enabled) {
    logger.info?.("[teamspeak] channel is disabled; skipping hook reconciliation");
    return;
  }
  if (!account.configured) {
    logger.warn?.(`[teamspeak] ts cli not found at ${account.cliPath}; skipping hook reconciliation`);
    return;
  }
  const desiredExec = buildHookExecCommand(cfg);
  const rawHooks = await runTsJson(account, ["events", "hook", "list"]);
  const hooks = Array.isArray(rawHooks) ? rawHooks.map(normalizeHookRecord).filter(Boolean) : [];
  for (const messageKind of ["client", "channel"]) {
    const relevant = hooks.filter(
      (hook) => hook.type === "message.received" && hook.messageKind === messageKind
    );
    const exactMatches = relevant.filter((hook) => hook.exec === desiredExec);
    const stale = relevant.filter((hook) => hook.exec !== desiredExec);
    for (const hook of stale) {
      if (!hook.id) {
        continue;
      }
      await runTsText(account, ["events", "hook", "remove", hook.id]);
      logger.info?.(`[teamspeak] removed stale ${messageKind} hook ${hook.id}`);
    }
    for (const duplicate of exactMatches.slice(1)) {
      if (!duplicate.id) {
        continue;
      }
      await runTsText(account, ["events", "hook", "remove", duplicate.id]);
      logger.info?.(`[teamspeak] removed duplicate ${messageKind} hook ${duplicate.id}`);
    }
    if (exactMatches.length === 0) {
      await runTsText(account, [
        "events",
        "hook",
        "add",
        "--type",
        "message.received",
        "--message-kind",
        messageKind,
        "--exec",
        desiredExec
      ]);
      logger.info?.(`[teamspeak] installed ${messageKind} hook`);
    }
  }
}

async function readDaemonStatus(cfg) {
  const account = resolveTeamspeakChannelConfig(cfg);
  if (!account.configured) {
    return null;
  }
  try {
    return await runTsJson(account, ["daemon", "status"]);
  } catch {
    return null;
  }
}

async function readSelfIdentity(cfg) {
  const cached = sharedState.selfIdentity;
  if (Date.now() - cached.refreshedAt < SELF_IDENTITY_TTL_MS && (cached.uid || cached.clientId || cached.nickname)) {
    return cached;
  }
  const account = resolveTeamspeakChannelConfig(cfg);
  const next = {
    refreshedAt: Date.now(),
    uid: "",
    clientId: "",
    nickname: ""
  };
  try {
    const status = await runTsJson(account, ["status"]);
    if (isRecord(status)) {
      next.uid = normalizeOptionalString(status.identity);
      next.nickname = normalizeOptionalString(status.nickname);
    }
  } catch {
    // ignore; fallback to client list below when possible
  }
  try {
    const clients = await runTsJson(account, ["client", "list"]);
    if (Array.isArray(clients)) {
      const selfEntry = clients.find((entry) => isRecord(entry) && entry.self === true);
      if (isRecord(selfEntry)) {
        next.clientId = normalizeOptionalString(selfEntry.id);
        next.uid = next.uid || normalizeOptionalString(selfEntry.unique_identity);
        next.nickname = next.nickname || normalizeOptionalString(selfEntry.nickname);
      }
    }
  } catch {
    // ignore; best-effort only
  }
  sharedState.selfIdentity = next;
  return next;
}

function matchesSelfIdentity({ uid = "", clientId = "", nickname = "" }, selfIdentity) {
  if (!selfIdentity || !isRecord(selfIdentity)) {
    return false;
  }
  const selfUid = normalizeOptionalString(selfIdentity.uid);
  const selfClientId = normalizeOptionalString(selfIdentity.clientId);
  const selfNickname = normalizeOptionalString(selfIdentity.nickname);
  const normalizedUid = normalizeOptionalString(uid);
  const normalizedClientId = normalizeOptionalString(clientId);
  const normalizedNickname = normalizeOptionalString(nickname);
  if (normalizedUid && normalizedUid === selfUid) {
    return true;
  }
  if (normalizedClientId && normalizedClientId === selfClientId) {
    return true;
  }
  if (!normalizedUid && !normalizedClientId && normalizedNickname && normalizedNickname === selfNickname) {
    return true;
  }
  return false;
}

function isUsableTeamspeakChannelId(value) {
  const normalized = normalizeOptionalString(value);
  return Boolean(normalized && normalized !== "0");
}

async function resolveLiveSpeakerChannelId(cfg, speakerState, logger) {
  if (isUsableTeamspeakChannelId(speakerState?.channelId)) {
    return speakerState.channelId;
  }
  const account = resolveTeamspeakChannelConfig(cfg);
  const clientId = normalizeOptionalString(speakerState?.clientId);
  const uid = normalizeOptionalString(speakerState?.uid);
  const nickname = normalizeOptionalString(speakerState?.nickname);
  try {
    if (clientId) {
      const entry = await runTsJson(account, ["client", "get", clientId]);
      if (isRecord(entry)) {
        const resolved = normalizeOptionalString(entry.channel_id) || normalizeOptionalString(entry.channelId);
        if (isUsableTeamspeakChannelId(resolved)) {
          return resolved;
        }
      }
    }
  } catch (error) {
    logger.warn?.(`[teamspeak voice] failed live client lookup for ${clientId || uid || nickname || "unknown speaker"}: ${String(error)}`);
  }
  try {
    const clients = await runTsJson(account, ["client", "list"]);
    if (!Array.isArray(clients)) {
      return "";
    }
    const entry = clients.find((candidate) => {
      if (!isRecord(candidate)) {
        return false;
      }
      const candidateId = normalizeOptionalString(candidate.id);
      const candidateUid = normalizeOptionalString(candidate.unique_identity) || normalizeOptionalString(candidate.uid);
      const candidateNickname = normalizeOptionalString(candidate.nickname);
      if (clientId && candidateId === clientId) {
        return true;
      }
      if (uid && candidateUid === uid) {
        return true;
      }
      return !clientId && !uid && nickname && candidateNickname === nickname;
    });
    if (isRecord(entry)) {
      const resolved = normalizeOptionalString(entry.channel_id) || normalizeOptionalString(entry.channelId);
      if (isUsableTeamspeakChannelId(resolved)) {
        return resolved;
      }
    }
  } catch (error) {
    logger.warn?.(`[teamspeak voice] failed live client list lookup for ${clientId || uid || nickname || "unknown speaker"}: ${String(error)}`);
  }
  return "";
}

function isSelfInboundMessage(normalized, selfIdentity) {
  return matchesSelfIdentity(
    {
      uid: normalized?.sender?.uid,
      clientId: normalized?.sender?.id,
      nickname: normalized?.sender?.name
    },
    selfIdentity
  );
}

function attachDaemonLogStream(stream, logFn, prefix) {
  if (!stream || !logFn) {
    return;
  }
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    const text = String(chunk ?? "").trim();
    if (text) {
      logFn(`${prefix} ${text}`);
    }
  });
}

function clearDaemonRestartTimer() {
  if (sharedState.daemonRestartTimer) {
    clearTimeout(sharedState.daemonRestartTimer);
    sharedState.daemonRestartTimer = null;
  }
}

function startOwnedDaemon(cfg, logger) {
  const account = resolveTeamspeakChannelConfig(cfg);
  if (!account.enabled || !account.configured || sharedState.stopping) {
    return;
  }
  clearDaemonRestartTimer();
  const child = spawn(
    account.cliPath,
    [
      ...buildTsGlobalArgs(account),
      "daemon",
      "start",
      "--foreground",
      "--poll-ms",
      String(account.daemonPollMs)
    ],
    {
      stdio: ["ignore", "pipe", "pipe"]
    }
  );
  sharedState.daemonChild = child;
  attachDaemonLogStream(child.stdout, logger.debug, "[teamspeak daemon]");
  attachDaemonLogStream(child.stderr, logger.warn, "[teamspeak daemon]");
  child.on("exit", (code, signal) => {
    sharedState.daemonChild = null;
    if (sharedState.stopping || !sharedState.daemonOwned) {
      return;
    }
    logger.warn?.(
      `[teamspeak] daemon exited unexpectedly (code=${code ?? "null"}, signal=${signal ?? "null"}); restarting`
    );
    sharedState.daemonRestartTimer = setTimeout(() => {
      startOwnedDaemon(cfg, logger);
    }, DAEMON_RESTART_DELAY_MS);
  });
}

function stopOwnedDaemon() {
  clearDaemonRestartTimer();
  const child = sharedState.daemonChild;
  if (!child) {
    return;
  }
  sharedState.daemonChild = null;
  try {
    child.kill("SIGTERM");
  } catch {
    // Ignore process teardown races.
  }
}

function buildTeamspeakVoiceReplySystemPrompt(normalized) {
  if (normalized?.eventType !== "voice.utterance") {
    return undefined;
  }
  return [
    "This turn came from live TeamSpeak voice input and your reply will be spoken aloud.",
    "Write for speech, not for screen reading.",
    "Use plain text only and natural spoken sentences.",
    "Do not use markdown, bullets, numbering, tables, code fences, headings, quoted blocks, or other text formatting unless the user explicitly asked for them.",
    "Front-load the answer: start with the useful answer or a short spoken acknowledgement in the first sentence.",
    "If tool work is needed, say a brief spoken lead-in first, then do the tool work, then continue with the result.",
    "Keep the first spoken chunk short and conversational so TTS can begin quickly."
  ].join(" ");
}

async function dispatchTeamspeakTurn({ cfg, normalized, logger, deliverReply, extraUntrustedContext }) {
  if (!claimInboundFingerprint(normalized.fingerprint)) {
    return {
      handled: true,
      deduped: true
    };
  }
  const runtime = runtimeStore.getRuntime();
  const account = resolveTeamspeakChannelConfig(cfg);
  const selfIdentity = await readSelfIdentity(cfg);
  if (isSelfInboundMessage(normalized, selfIdentity)) {
    logger.info?.("[teamspeak] ignoring self-authored inbound message");
    return {
      handled: true,
      deduped: false,
      ignored: "self-message"
    };
  }
  if (normalized.messageKind === "channel" && !isUsableTeamspeakChannelId(normalized.target?.id)) {
    let resolvedChannelId = await resolveLiveSpeakerChannelId(
      cfg,
      {
        channelId: normalized.target?.id,
        clientId: normalized.sender?.id,
        uid: normalized.sender?.uid,
        nickname: normalized.sender?.name
      },
      logger
    );
    if (!isUsableTeamspeakChannelId(resolvedChannelId)) {
      resolvedChannelId = await resolveLiveSpeakerChannelId(
        cfg,
        {
          clientId: selfIdentity.clientId,
          uid: selfIdentity.uid,
          nickname: selfIdentity.nickname
        },
        logger
      );
    }
    if (isUsableTeamspeakChannelId(resolvedChannelId)) {
      logger.info?.(
        `[teamspeak] corrected channel message target: ${normalized.target?.id || "<empty>"} -> ${resolvedChannelId}`
      );
      normalized.target.id = resolvedChannelId;
    }
  }
  if (normalized.messageKind === "channel" && !isUsableTeamspeakChannelId(normalized.target?.id)) {
    throw new Error(`channel message has unresolved TeamSpeak channel id ${normalized.target?.id || "<empty>"}`);
  }
  const sessionPeerId =
    normalized.messageKind === "client"
      ? normalizeOptionalString(normalized.sender.uid) || normalizeOptionalString(normalized.sender.id)
      : TEAMSPEAK_CHANNEL_SESSION_ID;
  const route = runtime.channel.routing.resolveAgentRoute({
    cfg,
    channel: CHANNEL_ID,
    accountId: account.accountId,
    peer: {
      kind: normalized.messageKind === "client" ? "direct" : "channel",
      id: sessionPeerId
    }
  });
  const storePath = runtime.channel.session.resolveStorePath(cfg.session?.store, {
    agentId: route.agentId
  });
  await maybeApplyTeamspeakSessionDefaults({
    storePath,
    sessionKey: route.sessionKey,
    sessionDefaults: account.sessionDefaults,
    logger
  });
  const previousTimestamp = runtime.channel.session.readSessionUpdatedAt({
    storePath,
    sessionKey: route.sessionKey
  });
  const conversationLabel =
    normalized.messageKind === "client"
      ? normalizeOptionalString(normalized.sender.name) ||
        normalizeOptionalString(normalized.sender.uid) ||
        normalizeOptionalString(normalized.sender.id)
      : TEAMSPEAK_CHANNEL_CONVERSATION_LABEL;
  const envelopeOptions = runtime.channel.reply.resolveEnvelopeFormatOptions(cfg);
  const body = runtime.channel.reply.formatAgentEnvelope({
    channel: "TeamSpeak",
    from: conversationLabel,
    timestamp: normalized.timestamp,
    previousTimestamp,
    envelope: envelopeOptions,
    body: normalized.text
  });
  const originatingTo =
    normalized.messageKind === "client"
      ? `teamspeak:dm:${normalizeOptionalString(normalized.sender.uid) || normalizeOptionalString(normalized.sender.id)}`
      : `teamspeak:channel:${normalized.target.id}`;
  const untrustedContext = [
    ...(normalized.handler ? [`TeamSpeak handler: ${normalized.handler}`] : []),
    ...(normalized.messageKind === "channel" ? [`TeamSpeak current channel id: ${normalized.target.id}`] : []),
    ...(Array.isArray(extraUntrustedContext) ? extraUntrustedContext.filter(Boolean) : [])
  ];
  const groupSystemPrompt = buildTeamspeakVoiceReplySystemPrompt(normalized);
  if (groupSystemPrompt) {
    sharedState.voice.lastPromptGuidance = {
      updatedAt: Date.now(),
      eventType: normalized.eventType,
      prompt: groupSystemPrompt
    };
    logger.info?.(`[teamspeak voice] attached voice reply guidance (${groupSystemPrompt.length} chars)`);
  }
  const voiceReplyStream = normalized.eventType === "voice.utterance" ? createTeamspeakVoiceReplyStreamController({
    account,
    originatingTo,
    cfg,
    logger
  }) : null;
  const ctxPayload = runtime.channel.reply.finalizeInboundContext({
    Body: body,
    BodyForAgent: normalized.text,
    RawBody: normalized.text,
    CommandBody: normalized.text,
    GroupSystemPrompt: groupSystemPrompt,
    From:
      normalized.messageKind === "client"
        ? `teamspeak:user:${normalizeOptionalString(normalized.sender.uid) || normalizeOptionalString(normalized.sender.id)}`
        : `teamspeak:channel:${normalized.target.id}`,
    To: originatingTo,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: normalized.messageKind === "client" ? "direct" : "channel",
    ConversationLabel: conversationLabel,
    SenderName: normalizeOptionalString(normalized.sender.name) || undefined,
    SenderId: normalizeOptionalString(normalized.sender.id) || undefined,
    SenderTag: normalizeOptionalString(normalized.sender.uid) || undefined,
    NativeDirectUserId:
      normalized.messageKind === "client" ? normalizeOptionalString(normalized.sender.uid) || undefined : undefined,
    GroupSubject:
      normalized.messageKind === "channel" ? TEAMSPEAK_CHANNEL_CONVERSATION_LABEL : undefined,
    Provider: CHANNEL_ID,
    Surface: CHANNEL_ID,
    MessageSid: normalized.fingerprint,
    Timestamp: normalized.timestamp,
    OriginatingChannel: CHANNEL_ID,
    OriginatingTo: originatingTo,
    CommandAuthorized: true,
    UntrustedContext: untrustedContext.length > 0 ? untrustedContext : undefined
  });
  if (normalized.messageKind === "client") {
    const uid = normalizeOptionalString(normalized.sender.uid) || normalizeOptionalString(normalized.sender.id);
    const clientId = normalizeOptionalString(normalized.sender.id);
    if (uid && clientId) {
      updateDmRouteCache({
        uid,
        clientId,
        senderName: normalizeOptionalString(normalized.sender.name),
        sessionKey: route.sessionKey,
        updatedAt: normalized.timestamp
      });
    }
  } else {
    updateChannelRouteCache({
      channelId: normalizeOptionalString(normalized.target.id),
      sessionKey: route.sessionKey,
      updatedAt: normalized.timestamp
    });
  }
  await dispatchInboundReplyWithBase({
    cfg,
    channel: CHANNEL_ID,
    accountId: account.accountId,
    route,
    storePath,
    ctxPayload,
    core: runtime,
    deliver: async (payload) => {
      await deliverReply(payload, {
        normalized,
        route,
        originatingTo,
        account,
        cfg,
        logger,
        voiceReplyStream
      });
    },
    onRecordError: (error) => {
      logger.error?.(`[teamspeak] failed to record inbound session: ${String(error)}`);
    },
    onDispatchError: (error, info) => {
      logger.error?.(`[teamspeak] ${info.kind} reply failed: ${String(error)}`);
    },
    replyOptions: voiceReplyStream ? {
      onPartialReply: (payload) => {
        voiceReplyStream.onPartialReply(payload?.text);
      },
      onAssistantMessageStart: () => {
        voiceReplyStream.onAssistantMessageStart();
      },
      onToolStart: () => {
        voiceReplyStream.onToolStart();
      }
    } : undefined
  });
  return {
    handled: true,
    deduped: false,
    sessionKey: route.sessionKey
  };
}

function buildVoiceNormalizedEvent(speakerState, text) {
  const messageKind = normalizeOptionalString(speakerState.channelId) && speakerState.channelId !== "0" ? "channel" : "client";
  const timestamp = Date.now();
  return {
    eventType: "voice.utterance",
    messageKind,
    sender: {
      id: speakerState.clientId,
      name: speakerState.nickname,
      uid: speakerState.uid
    },
    target: {
      id: messageKind === "channel" ? speakerState.channelId : speakerState.clientId,
      mode: messageKind === "channel" ? "channel" : "client"
    },
    text,
    timestamp,
    handler: speakerState.handlerId,
    fingerprint: createHash("sha1")
      .update(
        JSON.stringify({
          source: "teamspeak-voice",
          uid: speakerState.uid,
          clientId: speakerState.clientId,
          channelId: speakerState.channelId,
          text,
          sequence: ++sharedState.voice.utteranceSeq,
          timestamp
        })
      )
      .digest("hex")
  };
}

async function deliverTeamspeakVoiceReply(payload, context) {
  const replyText = extractReplyText(payload).trim();
  if (!replyText) {
    return;
  }
  const voiceConfig = resolveTeamspeakChannelConfig(context.cfg).voice;
  const generation = sharedState.voice.playbackGeneration;
  await readSelfIdentity(context.cfg);
  let textToSpeak = context.voiceReplyStream ? replyText : normalizeTeamspeakVoiceReplyText(replyText);
  try {
    if (context.voiceReplyStream) {
      const finalized = await context.voiceReplyStream.finalize(replyText);
      textToSpeak = normalizeTeamspeakVoiceReplyText(finalized?.remainingText);
      if (!textToSpeak) {
        if (voiceConfig.mirrorTextReplies) {
          await sendTeamspeakText(context.account, context.originatingTo, replyText);
        }
        return;
      }
    }
    const synthesis = await synthesizeTeamspeakReplyAudio(textToSpeak, context.logger);
    if (generation !== sharedState.voice.playbackGeneration) {
      context.logger.info?.("[teamspeak voice] dropping synthesized reply because playback was interrupted");
      return;
    }
    const playbackMetrics = await playbackTeamspeakAudioBuffer(synthesis.pcmBuffer, context.logger, generation);
    sharedState.voice.lastPlaybackMetrics = {
      source: context.voiceReplyStream ? "reply-stream-tail" : "reply",
      updatedAt: Date.now(),
      replyChars: textToSpeak.length,
      ttsMs: synthesis.ttsMs,
      wavBytes: synthesis.wavBytes,
      audioDurationMs: synthesis.audioDurationMs,
      ...(playbackMetrics || {})
    };
  } catch (error) {
    sharedState.voice.lastPlaybackMetrics = {
      source: context.voiceReplyStream ? "reply-stream-tail" : "reply",
      updatedAt: Date.now(),
      replyChars: textToSpeak.length,
      error: String(error)
    };
    context.logger.error?.(`[teamspeak voice] voice reply failed, falling back to text: ${String(error)}`);
    await sendTeamspeakText(context.account, context.originatingTo, replyText);
    return;
  }
  if (voiceConfig.mirrorTextReplies) {
    await sendTeamspeakText(context.account, context.originatingTo, replyText);
  }
}

function scheduleSpeakerFinalize(cfg, speakerState, logger) {
  clearSpeakerFinalizeTimer(speakerState);
  const voiceConfig = resolveTeamspeakChannelConfig(cfg).voice;
  speakerState.finalizeTimer = setTimeout(() => {
    finalizeSpeakerUtterance(cfg, speakerState.key, logger, "silence-timeout").catch((error) => {
      logger.error?.(`[teamspeak voice] failed to finalize utterance: ${String(error)}`);
    });
  }, voiceConfig.silenceTimeoutMs);
}

async function finalizeSpeakerUtterance(cfg, speakerKey, logger, reason) {
  const speakerState = sharedState.voice.speakers.get(speakerKey);
  if (!speakerState) {
    return;
  }
  clearSpeakerFinalizeTimer(speakerState);
  sharedState.voice.speakers.delete(speakerKey);
  if (speakerState.chunks.length === 0) {
    return;
  }
  const pcmBuffer = Buffer.concat(speakerState.chunks);
  const wavBuffer = buildWavBufferFromPcm({
    pcmBuffer,
    sampleRate: speakerState.sampleRate,
    channels: speakerState.channels
  });
  const audioDurationMs = pcmBufferDurationMs(pcmBuffer, speakerState.sampleRate, speakerState.channels);
  const audioPath = path.join(sharedState.voice.stateDir, `${speakerKey.replace(/[^a-zA-Z0-9._-]+/g, "_")}-${Date.now()}.wav`);
  fs.writeFileSync(audioPath, wavBuffer);
  try {
    const runtime = runtimeStore.getRuntime();
    const voiceConfig = resolveTeamspeakChannelConfig(cfg).voice;
    const speakerIdentity = speakerState.nickname || speakerState.uid || speakerState.clientId || speakerKey;
    const transcriptionTarget = resolveConfiguredAudioTranscriptionTarget(cfg);
    const transcriptionStartedAt = Date.now();
    const baseTranscriptionMetrics = {
      source: "speaker",
      updatedAt: transcriptionStartedAt,
      speaker: speakerIdentity,
      speakerKey,
      finalizeReason: reason,
      audioDurationMs,
      transcriptionTarget: transcriptionTarget.hint,
      provider: transcriptionTarget.provider,
      model: transcriptionTarget.model,
      baseUrl: transcriptionTarget.baseUrl,
      allowPrivateNetwork: transcriptionTarget.allowPrivateNetwork,
      language: voiceConfig.transcriptionLanguage || undefined
    };
    let transcript = "";
    try {
      transcript = normalizeOptionalString(
        (
          await runtime.stt.transcribeAudioFile({
            filePath: audioPath,
            cfg,
            language: voiceConfig.transcriptionLanguage || undefined
          })
        )?.text
      );
    } catch (error) {
      const failedMetrics = {
        ...baseTranscriptionMetrics,
        updatedAt: Date.now(),
        outcome: "error",
        transcriptionDurationMs: Date.now() - transcriptionStartedAt,
        transcriptLength: 0,
        error: String(error)
      };
      sharedState.voice.lastTranscriptionMetrics = failedMetrics;
      logger.error?.(
        `[teamspeak voice] transcription failed for ${speakerIdentity} after ${failedMetrics.transcriptionDurationMs}ms (audio=${audioDurationMs}ms${transcriptionTarget.hint ? `, target=${transcriptionTarget.hint}` : ""}): ${String(error)}`
      );
      throw error;
    }
    const transcriptionMetrics = {
      ...baseTranscriptionMetrics,
      updatedAt: Date.now(),
      outcome: "transcribed",
      transcriptionDurationMs: Date.now() - transcriptionStartedAt,
      transcriptLength: transcript.length
    };
    sharedState.voice.lastTranscriptionMetrics = transcriptionMetrics;
    logger.info?.(
      `[teamspeak voice] transcribed ${speakerIdentity} in ${transcriptionMetrics.transcriptionDurationMs}ms (audio=${audioDurationMs}ms, chars=${transcript.length}${transcriptionTarget.hint ? `, target=${transcriptionTarget.hint}` : ""})`
    );
    if (!transcript) {
      sharedState.voice.lastTranscriptionMetrics = {
        ...transcriptionMetrics,
        updatedAt: Date.now(),
        outcome: "empty"
      };
      logger.info?.(`[teamspeak voice] dropped empty transcript for ${speakerState.nickname || speakerState.uid || speakerState.clientId}`);
      return;
    }
    const resolvedChannelId = await resolveLiveSpeakerChannelId(cfg, speakerState, logger);
    if (isUsableTeamspeakChannelId(resolvedChannelId) && resolvedChannelId !== speakerState.channelId) {
      logger.info?.(
        `[teamspeak voice] corrected speaker channel for ${speakerIdentity}: ${speakerState.channelId || "<empty>"} -> ${resolvedChannelId}`
      );
      speakerState.channelId = resolvedChannelId;
    }
    const accepted = await evaluateVoiceAcceptance({
      cfg,
      speaker: speakerState,
      transcript,
      logger
    });
    if (!accepted.accepted) {
      sharedState.voice.lastTranscriptionMetrics = {
        ...transcriptionMetrics,
        updatedAt: Date.now(),
        outcome: "ignored",
        accepted: false,
        acceptedReason: accepted.reason
      };
      logger.info?.(`[teamspeak voice] ignored utterance (${accepted.reason}) from ${speakerState.nickname || speakerState.uid || speakerState.clientId}`);
      return;
    }
    sharedState.voice.lastTranscriptionMetrics = {
      ...transcriptionMetrics,
      updatedAt: Date.now(),
      outcome: "accepted",
      accepted: true,
      normalizedTranscriptLength: normalizeOptionalString(accepted.text).length,
      wakeMatched: accepted.wakeMatched === true,
      wakeTrigger: accepted.trigger || undefined
    };
    const selfSpeaker = matchesSelfIdentity(
      {
        uid: speakerState.uid,
        clientId: speakerState.clientId,
        nickname: speakerState.nickname
      },
      sharedState.selfIdentity
    );
    if (
      voiceConfig.interruptOnSpeech &&
      voiceConfig.interruptMode === "wake_word" &&
      sharedState.voice.playbackActive &&
      accepted.wakeMatched === true &&
      !selfSpeaker
    ) {
      await clearTeamspeakPlayback(logger, `wake-word:${speakerKey}`);
    }
    const normalized = buildVoiceNormalizedEvent(speakerState, accepted.text);
    await dispatchTeamspeakTurn({
      cfg,
      normalized,
      logger,
      deliverReply: deliverTeamspeakVoiceReply,
      extraUntrustedContext: [
        "TeamSpeak voice input",
        `Voice finalize reason: ${reason}`,
        ...(accepted.wakeMatched ? [`Voice wake trigger: ${accepted.trigger}`] : [])
      ]
    });
  } finally {
    fs.rmSync(audioPath, { force: true });
  }
}

function scheduleVoiceReconnect(cfg, logger, failureMessage = "") {
  if (sharedState.stopping || !resolveTeamspeakChannelConfig(cfg).voice.enabled) {
    return;
  }
  clearVoiceReconnectTimer();
  const delayMs = getVoiceReconnectDelayMs();
  sharedState.voice.lastReconnectDelayMs = delayMs;
  if (failureMessage) {
    logVoiceConnectionFailure(logger, failureMessage, delayMs);
  }
  sharedState.voice.reconnectTimer = setTimeout(() => {
    connectTeamspeakVoiceManager(cfg, logger).catch((error) => {
      logger.error?.(`[teamspeak voice] reconnect failed: ${String(error)}`);
    });
  }, delayMs);
  sharedState.voice.reconnectTimer.unref?.();
  sharedState.voice.reconnectAttempt += 1;
}

function handleVoiceMediaFrame(cfg, frame, logger) {
  const voiceState = sharedState.voice;
  const type = frame.fields[1] || "";
  if (type === "hello") {
    voiceState.lastHelloAt = Date.now();
    voiceState.mediaFormat = hexDecode(frame.fields[3]);
    voiceState.mediaSocketPath = hexDecode(frame.fields[6]) || voiceState.mediaSocketPath;
    try {
      requestMediaStatus(frame.socket || sharedState.voice.socket);
    } catch (error) {
      logger.warn?.(`[teamspeak voice] failed to request media status after hello: ${String(error)}`);
    }
    return;
  }
  if (type === "status") {
    voiceState.lastStatusAt = Date.now();
    voiceState.playbackActive = frame.fields[4] === "1";
    voiceState.queuedPlaybackSamples = Number.parseInt(frame.fields[5] || "", 10) || 0;
    voiceState.activeSpeakerCount = Number.parseInt(frame.fields[6] || "", 10) || 0;
    voiceState.droppedIngressChunks = Number.parseInt(frame.fields[7] || "", 10) || 0;
    voiceState.droppedPlaybackChunks = Number.parseInt(frame.fields[8] || "", 10) || 0;
    voiceState.lastError = hexDecode(frame.fields[9]);
    return;
  }
  if (type === "playback.started") {
    voiceState.playbackActive = true;
    return;
  }
  if (type === "playback.stopped" || type === "playback.cleared") {
    voiceState.playbackActive = false;
    voiceState.queuedPlaybackSamples = 0;
    return;
  }
  if (type === "error") {
    const errorCode = hexDecode(frame.fields[3]);
    const errorDetail = hexDecode(frame.fields[4]);
    voiceState.lastError = `${errorCode}: ${errorDetail}`;
    if (errorCode.startsWith("playback_")) {
      voiceState.playbackActive = false;
      voiceState.queuedPlaybackSamples = 0;
      voiceState.playbackErrorSeq += 1;
    }
    logger.warn?.(`[teamspeak voice] media bridge error ${voiceState.lastError}`);
    return;
  }
  if (type !== "speaker.start" && type !== "speaker.stop" && type !== "audio.chunk") {
    return;
  }
  const parsed = parseMediaFrameFields(frame.fields);
  const speakerKey = speakerKeyForFrame(parsed);
  if (type === "speaker.start") {
    const selfSpeaker = matchesSelfIdentity(
      {
        uid: parsed.uid,
        clientId: parsed.clientId,
        nickname: parsed.nickname
      },
      sharedState.selfIdentity
    );
    const voiceConfig = resolveTeamspeakChannelConfig(cfg).voice;
    if (
      voiceConfig.interruptOnSpeech &&
      voiceConfig.interruptMode === "any_speech" &&
      voiceState.playbackActive &&
      !selfSpeaker
    ) {
      clearTeamspeakPlayback(logger, `speaker-start:${speakerKey}`).catch(() => {});
    }
    const speakerState = {
      key: speakerKey,
      handlerId: parsed.handlerId,
      clientId: parsed.clientId,
      uid: parsed.uid,
      nickname: parsed.nickname,
      channelId: parsed.channelId,
      sampleRate: parsed.sampleRate || PLAYBACK_SAMPLE_RATE,
      channels: parsed.channels || 1,
      chunks: [],
      finalizeTimer: null
    };
    voiceState.speakers.set(speakerKey, speakerState);
    scheduleSpeakerFinalize(cfg, speakerState, logger);
    return;
  }
  const speakerState = voiceState.speakers.get(speakerKey);
  if (!speakerState) {
    return;
  }
  if (type === "audio.chunk") {
    if (frame.payload?.length) {
      speakerState.chunks.push(frame.payload);
    }
    speakerState.sampleRate = parsed.sampleRate || speakerState.sampleRate;
    speakerState.channels = parsed.channels || speakerState.channels;
    scheduleSpeakerFinalize(cfg, speakerState, logger);
    return;
  }
  if (type === "speaker.stop") {
    finalizeSpeakerUtterance(cfg, speakerKey, logger, "speaker-stop").catch((error) => {
      logger.error?.(`[teamspeak voice] failed to finalize speaker-stop utterance: ${String(error)}`);
    });
  }
}

async function connectTeamspeakVoiceManager(cfg, logger) {
  const account = resolveTeamspeakChannelConfig(cfg);
  if (!account.voice.enabled || !account.enabled || !account.configured || sharedState.stopping) {
    return;
  }
  if (sharedState.voice.connected || sharedState.voice.connecting) {
    return;
  }
  sharedState.voice.connecting = true;
  clearVoiceReconnectTimer();
  try {
    const pluginInfo = await resolveTeamspeakPluginInfo(cfg, logger);
    sharedState.voice.mediaSocketPath = pluginInfo.mediaSocketPath;
    sharedState.voice.mediaFormat = pluginInfo.mediaFormat;
    sharedState.voice.mediaTransport = pluginInfo.mediaTransport;
    if (!sharedState.voice.mediaSocketPath) {
      throw new Error("could not resolve TeamSpeak media socket path");
    }
    const socket = net.createConnection(sharedState.voice.mediaSocketPath);
    let socketConnected = false;
    let socketErrorMessage = "";
    sharedState.voice.socket = socket;
    sharedState.voice.buffer = Buffer.alloc(0);
    socket.on("connect", () => {
      socketConnected = true;
      resetVoiceReconnectBackoff();
      sharedState.voice.connected = true;
      sharedState.voice.connecting = false;
      sharedState.voice.startupError = "";
      sharedState.voice.lastError = "";
      logger.info?.(`[teamspeak voice] connected to media socket ${sharedState.voice.mediaSocketPath}`);
      try {
        requestMediaStatus(socket);
      } catch (error) {
        logger.warn?.(`[teamspeak voice] failed to request media status after connect: ${String(error)}`);
      }
    });
    socket.on("data", (chunk) => {
      sharedState.voice.buffer = Buffer.concat([sharedState.voice.buffer, chunk]);
      while (true) {
        const newlineIndex = sharedState.voice.buffer.indexOf(0x0a);
        if (newlineIndex < 0) {
          return;
        }
        const header = sharedState.voice.buffer.subarray(0, newlineIndex).toString("utf8");
        const fields = header.split("\t");
        const needsPayload = fields[1] === "audio.chunk";
        const payloadBytes = needsPayload ? Number.parseInt(fields[11] || "", 10) || 0 : 0;
        const totalBytes = newlineIndex + 1 + payloadBytes;
        if (sharedState.voice.buffer.length < totalBytes) {
          return;
        }
        const payload = needsPayload
          ? sharedState.voice.buffer.subarray(newlineIndex + 1, newlineIndex + 1 + payloadBytes)
          : Buffer.alloc(0);
        sharedState.voice.buffer = sharedState.voice.buffer.subarray(totalBytes);
        handleVoiceMediaFrame(cfg, { fields, payload, socket }, logger);
      }
    });
    socket.on("error", (error) => {
      socketErrorMessage = String(error);
      if (sharedState.voice.socket !== socket) {
        return;
      }
      sharedState.voice.connecting = false;
      sharedState.voice.lastError = socketErrorMessage;
    });
    socket.on("close", () => {
      if (sharedState.voice.socket !== socket) {
        return;
      }
      const wasConnected = socketConnected || sharedState.voice.connected;
      sharedState.voice.connected = false;
      sharedState.voice.connecting = false;
      sharedState.voice.socket = null;
      sharedState.voice.buffer = Buffer.alloc(0);
      if (wasConnected) {
        logger.warn?.("[teamspeak voice] media socket disconnected");
        scheduleVoiceReconnect(cfg, logger);
        return;
      }
      const failureMessage = socketErrorMessage
        ? `media socket unavailable: ${socketErrorMessage}`
        : "media socket closed before connect";
      sharedState.voice.startupError = failureMessage;
      scheduleVoiceReconnect(cfg, logger, failureMessage);
    });
  } catch (error) {
    const failureMessage = `failed to connect media manager: ${String(error)}`;
    sharedState.voice.startupError = failureMessage;
    sharedState.voice.connected = false;
    sharedState.voice.connecting = false;
    sharedState.voice.socket = null;
    scheduleVoiceReconnect(cfg, logger, failureMessage);
  }
}

async function startTeamspeakVoiceManager(cfg, stateDir, logger) {
  clearVoiceStartTimer();
  sharedState.voice.stateDir = ensureVoiceStateDir(stateDir);
  await connectTeamspeakVoiceManager(cfg, logger);
}

async function stopTeamspeakVoiceManager(logger) {
  clearVoiceStartTimer();
  clearVoiceReconnectTimer();
  resetVoiceReconnectBackoff();
  for (const speakerState of sharedState.voice.speakers.values()) {
    clearSpeakerFinalizeTimer(speakerState);
  }
  sharedState.voice.speakers.clear();
  sharedState.voice.playbackGeneration += 1;
  const socket = sharedState.voice.socket;
  sharedState.voice.socket = null;
  sharedState.voice.connected = false;
  sharedState.voice.connecting = false;
  sharedState.voice.buffer = Buffer.alloc(0);
  if (socket && !socket.destroyed) {
    socket.destroy();
  }
  logger.info?.("[teamspeak voice] stopped voice manager");
}

async function handleInboundTeamspeakEvent(cfg, normalized, logger) {
  const account = resolveTeamspeakChannelConfig(cfg);
  return await dispatchTeamspeakTurn({
    cfg,
    normalized,
    logger,
    deliverReply: async (payload, context) => {
      const replyText = extractReplyText(payload).trim();
      if (!replyText) {
        return;
      }
      await sendTeamspeakText(account, context.originatingTo, replyText);
    }
  });
}

function validateTeamspeakConfig(value) {
  if (value === undefined || value === null) {
    return {
      ok: true,
      value: {}
    };
  }
  if (!isRecord(value)) {
    return {
      ok: false,
      errors: ["channels.teamspeak must be an object"]
    };
  }
  const errors = [];
  const stringKeys = ["cliPath", "profile", "server", "nickname", "identity", "configPath", "defaultTo", "ingressPath"];
  for (const key of stringKeys) {
    if (value[key] !== undefined && typeof value[key] !== "string") {
      errors.push(`channels.teamspeak.${key} must be a string`);
    }
  }
  if (value.enabled !== undefined && typeof value.enabled !== "boolean") {
    errors.push("channels.teamspeak.enabled must be a boolean");
  }
  if (
    value.daemonPollMs !== undefined &&
    !(typeof value.daemonPollMs === "number" && Number.isInteger(value.daemonPollMs) && value.daemonPollMs > 0)
  ) {
    errors.push("channels.teamspeak.daemonPollMs must be a positive integer");
  }
  if (value.sessionDefaults !== undefined) {
    if (!isRecord(value.sessionDefaults)) {
      errors.push("channels.teamspeak.sessionDefaults must be an object");
    } else {
      const sessionDefaults = value.sessionDefaults;
      if (sessionDefaults.model !== undefined && typeof sessionDefaults.model !== "string") {
        errors.push("channels.teamspeak.sessionDefaults.model must be a string");
      }
      if (sessionDefaults.fastMode !== undefined && typeof sessionDefaults.fastMode !== "boolean") {
        errors.push("channels.teamspeak.sessionDefaults.fastMode must be a boolean");
      }
      if (sessionDefaults.thinkingLevel !== undefined && typeof sessionDefaults.thinkingLevel !== "string") {
        errors.push("channels.teamspeak.sessionDefaults.thinkingLevel must be a string");
      }
    }
  }
  if (value.voice !== undefined) {
    if (!isRecord(value.voice)) {
      errors.push("channels.teamspeak.voice must be an object");
    } else {
      const voice = value.voice;
      const voiceBooleanKeys = ["enabled", "interruptOnSpeech", "stripWakeWord", "mirrorTextReplies"];
      for (const key of voiceBooleanKeys) {
        if (voice[key] !== undefined && typeof voice[key] !== "boolean") {
          errors.push(`channels.teamspeak.voice.${key} must be a boolean`);
        }
      }
      const voiceStringKeys = ["mode", "mediaSocketPath", "transcriptionLanguage"];
      for (const key of voiceStringKeys) {
        if (voice[key] !== undefined && typeof voice[key] !== "string") {
          errors.push(`channels.teamspeak.voice.${key} must be a string`);
        }
      }
      const voiceArrayKeys = ["allowedHandlers", "allowedChannels", "allowedUsers"];
      for (const key of voiceArrayKeys) {
        if (
          voice[key] !== undefined &&
          (!Array.isArray(voice[key]) || voice[key].some((entry) => typeof entry !== "string"))
        ) {
          errors.push(`channels.teamspeak.voice.${key} must be an array of strings`);
        }
      }
      if (
        voice.silenceTimeoutMs !== undefined &&
        !(typeof voice.silenceTimeoutMs === "number" && Number.isInteger(voice.silenceTimeoutMs) && voice.silenceTimeoutMs > 0)
      ) {
        errors.push("channels.teamspeak.voice.silenceTimeoutMs must be a positive integer");
      }
      if (
        voice.mode !== undefined &&
        !["always_on", "wake_word", "push_to_talk", "wake_or_ptt"].includes(voice.mode)
      ) {
        errors.push("channels.teamspeak.voice.mode must be one of always_on, wake_word, push_to_talk, wake_or_ptt");
      }
    }
  }
  return errors.length === 0
    ? {
        ok: true,
        value
      }
    : {
        ok: false,
        errors
      };
}

const teamspeakConfigSchema = {
  validate: validateTeamspeakConfig,
  jsonSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      enabled: { type: "boolean" },
      cliPath: { type: "string" },
      profile: { type: "string" },
      server: { type: "string" },
      nickname: { type: "string" },
      identity: { type: "string" },
      configPath: { type: "string" },
      defaultTo: { type: "string" },
      ingressPath: { type: "string" },
      daemonPollMs: { type: "integer", minimum: 1 },
      sessionDefaults: {
        type: "object",
        additionalProperties: false,
        properties: {
          model: { type: "string" },
          fastMode: { type: "boolean" },
          thinkingLevel: { type: "string" }
        }
      },
      voice: {
        type: "object",
        additionalProperties: false,
        properties: {
          enabled: { type: "boolean" },
          mode: {
            type: "string",
            enum: ["always_on", "wake_word", "push_to_talk", "wake_or_ptt"]
          },
          silenceTimeoutMs: { type: "integer", minimum: 1 },
          interruptOnSpeech: { type: "boolean" },
          stripWakeWord: { type: "boolean" },
          allowedHandlers: {
            type: "array",
            items: { type: "string" }
          },
          allowedChannels: {
            type: "array",
            items: { type: "string" }
          },
          allowedUsers: {
            type: "array",
            items: { type: "string" }
          },
          mediaSocketPath: { type: "string" },
          mirrorTextReplies: { type: "boolean" },
          transcriptionLanguage: { type: "string" }
        }
      }
    }
  }
};

const teamspeakPlugin = createChatChannelPlugin({
  base: createChannelPluginBase({
    id: CHANNEL_ID,
    meta: {
      id: CHANNEL_ID,
      label: "TeamSpeak",
      selectionLabel: "TeamSpeak",
      docsPath: "/docs/teamspeak-bridge-design.md",
      blurb: "Bridge TeamSpeak chat through the local ts daemon and TeamSpeak client plugin."
    },
    capabilities: {
      chatTypes: ["direct", "channel"]
    },
    reload: {
      configPrefixes: [`channels.${CHANNEL_ID}`]
    },
    configSchema: teamspeakConfigSchema,
    config: {
      listAccountIds: () => [DEFAULT_ACCOUNT_ID],
      resolveAccount: (cfg) => resolveTeamspeakChannelConfig(cfg),
      defaultAccountId: () => DEFAULT_ACCOUNT_ID,
      isEnabled: (account) => account.enabled,
      isConfigured: (account) => account.configured,
      resolveDefaultTo: ({ cfg }) => resolveTeamspeakChannelConfig(cfg).defaultTo || undefined,
      describeAccount: (account) => ({
        accountId: account.accountId,
        enabled: account.enabled,
        configured: account.configured,
        cliPath: account.cliPath,
        webhookPath: account.ingressPath
      })
    },
    setup: {
      resolveAccountId: () => DEFAULT_ACCOUNT_ID,
      applyAccountConfig: ({ cfg, input }) => {
        const current = isRecord(cfg?.channels?.[CHANNEL_ID]) ? cfg.channels[CHANNEL_ID] : {};
        return {
          ...cfg,
          channels: {
            ...cfg.channels,
            [CHANNEL_ID]: {
              ...current,
              enabled: true,
              ...(input.cliPath ? { cliPath: input.cliPath } : {})
            }
          }
        };
      }
    }
  }),
  outbound: {
    deliveryMode: "direct",
    sendText: async (ctx) => {
      const account = resolveTeamspeakChannelConfig(ctx.cfg);
      return await sendTeamspeakText(account, ctx.to, ctx.text);
    }
  }
});

export default defineChannelPluginEntry({
  id: CHANNEL_ID,
  name: "TeamSpeak",
  description: "Local TeamSpeak bridge powered by ts daemon hooks",
  plugin: teamspeakPlugin,
  configSchema: teamspeakConfigSchema,
  setRuntime: runtimeStore.setRuntime,
  registerFull(api) {
    const account = resolveTeamspeakChannelConfig(api.config);
    api.registerGatewayMethod(
      "teamspeak.voice.status",
      ({ respond }) => {
        respond(true, {
          enabled: resolveTeamspeakChannelConfig(api.config).voice.enabled,
          sessionDefaults: resolveTeamspeakChannelConfig(api.config).sessionDefaults,
          connected: sharedState.voice.connected,
          connecting: sharedState.voice.connecting,
          voiceStartPending: Boolean(sharedState.voice.startTimer),
          reconnectAttempt: sharedState.voice.reconnectAttempt || undefined,
          nextReconnectDelayMs: sharedState.voice.reconnectTimer
            ? sharedState.voice.lastReconnectDelayMs || undefined
            : undefined,
          suppressedConnectionFailures: sharedState.voice.suppressedConnectionFailures || undefined,
          mediaSocketPath: sharedState.voice.mediaSocketPath,
          mediaFormat: sharedState.voice.mediaFormat,
          mediaTransport: sharedState.voice.mediaTransport,
          playbackActive: sharedState.voice.playbackActive,
          queuedPlaybackSamples: sharedState.voice.queuedPlaybackSamples,
          queuedPlaybackBufferMs: queuedPlaybackBufferMs(),
          activeSpeakerCount: sharedState.voice.activeSpeakerCount,
          droppedIngressChunks: sharedState.voice.droppedIngressChunks,
          droppedPlaybackChunks: sharedState.voice.droppedPlaybackChunks,
          wakeTriggers: sharedState.voice.wakeTriggers,
          wakeFetchedAt: sharedState.voice.wakeFetchedAt || undefined,
          lastHelloAt: sharedState.voice.lastHelloAt || undefined,
          lastStatusAt: sharedState.voice.lastStatusAt || undefined,
          lastError: sharedState.voice.lastError || undefined,
          lastPlaybackMetrics: sharedState.voice.lastPlaybackMetrics || undefined,
          lastTranscriptionMetrics: sharedState.voice.lastTranscriptionMetrics || undefined,
          lastPromptGuidance: sharedState.voice.lastPromptGuidance || undefined,
          startupError: sharedState.voice.startupError || undefined
        });
      },
      { scope: "operator.read" }
    );
    api.registerGatewayMethod(
      "teamspeak.voice.reconnect",
      async ({ respond }) => {
        if (!sharedState.routeStateDir) {
          respond(false, undefined, {
            code: "service_not_started",
            message: "TeamSpeak service state is not initialized yet"
          });
          return;
        }
        await stopTeamspeakVoiceManager(api.logger);
        await startTeamspeakVoiceManager(api.config, sharedState.routeStateDir, api.logger);
        respond(true, {
          ok: true,
          connected: sharedState.voice.connected,
          mediaSocketPath: sharedState.voice.mediaSocketPath || undefined,
          startupError: sharedState.voice.startupError || undefined
        });
      },
      { scope: "operator.admin" }
    );
    api.registerGatewayMethod(
      "teamspeak.voice.testSpeak",
      async ({ params, respond }) => {
        if (!sharedState.voice.connected || !sharedState.voice.socket || sharedState.voice.socket.destroyed) {
          respond(false, undefined, {
            code: "voice_not_connected",
            message: "TeamSpeak voice media socket is not connected"
          });
          return;
        }
        const text = normalizeOptionalString(params?.text) || "This is a TeamSpeak voice playback test.";
        const generation = sharedState.voice.playbackGeneration;
        try {
          await readSelfIdentity(api.config);
          const synthesis = await synthesizeTeamspeakReplyAudio(text, api.logger);
          if (generation !== sharedState.voice.playbackGeneration) {
            respond(false, undefined, {
              code: "playback_interrupted",
              message: "TeamSpeak playback was interrupted before audio could be queued"
            });
            return;
          }
          const playbackMetrics = await playbackTeamspeakAudioBuffer(synthesis.pcmBuffer, api.logger, generation);
          sharedState.voice.lastPlaybackMetrics = {
            source: "testSpeak",
            updatedAt: Date.now(),
            replyChars: text.length,
            ttsMs: synthesis.ttsMs,
            wavBytes: synthesis.wavBytes,
            audioDurationMs: synthesis.audioDurationMs,
            ...(playbackMetrics || {})
          };
          respond(true, {
            ok: true,
            text,
            connected: sharedState.voice.connected,
            mediaSocketPath: sharedState.voice.mediaSocketPath || undefined
          });
        } catch (error) {
          sharedState.voice.lastPlaybackMetrics = {
            source: "testSpeak",
            updatedAt: Date.now(),
            replyChars: text.length,
            error: String(error)
          };
          respond(false, undefined, {
            code: "playback_failed",
            message: String(error)
          });
        }
      },
      { scope: "operator.admin" }
    );
    api.registerHttpRoute({
      path: account.ingressPath,
      auth: "plugin",
      match: "exact",
      replaceExisting: true,
      handler: async (req, res) => {
        if (req.method !== "POST") {
          res.statusCode = 405;
          res.setHeader("allow", "POST");
          res.end("Method Not Allowed");
          return true;
        }
        const providedSecret = normalizeOptionalString(req.headers["x-openclaw-teamspeak-secret"]);
        if (!sharedState.ingressSecret || !providedSecret || !safeEqualText(providedSecret, sharedState.ingressSecret)) {
          res.statusCode = 401;
          res.setHeader("content-type", "text/plain; charset=utf-8");
          res.end("Unauthorized");
          return true;
        }
        const body = await readJsonWebhookBodyOrReject({ req, res });
        if (!body.ok) {
          return true;
        }
        const normalized = normalizeInboundPayload(body.value);
        if (!normalized.ok) {
          sendJson(res, 202, {
            ok: true,
            ignored: normalized.ignored
          });
          return true;
        }
        try {
          const outcome = await handleInboundTeamspeakEvent(api.config, normalized.value, api.logger);
          sendJson(res, 200, {
            ok: true,
            ...outcome
          });
        } catch (error) {
          api.logger.error?.(`[teamspeak] inbound dispatch failed: ${String(error)}`);
          sendJson(res, 500, {
            ok: false,
            error: String(error)
          });
        }
        return true;
      }
    });
    api.registerService({
      id: "teamspeak-daemon",
      start: async (ctx) => {
        sharedState.stopping = false;
        sharedState.serviceConfig = ctx.config;
        sharedState.routeStateDir = ensureTeamspeakStateDir(ctx.stateDir);
        sharedState.ingressSecret = ensureIngressSecret(sharedState.routeStateDir);
        loadRouteCache();
        await reconcileHooks(ctx.config, ctx.logger).catch((error) => {
          ctx.logger.warn?.(`[teamspeak] hook reconciliation failed: ${String(error)}`);
        });
        const daemonStatus = await readDaemonStatus(ctx.config);
        if (daemonStatus?.running) {
          sharedState.daemonOwned = false;
          ctx.logger.info?.("[teamspeak] daemon already running; leaving existing process in place");
        } else {
          sharedState.daemonOwned = true;
          startOwnedDaemon(ctx.config, ctx.logger);
        }
        if (resolveTeamspeakChannelConfig(ctx.config).voice.enabled) {
          scheduleTeamspeakVoiceManagerStart(ctx.config, sharedState.routeStateDir, ctx.logger);
        } else {
          await stopTeamspeakVoiceManager(ctx.logger);
        }
      },
      stop: async (ctx) => {
        sharedState.stopping = true;
        await stopTeamspeakVoiceManager(ctx.logger);
        if (sharedState.daemonOwned) {
          stopOwnedDaemon();
        }
        sharedState.daemonOwned = false;
      }
    });
  }
});
