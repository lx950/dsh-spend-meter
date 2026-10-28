/**
 * dsh-spend-panel — client half.
 *
 * A small, draggable panel that shows what this session costs:
 *   balance · last turn · today · live turn · peak/off-peak
 *
 * It talks to the host over the Fetch route channel (`api/dsh-spend/state`),
 * with a plain GET fallback for older hosts. Failures are shown, not hidden:
 * if the balance cannot be read the panel says why.
 *
 * Not bundled — the host loads `lib/client.js` through `window.__ModuleLoader__`
 * as a CommonJS-style factory, exactly like the bundled client plugins do.
 */
window.__ModuleLoader__.load({
  id: `dsh-spend-panel`,
  factory: (require) => {
    const module = { exports: {} };
    const React = require(`react`);
    const h = React.createElement;
    // The dock lives inside the composer stack, which may be a transformed /
    // clipped containing block. Portal to <body> so `position: fixed` really
    // means "fixed to the viewport".
    let createPortal = null;
    try {
      const reactDom = require(`react-dom`);
      if (reactDom && typeof reactDom.createPortal === `function`) createPortal = reactDom.createPortal;
    } catch {
      /* react-dom not exposed — render inline (still fine on untransformed hosts) */
    }

    const PKG = `dsh-spend-panel`;
    const STYLE_ID = `dsh-spend-panel/styles`;
    const POS_KEY = `dsh-spend-meter/panel`;
    const POLL_MS = 3000;
    const PANEL_W = 268;

    /* ------------------------------------------------------------------ css -- */

    const CSS = `
.dsm-panel {
  position: fixed;
  z-index: 60;
  width: ${PANEL_W}px;
  box-sizing: border-box;
  font-family: var(--dsw-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif);
  font-size: var(--dsw-font-xs-13, 13px);
  line-height: 1.5;
  color: var(--dsw-alias-label-primary, #0f1115);
  background: var(--dsw-alias-bg-layer-1, #ffffff);
  border: 1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.1));
  border-radius: var(--dsw-radius-lg, 16px);
  box-shadow: var(--dsw-shadow-lv3, 0 4px 12px rgba(0, 0, 0, 0.02), 0 8px 32px rgba(0, 0, 0, 0.12));
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  overflow: hidden;
  user-select: none;
  -webkit-user-select: none;
  transition: opacity 120ms var(--ds-ease-in-out, ease), box-shadow 120ms var(--ds-ease-in-out, ease);
}
.dsm-panel[data-dragging="1"] {
  transition: none;
  box-shadow: var(--dsw-shadow-lv3, 0 12px 40px rgba(0, 0, 0, 0.18));
}
.dsm-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 10px 6px 12px;
  cursor: grab;
  touch-action: none;
}
.dsm-panel[data-dragging="1"] .dsm-head { cursor: grabbing; }
.dsm-title {
  flex: 1 1 auto;
  min-width: 0;
  font-size: var(--dsw-font-xxs-12, 12px);
  font-weight: 600;
  letter-spacing: 0.02em;
  color: var(--dsw-alias-label-secondary, #61666b);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.dsm-tier {
  flex: 0 0 auto;
  font-size: var(--dsw-font-xxxs-11, 11px);
  padding: 1px 6px;
  border-radius: var(--dsw-radius-xs, 4px);
  border: 1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.1));
  color: var(--dsw-alias-label-tertiary, #81858c);
  white-space: nowrap;
}
.dsm-tier[data-peak="1"] {
  color: var(--dsw-static-amber-500, rgb(245, 158, 11));
  border-color: color-mix(in srgb, var(--dsw-static-amber-500, rgb(245, 158, 11)) 35%, transparent);
}
.dsm-dot {
  flex: 0 0 auto;
  width: 6px;
  height: 6px;
  margin-right: 2px;
  border-radius: 50%;
  background: var(--dsw-static-green-500, rgb(34, 197, 94));
}
.dsm-dot[data-state="warn"] { background: var(--dsw-static-amber-500, rgb(245, 158, 11)); }
.dsm-dot[data-state="error"] { background: var(--dsw-static-red-500, rgb(239, 68, 68)); }
.dsm-dot[data-state="idle"] { background: var(--dsw-alias-label-caption, #adb2b8); }
.dsm-btn {
  flex: 0 0 auto;
  width: 20px;
  height: 20px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: 0;
  border-radius: var(--dsw-radius-xs, 4px);
  background: transparent;
  color: var(--dsw-alias-label-tertiary, #81858c);
  font: inherit;
  font-size: 12px;
  line-height: 1;
  cursor: pointer;
}
.dsm-btn:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(38, 49, 72, 0.06)); color: var(--dsw-alias-label-primary, #0f1115); }
.dsm-rows { padding: 0 12px 10px; }
.dsm-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
  padding: 3px 0;
}
.dsm-k {
  flex: 0 0 auto;
  font-size: var(--dsw-font-xxs-12, 12px);
  color: var(--dsw-alias-label-tertiary, #81858c);
  white-space: nowrap;
}
.dsm-v {
  flex: 1 1 auto;
  text-align: right;
  font-size: var(--dsw-font-xs-13, 13px);
  font-variant-numeric: tabular-nums;
  color: var(--dsw-alias-label-primary, #0f1115);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.dsm-v[data-strong="1"] { font-weight: 600; }
.dsm-v[data-dim="1"] { color: var(--dsw-alias-label-tertiary, #81858c); font-weight: 400; }
.dsm-note {
  padding: 6px 12px 10px;
  font-size: var(--dsw-font-xxxs-11, 11px);
  line-height: 1.45;
  color: var(--dsw-alias-label-tertiary, #81858c);
  border-top: 1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.1));
  word-break: break-word;
  user-select: text;
  -webkit-user-select: text;
}
.dsm-note[data-kind="error"] { color: var(--dsw-static-red-500, rgb(239, 68, 68)); }
.dsm-bar-wrap { padding: 4px 12px 10px; }
.dsm-pill {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  font-size: var(--dsw-font-xxs-12, 12px);
  color: var(--dsw-alias-label-secondary, #61666b);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.dsm-pill b { font-weight: 600; color: var(--dsw-alias-label-primary, #0f1115); }
body[data-ds-dark-theme] .dsm-panel {
  background: var(--dsw-alias-bg-layer-1, rgb(35, 35, 36));
  color: var(--dsw-alias-label-primary, #f9fafb);
  border-color: var(--dsw-alias-border-l2, rgba(255, 255, 255, 0.12));
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.24), 0 8px 32px rgba(0, 0, 0, 0.4);
}
`;

    function ensureCss() {
      if (typeof document === `undefined`) return;
      if (document.querySelector(`style[data-plugin-css="${STYLE_ID}"]`)) return;
      const el = document.createElement(`style`);
      el.setAttribute(`data-plugin`, PKG);
      el.setAttribute(`data-plugin-css`, STYLE_ID);
      el.textContent = CSS;
      document.head.appendChild(el);
    }

    /* --------------------------------------------------------------- helpers -- */

    function yuan(value, opts) {
      if (value === null || value === undefined || !Number.isFinite(Number(value))) return `—`;
      const n = Number(value);
      const decimals = opts && opts.decimals;
      let digits = 2;
      if (decimals !== undefined) digits = decimals;
      else if (n !== 0 && Math.abs(n) < 0.01) digits = 4;
      else if (n !== 0 && Math.abs(n) < 1) digits = 3;
      return `¥${n.toFixed(digits)}`;
    }

    function tokens(n) {
      const v = Number(n);
      if (!Number.isFinite(v) || v <= 0) return `—`;
      if (v >= 1e6) return `${(v / 1e6).toFixed(v >= 1e7 ? 0 : 1)}M`;
      if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
      return String(Math.round(v));
    }

    function clock(ms) {
      if (!ms) return ``;
      try {
        const d = new Date(ms);
        const p = (x) => String(x).padStart(2, `0`);
        return `${p(d.getHours())}:${p(d.getMinutes())}`;
      } catch {
        return ``;
      }
    }

    function transport() {
      try {
        const t = globalThis.__DSH_TRANSPORT__;
        if (!t) return ``;
        for (const key of [`streamBaseUrl`, `baseUrl`, `origin`]) {
          const v = t[key];
          if (typeof v === `string` && /^https?:\/\//.test(v)) return v.replace(/\/$/, ``);
        }
      } catch {
        /* not available on this host */
      }
      return ``;
    }

    /** Which base path actually answers — discovered once, then remembered. */
    let channel = null;
    const rememberChannel = (name, base) => {
      channel = { name, base };
    };
    try {
      const saved = globalThis.localStorage && globalThis.localStorage.getItem(`dsh-spend-meter/channel`);
      if (saved === `fetch` || saved === `http`) channel = { name: saved, base: `` };
    } catch {
      /* storage blocked */
    }

    async function askState(sessionId, probe) {
      const abs = transport();
      const tryFetchChannel = async () => {
        const payload = { session: sessionId };
        if (probe) payload.probe = probe;
        const res = await fetch(`api/dsh-spend/state`, {
          method: `POST`,
          headers: { 'content-type': `application/json` },
          body: JSON.stringify(payload),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (!data || data.ok !== true) throw new Error((data && data.error) || `bad payload`);
        return data;
      };
      const tryHttpChannel = async () => {
        const base = channel && channel.name === `http` && channel.base ? channel.base : abs;
        const query = `session=${encodeURIComponent(sessionId || ``)}` + (probe ? `&probe=${encodeURIComponent(JSON.stringify(probe))}` : ``);
        const url = `${base || ``}/api/dsh-spend/state?${query}`;
        const res = await fetch(url, { method: `GET` });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (!data || data.ok !== true) throw new Error((data && data.error) || `bad payload`);
        return data;
      };

      const attempts = [
        { name: `POST api/dsh-spend/state`, run: tryFetchChannel },
        { name: `GET /api/dsh-spend/state`, run: tryHttpChannel },
      ];
      // A remembered channel goes first, the other one still gets a chance.
      const order =
        channel && channel.name === `http`
          ? [attempts[1], attempts[0]]
          : [attempts[0], attempts[1]];
      const failures = [];
      let lastError = null;
      for (const attempt of order) {
        try {
          const data = await attempt.run();
          rememberChannel(attempt === attempts[0] ? `fetch` : `http`, attempt === attempts[1] ? abs : ``);
          try {
            globalThis.localStorage.setItem(`dsh-spend-meter/channel`, channel.name);
          } catch {
            /* ignore */
          }
          return data;
        } catch (err) {
          lastError = err;
          failures.push(`${attempt.name} → ${(err && err.message) || err}`);
        }
      }
      // Say which channel failed and on which page, otherwise "Failed to fetch" alone
      // gives nobody anything to work with.
      const where = (() => {
        try {
          return globalThis.location && globalThis.location.href ? ` @ ${globalThis.location.href}` : ``;
        } catch {
          return ``;
        }
      })();
      const error = new Error(failures.join(` | `) + where);
      error.cause = lastError;
      throw error;
    }

    /* ---------------------------------------------------------------- panel -- */

    function loadPos() {
      try {
        const raw = globalThis.localStorage.getItem(POS_KEY);
        if (raw) {
          const parsed = JSON.parse(raw);
          if (parsed && Number.isFinite(parsed.x) && Number.isFinite(parsed.y)) {
            return { x: parsed.x, y: parsed.y, collapsed: parsed.collapsed === true };
          }
        }
      } catch {
        /* ignore corrupt state */
      }
      return null;
    }

    function savePos(pos) {
      try {
        globalThis.localStorage.setItem(POS_KEY, JSON.stringify(pos));
      } catch {
        /* ignore */
      }
    }

    function defaultPos() {
      const vw = (globalThis.innerWidth || 1280) | 0;
      const vh = (globalThis.innerHeight || 800) | 0;
      return { x: Math.max(12, vw - PANEL_W - 24), y: Math.max(12, Math.round(vh * 0.35)), collapsed: false };
    }

    function clampPos(pos, collapsed) {
      const vw = (globalThis.innerWidth || 1280) | 0;
      const vh = (globalThis.innerHeight || 800) | 0;
      const w = PANEL_W;
      const hh = collapsed ? 34 : 212;
      return {
        x: Math.min(Math.max(0, pos.x), Math.max(0, vw - w)),
        y: Math.min(Math.max(0, pos.y), Math.max(0, vh - hh)),
        collapsed: pos.collapsed === true,
      };
    }

    /**
     * The id a slot injects is normally a string, but a host is free to hand over
     * the session object instead. Read the id out of it rather than sending
     * "[object Object]" to the meter.
     */
    function sessionIdOf(value) {
      if (typeof value === `string`) return value;
      if (typeof value === `number`) return String(value);
      if (value && typeof value === `object`) {
        const inner = value.id != null ? value.id : value.sessionId != null ? value.sessionId : value.session != null ? value.session : ``;
        return typeof inner === `string` ? inner : inner != null ? String(inner) : ``;
      }
      return ``;
    }

    /**
     * Find the session id in whatever a dock child is handed.
     *
     * A session-scoped slot's `inject` receives the binding key, but in this host
     * the dock was observed receiving nothing at all (`diag.lastSession.raw` was
     * empty while a conversation was clearly open). The conversation root renders
     * the dock with `{ session, input }` as owner props, so the session object is
     * the dependable source; keep the injected value as the last resort.
     */
    function resolveSessionId(props, injected) {
      const face = props || {};
      const candidates = [
        [`props.sessionId`, face.sessionId],
        [`props.session.id`, face.session && face.session.id],
        [`props.session.sessionId`, face.session && face.session.sessionId],
        [`props.input.sessionId`, face.input && face.input.sessionId],
        [`props.input.session.id`, face.input && face.input.session && face.input.session.id],
        [`inject`, injected],
      ];
      for (const [source, value] of candidates) {
        const id = sessionIdOf(value);
        if (id) return { id, source };
      }
      return { id: ``, source: `none` };
    }

    function SpendPanel(props) {
      const injected = props && props.injectedSessionId;
      const resolved = resolveSessionId(props, injected);
      const sessionId = resolved.id;
      const probeOnce = React.useRef(true);
      const [state, setState] = React.useState(null);
      const [failure, setFailure] = React.useState(null);
      const [pos, setPos] = React.useState(() => clampPos(loadPos() || defaultPos()));
      const [dragging, setDragging] = React.useState(false);
      const dragRef = React.useRef(null);

      React.useEffect(() => {
        let alive = true;
        let timer = null;
        const tick = async () => {
          try {
            // The very first poll can race the plugin's route mount and fail. Only
            // forget the probe once a poll actually succeeds, otherwise the one
            // payload that explains what the slot props contained is thrown away.
            // While the id is still unknown, keep attaching it: it is the only way
            // left to learn what this host version hands a dock child.
            const probe = probeOnce.current || !sessionId
              ? {
                  source: resolved.source,
                  resolved: sessionId,
                  propsKeys: Object.keys(props || {}),
                  sessionKeys: Object.keys((props && props.session) || {}),
                }
              : null;
            const data = await askState(sessionId, probe);
            if (!alive) return;
            if (probe) probeOnce.current = false;
            setState(data);
            setFailure(null);
          } catch (err) {
            if (!alive) return;
            setFailure(String((err && err.message) || err));
          }
          if (alive) timer = globalThis.setTimeout(tick, POLL_MS);
        };
        tick();
        const onResize = () => setPos((p) => clampPos(p, p.collapsed));
        globalThis.addEventListener && globalThis.addEventListener(`resize`, onResize);
        return () => {
          alive = false;
          if (timer) globalThis.clearTimeout(timer);
          globalThis.removeEventListener && globalThis.removeEventListener(`resize`, onResize);
        };
      }, [sessionId]);

      const persist = (next) => {
        const clamped = clampPos(next, next.collapsed);
        setPos(clamped);
        savePos(clamped);
        return clamped;
      };

      const onPointerDown = (event) => {
        if (event.button !== undefined && event.button !== 0) return;
        const target = event.currentTarget;
        try {
          target.setPointerCapture && target.setPointerCapture(event.pointerId);
        } catch {
          /* ignore */
        }
        dragRef.current = { dx: event.clientX - pos.x, dy: event.clientY - pos.y, id: event.pointerId };
        setDragging(true);
      };
      const onPointerMove = (event) => {
        if (!dragRef.current) return;
        event.preventDefault();
        const next = clampPos({ x: event.clientX - dragRef.current.dx, y: event.clientY - dragRef.current.dy, collapsed: pos.collapsed }, pos.collapsed);
        setPos(next);
      };
      const onPointerUp = () => {
        if (!dragRef.current) return;
        dragRef.current = null;
        setDragging(false);
        savePos(pos);
      };
      const toggle = () => {
        const next = { x: pos.x, y: pos.y, collapsed: !pos.collapsed };
        persist(next);
      };

      const balance = state && state.balance ? state.balance : null;
      const today = state && state.today ? state.today : null;
      const lastTurn = state && state.lastTurn ? state.lastTurn : null;
      const live = state && state.live ? state.live : null;
      const peak = state && state.peak === true;

      const balanceText = balance ? yuan(balance.value) : `—`;
      // "Last turn" prefers the money the Platform actually charged for it; the rate
      // card estimate is the fallback (and what shows while the charge settles).
      const lastActual = lastTurn && typeof lastTurn.actual === `number` ? lastTurn.actual : null;
      const lastText = lastTurn ? yuan(lastActual != null ? lastActual : lastTurn.amount) : `—`;
      const lastTitle = lastTurn
        ? [
            `第 ${lastTurn.turn} 轮 · ${tokens(lastTurn.tokens)} tokens · ${lastTurn.model || ``}`,
            lastActual != null
              ? `实测扣费 ${yuan(lastActual)}（平台账单差额）`
              : `按价目表估算 ${yuan(lastTurn.amount)}（平台账单尚未结算这一轮）`,
            // The server falls back when it cannot match the id this panel sent; say
            // so instead of silently implying "your session".
            lastTurn.scope === `recent` ? `当前会话未上报 id，显示最近一轮` : ``,
            lastTurn.scope === `active` ? `当前会话未上报 id，显示最近活跃会话` : ``,
          ]
            .filter(Boolean)
            .join(`\n`)
        : `还没有已完成的回合`;
      const costs = state && state.costs ? state.costs : null;
      // "Today" has two numbers: what the account actually paid (Platform spend
      // counter, exact) and what the token rate card predicts. The counter wins when
      // available, the estimate is the fallback, and the tooltip shows both.
      const todayActual = today && typeof today.actual === `number` ? today.actual : null;
      const todayText = today ? yuan(todayActual != null ? todayActual : today.amount) : `—`;
      const todaySource =
        today && today.actualSource === `counter` ? `平台账单计数器` : `余额差`;
      const todayTitle = today
        ? [
            todayActual != null
              ? `实测扣费${today.actualSince ? `（自 ${clock(today.actualSince)} 起按${todaySource}` : `（按${todaySource}`}${
                  today.actualBefore > 0
                    ? ` + 之前 ¥${today.actualBefore.toFixed(4)} 按价目表估算${
                        today.actualFactor && Math.abs(today.actualFactor - 1) > 0.005
                          ? `（实测/估算 ${today.actualFactor.toFixed(3)}×）`
                          : ``
                      }`
                    : ``
                }）`
              : `按 token × 价目表估算`,
            `全量估算 ${yuan(today.amount)} · ${today.turns || 0} 轮 · ${tokens(today.tokens || 0)} tokens`,
            costs && costs.pending > 0 ? `${costs.pending} 轮等待平台账单结算` : ``,
            costs && costs.available === false && costs.error ? `平台账单不可用：${costs.error}` : ``,
            today.actualCredits > 0 ? `今日到账充值 ${yuan(today.actualCredits)}（不计入消耗）` : ``,
            today.firstAt ? `本日最早一笔 ${clock(today.firstAt)}` : ``,
          ]
            .filter(Boolean)
            .join(`\n`)
        : ``;
      const liveText = live && live.amount > 0 ? yuan(live.amount) : `—`;

      let dotState = `idle`;
      if (failure) dotState = `error`;
      else if (balance && balance.error) dotState = `warn`;
      else if (state) dotState = `ok`;

      const tierLabel = state ? (peak ? `峰时` : `谷时`) : `…`;
      const nextSwitch = state && state.nextPeakAt ? clock(state.nextPeakAt) : ``;

      const head = h(
        `div`,
        {
          className: `dsm-head`,
          onPointerDown,
          onPointerMove,
          onPointerUp,
          onPointerCancel: onPointerUp,
          title: `按住拖动`,
        },
        h(`span`, { className: `dsm-dot`, 'data-state': dotState }),
        h(`span`, { className: `dsm-title` }, pos.collapsed ? `${balanceText} · 上轮 ${lastText} · 今日 ${todayText}` : `会话花费`),
        pos.collapsed ? null : h(`span`, { className: `dsm-tier`, 'data-peak': peak ? `1` : `0` }, tierLabel),
        h(
          `button`,
          {
            className: `dsm-btn`,
            type: `button`,
            title: pos.collapsed ? `展开` : `收起`,
            onPointerDown: (e) => e.stopPropagation(),
            onClick: (e) => {
              e.stopPropagation();
              toggle();
            },
          },
          pos.collapsed ? `▴` : `▾`
        )
      );

      const row = (key, value, opts) =>
        h(
          `div`,
          { className: `dsm-row` },
          h(`span`, { className: `dsm-k` }, key),
          h(
            `span`,
            {
              className: `dsm-v`,
              'data-strong': opts && opts.strong ? `1` : `0`,
              'data-dim': opts && opts.dim ? `1` : `0`,
              title: (opts && opts.title) || ``,
            },
            value
          )
        );

      const rows = pos.collapsed
        ? null
        : h(
            `div`,
            { className: `dsm-rows` },
            row(`余额`, balanceText, {
              strong: true,
              title: balance && balance.error ? balance.error : balance && balance.at ? `更新于 ${clock(balance.at)}` : ``,
            }),
            row(`上轮`, lastText, {
              strong: true,
              title: lastTitle,
            }),
            row(`今日`, todayText, {
              strong: true,
              title: todayTitle,
            }),
            liveText === `—` ? null : row(`本轮`, liveText, { dim: true, title: live ? `${tokens(live.tokens)} tokens` : `` }),
            row(
              `计费`,
              peak ? (nextSwitch ? `峰时 → ${nextSwitch} 转谷` : `峰时`) : nextSwitch ? `谷时 → ${nextSwitch} 转峰` : `谷时`,
              { dim: true }
            )
          );

      let note = null;
      if (failure) {
        note = h(`div`, { className: `dsm-note`, 'data-kind': `error` }, `连不上记账服务：${failure}`);
      } else if (balance && balance.error) {
        note = h(`div`, { className: `dsm-note`, 'data-kind': `error` }, `余额读不到：${balance.error}`);
      } else if (state && !balance) {
        note = h(`div`, { className: `dsm-note` }, `等待余额…`);
      }

      const panel = h(
        `div`,
        {
          className: `dsm-panel`,
          'data-dragging': dragging ? `1` : `0`,
          style: { left: `${Math.round(pos.x)}px`, top: `${Math.round(pos.y)}px` },
        },
        head,
        rows,
        pos.collapsed ? null : note
      );

      const host = createPortal && typeof document !== `undefined` && document.body ? document.body : null;
      return host ? createPortal(panel, host) : panel;
    }

    /* ------------------------------------------------------------ plugin glue -- */

    function apply(ctx) {
      ensureCss();
      ctx.slots.inject(`conversation.input.dock`, () =>
        ctx.slots.register(
          {
            name: `conversation.input.dock`,
            id: `spend-meter`,
            order: 30,
            // Hand the raw value through untouched: `resolveSessionId` copes with a
            // string, a number or a session object, and nothing is lost on the way.
            // An empty value must not be forwarded at all, otherwise a defined
            // `sessionId` from the standard props would be overwritten by undefined.
            inject: (value) => (value === undefined || value === null ? {} : { injectedSessionId: sessionIdOf(value) }),
          },
          SpendPanel
        )
      );
    }

    module.exports = { name: `${PKG}`, inject: [`slots`], apply };
    return module.exports;
  },
});
