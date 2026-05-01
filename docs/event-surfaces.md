# Event Surfaces

This plugin deals with two different TeamSpeak event surfaces.

## CLI / daemon events

Provided by `teamspeak-cli` through `ts events watch` and daemon hooks.

Currently used by this plugin:
- `message.received` (`client`)
- `message.received` (`channel`)

Observed / confirmed in `teamspeak-cli` source for the real plugin backend:
- `connection.requested`
- `connection.connecting`
- `connection.connected`
- `connection.disconnected`
- `connection.error`
- `connection.status`
- `message.received`
- `client.talking`
- `client.moved`
- `server.error`
- `media.playback.error`

Important: not all event types are documented cleanly upstream yet. Treat the source-backed list above as implementation evidence, not a polished public contract.

Because the runtime depends on exact `teamspeak-cli` JSON field names and hook command round trips, run `npm run smoke:contracts` after CLI/plugin upgrades. The script checks the local JSON surfaces documented in `docs/live-contracts.md`.

## Media socket events

Provided by the dedicated TeamSpeak media bridge, not `ts daemon`.

Used by this plugin:
- `hello`
- `status`
- `speaker.start`
- `audio.chunk`
- `speaker.stop`
- `playback.started`
- `playback.stopped`
- `playback.cleared`
- `error`

## Why the distinction matters

- daemon hooks are good for discrete TeamSpeak domain events and text ingress
- media socket events are required for low-level live voice capture and playback
- the OpenClaw TeamSpeak plugin currently uses both surfaces because one does not replace the other

## Current policy

For now, OpenClaw only reconciles daemon hooks for TeamSpeak text messages.

Broader hook-based event handling should wait until `teamspeak-cli` event documentation is clearer and stable enough to build against confidently.

The media socket protocol is treated as `tsmedia1` frame-v1. Keep live media
fixtures or smoke output with upgrade notes when the TeamSpeak client plugin is
changed, because unit tests cannot prove the installed socket protocol.
