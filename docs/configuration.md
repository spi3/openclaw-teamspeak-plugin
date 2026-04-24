# Configuration

Config lives under `channels.teamspeak`.

## Core keys

```json
{
  "channels": {
    "teamspeak": {
      "enabled": true,
      "cliPath": "/home/openclaw/.local/bin/ts",
      "profile": "wormhole-alpha",
      "server": "172.16.2.10:9987",
      "nickname": "Calder",
      "identity": "...optional...",
      "configPath": "...optional...",
      "defaultTo": "teamspeak:channel:1",
      "ingressPath": "/plugins/teamspeak/inbound",
      "daemonPollMs": 1000
    }
  }
}
```

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
            "baseUrl": "http://10.10.10.129:8000/v1"
          }
        ],
        "request": {
          "allowPrivateNetwork": true,
          "auth": {
            "mode": "authorization-bearer",
            "token": "x"
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
