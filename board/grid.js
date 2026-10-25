// Grid view (?view=grid), the fallback to the field: one tile per game in
// stable slots, sized to be read from the couch. Motion only on real change;
// recent change leaves a calm trace that outlives a 30-60 s glance interval.

import { breakKind } from './feed.js';
import { showsRedZone } from './board.js';
import {
  SHORT, ago, breakLeftText, closeAndLate, darkLogo, eventColors, esc, feedText, fmtDay, fmtTime,
  fourthDown, kickoffText, markColor, other, periodName, railHTML, setAttr, setHTML, setStyle, setText,
  setVar,
} from './ui.js';

// Real time: how long motion lasts.
const FLASH_MS = { TD: 8000, FG: 6000, SAFETY: 6000, TURNOVER: 6000 };
const PULSE_MS = 2600; // red-zone entry: three pulses, then static

// Board time: how long a trace stays.
const FRESH_MS = 2 * 60_000; // score box lit, trace chip bright
const TRACE_MS = 6 * 60_000; // trace chip faded until this
const RECENT_MS = 20 * 60_000; // the recent panel's window

const MAX_TILES = 9; // past this, pregame then final tiles move to the rail
const SHRINK_MS = 60_000; // a smaller layout must hold this long before repacking

export function mount(root) {
  root.innerHTML = `
    <main class="grid"></main>
    <footer class="bar">
      <div class="rail"></div>
      <div class="feed"></div>
      <div class="clock"></div>
    </footer>`;
  const grid = root.querySelector('.grid');
  const bar = root.querySelector('.bar');
  const tiles = new Map(); // game id -> tile element
  let slots = []; // game id | null, row-major
  let cols = 1;
  let shrinkSince = null;

  // The column count that gives the largest type, given the tile's design
  // proportions (type unit = min(3.2% of width, 6% of height)).
  function pickLayout(n) {
    const W = grid.clientWidth;
    const H = grid.clientHeight;
    const gap = parseFloat(getComputedStyle(grid).rowGap) || 0;
    let best = null;
    for (let c = 1; c <= Math.max(1, n); c++) {
      const r = Math.ceil(Math.max(1, n) / c);
      const w = (W - gap * (c - 1)) / c;
      const h = (H - gap * (r - 1)) / r;
      const u = Math.min(w * 0.032, h * 0.06);
      // Ties (within 2%) go to fewer empty slots, then to fewer columns: wide
      // tiles keep away and home rows together.
      if (!best || u > best.u * 1.02 || (u > best.u * 0.98 && c * r - n < best.c * best.r - n)) best = { c, r, u };
    }
    return best;
  }

  // A game keeps its slot while the current shape still holds everyone: a game
  // that leaves leaves a hole, and a new game takes the first hole. The grid
  // repacks in kickoff order only when it must grow, or when a better shape
  // has been available for SHRINK_MS (so finals expiring one by one cause one
  // reshuffle, not several).
  function placeSlots(ids) {
    const real = Date.now();
    const L = pickLayout(ids.length);
    const want = new Set(ids);
    const keep = slots.map((id) => (id && want.has(id) ? id : null));
    const fresh = ids.filter((id) => !keep.includes(id));
    const fits = slots.length > 0 && fresh.length <= keep.filter((id) => id === null).length;
    const best = L.c === cols && L.c * L.r === slots.length;

    shrinkSince = fits && !best ? (shrinkSince ?? real) : null;
    if (fits && (best || real - shrinkSince < SHRINK_MS)) {
      for (const id of fresh) keep[keep.indexOf(null)] = id;
      slots = keep;
      return;
    }
    shrinkSince = null;
    cols = L.c;
    slots = [...ids, ...Array(L.c * L.r - ids.length).fill(null)];
  }

  // A kiosk browser often starts windowed and then goes full screen: if that
  // changes the best shape, repack at once rather than waiting out SHRINK_MS.
  addEventListener('resize', () => {
    const n = slots.filter(Boolean).length;
    const L = pickLayout(n);
    if (n && (L.c !== cols || L.c * L.r !== slots.length)) slots = [];
  });

  function render(b, t, real) {
    const { live, pre, fin, later, finals } = b.partition(t);
    // Live games always get a tile. Pregame, then final, give theirs up first.
    let room = Math.max(0, MAX_TILES - live.length);
    const keepFin = fin.slice(0, room);
    room -= keepFin.length;
    const keepPre = pre.slice(0, room);
    const shown = [...live, ...keepFin, ...keepPre].sort((x, y) => x.kickoff - y.kickoff);
    const railLater = [...later, ...pre.slice(keepPre.length)].sort((x, y) => x.kickoff - y.kickoff);
    const railFinals = [...finals, ...fin.slice(keepFin.length)].sort((x, y) => x.kickoff - y.kickoff);

    renderGrid(b, shown, t, real, railLater);
    setHTML(bar.querySelector('.rail'), railHTML(railLater, railFinals, t));
    const feed = bar.querySelector('.feed');
    feed.className = `feed ${b.feed().state}`;
    setText(feed, feedText(b));
    setText(bar.querySelector('.clock'), fmtTime(t)); // tiles have a .clock too
  }

  function renderGrid(b, shown, t, real, later) {
    const ids = new Set(shown.map((g) => g.id));
    for (const [id, el] of tiles) {
      if (!ids.has(id)) {
        el.remove();
        tiles.delete(id);
      }
    }

    let empty = grid.querySelector('.empty');
    if (!shown.length) {
      slots = [];
      grid.querySelector('.recent')?.remove();
      if (!empty) {
        empty = document.createElement('div');
        empty.className = 'empty';
        grid.append(empty);
      }
      setStyle(grid, 'gridTemplateColumns', '1fr');
      setStyle(grid, 'gridTemplateRows', '1fr');
      const next = later[0];
      setText(empty, b.games().length ? (next ? `Next kickoff ${fmtDay(next.kickoff)} ${fmtTime(next.kickoff)}` : 'No games right now') : 'Loading…');
      return;
    }
    empty?.remove();

    const byId = new Map(shown.map((g) => [g.id, g]));
    placeSlots(shown.map((g) => g.id));
    const rows = Math.ceil(slots.length / cols);
    setStyle(grid, 'gridTemplateColumns', `repeat(${cols}, minmax(0, 1fr))`);
    setStyle(grid, 'gridTemplateRows', `repeat(${rows}, minmax(0, 1fr))`);

    slots.forEach((id, i) => {
      if (!id) return;
      let el = tiles.get(id);
      if (!el) {
        el = makeTile();
        tiles.set(id, el);
        grid.append(el);
      }
      setStyle(el, 'gridArea', `${Math.floor(i / cols) + 1} / ${(i % cols) + 1}`);
      updateTile(el, byId.get(id), b, t, real);
    });

    renderRecent(b, t, rows);
  }

  // Spare slots hold the recent-events panel: the trailing run of empty slots
  // in the last row, or else the last hole.
  function renderRecent(b, t, rows) {
    let el = grid.querySelector('.recent');
    let start;
    let span;
    const lastRow = (rows - 1) * cols;
    let k = slots.length - 1;
    while (k >= lastRow && slots[k] === null) k--;
    if (k < slots.length - 1) {
      start = k + 1;
      span = slots.length - start;
    } else {
      start = slots.lastIndexOf(null);
      span = start >= 0 ? 1 : 0;
    }
    if (start < 0) {
      el?.remove();
      return;
    }
    if (!el) {
      el = document.createElement('section');
      el.className = 'recent';
      grid.append(el);
    }
    const r = Math.floor(start / cols) + 1;
    const c = (start % cols) + 1;
    setStyle(el, 'gridArea', `${r} / ${c} / ${r + 1} / ${c + span}`);
    el.classList.toggle('wide', span > 1);

    const items = b.recent(t, RECENT_MS).slice(0, 6);
    const html = items.length
      ? items
          .map((e) => {
            const old = t - e.at < FRESH_MS ? '' : 'old';
            const score = `${esc(e.away.abbr)} ${e.away.score}<i>–</i>${e.home.score} ${esc(e.home.abbr)}`;
            return `<div class="ri ${old}">${chipHTML(e, old)}<b>${esc(e.team?.abbr ?? '')}</b><span class="rs">${score}</span><span class="ra">${esc(ago(t - e.at))}</span></div>`;
          })
          .join('')
      : '<div class="none">No scores or turnovers in the last 20 min</div>';
    setHTML(el, `<h2>Last 20 min</h2><div class="rl">${html}</div>`);
  }

  return { render };
}

const TEAM_ROW = (side) => `
  <div class="team ${side}">
    <span class="bar"></span><img class="logo" alt=""><span class="abbr"></span><span class="poss"></span>
    <span class="trace"></span>
    <span class="score"></span>
  </div>`;

function makeTile() {
  const el = document.createElement('article');
  el.className = 'tile';
  el.innerHTML = `
    <div class="band"><span class="state"></span><span class="tag"></span><span class="clock"><b class="per"></b><b class="clk"></b></span></div>
    <div class="teams">${TEAM_ROW('away')}${TEAM_ROW('home')}</div>
    <div class="sit"><span class="dd"></span><span class="spot"></span></div>
    <div class="field">
      <span class="ez own"></span>
      <span class="turf"><span class="rz"></span><span class="drive"></span><span class="ltg"></span><span class="ball"></span></span>
      <span class="ez opp"></span>
    </div>
    <div class="flash"><span class="f-label"></span><span class="f-team"></span></div>`;
  return el;
}

function updateTile(el, g, b, t, real) {
  const h = b.hist(g);
  const s = g.situation;
  const live = g.state === 'in';
  const half = g.status === 'STATUS_HALFTIME';
  const brk = Boolean(breakKind(g));
  const rz = showsRedZone(g);
  const q = el.querySelector.bind(el);

  el.classList.toggle('is-pre', g.state === 'pre');
  el.classList.toggle('is-post', g.state === 'post');
  el.classList.toggle('is-break', brk);
  el.classList.toggle('is-rz', rz);
  el.classList.toggle('rz-enter', rz && h?.rzAt != null && real - h.rzAt < PULSE_MS);

  // band: state label + game clock
  const [state, kind, tag] = bandFor(g, b, t, brk, rz);
  q('.band').className = `band k-${kind}`;
  setText(q('.state'), state);
  setText(q('.tag'), tag);
  const [per, clk] = clockFor(g);
  setText(q('.per'), per);
  setText(q('.clk'), clk);

  // teams + scores + traces
  for (const side of ['away', 'home']) {
    const team = g[side];
    const row = q(`.team.${side}`);
    setVar(row, '--team', markColor(team));
    setAttr(row.querySelector('.logo'), 'src', darkLogo(team.logo));
    setText(row.querySelector('.abbr'), team.abbr);
    const score = row.querySelector('.score');
    setText(score, g.state === 'pre' ? team.record : String(team.score ?? 0));
    score.classList.toggle('is-record', g.state === 'pre');
    row.classList.toggle('has-ball', live && !half && s?.offense === side);
    row.classList.toggle('loser', g.state === 'post' && !team.winner && g[other(side)].winner);

    const last = h?.events.findLast((e) => e.side === side && t >= e.at && t - e.at < TRACE_MS);
    const fresh = Boolean(last) && t - last.at < FRESH_MS;
    row.classList.toggle('scored', fresh && last.kind !== 'TURNOVER');
    setHTML(
      row.querySelector('.trace'),
      last ? `${chipHTML(last, fresh ? '' : 'old')}<span class="age${fresh ? '' : ' old'}">${esc(ago(t - last.at))}</span>` : '',
    );
  }

  // down & distance, spot
  let dd = '';
  let spot = '';
  if (g.state === 'pre') {
    dd = g.network;
  } else if (live && s && !half) {
    const m = /^(.*?)\s+at\s+(.*)$/i.exec(s.text || '');
    if (m) [dd, spot] = [m[1], m[2]];
    else if (s.text) dd = s.text;
    else if (s.spot) spot = s.spot;
  }
  setText(q('.dd'), dd.toUpperCase());
  setText(q('.spot'), spot.toUpperCase());

  // field strip: the offense drives left to right
  const field = q('.field');
  const showField = live && !half && s?.offense && s.toGo != null;
  setStyle(field, 'visibility', showField ? 'visible' : 'hidden');
  if (showField) {
    setVar(field, '--off', markColor(g[s.offense]));
    setVar(field, '--def', markColor(g[other(s.offense)]));
    const x = 100 - s.toGo;
    setStyle(q('.ball'), 'left', `${x}%`);
    const ltg = s.distance ? x + s.distance : null;
    setStyle(q('.ltg'), 'display', ltg !== null && ltg < 100 ? 'block' : 'none');
    if (ltg !== null) setStyle(q('.ltg'), 'left', `${ltg}%`);
    const start = s.driveStart;
    const showDrive = start !== null && start < x;
    setStyle(q('.drive'), 'display', showDrive ? 'block' : 'none');
    if (showDrive) {
      setStyle(q('.drive'), 'left', `${start}%`);
      setStyle(q('.drive'), 'width', `${x - start}%`);
    }
  }

  // flash: covers the situation rows; the scores stay readable above it
  const f = h?.flash;
  const flash = q('.flash');
  const on = Boolean(f) && real - f.real < FLASH_MS[f.kind];
  flash.classList.toggle('on', on);
  if (on) {
    const { bg, fg } = eventColors(f);
    flash.dataset.kind = f.kind;
    setVar(flash, '--flash-bg', bg);
    setVar(flash, '--flash-fg', fg);
    setText(q('.f-label'), f.label);
    setText(q('.f-team'), f.team ? (f.kind === 'TURNOVER' ? `${f.team.abbr} BALL` : f.team.name.toUpperCase()) : '');
  }
}

// [label, kind, tag]. kind picks the band style: rz | warn | back | break | pre | post | none
function bandFor(g, b, t, brk, rz) {
  if (g.state === 'pre') return [kickoffText(g, t), 'pre', ''];
  if (g.state === 'post') return ['', 'post', ''];
  const lp = g.lastPlay;
  if (brk) {
    let label = 'TV BREAK';
    if (g.status === 'STATUS_HALFTIME') label = 'HALFTIME';
    else if (g.status === 'STATUS_END_PERIOD') label = g.period === 4 ? 'END OF REG' : `END OF ${periodName(g.period)}`;
    else if (lp?.stoppage === '2-MIN WARNING') label = '2-MIN WARN';
    return [label, 'break', breakLeftText(b.breakLeft(g, t))];
  }
  const back = b.isBack(g, t);
  const minor = back ? 'BACK' : lp?.stoppage === 'TIMEOUT' ? 'TIMEOUT' : b.isQuiet(g, t) ? 'NO UPDATES' : '';
  if (rz) return ['RED ZONE', 'rz', minor];
  if (fourthDown(g.situation)) return ['4TH DOWN', 'warn', minor];
  if (closeAndLate(g)) return ['CLOSE & LATE', 'warn', minor];
  if (back) return ['BACK', 'back', ''];
  return ['', 'none', minor];
}

function clockFor(g) {
  if (g.state === 'pre') return ['', fmtTime(g.kickoff)];
  if (g.state === 'post') return ['', /OT/.test(g.detail) ? 'FINAL/OT' : 'FINAL'];
  if (g.status === 'STATUS_HALFTIME' || g.status === 'STATUS_END_PERIOD') return ['', ''];
  return [periodName(g.period), g.clock];
}

function chipHTML(e, cls) {
  const short = SHORT[e.label] ?? e.kind;
  if (e.kind === 'TURNOVER') return `<span class="ev to ${cls}">${esc(short)}</span>`;
  const { bg, fg } = eventColors(e);
  return `<span class="ev sc ${cls}" style="--bg:${bg};--fg:${fg}">${esc(short)}</span>`;
}
