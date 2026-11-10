import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyPlay } from '../feed.js';
import { createBoard } from '../board.js';
import { createQuadDirector } from '../director.js';

const KICK = Date.parse('2026-11-08T18:00:00Z');

function game(id, { toGo = 50, down = 1, distance = 10, period = 2, clock = '8:00', home = 0, away = 0, play = 'Rush', playId = '1', homeWin = 0.5, state = 'in' } = {}) {
  return {
    id, kickoff: KICK, state, status: 'STATUS_IN_PROGRESS', period, clock,
    home: { abbr: `H${id}`, score: home }, away: { abbr: `A${id}`, score: away },
    situation: { offense: 'home', down, distance, toGo, redZone: toGo <= 20, timeouts: {} },
    lastPlay: { id: playId, type: play, text: play, ...classifyPlay(play), homeWin },
  };
}

const QUAD = ['1', '2', '3', '4'];
function rig() {
  let t = KICK + 30 * 60_000;
  const board = createBoard({ now: () => t });
  const d = createQuadDirector();
  const run = (secs, games) => {
    for (const end = t + secs * 1000; t < end; t += 5000) {
      board.ingest(games);
      board.step();
      d.step(board, t, QUAD);
    }
    return d.current();
  };
  return { run, d, board, now: () => t };
}
const quiet = QUAD.map((id) => game(id));
const with_ = (id, g) => quiet.map((q) => (q.id === id ? g : q));

test('starts on the quad, ids in tile order', () => {
  const cur = rig().run(10, quiet);
  assert.equal(cur.n, 4);
  assert.deepEqual(cur.ids, QUAD);
});

test('audio moves to the action after its hold; two red-zone drives keep the quad', () => {
  const r = rig();
  r.run(10, quiet);
  const rz = [quiet[0], quiet[1], game('3', { toGo: 18 }), game('4', { toGo: 19 })];
  assert.equal(r.run(20, rz).audio, '1', 'audio holds 60 s');
  const cur = r.run(60, rz);
  assert.deepEqual([cur.n, cur.audio], [4, '3']);
});

test('one goal-to-go game goes full screen, and leaves at its commercial', () => {
  const r = rig();
  r.run(10, quiet);
  const gtg = game('2', { toGo: 6, distance: 6 });
  assert.deepEqual([r.run(100, with_('2', gtg)).n, r.d.current().audio], [1, '2']);
  const brk = game('2', { toGo: 6, distance: 6, play: 'Official Timeout', playId: '2' });
  const cur = r.run(10, with_('2', brk));
  assert.equal(cur.n, 4);
  assert.notEqual(cur.audio, '2');
});

test('two key games stay in the quad, audio on the hotter', () => {
  const r = rig();
  r.run(100, quiet);
  const late = { period: 4, clock: '3:30', home: 20, away: 17 };
  const cur = r.run(30, [game('1', { ...late }), game('2', { ...late, toGo: 8, distance: 8 }), ...quiet.slice(2)]);
  assert.deepEqual([cur.n, cur.audio], [4, '2']);
});

test('suggests swapping a final quad game for a live close one', () => {
  const r = rig();
  const games = [...with_('4', game('4', { state: 'post', period: 4, clock: '0:00' })), game('5')];
  r.run(10, games);
  assert.deepEqual(r.d.swaps(r.board, r.now(), QUAD), ['−A4@H4 FINAL +A5@H5']);
});
