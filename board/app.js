// Entry point: pick a view, start the board, render twice a second.
//
// URL parameters:
//   ?view=grid                 the fallback grid view (default: field)
//   ?delay=40                  hold everything back 40 s to match the TV stream
//   ?sim=2026-10-18T18:30:00Z  rebuild a past slate from play-by-play, starting then
//   &speed=20                  sim playback rate (0 freezes it)
//   &saved=/espn               sim from saved ESPN responses instead (see sim.js)
//   ?fill=9                    test aid: clone live games until nine are live
//   ?director=1                mock RedZone: a strip showing what the TV would show (field view)

import { createBoard } from './board.js';
import * as field from './field.js';
import * as grid from './grid.js';
import * as tv from './tv.js';
import { createDirector } from './director.js';

const params = new URLSearchParams(location.search);
const views = { field, grid };
const name = views[params.get('view')] ? params.get('view') : 'field';

const board = createBoard({
  simStart: params.has('sim') ? Date.parse(params.get('sim')) : null,
  speed: Number(params.get('speed') ?? 1),
  delayMs: Number(params.get('delay') ?? 0) * 1000,
  saved: params.get('saved'),
  fill: Number(params.get('fill') ?? 0),
});

async function main() {
  document.body.className = `v-${name}`;
  await new Promise((resolve) => {
    const css = Object.assign(document.createElement('link'), { rel: 'stylesheet', href: `${name}.css` });
    css.onload = css.onerror = resolve;
    document.head.append(css);
  });
  const director = params.has('director') && name === 'field' ? createDirector() : null;
  if (director) document.documentElement.classList.add('with-tv');
  const view = views[name].mount(document.body);
  const strip = director && tv.mount(document.body);
  await board.start();
  // A kiosk has no one to reload it: a bad frame is logged, and the next one tries again.
  const tick = () => {
    try {
      board.step();
      view.render(board, board.now(), Date.now());
      if (director) {
        director.step(board, board.now());
        strip.render(director, board, board.now(), Date.now());
      }
      document.body.classList.toggle('feed-dead', board.feed().state === 'dead');
    } catch (err) {
      console.error('[redzone] render', err);
    }
    setTimeout(tick, 500);
  };
  tick();
}

main().catch((err) => {
  console.error('[redzone]', err);
  document.body.textContent = `Board failed to start: ${err.message}`;
});
