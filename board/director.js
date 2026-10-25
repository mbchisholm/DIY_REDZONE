// Mock RedZone: decides what the TV would show, one game full screen or a 2-
// or 4-game tile, from the board's state. It controls nothing; it says what
// it would switch to and why, so a Sunday can test the rules before Home
// Assistant can act on them. Pure logic over the board API, so it runs under
// `node --test` and in director-replay.js as well as on the page.

import { breakKind } from './feed.js';
import { showsRedZone } from './board.js';
import { closeAndLate, fourthDown } from './ui.js';

export const HOT = 5; // heat that earns a game a slot on its own
const INCUMBENT = 1.5; // heat bonus for a game already on screen, so slots don't flap
const HELD = 0.5; // heat of a tile sitting through its own commercial
const RECENT_MS = 45_000; // a score or turnover this fresh still has a replay coming
// Conservative until we know how long a real switch takes. On the 2026-10-18
// 1pm window this is ~15 switches an hour (vs 43 at 45 s / 15 s) for one
// fewer touchdown on screen; under 3 min the urgent floor stops paying.
const DWELL_MS = 5 * 60_000; // board time a layout holds before an ordinary change
const SETTLE_MS = 30_000; // an ordinary change must stay the pick this long
const URGENT_GAP_MS = 3 * 60_000; // even an urgent change waits this long after the last
const BLOWOUT_FLOOR = 0.35; // share of its heat a decided game keeps: a goal-to-go drive still shows if nothing else is on
const CONTESTED = 0.5; // competitiveness (about 85/15) at or above which a game gets no discount
const DECIDED = 0.15; // competitiveness below which close-and-late no longer makes a game key

// How much a game deserves the screen right now -> { heat, why }. A game in
// a commercial, or not live, has none. `why` is the largest contribution.
export function heatOf(g, b, t) {
  if (g.state !== 'in' || breakKind(g)) return { heat: 0, why: g.state === 'in' ? 'TV BREAK' : '' };
  const s = g.situation;
  // Blowouts are discounted, not dropped: past about 85/15, every reason to
  // watch counts for less as the game gets decided.
  const live = Math.min(1, competitiveness(g) / CONTESTED);
  const k = BLOWOUT_FLOOR + (1 - BLOWOUT_FLOOR) * live;
  let heat = 0.5 + 0.5 * live;
  let why = live < 0.6 ? 'LIVE (LOPSIDED)' : 'LIVE';
  let top = 0;
  const add = (v, w) => {
    heat += v * k;
    if (v > top) [top, why] = [v, w];
  };

  if (s?.offense && s.toGo != null) {
    if (s.down && s.toGo <= 10 && s.distance >= s.toGo) add(6, 'GOAL TO GO');
    else if (showsRedZone(g)) add(4.5, 'RED ZONE');
    else if (s.toGo <= 40) add(1.5, 'SCORING RANGE');
  }
  if (fourthDown(s)) add(2.5, '4TH DOWN');
  if (closeAndLate(g)) add(secondsLeft(g) <= 120 || g.period > 4 ? 5.5 : 4, 'CLOSE & LATE');
  else if (g.period >= 4 && margin(g) <= 8) add(1, 'ONE SCORE, 4TH');

  const ev = b.hist(g)?.events.at(-1);
  if (ev && t >= ev.at && t - ev.at < RECENT_MS) add(ev.kind === 'TURNOVER' ? 2 : 1, ev.kind === 'TURNOVER' ? 'TURNOVER' : 'JUST SCORED');
  if (b.isBack(g, t)) add(0.5, 'BACK FROM BREAK');
  if (b.isQuiet(g, t)) heat -= 2;
  return { heat, why };
}

const margin = (g) => Math.abs((g.home.score ?? 0) - (g.away.score ?? 0));

// 1 for a coin flip, 0 for a decided game. From ESPN's live win probability
// on the last play: 75/25 -> 0.75, 90/10 -> 0.36, 98/2 -> 0.08. Without one,
// from the margin against the time left: a lead counts as safe at 32 points
// at kickoff, shrinking to 12 at the end.
export function competitiveness(g) {
  const wp = g.lastPlay?.homeWin;
  if (typeof wp === 'number') return 1 - (2 * wp - 1) ** 2;
  const left = g.period > 4 ? 0 : (4 - g.period) * 900 + secondsLeft(g);
  const safe = 12 + 20 * (left / 3600);
  return Math.max(0, 1 - (margin(g) / safe) ** 2);
}

function secondsLeft(g) {
  const [m, s] = g.clock.split(':').map(Number);
  return m * 60 + (s || 0);
}

// The layout the rules want now, ignoring timing: { n, ids, heat } or null
// when nothing is live outside a break (the TV would be in commercials anyway).
//  - Close-and-late games and HOT games are "key".
//  - One key game: full screen. Two: split. Three or more: quad.
//  - No key game: a quad of the best live games, like a resting multiview.
// A tile in a TV break keeps a little heat, so a commercial alone doesn't
// cost it its slot; full screen never sits on a commercial.
export function pick(b, t, cur = { n: 0, ids: [] }) {
  const live = b.partition(t).live
    .map((g) => {
      let { heat, why } = heatOf(g, b, t);
      const mine = cur.ids.includes(g.id);
      const held = heat === 0 && mine && cur.n > 1;
      if (held) heat = HELD;
      return { g, heat, why, held, eff: heat + (heat > 0 && mine ? INCUMBENT : 0) };
    })
    .filter((x) => x.heat > 0)
    .sort((x, y) => y.eff - x.eff || x.g.kickoff - y.g.kickoff);
  if (!live.length) return null;

  const key = live.filter((x) => !x.held && (x.heat >= HOT || (closeAndLate(x.g) && competitiveness(x.g) >= DECIDED)));
  const n = key.length === 1 || live.length === 1 ? 1 : key.length === 2 || live.length === 2 ? 2 : 4;
  const chosen = [...key, ...live.filter((x) => !key.includes(x))].slice(0, n);
  return { n, ids: chosen.map((x) => x.g.id), heat: Object.fromEntries(live.map((x) => [x.g.id, x])) };
}

// The director proper: pick() plus timing. An urgent change (a HOT game not on
// screen, or a game on screen gone to break or final) goes almost at once; an
// ordinary one waits out DWELL_MS and must stay the pick for SETTLE_MS.
export function createDirector({ logMax = 200, dwellMs = DWELL_MS, settleMs = SETTLE_MS, urgentGapMs = URGENT_GAP_MS } = {}) {
  let cur = { n: 0, ids: [], since: -Infinity };
  let pending = null; // { key, since }
  const log = [];

  function step(b, t) {
    const want = pick(b, t, cur);
    if (!want) return cur; // everything in break: hold
    const key = layoutKey(want);
    if (key === layoutKey(cur)) {
      pending = null;
      return cur;
    }
    const byId = new Map(b.games().map((g) => [g.id, g]));
    const gone = cur.ids.filter((id) => !(want.heat[id]?.heat > 0));
    const arrivingHot = want.ids.filter((id) => !cur.ids.includes(id) && want.heat[id].heat >= HOT);
    const urgent = gone.length > 0 || arrivingHot.length > 0;

    if (!pending || pending.key !== key) pending = { key, since: t };
    const ready = urgent
      ? t - cur.since >= urgentGapMs
      : t - cur.since >= dwellMs && t - pending.since >= settleMs;
    if (!ready) return cur;

    const entry = { at: t, n: want.n, ids: want.ids, labels: want.ids.map((id) => label(byId.get(id))), urgent, why: explain(cur, want, byId) };
    log.push(entry);
    if (log.length > logMax) log.shift();
    cur = { n: want.n, ids: want.ids, since: t, heat: want.heat };
    pending = null;
    return cur;
  }

  return { step, current: () => cur, log: () => log };
}

const layoutKey = (l) => `${l.n}|${[...l.ids].sort().join(',')}`;
export const label = (g) => (g ? `${g.away.abbr}@${g.home.abbr}` : '?');
const LAYOUT = { 1: 'FULL', 2: 'SPLIT', 4: 'QUAD' };

// One line for the log: the layout, then what came on and why, then what left.
function explain(cur, want, byId) {
  const parts = [LAYOUT[want.n]];
  const on = want.ids.filter((id) => !cur.ids.includes(id));
  const off = cur.ids.filter((id) => !want.ids.includes(id));
  const why = (id) => `${label(byId.get(id))} ${want.heat[id]?.why ?? ''}`.trim();
  if (on.length) parts.push(`+ ${on.map(why).join(', ')}`);
  else parts.push(want.ids.map(why).join(', '));
  if (off.length) parts.push(`− ${off.map((id) => `${label(byId.get(id))}${want.heat[id] ? '' : ` ${offWhy(byId.get(id))}`}`).join(', ')}`);
  return parts.join(' ');
}

function offWhy(g) {
  if (!g) return '';
  if (g.state === 'post') return 'FINAL';
  return breakKind(g) ? 'TV BREAK' : '';
}
