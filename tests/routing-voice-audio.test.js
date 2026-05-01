import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { beforeEach } from "node:test";

import { __testInternals as teamspeak } from "../index.js";

const silentLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {}
};

beforeEach(() => {
  teamspeak.resetSharedStateForTests();
});

test("global TeamSpeak CLI args preserve argv boundaries", () => {
  assert.deepEqual(
    teamspeak.buildTsGlobalArgs({
      profile: "work",
      server: "server-a",
      nickname: "Claw Bot",
      identity: "identity-a",
      configPath: "/tmp/config.json"
    }, { json: true }),
    [
      "--json",
      "--profile",
      "work",
      "--server",
      "server-a",
      "--nickname",
      "Claw Bot",
      "--identity",
      "identity-a",
      "--config",
      "/tmp/config.json"
    ]
  );
});

test("outbound targets resolve channels, clients, cached DMs, and send argv", () => {
  assert.deepEqual(teamspeak.parseTeamspeakTarget("teamspeak:channel:42"), {
    kind: "channel",
    id: "42"
  });
  assert.deepEqual(teamspeak.parseTeamspeakTarget("client:17"), {
    kind: "client",
    id: "17"
  });
  assert.equal(teamspeak.parseTeamspeakTarget("discord:channel:42"), null);

  assert.deepEqual(teamspeak.resolveTeamspeakOutboundTarget("teamspeak:channel:42"), {
    cliTarget: "channel",
    id: "42",
    targetKey: "teamspeak:channel:42"
  });
  assert.deepEqual(teamspeak.resolveTeamspeakOutboundTarget("teamspeak:client:17"), {
    cliTarget: "client",
    id: "17",
    targetKey: "teamspeak:client:17"
  });

  teamspeak.sharedState.routeCache.dmByUid.set("uid-alice", {
    uid: "uid-alice",
    clientId: "17",
    senderName: "Alice",
    sessionKey: "session-a",
    updatedAt: 1000
  });
  assert.deepEqual(teamspeak.resolveTeamspeakOutboundTarget("teamspeak:dm:uid-alice"), {
    cliTarget: "client",
    id: "17",
    targetKey: "teamspeak:dm:uid-alice",
    uid: "uid-alice"
  });
  assert.deepEqual(teamspeak.buildTeamspeakTextSendArgs("teamspeak:dm:uid-alice", " hello "), {
    target: {
      cliTarget: "client",
      id: "17",
      targetKey: "teamspeak:dm:uid-alice",
      uid: "uid-alice"
    },
    trimmedText: "hello",
    args: ["message", "send", "--target", "client", "--id", "17", "--text", "hello"]
  });
  assert.throws(
    () => teamspeak.buildTeamspeakTextSendArgs("teamspeak:dm:unknown", "hi"),
    /no recent TeamSpeak client id is known/
  );
  assert.throws(
    () => teamspeak.buildTeamspeakTextSendArgs("teamspeak:channel:42", "   "),
    /refusing to send an empty TeamSpeak message/
  );
});

test("route cache persists direct and channel routes", () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "teamspeak-route-cache-"));
  try {
    teamspeak.sharedState.routeStateDir = stateDir;
    teamspeak.updateDmRouteCache({
      uid: "uid-a",
      clientId: "11",
      senderName: "Alice",
      sessionKey: "dm-session",
      updatedAt: 100
    });
    teamspeak.updateChannelRouteCache({
      channelId: "42",
      sessionKey: "channel-session",
      updatedAt: 200
    });

    const persisted = JSON.parse(fs.readFileSync(path.join(stateDir, "routes.json"), "utf8"));
    assert.deepEqual(persisted.dmByUid, [
      {
        uid: "uid-a",
        clientId: "11",
        senderName: "Alice",
        sessionKey: "dm-session",
        updatedAt: 100
      }
    ]);
    assert.deepEqual(persisted.channelById, [
      {
        channelId: "42",
        sessionKey: "channel-session",
        updatedAt: 200
      }
    ]);

    teamspeak.resetSharedStateForTests();
    teamspeak.sharedState.routeStateDir = stateDir;
    teamspeak.loadRouteCache();
    assert.equal(teamspeak.sharedState.routeCache.dmByUid.get("uid-a").clientId, "11");
    assert.equal(teamspeak.sharedState.routeCache.channelById.get("42").sessionKey, "channel-session");
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test("voice acceptance enforces allow lists and always-on mode", async () => {
  const cfg = {
    channels: {
      teamspeak: {
        cliPath: "/definitely/missing/ts",
        voice: {
          enabled: true,
          mode: "always_on",
          allowedHandlers: ["handler-a"],
          allowedChannels: ["42"],
          allowedUsers: ["uid:user-a", "client:17"]
        }
      }
    }
  };

  assert.deepEqual(
    await teamspeak.evaluateVoiceAcceptance({
      cfg,
      speaker: {
        handlerId: "handler-a",
        channelId: "42",
        uid: "user-a",
        clientId: "17"
      },
      transcript: " hello ",
      logger: silentLogger
    }),
    {
      accepted: true,
      text: "hello",
      wakeMatched: false
    }
  );

  assert.deepEqual(
    await teamspeak.evaluateVoiceAcceptance({
      cfg,
      speaker: {
        handlerId: "handler-b",
        channelId: "42",
        uid: "user-a",
        clientId: "17"
      },
      transcript: "hello",
      logger: silentLogger
    }),
    {
      accepted: false,
      reason: "handler-not-allowed"
    }
  );
});

test("wake-word voice acceptance strips trigger text and respects word boundaries", async () => {
  const cfg = {
    channels: {
      teamspeak: {
        cliPath: "/definitely/missing/ts",
        voice: {
          enabled: true,
          mode: "wake_word",
          stripWakeWord: true
        }
      }
    }
  };
  teamspeak.sharedState.voice.wakeTriggers = ["hey claw", "computer"];
  teamspeak.sharedState.voice.wakeFetchedAt = Date.now();

  assert.deepEqual(teamspeak.findWakeWordMatch("Hey Claw, what's the status?", ["hey claw"]), {
    trigger: "hey claw",
    stripped: "what's the status?"
  });
  assert.equal(teamspeak.findWakeWordMatch("hey clawed is not a wake word", ["hey claw"]), null);
  assert.deepEqual(
    await teamspeak.evaluateVoiceAcceptance({
      cfg,
      speaker: {
        handlerId: "handler-a",
        channelId: "42",
        uid: "user-a",
        clientId: "17"
      },
      transcript: "Hey Claw, what's the status?",
      logger: silentLogger
    }),
    {
      accepted: true,
      text: "what's the status?",
      wakeMatched: true,
      trigger: "hey claw"
    }
  );
});

test("voice reply text cleanup and stream chunk boundary selection are speech-friendly", () => {
  assert.equal(
    teamspeak.normalizeTeamspeakVoiceReplyText(`
# Heading
- [OpenClaw](https://example.test) **works**.
MEDIA: hidden
[[audio_as_voice]]
`),
    "Heading OpenClaw works."
  );
  assert.equal(teamspeak.joinTeamspeakVoiceReplyText("First.", " Second "), "First. Second");
  assert.equal(
    teamspeak.findTeamspeakVoiceReplyBoundary("Short sentence.", 0, false),
    0
  );
  assert.equal(
    teamspeak.findTeamspeakVoiceReplyBoundary("This first sentence is long enough. The second can wait.", 0, false),
    "This first sentence is long enough. The second can wait.".length
  );
  assert.equal(
    teamspeak.findTeamspeakVoiceReplyBoundary("Tail", 0, false, true),
    4
  );
});

test("media frame helpers decode fields and audio conversion keeps expected duration", () => {
  const fields = [
    "tsmedia1",
    "audio.chunk",
    "12345",
    "handler-a",
    "17",
    teamspeak.hexEncode("uid:user-a"),
    teamspeak.hexEncode("Alice"),
    "42",
    "48000",
    "2",
    "960",
    "3840"
  ];
  assert.deepEqual(teamspeak.parseMediaFrameFields(fields), {
    type: "audio.chunk",
    timestamp: 12345,
    handlerId: "handler-a",
    clientId: "17",
    uid: "uid:user-a",
    nickname: "Alice",
    channelId: "42",
    sampleRate: 48000,
    channels: 2,
    frameCount: 960,
    payloadBytes: 3840
  });
  assert.equal(
    teamspeak.buildMediaHeader(["tsmedia1", "status.request"]).toString("utf8"),
    "tsmedia1\tstatus.request\n"
  );

  const mono = teamspeak.mixToMono(new Float32Array([1, -1, 0.5, 0.5]), 2);
  assert.deepEqual([...mono], [0, 0.5]);
  const resampled = teamspeak.resampleFloat32Mono(new Float32Array([0, 1]), 2, 4);
  assert.deepEqual([...resampled], [0, 0.5, 1, 1]);

  const pcmBuffer = Buffer.alloc(4);
  pcmBuffer.writeInt16LE(32767, 0);
  pcmBuffer.writeInt16LE(-32768, 2);
  const wavBuffer = teamspeak.buildWavBufferFromPcm({
    pcmBuffer,
    sampleRate: 48000,
    channels: 1
  });
  const parsed = teamspeak.parseWavPcmToFloat32(wavBuffer);
  assert.equal(parsed.sampleRate, 48000);
  assert.equal(parsed.channels, 1);
  assert.ok(parsed.samples[0] > 0.99);
  assert.equal(parsed.samples[1], -1);

  const playback = teamspeak.convertWavToTeamspeakPlayback(wavBuffer);
  assert.equal(playback.length, 4);
  assert.equal(teamspeak.pcmBufferDurationMs(playback), 0);
});

test("media frame handling updates playback diagnostics and error counters", () => {
  const cfg = {
    channels: {
      teamspeak: {
        cliPath: "/definitely/missing/ts"
      }
    }
  };

  teamspeak.handleVoiceMediaFrame(cfg, {
    fields: [
      "tsmedia1",
      "status",
      "",
      "",
      "1",
      "4800",
      "2",
      "3",
      "4",
      teamspeak.hexEncode("last error")
    ]
  }, silentLogger);
  assert.equal(teamspeak.sharedState.voice.playbackActive, true);
  assert.equal(teamspeak.sharedState.voice.queuedPlaybackSamples, 4800);
  assert.equal(teamspeak.sharedState.voice.activeSpeakerCount, 2);
  assert.equal(teamspeak.sharedState.voice.droppedIngressChunks, 3);
  assert.equal(teamspeak.sharedState.voice.droppedPlaybackChunks, 4);
  assert.equal(teamspeak.sharedState.voice.lastError, "last error");

  teamspeak.handleVoiceMediaFrame(cfg, {
    fields: ["tsmedia1", "playback.stopped"]
  }, silentLogger);
  assert.equal(teamspeak.sharedState.voice.playbackActive, false);
  assert.equal(teamspeak.sharedState.voice.queuedPlaybackSamples, 0);

  teamspeak.sharedState.voice.playbackActive = true;
  teamspeak.sharedState.voice.queuedPlaybackSamples = 100;
  teamspeak.handleVoiceMediaFrame(cfg, {
    fields: [
      "tsmedia1",
      "error",
      "",
      teamspeak.hexEncode("playback_failed"),
      teamspeak.hexEncode("bridge rejected playback")
    ]
  }, silentLogger);
  assert.equal(teamspeak.sharedState.voice.lastError, "playback_failed: bridge rejected playback");
  assert.equal(teamspeak.sharedState.voice.playbackActive, false);
  assert.equal(teamspeak.sharedState.voice.queuedPlaybackSamples, 0);
  assert.equal(teamspeak.sharedState.voice.playbackErrorSeq, 1);
});

test("voice normalized events preserve session model and produce unique fingerprints", () => {
  const channelEvent = teamspeak.buildVoiceNormalizedEvent({
    handlerId: "handler-a",
    clientId: "17",
    uid: "uid:user-a",
    nickname: "Alice",
    channelId: "42"
  }, "hello from voice");
  assert.equal(channelEvent.eventType, "voice.utterance");
  assert.equal(channelEvent.messageKind, "channel");
  assert.deepEqual(channelEvent.sender, {
    id: "17",
    name: "Alice",
    uid: "uid:user-a"
  });
  assert.deepEqual(channelEvent.target, {
    id: "42",
    mode: "channel"
  });

  const dmEvent = teamspeak.buildVoiceNormalizedEvent({
    handlerId: "handler-a",
    clientId: "17",
    uid: "uid:user-a",
    nickname: "Alice",
    channelId: "0"
  }, "hello from voice");
  assert.equal(dmEvent.messageKind, "client");
  assert.equal(dmEvent.target.id, "17");
  assert.notEqual(channelEvent.fingerprint, dmEvent.fingerprint);
});

test("voice diagnostics expose current shared state without mutating it", () => {
  teamspeak.sharedState.voice.connected = true;
  teamspeak.sharedState.voice.mediaSocketPath = "/tmp/ts-media.sock";
  teamspeak.sharedState.voice.mediaFormat = "pcm_s16le_48000_1";
  teamspeak.sharedState.voice.mediaTransport = "unix-stream/frame-v1";
  teamspeak.sharedState.voice.playbackActive = true;
  teamspeak.sharedState.voice.queuedPlaybackSamples = 4800;
  teamspeak.sharedState.voice.activeSpeakerCount = 2;
  teamspeak.sharedState.voice.droppedIngressChunks = 3;
  teamspeak.sharedState.voice.droppedPlaybackChunks = 4;
  teamspeak.sharedState.voice.wakeTriggers = ["hey claw"];
  teamspeak.sharedState.voice.lastError = "playback_error";
  teamspeak.sharedState.voice.lastPlaybackMetrics = { source: "reply" };
  teamspeak.sharedState.voice.lastTranscriptionMetrics = { outcome: "accepted" };
  teamspeak.sharedState.voice.lastPromptGuidance = { eventType: "voice.utterance" };

  assert.deepEqual(
    teamspeak.buildTeamspeakVoiceStatus({
      channels: {
        teamspeak: {
          cliPath: "/definitely/missing/ts",
          sessionDefaults: {
            model: "gpt-test"
          },
          voice: {
            enabled: true
          }
        }
      }
    }),
    {
      enabled: true,
      sessionDefaults: {
        model: "gpt-test",
        fastMode: null,
        thinkingLevel: "",
        raw: {
          model: "gpt-test"
        }
      },
      connected: true,
      connecting: false,
      voiceStartPending: false,
      reconnectAttempt: undefined,
      nextReconnectDelayMs: undefined,
      suppressedConnectionFailures: undefined,
      mediaSocketPath: "/tmp/ts-media.sock",
      mediaFormat: "pcm_s16le_48000_1",
      mediaTransport: "unix-stream/frame-v1",
      playbackActive: true,
      queuedPlaybackSamples: 4800,
      queuedPlaybackBufferMs: 100,
      activeSpeakerCount: 2,
      droppedIngressChunks: 3,
      droppedPlaybackChunks: 4,
      wakeTriggers: ["hey claw"],
      wakeFetchedAt: undefined,
      lastHelloAt: undefined,
      lastStatusAt: undefined,
      lastError: "playback_error",
      lastPlaybackMetrics: { source: "reply" },
      lastTranscriptionMetrics: { outcome: "accepted" },
      lastPromptGuidance: { eventType: "voice.utterance" },
      startupError: undefined
    }
  );
});

test("transcription target resolution reports provider, request, and display hint", () => {
  assert.deepEqual(
    teamspeak.resolveConfiguredAudioTranscriptionTarget({
      tools: {
        media: {
          audio: {
            models: [
              {
                provider: "openai",
                model: "gpt-4o-mini-transcribe"
              }
            ],
            request: {
              allowPrivateNetwork: true
            }
          }
        }
      },
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1"
          }
        }
      }
    }),
    {
      provider: "openai",
      model: "gpt-4o-mini-transcribe",
      baseUrl: "https://api.openai.com/v1",
      allowPrivateNetwork: true,
      hint: "openai/gpt-4o-mini-transcribe @ https://api.openai.com/v1"
    }
  );
});

test("self identity matching prefers uid and client id before nickname-only fallback", () => {
  const selfIdentity = {
    uid: "uid:self",
    clientId: "7",
    nickname: "Claw"
  };
  assert.equal(teamspeak.matchesSelfIdentity({ uid: "uid:self" }, selfIdentity), true);
  assert.equal(teamspeak.matchesSelfIdentity({ clientId: "7" }, selfIdentity), true);
  assert.equal(teamspeak.matchesSelfIdentity({ nickname: "Claw" }, selfIdentity), true);
  assert.equal(teamspeak.matchesSelfIdentity({ uid: "uid:other", nickname: "Claw" }, selfIdentity), false);
  assert.equal(teamspeak.isUsableTeamspeakChannelId("42"), true);
  assert.equal(teamspeak.isUsableTeamspeakChannelId("0"), false);
  assert.equal(teamspeak.buildTeamspeakVoiceReplySystemPrompt({ eventType: "voice.utterance" }).includes("spoken aloud"), true);
  assert.equal(teamspeak.buildTeamspeakVoiceReplySystemPrompt({ eventType: "message.received" }), undefined);
});
