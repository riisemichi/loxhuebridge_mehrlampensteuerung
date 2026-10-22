# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

loxHueBridge Mehrlampensteuerung: a fork of loxHueBridge that bridges a Loxone Miniserver (HTTP virtual outputs in, UDP virtual inputs out) with a Philips Hue Bridge V2 API (REST + SSE EventStream) and, optionally, MQTT. The fork adds per-lamp multi-sync (groups A–E with manual clusters), an effect fallback for Hue rooms, zones and groups, and robust SSE parsing. Code comments, log messages, UI text, README and CHANGELOG are in **German**. Keep it that way.

## Commands

Requires **Node.js 24+** because `lib/logger.js` uses the built-in `node:sqlite` module. There is no build step and no linter.

```bash
npm ci
npm start                                   # node server.js, HTTP on $HTTP_PORT (default 8555)
npm test                                    # node --test --experimental-test-coverage test/*.test.js
node --test test/hue.test.js                # single test file
node --test --test-name-pattern="Multi-Sync" test/hue.test.js   # single test by name
node --check lib/hue.js                     # syntax check, as the README does
docker compose up -d --build                # local container (host networking, ./data mounted as DATA_DIR)
```

CI (`.github/workflows/test.yml`) runs `npm test` and `npm audit --omit=dev --audit-level=moderate` on Ubuntu **and Windows**. Tests must stay platform-neutral: no Unix-only signals (the shutdown test sends SIGTERM over IPC) and no reliance on fsync of directories. Pushing a tag triggers `docker-publish.yml`. Tags that contain `-` (e.g. `2.5.12-dev`) never get the `latest` image.

The root-level `test_*.js`, `scratch.js` and `tools/manual/` scripts are old scratch and manual diagnostics, not part of `npm test`. `tools/manual/*` must only run when given an explicit target address.

## Architecture

`server.js` wires everything together: it loads config, initializes the logger, runs the `auth.requireAuth` middleware, redirects to `setup.html` until the setup is done (`configManager.isConfigured` needs bridgeIp, appKey and loxoneIp), serves `public/` statically, mounts `lib/routes.js`, starts the Hue EventStream, and coordinates graceful shutdown. Anything that wants to shut down the process (the restart and restore APIs) emits `shutdown` on `lib/lifecycle.js` (an EventEmitter) and does not call `process.exit` directly.

The modules in `lib/` are **singletons exported via `require`** (configManager, hueManager, mqttManager, loxoneManager, logger), and they share state through those modules:

- `config.js`: holds `config` and `mapping` in memory, persisted to `$DATA_DIR/config.json` and `mapping.json` (default `./data`). `createDefaultMultiLightControl` normalizes and migrates the multi-sync settings, including legacy flat settings mapped onto group A. It also holds runtime-only state: `statusCache` (the actual lamp state shown on the dashboard) and `detectedItems` (unknown Loxone commands, used for click-to-map).
- `persistence.js`: `writeAtomic` (temp file, fsync, rename). A restore writes config and mapping together using the `.restore-pending.json` journal. `recoverRestore()` rolls back an interrupted restore on the next load or save. Invalid data must throw. Never silently replace it with defaults.
- `hue.js` (~1900 lines): the core of the bridge. Main parts:
  - **Command entry**: `executeCommand` parses Loxone values (0/1–100 brightness, `20BBBKKKK` color temperature, RGB as `R + G*1000 + B*1000000` with each component 0–100; invalid values are rejected with HTTP 400). Also `executeEffect`, `executeTimedEffect` and `executeAlert`, plus variants for multi-sync groups and for "all".
  - **Two send paths**: normal lamps go through `updateLightWithQueue` (per-target queue and throttle). Lamps with multi-sync enabled go through `scheduleMultiSyncedLightCommand`, which buffers commands for each group during a collection window, merges payloads (the last requested on/off wins), then sends them in batches and clusters with per-lamp `sync_offset_ms`.
  - **Global Hue PUT scheduler**: every real PUT (queue, multi-sync, effects, retries) goes through `scheduleHuePutTask` / `waitForHuePutSlot`, which enforces `bridgeMaxCommandsPerSecond` and backs off on 429. Command generations and versions (`bumpLampCommandGeneration`, `bumpMultiSyncCommandVersion`) drop stale queued commands, retries and effect timers per target before they are sent.
  - **Reliability**: optional per-lamp radio measures (state verification read-back, split on-command, repeat command), and per-lamp diagnostics (`getLampDiagnostics`). An HTTP 200 with a non-empty Hue `errors[]` counts as a failure.
  - **Effect fallback**: effects sent to rooms, zones or grouped lights resolve to the individual lights they contain (`resolveEffectTargets`), are filtered by capability, and use the multi-sync timing of their group.
  - **EventStream**: SSE stream with a UTF-8 `StringDecoder` buffer (`appendEventStreamChunk` / `extractSseData`). A configurable silence watchdog restarts the stream, and generation counters make sure late connections get closed. `processHueEvents` updates `statusCache` and forwards events to Loxone UDP (`loxone.js`) and MQTT (`mqtt.js`).
  - **Important invariant**: dashboard, UDP and MQTT only report **actual** state (from Hue GET or SSE), never the requested payload.
- `public/multisync.js`: a UMD module **shared by the backend (`require('../public/multisync')` in hue.js) and the browser**, so the timing preview in the UI uses exactly the same schedule computation as the real sender. Changes to it affect both.
- `routes.js`: the `/api/*` dashboard and setup endpoints, plus the Loxone control routes `/:name/:value` and `/:name/sunrise/:seconds`. These are matched last. `:name` can be a mapped `loxone_name`, a multi-sync group (`gruppe_a`, `group_b`, or a custom group name) or `all`/`alles`.
- `auth.js`: optional password protection (async hash check, concurrency limit, credential cache, login rate limiting) for the dashboard and `/api/*`. Two-segment Loxone control paths are **deliberately exempt** from auth, so that existing Loxone virtual outputs keep working.
- `logger.js`: logs to SQLite at `$DATA_DIR/logs.db` (WAL, rotation), or to RAM only when `disableLogDisk` ("SD-Card Mode") is set or SQLite fails to open.

## Testing conventions

Tests use `node:test` and `node:assert`. They replace dependencies by patching `Module._load` before requiring `lib/*` (for example, `test/hue.test.js` swaps `axios` for queued mock responses). They point `DATA_DIR` at temporary directories. HTTP, auth, SSE and shutdown integration tests start the real server in a child process against a local Hue simulator via `test/helpers/bridge-transport.cjs`, which only allows the `hue.test` host. `hue.js` exports `...ForTests` helpers (such as `resetHueSchedulerForTests` and `setReliabilityTimingsForTests`) to reset singleton state between tests.

## Branches and releases

`main` is stable (version without a suffix). `develop` carries `X.Y.Z-dev`. Bump `package.json` (the version shown in the UI comes from it) and add a German entry at the top of `CHANGELOG.md`. The README mentions the current version and branch table in several places, so update those too.
