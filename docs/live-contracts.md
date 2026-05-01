# Live Contracts And Audit Assumptions

Unit tests cover the stable pure seams in this repository. They cannot prove
that the installed `ts` CLI, the TeamSpeak client plugin, the OpenClaw gateway,
or the local media socket still expose the JSON fields and protocol details the
plugin expects. Treat this document as the operator/developer checklist for
those live contracts.

## Smoke Check

Run the local contract smoke after upgrading OpenClaw, `teamspeak-cli`, the
TeamSpeak client plugin, or the host profile used by this bridge:

```bash
npm run smoke:contracts
```

The script shells out to local commands only. It does not open external network
connections itself, but it does require the local `ts` and `openclaw` CLIs to be
installed and pointed at the same local runtime the plugin uses.

Useful options:

```bash
npm run smoke:contracts -- --skip-openclaw
npm run smoke:contracts -- --skip-ts
npm run smoke:contracts -- --require-voice-connected
npm run smoke:contracts -- --include-tts
```

The script uses these command paths by default:

- TeamSpeak CLI: `OPENCLAW_TEAMSPEAK_CLI_PATH`, `TEAMSPEAK_CLI_PATH`,
  `TS_CLI_PATH`, then `ts`
- OpenClaw CLI: `OPENCLAW_CLI_PATH`, then `openclaw`

To match a non-default TeamSpeak profile/server, pass `--profile`, `--server`,
`--nickname`, `--identity`, or `--config`, or set the corresponding
`TEAMSPEAK_PROFILE`, `TEAMSPEAK_SERVER`, `TEAMSPEAK_NICKNAME`,
`TEAMSPEAK_IDENTITY`, or `TEAMSPEAK_CONFIG_PATH` environment variable.

## What The Smoke Checks

TeamSpeak CLI and plugin contracts:

- `ts plugin info --json` returns a JSON object and, when voice is available,
  exposes media socket fields such as `media_socket_path`, `media_format`, and
  `media_transport`.
- `ts config view --json` returns `active_profile` and a `profiles` array so the
  media socket fallback can derive a path from `control_socket_path`.
- `ts status --json` exposes self identity fields used for self-message
  suppression, especially `identity` and `nickname`.
- `ts client list --json` returns client records with `id`, `nickname`,
  `unique_identity` or `uid`, and `channel_id` or `channelId` when connected.
- `ts events hook list --json` returns hook records with stable event type,
  command, id, and message-kind fields. The runtime currently compares the hook
  command string exactly, so live round trips should be checked after
  `teamspeak-cli` upgrades.
- `ts daemon status --json` exposes a `running` boolean. If it reports an
  already-running daemon, that external daemon must be using the same profile,
  server, config path, and hook state expected by this plugin.

The script cannot synthesize a real `message.received` hook payload. Capture one
live DM and one live channel payload after `teamspeak-cli` upgrades and confirm
the payload still exposes `fields.message_kind` or `fields.target_mode`,
`fields.from_id`, `fields.from_name`, `fields.from_unique_identifier`,
`fields.to_id`, and `fields.text`. Channel events without `fields.to_id` are
dropped because the plugin cannot route them to a TeamSpeak channel session.

OpenClaw contracts:

- `openclaw gateway call teamspeak.voice.status --json` returns diagnostics with
  `enabled`, `connected`, playback counters, speaker counters, wake trigger
  counts, and redacted media socket state. Use the admin-scoped
  `teamspeak.voice.debugStatus` only when raw local paths and detailed errors
  are needed.
- `openclaw gateway call voicewake.get --json` returns a `triggers` array used
  by wake-word and `wake_or_ptt` voice modes.
- `talk.speak` is not called by default because many TTS providers require
  outbound network access. Use `--include-tts` only when the configured TTS path
  is safe to exercise; the script then verifies that the returned audio is
  base64 WAV, which is the only playback format this plugin currently accepts.

The smoke script does not mutate sessions, so it does not call
`sessions.patch`. It also cannot directly prove
`runtime.stt.transcribeAudioFile(...)`; validate STT by speaking a real
wake-word-qualified utterance and confirming `lastTranscriptionMetrics` updates
in `teamspeak.voice.status`.

## Assumptions Operators Must Know

`wake_or_ptt` currently behaves like `wake_word`. The media frames consumed by
this plugin do not expose PTT state, so non-wake utterances are still dropped.
`push_to_talk` is explicitly unsupported until the media socket provides PTT
metadata.

DM replies to `teamspeak:dm:<uid>` use the current UID to client-id route cache
and fall back to a live `ts client list --json` lookup. That lookup still
requires the user to be online and visible to the configured TeamSpeak client.
Target `teamspeak:client:<id>` when an operator knows the live client id.

Webhook ingress assumes local host trust plus a generated shared secret. The
hook command passes a private secret-file path to `hook-relay.js`; the bearer
secret itself is stored under plugin state with owner-only permissions. Treat
the TeamSpeak/OpenClaw host as trusted, keep state files private, and rotate the
ingress secret if local state permissions may have leaked.

Voice TTS playback requires `talk.speak` to return base64 WAV audio. MP3, Opus,
raw PCM, and other formats fail playback and can fall back to text behavior.

Voice transcription writes temporary WAV files under the plugin state directory
and removes them in a `finally` path after STT returns. Sensitive speech can
exist briefly on disk, and a process crash can leave stale temp WAV files behind.
Keep the OpenClaw state directory private, monitor available disk, and clean
stale TeamSpeak voice temp files during maintenance if the process exits
uncleanly.

Inbound dedupe uses a 60 second TTL and a fingerprint derived from normalized
event fields. Retries after the TTL can become new turns, and two identical
events with the same parsed timestamp can collapse. If a future
`teamspeak-cli` event id becomes available, prefer it in the fingerprint and
capture live duplicate-hook fixtures.

## Manual Live Verification

After runtime changes, still verify the paths the script cannot prove:

1. Send a TeamSpeak DM and confirm the reply targets the same live client.
2. Send TeamSpeak channel messages from two channel ids and confirm they keep
   the shared channel session context while replies still target the originating
   TeamSpeak channel id.
3. Capture real DM and channel `message.received` hook payloads and confirm the
   expected `fields.*` names are still present.
4. Inspect `ts events hook list --json` after restart and confirm hooks are not
   removed/re-added repeatedly.
5. Speak a wake-word-qualified utterance and confirm transcription, wake
   acceptance, session routing, TTS synthesis, and playback metrics update.
6. If using an externally started daemon, confirm its profile, server, config
   path, and hook state match `channels.teamspeak`.
