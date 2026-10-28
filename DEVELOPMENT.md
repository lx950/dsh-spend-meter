# Development notes

## Layout

```
lib/index.js       host half — usage events + Platform counter → pricing → ledger → routes
lib/ledger.js      per-day + per-session ledger with debounced atomic writes
lib/pricing.js     the rate card, peak/off-peak schedule, holiday table
lib/transcripts.js incremental multi-frame zstd reader for the host session transcripts
lib/platform.js    read-only client for the Platform billing summary (counter + wallet)
lib/attribution.js pure cost-day bookkeeping: counter deltas and charge splitting
lib/credentials.js read-only fallback reader for `$DSH_HOME/.credentials.yaml`
lib/client.js      browser half — registers `conversation.input.dock`, polls the routes
test/              self-check (pure functions + bundle smoke), apply-smoke, platform-e2e, live checks
```

Nothing is bundled or transpiled: `lib/client.js` is hand-written in the host's `__ModuleLoader__.load({ id, factory })` format, which the host serves verbatim at `/plugins/…`. Edit a file, restart DSH, done.

## Install a local checkout

### Web / CLI profiles

From GitHub (how end users install it):

```bash
dsh plugin --profile <name> add github:lx950/dsh-spend-meter
```

From a local checkout (development, edits are picked up without reinstalling):

```bash
dsh plugin --profile <name> add link:/absolute/path/to/dsh-spend-meter
```

### The `desktop` profile (Electron app)

The shell owns this profile — `dsh plugin --profile desktop add …` is refused with
`profile "desktop" is managed exclusively by the Electron application`. Use one of:

1. **In-app plugin manager** — it accepts a `link:` spec (it writes `link:<dir>` itself).
2. **By hand**, then restart:
   - add to the profile's `package.json` `dependencies`:
     `"dsh-spend-panel": "github:lx950/dsh-spend-meter"` (or `link:` for a local checkout)
   - append `"dsh-spend-panel"` to `dsh.profile.bundles`
   - install with the app's own pnpm:
     ```bash
     node "C:/Users/<you>/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/pnpm/bin/pnpm.cjs" \
       install --dir "C:/Users/<you>/.dsh/profiles/desktop"
     ```

The profile has no HMR for bundle rows: the layer stack is assembled at startup, so a restart is required.

## Contracts this plugin relies on

- `ctx.on('session/event', (session, event) => …)` with
  `assistant/message` → `data.usage = { inputTokens, cacheReadTokens, outputTokens }`,
  `data.turn`, `data.message.source.model`. `turn/end` settles a turn early *when the host
  emits it* — DSH 0.2.1 does not always, so the plugin also settles on a turn-number change
  (a new turn starting is what makes the previous one "last turn").
- `ctx.get('connection').fetch.register({ path, methods: ['POST'], requestBody: 'buffered', fetch })`
  — the Fetch route channel used by first-party pages (`fetch('api/<name>/<op>')` from the
  browser, handler returns a real `Response`). Registered inside `ctx.effect(...)` so it
  unmounts with the plugin.
- `ctx.webServer.register({ kind: 'exact', path, handler })` — raw `node:http`, kept as a
  read-only GET fallback for curl and for hosts without the Fetch channel.
- `ctx.slots.register({ name, id, order, inject }, Component)` for `conversation.input.dock`,
  used only as a mount point; the panel itself is `position: fixed` so it can float.
- `ctx.get('deepseekAccount').getBalance({ version, locale, timezoneOffsetSeconds })` and
  `ctx.credentials.resolve('DEEPSEEK_API_KEY')` for the two balance paths.

  One wrinkle, measured on DSH 0.2.1-rc.2 desktop: `ctx.get(name)` resolves through the
  **root isolation map** (`ReflectService._getImpl` → `root[Context.isolate][name]`), and a
  host that scopes services per plugin can leave that map empty — `ctx.get('credentials')`
  then reads back `undefined` even though the host's own settings page uses the service.
  The reliable route is `inject`: `root.inject(['credentials'], (ctx) => ctx.credentials)`
  resolves through the fiber chain. `lib/index.js` therefore *discovers* both optional
  services with `inject` — a callback that never fires is harmless when a host does not
  provide the service — and keeps `ctx.get` as the fallback, not the primary.

  A second wrinkle, measured on the same build: the injected `credentials` service can be
  reachable *and* report nothing (`resolve` → `undefined`, `readRecord` → `undefined`) even
  though the account is signed in — the host scopes the record's owner per plugin. The file
  at `$DSH_HOME/.credentials.yaml` still holds the grant, so `lib/credentials.js` reads it
  (read-only, never logged) whenever the service path comes up empty; the resolution order is
  service → file, and `platform.credentialSource` records which one answered. Tests always
  point `credentialsFile` at a temp path so they never read a developer's real store.
- **The billing counter.** `GET https://platform.deepseek.com/api/v0/users/get_user_summary`
  with the header `x-dsh-auth-token: <grant token>` (`Authorization: Bearer` is rejected with
  `code 40003`) returns `data.biz_data.normal_wallets[].balance` (8 decimals) and
  `data.biz_data.total_costs[].amount` — a **lifetime, monotonically increasing charge counter**.
  The grant token lives in `$DSH_HOME/.credentials.yaml` under
  `records["deepseek-account-platform/default"]` (`.payload.token` / `.payload.issuer`), which is
  exactly the record `ctx.credentials.readRecord("deepseek-account-platform/default")` returns.
  The host's own account service only parses the wallets and throws `total_costs` away, so the
  plugin reads the summary itself. Every money number in the UI is a difference of that counter:
  last turn = counter after − counter before; today = counter now − counter at the day's first
  reading. Deltas are clamped at `≥ 0`, so refunds and counter resets never read as negative spend.
  Settlement lags ~1 minute, hence the burst-then-backoff poll (2 s for 20 s, then 6 s up to 2 min)
  after each turn, and `pendingTurns` / `unattributed` in `diag.json` for money that arrived with
  no turn waiting.
- Design tokens `--dsw-*` come from the host theme (`dsh-orb`'s `theme.css`), with light
  values as fallbacks and `body[data-ds-dark-theme]` overrides.
- The **session transcripts** at `$DSH_HOME/sessions/<workspace>/<session>/session.v4.jsonl.zstd`:
  one record per line, `{ type, seq, time, data }`, and `type === 'assistant/message'` carries
  `data.usage = { inputTokens, cacheReadTokens, cacheWriteTokens, outputTokens, totalTokens }`
  and `data.message.source.model`. `inputTokens` is the *uncached* part only; reasoning tokens
  are inside `outputTokens`. This is the authoritative, append-only record of the day, and the
  only way to price usage from before the plugin was loaded or from before a restart.

  These files are **multi-frame zstd streams**. `zlib.zstdDecompressSync` decodes exactly one
  frame and returns successfully — on a 2 MB transcript that silently yields a single record.
  Split on the frame magic (`0xfd2fb528`, little endian) and decode frame by frame. Files are
  append-only, so a warm pass only decodes frames past the cached frame count (and re-attaches
  the partial line left over at the previous frame boundary).

If a future DSH release renames any of these, `lib/index.js` and `lib/client.js` are the only two files to touch.

## Diagnostics

The host half writes `$DSH_HOME/spend-meter/diag.json` on every balance refresh and on route
mount: which channel registered, whether `credentials` / `deepseekAccount` were reachable, and
what each balance path returned. `polls` climbing means the page is getting through; a stale
`polls` means the client is on the wrong channel. Both are also exposed at `/api/dsh-spend/health`.

Note that `curl` against the raw HTTP routes always answers `401 {"ok":false,"error":"forbidden"}`:
the host fences `api/*` behind the browser-session cookie, which only the page carries. A 401 from
a terminal proves the route exists, not that the plugin is broken.

`transcript` in `diag.json` records the last reconciliation pass: `day`, `files` touched, the
day's estimate, `before` (usage that predates the first balance reading — priced, not measured),
`after` (the part the balance also covers) and `factor` — the learned invoice ÷ chart ratio,
computed from `spent ÷ after` once both reach a usable size. If `today.actual` is missing from
`/api/dsh-spend/health`, the balance delta has not started yet and the panel is showing the
estimate alone.

`platform`, `costDay`, `pendingTurns` and `unattributed` answer the money questions: `platform.ok`
says whether the summary call works at all (with `balance` / `totalCosts` as read),
`platform.credentialSource` says whether the grant came from the host service or straight from the
credentials file, `costDay` is the counter book (`opening` → `last`), `pendingTurns` are turns whose
charge has not landed yet, and `unattributed` is money that arrived while no turn was waiting
(subagents, background calls).

`lastSession` records the session id the panel last asked about: `raw` is exactly what arrived over
the wire, `key` is its normalised form, `scope` is `session` when it matched a known session,
`active` when the active conversation answered instead, `recent` when the answer came from the
newest-turn fallback, and `known` counts the sessions the plugin currently knows. A slot's `inject` is not guaranteed to hand over an id, and the host writes
both `session-<uuid>` and `<uuid>`, so `scope: "recent"` with a sensible `raw` means the panel is
working as designed — a `raw` of `""` or `"[object Object]"` is the thing to fix.

## Tests

```bash
npm test                        # self-check + apply-smoke + platform-e2e + today-e2e + session-id + credentials-e2e
npm run test:live               # optional: real balance API with this machine's key
node test/live-platform.mjs     # optional: real Platform summary (8 decimals + lifetime counter)
npm run test:preview            # optional: what the panel would show on this machine right now
```

`self-check` covers the price card, peak/off-peak boundaries, Beijing day rollover, ledger
persistence, multi-frame zstd decoding, per-day transcript aggregation, balance-delta accounting
(including top-ups), monotonic reconciliation, and materializes the browser bundle in a `vm`
sandbox to prove the slot registration and first render work.

`apply-smoke` boots `apply()` against a fake Cordis context, feeds it a real event
sequence, walks all three routes, and reconciles against a transcript written into a temporary
`$DSH_HOME` layout — including a `turn/end` with no payload and the debounced ledger write.

`platform-e2e` stubs `fetch` with a synthetic Platform summary and drives a full turn: a turn
starts, the counter moves by $0.05, the next turn begins, and the previous turn must be persisted
with `actual = 0.05` while keeping its rate-card `estimate`. It proves the whole chain — credentials
→ summary → cost day → attribution → ledger — without spending money.

`test:live` is the manual one: it reads `DEEPSEEK_API_KEY` from `$DSH_HOME/.credentials.yaml`,
runs the plugin's own balance code against `api.deepseek.com`, and prints what the panel would
show. It skips itself when no key is stored and never prints the key.

`session-id` pins how a panel request is matched to a session: `session-<uuid>` and `<uuid>` both
resolve to the same session, an id the plugin cannot know falls back to the newest turn with
`scope: "recent"` (never a permanent dash), and a newer session cannot hijack an exact match.
It also asserts `diag.lastSession` carries the raw id.

The first poll of every mount also sends a `probe`: the source that produced the id
(`props.sessionId`, `props.session.id`, `props.session.sessionId`, `inject`) and the key
names the slot props / session snapshot actually carried. `diag.probe` keeps it. This is
the cheap way to learn what a host version hands a dock child — on this one the injected
binding key was empty, and only `props.session.id` had the answer.

`credentials-e2e` boots the plugin **without** a `credentials` service — the shape the desktop app
actually hands it — and checks the file fallback both ways: a grant in `$DSH_HOME/.credentials.yaml`
must reach the Platform summary (`credentialSource: "file"`, 8-decimal balance, lifetime counter)
without ever calling the cents-only balance endpoint; a file with only an API key must never send a
Platform request and must land on `balanceSource: "api-key"`. Each case re-imports the module with a
distinct query string so the two plugin instances cannot share module state.
