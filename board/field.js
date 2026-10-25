// Field view: every game is a lane on one shared field. The axis is yards from
// the offense's own goal line, so every offense drives left to right and the
// red zone is one column down the whole board. "Who is about to score" reads
// as "whose ball is furthest right".

import { breakKind } from './feed.js';
import { showsRedZone } from './board.js';
import {
  SHORT, ago, breakLeftText, clamp, closeAndLate, darkLogo, eventColors, feedText, fmtDay, fmtTime,
  fourthDown, kickoffText, markColor, other, periodName, railHTML, sameDay, setAttr, setHTML, setStyle,
  setText, setVar, tidyPlay,
} from './ui.js';

const FLASH_MS = { TD: 15000, FG: 8000, SAFETY: 8000, TURNOVER: 10000 }; // real time
const RECENT_MS = 5 * 60_000; // board time an event stays in the end-zone cell
const RECENT_FRESH_MS = 2 * 60_000; // after this the cell dims
const RZ_PULSE_MS = 5000; // real time a lane pulses after entering the red zone
const COMPACT = 0.56; // pregame/halftime/final lane height as a share of a live lane
const TV_H = 156; // the mock TV strip and its gap, in design px (field.css --tv)

export function mount(root) {
  // The top bar shares the lanes' columns, so the yard numbers over the field
  // column are the axis for every lane below.
  root.innerHTML = `
    <header class="top cols">
      <div class="brand"><span class="mark"></span>REDZONE</div>
      <div class="now"><span class="clock"></span><span class="feed"></span></div>
      <div class="axis"></div>
      <div class="axis-ez">LAST 5 MIN</div>
    </header>
    <main class="board"></main>
    <footer class="rail"></footer>`;
  const ticks = [10, 20, 30, 40, 50, 60, 70]
    .map((x) => `<span class="tick${x === 50 ? ' mid' : ''}" style="left:${x}%">${x <= 50 ? x : 100 - x}</span>`)
    .join('');
  root.querySelector('.axis').innerHTML = `<span class="own">OWN</span>${ticks}<span class="rzhead">RED ZONE</span>`;

  const board = root.querySelector('.board');
  const lanes = new Map(); // game id -> lane element
  let geom = { fieldW: 1100, u: 1 };

  // Lane height comes from how many lanes there are. JS only publishes the
  // counts; field.css turns them into sizes, so a resize needs no JS. geom
  // mirrors that arithmetic for the one thing JS places by hand.
  function layout(shown) {
    const nFull = shown.filter((g) => !isCompact(g)).length;
    const n = Math.max(1, shown.length);
    const neff = Math.max(1, nFull + COMPACT * (shown.length - nFull));
    setVar(document.documentElement, '--n', String(n));
    setVar(document.documentElement, '--neff', neff.toFixed(2));

    const wx = innerWidth / 1920;
    const tv = document.documentElement.classList.contains('with-tv') ? TV_H : 0;
    const avail = innerHeight - (144 + tv) * wx;
    const L = Math.min((avail - 8 * wx * (n - 1)) / neff, 250 * wx);
    // Four games or fewer leave height to spare: spend it on the last play.
    board.classList.toggle('tall', L >= 215 * wx);
    const u = Math.min(L / 100, 1.4 * wx);
    geom = { u, fieldW: innerWidth - 28 * wx - (330 + 215 + 168) * u };
  }

  function render(b, t, real) {
    const { live, pre, fin, later, finals } = b.partition(t);
    // Fixed order: kickoff, then ESPN's. Lanes never reshuffle on a play, so a
    // game keeps its row and the eye learns where to look.
    const shown = [...live, ...fin, ...pre].sort((x, y) => x.kickoff - y.kickoff);
    layout(shown);

    const feed = root.querySelector('.top .feed');
    feed.className = `feed ${b.feed().state}`;
    setText(feed, feedText(b));
    setText(root.querySelector('.top .clock'), fmtTime(t));

    const ids = new Set(shown.map((g) => g.id));
    for (const [id, el] of lanes) {
      if (!ids.has(id)) {
        el.remove();
        lanes.delete(id);
      }
    }
    let empty = board.querySelector('.empty');
    if (!shown.length) {
      if (!empty) {
        empty = document.createElement('div');
        empty.className = 'empty';
        board.append(empty);
      }
      const next = later[0];
      setText(empty, b.games().length ? (next ? `Next kickoff ${fmtDay(next.kickoff)} ${fmtTime(next.kickoff)}` : 'No games right now') : 'Loading…');
    } else {
      empty?.remove();
      shown.forEach((g, i) => {
        let el = lanes.get(g.id);
        if (!el) {
          el = makeLane();
          el.dataset.id = g.id;
          lanes.set(g.id, el);
        }
        if (board.children[i] !== el) board.insertBefore(el, board.children[i] ?? null);
        updateLane(el, g, b, t, real, geom);
      });
    }
    setHTML(root.querySelector('.rail'), railHTML(later, finals, t));
  }

  return { render };
}

const isCompact = (g) => g.state !== 'in' || g.status === 'STATUS_HALFTIME';

const TEAM = (side) => `
  <div class="team ${side}">
    <span class="tbar"></span><img class="logo" alt=""><span class="abbr"></span>
    <span class="poss"></span><span class="tos"><i></i><i></i><i></i></span>
    <span class="score"></span>
  </div>`;

function makeLane() {
  const el = document.createElement('article');
  el.className = 'lane cols';
  el.innerHTML = `
    <div class="teams">${TEAM('away')}${TEAM('home')}</div>
    <div class="when"><div class="clk"><span class="per"></span><span class="time"></span></div><div class="sub"><div class="chip"><b></b><span class="el"></span></div><span class="net"></span></div></div>
    <div class="field">
      <span class="rz"></span><span class="fifty"></span>
      <div class="plays">
        <div class="layer trail"><i></i></div>
        <div class="layer ltg"><i></i></div>
        <div class="layer mark"><span class="los"></span><span class="ball"><img alt=""></span><span class="dd"></span></div>
      </div>
      <div class="hatch"></div>
      <div class="note"><span></span></div>
    </div>
    <p class="lastplay"></p>
    <div class="ez"><b class="ez-label"></b><span class="ez-sub"></span></div>
    <div class="flash"><b class="f-label"></b><span class="f-team"></span><span class="f-text"></span></div>`;
  return el;
}

function updateLane(el, g, b, t, real, geom) {
  const q = el.querySelector.bind(el);
  const h = b.hist(g);
  const live = g.state === 'in';
  const half = g.status === 'STATUS_HALFTIME';
  const brk = Boolean(breakKind(g));
  const s = live && !half ? g.situation : null;

  el.classList.toggle('compact', isCompact(g));
  el.classList.toggle('is-pre', g.state === 'pre');
  el.classList.toggle('is-post', g.state === 'post');
  el.classList.toggle('is-break', brk);
  el.classList.toggle('is-half', half);
  el.classList.toggle('is-rz', showsRedZone(g));
  el.classList.toggle('rz-enter', showsRedZone(g) && real - (h?.rzAt ?? -Infinity) < RZ_PULSE_MS);

  const lastEvent = (side) => h?.events.findLast((e) => e.side === side && e.kind !== 'TURNOVER');
  for (const side of ['away', 'home']) {
    const team = g[side];
    const row = q(`.team.${side}`);
    setVar(row, '--team', markColor(team));
    setAttr(row.querySelector('.logo'), 'src', darkLogo(team.logo));
    setText(row.querySelector('.abbr'), team.abbr);
    const score = row.querySelector('.score');
    setText(score, g.state === 'pre' ? team.record : String(team.score ?? 0));
    score.classList.toggle('is-record', g.state === 'pre');
    row.classList.toggle('has-ball', s?.offense === side);
    row.classList.toggle('loser', g.state === 'post' && !team.winner && g[other(side)].winner);
    const scoredAt = lastEvent(side)?.at;
    row.classList.toggle('scored', scoredAt != null && t - scoredAt < RECENT_MS);
    const left = live ? g.situation?.timeouts[side] : null;
    setStyle(row.querySelector('.tos'), 'visibility', left == null ? 'hidden' : 'visible');
    row.querySelectorAll('.tos i').forEach((pip, k) => pip.classList.toggle('used', left != null && k >= left));
  }

  const [per, time] = clockParts(g, t);
  setText(q('.per'), per);
  setText(q('.time'), time);
  const [chip, kind, extra] = chipFor(g, b, t, brk);
  const chipEl = q('.chip');
  chipEl.className = `chip ${kind}`;
  setText(chipEl.querySelector('b'), chip);
  setText(chipEl.querySelector('.el'), extra);
  setText(q('.net'), live ? g.network.toUpperCase() : '');

  // the shared field
  const field = q('.field');
  const showBall = Boolean(s?.offense) && s.toGo != null;
  field.classList.toggle('has-ball', showBall);
  if (showBall) {
    const off = g[s.offense];
    // A change of possession is a new drive, not movement: jump, don't slide
    // the ball across the lane.
    if (field.dataset.off !== s.offense) {
      field.dataset.off = s.offense;
      field._jumpUntil = real + 700;
    }
    field.classList.toggle('jump', real < (field._jumpUntil ?? 0));
    setVar(field, '--off', markColor(off));
    const x = clamp(100 - s.toGo, 0, 100);
    setStyle(q('.mark'), 'transform', `translateX(${x}%)`);
    setAttr(q('.ball img'), 'src', darkLogo(off.logo));

    const ds = s.driveStart;
    const trail = q('.trail');
    const showTrail = ds != null && ds < x;
    setStyle(trail, 'opacity', showTrail ? '1' : '0');
    if (showTrail) setStyle(trail, 'transform', `translateX(${ds}%) scaleX(${((x - ds) / 100).toFixed(4)})`);

    const ltg = q('.ltg');
    const lx = s.distance ? x + s.distance : null;
    const showLtg = lx !== null && lx < 100;
    setStyle(ltg, 'opacity', showLtg ? '1' : '0');
    if (showLtg) setStyle(ltg, 'transform', `translateX(${lx}%)`);

    const dd = downText(s);
    const ddEl = q('.dd');
    setText(ddEl, dd);
    // The label sits behind the ball (over the drive) unless that would run off
    // the left edge of the field.
    const need = (((dd.length * 19 + 70) * geom.u) / geom.fieldW) * 100;
    ddEl.classList.toggle('ahead', x < need);
  }

  setText(q('.note span'), noteFor(g, b, t, showBall));
  setText(q('.lastplay'), live ? tidyPlay(h?.lastAction) : '');

  // end-zone cell: the latest score or turnover, kept for RECENT_MS
  const ev = h?.events.at(-1);
  const ez = q('.ez');
  const age = ev ? t - ev.at : Infinity;
  const onEz = age < RECENT_MS;
  ez.classList.toggle('on', onEz);
  ez.classList.toggle('old', onEz && age >= RECENT_FRESH_MS);
  if (onEz) {
    const { bg, fg } = eventColors(ev);
    setVar(ez, '--ev-bg', bg);
    setVar(ez, '--ev-fg', fg);
    setText(q('.ez-label'), SHORT[ev.label] ?? ev.kind);
    const who = ev.team ? (ev.kind === 'TURNOVER' ? `${ev.team.abbr} BALL` : ev.team.abbr) : '';
    setText(q('.ez-sub'), `${who} · ${ago(age)}`);
  } else {
    setText(q('.ez-label'), '');
    setText(q('.ez-sub'), '');
  }

  // flash: covers the field and end zone; the scoreboard stays readable
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
    setText(q('.f-text'), tidyPlay(f.text));
  }
}

function clockParts(g, t) {
  if (g.state === 'pre') return [sameDay(g.kickoff, t) ? '' : fmtDay(g.kickoff).toUpperCase(), fmtTime(g.kickoff)];
  if (g.state === 'post') return ['', /OT/.test(g.detail) ? 'FINAL/OT' : 'FINAL'];
  if (g.status === 'STATUS_HALFTIME') return ['', 'HALF'];
  if (g.status === 'STATUS_END_PERIOD') return ['END', periodName(g.period)];
  return [periodName(g.period), g.clock];
}

// One chip per lane: [label, kind, extra]. A commercial outranks everything,
// and every kind gets the same words (the clock column already says whether
// it's a quarter break or the two-minute warning); the time left goes on the
// field, which has room for it. The red zone has no chip: the lit segment
// sits under the column's RED ZONE label.
function chipFor(g, b, t, brk) {
  if (g.state !== 'in') return ['', '', ''];
  if (brk) return ['TV BREAK', 'brk', ''];
  if (b.isBack(g, t)) return ['BACK', 'back', ''];
  const s = g.situation;
  if (fourthDown(s)) return ['4TH DOWN', 'watch', ''];
  if (g.lastPlay?.stoppage === 'TIMEOUT') return ['TIMEOUT', 'to', ''];
  if (closeAndLate(g)) return ['CLOSE & LATE', 'watch', ''];
  if (b.isQuiet(g, t)) return ['NO UPDATES', 'to', ''];
  return ['', '', ''];
}

function noteFor(g, b, t, showBall) {
  if (g.state === 'pre') return `${kickoffText(g, t)}${g.network ? ` · ${g.network.toUpperCase()}` : ''}`;
  if (g.state === 'post') return '';
  const left = breakLeftText(b.breakLeft(g, t));
  if (g.status === 'STATUS_HALFTIME') return `HALFTIME${left ? ` · ${left}` : ''}`;
  if (breakKind(g)) return left;
  if (!showBall) return g.lastPlay?.score ? '' : 'KICKOFF';
  return '';
}

function downText(s) {
  if (!s.down) return '';
  const head = (s.text || '').split(' at ')[0];
  if (head) return head;
  return `${['', '1st', '2nd', '3rd', '4th'][s.down]} & ${s.distance}`;
}
