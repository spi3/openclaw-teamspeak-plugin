# Architecture

## Main pieces

### `index.js`

The main OpenClaw plugin entrypoint.

Responsibilities:
- register the TeamSpeak channel plugin
- manage daemon supervision
- reconcile `ts daemon` hooks
- receive inbound TeamSpeak text via local webhook ingress
- map TeamSpeak peers/channels to OpenClaw sessions
- manage the TeamSpeak media socket for voice
- synthesize and play back voice replies
- expose diagnostics through `teamspeak.voice.status`

### `hook-relay.js`

A small relay process invoked by `ts daemon` hooks.

Responsibilities:
- read the TeamSpeak event payload
- authenticate to the plugin ingress with a shared secret
- forward the event body to the local OpenClaw ingress route

### `openclaw.plugin.json`

Declares:
- plugin id
- channel id
- user-facing config schema for `channels.teamspeak`

## Event model

There are two distinct inbound surfaces.

### 1. Daemon events (`ts daemon`)

Current use:
- `message.received` for `client`
- `message.received` for `channel`
- `client.moved` as an informational movement turn in the shared channel session

Daemon events arrive via:
1. TeamSpeak client plugin callback
2. `teamspeak-cli` daemon event polling
3. daemon hook execution
4. `hook-relay.js`
5. OpenClaw ingress route
6. session routing + agent turn dispatch

### 2. Voice/media events (media socket)

Current use:
- `hello`
- `status`
- `speaker.start`
- `audio.chunk`
- `speaker.stop`
- `playback.started`
- `playback.stopped`
- `playback.cleared`
- `error`

These are consumed directly from the TeamSpeak media socket and do not pass through the daemon hook path.

## Session routing

### Text

- TeamSpeak DMs map to an OpenClaw direct session keyed by TeamSpeak UID when available
- TeamSpeak channel chat maps to one shared OpenClaw channel session peer id, currently `all`
- the actual TeamSpeak channel id is still preserved for outbound targeting and route-cache diagnostics

The shared channel session is intentional. The bot acts as one TeamSpeak client,
and that client can be moved by users or move itself between server channels.
Splitting OpenClaw context by TeamSpeak channel id would make those channel
moves look like context loss to users talking to the same bot.

### Voice

- finalized voice utterances are normalized into a pseudo inbound event
- accepted voice utterances are routed into the same TeamSpeak session model used by text
- voice turns attach extra system guidance so replies are formatted for speech

## Voice pipeline

1. receive `speaker.start`
2. buffer PCM chunks from `audio.chunk`
3. finalize on silence timeout or `speaker.stop`
4. write temp WAV
5. transcribe through OpenClaw STT
6. evaluate wake-word / allow-list policy
7. dispatch agent turn
8. synthesize spoken reply with OpenClaw TTS
9. convert/stream PCM back through TeamSpeak playback frames

## Diagnostics

The plugin exposes a gateway method:
- `teamspeak.voice.status`
- `teamspeak.voice.debugStatus` for admin-only raw diagnostics

Useful fields include:
- connection state
- redacted media socket state / format
- sanitized playback metrics
- sanitized transcription metrics
- dropped ingress, playback, and utterance counters
