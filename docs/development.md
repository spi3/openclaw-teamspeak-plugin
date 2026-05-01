# Development

## Local checks

Syntax plus unit tests:

```bash
npm run check
```

Unit tests only:

```bash
npm test
```

Useful runtime checks:

```bash
ts status
ts daemon status --json
ts events hook list --json
openclaw gateway call teamspeak.voice.status --json
```

Optional local contract smoke:

```bash
npm run smoke:contracts
```

This is intentionally outside `npm run check` because it requires live local
`ts` and OpenClaw CLIs. Use it after runtime or dependency upgrades to validate
the JSON fields and gateway methods documented in `docs/live-contracts.md`.

## Safe workflow

1. change the plugin files in this directory
2. run `npm run check`
3. if runtime behavior changed, reload or restart the gateway/plugin
4. verify only the relevant path:
   - text ingress
   - voice transcription
   - playback
   - session routing

## Current testing reality

The project has standalone unit tests under `tests/` for the stable pure seams:
- config normalization and schema validation
- text hook event normalization and dedupe
- route-cache persistence and conversation target derivation
- outbound TeamSpeak argv construction
- voice acceptance, reply cleanup, media helpers, and diagnostics
- `hook-relay.js` argument parsing and local HTTP forwarding

There is still no standalone automated integration harness for a live OpenClaw gateway plus TeamSpeak client. Runtime confidence still needs:
- direct gateway diagnostics
- real TeamSpeak text round-trips
- real TeamSpeak voice round-trips
- local live-contract smoke checks for TeamSpeak/OpenClaw JSON shape drift

## Recommended next formalization steps

When this project grows further, the next sane steps are:
- split `index.js` into `src/` modules
- expand the local contract smoke into a repeatable integration script with captured fixtures
- move from manual changelog maintenance to tagged releases if it gets a real remote
