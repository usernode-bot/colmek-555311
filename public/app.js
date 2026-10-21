/* AI Agent Trading SNR — the scan engine.
 *
 * The dashboard runs here in the browser. In a live scan the price is the
 * real market quote from the server feed (/api/xau, sampling gold-api.com) —
 * the same feed the Live XAUUSD card draws. The three agents and the master
 * verdict read that live price. It reads prices, it never places, sends or
 * executes a trade. The staged demo (?demo=1) keeps a fully scripted
 * simulation.
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
        { name: 'H4 support', tf: 'H4', kind: 'support', low: 4100.0, high: 4105.0 },
        { name: 'H1 support', tf: 'H1', kind: 'support', low: 4128.0, high: 4133.0 },
        { name: 'H1 resistance', tf: 'H1', kind: 'resistance', low: 4177.0, high: 4182.0 },
        { name: 'H4 resistance', tf: 'H4', kind: 'resistance', low: 4195.0, high: 4200.0 },
      ],
      // The scripted path (staged demo only): price eases toward each leg's
      // target, plus noise
      // of up to ±0.35 per tick. One loop sets up a buy at support; the next
      // mirrors it as a sell at resistance, then breaks below support, so
      // all three verdicts and both directions appear within about four
      // minutes. Each loop ends where the next begins.
      legs: [
        [
          { to: 4131.4, ticks: 12 }, // drifts down into H1 support
          { to: 4126.4, ticks: 4 }, // sweeps 1.60 below the far edge
          { to: 4134.0, ticks: 4 }, // the V back inside — green buy setup
          { to: 4134.6, ticks: 8 }, // holds just above the zone
          { to: 4155.0, ticks: 8 }, // leaves the zone
          { to: 4179.8, ticks: 12 }, // climbs into H1 resistance
          { to: 4185.7, ticks: 5 }, // breaks out 3.70 above — red
          { to: 4156.0, ticks: 10 }, // falls back mid-range
        ],
        [
          { to: 4179.8, ticks: 12 }, // climbs into H1 resistance
          { to: 4183.4, ticks: 4 }, // sweeps 1.40 above the far edge
          { to: 4175.8, ticks: 4 }, // the V back down — green sell setup
          { to: 4175.2, ticks: 8 }, // holds just below the zone
          { to: 4155.0, ticks: 8 }, // leaves the zone
          { to: 4131.4, ticks: 12 }, // falls into H1 support
          { to: 4122.5, ticks: 5 }, // breaks down 5.50 below — red
          { to: 4154.0, ticks: 10 }, // recovers mid-range
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
  // Whole literals: Tailwind purges @layer components whose class name never
  // appears in the scanned files, so the lamp classes must be written out.
  const LAMP = { go: 'lamp lamp-go', wait: 'lamp lamp-wait', stop: 'lamp lamp-stop' };
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
    noteBody: $('[data-note-body]'),
    terminalMeta: $('[data-terminal-meta]'),
    simError: $('[data-sim-error]'),
    errorTime: $('[data-error-time]'),
    retry: $('[data-retry]'),
    terminalBody: $('[data-terminal-body]'),
    lamps: {},
    verdict: $('[data-verdict]'),
    confidence: $('[data-confidence]'),
    levels: {
      entry: $('[data-level-entry]'),
      stop: $('[data-level-stop]'),
      target: $('[data-level-target]'),
    },
    reason: $('[data-reason]'),
    price: $('[data-price]'),
    priceNote: $('[data-price-note]'),
    votes: {},
    agents: {},
    log: $('[data-log]'),
    live: {},
  };
  [
    'priceline', 'updated', 'price', 'change', 'paused', 'svg', 'line', 'dot',
    'axis', 'start', 'range', 'end', 'collecting', 'source', 'loading', 'error',
    'error-reason', 'retry',
  ].forEach((k) => {
    // Dash keys bind under their camelCase name ('error-reason' becomes
    // el.live.errorReason), so the render code never reads a dashed key.
    const name = k.replace(/-([a-z])/g, (_m, c) => c.toUpperCase());
    el.live[name] = $('[data-live-' + k + ']');
  });
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
  el.agents.m1.sparkArea = $('[data-spark-area]');
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
    state.m30 = { tone: 'idle', label: 'No level', zone: null, extreme: null, beyond: 0 };
    state.m1 = { tone: 'idle', label: 'Waiting', zone: null, extreme: null, entry: null, recovery: 0 };
    state.map = { trend: 'Mapping', support: null, resistance: null };
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
    el.confidence.textContent = '';
    el.levels.entry.textContent = '—';
    el.levels.stop.textContent = '—';
    el.levels.target.textContent = '—';
    el.reason.textContent = 'Reading the market';
    el.price.textContent = '—';
    el.priceNote.textContent = '';
    ['h1', 'm30', 'm1'].forEach((a) => {
      renderVote(a, state[a]);
      renderChip(a, state[a]);
    });
    renderLadder();
    renderFacts(el.agents.h1.facts, []);
    el.agents.m30.sentence.textContent = 'Reading the live feed for trendlines and levels.';
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
    if (state.demo) {
      // Staged demo: the fully scripted path, untouched.
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
    } else {
      // Live scan: the tick's price is the latest real quote from the same
      // server feed the Live XAUUSD card uses (/api/xau, gold-api.com).
      // A tick with no feed data yet, or no new price since the last one,
      // is a no-op: the agents only re-read when the market moved, and the
      // 1.5 s timer keeps the ACTIVE badge and pause/resume honest between
      // the feed's 10 s samples.
      const pts = live.points;
      const p = pts.length ? pts[pts.length - 1].p : null;
      if (p == null || p === state.price) return;
      if (state.price == null) addLog('SYSTEM', 'muted', 'Live price connected: ' + fmt(p) + '.');
      state.price = p;
      state.history.push(p);
      if (state.history.length > 120) state.history.shift();
      state.tick += 1;
    }

    state.h1 = evalH1(state.price, state.h1);
    state.m30 = evalM30(state.price, state.h1);
    // Agent 2's map, read once per tick: Agent 3's scalp areas and the
    // card's trend rows must come off the same reading.
    state.map = mapSNR();
    state.m1 = evalM1(state.price, state.m30, state.map);
    state.verdict = evalMaster(state.h1, state.m30, state.m1);

    renderTerminal();
    ['h1', 'm30', 'm1'].forEach((a) => {
      renderVote(a, state[a]);
      renderChip(a, state[a]);
    });
    renderLadder();
    renderH1Facts();
    renderM30();
    renderM1Facts();
    drawSpark();
    writeTickLogs();
    // In the staged demo the live card is drawn from the simulation, on
    // every tick, so the visual test stays deterministic.
    if (state.demo) renderLive(demoPoints(), { demo: true });
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

  /* ── Agent 2: Trendline & SNR Mapper ─────────────────────────────────
   * Reads the same price history the live feed fills: swing highs and
   * swing lows fit two trendlines whose slopes give the trend direction,
   * and clustered swings become the mapped support/resistance levels.
   * While Agent 1 sits at a zone, the mapper tracks the test of that
   * level (the episode below): the pierce extreme and the return inside
   * are what Agent 3 times its V-shape on. */
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
        return { tone: 'go', label: 'Level held', zone: z, extreme: ep.extreme, beyond: ep.extremeBeyond };
      }
      return { tone: 'wait', label: 'Testing level', zone: z, extreme: ep.extreme, beyond: ep.extremeBeyond };
    }
    state.episode = null; // leaving the level resets the test, and agent 3
    if (h1.label === 'Zone broken') {
      return { tone: 'stop', label: 'Level broken', zone: h1.zone, extreme: null, beyond: h1.beyond };
    }
    return { tone: 'idle', label: 'No level', zone: null, extreme: null, beyond: 0 };
  }

  /* The mapper's map, drawn from the same history: how the trend is read
   * and where the nearest mapped levels sit around the current price. */
  const SWING_K = 2;       // neighbours each side a pivot must dominate
  const SWING_PROM = 0.6;  // how far a pivot must stand clear of them
  const LEVEL_TOL = 1.5;   // swings within this of each other share a level

  function findSwings(history) {
    // Fractal pivots: a high the k neighbours on both sides stay below
    // (and stand clear of by the prominence), mirrored for lows.
    const highs = [];
    const lows = [];
    for (let i = SWING_K; i < history.length - SWING_K; i++) {
      let clearHigh = true;
      let clearLow = true;
      let aroundHigh = -Infinity;
      let aroundLow = Infinity;
      for (let j = i - SWING_K; j <= i + SWING_K; j++) {
        if (j === i) continue;
        if (history[j] >= history[i]) clearHigh = false;
        if (history[j] <= history[i]) clearLow = false;
        if (history[j] > aroundHigh) aroundHigh = history[j];
        if (history[j] < aroundLow) aroundLow = history[j];
      }
      if (clearHigh && history[i] - aroundHigh >= SWING_PROM) highs.push({ i: i, p: history[i] });
      if (clearLow && aroundLow - history[i] >= SWING_PROM) lows.push({ i: i, p: history[i] });
    }
    return { highs: highs, lows: lows };
  }

  function clusterLevels(points, tol) {
    // Swings close in price merge into one mapped level (their average).
    const sorted = points.slice().sort(function (a, b) { return a.p - b.p; });
    const groups = [];
    let group = null;
    sorted.forEach(function (pt) {
      if (group && pt.p - group.anchor <= tol) group.pts.push(pt);
      else { group = { anchor: pt.p, pts: [pt] }; groups.push(group); }
    });
    return groups.map(function (g) {
      return {
        level: g.pts.reduce(function (s, p) { return s + p.p; }, 0) / g.pts.length,
      };
    });
  }

  function trendFromFit(history) {
    // Interim trend while the swings are still forming: a least-squares
    // line through the most recent prices (the last 30 at most) read by
    // its slope.
    const recent = history.slice(-30);
    const n = recent.length;
    if (n < 2) return 'Mapping';
    const ym = recent.reduce(function (s, p) { return s + p; }, 0) / n;
    let num = 0;
    let den = 0;
    recent.forEach(function (p, i) {
      num += (i - (n - 1) / 2) * (p - ym);
      den += (i - (n - 1) / 2) * (i - (n - 1) / 2);
    });
    const slope = num / den;
    if (slope > 0.05) return 'Uptrend';
    if (slope < -0.05) return 'Downtrend';
    return 'Range';
  }

  function bootstrapLevels(price) {
    // The interim map before the history holds swings: the static SNR
    // zones from the config (Agent 1's H4/H1 support and resistance)
    // stand in as the mapped levels. Every zone edge is a candidate, so
    // a zone price has crossed flips roles on its own: its edges below
    // price act as support, above as resistance.
    let support = null;
    let resistance = null;
    state.pair.zones.forEach(function (z) {
      [z.low, z.high].forEach(function (level) {
        if (level <= price && (!support || level > support.level)) {
          support = { level: level, dist: price - level };
        }
        if (level >= price && (!resistance || level < resistance.level)) {
          resistance = { level: level, dist: level - price };
        }
      });
    });
    return { support: support, resistance: resistance };
  }

  function mapSNR() {
    const history = state.history;
    const out = { trend: 'Mapping', support: null, resistance: null };
    if (state.price == null) return out;
    if (history.length < 8) {
      // Too little history for swings: the map bootstraps from the static
      // zones, with the trend read off a straight fit through what is here.
      out.trend = trendFromFit(history);
      const boot = bootstrapLevels(state.price);
      out.support = boot.support;
      out.resistance = boot.resistance;
      return out;
    }
    const swings = findSwings(history);
    // Two trendlines: one through the recent swing highs, one through the
    // recent swing lows. Both rising is an uptrend, both falling a
    // downtrend, anything else a range. Not enough swings yet: the same
    // straight fit through the recent prices stands in.
    let trend;
    if (swings.highs.length >= 2 && swings.lows.length >= 2) {
      const prevHigh = swings.highs[swings.highs.length - 2];
      const lastHigh = swings.highs[swings.highs.length - 1];
      const prevLow = swings.lows[swings.lows.length - 2];
      const lastLow = swings.lows[swings.lows.length - 1];
      const resSlope = (lastHigh.p - prevHigh.p) / (lastHigh.i - prevHigh.i);
      const supSlope = (lastLow.p - prevLow.p) / (lastLow.i - prevLow.i);
      if (resSlope > 0 && supSlope > 0) trend = 'Uptrend';
      else if (resSlope < 0 && supSlope < 0) trend = 'Downtrend';
      else trend = 'Range';
    } else {
      trend = trendFromFit(history);
    }
    out.trend = trend;
    // Clustered swings are the mapped levels. A level flips roles once
    // price crosses it: a swing-high cluster below price now acts as
    // support, a swing-low cluster above it as resistance.
    const levels = clusterLevels(swings.lows, LEVEL_TOL).concat(clusterLevels(swings.highs, LEVEL_TOL));
    levels.forEach(function (lv) {
      if (lv.level <= state.price && (!out.support || lv.level > out.support.level)) {
        out.support = { level: lv.level, dist: state.price - lv.level };
      }
      if (lv.level >= state.price && (!out.resistance || lv.level < out.resistance.level)) {
        out.resistance = { level: lv.level, dist: lv.level - state.price };
      }
    });
    // Any side the swings have not mapped yet keeps its bootstrap level
    // from the static zones until enough swings cluster there.
    const boot = bootstrapLevels(state.price);
    if (!out.support) out.support = boot.support;
    if (!out.resistance) out.resistance = boot.resistance;
    return out;
  }

  /* ── Agent 3: M5 Zero Floating Trigger ───────────────────────────────
   * The trigger itself is unchanged: during a level test it watches the
   * wick and times the V-shape. What is new is what it does while it
   * would otherwise only wait: off Agent 2's mapped SNR levels and trend
   * it marks a thin scalping area at the trend's level — a small buffer
   * band off the level's edge, never the level itself — a buy above the
   * nearest support in an uptrend, a sell below the nearest resistance
   * in a downtrend, nothing in a range. The stop and target distances
   * scale off the distance to that level, clamped to scalping size.
   * Analysis only: nothing here places or executes a trade. */
  const SCALP_BUF = 0.3;                                    // the band starts this far off the level's edge
  const SCALP_BAND = { share: 0.25, min: 0.4, max: 1.2 };   // band height, off the SNR distance
  const SCALP_STOP = { share: 0.3, min: 0.5, max: 2.0 };    // stop distance, off the SNR distance
  const SCALP_TARGET = { share: 0.6, min: 1.0, max: 3.0 };  // target distance, off the SNR distance

  function scalpSize(dist, size) {
    return Math.min(size.max, Math.max(size.min, dist * size.share));
  }

  function buildScalp(lv, dir) {
    const band = scalpSize(lv.dist, SCALP_BAND);
    const stopDist = scalpSize(lv.dist, SCALP_STOP);
    const targetDist = scalpSize(lv.dist, SCALP_TARGET);
    const low = dir === 'Buy' ? lv.level + SCALP_BUF : lv.level - SCALP_BUF - band;
    const high = dir === 'Buy' ? lv.level + SCALP_BUF + band : lv.level - SCALP_BUF;
    const entry = (low + high) / 2; // mid-area: where a limit resting in the band sits
    return {
      dir: dir,
      areaLow: low,
      areaHigh: high,
      entry: entry,
      stop: dir === 'Buy' ? lv.level - stopDist : lv.level + stopDist,
      target: dir === 'Buy' ? entry + targetDist : entry - targetDist,
    };
  }

  function scalpArea(map) {
    if (map.trend === 'Uptrend' && map.support) return buildScalp(map.support, 'Buy');
    if (map.trend === 'Downtrend' && map.resistance) return buildScalp(map.resistance, 'Sell');
    return null; // a range, or no mapped level on the trend's side: nothing to mark
  }

  function evalM1(price, m30, map) {
    if (m30.tone !== 'go' || !state.episode) {
      // No level under test: instead of only waiting, mark the trend's
      // thin scalping area off the mapped SNR level, if there is one.
      const scalp = scalpArea(map);
      if (scalp) {
        return {
          tone: 'wait',
          label: scalp.dir === 'Buy' ? 'Thin buy area' : 'Thin sell area',
          zone: null, extreme: null, entry: scalp.entry, recovery: 0, scalp: scalp,
        };
      }
      return { tone: 'idle', label: 'Waiting', zone: null, extreme: null, entry: null, recovery: 0 };
    }
    const z = state.episode.zone;
    const buy = z.kind === 'support';
    const extreme = state.episode.extreme;
    const recovery = buy ? price - extreme : extreme - price;
    const entry = buy ? extreme + 0.2 : extreme - 0.2;
    const sinceExtreme = state.tick - state.episode.extremeTick;
    if (recovery >= 2.0 && sinceExtreme <= 6) {
      return { tone: 'go', label: 'V-shape', zone: z, extreme, entry, recovery, since: sinceExtreme };
    }
    return { tone: 'wait', label: 'Watching wick', zone: z, extreme, entry, recovery, since: sinceExtreme };
  }

  /* ── Master decision ───────────────────────────────────────────────── */
  /* Confidence and levels. Each agent's own score reads what it saw: how
   * far a sweep went, how quickly price came back, or how close the level
   * is. The master's score adds the agents' agreement to the sweep and
   * the recovery, and never claims more than 95%. The levels reuse Agent
   * 3's entry and the app's scalping distances. */
  function clamp01(x) {
    return Math.min(1, Math.max(0, x));
  }
  function depthScore(m30) {
    // 0 at a 0.50 sweep through the far edge, 1 at 3.00.
    if (!m30.zone) return 0;
    return clamp01((m30.beyond - 0.5) / 2.5);
  }
  function speedScore(m1) {
    // Recovery per tick since the wick: 0 at 0.33 a tick, 1 at 3.00.
    if (m1.since === undefined) return 0;
    return clamp01((m1.recovery / Math.max(1, m1.since) - 0.33) / 2.67);
  }
  function confH1(a) {
    if (a.tone === 'go') return 100 - Math.round((a.beyond / 3) * 40);
    if (a.tone === 'wait') return Math.round(40 * (1 - a.near / 1.5));
    return 0;
  }
  function confM30(m) {
    if (m.tone === 'idle') return null;
    if (m.tone === 'stop') return 0;
    if (m.tone === 'go') return 60 + Math.round(depthScore(m) * 40);
    return Math.round(depthScore(m) * 40);
  }
  function confM1(m) {
    if (m.tone === 'idle') return null;
    if (m.tone === 'go') return 60 + Math.round(speedScore(m) * 40);
    if (m.scalp) return 30; // the thin area rests on the trend alone
    return Math.round((Math.min(Math.max(m.recovery, 0), 2) / 2) * 40);
  }
  function targetFor(kind, entry, stop) {
    // The next zone of the opposite kind on the ladder, or the scalping
    // target distance when the map has none that side.
    let target = null;
    state.pair.zones.forEach((z) => {
      if (kind === 'support' && z.kind === 'resistance' && z.low > entry) {
        if (target === null || z.low < target) target = z.low;
      } else if (kind === 'resistance' && z.kind === 'support' && z.high < entry) {
        if (target === null || z.high > target) target = z.high;
      }
    });
    if (target !== null) return target;
    const dist = scalpSize(Math.abs(entry - stop), SCALP_TARGET);
    return kind === 'support' ? entry + dist : entry - dist;
  }
  function evalMaster(h1, m30, m1) {
    const goCount = [h1, m30, m1].filter((a) => a.tone === 'go').length;
    const confidence = Math.min(
      95,
      20 * goCount +
        Math.round(depthScore(m30) * 15) +
        (m1.tone === 'go' ? Math.round(speedScore(m1) * 20) : 0)
    );
    if (h1.tone === 'go' && m30.tone === 'go' && m1.tone === 'go') {
      const z = h1.zone;
      const dir = z.kind === 'support' ? 'Buy' : 'Sell';
      const entry = m1.entry;
      const stop = z.kind === 'support'
        ? Math.min(z.low, m1.extreme) - SCALP_BUF
        : Math.max(z.high, m1.extreme) + SCALP_BUF;
      return {
        tone: 'go',
        word: 'Ready to Execute',
        reason: dir + ' setup at ' + z.name + ' ' + fmt(z.low) + ' – ' + fmt(z.high),
        confidence,
        entry,
        stop,
        target: targetFor(z.kind, entry, stop),
      };
    }
    if (h1.tone === 'stop' || m30.tone === 'stop') {
      let reason;
      if (m30.tone === 'stop') reason = 'Level broken, ' + fmt(m30.beyond) + ' beyond ' + m30.zone.name;
      else if (h1.label === 'Zone broken') reason = 'H1 zone broken, no valid setup';
      else reason = 'Price mid-range, no valid zone';
      return { tone: 'stop', word: 'Invalid Zone', reason, confidence: 0, entry: null, stop: null, target: null };
    }
    let reason;
    if (h1.tone !== 'go') reason = 'Near ' + h1.zone.name + ', no setup yet';
    else if (m30.tone === 'wait') reason = 'At ' + h1.zone.name + ', watching the level test';
    else reason = 'Level held, waiting for the M5 V-shape';
    return { tone: 'wait', word: 'Standby', reason, confidence, entry: null, stop: null, target: null };
  }

  /* ── Rendering ─────────────────────────────────────────────────────── */
  function setBadge(kind) {
    const b = BADGE[kind];
    el.status.textContent = b.text;
    el.status.className = PILL[b.tone];
  }
  function setPauseButton(paused) {
    // toggleAttribute, not `.hidden =`: the hidden IDL property exists on
    // HTMLElement only, so on these SVGs it sets a JS expando and the CSS
    // `[hidden]` rule never fires.
    el.pauseIcon.toggleAttribute('hidden', paused);
    el.resumeIcon.toggleAttribute('hidden', !paused);
    el.pauseLabel.textContent = paused ? 'Resume scan' : 'Pause scan';
  }
  function renderVote(agent, a) {
    const v = el.votes[agent];
    // One icon shows with the status: check for go, clock for wait (muted
    // while the agent is idle), cross for stop.
    const shown = a.tone === 'idle' ? 'wait' : a.tone;
    const shownClass = TONE_TEXT[a.tone];
    ['go', 'wait', 'stop'].forEach((t) => {
      const icon = v.icons[t];
      icon.toggleAttribute('hidden', t !== shown); // see setPauseButton on .hidden
      icon.setAttribute('class', t === shown ? shownClass : '');
    });
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
      // Bottom green, middle yellow, top red; the unlit two stay in the line colour.
      el.lamps[t].className = state.verdict && state.verdict.tone === t ? LAMP[t] : 'lamp';
    });
    el.verdict.textContent = state.verdict.word;
    el.verdict.className = 'text-title ' + TONE_TEXT[state.verdict.tone];
    el.confidence.textContent = state.verdict.confidence + '% confidence';
    el.confidence.className = 'text-small font-semibold ' + TONE_TEXT[state.verdict.tone];
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
    el.levels.entry.textContent = state.verdict.entry == null ? '—' : fmt(state.verdict.entry);
    el.levels.stop.textContent = state.verdict.stop == null ? '—' : fmt(state.verdict.stop);
    el.levels.target.textContent = state.verdict.target == null ? '—' : fmt(state.verdict.target);
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
  function pct(n) {
    return n == null ? '—' : n + '%';
  }
  function renderH1Facts() {
    renderFacts(el.agents.h1.facts, [['Confidence', pct(confH1(state.h1))]]);
  }
  function renderM30() {
    const m = state.m30;
    const map = state.map || mapSNR(); // the map tickOnce read, so the card and Agent 3 agree
    let sentence;
    const rows = [];
    if (m.zone) {
      rows.push(['Tested level', m.zone.name + ' ' + fmt(m.zone.low) + ' – ' + fmt(m.zone.high)]);
      if (m.extreme != null) rows.push([m.zone.kind === 'support' ? 'Wick low' : 'Wick high', fmt(m.extreme)]);
    }
    if (m.tone === 'go') {
      sentence = (m.zone.kind === 'support' ? 'Support' : 'Resistance') + ' held at ' + m.zone.name + ', price is back inside.';
    } else if (m.tone === 'wait') {
      sentence = m.beyond > 0
        ? 'Pierced ' + fmt(edge(m.zone)) + ', waiting for the return inside.'
        : 'Watching ' + fmt(m.zone.kind === 'support' ? m.zone.high : m.zone.low) + ' at ' + m.zone.name + '.';
    } else if (m.tone === 'stop') {
      sentence = 'Price is ' + fmt(m.beyond) + ' beyond ' + m.zone.name + ', the level broke.';
    } else {
      sentence = 'No level under test. The map updates from the live feed.';
    }
    rows.push(['Trend', map.trend]);
    rows.push(['Nearest support', map.support ? fmt(map.support.level) + ' · ' + fmt(map.support.dist) + ' away' : '—']);
    rows.push(['Nearest resistance', map.resistance ? fmt(map.resistance.level) + ' · ' + fmt(map.resistance.dist) + ' away' : '—']);
    rows.push(['Confidence', pct(confM30(m))]);
    el.agents.m30.sentence.textContent = sentence;
    renderFacts(el.agents.m30.facts, rows);
  }
  function renderM1Facts() {
    const m = state.m1;
    const rows = [];
    if (m.scalp) {
      // The thin scalping area, marked while no level is under test.
      rows.push(['Area', fmt(m.scalp.areaLow) + ' – ' + fmt(m.scalp.areaHigh)]);
      rows.push(['Direction', m.scalp.dir]);
      rows.push(['Entry', fmt(m.scalp.entry)]);
      rows.push(['Stop', fmt(m.scalp.stop)]);
      rows.push(['Target', fmt(m.scalp.target)]);
    }
    if (m.tone !== 'idle' && m.extreme != null && m.zone) {
      // The level test the trigger is timing (the rows above never coexist
      // with these: the area is marked only outside a test).
      const z = m.zone;
      const wick = Math.max(0, Math.round(beyondFar(z, m.extreme) - 0.68));
      rows.push(['Wick', fmt(wick)]);
      rows.push(['Entry', fmt(m.entry)]);
      rows.push(['Recovery', fmt(m.recovery)]);
    }
    rows.push(['Confidence', pct(confM1(m))]);
    renderFacts(el.agents.m1.facts, rows);
  }
  function drawSpark() {
    const svg = el.agents.m1;
    const pts = state.history.slice(-30);
    if (pts.length < 2) {
      svg.sparkLine.setAttribute('points', '');
      svg.sparkDot.setAttribute('visibility', 'hidden');
      svg.sparkZone.setAttribute('height', '0');
      svg.sparkArea.setAttribute('height', '0');
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
    // The thin scalping area, as its own band. It is NOT folded into the
    // scale: it can sit far from the last 30 prices, and stretching the
    // line to fit it would flatten the price. A band outside the chart
    // clamps to its edge; one entirely outside draws nothing.
    const scalp = state.m1 && state.m1.scalp;
    if (scalp) {
      const aTop = Math.min(y(scalp.areaHigh), y(scalp.areaLow));
      const aBot = Math.max(y(scalp.areaHigh), y(scalp.areaLow));
      const cTop = Math.max(2, Math.min(H - 2, aTop));
      const cBot = Math.max(2, Math.min(H - 2, aBot));
      if (cBot - cTop >= 1) {
        svg.sparkArea.setAttribute('y', cTop.toFixed(1));
        svg.sparkArea.setAttribute('height', (cBot - cTop).toFixed(1));
        svg.sparkArea.setAttribute('fill', scalp.dir === 'Buy' ? 'rgb(var(--go) / 0.15)' : 'rgb(var(--stop) / 0.15)');
      } else {
        svg.sparkArea.setAttribute('height', '0');
      }
    } else {
      svg.sparkArea.setAttribute('height', '0');
    }
  }

  /* ── Live XAUUSD chart ────────────────────────────────────────────────
   * The real gold price, sampled by the server every 10 s and drawn as a
   * bigger Agent 3 spark. In a live scan its latest quote IS the market:
   * tickOnce reads it into state.price, so the agents and the master
   * verdict price off the same feed the card draws. The staged demo draws
   * this card from the simulation instead. */
  const live = { hadData: false, points: [], failing: false, timer: null };
  let liveToken = null;
  // The tick self-reschedules: 10 s when the feed is healthy, a short
  // backoff (1 s, 2 s, 4 s) while it is down, so a blip is ridden out
  // before the card gives up and shows its Retry button.
  const LIVE_TICK_MS = 10_000;
  const LIVE_RETRY_DELAYS = [1000, 2000, 4000];
  let liveBusy = false; // one fetch at a time
  let liveRetryIdx = 0; // next automatic retry's delay
  let liveRetryQueued = false; // someone hit Retry while a fetch was in flight

  function demoPoints() {
    // The staged demo draws the card from the simulation: the last 40 tick
    // prices, spaced 1.5 s apart and ending now.
    const pts = state.history.slice(-40);
    const base = now().getTime();
    return pts.map((p, i) => ({
      t: new Date(base - (pts.length - 1 - i) * TICK_MS).toISOString(),
      p,
    }));
  }

  function renderLive(points, opts) {
    opts = opts || {};
    // Whatever the outcome, the fetch is over: the Retry button reads
    // "Checking…" while one is in flight and is back to "Retry" here.
    setLiveRetryBusy(false);
    if (!points || points.length === 0) {
      // No data ever arrived: the error state is the whole card body.
      el.live.loading.hidden = true;
      el.live.priceline.hidden = true;
      el.live.paused.hidden = true;
      // toggleAttribute, not `.hidden =`: the hidden IDL property exists on
      // HTMLElement only, so on this SVG it would set a JS expando and the
      // CSS `[hidden]` rule never fires (see setPauseButton).
      el.live.svg.toggleAttribute('hidden', true);
      el.live.axis.hidden = true;
      el.live.collecting.hidden = true;
      el.live.source.hidden = true;
      // Why the feed has nothing to show ("gold-api.com: HTTP 403; …"),
      // from the server's sampler via /api/xau, so an outage is
      // diagnosable from the card instead of only in the server log.
      el.live.errorReason.textContent = opts.reason || '';
      el.live.error.hidden = false;
      return;
    }
    el.live.error.hidden = true;
    el.live.source.hidden = false;
    el.live.source.textContent = opts.demo
      ? 'Staging demo: simulated prices, not the live market.'
      : 'Source: gold-api.com, refreshed every 10 seconds';
    el.live.loading.hidden = true;
    el.live.priceline.hidden = false;
    el.live.svg.toggleAttribute('hidden', false);
    el.live.axis.hidden = false;
    const last = points[points.length - 1];
    const first = points[0];
    el.live.price.textContent = fmt(last.p);
    el.live.updated.textContent = 'Updated ' + fmtTime(new Date(last.t));
    if (points.length >= 2) {
      const change = last.p - first.p;
      el.live.change.textContent = (change < 0 ? '−' : '+') + fmt(Math.abs(change)) + ' in the last hour';
    } else {
      el.live.change.textContent = 'Collecting prices';
    }
    // Grey, not green or red: green and red already mean the agents'
    // verdicts on this screen.
    el.live.paused.textContent = 'Live feed paused. Last price from ' + fmtTime(new Date(last.t)) + '.';
    el.live.paused.hidden = !opts.stale;
    el.live.collecting.hidden = points.length >= 2;

    let min = Infinity;
    let max = -Infinity;
    points.forEach((pt) => {
      if (pt.p < min) min = pt.p;
      if (pt.p > max) max = pt.p;
    });
    const low = min;
    const high = max;
    const pad = (max - min) * 0.1 || 1; // flat hour: the line sits mid-chart
    min -= pad;
    max += pad;
    const H = 160;
    const y = (p) => H - 4 - ((p - min) / (max - min)) * (H - 8);
    const n = points.length;
    if (n >= 2) {
      const coords = points.map((pt, i) => ((i / (n - 1)) * 998 + 1).toFixed(1) + ',' + y(pt.p).toFixed(1));
      el.live.line.setAttribute('points', coords.join(' '));
      const lastPt = coords[n - 1].split(',');
      el.live.dot.setAttribute('cx', lastPt[0]);
      el.live.dot.setAttribute('cy', lastPt[1]);
    } else {
      el.live.line.setAttribute('points', '');
      el.live.dot.setAttribute('cx', '999');
      el.live.dot.setAttribute('cy', y(last.p).toFixed(1));
    }
    el.live.dot.setAttribute('visibility', 'visible');
    el.live.start.textContent = hhmm(new Date(first.t));
    el.live.end.textContent = hhmm(new Date(last.t));
    el.live.range.textContent = 'Low ' + fmt(low) + ' · High ' + fmt(high);
  }

  function hhmm(d) {
    return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });
  }

  // The card's checking state: the same skeletons the page boots with, so a
  // retry reads as "working on it" instead of a button that does nothing.
  function renderLiveChecking() {
    el.live.error.hidden = true;
    el.live.priceline.hidden = true;
    el.live.svg.toggleAttribute('hidden', true);
    el.live.axis.hidden = true;
    el.live.collecting.hidden = true;
    el.live.source.hidden = true;
    el.live.updated.textContent = '';
    el.live.loading.hidden = false;
  }

  function setLiveRetryBusy(busy) {
    el.live.retry.disabled = busy;
    el.live.retry.textContent = busy ? 'Checking…' : 'Retry';
  }

  // The single scheduler for feed fetches: a self-rescheduling timeout, so
  // the healthy 10 s cadence and the retry backoff can never pile up.
  function scheduleLiveTick(delay) {
    clearTimeout(live.timer);
    live.timer = setTimeout(loadLive, delay);
  }

  async function loadLive() {
    if (liveBusy) return;
    liveBusy = true;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 6000);
    let data = null;
    try {
      const res = await fetch('/api/xau', {
        headers: liveToken ? { 'x-usernode-token': liveToken } : {},
        signal: ctl.signal,
      });
      if (res.ok) data = await res.json();
    } catch (_err) {
      // Timed out or unreachable: handled below, warned once.
    }
    clearTimeout(timer);
    liveBusy = false;
    if (liveRetryQueued) {
      // A Retry click arrived while this fetch was in flight: run it now,
      // so the retry chain can never be left unscheduled.
      liveRetryQueued = false;
      scheduleLiveTick(0);
      return;
    }
    if (data && data.ok && Array.isArray(data.points) && data.points.length > 0) {
      if (live.failing) {
        live.failing = false;
        console.warn('Live XAUUSD feed recovered.');
      }
      live.hadData = true;
      live.points = data.points;
      liveRetryIdx = 0;
      renderLive(live.points, { stale: !!data.stale });
      scheduleLiveTick(LIVE_TICK_MS);
      return;
    }
    // The feed is down. Prices were on screen before? Keep the last chart
    // and say the feed is paused, rather than dropping the card to an
    // error: that last good price is the display fallback until a source
    // answers again.
    if (live.hadData) {
      if (!live.failing) {
        live.failing = true;
        console.warn('Live XAUUSD feed unavailable, showing the last chart.');
      }
      renderLive(live.points, { stale: true });
    }
    if (liveRetryIdx < LIVE_RETRY_DELAYS.length) {
      // Not all automatic retries are spent yet: wait out the next short
      // delay and try again. While nothing was ever on screen, the
      // skeletons say the card is still working on it.
      scheduleLiveTick(LIVE_RETRY_DELAYS[liveRetryIdx]);
      liveRetryIdx += 1;
      if (!live.hadData) renderLiveChecking();
    } else if (!live.hadData) {
      if (!live.failing) {
        live.failing = true;
        console.warn('Live XAUUSD feed unavailable.');
      }
      renderLive(null, {
        reason: data && !data.ok && data.reason ? data.reason : 'the price feed is unreachable',
      });
      scheduleLiveTick(LIVE_TICK_MS);
    } else {
      // Stale chart on screen, retries spent: fall back to the steady
      // cadence until the feed recovers.
      scheduleLiveTick(LIVE_TICK_MS);
    }
  }

  // A retry the person asked for: spend none of the automatic backoff, say
  // the card is checking, and fetch straight away. While a fetch is already
  // in flight, queue one for the moment it settles instead of dropping it.
  function retryLive() {
    if (state.demo) return; // the demo runs on the simulation, no feed to retry
    liveRetryIdx = 0;
    if (liveBusy) {
      liveRetryQueued = true;
      return;
    }
    clearTimeout(live.timer);
    setLiveRetryBusy(true);
    renderLiveChecking();
    loadLive();
  }

  /* ── Log ───────────────────────────────────────────────────────────── */
  function addLog(source, tone, text) {
    // The first real line replaces the loading skeletons.
    if (el.log.querySelector('.skeleton')) el.log.replaceChildren();
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
      ['SNR', state.m30Prev, state.m30, describeM30],
      ['M5', state.m1Prev, state.m1, describeM1],
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
    if (a.extreme != null) s += ', wick ' + fmt(a.extreme);
    return s;
  }
  function describeM1(a) {
    let s = a.label;
    if (a.extreme != null) s += ', entry ' + fmt(a.entry);
    else if (a.scalp) s += ' ' + fmt(a.scalp.areaLow) + ' – ' + fmt(a.scalp.areaHigh) + ', entry ' + fmt(a.entry);
    return s;
  }

  /* ── Timer, pause, error ───────────────────────────────────────────── */
  function stopTimer() {
    if (state.timer) {
      clearInterval(state.timer);
      state.timer = null;
    }
  }
  function runFirstTick() {
    // Run the first tick before the timer starts, so the badge reading
    // ACTIVE and the verdict never disagree: with the first tick 1.5 s
    // away, the badge said ACTIVE while the verdict still said "Starting
    // scan" and the agents showed their initial readings.
    try {
      tickOnce();
    } catch (err) {
      fail(err);
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
    liveToken = token;
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
    if (demo) {
      el.noteDemo.hidden = false;
      // The staged demo view stays fully simulated, chart included.
      el.noteBody.textContent = 'Simulated XAUUSD prices, not a live market feed. Signals only, nothing is traded.';
      const foot = document.querySelector('[data-footer-note]');
      if (foot) foot.textContent = 'Agents run on simulated prices. Analysis only, nothing is traded. Not financial advice.';
    }

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
      runFirstTick();
    }
    if (!state.stopped) startTimer();
    // The live feed drives both the chart and the agents in a live scan:
    // loadLive reschedules itself (10 s when healthy, short backoff while
    // the feed is down), independently of the scan's pause, stop and retry.
    if (!demo) loadLive();
  }

  el.pair.addEventListener('change', () => {
    state.pairKey = el.pair.value;
    rebuild(Date.now());
    addLog('SYSTEM', 'muted', 'Scan restarted on ' + state.pairKey + '.');
    runFirstTick();
    retryLive(); // a fresh quote for the restarted scan
    if (!state.stopped) startTimer();
  });
  el.pauseBtn.addEventListener('click', () => {
    if (state.stopped) return;
    if (state.paused) resume();
    else pause();
  });
  el.retry.addEventListener('click', () => {
    rebuild(Date.now());
    addLog('SYSTEM', 'muted', 'Scan restarted on ' + state.pairKey + '.');
    runFirstTick();
    retryLive(); // a fresh quote for the restarted scan
    if (!state.stopped) startTimer();
  });
  el.live.retry.addEventListener('click', () => retryLive());

  boot();
})();
