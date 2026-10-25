// The board's memory between polls. ESPN only says what's true now and what
// the last play was; anything with a duration (how long a break has run, when
// a game came back, what scored five minutes ago) is kept here. Views read
// this and never write to it.

import { SCOREBOARD_URL, normalizeScoreboard, playEvents, ScoreWatch, breakKind, BREAK_TYPICAL_MS } from './feed.js';
import { loadSlate } from './sim.js';

const PREVIEW_MS = 30 * 60_000; // pregame games appear this long before kickoff
const LINGER_MS = 10 * 60_000; // finished games stay this long
const RAIL_WINDOW_MS = 14 * 3600_000; // the rail lists games kicking off within this
const MIN_BREAK_MS = 20_000; // a shorter stoppage doesn't earn a BACK
const BACK_MS = 90_000; // BACK shows this long after a break ends
const QUIET_MS = 6 * 60_000; // a live game whose feed hasn't moved this long is flagged
const STALE_MS = 20_000;
const DEAD_MS = 60_000;

// Board time is game time: wall time when live, replay time in a sim. Event
// ages and break timers run on board time; flashes and pulses on real time.
export function createBoard({ simStart = null, speed = 1, delayMs = 0, saved = null, fill = 0, now } = {}) {
  const t0 = Date.now();
  const clock = now ?? (simStart ? () => simStart + (Date.now() - t0) * speed : () => Date.now());
  const pollMs = simStart ? 1000 : 5000; // ESPN caches for 10 s; 5 s halves the wait

  const queue = []; // snapshots waiting out delayMs
  const byId = new Map(); // game id -> last applied game
  const hist = new Map(); // game id -> memory (see histOf)
  let games = [];
  let lastOk = 0;
  let failing = false;

  function histOf(g) {
    let h = hist.get(g.id);
    if (!h) {
      h = {
        events: [], // scores and turnovers, oldest first
        flash: null, // the newest event
        watch: new ScoreWatch(g),
        breakStart: null, // board time the break began; null if none, or it began before we looked
        breakKind: null,
        backAt: null, // board time the last real break ended
        rzAt: null, // real time the drive entered the red zone
        finishedAt: null,
        lastAction: '', // text of the last play that wasn't a stoppage
        changedAt: clock(), // board time the feed last said something new about this game
      };
      hist.set(g.id, h);
    }
    return h;
  }

  // -> async () => normalized games
  async function makeSource() {
    if (simStart) {
      const at = await loadSlate(simStart, saved);
      return async () => normalizeScoreboard(at(clock()));
    }
    return async () => {
      const r = await fetch(SCOREBOARD_URL, { cache: 'no-store' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return normalizeScoreboard(await r.json());
    };
  }

  async function start() {
    const pull = await makeSource();
    const loop = async () => {
      try {
        ingest(await pull());
      } catch (err) {
        failing = true;
        console.warn('[redzone] feed error', err);
      }
      setTimeout(loop, pollMs);
    };
    loop();
  }

  function ingest(list) {
    queue.push({ at: Date.now(), games: withFill(list) });
    lastOk = Date.now();
    failing = false;
  }

  // Test aid: ?fill=9 clones live games until nine are live.
  function withFill(list) {
    const live = list.filter((g) => g.state === 'in');
    const out = [...list];
    for (let i = 0; live.length && out.filter((g) => g.state === 'in').length < fill; i++) {
      const g = live[i % live.length];
      out.push({ ...g, id: `${g.id}-copy${i}` });
    }
    return out;
  }

  // Apply every due snapshot in order: skipping one could skip a turnover.
  function step() {
    while (queue.length && queue[0].at <= Date.now() - delayMs) apply(queue.shift().games);
  }

  function apply(next) {
    const t = clock();
    const real = Date.now();
    for (const g of next) {
      const prev = byId.get(g.id);
      const h = histOf(g);
      if (g.lastPlay && !g.lastPlay.stoppage) h.lastAction = g.lastPlay.text;
      if (!prev) {
        h.breakKind = breakKind(g); // start unknown
        continue;
      }

      const { events, reversed } = h.watch.update(prev, g);
      for (const side of reversed) {
        // An overturned score takes its trace with it.
        const i = h.events.findLastIndex((e) => e.side === side && e.kind !== 'TURNOVER');
        if (i >= 0) {
          if (h.flash === h.events[i]) h.flash = null;
          h.events.splice(i, 1);
        }
      }
      for (const ev of [...events, ...playEvents(prev, g)]) {
        const e = {
          ...ev,
          gameId: g.id,
          at: t,
          real,
          team: ev.side ? g[ev.side] : null,
          away: { abbr: g.away.abbr, score: g.away.score ?? 0 },
          home: { abbr: g.home.abbr, score: g.home.score ?? 0 },
        };
        h.events.push(e);
        h.flash = e;
      }

      const was = breakKind(prev);
      const is = breakKind(g);
      if (!was && is) {
        h.breakStart = t;
        h.breakKind = is;
        h.backAt = null;
      } else if (was && is) {
        // e.g. a TV timeout logged during a quarter break: keep the longer.
        if (!h.breakKind || BREAK_TYPICAL_MS[is] > BREAK_TYPICAL_MS[h.breakKind]) h.breakKind = is;
      } else if (was && !is) {
        if (g.state === 'in' && (h.breakStart === null || t - h.breakStart >= MIN_BREAK_MS)) h.backAt = t;
        h.breakStart = null;
        h.breakKind = null;
      }

      if (showsRedZone(g) && !showsRedZone(prev)) h.rzAt = real;
      if (prev.state === 'in' && g.state === 'post') h.finishedAt = t;
      if (fingerprint(g) !== fingerprint(prev)) h.changedAt = t;
    }
    games = next;
    byId.clear();
    for (const g of next) byId.set(g.id, g);
  }

  // Which games are on screen. Live games always; pregame from PREVIEW_MS
  // before kickoff; finals for LINGER_MS. With nothing live, the next window
  // previews however far off it is. Everything else in the day's slate goes
  // to the rail. Each list is in kickoff order, ESPN's order breaking ties.
  function partition(t) {
    const anyLive = games.some((g) => g.state === 'in');
    const nextKick = Math.min(...games.filter((g) => g.state === 'pre' && g.kickoff >= t).map((g) => g.kickoff));
    const idle = !anyLive && Number.isFinite(nextKick);
    const horizon = idle ? Math.max(t + PREVIEW_MS, nextKick) : t + PREVIEW_MS;
    const railRef = idle ? nextKick : t;

    const out = { live: [], pre: [], fin: [], later: [], finals: [] };
    for (const g of games) {
      const done = hist.get(g.id)?.finishedAt;
      if (g.state === 'in') out.live.push(g);
      else if (g.state === 'pre' && g.kickoff <= horizon) out.pre.push(g);
      else if (g.state === 'post' && done != null && t - done < LINGER_MS) out.fin.push(g);
      else if (Math.abs(g.kickoff - railRef) <= RAIL_WINDOW_MS) (g.state === 'post' ? out.finals : out.later).push(g);
    }
    for (const list of Object.values(out)) list.sort((a, b) => a.kickoff - b.kickoff);
    return out;
  }

  // Milliseconds of break left on the typical clock (negative once overdue),
  // or null when the break began before the board was watching.
  function breakLeft(g, t) {
    const h = hist.get(g.id);
    if (!h || h.breakStart === null || !h.breakKind) return null;
    return BREAK_TYPICAL_MS[h.breakKind] - (t - h.breakStart);
  }

  const isBack = (g, t) => {
    const h = hist.get(g.id);
    return h?.backAt != null && t >= h.backAt && t - h.backAt < BACK_MS && !breakKind(g);
  };

  // Live, not in a break, and the feed hasn't moved: ESPN may have stalled on
  // this one game.
  const isQuiet = (g, t) => {
    const h = hist.get(g.id);
    return g.state === 'in' && !breakKind(g) && h != null && t - h.changedAt > QUIET_MS;
  };

  function feed() {
    if (simStart) return { state: 'sim', age: 0 };
    const age = Date.now() - lastOk;
    const state = !lastOk ? 'connecting' : age > DEAD_MS ? 'dead' : failing || age > STALE_MS ? 'stale' : 'ok';
    return { state, age };
  }

  // Every game's events in a window, newest first.
  const recent = (t, windowMs) =>
    [...hist.values()]
      .flatMap((h) => h.events)
      .filter((e) => t >= e.at && t - e.at < windowMs)
      .sort((a, b) => b.at - a.at);

  return {
    now: clock,
    simStart,
    speed,
    delayMs,
    start,
    ingest,
    step,
    partition,
    breakLeft,
    isBack,
    isQuiet,
    feed,
    recent,
    games: () => games,
    hist: (g) => hist.get(g.id),
  };
}

// The red zone as the board shows it: not during a commercial.
export const showsRedZone = (g) => g.state === 'in' && Boolean(g.situation?.redZone) && !breakKind(g);

const fingerprint = (g) => `${g.status}|${g.clock}|${g.home.score}|${g.away.score}|${g.lastPlay?.id ?? ''}`;
