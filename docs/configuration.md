# Configuration

Config lives under `channels.teamspeak`.

## Core keys

```json
{
  "channels": {
    "teamspeak": {
      "enabled": true,
      "cliPath": "ts",
      "profile": "my-teamspeak-profile",
      "server": "ts.example.net:9987",
      "nickname": "OpenClaw",
      "identity": "...optional...",
      "configPath": "...optional...",
      "defaultTo": "teamspeak:channel:lobby",
      "ingressPath": "/plugins/teamspeak/inbound",
      "daemonPollMs": 1000
    }
  }
}
```

If `cliPath` is omitted, the plugin falls back to the first non-empty environment override it finds:
- `OPENCLAW_TEAMSPEAK_CLI_PATH`
- `TEAMSPEAK_CLI_PATH`
- `TS_CLI_PATH`

If none are set, it uses `ts` from `PATH`.

## Session defaults

Use this to bias TeamSpeak sessions toward a model/profile optimized for chat or voice latency.

```json
{
  "channels": {
    "teamspeak": {
      "sessionDefaults": {
        "model": "openai-codex/gpt-5.3-codex-spark",
        "fastMode": true,
        "thinkingLevel": "off"
      }
    }
  }
}
```

The plugin applies these to the mapped OpenClaw session before the turn runs.

## Command authorization

TeamSpeak ingress defaults to `CommandAuthorized: false`. Set
`commandAuthorization` only for TeamSpeak users or channels that should be able
to trigger downstream OpenClaw commands that trust that field.

```json
{
  "channels": {
    "teamspeak": {
      "commandAuthorization": {
        "mode": "allowlist",
        "allowedHandlers": ["default"],
        "allowedChannels": ["42"],
        "allowedUsers": ["uid:abc123", "client:17"]
      }
    }
  }
}
```

Modes:
- `"none"` authorizes no TeamSpeak turns
- `"allowlist"` authorizes turns matching any listed handler, channel id, UID, or client id
- `"all"` authorizes every TeamSpeak turn and should only be used on tightly controlled servers

## Text message trust

TeamSpeak text messages are treated as trusted by default to preserve existing behavior. Set `channelMessages.trust` or `directMessages.trust` to `"untrusted"` for shared, public, or otherwise lower-trust surfaces. Untrusted text is never `CommandAuthorized`, is forced out of owner handling, and the raw message body is attached as untrusted context for prompt assembly.

```json
{
  "channels": {
    "teamspeak": {
      "channelMessages": {
        "trust": "untrusted"
      },
      "directMessages": {
        "trust": "trusted"
      }
    }
  }
}
```

Values:
- `"trusted"` preserves normal text-message handling and still requires `commandAuthorization` before `CommandAuthorized` can be true
- `"untrusted"` downgrades TeamSpeak text even if `commandAuthorization` would otherwise allow it

## Voice config

```json
{
  "channels": {
    "teamspeak": {
      "voice": {
        "enabled": true,
        "mode": "wake_word",
        "silenceTimeoutMs": 1200,
        "interruptOnSpeech": true,
        "interruptMode": "wake_word",
        "stripWakeWord": true,
        "allowedHandlers": [],
        "allowedChannels": [],
        "allowedUsers": [],
        "mediaSocketPath": "",
        "mirrorTextReplies": false,
        "transcriptionLanguage": "en"
      }
    }
  }
}
```

`interruptMode` is only used when `interruptOnSpeech` is `true`:
- `"any_speech"` interrupts playback on any other detected speaker start
- `"wake_word"` interrupts only when a finalized utterance is accepted by the wake-word path

Because the current TeamSpeak voice path is finalize-then-transcribe, `"wake_word"` interruption happens after the new utterance is finalized and transcribed, not on the first syllable.

`mode` caveats:
- `"push_to_talk"` is configured but not currently usable because TeamSpeak media frames do not expose PTT state
- `"wake_or_ptt"` currently behaves like `"wake_word"` for the same reason; non-wake utterances are dropped

## STT integration

The plugin uses the normal OpenClaw media-audio path. Example:

```json
{
  "tools": {
    "media": {
      "audio": {
        "enabled": true,
        "language": "en",
        "models": [
          {
            "provider": "openai",
            "model": "whisper-1",
            "baseUrl": "http://stt.example.internal:8000/v1"
          }
        ],
        "request": {
          "allowPrivateNetwork": true,
          "auth": {
            "mode": "authorization-bearer",
            "token": "replace-me"
          }
        }
      }
    }
  }
}
```

## TTS integration

The plugin uses OpenClaw `talk.speak` and expects a voice-capable provider already configured in OpenClaw.

For TeamSpeak voice playback, `talk.speak` must return base64 WAV audio. MP3, Opus, raw PCM, and other returned formats are not decoded by this plugin right now.

## Live contract checks

After upgrading `teamspeak-cli`, the TeamSpeak client plugin, or OpenClaw, run:

```bash
npm run smoke:contracts
```

See `docs/live-contracts.md` for the exact JSON fields and operational assumptions this checks.

## Notes

- `defaultTo` is used for proactive outbound TeamSpeak messaging when no stronger route is available
- `voice.allowedChannels` and `voice.allowedUsers` apply to accepted voice input; use `commandAuthorization` for `CommandAuthorized`
- `mediaSocketPath` is usually best left blank unless the runtime needs an override
- `teamspeak:dm:<uid>` sends use the volatile UID to client-id cache and fall back to a live client list lookup
- the ingress secret is stored in the plugin state directory and passed to the hook relay by private secret-file path; keep hook listings and state permissions private on multi-user hosts
- voice transcription writes temporary WAV files under plugin state and removes them after STT; keep the state directory private and clean stale temp files after unclean exits
