# OpenClaw TeamSpeak Plugin

A real OpenClaw channel plugin for TeamSpeak, not just a one-off workspace hack.

This project bridges the local [`ts`](https://github.com/spi3/teamspeak-cli) client/plugin runtime into OpenClaw so TeamSpeak text and voice can participate in normal OpenClaw sessions.

## What it does

- registers a `teamspeak` channel plugin
- receives TeamSpeak text events through `ts daemon` hooks
- sends outbound text replies back through `ts message send`
- consumes the TeamSpeak media socket for voice input and playback
- transcribes finalized utterances through OpenClaw STT
- synthesizes spoken replies through OpenClaw TTS
- applies per-session defaults for TeamSpeak sessions
- exposes runtime diagnostics through `teamspeak.voice.status`

## Project status

This is live code and currently used in a real OpenClaw runtime.

Current shape:
- production code is still intentionally small and flat
- integration is real, but testing is mostly syntax + live/manual verification
- broader non-message TeamSpeak event integration is deferred until `teamspeak-cli` event docs are clearer

## Repository layout

```text
teamspeak/
├── index.js                 # main OpenClaw plugin entrypoint
├── hook-relay.js            # ts daemon hook -> local HTTP ingress relay
├── openclaw.plugin.json     # plugin id + config schema
├── package.json             # local project metadata + check scripts
├── AGENTS.md                # project-specific maintainer notes
├── CHANGELOG.md             # human changelog
├── CONTRIBUTING.md          # contribution / verification guidance
├── .gitignore
└── docs/
    ├── architecture.md
    ├── configuration.md
    ├── development.md
    └── event-surfaces.md
```

## Runtime dependencies

- OpenClaw with plugin loading enabled
- local `ts` CLI installed
- TeamSpeak 3 client with `teamspeak-cli` plugin bridge loaded
- a reachable OpenClaw gateway

Optional for voice:
- OpenClaw TTS configured (`talk.speak`)
- OpenClaw STT configured (`runtime.stt.transcribeAudioFile(...)`)

## Quick start

Configure `channels.teamspeak` in `~/.openclaw/openclaw.json`:

```json
{
  "channels": {
    "teamspeak": {
      "enabled": true,
      "cliPath": "/home/openclaw/.local/bin/ts",
      "daemonPollMs": 1000,
      "ingressPath": "/plugins/teamspeak/inbound",
      "sessionDefaults": {
        "model": "openai-codex/gpt-5.3-codex-spark",
        "fastMode": true,
        "thinkingLevel": "off"
      },
      "voice": {
        "enabled": true,
        "mode": "wake_word",
        "silenceTimeoutMs": 1200,
        "interruptOnSpeech": true,
        "stripWakeWord": true,
        "mirrorTextReplies": false,
        "transcriptionLanguage": "en"
      }
    }
  }
}
```

For STT/TTS and config details, see:
- `docs/configuration.md`
- `docs/event-surfaces.md`

## Checks

Syntax:

```bash
npm run check
```

Useful live checks:

```bash
/home/openclaw/.local/bin/ts status
/home/openclaw/.local/bin/ts daemon status --json
/home/openclaw/.local/bin/ts events hook list --json
openclaw gateway call teamspeak.voice.status --json
```

## Manual verification

Text path:
1. send a TeamSpeak DM
2. send a TeamSpeak channel message
3. confirm the correct OpenClaw session appears
4. reply from OpenClaw
5. confirm the reply goes back to TeamSpeak

Voice path:
1. confirm `teamspeak.voice.status` reports `connected: true`
2. speak a wake-word-qualified utterance
3. confirm `lastTranscriptionMetrics` updates
4. confirm the agent replies in the correct TeamSpeak session
5. confirm spoken playback returns through the TeamSpeak client

## Known limitations

- TeamSpeak text hooks currently reconcile only `message.received`
- broader `ts events watch` event hookup exists in principle but is not wired into OpenClaw yet
- the media bridge is still the authoritative path for live voice activity
- automated tests are still thin; most confidence comes from live integration checks

## Related docs

- `docs/architecture.md`
- `docs/configuration.md`
- `docs/development.md`
- `docs/event-surfaces.md`
