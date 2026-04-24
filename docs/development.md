# Development

## Local checks

Syntax only:

```bash
npm run check
```

Useful runtime checks:

```bash
ts status
ts daemon status --json
ts events hook list --json
openclaw gateway call teamspeak.voice.status --json
```

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

There is no standalone automated integration harness for this plugin yet.

Confidence comes from:
- syntax validation
- direct gateway diagnostics
- real TeamSpeak text round-trips
- real TeamSpeak voice round-trips

## Recommended next formalization steps

When this project grows further, the next sane steps are:
- split `index.js` into `src/` modules
- add fixture-based tests for event normalization and routing
- add a repeatable local integration script
- move from manual changelog maintenance to tagged releases if it gets a real remote
