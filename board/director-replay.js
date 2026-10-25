// Scores the mock director against a past slate: replays the day through the
// board every 5 s of game time, as a live poll would, and reports what the TV
// would have shown when it mattered.
//
//   node director-replay.js 2026-10-18                  summary
//   node director-replay.js 2026-10-18 --log            plus every switch
//   node director-replay.js 2026-10-18 --from 17:00 --to 20:30   UTC window
//   --dwell 120 --urgent 60 --settle 30                    timing, in seconds
//
// ESPN responses are cached in $TMPDIR/redzone-replay, so reruns are offline.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SCOREBOARD_URL, SUMMARY_URL, breakKind, normalizeScoreboard } from './feed.js';
import { createBoard, showsRedZone } from './board.js';
import { prepare } from './sim.js';
import { competitiveness, createDirector, label } from './director.js';
import { closeAndLate } from './ui.js';

const STEP_MS = 5000;
const args = process.argv.slice(2);
const day = args.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a));
if (!day) {
  console.error('usage: node director-replay.js YYYY-MM-DD [--log] [--from HH:MM] [--to HH:MM]');
  process.exit(1);
}
const opt = (k) => (args.includes(k) ? args[args.indexOf(k) + 1] : null);
const showLog = args.includes('--log');

const cacheDir = join(tmpdir(), 'redzone-replay');
async function cached(name, url) {
  const path = join(cacheDir, name);
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`${r.status} ${url}`);
    const json = await r.json();
    await mkdir(cacheDir, { recursive: true });
    await writeFile(path, JSON.stringify(json));
    return json;
  }
}

const ymd = day.replaceAll('-', '');
const sb = await cached(`sb_${ymd}.json`, `${SCOREBOARD_URL}?dates=${ymd}`);
const slate = await Promise.all(sb.events.map(async (ev) => prepare(ev, await cached(`sum_${ev.id}.json`, `${SUMMARY_URL}?event=${ev.id}`))));
const at = (t) => normalizeScoreboard({ events: slate.map((f) => f(t)) });

// Default window: first kickoff to the last afternoon final (skips the night game).
const kicks = sb.events.map((ev) => Date.parse(ev.date)).sort((a, b) => a - b);
const from = opt('--from') ? Date.parse(`${day}T${opt('--from')}:00Z`) : kicks[0];
const to = opt('--to') ? Date.parse(`${day}T${opt('--to')}:00Z`) : kicks.filter((k) => k < kicks[0] + 10 * 3600_000).at(-1) + 4 * 3600_000;

let t = from;
const board = createBoard({ now: () => t });
const secs = (k) => (opt(k) ? Number(opt(k)) * 1000 : undefined);
const director = createDirector({ logMax: Infinity, dwellMs: secs('--dwell'), settleMs: secs('--settle'), urgentGapMs: secs('--urgent') });

// Tallies. "Moments" are scores and turnovers: what the TV showed on the poll
// before the board saw it, i.e. while the play was being run.
const moments = [];
const time = { rz: { full: 0, tile: 0, off: 0 }, late: { full: 0, tile: 0, off: 0 }, lateLive: { full: 0, tile: 0, off: 0 }, breakOnScreen: 0, onScreen: 0 };
const seen = new Set();
let shownBefore = { n: 0, ids: [] };
let compBefore = new Map(); // game id -> competitiveness on the previous poll

for (; t <= to; t += STEP_MS) {
  board.ingest(at(t));
  board.step();
  const shown = director.step(board, t);

  for (const g of board.games()) {
    for (const e of board.hist(g)?.events ?? []) {
      const k = `${g.id}|${e.at}|${e.kind}`;
      if (seen.has(k)) continue;
      seen.add(k);
      moments.push({ at: e.at, game: label(g), kind: e.kind, how: how(shownBefore, g.id), close: (compBefore.get(g.id) ?? 1) >= 0.3 });
    }
    if (g.state !== 'in') continue;
    const h = how(shown, g.id);
    if (showsRedZone(g)) time.rz[h] += STEP_MS;
    if (closeAndLate(g)) time.late[h] += STEP_MS;
    if (closeAndLate(g) && competitiveness(g) >= 0.3) time.lateLive[h] += STEP_MS;
  }
  for (const id of shown.ids) {
    time.onScreen += STEP_MS;
    const g = board.games().find((x) => x.id === id);
    if (g && breakKind(g)) time.breakOnScreen += STEP_MS;
  }
  shownBefore = { n: shown.n, ids: [...shown.ids] };
  compBefore = new Map(board.games().filter((g) => g.state === 'in').map((g) => [g.id, competitiveness(g)]));
}

function how(shown, id) {
  if (!shown.ids.includes(id)) return 'off';
  return shown.n === 1 ? 'full' : 'tile';
}

const hhmm = (ms) => new Date(ms).toISOString().slice(11, 19);
const pct = (a, total) => (total ? `${Math.round((100 * a) / total)}%` : '—');
const log = director.log();

if (showLog) {
  for (const e of log) console.log(`${hhmm(e.at)}Z ${e.urgent ? '!' : ' '} ${e.why}`);
  console.log();
}

const hours = (to - from) / 3600_000;
const dwell = log.slice(1).map((e, i) => e.at - log[i].at).sort((a, b) => a - b);
console.log(`${day}  ${hhmm(from)}Z–${hhmm(to)}Z  (${hours.toFixed(1)} h)`);
console.log(`switches: ${log.length} (${(log.length / hours).toFixed(1)}/h), median hold ${Math.round((dwell[dwell.length >> 1] ?? 0) / 1000)} s`);
const byN = Object.groupBy(log.slice(0, -1).map((e, i) => ({ n: e.n, ms: log[i + 1].at - e.at })), (x) => x.n);
console.log(`time by layout: ${[1, 2, 4].map((n) => `${{ 1: 'full', 2: 'split', 4: 'quad' }[n]} ${Math.round((byN[n] ?? []).reduce((s, x) => s + x.ms, 0) / 60_000)} min`).join(', ')}`);

for (const kind of ['TD', 'FG', 'TURNOVER']) {
  const m = moments.filter((x) => x.kind === kind);
  const c = (h, xs = m) => xs.filter((x) => x.how === h).length;
  const close = m.filter((x) => x.close);
  console.log(`${kind.padEnd(8)} ${String(m.length).padStart(3)}  full ${c('full')}  tile ${c('tile')}  missed ${c('off')}   competitive: ${close.length}, missed ${c('off', close)}`);
}
const cov = (o) => `full ${pct(o.full, o.full + o.tile + o.off)}, tile ${pct(o.tile, o.full + o.tile + o.off)}, off ${pct(o.off, o.full + o.tile + o.off)}`;
console.log(`red-zone time:     ${cov(time.rz)}`);
console.log(`close-&-late time: ${cov(time.late)}`);
console.log(`  still in doubt:  ${cov(time.lateLive)}`);
console.log(`screen time spent on a game in break: ${pct(time.breakOnScreen, time.onScreen)}`);

const missed = moments.filter((x) => x.how === 'off' && x.kind === 'TD');
if (missed.length) console.log(`\nmissed TDs: ${missed.map((x) => `${hhmm(x.at)}Z ${x.game}`).join(', ')}`);
