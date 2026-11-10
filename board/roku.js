// Auto mode (?director=1&drive=1): moves YouTube TV on the Roku to follow the
// director, inside a 4-game multiview someone built by hand. Key presses go
// through serve.py's /roku relay.
//
// Mapped on the Roku Streaming Stick, YouTube TV 2.26.77, 2026-11-08:
//   quad: Left/Right/Up/Down to a neighbour tile moves highlight and audio
//   quad: a press toward an edge opens an overlay menu (never sent)
//   quad: Back exits to the YouTube TV home page (never sent)
//   quad: Select makes the highlighted tile full screen (player close -> play, ~2 s)
//   full: Back returns to the quad (close -> buffer -> play, ~3 s)
// Nothing on the Roku says which tile is highlighted, so this tracks it by
// counting presses. After every move it checks the player is still playing;
// if not, it stops pressing until tv.txt changes.
//
// tv.txt (next to index.html, re-read every 10 s; edit it to take control back):
//   line 1: auto | off
//   line 2: one team per quad game, top-left top-right bottom-left bottom-right
//   line 3: the tile highlighted now: TL TR BL BR
// Saving a changed tv.txt resets the tracking, so rewrite it after rebuilding
// the quad by hand.
//
// The kiosk reports back through status.json (report() below), which
// remote.html shows: what auto mode thinks the TV is doing, and when the kiosk
// last checked in.

const TILES = ['TL', 'TR', 'BL', 'BR'];
const KEY_GAP_MS = 700;
const SETTLE_MS = 6000; // after Select or Back, the player restarts before it plays
const CONFIG_MS = 10_000;
const HEALTH_MS = 15_000;

const post = (key) => fetch(`/roku/keypress/${key}`, { method: 'POST' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function playerState() {
  try {
    const xml = await (await fetch('/roku/query/media-player', { cache: 'no-store' })).text();
    return xml.match(/state="(\w+)"/)?.[1] ?? 'unknown';
  } catch {
    return 'unreachable';
  }
}

// Keys from one { tile, full } to another. Moves only ever cross the middle
// of the 2x2, so they can't hit an edge.
export function plan(from, to) {
  const keys = [];
  if (from.full && (to.tile !== from.tile || !to.full)) keys.push('Back');
  const [fr, fc] = [from.tile >> 1, from.tile & 1];
  const [tr, tc] = [to.tile >> 1, to.tile & 1];
  if (tr !== fr) keys.push(tr > fr ? 'Down' : 'Up');
  if (tc !== fc) keys.push(tc > fc ? 'Right' : 'Left');
  if (to.full && (keys.length || !from.full)) keys.push('Select');
  return keys;
}

export function parseConfig(text) {
  const lines = text.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  return {
    mode: lines[0] === 'auto' ? 'auto' : 'off',
    teams: (lines[1] ?? '').toUpperCase().split(/\s+/).filter(Boolean),
    tile: Math.max(0, TILES.indexOf((lines[2] ?? 'TR').toUpperCase())),
  };
}

// Post the kiosk's state to status.json when it changes, and at least every
// 15 s so the phone can tell the kiosk page is still running.
const BEAT_MS = 15_000;
let sent = '';
let sentAt = 0;
export function report(state) {
  const body = JSON.stringify(state);
  if (body === sent && Date.now() - sentAt < BEAT_MS) return;
  sent = body;
  sentAt = Date.now();
  fetch('/status', { method: 'POST', body }).catch(() => {});
}

export function createDriver() {
  let raw = null;
  let cfg = { mode: 'off', teams: [], tile: 1 };
  let at = { tile: 1, full: false }; // where the TV is, by our count
  let busy = false;
  let lost = '';
  let lastKeys = '';
  let movedAt = 0;
  let misses = 0;
  let quad = []; // game ids by tile

  async function loadConfig() {
    try {
      const text = await (await fetch('tv.txt', { cache: 'no-store' })).text();
      if (text === raw) return;
      raw = text;
      cfg = parseConfig(text);
      at = { tile: cfg.tile, full: false };
      lost = '';
      misses = 0;
      console.log('[roku] tv.txt', cfg);
    } catch (err) {
      console.error('[roku] tv.txt', err);
    }
  }

  async function health() {
    if (cfg.mode !== 'auto' || busy || lost) return;
    const s = await playerState();
    misses = s === 'play' || s === 'buffer' ? 0 : misses + 1;
    if (misses >= 2) lost = `player ${s}`;
  }

  loadConfig();
  setInterval(loadConfig, CONFIG_MS);
  setInterval(health, HEALTH_MS);

  // Map tv.txt teams to today's game ids, in tile order.
  function resolve(games) {
    quad = cfg.teams.map((abbr) => games.find((g) => g.home.abbr === abbr || g.away.abbr === abbr)?.id ?? null);
  }

  async function go(to) {
    const keys = plan(at, to);
    if (!keys.length) return;
    busy = true;
    lastKeys = keys.join(' ');
    movedAt = Date.now();
    console.log(`[roku] ${TILES[at.tile]}${at.full ? ' full' : ''} -> ${TILES[to.tile]}${to.full ? ' full' : ''}: ${lastKeys}`);
    try {
      for (const k of keys) {
        const r = await post(k);
        if (!r.ok) throw new Error(`${k}: relay ${r.status}`);
        await sleep(k === 'Select' || k === 'Back' ? SETTLE_MS : KEY_GAP_MS);
      }
      at = to;
      const s = await playerState();
      if (s !== 'play' && s !== 'buffer') lost = `player ${s} after ${lastKeys}`;
    } catch (err) {
      lost = String(err.message ?? err);
    }
    if (lost) console.error('[roku] stopped:', lost);
    busy = false;
  }

  // Each tick: follow the quad director (director.js createQuadDirector):
  // audio on its tile, full screen when it says so.
  function step(director) {
    if (cfg.mode !== 'auto' || busy || lost) return;
    const cur = director.current();
    const tile = quad.indexOf(cur.audio);
    if (!cur.n || tile < 0) return;
    go({ tile, full: cur.n === 1 });
  }

  return {
    step,
    resolve,
    quad: () => quad, // game ids by tile, null where tv.txt names no game
    status: () => ({ mode: cfg.mode, lost, busy, at: `${TILES[at.tile]}${at.full ? ' FULL' : ''}`, quad, lastKeys, movedAt }),
  };
}
