# Contributing

Thanks for taking a look. This is a small plugin with an unusually strict set of host
contracts, so the notes below are mostly about **not breaking them**.

## Setup

```bash
git clone https://github.com/lx950/dsh-spend-meter.git
cd dsh-spend-meter
node --version        # >= 20
npm test              # no dependencies to install: the suites use node:test + stubs
```

There is no build step. `lib/client.js` is shipped as-is in the host's
`__ModuleLoader__.load({ id, factory })` format, so it is plain JS + `React.createElement`
(no JSX, no bundler). Keep it that way unless you are prepared to add one.

To try a change inside a real host:

```bash
dsh plugin --profile <profile> add link:/absolute/path/to/dsh-spend-meter
# restart the host — client bundles are composed at launch, there is no HMR for them
```

## Layout

| file | responsibility |
| --- | --- |
| `lib/index.js` | service side: usage events, day books, platform/billing reads, routes, diagnostics |
| `lib/client.js` | the panel (React, injected into `conversation.input.dock`) |
| `lib/pricing.js` | rate card, Beijing day keys, peak/off-peak |
| `lib/ledger.js` | atomic local ledger in `$DSH_HOME/spend-meter/` |
| `lib/transcripts.js` | multi-frame zstd transcript reader + incremental frame cache |
| `lib/platform.js` | `platform.deepseek.com` summary client |
| `lib/credentials.js` | read-only fallback that parses `$DSH_HOME/.credentials.yaml` |
| `lib/attribution.js` | pure functions: day book advance, charge splitting |

## Contracts to preserve

1. **Never hard-require an optional host service.** `inject: ['credentials']` at plugin
   level means "the plugin does not load without it". Use
   `root.inject(['credentials'], ctx => …)` and fall back to the credential file.
2. **Never add a server the host does not have.** Everything must work when the
   `deepseekAccount` service, the platform grant, or the network is missing.
3. **A dash is acceptable, a wrong number is not.** Estimated and measured values must stay
   distinguishable (`source` / `actualSource` / `scope`), and a failure must carry a reason
   into `diag.json` rather than being swallowed.
4. **Day-scoped caches.** Anything cached from transcripts or counters is only valid for
   the Beijing day key it was built for.
5. **No telemetry, no tokens in logs.** The plugin reads two DeepSeek endpoints and writes
   only to `$DSH_HOME/spend-meter/`.

## Tests

```bash
npm test                  # 28 assertions + apply-smoke + platform-e2e + today-e2e
                          # + session-id + credentials-e2e
npm run test:live         # real credential store, real /user/balance (prints no key)
npm run test:live:platform# real billing counter, 8 decimals
npm run test:preview      # prints the exact numbers the panel would render
```

The live scripts read your own machine's credentials — they are never part of `npm test`
and never run in CI.

When you fix a bug, add the assertion that fails without the fix. Two traps that have
already cost time:

- A fake cordis `effect` must actually invoke the callback (`effect: () => () => {}`
  silently drops route registration and shows up as "state route missing").
- Fetch stubs need `ok: true`, otherwise the API-key path treats the response as a failure.

## Pull requests

- One behaviour per PR, with the test that proves it.
- Update `CHANGELOG.md` under `## [Unreleased]`.
- If you touch the panel, mention both themes (light and `body[data-ds-dark-theme]`) in the
  description — screenshots help.
- Keep the English README and the `## 中文` section in sync when user-facing behaviour
  changes.
