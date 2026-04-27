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

## Notes

- `defaultTo` is used for proactive outbound TeamSpeak messaging when no stronger route is available
- `allowedChannels` and `allowedUsers` apply to accepted voice input, not TeamSpeak text chat
- `mediaSocketPath` is usually best left blank unless the runtime needs an override
