# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.4.5] — 2026-10-29

### Fixed

- **"Today" now measures from the earliest money reading of the day.** The panel used
  to prefer the charge counter; if the wallet balance had been read earlier that day
  the counter's later start silently turned more of the day into a rate-card estimate.
  The earliest book wins now, so the estimated window is as small as the data allows.
- **The transcript reconciliation no longer drops the `after` half of the day.** The
  ledger rebuilt each day from scratch and only carried `before` over, so `after` was
  always 0, which silently disabled the calibration that compares the rate card with
  the real invoice. Both halves survive now and the calibration actually learns.

## [0.4.4] — 2026-10-29

### Fixed

- **The first poll no longer throws the diagnostics probe away.** It can race the
  plugin's route mount and fail; the probe is now only cleared after a poll that
  actually succeeds, and it keeps being attached while the conversation id is still
  unknown. Without this, a host that hands the dock child no id also left `diag.probe`
  empty, which is precisely the case the probe exists for.

### Changed

- **CI tests Node 22 only.** The transcript backfill decodes multi-frame zstd through
  `node:zlib`, which landed in Node 22; the matrix used to include Node 20 and fail
  there. Older runtimes now degrade gracefully instead of throwing: the backfill
  reports `transcript backfill needs Node 22+` in `diag.transcript.error` and the panel
  keeps working from the balance book alone.
- **Packaged as `dsh-spend-panel`, distributed from GitHub.** The plain `dsh-spend-meter`
  name is already taken on npm by an unrelated package, so the package id is
  `dsh-spend-panel`; install with `dsh plugin --profile <name> add
  github:lx950/dsh-spend-meter` until an npm release exists.

## [0.4.3] — 2026-10-29


### Fixed

- **The panel now reads the conversation id from its slot props.** On this host a
  `conversation.input.dock` child can be injected with no binding key at all, so the
  meter was polling with an empty session id and the "last turn" row fell back to the
  newest committed turn of any conversation. The client resolves the id in this order:
  `props.sessionId` → `props.session.id` → `props.session.sessionId` → the injected
  value, and an empty injected value is no longer forwarded (it used to overwrite a
  defined `sessionId` with `undefined`).

### Added

- **First-poll probe in `diag.json`.** The panel reports which source produced its
  session id plus the keys of its props, so a future report of "wrong conversation"
  can be diagnosed from the diagnostics file instead of guessed at.
- `/api/dsh-spend/health` now carries `lastSession` and `probe`.

## [0.4.2] — 2026-10-29

### Fixed

- **Credentials are read straight from `$DSH_HOME/.credentials.yaml` when the host's
  `credentials` service is scoped away.** On a desktop install the injected service can
  load without the plugin's entry in it, which used to leave the panel with no key and no
  platform grant. The plugin now tries the service first (recording `credentialSource:
  "service"`), then falls back to the credential file (`credentialSource: "file"`).
- **The panel now tells the server which conversation it belongs to.** The injected
  session value could arrive as an object or an empty string; it is now normalised in the
  client (`id` → `sessionId` → `session`) before polling.
- **Last turn no longer shows a dash for a conversation with no id yet.** Focus resolves
  to the session that emitted the newest event (`scope: "active"`), then to the newest
  committed turn (`scope: "recent"`), and the tooltip names which one is on screen.
- **Session dispose lost the in-flight turn.** `session/disposed` looked the turn up by the
  host's raw id while the books are keyed by the normalised id, so a session closed
  mid-turn never committed its last turn.
- **Transcript cache could fold yesterday into today.** Cache entries are day-scoped now;
  reusing a warm cache across midnight mixed the previous day's usage into the new one.
- **Fast-poll timer registered a disposer per turn.** One disposer per plugin, and the
  timer stops itself when the burst window ends.
- **Platform read failures are recorded.** An exception inside the platform read used to be
  swallowed and left the previous "ok" state on screen; it now sets `platform.error`.

### Added

- `diag.platform`, `health.platform.credentialSource` and `health.balanceValue` for
  self-diagnosis without leaving the panel.
- New regression tests: warm-cache cross-day isolation, credential-file fallback
  (`test/credentials-e2e.mjs`, no credentials service at all, real YAML shape),
  session-focus resolution (`test/session-id.mjs`).

## [0.4.1] — 2026-10-29

### Added

- `resolveFocus()` with tolerance for the two spellings of a session id
  (`<uuid>` and `session-<uuid>`) and a `recent` fallback so the panel never sits on a dash.
- `diag.lastSession` (`{ raw, key, scope, known }`) records what the client actually sent.
- `ledger.sessionIds()`, `health.balanceValue`.

## [0.4.0] — 2026-10-29

### Added

- **Billing counter accounting.** Every number now comes from the lifetime spend counter
  (`total_costs`, 8 decimals) on `platform.deepseek.com/api/v0/users/get_user_summary`,
  authenticated with the account grant: today = counter now − counter at this day's first
  reading; last turn = counter delta across the turn. A charge therefore equals what was
  actually debited, and a top-up cannot distort it.
- `lib/platform.js` (summary client), `lib/attribution.js` (day book, charge splitting),
  and a fast poll (2 s for 30 s, then 6 s) after each turn until the charge settles.
- The panel distinguishes *measured* (`counter`) from *estimated* (`balance` / counter not
  settled yet) numbers, and explains which one it is showing.

### Changed

- Transcript backfill is anchored on whichever book is live (`costDay` first), so the
  pre-install part of the day is filled in instead of silently dropped.

## [0.3.0] — 2026-10-29

### Added

- **Transcript backfill.** `$DSH_HOME/sessions/**/session.v4.jsonl.zstd` is parsed
  incrementally (multi-frame zstd, frame-aligned, append-only) to recover usage from
  before the plugin was watching and to restore the last turn after a restart.
- **Balance book** (opening − last + credits) as the measured counterpart, plus
  self-calibration: the ratio between the real counter and the rate-card estimate is
  learned (clamped to 0.8–1.8×) and applied to backfill only.
- `lib/transcripts.js`, `beijingDayStartMs()`, `ledger.reconcileDay()` (monotonic — it never
  lowers a recorded day), `ledger.getBalanceDay()/setBalanceDay()`.

### Fixed

- One session could appear twice when the host and the transcripts disagreed about the
  `session-` prefix (`sessionKey()` normalises both spellings).

## [0.2.1] — 2026-10-29

### Fixed

- **Services are discovered through `inject`.** `ctx.get(name)` reads the root isolation
  table and requires the provider to be `ACTIVE`, so during the startup race it returned
  `undefined` and the panel claimed the host had no credentials service. The plugin now
  injects `credentials` / `deepseekAccount` (never hard-requiring them) and retries the
  read for up to 10 s, which removes the empty first minute after launch.

### Added

- `test/live-balance.mjs` (`npm run test:live`) — reads the local credential store and
  exercises the real balance path without printing the key.

## [0.2.0] — 2026-10-29

### Added

- **Draggable panel** instead of a one-line bar: portal-rendered, 268 px, drag by the
  header, collapse to a pill, position and collapsed state persisted in `localStorage`.
- The panel uses the app's own design tokens (`--dsw-*`, with light and dark fallbacks),
  so it matches the host UI instead of approximating it.
- Failures are visible: the panel names the path that failed (`余额读不到：…`,
  `连不上记账服务：…`) and writes a `diag.json` snapshot for reporting.
- Routes moved to the host's Fetch channel (`connection.fetch.register`, POST
  `api/dsh-spend/state`), with the raw HTTP routes kept only as a curl debugging fallback.

### Fixed

- **Last turn is committed when the turn number changes**, not only on `turn/end`, which
  some hosts never emit for a session — that is why `上轮` used to sit on a dash forever.
- Balance reads are time-bounded and no longer leave a stale in-flight request behind.

## [0.1.0] — 2026-10-29

### Added

- First working version: a status line above the composer showing balance, the cost of the
  last turn and today's spend, computed from DSH usage events and the DeepSeek rate card
  (peak/off-peak, cache hit/miss), with a local ledger in `$DSH_HOME/spend-meter/`.

[Unreleased]: https://github.com/lx950/dsh-spend-meter/compare/v0.4.5...HEAD
[0.4.5]: https://github.com/lx950/dsh-spend-meter/compare/v0.4.4...v0.4.5
[0.4.4]: https://github.com/lx950/dsh-spend-meter/compare/v0.4.3...v0.4.4
[0.4.3]: https://github.com/lx950/dsh-spend-meter/compare/v0.4.2...v0.4.3
[0.4.2]: https://github.com/lx950/dsh-spend-meter/compare/v0.4.1...v0.4.2
[0.4.1]: https://github.com/lx950/dsh-spend-meter/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/lx950/dsh-spend-meter/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/lx950/dsh-spend-meter/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/lx950/dsh-spend-meter/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/lx950/dsh-spend-meter/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/lx950/dsh-spend-meter/releases/tag/v0.1.0
