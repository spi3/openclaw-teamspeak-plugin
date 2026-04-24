# Repository Guidelines

## Project Structure & Module Organization

This plugin is now a small but proper project. `index.js` is still the OpenClaw plugin entrypoint and owns daemon supervision, webhook ingress, routing, dedupe, voice media handling, and outbound reply dispatch. `hook-relay.js` forwards `ts daemon` hook payloads into the local HTTP ingress. `openclaw.plugin.json` defines plugin metadata and the `channels.teamspeak` config schema. Project docs live under `docs/`, with `README.md` as the operator-facing entrypoint.

## Build, Check, and Development Commands

There is no build step; OpenClaw loads `./index.js` directly.

- `npm run check`
  Runs syntax validation for the main plugin and relay helper.
- `npm run check:plugin`
  Syntax-checks `index.js` only.
- `npm run check:relay`
  Syntax-checks `hook-relay.js` only.
- `ts daemon status --json`
  Confirms the TeamSpeak daemon is up.
- `ts events hook list --json`
  Confirms required hook registrations exist.
- `openclaw gateway call teamspeak.voice.status --json`
  Reads voice/media diagnostics from the live plugin.

## Architecture Notes

Preserve the current split between:
- TeamSpeak text ingress through `ts daemon` hooks
- TeamSpeak voice/media ingress through the dedicated media socket

Do not collapse those paths casually; they solve different problems. Session routing must stay stable: DMs key off sender identity, channel chat keys off TeamSpeak channel id, and accepted voice turns route into the same session model. Outbound TeamSpeak CLI calls must stay argv-based.

## Coding Style & Naming Conventions

Use ESM JavaScript only; `package.json` is set to `"type": "module"`. Match the existing style: 2-space indentation, double quotes, semicolons, `camelCase` for functions and locals, and `UPPER_SNAKE_CASE` for shared constants. Prefer small helpers and Node built-ins over new dependencies.

## Testing Guidelines

This project currently relies on syntax checks plus live integration verification. Validate the smallest meaningful path for the change:
- text hook ingestion
- session routing
- transcription acceptance
- playback behavior
- diagnostics exposure

If automated tests are added later, place them under `tests/` and focus first on event normalization, conversation key derivation, and outbound command construction.

## Commit & Pull Request Guidelines

Keep commits focused and imperative. If this repo gets a remote, PRs should summarize the behavior change, note config/schema updates, and include the verification commands that were actually run.

## Security & Configuration Tips

Never commit live TeamSpeak identities, webhook secrets, or private OpenClaw config values. Keep examples sanitized. If `ts` / `teamspeak-cli` behavior is confusing or unclear, prefer opening an upstream issue over encoding folklore in this project.
