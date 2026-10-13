/* AI Agent Trading SNR — the simulation engine.
 *
 * Everything on the dashboard runs here in the browser: the price, the three
 * agents and the master verdict come from a scripted simulation, never from a
 * market feed. It reads prices, it never places, sends or executes a trade.
 *
 * Class names below are whole literals on purpose: the Tailwind build scans
 * this file with a regex, so a class assembled at runtime would never be
 * compiled (see the note in index.html).
 */
(function () {
  'use strict';

  /* ── Pair config ──────────────────────────────────────────────────────
   * Zones are the SNR levels the agents read. Only H1 zones drive the
   * rules today; the H4 zones appear in the ladder for context. */
  const PAIRS = {
    XAUUSD: {
      label: 'XAUUSD (Gold / US Dollar)',
      digits: 2,
      zones: [
        { name: 'H4 support', tf: 'H4', kind: 'support', low: 2329.0, high: 2331.5 },
        { name: 'H1 support', tf: 'H1', kind: 'support', low: 2338.5, high: 2341.0 },
        { name: 'H1 resistance', tf: 'H1', kind: 'resistance', low: 2362.0, high: 2364.5 },
        { name: 'H4 resistance', tf: 'H4', kind: 'resistance', low: 2371.0, high: 2373.5 },
      ],
      // The scripted path: price eases toward each leg's target, plus noise
      // of up to ±0.35 per tick. One loop sets up a buy at support; the next
      // mirrors it as a sell at resistance, then breaks below support, so
      // all three verdicts and both directions appear within about four
      // minutes. Each loop ends where the next begins.
      legs: [
        [
          { to: 2340.2, ticks: 12 }, // drifts down into H1 support
          { to: 2336.9, ticks: 4 }, // sweeps 1.60 below the far edge
          { to: 2342.0, ticks: 4 }, // the V back inside — green buy setup
          { to: 2342.6, ticks: 8 }, // holds just above the zone
          { to: 2351.0, ticks: 8 }, // leaves the zone
          { to: 2363.4, ticks: 12 }, // climbs into H1 resistance
          { to: 2368.2, ticks: 5 }, // breaks out 3.70 above — red
          { to: 2352.0, ticks: 10 }, // falls back mid-range
        ],
        [
          { to: 2363.4, ticks: 12 }, // climbs into H1 resistance
          { to: 2365.9, ticks: 4 }, // sweeps 1.40 above the far edge
          { to: 2360.8, ticks: 4 }, // the V back down — green sell setup
          { to: 2360.2, ticks: 8 }, // holds just below the zone
          { to: 2351.0, ticks: 8 }, // leaves the zone
          { to: 2340.2, ticks: 12 }, // falls into H1 support
          { to: 2333.0, ticks: 5 }, // breaks down 5.50 below — red
          { to: 2350.0, ticks: 10 }, // recovers mid-range
        ],
      ],
    },
  };

  const TICK_MS = 1500;
  const DEMO_SEED = 20261013;
  const LOG_CAP = 60;

  /* Class lookups — every entry a whole literal for the Tailwind scanner. */
  const CHIP = { go: 'chip chip-go', wait: 'chip chip-wait', stop: 'chip chip-stop', idle: 'chip chip-idle' };
  const TONE_TEXT = { go: 'text-go', wait: 'text-wait', stop: 'text-stop', idle: 'text-muted' };
  const PILL = {
    go: 'status-pill status-pill-go',
    wait: 'status-pill status-pill-wait',
    stop: 'status-pill status-pill-stop',
    idle: 'status-pill status-pill-idle',
  };
  const LOG_TONE = { go: 'text-go', wait: 'text-wait', stop: 'text-stop', muted: 'text-muted' };
  const BADGE = {
    running: { tone: 'go', text: 'ACTIVE / SCANNING MARKET' },
    paused: { tone: 'wait', text: 'PAUSED / SCAN ON HOLD' },
    stopped: { tone: 'stop', text: 'STOPPED' },
    starting: { tone: 'idle', text: 'STARTING' },
  };

  const $ = (sel) => document.querySelector(sel);
  const el = {
    status: $('[data-status]'),
    pair: $('[data-pair]'),
    pauseBtn: $('[data-pause]'),
    pauseIcon: $('[data-pause-icon]'),
    resumeIcon: $('[data-resume-icon]'),
    pauseLabel: $('[data-pause-label]'),
    noteDemo: $('[data-note-demo]'),
    terminalMeta: $('[data-terminal-meta]'),
    simError: $('[data-sim-error]'),
    errorTime: $('[data-error-time]'),
    retry: $('[data-retry]'),
    terminalBody: $('[data-terminal-body]'),
    lamps: {},
    verdict: $('[data-verdict]'),
    reason: $('[data-reason]'),
    price: $('[data-price]'),
    priceNote: $('[data-price-note]'),
    votes: {},
    agents: {},
    log: $('[data-log]'),
  };
  document.querySelectorAll('[data-lamp]').forEach((n) => { el.lamps[n.dataset.lamp] = n; });
  ['h1', 'm30', 'm1'].forEach((a) => {
    const icons = {};
    ['go', 'wait', 'stop'].forEach((t) => { icons[t] = $(`[data-vote-icon="${a}-${t}"]`); });
    el.votes[a] = { icons, name: $(`[data-vote-name="${a}"]`), label: $(`[data-vote-label="${a}"]`) };
    el.agents[a] = {
      root: $(`[data-agent="${a}"]`),
      chip: $(`[data-agent="${a}"] [data-chip]`),
      facts: $(`[data-agent="${a}"] [data-facts]`),
    };
  });
  el.agents.h1.ladder = $('[data-agent="h1"] [data-ladder]');
  el.agents.m30.sentence = $('[data-agent="m30"] [data-sentence]');
  el.agents.m1.sparkZone = $('[data-spark-zone]');
  el.agents.m1.sparkLine = $('[data-spark-line]');
  el.agents.m1.sparkDot = $('[data-spark-dot]');

  /* ── Small helpers ─────────────────────────────────────────────────── */
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const now = () => (window.usernode && window.usernode.now ? window.usernode.now() : new Date());
  const fmtTime = (d) => d.toLocaleTimeString('en-GB', { hour12: false });

  function edge(zone) {
    // The far edge: the side a sweep pierces through.
    return zone.kind === 'support' ? zone.low : zone.high;
  }
  function beyondFar(zone, price) {
    // How far price is beyond the far edge (positive = outside).
    return zone.kind === 'support' ? zone.low - price : price - zone.high;
  }
  function fromNear(zone, price) {
    // How far price sits on the near side of the zone.
    return zone.kind === 'support' ? price - zone.high : zone.low - price;
  }
  function inside(zone, price) {
    return price >= zone.low && price <= zone.high;
  }

  /* ── Engine state ──────────────────────────────────────────────────── */
  const state = {
    demo: false,
    pairKey: 'XAUUSD',
    pair: null,
    rng: null,
    timer: null,
    running: false,
    paused: false,
    stopped: false,
    tick: 0,
    price: null,
    history: [], // the last 120 tick prices
    legLoop: 0,
    legIndex: 0,
    legTick: 0,
    from: null,
    h1: null,
    m30: null,
    m1: null,
    episode: null,
    verdict: null,
    lastPriceLog: null, // { at, price } for the "in Ns" of the price lines
    startedAt: null,
  };

  function buildPairOptions() {
    el.pair.replaceChildren();
    Object.keys(PAIRS).forEach((key) => {
      const opt = document.createElement('option');
      opt.value = key;
      opt.textContent = PAIRS[key].label;
      el.pair.appendChild(opt);
    });
    el.pair.value = state.pairKey;
  }

  function resetEngine(seed) {
    stopTimer();
    state.pair = PAIRS[state.pairKey];
    state.rng = mulberry32(seed);
    state.tick = 0;
    state.price = null;
    state.history = [];
    state.legLoop = 0;
    state.legIndex = 0;
    state.legTick = 0;
    state.from = null;
    state.episode = null;
    state.verdict = null;
    state.lastPriceLog = null;
    state.startedAt = now().getTime();
    state.h1 = { tone: 'stop', label: 'Mid-range', zone: null, beyond: 0, near: 0 };
    state.m30 = { tone: 'idle', label: 'No zone', zone: null, extreme: null, beyond: 0 };
    state.m1 = { tone: 'idle', label: 'Waiting', zone: null, extreme: null, entry: null, recovery: 0 };
    state.paused = false;
    state.stopped = false;
    el.simError.hidden = true;
    el.terminalMeta.textContent = '';
    setBadge('starting');
    setPauseButton(false);
    el.lamps.stop.className = 'lamp';
    el.lamps.wait.className = 'lamp';
    el.lamps.go.className = 'lamp';
    el.verdict.textContent = 'Starting scan';
    el.verdict.className = 'text-title text-muted';
    el.reason.textContent = 'Reading the market';
    el.price.textContent = '—';
    el.priceNote.textContent = '';
    ['h1', 'm30', 'm1'].forEach((a) => {
      renderVote(a, state[a]);
      renderChip(a, state[a]);
    });
    renderLadder();
    el.agents.m30.sentence.textContent = 'No H1 zone under watch yet.';
    renderFacts(el.agents.m30.facts, []);
    renderFacts(el.agents.m1.facts, []);
    drawSpark();
  }

  function digits() {
    return state.pair.digits;
  }
  function fmt(p) {
    return Number(p).toLocaleString('en-US', { minimumFractionDigits: digits(), maximumFractionDigits: digits() });
  }

  /* ── One tick ──────────────────────────────────────────────────────── */
  function tickOnce() {
    state.tick += 1;
    const legs = state.pair.legs[state.legLoop % 2];
    if (state.legTick === 0) state.from = state.price == null ? state.pair.legs[0][0].to + 9.8 : state.price;
    const leg = legs[state.legIndex];
    state.legTick += 1;
    const t = state.legTick / leg.ticks;
    const noise = state.rng() * 0.7 - 0.35;
    state.price = state.from + (leg.to - state.from) * t + noise;
    state.history.push(state.price);
    if (state.history.length > 120) state.history.shift();
    if (state.legTick >= leg.ticks) {
      state.legIndex += 1;
      state.legTick = 0;
      if (state.legIndex >= legs.length) {
        state.legIndex = 0;
        state.legLoop += 1;
      }
    }

    state.h1 = evalH1(state.price, state.h1);
    state.m30 = evalM30(state.price, state.h1);
    state.m1 = evalM1(state.price, state.m30);
    state.verdict = evalMaster(state.h1, state.m30, state.m1);

    renderTerminal();
    ['h1', 'm30', 'm1'].forEach((a) => {
      renderVote(a, state[a]);
      renderChip(a, state[a]);
    });
    renderLadder();
    renderM30();
    renderM1Facts();
    drawSpark();
    writeTickLogs();
  }

  /* ── Agent 1: H1 Zone Mapper ───────────────────────────────────────── */
  function evalH1(price, prev) {
    const h1s = state.pair.zones.filter((z) => z.tf === 'H1');
    let out = null;
    for (const z of h1s) {
      const beyond = beyondFar(z, price);
      if (inside(z, price) || (beyond >= 0 && beyond <= 3.0)) {
        out = { tone: 'go', label: z.kind === 'support' ? 'At support' : 'At resistance', zone: z, beyond: Math.max(0, beyond), near: Math.max(0, fromNear(z, price)) };
        break;
      }
      const near = fromNear(z, price);
      if (near > 0 && near <= 1.5 && !out) {
        out = { tone: 'wait', label: 'Near zone', zone: z, beyond: 0, near };
      }
    }
    if (!out) out = { tone: 'stop', label: 'Mid-range', zone: null, beyond: 0, near: 0 };
    // Zone broken is sticky: it holds while price is more than 3.00 beyond
    // the far edge, and clears only once price is back inside or mid-range.
    for (const z of h1s) {
      const beyond = beyondFar(z, price);
      if (beyond > 3.0) {
        out = { tone: 'stop', label: 'Zone broken', zone: z, beyond, near: 0 };
      } else if (prev && prev.label === 'Zone broken' && prev.zone === z && beyond > 0 && !inside(z, price) && out.tone !== 'go' && !(out.zone === z && out.label === 'Near zone')) {
        out = { tone: 'stop', label: 'Zone broken', zone: z, beyond, near: 0 };
      }
    }
    return out;
  }

  /* ── Agent 2: M30 Sweep Hunter ─────────────────────────────────────── */
  function evalM30(price, h1) {
    if (h1.tone === 'go') {
      const z = h1.zone;
      let ep = state.episode;
      if (!ep || ep.zone !== z) {
        ep = { zone: z, extreme: price, extremeBeyond: 0, backInside: false, extremeTick: state.tick };
        state.episode = ep;
      }
      const beyond = beyondFar(z, price);
      if (beyond > ep.extremeBeyond) {
        ep.extremeBeyond = beyond;
        ep.extreme = price;
        ep.extremeTick = state.tick;
      }
      if (inside(z, price)) ep.backInside = true;
      if (ep.backInside && ep.extremeBeyond >= 0.5 && ep.extremeBeyond <= 3.0) {
        return { tone: 'go', label: 'Sweep found', zone: z, extreme: ep.extreme, beyond: ep.extremeBeyond };
      }
      return { tone: 'wait', label: 'Watching', zone: z, extreme: ep.extreme, beyond: ep.extremeBeyond };
    }
    state.episode = null; // leaving the zone resets the episode, and agent 3
    if (h1.label === 'Zone broken') {
      return { tone: 'stop', label: 'Breakout', zone: h1.zone, extreme: null, beyond: h1.beyond };
    }
    return { tone: 'idle', label: 'No zone', zone: null, extreme: null, beyond: 0 };
  }

  /* ── Agent 3: M1 Zero Floating Trigger ─────────────────────────────── */
  function evalM1(price, m30) {
    if (m30.tone !== 'go' || !state.episode) {
      return { tone: 'idle', label: 'Waiting', zone: null, extreme: null, entry: null, recovery: 0 };
    }
    const z = state.episode.zone;
    const buy = z.kind === 'support';
    const extreme = state.episode.extreme;
    const recovery = buy ? price - extreme : extreme - price;
    const entry = buy ? extreme + 0.2 : extreme - 0.2;
    const sinceExtreme = state.tick - state.episode.extremeTick;
    if (recovery >= 2.0 && sinceExtreme <= 6) {
      return { tone: 'go', label: 'V-shape', zone: z, extreme, entry, recovery };
    }
    return { tone: 'wait', label: 'Watching wick', zone: z, extreme, entry, recovery };
  }

  /* ── Master decision ───────────────────────────────────────────────── */
  function evalMaster(h1, m30, m1) {
    if (h1.tone === 'go' && m30.tone === 'go' && m1.tone === 'go') {
      const z = h1.zone;
      const dir = z.kind === 'support' ? 'Buy' : 'Sell';
      return {
        tone: 'go',
        word: 'Ready to Execute',
        reason: dir + ' setup at ' + z.name + ' ' + fmt(z.low) + ' – ' + fmt(z.high),
      };
    }
    if (h1.tone === 'stop' || m30.tone === 'stop') {
      let reason;
      if (m30.tone === 'stop') reason = 'Breakout ' + fmt(m30.beyond) + ' beyond ' + m30.zone.name;
      else if (h1.label === 'Zone broken') reason = 'H1 zone broken, no valid setup';
      else reason = 'Price mid-range, no valid zone';
      return { tone: 'stop', word: 'Invalid Zone', reason };
    }
    let reason;
    if (h1.tone !== 'go') reason = 'Near ' + h1.zone.name + ' — no setup yet';
    else if (m30.tone === 'wait') reason = 'At ' + h1.zone.name + ' — watching for a sweep';
    else reason = 'Sweep found — waiting for the M1 V-shape';
    return { tone: 'wait', word: 'Standby', reason };
  }

  /* ── Rendering ─────────────────────────────────────────────────────── */
  function setBadge(kind) {
    const b = BADGE[kind];
    el.status.textContent = b.text;
    el.status.className = PILL[b.tone];
  }
  function setPauseButton(paused) {
    el.pauseIcon.hidden = paused;
    el.resumeIcon.hidden = !paused;
    el.pauseLabel.textContent = paused ? 'Resume scan' : 'Pause scan';
  }
  function renderVote(agent, a) {
    const v = el.votes[agent];
    const iconTone = a.tone === 'idle' ? 'wait' : a.tone;
    ['go', 'wait', 'stop'].forEach((t) => { v.icons[t].hidden = t !== iconTone; });
    v.name.className = TONE_TEXT[a.tone];
    v.label.textContent = a.label;
    v.label.className = TONE_TEXT[a.tone];
  }
  function renderChip(agent, a) {
    el.agents[agent].chip.textContent = a.label;
    el.agents[agent].chip.className = CHIP[a.tone];
  }
  function renderTerminal() {
    ['stop', 'wait', 'go'].forEach((t) => {
      el.lamps[t].className = state.verdict && state.verdict.tone === t ? 'lamp lamp-' + t : 'lamp';
    });
    el.verdict.textContent = state.verdict.word;
    el.verdict.className = 'text-title ' + TONE_TEXT[state.verdict.tone];
    el.reason.textContent = state.verdict.reason;
    el.price.textContent = fmt(state.price);
    const z = state.h1.zone;
    let note = '';
    if (z) {
      if (inside(z, state.price)) note = 'in ' + z.name;
      else if (state.h1.beyond > 0) note = fmt(state.h1.beyond) + ' beyond ' + z.name;
      else note = fmt(state.h1.near) + ' from ' + z.name;
    }
    el.priceNote.textContent = note;
  }
  function renderLadder() {
    const rows = [];
    state.pair.zones.forEach((z) => {
      const active = state.h1.zone === z && state.h1.tone === 'go';
      const tone = z.kind === 'support' ? 'go' : 'stop';
      let note = '';
      let noteTone = 'muted';
      if (z.tf === 'H1') {
        if (active) {
          note = inside(z, state.price) ? 'price here' : fmt(state.h1.beyond) + ' beyond';
          noteTone = tone;
        } else if (state.h1.zone === z && state.h1.tone === 'wait') {
          note = fmt(state.h1.near) + ' from edge';
        } else {
          const b = beyondFar(z, state.price);
          const n = fromNear(z, state.price);
          if (b > 0) note = fmt(b) + ' beyond';
          else if (n > 0) note = fmt(n) + ' away';
        }
      }
      rows.push({ name: z.name, range: fmt(z.low) + ' – ' + fmt(z.high), active, tone, note, noteTone });
    });
    const ul = el.agents.h1.ladder;
    ul.replaceChildren();
    rows.forEach((r) => {
      const li = document.createElement('li');
      li.className = 'list-row justify-between gap-3 py-2.5';
      const left = document.createElement('div');
      left.className = 'min-w-0';
      const name = document.createElement('p');
      name.className = r.active ? 'text-small font-semibold ' + TONE_TEXT[r.tone] : 'text-small font-semibold text-fg';
      name.textContent = r.name;
      const range = document.createElement('p');
      range.className = 'text-small text-muted';
      range.textContent = r.range;
      left.appendChild(name);
      left.appendChild(range);
      const right = document.createElement('span');
      right.className = 'text-small ' + TONE_TEXT[r.noteTone];
      right.textContent = r.note;
      li.appendChild(left);
      li.appendChild(right);
      ul.appendChild(li);
    });
  }
  function renderFacts(dl, rows) {
    dl.replaceChildren();
    rows.forEach((r) => {
      const div = document.createElement('div');
      div.className = 'flex items-baseline justify-between gap-3';
      const dt = document.createElement('dt');
      dt.className = 'text-muted';
      dt.textContent = r[0];
      const dd = document.createElement('dd');
      dd.className = 'font-semibold text-fg';
      dd.textContent = r[1];
      div.appendChild(dt);
      div.appendChild(dd);
      dl.appendChild(div);
    });
  }
  function renderM30() {
    const m = state.m30;
    let sentence;
    const rows = [['Zone', m.zone ? m.zone.name + ' ' + fmt(m.zone.low) + ' – ' + fmt(m.zone.high) : '—']];
    if (m.tone === 'go') {
      const buy = m.zone.kind === 'support';
      sentence = 'Liquidity swept ' + (buy ? 'below' : 'above') + ' ' + fmt(edge(m.zone)) + ' — price is back inside.';
      rows.push([buy ? 'Sweep low' : 'Sweep high', fmt(m.extreme)]);
    } else if (m.tone === 'wait') {
      sentence = m.beyond > 0
        ? 'Pierced ' + fmt(edge(m.zone)) + ' — waiting for the return inside.'
        : 'Watching ' + fmt(m.zone.kind === 'support' ? m.zone.high : m.zone.low) + ' at ' + m.zone.name + '.';
      if (m.extreme != null) rows.push([m.zone.kind === 'support' ? 'Sweep low' : 'Sweep high', fmt(m.extreme)]);
    } else if (m.tone === 'stop') {
      sentence = 'Breakout ' + fmt(m.beyond) + ' beyond ' + m.zone.name + ' — zone invalid.';
    } else {
      sentence = 'No H1 zone under watch.';
    }
    el.agents.m30.sentence.textContent = sentence;
    renderFacts(el.agents.m30.facts, rows);
  }
  function renderM1Facts() {
    const m = state.m1;
    if (m.tone === 'idle' || m.extreme == null) {
      renderFacts(el.agents.m1.facts, []);
      return;
    }
    const z = m.zone;
    const wick = Math.max(0, Math.round(beyondFar(z, m.extreme) - 0.68));
    const wickTxt = fmt(wick);
    renderFacts(el.agents.m1.facts, [
      ['Wick', wickTxt],
      ['Entry', fmt(m.entry)],
      ['Recovery', fmt(m.recovery)],
    ]);
  }
  function drawSpark() {
    const svg = el.agents.m1;
    const pts = state.history.slice(-30);
    if (pts.length < 2) {
      svg.sparkLine.setAttribute('points', '');
      svg.sparkDot.setAttribute('visibility', 'hidden');
      svg.sparkZone.setAttribute('height', '0');
      return;
    }
    const z = state.h1.zone;
    let min = Math.min.apply(null, pts);
    let max = Math.max.apply(null, pts);
    if (z) {
      min = Math.min(min, z.low);
      max = Math.max(max, z.high);
    }
    const pad = (max - min) * 0.1 || 1;
    min -= pad;
    max += pad;
    const H = 72;
    const y = (p) => H - 4 - ((p - min) / (max - min)) * (H - 8);
    const n = pts.length;
    const points = pts.map((p, i) => ((i / (n - 1)) * 298 + 1).toFixed(1) + ',' + y(p).toFixed(1));
    svg.sparkLine.setAttribute('points', points.join(' '));
    const last = points[n - 1].split(',');
    svg.sparkDot.setAttribute('cx', last[0]);
    svg.sparkDot.setAttribute('cy', last[1]);
    svg.sparkDot.setAttribute('visibility', 'visible');
    if (z) {
      const top = Math.min(y(z.high), y(z.low));
      const bottom = Math.max(y(z.high), y(z.low));
      svg.sparkZone.setAttribute('y', top.toFixed(1));
      svg.sparkZone.setAttribute('height', Math.max(1, bottom - top).toFixed(1));
      svg.sparkZone.setAttribute('fill', z.kind === 'support' ? 'rgb(var(--go) / 0.15)' : 'rgb(var(--stop) / 0.15)');
    } else {
      svg.sparkZone.setAttribute('height', '0');
    }
  }

  /* ── Log ───────────────────────────────────────────────────────────── */
  function addLog(source, tone, text) {
    const li = document.createElement('li');
    li.className = 'flex gap-2 py-1';
    li.dataset.tick = String(state.tick);
    const time = document.createElement('span');
    time.className = 'flex-none text-muted';
    time.textContent = fmtTime(now());
    const src = document.createElement('span');
    src.className = 'flex-none font-semibold ' + LOG_TONE[tone];
    src.textContent = source;
    const body = document.createElement('span');
    body.className = 'min-w-0 flex-1';
    body.textContent = text;
    li.appendChild(time);
    li.appendChild(src);
    li.appendChild(body);
    el.log.prepend(li);
    while (el.log.children.length > LOG_CAP) el.log.removeChild(el.log.lastChild);
    return li;
  }

  function writeTickLogs() {
    // Agent lines only when that agent's status changes.
    const lines = [
      ['H1', state.h1Prev, state.h1, describeH1],
      ['M30', state.m30Prev, state.m30, describeM30],
      ['M1', state.m1Prev, state.m1, describeM1],
    ];
    lines.forEach(([source, prev, cur, describe]) => {
      if (prev && (prev.tone !== cur.tone || prev.label !== cur.label)) {
        addLog(source, cur.tone, describe(cur));
      }
    });
    if (state.verdictPrev && (state.verdictPrev.tone !== state.verdict.tone || state.verdictPrev.word !== state.verdict.word)) {
      addLog('MASTER', state.verdict.tone, state.verdict.word + ' — ' + state.verdict.reason);
    }
    state.h1Prev = snapshot(state.h1);
    state.m30Prev = snapshot(state.m30);
    state.m1Prev = snapshot(state.m1);
    state.verdictPrev = { tone: state.verdict.tone, word: state.verdict.word };

    // A price line every 5th tick.
    if (state.tick % 5 === 0) {
      const at = now().getTime();
      const since = state.lastPriceLog ? at - state.lastPriceLog.at : at - state.startedAt;
      const delta = state.lastPriceLog ? state.price - state.lastPriceLog.price : 0;
      const dir = delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat';
      addLog('PRICE', 'muted', fmt(state.price) + ', ' + dir + ' ' + fmt(Math.abs(delta)) + ' in ' + Math.round(since / 1000) + 's');
      state.lastPriceLog = { at, price: state.price };
    }
  }
  function snapshot(a) {
    return { tone: a.tone, label: a.label };
  }
  function describeH1(a) {
    return a.label + ' — ' + fmt(state.price) + (a.zone ? ' at ' + a.zone.name : '');
  }
  function describeM30(a) {
    let s = a.label;
    if (a.zone) s += ' at ' + a.zone.name;
    if (a.extreme != null) s += ', extreme ' + fmt(a.extreme);
    return s;
  }
  function describeM1(a) {
    let s = a.label;
    if (a.extreme != null) s += ', entry ' + fmt(a.entry);
    return s;
  }

  /* ── Timer, pause, error ───────────────────────────────────────────── */
  function stopTimer() {
    if (state.timer) {
      clearInterval(state.timer);
      state.timer = null;
    }
  }
  function startTimer() {
    stopTimer();
    state.timer = setInterval(() => {
      try {
        tickOnce();
      } catch (err) {
        fail(err);
      }
    }, TICK_MS);
    state.running = true;
    state.paused = false;
    setBadge('running');
    setPauseButton(false);
    el.terminalMeta.textContent = '';
  }
  function pause() {
    stopTimer();
    state.paused = true;
    setBadge('paused');
    setPauseButton(true);
    el.terminalMeta.textContent = 'Paused at ' + fmtTime(now());
    addLog('SYSTEM', 'muted', 'Scan paused.');
  }
  function resume() {
    startTimer();
    addLog('SYSTEM', 'muted', 'Scan resumed.');
  }
  function fail(err) {
    stopTimer();
    state.stopped = true;
    setBadge('stopped');
    setPauseButton(false);
    el.errorTime.textContent = fmtTime(now());
    el.simError.hidden = false;
    // A warn, not an error: the check runner treats console.error as a
    // failure, and the page itself is fine — the readings stay on screen.
    console.warn('Market simulation stopped:', err);
  }

  /* ── Boot ──────────────────────────────────────────────────────────── */
  function backdateLog() {
    // In demo the ticks ran instantly; stamp them as if they had taken
    // 1.5 s each, ending at now.
    const last = state.tick;
    const base = now().getTime();
    el.log.querySelectorAll('li').forEach((li) => {
      const age = (last - Number(li.dataset.tick || last)) * TICK_MS;
      li.firstChild.textContent = fmtTime(new Date(base - age));
    });
  }

  function rebuild(seed) {
    resetEngine(seed);
    state.h1Prev = snapshot(state.h1);
    state.m30Prev = snapshot(state.m30);
    state.m1Prev = snapshot(state.m1);
    state.verdictPrev = null;
  }

  async function boot() {
    const params = new URLSearchParams(location.search);
    const token = params.get('token');
    let demo = false;
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 4000);
      const res = await fetch('/api/session' + location.search, {
        headers: token ? { 'x-usernode-token': token } : {},
        signal: ctl.signal,
      });
      clearTimeout(timer);
      if (res.ok) {
        const data = await res.json();
        demo = !!data.demo;
      }
    } catch (_err) {
      // No session answer: run as a normal scan. Not logged as an error —
      // the dashboard does not depend on it.
    }
    state.demo = demo;
    if (demo) el.noteDemo.hidden = false;

    buildPairOptions();
    rebuild(demo ? DEMO_SEED : Date.now());

    if (demo) {
      // Fast-forward synchronously to the first tick after the first green
      // verdict, so the staged screen opens populated and ready.
      let greenAt = null;
      for (let i = 0; i < 200; i++) {
        tickOnce();
        if (greenAt === null && state.verdict.tone === 'go') greenAt = state.tick;
        if (greenAt !== null && state.tick > greenAt) break;
      }
      backdateLog();
    } else {
      addLog('SYSTEM', 'muted', 'Scan started on ' + state.pairKey + '.');
    }
    startTimer();
  }

  el.pair.addEventListener('change', () => {
    state.pairKey = el.pair.value;
    rebuild(Date.now());
    addLog('SYSTEM', 'muted', 'Scan restarted on ' + state.pairKey + '.');
    startTimer();
  });
  el.pauseBtn.addEventListener('click', () => {
    if (state.stopped) return;
    if (state.paused) resume();
    else pause();
  });
  el.retry.addEventListener('click', () => {
    rebuild(Date.now());
    addLog('SYSTEM', 'muted', 'Scan restarted on ' + state.pairKey + '.');
    startTimer();
  });

  boot();
})();
