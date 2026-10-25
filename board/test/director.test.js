import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyPlay } from '../feed.js';
import { createBoard } from '../board.js';
import { createDirector } from '../director.js';

const KICK = Date.parse('2026-10-25T17:00:00Z');

// A live game at midfield in the 2nd quarter, unless told otherwise.
function game(id, { toGo = 50, down = 1, distance = 10, period = 2, clock = '8:00', home = 0, away = 0, play = 'Rush', playId = '1', homeWin = 0.5 } = {}) {
  return {
    id,
    kickoff: KICK,
    state: 'in',
    status: 'STATUS_IN_PROGRESS',
    period,
    clock,
    home: { abbr: `H${id}`, score: home },
    away: { abbr: `A${id}`, score: away },
    situation: { offense: 'home', down, distance, toGo, redZone: toGo <= 20, timeouts: {} },
    lastPlay: { id: playId, type: play, text: play, ...classifyPlay(play), homeWin },
  };
}

// Feeds the same slate every 5 s for `secs`, stepping the director each time.
// The rules are tested on fast timing; the default timing has its own test.
const FAST = { dwellMs: 45_000, settleMs: 15_000, urgentGapMs: 15_000 };
function rig(timing = FAST) {
  let t = KICK + 30 * 60_000;
  const board = createBoard({ now: () => t });
  const director = createDirector(timing);
  const run = (secs, games) => {
    for (const end = t + secs * 1000; t < end; t += 5000) {
      board.ingest(games);
      board.step();
      director.step(board, t);
    }
    return director.current();
  };
  return { run, director };
}

const quiet = ['1', '2', '3', '4', '5'].map((id) => game(id));

test('with nothing happening, the TV rests on a quad', () => {
  const { run } = rig();
  const cur = run(30, quiet);
  assert.equal(cur.n, 4);
});

test('one game in the red zone takes the full screen', () => {
  const { run } = rig();
  run(60, quiet);
  const cur = run(30, [...quiet.slice(0, 4), game('5', { toGo: 8, distance: 8 })]);
  assert.deepEqual([cur.n, cur.ids], [1, ['5']]);
});

test('two close-and-late games share the screen even with one in the red zone', () => {
  const { run } = rig();
  run(60, quiet);
  const late = { period: 4, clock: '3:30', home: 20, away: 17 };
  const cur = run(30, [game('1', { ...late, toGo: 12 }), game('2', late), ...quiet.slice(2)]);
  assert.equal(cur.n, 2);
  assert.deepEqual([...cur.ids].sort(), ['1', '2']);
});

test('full screen leaves a commercial; a quad tile sits through one', () => {
  const { run } = rig();
  run(60, quiet);
  run(30, [...quiet.slice(0, 4), game('5', { toGo: 8, distance: 8 })]);
  const brk = game('5', { toGo: 8, distance: 8, play: 'Official Timeout', playId: '2' });
  assert.notDeepEqual(run(30, [...quiet.slice(0, 4), brk]).ids, ['5']);

  const r = rig();
  const before = r.run(60, quiet);
  const tile = before.ids[0];
  const slate = quiet.map((g) => (g.id === tile ? game(tile, { play: 'Official Timeout', playId: '2' }) : g));
  assert.ok(r.run(60, slate).ids.includes(tile));
});

test('a red-zone trip in a decided game loses to one in a close game', () => {
  const { run } = rig();
  run(60, quiet);
  const blowout = game('4', { toGo: 15, homeWin: 0.99, home: 35 });
  const close = game('5', { toGo: 15, homeWin: 0.6 });
  assert.deepEqual(run(30, [...quiet.slice(0, 3), blowout, close]).ids, ['5']);
});

test('by default, nothing switches within 3 minutes of the last switch', () => {
  const { run, director } = rig({});
  run(60, quiet); // the quad goes up 30 s in, once it has settled
  const hot = [...quiet.slice(0, 4), game('5', { toGo: 8, distance: 8 })];
  run(110, hot);
  assert.equal(director.log().length, 1);
  run(60, hot);
  assert.deepEqual(director.current().ids, ['5']);
});
