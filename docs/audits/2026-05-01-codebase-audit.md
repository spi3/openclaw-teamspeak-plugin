# TeamSpeak Plugin Codebase Audit

Date: 2026-05-01

This document records a deep review of the OpenClaw TeamSpeak plugin across
security, correctness, reliability, performance, resource usage, convention,
schema consistency, and implicit codebase assumptions.

The review used multiple focused subagent passes and a local validation pass.
No production code was changed as part of the review.

Verification run:

```bash
npm run check
```

Result: syntax validation and all unit tests passed.

## Scope

Reviewed files:

- `index.js`
- `hook-relay.js`
- `openclaw.plugin.json`
- `README.md`
- `docs/*.md`
- `tests/*.js`

Primary runtime areas reviewed:

- TeamSpeak daemon hook reconciliation
- HTTP webhook ingress
- inbound event normalization
- session routing and route cache
- dedupe behavior
- TeamSpeak CLI command construction
- daemon supervision
- voice media socket parsing
- voice utterance buffering and transcription
- TTS synthesis and playback
- gateway diagnostics
- config schema and docs consistency

## Executive Summary

The codebase is compact and has useful unit coverage around pure seams, argv
construction, config normalization, route cache persistence, voice helpers, and
diagnostics. The main risks are not syntax or obvious style issues. They are
runtime contract assumptions and missing bounds around long-running or external
interfaces.

Highest priority items:

1. Channel routing currently uses one peer id, `"all"`, for all TeamSpeak
   channel chat even though repository guidance says TeamSpeak channel chat
   should key off channel id.
2. Inbound dedupe claims a message before dispatch succeeds, so retryable
   failures can be converted into dropped duplicate events.
3. Every inbound TeamSpeak turn is marked `CommandAuthorized: true`; whether
   exploitable depends on OpenClaw semantics, but the trust boundary is broad.
4. Media socket receive buffers and speaker audio buffers lack hard size and
   duration caps.
5. Subprocess and relay HTTP calls lack timeouts and output/input caps.
6. `interruptMode` is supported by docs/runtime/manifest but missing from the
   exported runtime schema and manual validator.
7. Several important contracts depend on live TeamSpeak CLI, OpenClaw gateway,
   and media socket behavior that should be captured as fixtures or smoke
   checks.

## Confirmed Findings

### 1. Channel Sessions Collapse To One Peer Id

Severity: High

Refs:

- `index.js:46`
- `index.js:2161`
- `docs/architecture.md:72`
- `AGENTS.md:32`

The code defines `TEAMSPEAK_CHANNEL_SESSION_ID = "all"` and passes that as the
route peer id for every TeamSpeak channel turn:

```js
const sessionPeerId =
  normalized.messageKind === "client"
    ? normalizeOptionalString(normalized.sender.uid) || normalizeOptionalString(normalized.sender.id)
    : TEAMSPEAK_CHANNEL_SESSION_ID;
```

The actual TeamSpeak channel id is preserved for outbound targeting through
`OriginatingTo`, but not for the route peer id used to resolve the OpenClaw
session.

Impact:

- Multiple TeamSpeak channels can share one OpenClaw channel session.
- Context and routing may bleed across otherwise separate TeamSpeak channels.
- This contradicts repository guidance stating channel chat keys off TeamSpeak
  channel id.

Remediation:

- `"all"` is intentional. The bot is one TeamSpeak client that may be moved by
  users or move itself between server channels, so splitting OpenClaw context by
  TeamSpeak channel id would make those moves look like unexpected context loss.
- Preserve the originating TeamSpeak channel id for outbound targeting and
  diagnostics.
- Keep tests and architecture docs explicit about the shared channel session
  model so future reviews do not treat it as accidental collapse.

### 2. Failed Inbound Dispatches Are Deduped Before Success

Severity: High

Refs:

- `index.js:26`
- `index.js:2112`
- `index.js:2276`
- `index.js:3244`

`dispatchTeamspeakTurn` claims the fingerprint at function entry. Later work can
still fail: self identity lookup, route resolution, session defaults, route cache
persistence, agent dispatch, or outbound delivery. The HTTP handler returns
`500` on failure, but retries within the TTL will hit the dedupe cache and be
treated as handled.

Impact:

- Retryable failures can drop real messages for up to `DEDUPE_TTL_MS`.
- Operators may see ingress failures but retries do not recover the event.

Remediation:

- Track an in-flight state and release it on failure.
- Or commit dedupe only after successful dispatch/delivery.
- Add a route-level test that simulates a failure followed by a retry.

### 3. TeamSpeak Ingress Marks Every Turn As Command Authorized

Severity: High if OpenClaw treats this as authorization; otherwise Medium

Refs:

- `index.js:2226`
- `index.js:2254`

Every inbound TeamSpeak turn sets:

```js
CommandAuthorized: true
```

This applies to DMs, channel text, and accepted voice turns.

Impact:

- If downstream OpenClaw command/tool logic trusts this field, any TeamSpeak
  user who can reach the bot may trigger actions that should require explicit
  authorization.
- The code currently has voice allowlists but no equivalent text ACLs.

Assumption:

- Exploitability depends on OpenClaw's semantics for `CommandAuthorized`.

Remediation:

- Default TeamSpeak ingress to unauthorized unless explicitly allowed.
- Add text allowlists by UID, channel, handler, server role, or configured trust
  policy.
- Document how `CommandAuthorized` is intended to be used for TeamSpeak.

### 4. Media Socket Receive Buffer Is Unbounded

Severity: High

Refs:

- `index.js:2727`
- `index.js:2737`
- `index.js:2742`

The socket `data` handler appends every chunk with `Buffer.concat` and waits for
a newline plus declared payload length. There is no maximum header length, frame
payload length, or total buffered bytes.

Impact:

- A malformed or compromised local media socket can grow memory indefinitely by
  sending a huge header, omitting newlines, declaring a large payload, or
  withholding completion.
- Repeated `Buffer.concat` can become O(n^2) copying and block the event loop.

Remediation:

- Add max header bytes, max payload bytes, and max buffered bytes.
- Reject negative or oversized payload lengths.
- Destroy and reconnect on protocol violations.
- Keep a socket-local parser buffer rather than a global shared buffer.
- Validate the protocol version field before parsing payload fields.

### 5. Voice Utterance Audio Is Buffered Without Caps

Severity: High

Refs:

- `index.js:2654`
- `index.js:2676`
- `index.js:2680`
- `index.js:2425`

Each speaker state stores `chunks: []`. Every `audio.chunk` payload is pushed
until `speaker.stop` or silence finalization. The silence timer is reset on each
chunk, so continuous audio can grow without bound.

Impact:

- Long speech, stuck VAD, malicious input, or many concurrent speakers can
  consume unbounded RAM.
- Finalization concatenates the full utterance and writes a WAV synchronously,
  creating additional memory and I/O spikes.

Remediation:

- Track per-speaker bytes and duration.
- Cap max utterance duration, max utterance bytes, and max active speakers.
- Finalize early or drop over-limit utterances with clear diagnostics.
- Consider streaming/chunked STT if available.

### 6. Subprocess Wrapper Has No Timeout Or Output Caps

Severity: Medium

Refs:

- `index.js:377`
- `index.js:387`
- `index.js:390`

`runCommand` spawns external commands and accumulates full stdout/stderr strings
without a timeout or byte cap. It is used for `ts` and `openclaw` gateway calls.

Impact:

- A hung subprocess can pin HTTP ingress, voice finalization, or service startup.
- A noisy subprocess can grow memory and create oversized error messages.

Remediation:

- Add a timeout with process kill.
- Add `maxStdoutBytes` and `maxStderrBytes`.
- Use shorter hot-path timeouts for sends and live lookups.
- Truncate error messages safely.

### 7. Hook Relay Can Hang And Buffers Without Caps

Severity: Medium

Refs:

- `hook-relay.js:28`
- `hook-relay.js:45`
- `hook-relay.js:64`

`hook-relay.js` reads all stdin into one string, posts without a request timeout,
and accumulates the full response body.

Impact:

- Each daemon hook subprocess can hang indefinitely if the gateway accepts a
  connection but never responds.
- Unexpectedly large stdin or response bodies can consume memory.

Remediation:

- Add stdin and response byte caps.
- Add a request timeout and destroy the request on timeout.
- Fail fast with a clear nonzero exit.

### 8. Ingress Secret Is Stored In Hook Command And Process Args

Severity: Medium

Refs:

- `index.js:1796`
- `index.js:1802`
- `hook-relay.js:20`

The hook command embeds the ingress secret as `--secret`. That command can be
visible through hook listings, process args, or logs depending on host and CLI
behavior.

Impact:

- A local user or operator with access to hook metadata can recover the secret
  and forge local webhook events.

Remediation:

- Have the relay read the secret from a `0600` state file.
- Or use a protected file descriptor/environment setup if process visibility is
  acceptable for the deployment.
- Document that hook listings contain bearer-equivalent material until changed.

### 9. UID-Only DM Events May Be Accepted But Unrepliable

Severity: Medium

Refs:

- `index.js:1411`
- `index.js:1541`
- `index.js:2202`
- `index.js:2257`
- `tests/routing-voice-audio.test.js:90`

Inbound DM normalization accepts a sender UID without a sender client id. Later,
the reply target is built as `teamspeak:dm:<uid>`. Outbound DM sending requires a
cached client id, but the cache is updated only when both UID and client id are
present.

Impact:

- A first DM with UID but no client id can dispatch to the agent and then fail
  outbound delivery.
- Proactive DMs can fail after restart, cache loss, or client reconnect.

Remediation:

- Require `from_id` for DMs that need replies.
- Or resolve UID to live client id before dispatch or before send.
- Document the volatile client-id cache requirement.

### 10. `interruptMode` Schema Drift

Severity: Medium

Refs:

- `index.js:197`
- `index.js:215`
- `index.js:2879`
- `index.js:2950`
- `openclaw.plugin.json:79`
- `docs/configuration.md:78`

Runtime normalization supports `voice.interruptMode`, docs advertise it, and the
manifest schema includes it. The exported runtime `teamspeakConfigSchema` omits
it, and the manual validator does not type-check or enum-check it.

Impact:

- OpenClaw UI or runtime consumers may reject, ignore, or fail to expose a
  supported config key.
- Invalid values silently normalize to `"any_speech"`.

Remediation:

- Add `interruptMode` to `teamspeakConfigSchema.jsonSchema`.
- Add manual validator checks for type and enum.
- Add valid and invalid test coverage.

### 11. Runtime Validator Does Not Enforce `additionalProperties: false`

Severity: Medium

Refs:

- `index.js:2829`
- `index.js:2928`
- `openclaw.plugin.json:8`
- `tests/config-and-ingress.test.js:126`

The JSON schemas declare `additionalProperties: false`, but the manual
`validateTeamspeakConfig` only validates selected known fields. Unknown keys at
the top level, under `sessionDefaults`, or under `voice` pass validation.

Impact:

- Typos are silently accepted.
- Schema and validator behavior drift.

Remediation:

- Reject unknown keys in each object according to the declared schema.
- Add tests for unknown keys at each nesting level.

### 12. HTTP Ingress Holds Connection Through Full Dispatch

Severity: Medium

Refs:

- `index.js:3212`
- `index.js:3239`

The webhook route awaits full inbound handling before responding. That path can
perform CLI calls, route/session work, model dispatch, and outbound sends.

Impact:

- Bursts of daemon hooks can tie up HTTP sockets and start many expensive
  dispatches concurrently.

Remediation:

- Add a bounded queue or semaphore.
- Return `429` or `503` when saturated.
- Or acknowledge quickly only after enqueueing into a bounded queue with clear
  overflow behavior.

### 13. Voice Socket Parser Uses Global Buffer Across Socket Lifetimes

Severity: Medium

Refs:

- `index.js:2711`
- `index.js:2727`
- `index.js:2757`

The `data` handler appends to `sharedState.voice.buffer` without first checking
that the emitting socket is still the active `sharedState.voice.socket`. Close
and error handlers guard stale sockets, but data does not.

Impact:

- Late frames from a stale socket during reconnect can corrupt the active
  parser buffer.

Remediation:

- Use a socket-local buffer closed over by the handler.
- Or ignore `data` when `sharedState.voice.socket !== socket`.

### 14. TTS Decode And Playback Allocate Full Audio Synchronously

Severity: Medium

Refs:

- `index.js:1016`
- `index.js:1021`
- `index.js:631`
- `index.js:710`
- `index.js:727`

The TTS path decodes full base64 audio, parses WAV into a `Float32Array`,
resamples synchronously, and creates another PCM buffer.

Impact:

- Oversized or unexpectedly long TTS output can spike memory and block the event
  loop.

Remediation:

- Reject TTS audio above max bytes or duration before conversion.
- Validate WAV metadata before allocating arrays.
- Consider chunked or worker-thread conversion for larger audio.

### 15. Diagnostics Expose Internal Runtime Details

Severity: Low to Medium, depending on OpenClaw ACLs

Refs:

- `index.js:914`
- `index.js:3126`
- `tests/routing-voice-audio.test.js:408`

`teamspeak.voice.status` is scoped to `operator.read` and returns fields such as
media socket path, wake triggers, last errors, prompt guidance, playback metrics,
transcription metrics, and STT base URL metadata.

Impact:

- Operators with broad read access can learn local filesystem paths, private
  service endpoints, wake trigger text, and internal prompt guidance.

Remediation:

- Define a stable public diagnostics contract.
- Redact paths, base URLs, and detailed errors by default.
- Put sensitive detail behind an admin-only method if needed.

### 16. Existing Ingress Secret File Permissions Are Trusted

Severity: Low

Refs:

- `index.js:1207`
- `index.js:1230`

New ingress secret files are written with mode `0600`, but existing files and
the containing state directory are accepted without ownership or mode checks.

Impact:

- If the file or directory is accidentally world-readable, local users can steal
  the webhook secret.

Remediation:

- `stat` state directory and secret file on startup.
- Require current-user ownership and no group/world read/write bits.
- `chmod` or rotate unsafe files.

### 17. Plugin Metadata Points To Missing Docs

Severity: Low

Refs:

- `index.js:2990`

The plugin metadata uses:

```js
docsPath: "/docs/teamspeak-bridge-design.md"
```

That file is not present in this repository.

Impact:

- UI or help links can land on a missing document.

Remediation:

- Point to an existing doc, such as `docs/architecture.md` or
  `docs/configuration.md`, or remove the field if the path is external.

### 18. Route Cache Persistence Is Synchronous On Inbound Path

Severity: Low

Refs:

- `index.js:1227`
- `index.js:2261`
- `index.js:2270`

Route cache updates persist the full cache with `fs.writeFileSync` during
inbound dispatch.

Impact:

- Bursts of inbound messages can block the event loop on filesystem writes.

Remediation:

- Debounce persistence.
- Use async writes.
- Persist on interval/shutdown with a dirty flag.

## Codebase Assumption Audit

This section captures assumptions baked into the codebase. Some are defensible
design choices; others need tests, docs, or live contract verification.

### A1. `wake_or_ptt` Is Useful Without PTT Metadata

Classification: Undocumented / fragile

Refs:

- `index.js:184`
- `index.js:870`
- `index.js:877`
- `openclaw.plugin.json:63`

The config accepts `wake_or_ptt`, but media frames do not expose PTT state.
`push_to_talk` is explicitly dropped, while `wake_or_ptt` falls through to
wake-word matching.

Failure mode:

- Operators configure `wake_or_ptt` expecting PTT turns to work, but non-wake
  utterances are dropped.

Suggested action:

- Document that `wake_or_ptt` currently behaves as wake-word mode.
- Or normalize it only when PTT metadata exists.
- Add a test for current fallback semantics.

### A2. TeamSpeak CLI JSON Shapes Are Stable

Classification: Needs live verification

Refs:

- `index.js:490`
- `index.js:505`
- `index.js:1909`
- `index.js:1918`
- `index.js:1971`
- `docs/event-surfaces.md:26`

The code assumes fields from `ts plugin info`, `ts config view`, `ts status`,
`ts client list`, and `ts client get`, including:

- `media_socket_path`
- `media_format`
- `media_transport`
- `active_profile`
- `control_socket_path`
- `identity`
- `nickname`
- `unique_identity`
- `channel_id`

Failure mode:

- Voice never connects.
- Self-authored messages loop.
- Channel correction fails.
- Diagnostics are wrong.

Suggested action:

- Capture live JSON fixtures from the supported `teamspeak-cli` version.
- Add a smoke script that asserts required fields.
- Document the minimum supported `teamspeak-cli` version.

### A3. Hook Commands Round Trip With Exact String Equality

Classification: Fragile

Refs:

- `index.js:1796`
- `index.js:1844`
- `index.js:1851`
- `tests/config-and-ingress.test.js:305`

Hook reconciliation compares `hook.exec === desiredExec`.

Failure mode:

- If `ts events hook list --json` canonicalizes paths, quoting, whitespace, or
  command line fields differently, the plugin may remove/re-add hooks on every
  restart or miss stale hooks.

Suggested action:

- Live-verify hook list round-trip behavior.
- Consider structural matching for relay path, URL, and secret source rather
  than full command-string equality.

### A4. Inbound Message Field Names Are Stable

Classification: Needs live verification

Refs:

- `index.js:1372`
- `index.js:1383`
- `index.js:1407`
- `tests/config-and-ingress.test.js:226`

Normalization assumes:

- `fields.message_kind` or `fields.target_mode`
- `fields.from_id`
- `fields.from_name`
- `fields.from_unique_identifier`
- `fields.to_id`
- `fields.text`

Env fallback exists only for kind, from, and text.

Failure mode:

- Messages are ignored with 202.
- Channel messages without `to_id` are dropped.
- DMs without sender id/uid are dropped.

Suggested action:

- Capture real hook payloads for DM and channel events.
- Add fixture tests for those exact payloads.

### A5. DM Sends Require Current Volatile Client Id

Classification: Fragile / partially documented by tests

Refs:

- `index.js:1247`
- `index.js:1541`
- `index.js:2257`
- `tests/routing-voice-audio.test.js:45`

TeamSpeak UID targets are resolved through a local route cache containing the
current client id.

Failure mode:

- Proactive DMs to known users fail after restart, cache loss, or reconnect.

Suggested action:

- Document the limitation in user-facing docs.
- Attempt live lookup by UID before failing.

### A6. Self-Message Suppression Can Rely On Best-Effort Identity Discovery

Classification: Risky

Refs:

- `index.js:1896`
- `index.js:1934`
- `index.js:2014`
- `tests/routing-voice-audio.test.js:512`

The plugin uses `ts status` and `ts client list` to identify itself. If uid and
client id are missing, nickname-only matching can suppress messages.

Failure mode:

- If identity lookup fails, bot-authored messages may be processed and loop.
- If another user shares a nickname and lacks uid/client id, that user's message
  may be dropped.

Suggested action:

- Log when falling back to nickname-only.
- Add tests for missing identity cases.
- Live-verify self identity fields.

### A7. Webhook Security Assumes Local Gateway Auth And Static Secret Are Enough

Classification: Defensible with operational caveats

Refs:

- `index.js:1230`
- `index.js:3207`
- `index.js:3219`
- `hook-relay.js:57`
- `CONTRIBUTING.md:5`

Security relies on OpenClaw route auth plus a generated shared secret. The hook
relay presents that secret in a request header.

Failure mode:

- If the secret leaks through hook listings/process args, local users can forge
  inbound events.

Suggested action:

- Document the host trust assumption.
- Move secret passing out of command args if multi-user hosts are supported.

### A8. OpenClaw Gateway And Runtime Contracts Are Stable

Classification: Needs live verification

Refs:

- `index.js:345`
- `index.js:789`
- `index.js:1016`
- `index.js:2458`
- `README.md:53`

The plugin assumes these contracts:

- `sessions.patch`
- `voicewake.get`
- `talk.speak`
- `runtime.stt.transcribeAudioFile`

Failure mode:

- Session defaults silently fail.
- Wake-word mode rejects all speech if triggers cannot be fetched.
- TTS falls back to text.
- Voice transcription fails.

Suggested action:

- Document minimum OpenClaw API version.
- Add live gateway smoke checks for required methods.

### A9. TTS Replies Are WAV

Classification: Defensible but limiting

Refs:

- `index.js:1016`
- `index.js:1022`
- `index.js:631`
- `docs/configuration.md:115`

The plugin only supports TTS output as WAV with base64 audio.

Failure mode:

- Providers that default to MP3, Opus, or raw PCM cause voice reply failure and
  text fallback.

Suggested action:

- Document the WAV requirement in TTS configuration docs.
- Add diagnostics for unsupported returned formats.

### A10. Media Socket Protocol Is Fixed `tsmedia1`

Classification: Needs live verification

Refs:

- `index.js:615`
- `index.js:764`
- `index.js:2727`
- `tests/routing-voice-audio.test.js:266`
- `docs/event-surfaces.md:28`

The parser assumes newline-delimited tab fields, fixed field indices,
hex-encoded identity fields, and payload length in field 11 for `audio.chunk`.

Failure mode:

- Buffer desync.
- Dropped audio.
- Wrong speaker attribution.
- Unbounded buffer growth waiting for an incorrect payload length.

Suggested action:

- Check `fields[0]` for protocol version.
- Keep media bridge fixtures.
- Add parser tests for malformed and version-mismatched frames.

### A11. Temporary WAV Files Are Safe In Plugin State

Classification: Defensible with edge cases

Refs:

- `index.js:528`
- `index.js:2432`
- `index.js:2562`

Voice transcription writes temporary WAV files under plugin state and removes
them in `finally`.

Failure mode:

- STT fails if the state dir is unwritable or disk is full.
- Sensitive speech briefly exists on disk.
- If process exits before `finally`, a temp WAV can remain.

Suggested action:

- Document state-dir sensitivity.
- Ensure restrictive permissions if OpenClaw does not guarantee them.
- Consider cleanup of stale voice temp files on startup.

### A12. Dedupe TTL And Fingerprint Contents Are Sufficient

Classification: Fragile

Refs:

- `index.js:26`
- `index.js:1423`
- `index.js:1332`
- `tests/config-and-ingress.test.js:296`

The dedupe fingerprint is based on normalized event fields and a 60 second TTL.

Failure mode:

- Retries after 60 seconds become duplicate turns.
- Two identical messages at the same parsed timestamp can collapse.
- Missing or unparseable timestamps use `Date.now()`, which can reduce retry
  dedupe effectiveness.

Suggested action:

- Include upstream event id if available.
- Live-verify duplicate hook retry behavior.

### A13. Already-Running Daemon Is Compatible

Classification: Defensible, needs live verification

Refs:

- `index.js:1884`
- `index.js:2045`
- `index.js:3265`

If `ts daemon status --json` reports a running daemon, the plugin leaves it in
place.

Failure mode:

- An external daemon may be using a different profile, server, config path, or
  hook state than the plugin expects.

Suggested action:

- Add daemon profile/server/config diagnostics.
- Document that an external daemon must match plugin config.

## Test Gaps

The current unit tests cover many pure seams, but the review identified these
gaps:

- Two distinct TeamSpeak channel ids should not collide unless shared-channel
  routing is intentional and documented.
- Failed dispatch followed by retry should not be swallowed by dedupe.
- UID-only DM ingress should either be rejected, resolved, or tested as an
  expected outbound failure.
- `interruptMode` should be covered in validator and schema tests.
- Unknown config keys should be rejected if `additionalProperties: false`
  remains declared.
- Hook relay timeout and size caps should be tested after implementation.
- Media parser malformed frame, oversized header, oversized payload, and stale
  socket cases should be tested.
- Voice utterance duration and byte limits should be tested after implementation.
- Live fixtures should cover:
  - `ts events hook list --json`
  - `ts plugin info`
  - `ts config view`
  - `ts status`
  - `ts client list`
  - real `message.received` DM and channel hook payloads
  - representative media socket frames

## Suggested Remediation Order

1. Resolve the channel session model mismatch.
2. Fix dedupe so failed dispatches can retry.
3. Decide TeamSpeak authorization policy and stop unconditionally setting
   `CommandAuthorized: true` if inappropriate.
4. Add media socket parser and utterance resource caps.
5. Add subprocess and hook relay timeouts/caps.
6. Fix `interruptMode` schema and validator drift.
7. Clarify `wake_or_ptt` behavior.
8. Improve DM UID lookup behavior or document cache requirements.
9. Add live contract fixtures and smoke checks for `ts` and OpenClaw APIs.
10. Sanitize or split diagnostics.
11. Harden state directory and secret file permissions.
12. Fix docs path and additionalProperties validation mismatch.
