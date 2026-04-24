# Contributing

## Ground rules

- keep the plugin local-only and fail closed
- do not commit live secrets, webhook secrets, or private TeamSpeak identities
- prefer small focused changes over broad rewrites
- keep TeamSpeak CLI interactions argv-based, never shell-interpolated

## Before changing behavior

Read:
- `README.md`
- `docs/architecture.md`
- `docs/configuration.md`
- `docs/event-surfaces.md`

## Verification

Run:

```bash
npm run check
```

Then, when the change affects runtime behavior, verify the smallest relevant live path:

### Text

```bash
ts daemon status --json
ts events hook list --json
```

Send a real TeamSpeak DM or channel message and confirm the mapped OpenClaw session and outbound reply behavior.

### Voice

```bash
openclaw gateway call teamspeak.voice.status --json
```

Check the relevant fields for your change, such as:
- `connected`
- `lastPlaybackMetrics`
- `lastTranscriptionMetrics`
- `lastPromptGuidance`

## Issue policy

If `ts` / `teamspeak-cli` behavior is confusing, unclear, or blocks integration cleanly, open or update an issue on:
- `spi3/teamspeak-cli`
