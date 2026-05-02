import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { beforeEach } from "node:test";
import { fileURLToPath } from "node:url";

import pluginEntry, { __testInternals as teamspeak } from "../index.js";

const REPO_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

beforeEach(() => {
  teamspeak.resetSharedStateForTests();
});

test("plugin entry keeps TeamSpeak metadata and config schema available", () => {
  assert.equal(pluginEntry.id, "teamspeak");
  assert.equal(pluginEntry.name, "TeamSpeak");
  assert.equal(pluginEntry.configSchema, teamspeak.teamspeakConfigSchema);
  assert.equal(pluginEntry.plugin.base.id, "teamspeak");
  assert.equal(pluginEntry.plugin.base.meta.docsPath, "/docs/configuration.md");
  assert.equal(fs.existsSync(path.join(REPO_DIR, pluginEntry.plugin.base.meta.docsPath.slice(1))), true);
  assert.deepEqual(teamspeak.teamspeakConfigSchema.jsonSchema.properties.voice.properties.interruptMode, {
    type: "string",
    enum: ["any_speech", "wake_word"]
  });
  assert.deepEqual(pluginEntry.plugin.base.capabilities.chatTypes, ["direct", "channel"]);
});

test("channel config normalization applies defaults, trimming, and voice policy", () => {
  const account = teamspeak.resolveTeamspeakChannelConfig({
    channels: {
      teamspeak: {
        enabled: false,
        cliPath: "/definitely/missing/ts",
        profile: " work ",
        server: " ts.example.test ",
        nickname: " Claw ",
        identity: " ident ",
        configPath: " /tmp/ts-config.json ",
        defaultTo: " teamspeak:channel:42 ",
        ingressPath: "custom/inbound",
        daemonPollMs: "2500",
        sessionDefaults: {
          model: " gpt-test ",
          fastMode: true,
          thinkingLevel: "HIGH"
        },
        commandAuthorization: {
          mode: "allowlist",
          allowedHandlers: [" handler-a "],
          allowedChannels: [" 42 "],
          allowedUsers: [" uid:user-a "]
        },
        voice: {
          enabled: true,
          mode: "wake_or_ptt",
          silenceTimeoutMs: "1750",
          interruptOnSpeech: false,
          interruptMode: "wake_word",
          stripWakeWord: false,
          allowedHandlers: [" handler-a ", ""],
          allowedChannels: [" 42 "],
          allowedUsers: [" uid:user-a "],
          mediaSocketPath: " /tmp/ts-media.sock ",
          mirrorTextReplies: true,
          transcriptionLanguage: " en "
        }
      }
    }
  });

  assert.equal(account.accountId, "default");
  assert.equal(account.enabled, false);
  assert.equal(account.configured, false);
  assert.equal(account.cliPath, "/definitely/missing/ts");
  assert.equal(account.profile, "work");
  assert.equal(account.server, "ts.example.test");
  assert.equal(account.nickname, "Claw");
  assert.equal(account.identity, "ident");
  assert.equal(account.configPath, "/tmp/ts-config.json");
  assert.equal(account.defaultTo, "teamspeak:channel:42");
  assert.equal(account.ingressPath, "/custom/inbound");
  assert.equal(account.daemonPollMs, 2500);
  assert.deepEqual(account.sessionDefaults, {
    model: "gpt-test",
    fastMode: true,
    thinkingLevel: "high",
    raw: {
      model: " gpt-test ",
      fastMode: true,
      thinkingLevel: "HIGH"
    }
  });
  assert.deepEqual(account.commandAuthorization, {
    mode: "allowlist",
    allowedHandlers: ["handler-a"],
    allowedChannels: ["42"],
    allowedUsers: ["uid:user-a"],
    raw: {
      mode: "allowlist",
      allowedHandlers: [" handler-a "],
      allowedChannels: [" 42 "],
      allowedUsers: [" uid:user-a "]
    }
  });
  assert.equal(account.voice.enabled, true);
  assert.equal(account.voice.mode, "wake_or_ptt");
  assert.equal(account.voice.silenceTimeoutMs, 1750);
  assert.equal(account.voice.interruptOnSpeech, false);
  assert.equal(account.voice.interruptMode, "wake_word");
  assert.equal(account.voice.stripWakeWord, false);
  assert.deepEqual(account.voice.allowedHandlers, ["handler-a"]);
  assert.deepEqual(account.voice.allowedChannels, ["42"]);
  assert.deepEqual(account.voice.allowedUsers, ["uid:user-a"]);
  assert.equal(account.voice.mediaSocketPath, "/tmp/ts-media.sock");
  assert.equal(account.voice.mirrorTextReplies, true);
  assert.equal(account.voice.transcriptionLanguage, "en");
});

test("cli path resolution prefers explicit config, then env, then default", () => {
  const previousOpenClaw = process.env.OPENCLAW_TEAMSPEAK_CLI_PATH;
  const previousTeamspeak = process.env.TEAMSPEAK_CLI_PATH;
  const previousTs = process.env.TS_CLI_PATH;
  try {
    delete process.env.OPENCLAW_TEAMSPEAK_CLI_PATH;
    delete process.env.TEAMSPEAK_CLI_PATH;
    delete process.env.TS_CLI_PATH;
    assert.equal(teamspeak.resolveTeamspeakCliPath({ cliPath: " /bin/custom-ts " }), "/bin/custom-ts");
    assert.equal(teamspeak.resolveTeamspeakCliPath({}), "ts");
    process.env.TEAMSPEAK_CLI_PATH = " /env/teamspeak ";
    process.env.OPENCLAW_TEAMSPEAK_CLI_PATH = " /env/openclaw ";
    process.env.TS_CLI_PATH = " /env/ts ";
    assert.equal(teamspeak.resolveTeamspeakCliPath({}), "/env/openclaw");
    delete process.env.OPENCLAW_TEAMSPEAK_CLI_PATH;
    assert.equal(teamspeak.resolveTeamspeakCliPath({}), "/env/teamspeak");
  } finally {
    if (previousOpenClaw === undefined) {
      delete process.env.OPENCLAW_TEAMSPEAK_CLI_PATH;
    } else {
      process.env.OPENCLAW_TEAMSPEAK_CLI_PATH = previousOpenClaw;
    }
    if (previousTeamspeak === undefined) {
      delete process.env.TEAMSPEAK_CLI_PATH;
    } else {
      process.env.TEAMSPEAK_CLI_PATH = previousTeamspeak;
    }
    if (previousTs === undefined) {
      delete process.env.TS_CLI_PATH;
    } else {
      process.env.TS_CLI_PATH = previousTs;
    }
  }
});

test("config schema validation accepts valid settings and reports precise invalid paths", () => {
  assert.deepEqual(
    teamspeak.validateTeamspeakConfig({
      enabled: true,
      daemonPollMs: 1000,
      sessionDefaults: {
        model: "gpt-test",
        fastMode: false,
        thinkingLevel: "low"
      },
      commandAuthorization: {
        mode: "allowlist",
        allowedHandlers: ["default"],
        allowedChannels: ["42"],
        allowedUsers: ["uid:user-a"]
      },
      voice: {
        enabled: true,
        mode: "wake_word",
        silenceTimeoutMs: 1000,
        interruptOnSpeech: true,
        interruptMode: "any_speech",
        stripWakeWord: true,
        allowedHandlers: ["default"],
        allowedChannels: ["42"],
        allowedUsers: ["uid:user-a"],
        mediaSocketPath: "/tmp/media.sock",
        mirrorTextReplies: false,
        transcriptionLanguage: "en"
      }
    }),
    {
      ok: true,
      value: {
        enabled: true,
        daemonPollMs: 1000,
        sessionDefaults: {
          model: "gpt-test",
          fastMode: false,
          thinkingLevel: "low"
        },
        commandAuthorization: {
          mode: "allowlist",
          allowedHandlers: ["default"],
          allowedChannels: ["42"],
          allowedUsers: ["uid:user-a"]
        },
        voice: {
          enabled: true,
          mode: "wake_word",
          silenceTimeoutMs: 1000,
          interruptOnSpeech: true,
          interruptMode: "any_speech",
          stripWakeWord: true,
          allowedHandlers: ["default"],
          allowedChannels: ["42"],
          allowedUsers: ["uid:user-a"],
          mediaSocketPath: "/tmp/media.sock",
          mirrorTextReplies: false,
          transcriptionLanguage: "en"
        }
      }
    }
  );

  const invalid = teamspeak.validateTeamspeakConfig({
    enabled: "true",
    daemonPollMs: 0,
    sessionDefaults: {
      model: 123,
      fastMode: "yes",
      thinkingLevel: false
    },
    commandAuthorization: {
      mode: "everybody",
      allowedUsers: ["uid:user-a", 7]
    },
    voice: {
      enabled: "yes",
      mode: "invalid",
      silenceTimeoutMs: -1,
      interruptOnSpeech: "true",
      allowedUsers: ["uid:user-a", 7]
    }
  });

  assert.equal(invalid.ok, false);
  assert.deepEqual(invalid.errors, [
    "channels.teamspeak.enabled must be a boolean",
    "channels.teamspeak.daemonPollMs must be a positive integer",
    "channels.teamspeak.sessionDefaults.model must be a string",
    "channels.teamspeak.sessionDefaults.fastMode must be a boolean",
    "channels.teamspeak.sessionDefaults.thinkingLevel must be a string",
    "channels.teamspeak.commandAuthorization.mode must be one of none, allowlist, all",
    "channels.teamspeak.commandAuthorization.allowedUsers must be an array of strings",
    "channels.teamspeak.voice.enabled must be a boolean",
    "channels.teamspeak.voice.interruptOnSpeech must be a boolean",
    "channels.teamspeak.voice.allowedUsers must be an array of strings",
    "channels.teamspeak.voice.silenceTimeoutMs must be a positive integer",
    "channels.teamspeak.voice.mode must be one of always_on, wake_word, push_to_talk, wake_or_ptt"
  ]);
});

test("config schema validation rejects invalid interruptMode type and enum", () => {
  assert.deepEqual(
    teamspeak.validateTeamspeakConfig({
      voice: {
        interruptMode: false
      }
    }),
    {
      ok: false,
      errors: ["channels.teamspeak.voice.interruptMode must be a string"]
    }
  );

  assert.deepEqual(
    teamspeak.validateTeamspeakConfig({
      voice: {
        interruptMode: "invalid"
      }
    }),
    {
      ok: false,
      errors: ["channels.teamspeak.voice.interruptMode must be one of any_speech, wake_word"]
    }
  );
});

test("config schema validation rejects unknown keys where additionalProperties is false", () => {
  const invalid = teamspeak.validateTeamspeakConfig({
    unknownTopLevel: true,
    sessionDefaults: {
      unknownSessionDefault: true
    },
    commandAuthorization: {
      unknownCommandAuthorization: true
    },
    voice: {
      unknownVoice: true
    }
  });

  assert.equal(invalid.ok, false);
  assert.deepEqual(invalid.errors, [
    "channels.teamspeak.unknownTopLevel is not allowed",
    "channels.teamspeak.sessionDefaults.unknownSessionDefault is not allowed",
    "channels.teamspeak.commandAuthorization.unknownCommandAuthorization is not allowed",
    "channels.teamspeak.voice.unknownVoice is not allowed"
  ]);
});

test("session-default patch params include only configured values", () => {
  assert.equal(teamspeak.buildSessionDefaultsPatchParams(null), null);
  assert.equal(teamspeak.buildSessionDefaultsPatchParams({}), null);
  assert.deepEqual(
    teamspeak.buildSessionDefaultsPatchParams({
      model: " gpt-test ",
      fastMode: false,
      thinkingLevel: "HIGH"
    }),
    {
      model: "gpt-test",
      fastMode: false,
      thinkingLevel: "high"
    }
  );
});

test("inbound payload normalization handles client, channel, env fallback, and ignored events", () => {
  const clientBody = {
    event: {
      type: "message.received",
      timestamp: "2026-02-03T04:05:06.000Z",
      fields: {
        message_kind: "1",
        from_id: "17",
        from_name: " Alice ",
        from_unique_identifier: " uid-alice ",
        to_id: "99",
        text: " hello there ",
        handler: "default"
      }
    }
  };
  const normalizedClient = teamspeak.normalizeInboundPayload(clientBody);
  assert.equal(normalizedClient.ok, true);
  assert.equal(normalizedClient.value.messageKind, "client");
  assert.deepEqual(normalizedClient.value.sender, {
    id: "17",
    name: "Alice",
    uid: "uid-alice"
  });
  assert.deepEqual(normalizedClient.value.target, {
    id: "99",
    mode: "client"
  });
  assert.equal(normalizedClient.value.text, "hello there");
  assert.equal(normalizedClient.value.timestamp, Date.parse("2026-02-03T04:05:06.000Z"));
  assert.equal(
    teamspeak.normalizeInboundPayload(clientBody).value.fingerprint,
    normalizedClient.value.fingerprint
  );

  const channelBody = {
    event: {
      type: "message.received",
      timestamp: 1234,
      fields: {
        target_mode: 2,
        to_id: "42"
      }
    },
    env: {
      TS_MESSAGE_TEXT: " channel text ",
      TS_MESSAGE_KIND: "channel"
    }
  };
  const normalizedChannel = teamspeak.normalizeInboundPayload(channelBody);
  assert.equal(normalizedChannel.ok, true);
  assert.equal(normalizedChannel.value.messageKind, "channel");
  assert.equal(normalizedChannel.value.target.id, "42");
  assert.equal(normalizedChannel.value.text, "channel text");
  assert.equal(normalizedChannel.value.timestamp, 1234);

  const movedBody = {
    event: {
      type: "client.moved",
      timestamp: "2026-02-03T04:05:07.000Z",
      fields: {
        handler: "default",
        client_id: "17",
        old_channel_id: "41",
        new_channel_id: "42",
        message: "follow me"
      }
    }
  };
  const normalizedMoved = teamspeak.normalizeInboundPayload(movedBody);
  assert.equal(normalizedMoved.ok, true);
  assert.equal(normalizedMoved.value.eventType, "client.moved");
  assert.equal(normalizedMoved.value.messageKind, "channel");
  assert.deepEqual(normalizedMoved.value.sender, {
    id: "17",
    name: "",
    uid: ""
  });
  assert.deepEqual(normalizedMoved.value.target, {
    id: "42",
    mode: "channel"
  });
  assert.equal(
    normalizedMoved.value.text,
    "TeamSpeak client 17 moved channels. Old channel id: 41. New channel id: 42. Move message: follow me"
  );
  assert.deepEqual(normalizedMoved.value.movement, {
    clientId: "17",
    oldChannelId: "41",
    newChannelId: "42",
    message: "follow me"
  });
  assert.equal(normalizedMoved.value.timestamp, Date.parse("2026-02-03T04:05:07.000Z"));
  assert.equal(
    teamspeak.normalizeInboundPayload(movedBody).value.fingerprint,
    normalizedMoved.value.fingerprint
  );

  assert.deepEqual(
    teamspeak.normalizeInboundPayload({ event: { type: "message.received", fields: { message_kind: 3, text: "x" } } }),
    { ok: false, ignored: "server chat is not routed" }
  );
  assert.deepEqual(
    teamspeak.normalizeInboundPayload({ event: { type: "client.moved", fields: { old_channel_id: "41" } } }),
    { ok: false, ignored: "client move event missing client id" }
  );
  assert.deepEqual(
    teamspeak.normalizeInboundPayload({ event: { type: "client.moved", fields: { client_id: "17" } } }),
    { ok: false, ignored: "client move event missing channel id" }
  );
  assert.deepEqual(
    teamspeak.normalizeInboundPayload({ event: { type: "message.received", fields: { message_kind: "client", text: "x" } } }),
    { ok: false, ignored: "dm event missing sender identity" }
  );
});

test("dedupe claims each inbound fingerprint once until state is reset", () => {
  assert.equal(teamspeak.claimInboundFingerprint("fingerprint-a"), true);
  assert.equal(teamspeak.claimInboundFingerprint("fingerprint-a"), false);
  assert.equal(teamspeak.claimInboundFingerprint("fingerprint-b"), true);

  teamspeak.resetSharedStateForTests();
  assert.equal(teamspeak.claimInboundFingerprint("fingerprint-a"), true);
});

test("hook command construction quotes URLs, secret files, and hook records consistently", () => {
  teamspeak.sharedState.ingressSecret = "super-hidden-secret";
  teamspeak.sharedState.routeStateDir = "/tmp/team speak'state";
  const command = teamspeak.buildHookExecCommand({
    gateway: {
      port: 19999
    },
    channels: {
      teamspeak: {
        ingressPath: "teamspeak/hook"
      }
    }
  });

  assert.match(
    command,
    /^'.+' '.+hook-relay\.js' --url 'http:\/\/127\.0\.0\.1:19999\/teamspeak\/hook' --secret-file '\/tmp\/team speak'"'"'state\/ingress-secret\.txt'$/
  );
  assert.equal(command.includes("super-hidden-secret"), false);
  assert.deepEqual(
    teamspeak.normalizeHookRecord({
      hook_id: "hook-1",
      event_type: "message.received",
      command_line: command,
      message_kind: "2"
    }),
    {
      id: "hook-1",
      type: "message.received",
      exec: command,
      messageKind: "channel"
    }
  );
  assert.deepEqual(
    teamspeak.normalizeHookRecord({
      hook_id: "hook-moved",
      event_type: "client.moved",
      command_line: command
    }),
    {
      id: "hook-moved",
      type: "client.moved",
      exec: command,
      messageKind: ""
    }
  );
  assert.deepEqual(
    teamspeak.daemonHookDefinitions.map((definition) => teamspeak.buildHookAddArgs(definition, command)),
    [
      ["events", "hook", "add", "--type", "message.received", "--message-kind", "client", "--exec", command],
      ["events", "hook", "add", "--type", "message.received", "--message-kind", "channel", "--exec", command],
      ["events", "hook", "add", "--type", "client.moved", "--exec", command]
    ]
  );
  assert.equal(
    teamspeak.hookMatchesDefinition(
      teamspeak.normalizeHookRecord({ event_type: "client.moved", command_line: command }),
      teamspeak.daemonHookDefinitions[2]
    ),
    true
  );
  assert.equal(teamspeak.normalizeHookRecord({ id: "missing-type" }), null);
});

test("client move notifications are informational and never command-authorized", () => {
  const commandAuthorization = {
    mode: "allowlist",
    allowedChannels: ["42"],
    allowedUsers: ["client:17"]
  };
  assert.equal(
    teamspeak.resolveTeamspeakCommandAuthorized({
      eventType: "message.received",
      messageKind: "channel",
      sender: { id: "17" },
      target: { id: "42" }
    }, commandAuthorization),
    true
  );
  assert.equal(
    teamspeak.resolveTeamspeakCommandAuthorized({
      eventType: "client.moved",
      messageKind: "channel",
      sender: { id: "17" },
      target: { id: "42" }
    }, commandAuthorization),
    false
  );
  assert.match(
    teamspeak.buildTeamspeakEventSystemPrompt({ eventType: "client.moved" }),
    /automatic TeamSpeak client movement notification/
  );
});

test("ingress secret helper creates private state and secret files", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "teamspeak-secret-"));
  const stateDir = path.join(root, "teamspeak");
  try {
    fs.mkdirSync(stateDir, { mode: 0o755 });
    fs.chmodSync(stateDir, 0o755);
    const secret = teamspeak.ensureIngressSecret(stateDir);
    const secretPath = teamspeak.ingressSecretFilePath(stateDir);

    assert.match(secret, /^[0-9a-f]{48}$/);
    assert.equal(fs.statSync(stateDir).mode & 0o777, 0o700);
    assert.equal(fs.statSync(secretPath).mode & 0o777, 0o600);
    assert.equal(fs.readFileSync(secretPath, "utf8").trim(), secret);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("ingress secret helper repairs and rotates exposed existing secret files", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "teamspeak-secret-"));
  const stateDir = path.join(root, "teamspeak");
  try {
    fs.mkdirSync(stateDir, { mode: 0o700 });
    const secretPath = teamspeak.ingressSecretFilePath(stateDir);
    fs.writeFileSync(secretPath, "leaked-secret\n", { mode: 0o644 });
    fs.chmodSync(secretPath, 0o644);

    const secret = teamspeak.ensureIngressSecret(stateDir);

    assert.notEqual(secret, "leaked-secret");
    assert.match(secret, /^[0-9a-f]{48}$/);
    assert.equal(fs.statSync(secretPath).mode & 0o777, 0o600);
    assert.equal(fs.readFileSync(secretPath, "utf8").trim(), secret);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
