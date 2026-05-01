#!/usr/bin/env node
import { spawn } from "node:child_process";

const DEFAULT_TIMEOUT_MS = 10000;
const MAX_OUTPUT_BYTES = 1024 * 1024;

const failures = [];
const warnings = [];

function usage() {
  return `Usage: node scripts/live-contract-smoke.js [options]

Options:
  --skip-ts                 Skip TeamSpeak CLI checks
  --skip-openclaw           Skip OpenClaw gateway checks
  --include-tts             Also call talk.speak and require base64 WAV output
  --require-voice-connected Fail if teamspeak.voice.status.connected is false
  --timeout-ms <ms>         Per-command timeout, default ${DEFAULT_TIMEOUT_MS}
  --ts-bin <path>           TeamSpeak CLI path
  --openclaw-bin <path>     OpenClaw CLI path
  --profile <name>          TeamSpeak profile argument
  --server <host[:port]>    TeamSpeak server argument
  --nickname <name>         TeamSpeak nickname argument
  --identity <identity>     TeamSpeak identity argument
  --config <path>           TeamSpeak CLI config path
  --help                    Show this help`;
}

function readOption(args, index, name) {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

function parseArgs(argv) {
  const options = {
    includeTts: false,
    requireVoiceConnected: false,
    skipOpenclaw: false,
    skipTs: false,
    timeoutMs: Number.parseInt(process.env.TEAMSPEAK_CONTRACT_TIMEOUT_MS || "", 10) || DEFAULT_TIMEOUT_MS,
    tsBin:
      process.env.OPENCLAW_TEAMSPEAK_CLI_PATH ||
      process.env.TEAMSPEAK_CLI_PATH ||
      process.env.TS_CLI_PATH ||
      "ts",
    openclawBin: process.env.OPENCLAW_CLI_PATH || "openclaw",
    profile: process.env.TEAMSPEAK_PROFILE || "",
    server: process.env.TEAMSPEAK_SERVER || "",
    nickname: process.env.TEAMSPEAK_NICKNAME || "",
    identity: process.env.TEAMSPEAK_IDENTITY || "",
    config: process.env.TEAMSPEAK_CONFIG_PATH || ""
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help") {
      console.log(usage());
      process.exit(0);
    } else if (arg === "--skip-ts") {
      options.skipTs = true;
    } else if (arg === "--skip-openclaw") {
      options.skipOpenclaw = true;
    } else if (arg === "--include-tts") {
      options.includeTts = true;
    } else if (arg === "--require-voice-connected") {
      options.requireVoiceConnected = true;
    } else if (arg === "--timeout-ms") {
      options.timeoutMs = Number.parseInt(readOption(argv, index, arg), 10);
      index += 1;
    } else if (arg === "--ts-bin") {
      options.tsBin = readOption(argv, index, arg);
      index += 1;
    } else if (arg === "--openclaw-bin") {
      options.openclawBin = readOption(argv, index, arg);
      index += 1;
    } else if (arg === "--profile") {
      options.profile = readOption(argv, index, arg);
      index += 1;
    } else if (arg === "--server") {
      options.server = readOption(argv, index, arg);
      index += 1;
    } else if (arg === "--nickname") {
      options.nickname = readOption(argv, index, arg);
      index += 1;
    } else if (arg === "--identity") {
      options.identity = readOption(argv, index, arg);
      index += 1;
    } else if (arg === "--config") {
      options.config = readOption(argv, index, arg);
      index += 1;
    } else {
      throw new Error(`unknown option ${arg}`);
    }
  }

  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new Error("--timeout-ms must be a positive integer");
  }

  return options;
}

function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function firstField(record, names) {
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(record, name)) {
      return {
        name,
        value: record[name]
      };
    }
  }
  return null;
}

function pass(label, detail = "") {
  console.log(`[ok] ${label}${detail ? ` - ${detail}` : ""}`);
}

function warn(label, detail = "") {
  warnings.push({ label, detail });
  console.warn(`[warn] ${label}${detail ? ` - ${detail}` : ""}`);
}

function fail(label, detail = "") {
  failures.push({ label, detail });
  console.error(`[fail] ${label}${detail ? ` - ${detail}` : ""}`);
}

function requireRecord(label, value) {
  if (isRecord(value)) {
    pass(label, "JSON object");
    return true;
  }
  fail(label, `expected JSON object, got ${Array.isArray(value) ? "array" : typeof value}`);
  return false;
}

function requireArray(label, value) {
  if (Array.isArray(value)) {
    pass(label, `${value.length} record(s)`);
    return true;
  }
  fail(label, `expected JSON array, got ${isRecord(value) ? "object" : typeof value}`);
  return false;
}

function requireField(label, record, names, type) {
  const field = firstField(record, names);
  if (!field) {
    fail(label, `missing ${names.join(" or ")}`);
    return undefined;
  }
  if (type && typeof field.value !== type) {
    fail(label, `${field.name} must be ${type}, got ${typeof field.value}`);
    return undefined;
  }
  pass(label, `${field.name} present`);
  return field.value;
}

function warnMissingField(label, record, names, type = "") {
  const field = firstField(record, names);
  if (!field) {
    warn(label, `missing ${names.join(" or ")}`);
    return undefined;
  }
  if (type && typeof field.value !== type) {
    warn(label, `${field.name} should be ${type}, got ${typeof field.value}`);
    return undefined;
  }
  pass(label, `${field.name} present`);
  return field.value;
}

function buildTsArgs(options, subcommandArgs) {
  const args = ["--json"];
  if (options.profile) {
    args.push("--profile", options.profile);
  }
  if (options.server) {
    args.push("--server", options.server);
  }
  if (options.nickname) {
    args.push("--nickname", options.nickname);
  }
  if (options.identity) {
    args.push("--identity", options.identity);
  }
  if (options.config) {
    args.push("--config", options.config);
  }
  return [...args, ...subcommandArgs];
}

function trimForMessage(value) {
  const normalized = String(value || "").trim();
  return normalized.length > 500 ? `${normalized.slice(0, 500)}...` : normalized;
}

function runJson(command, args, options) {
  const label = `${command} ${args.join(" ")}`;
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let outputTooLarge = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, options.timeoutMs);

    function settle(callback) {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      callback();
    }

    function append(kind, chunk) {
      const text = chunk.toString("utf8");
      if (kind === "stdout") {
        stdout += text;
      } else {
        stderr += text;
      }
      if (stdout.length + stderr.length > MAX_OUTPUT_BYTES) {
        outputTooLarge = true;
        child.kill("SIGTERM");
      }
    }

    child.stdout.on("data", (chunk) => append("stdout", chunk));
    child.stderr.on("data", (chunk) => append("stderr", chunk));
    child.on("error", (error) => {
      settle(() => reject(error));
    });
    child.on("close", (code) => {
      settle(() => {
        if (timedOut) {
          reject(new Error(`${label} timed out after ${options.timeoutMs}ms`));
          return;
        }
        if (outputTooLarge) {
          reject(new Error(`${label} produced more than ${MAX_OUTPUT_BYTES} bytes`));
          return;
        }
        if (code !== 0) {
          reject(new Error(`${label} exited ${code ?? "unknown"}: ${trimForMessage(stderr || stdout)}`));
          return;
        }
        const trimmed = stdout.trim();
        if (!trimmed) {
          resolve(null);
          return;
        }
        try {
          resolve(JSON.parse(trimmed));
        } catch (error) {
          reject(new Error(`${label} did not return valid JSON: ${trimForMessage(trimmed)}`));
        }
      });
    });

    child.stdin.end();
  });
}

async function runTsJson(options, subcommandArgs) {
  const args = buildTsArgs(options, subcommandArgs);
  const label = `ts ${subcommandArgs.join(" ")}`;
  try {
    const value = await runJson(options.tsBin, args, options);
    pass(label, "returned JSON");
    return value;
  } catch (error) {
    fail(label, String(error.message || error));
    return undefined;
  }
}

async function runOpenClawJson(options, method, params = undefined) {
  const args = ["gateway", "call", method, "--json", "--timeout", String(options.timeoutMs)];
  if (params !== undefined) {
    args.push("--params", JSON.stringify(params));
  }
  try {
    const value = await runJson(options.openclawBin, args, options);
    pass(`openclaw ${method}`, "returned JSON");
    return value;
  } catch (error) {
    fail(`openclaw ${method}`, String(error.message || error));
    return undefined;
  }
}

function validatePluginInfo(value) {
  if (!requireRecord("ts plugin info shape", value)) {
    return {
      hasMediaSocketPath: false
    };
  }
  const mediaSocketPath = warnMissingField("ts plugin info media socket", value, ["media_socket_path"], "string");
  if (mediaSocketPath) {
    warnMissingField("ts plugin info media format", value, ["media_format"], "string");
    warnMissingField("ts plugin info media transport", value, ["media_transport"], "string");
  } else {
    warn("ts plugin info media socket", "runtime will rely on mediaSocketPath config, TS_MEDIA_SOCKET_PATH, or config view fallback");
  }
  return {
    hasMediaSocketPath: Boolean(mediaSocketPath)
  };
}

function validateConfigView(value, pluginInfoState) {
  if (!requireRecord("ts config view shape", value)) {
    return;
  }
  const activeProfile = warnMissingField("ts config view active profile", value, ["active_profile"], "string");
  const profiles = firstField(value, ["profiles"])?.value;
  if (!Array.isArray(profiles)) {
    warn("ts config view profiles", "missing profiles array");
    return;
  }
  pass("ts config view profiles", `${profiles.length} profile(s)`);
  if (!activeProfile) {
    return;
  }
  const active = profiles.find((entry) => isRecord(entry) && entry.name === activeProfile);
  if (!active) {
    warn("ts config view active profile record", `profile ${activeProfile} not found in profiles`);
    return;
  }
  if (!pluginInfoState.hasMediaSocketPath && !process.env.TS_MEDIA_SOCKET_PATH) {
    warnMissingField("ts config view control socket fallback", active, ["control_socket_path"], "string");
  }
}

function validateStatus(value) {
  if (!requireRecord("ts status shape", value)) {
    return;
  }
  warnMissingField("ts status identity", value, ["identity"], "string");
  warnMissingField("ts status nickname", value, ["nickname"], "string");
}

function validateClientList(value) {
  if (!requireArray("ts client list shape", value)) {
    return;
  }
  if (value.length === 0) {
    warn("ts client list records", "no clients returned; TeamSpeak may be disconnected");
    return;
  }
  const self = value.find((entry) => isRecord(entry) && entry.self === true);
  const sample = self || value.find(isRecord);
  if (!sample) {
    warn("ts client list records", "no object records returned");
    return;
  }
  warnMissingField("ts client list client id", sample, ["id"], "string");
  warnMissingField("ts client list nickname", sample, ["nickname"], "string");
  warnMissingField("ts client list unique identity", sample, ["unique_identity", "uid"], "string");
  warnMissingField("ts client list channel id", sample, ["channel_id", "channelId"], "string");
}

function validateHookList(value) {
  if (!requireArray("ts events hook list shape", value)) {
    return;
  }
  const messageHooks = value.filter((entry) => {
    if (!isRecord(entry)) {
      return false;
    }
    const type = firstField(entry, ["type", "event_type", "eventType"])?.value;
    return type === "message.received";
  });
  if (messageHooks.length === 0) {
    warn("ts events hook list message hooks", "no message.received hooks returned");
    return;
  }
  pass("ts events hook list message hooks", `${messageHooks.length} hook(s)`);
  for (const hook of messageHooks) {
    warnMissingField("ts hook id", hook, ["id", "hook_id", "hookId"], "string");
    requireField("ts hook command", hook, ["exec", "command", "command_line", "commandLine"], "string");
    warnMissingField("ts hook message kind", hook, ["message_kind", "messageKind"], "string");
  }
}

function validateDaemonStatus(value) {
  if (!requireRecord("ts daemon status shape", value)) {
    return;
  }
  requireField("ts daemon status running", value, ["running"], "boolean");
  if (value.running === true) {
    warn("ts daemon compatibility", "already-running daemon must match this plugin profile/server/config");
  }
}

function validateVoiceStatus(value, options) {
  if (!requireRecord("teamspeak.voice.status shape", value)) {
    return;
  }
  requireField("teamspeak.voice.status enabled", value, ["enabled"], "boolean");
  requireField("teamspeak.voice.status connected", value, ["connected"], "boolean");
  requireField("teamspeak.voice.status playback active", value, ["playbackActive"], "boolean");
  requireField("teamspeak.voice.status active speaker count", value, ["activeSpeakerCount"], "number");
  warnMissingField("teamspeak.voice.status media socket path", value, ["mediaSocketPath"], "string");
  warnMissingField("teamspeak.voice.status media format", value, ["mediaFormat"], "string");
  warnMissingField("teamspeak.voice.status media transport", value, ["mediaTransport"], "string");
  if (options.requireVoiceConnected && value.connected !== true) {
    fail("teamspeak.voice.status connected", "expected connected true");
  }
}

function validateVoiceWake(value) {
  if (!requireRecord("voicewake.get shape", value)) {
    return;
  }
  const triggers = requireField("voicewake.get triggers", value, ["triggers"]);
  if (triggers !== undefined && !Array.isArray(triggers)) {
    fail("voicewake.get triggers", `expected array, got ${typeof triggers}`);
  } else if (Array.isArray(triggers)) {
    pass("voicewake.get triggers array", `${triggers.length} trigger(s)`);
  }
}

function validateTalkSpeak(value) {
  if (!requireRecord("talk.speak shape", value)) {
    return;
  }
  const audio = firstField(value, ["audioBase64", "audio", "data"])?.value;
  if (typeof audio !== "string" || !audio.trim()) {
    fail("talk.speak audio", "missing base64 audio string");
  } else {
    pass("talk.speak audio", "base64 field present");
  }
  const format =
    String(firstField(value, ["format", "mimeType"])?.value || "").toLowerCase();
  const extension = String(firstField(value, ["extension"])?.value || "").toLowerCase();
  if (format.includes("wav") || extension === "wav") {
    pass("talk.speak wav format", format || extension);
    return;
  }
  fail("talk.speak wav format", `expected wav, got ${format || extension || "unknown"}`);
}

async function runTsChecks(options) {
  const pluginInfo = await runTsJson(options, ["plugin", "info"]);
  const pluginInfoState = pluginInfo === undefined
    ? { hasMediaSocketPath: false }
    : validatePluginInfo(pluginInfo);

  const configView = await runTsJson(options, ["config", "view"]);
  if (configView !== undefined) {
    validateConfigView(configView, pluginInfoState);
  }

  const status = await runTsJson(options, ["status"]);
  if (status !== undefined) {
    validateStatus(status);
  }

  const clients = await runTsJson(options, ["client", "list"]);
  if (clients !== undefined) {
    validateClientList(clients);
  }

  const hooks = await runTsJson(options, ["events", "hook", "list"]);
  if (hooks !== undefined) {
    validateHookList(hooks);
  }

  const daemonStatus = await runTsJson(options, ["daemon", "status"]);
  if (daemonStatus !== undefined) {
    validateDaemonStatus(daemonStatus);
  }
}

async function runOpenClawChecks(options) {
  const voiceStatus = await runOpenClawJson(options, "teamspeak.voice.status");
  if (voiceStatus !== undefined) {
    validateVoiceStatus(voiceStatus, options);
  }

  const voiceWake = await runOpenClawJson(options, "voicewake.get");
  if (voiceWake !== undefined) {
    validateVoiceWake(voiceWake);
  }

  if (options.includeTts) {
    const talkSpeak = await runOpenClawJson(options, "talk.speak", {
      text: "TeamSpeak contract smoke check."
    });
    if (talkSpeak !== undefined) {
      validateTalkSpeak(talkSpeak);
    }
  } else {
    warn("talk.speak", "skipped; pass --include-tts to verify base64 WAV output");
  }
}

let options;
try {
  options = parseArgs(process.argv.slice(2));
} catch (error) {
  console.error(`[fail] ${String(error.message || error)}`);
  console.error(usage());
  process.exit(2);
}

if (!options.skipTs) {
  await runTsChecks(options);
} else {
  warn("TeamSpeak CLI checks", "skipped by --skip-ts");
}

if (!options.skipOpenclaw) {
  await runOpenClawChecks(options);
} else {
  warn("OpenClaw gateway checks", "skipped by --skip-openclaw");
}

console.log("");
console.log(`Contract smoke complete: ${failures.length} failure(s), ${warnings.length} warning(s).`);

if (failures.length > 0) {
  process.exitCode = 1;
}
