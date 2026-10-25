// The mock TV strip (?director=1): what the director would put on the TV, why,
// and its last few switches. Lanes on screen get .on-tv, so the field shows
// it too. A switch lights the strip for a few seconds: that's the cue to
// change the channel by hand.

import { breakKind } from './feed.js';
import { showsRedZone } from './board.js';
import { label } from './director.js';
import { esc, fmtClock, fmtTime, markColor, setHTML, setText } from './ui.js';

const CUE_MS = 6000; // real time the strip stays lit after a switch
const LOG_SHOWN = 4;
const LAYOUT = { 1: 'FULL', 2: 'SPLIT', 4: 'QUAD' };

export function mount(root) {
  const el = document.createElement('section');
  el.className = 'tv';
  el.innerHTML = `
    <div class="tv-head"><span class="tv-tag">MOCK TV</span><b class="tv-layout"></b><span class="tv-held"></span></div>
    <div class="tv-screen"></div>
    <p class="tv-why"></p>
    <ol class="tv-log"></ol>`;
  root.querySelector('footer').before(el);
  const q = el.querySelector.bind(el);
  let seen = 0;
  let cueUntil = 0;

  function render(director, b, t, real) {
    const cur = director.current();
    const log = director.log();
    const last = log.at(-1);
    if (last && last.at !== seen) {
      if (seen) cueUntil = real + CUE_MS;
      seen = last.at;
      console.log(`[director] ${fmtTime(last.at)} ${last.why}`);
    }
    el.classList.toggle('cue', real < cueUntil);

    setText(q('.tv-layout'), LAYOUT[cur.n] ?? '—');
    setText(q('.tv-held'), cur.n ? fmtClock(t - cur.since) : '');
    setText(q('.tv-why'), last?.why ?? 'Waiting for a live game');

    const byId = new Map(b.games().map((g) => [g.id, g]));
    const slots = cur.n ? Array.from({ length: cur.n }, (_, i) => byId.get(cur.ids[i])) : [];
    const screen = q('.tv-screen');
    screen.dataset.n = String(cur.n);
    setHTML(screen, slots.map(slotHTML).join(''));

    setHTML(
      q('.tv-log'),
      log.slice(-LOG_SHOWN - 1, -1).reverse()
        .map((e) => `<li><b>${esc(fmtTime(e.at))}</b>${esc(e.why)}</li>`)
        .join(''),
    );

    const on = new Set(cur.ids);
    for (const lane of document.querySelectorAll('[data-id]')) lane.classList.toggle('on-tv', on.has(lane.dataset.id));
  }

  return { render };
}

function slotHTML(g) {
  if (!g) return '<div class="slot empty"></div>';
  const off = g.situation?.offense;
  const cls = ['slot', showsRedZone(g) ? 'rz' : '', breakKind(g) ? 'brk' : ''].join(' ');
  const team = (side) =>
    `<span class="${off === side ? 'has-ball' : ''}" style="--team:${markColor(g[side])}">${esc(g[side].abbr)} ${g[side].score ?? 0}</span>`;
  return `<div class="${cls}" title="${esc(label(g))}">${team('away')}${team('home')}</div>`;
}
