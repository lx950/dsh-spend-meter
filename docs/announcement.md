# Announcement copy

Copy-paste ready. Replace `YOURNAME` before posting. Numbers in these drafts are real
measurements from the development machine — swap in yours if they differ.

Posting order that tends to work: **Show HN → Reddit (same day) → X thread → Chinese
communities next morning**. Answer comments for the first 24 hours; that is what converts
an upvote into a star.

---

## Show HN

**Title** (HN title field, ≤80 chars, no marketing adjectives):

```
Show HN: A DSH panel that shows what each LLM turn actually cost
```

**URL:** `https://github.com/YOURNAME/dsh-spend-meter`

**Body** (first comment):

> I kept opening the DeepSeek billing page to figure out what a session was costing, and the
> number there is rounded to 2 decimals while a single turn is often ¥0.03. So I poked at
> the account API and found the summary endpoint returns the wallet with 8 decimals and a
> lifetime `total_costs` counter.
>
> The plugin diffs that counter instead of estimating from tokens:
>
> - today = counter now − counter at the day's first reading
> - last turn = counter delta across the turn (all steps and tool calls, not just the final
>   message)
> - live turn = rate-card estimate while it is still running
>
> Two things were more work than expected.
>
> 1. The counter settles about a minute after a turn. So `上轮` would sit empty for a while —
>    the panel shows the rate-card estimate and labels it, then swaps to the measured number.
> 2. A fresh install has no counter history for the day, so `今日` would start at zero at
>    noon. I ended up parsing the host's own session transcripts (multi-frame zstd, appended
>    per step) to rebuild the part of the day before the plugin was watching, priced on the
>    rate card, and learning the measured/estimated ratio so the backfill converges.
>
> Auth detail in case anyone else is poking at it: the platform endpoint wants
> `x-dsh-auth-token`, not `Authorization: Bearer` — the Bearer variant returns HTTP 200 with
> `{"code":40003,"msg":"Authorization Failed (invalid token)"}`, which is a fun way to lose
> an hour.
>
> It is a DSH plugin, MIT, no telemetry, two network calls to DeepSeek only. Repo has the
> transcript reader, the counter bookkeeping and the panel as separate modules if you want
> to steal a piece.

---

## Reddit — r/LocalLLaMA

**Title:** `I built a DSH plugin that shows the real cost of each turn (billing-counter diff, not a token estimate)`

**Body:**

> Short version: most "cost meters" multiply tokens by a rate card. This one reads the
> account's lifetime spend counter (8 decimals) and subtracts, so the number is what was
> actually debited — a top-up or a discount cannot skew it.
>
> What the panel shows: balance, last turn, today, live turn while streaming, and whether
> you are in the peak window (the bill doubles 09:00–12:00 / 14:00–18:00 Beijing time).
>
> The interesting problem was the gap between "plugin installed" and "day started". The
> counter only exists from the first read, so I parse the host's session transcripts to
> rebuild the earlier part of the day and price it on the rate card, then learn the ratio
> between measured and estimated so the backfill converges instead of staying optimistic.
>
> MIT, no telemetry. Repo: https://github.com/YOURNAME/dsh-spend-meter
>
> Happy to answer questions about the transcript format or the accounting model — both are
> documented in DEVELOPMENT.md.

---

## Reddit — r/DeepSeek

Same body, shorter:

> Made a small panel for DeepSeek Harness that shows balance, last-turn charge and today's
> spend, measured from the billing counter rather than estimated from tokens. It also shows
> the peak/off-peak countdown, because the same tokens cost 2× inside the peak window.
> MIT, no telemetry: https://github.com/YOURNAME/dsh-spend-meter

---

## X thread

**1/**

```
LLM dashboards tell you tokens. They do not tell you money.

So I built a panel that diffs the billing counter: today = counter now − counter at the
day's first read. 8 decimals, immune to top-ups, includes every tool call.

MIT, DSH plugin 👇
```

Attach: `docs/social-preview.png` (1280×640, also the repo social preview). A 2×2 crop of
the panel alone works even better as tweet 1 if you want the numbers to be readable on
mobile.

**2/**

```
One surprising detail: the counter settles ~1 minute after a turn.

So "last turn" sits empty for a bit. The panel shows the rate-card estimate, labelled as
such, then swaps to the measured number once the counter moves.

Honest > instant.
```

**3/**

```
Second detail: install the plugin at noon and "today" would start at zero.

Fix: rebuild the morning from the host's own session transcripts (multi-frame zstd, appended
per step), price it on the rate card, and learn the measured/estimated ratio so the backfill
converges.
```

**4/**

```
Also: peak pricing. 09:00–12:00 and 14:00–18:00 Beijing time cost 2×.

The panel shows which tier you are in and when it flips, which changed when I run long jobs.

Repo, MIT, no telemetry: https://github.com/YOURNAME/dsh-spend-meter
```

---

## V2EX（Node 或 程序员 节点）

**标题：** `[分享] 做了个 DSH 插件：实时显示余额、上一轮花了多少、今天花了多少`

**正文：**

> DSH（DeepSeek Harness）里看不到单轮成本，余额页又只保留两位小数，而一轮常常就几分钱。
> 所以写了个可拖动的小面板，数据不靠"token × 价目表"猜，而是读平台的**累计消费计数器**
> （`platform.deepseek.com/api/v0/users/get_user_summary`，8 位小数）做差分：
>
> - 今日 = 当前计数器 − 当天第一次读到的计数器
> - 上轮 = 一轮前后计数器之差（所有 step 和工具调用都算在内）
> - 本轮 = 轮次进行中的价目表估算
> - 计费 = 峰/谷档位 + 下一次切换时刻（北京时间 09–12、14–18 双倍价，周末与法定节假日全天谷价）
>
> 两个坑值得记一下：①计数器大约延迟 1 分钟结算，所以"上轮"会先显示估算并标注，结算后自动换成实测；
> ②插件中午才装，"今日"就会从零开始——于是解析宿主自己的会话 transcript（多帧 zstd、逐 step 追加）
> 把安装前那段补出来，按价目表计价，并用实测/估算的比值自校准（限幅 0.8–1.8×）。
>
> 另外接口鉴权头是 `x-dsh-auth-token`，用 `Authorization: Bearer` 会返回 HTTP 200 +
> `{"code":40003,...}`，能白查半小时。
>
> MIT，无遥测，只访问 DeepSeek 两个接口。仓库里把 transcript 解析、计数器记账、面板分成独立模块，
> 想抄哪块都行：https://github.com/YOURNAME/dsh-spend-meter

---

## 掘金 / 少数派（偏工程叙事，标题党克制）

**标题：** `把"一轮对话花了多少钱"算准到 1e-8：DSH 记账插件实现记录`

**摘要：** 不做 token×单价估算，而是对平台累计消费计数器做差分；顺便解决"计数器延迟结算"与
"插件中途安装导致当天缺数"两个问题，并用宿主 transcript 做回填与自校准。

**正文结构：**

1. 问题：为什么 token 估算不够（折扣、缓存价、峰谷、工具调用）
2. 接口考古：`get_user_summary` 的 8 位余额与 `total_costs`，以及鉴权头的坑
3. 记账模型：日账本 + 轮账本 + `unattributed` 兜底，为什么单调且不可下调（`Math.max`）
4. 回填：多帧 zstd 的静默截断、按帧头 `0xfd2fb528` 切分、增量缓存按天失效
5. 自校准：实测/估算比值，限幅的动机
6. 插件宿主契约：`ctx.get` 的根隔离表与 strict、`inject` 优先、Fetch 通道 401 是正常现象
7. 测试策略：无依赖 stub + 真凭据手动脚本，如何在不泄露 key 的前提下验证

末尾放仓库链接与 `npm` 安装命令。

---

## 一次性 checklist

- [ ] `Show HN` posted 08:00–10:00 UTC, Tue–Thu
- [ ] r/LocalLLaMA + r/DeepSeek, cross-link each other in a comment
- [ ] X thread, screenshot in tweet 1, repo link in tweet 4
- [ ] V2EX / 掘金 next morning (Beijing)
- [ ] Reply to everything for 24 h
- [ ] Pin an issue titled "What should the panel show next?" and act on one item within a week
