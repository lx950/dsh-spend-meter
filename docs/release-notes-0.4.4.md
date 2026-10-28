# v0.4.4 — accurate to 1e-8

First public release. A draggable panel inside DeepSeek Harness that answers one question
without switching tabs: **what is this costing me right now?**

```
会话花费                                  谷时  ▾
余额                    ¥9.6540
上轮                    ¥0.0759
今日                    ¥3.0671
本轮                    ¥0.0412
计费            谷时 → 09:00 转峰
```

## Why the numbers are different

Most usage meters multiply token counts by a rate card. That is an estimate: it misses
discounts, cache pricing quirks and anything billed outside the conversation.

This plugin reads the **lifetime spend counter** from the account summary
(`platform.deepseek.com/api/v0/users/get_user_summary`, 8 decimals) and takes differences:

- **Today** = counter now − counter at this day's first reading.
- **Last turn** = counter delta across the turn (all steps and tool calls included, not just
  the last message).
- **Live turn** = rate-card estimate while the turn is still running.

Because it diffs a monotonic counter, a top-up cannot distort the number, and a charge is
what the provider actually debited, to 1e-8 CNY. The counter settles about a minute after a
turn; until then the panel shows the rate-card estimate and says so in its tooltip.

Install the plugin at noon and `今日` is still right for the whole day: the part before the
plugin was watching is rebuilt from the host's own session transcripts
(`$DSH_HOME/sessions/**/session.v4.jsonl.zstd`, incremental multi-frame zstd reader) and
priced on the rate card. That backfill is shown as estimated, and the panel learns the
measured/estimated ratio (clamped to 0.8–1.8×) so the filled-in part converges to reality.

## Install

```bash
dsh plugin --profile <profile> add github:lx950/dsh-spend-meter
```

No npm package yet — GitHub is the distribution channel. The package is named
`dsh-spend-panel` internally (the plain `dsh-spend-meter` name was taken on npm), so that
is the id you will see in `node_modules` and in `dsh.profile.bundles`.

Restart the host. The panel appears over the conversation: drag it by the header, collapse
it with the corner button; position and collapsed state are remembered.

Desktop users: the `desktop` profile is owned by the Electron shell, so a terminal install
is refused by design — install from inside the app, or add the dependency plus a bundle row
to the profile's `package.json` and restart.

## What it does not do

- No telemetry, no network calls other than two DeepSeek endpoints.
- It cannot see spend that never reached a transcript **and** happened before the first
  counter reading on a fresh install — that window is empty, not guessed.
- Attribution of a charge to a specific turn can be off by one when two turns settle
  back-to-back; the day total is unaffected.
- Peak windows follow the published Beijing-time schedule; the holiday table needs a yearly
  update (currently 2026).

## Also in this release

- Panel uses the host's own design tokens (`--dsw-*`), light and dark themes, so it looks
  native rather than like a widget bolted on.
- Honest failure states: the panel names which path failed (`余额读不到：…`,
  `平台账单不可用：…`) and writes `diag.json` you can attach to an issue.
- 28 assertions + five integration suites, all runnable offline with stubs; `npm run
  test:live` / `test:live:platform` exercise the real credential store and billing counter
  on your machine without printing secrets.
- The conversation id is read from the slot props (`props.session.id` first), not only from
  the injected binding key, which this host leaves empty — "last turn" therefore follows
  the conversation on screen instead of the newest turn of any conversation.
- Session-scoped credentials fall back to `$DSH_HOME/.credentials.yaml` when the host's
  `credentials` service answers "nothing stored"; `diag.platform.credentialSource` says
  which path was used.
- Four latent bugs fixed while preparing this release: a transcript cache that could fold
  yesterday into today, a fast-poll timer that registered a disposer per turn, a platform
  read that could swallow errors, and a dispose handler that lost an in-flight turn.

**Full changelog:** [CHANGELOG.md](https://github.com/lx950/dsh-spend-meter/blob/main/CHANGELOG.md)
