import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyPlay } from '../feed.js';
import { createBoard } from '../board.js';

const MIN = 60_000;
const KICK = Date.parse('2026-10-25T17:00:00Z');

// A normalized game, as feed.js produces them.
function game({ id = 'g', state = 'in', status = 'STATUS_IN_PROGRESS', home = 0, away = 0, play = 'Rush', playId = '1', kickoff = KICK } = {}) {
  return {
    id,
    kickoff,
    state,
    status,
    period: 2,
    clock: '8:00',
    home: { abbr: 'KC', score: home },
    away: { abbr: 'LAC', score: away },
    situation: state === 'in' ? { offense: 'home', down: 1, redZone: false } : null,
    lastPlay: state === 'in' ? { id: playId, type: play, text: play, ...classifyPlay(play) } : null,
  };
}

// A board on a hand-cranked clock: feed(t, games) applies one snapshot at t.
function rig() {
  let t = KICK;
  const board = createBoard({ now: () => t });
  const feed = (at, ...games) => {
    t = at;
    board.ingest(games);
    board.step();
  };
  return { board, feed, at: (x) => (t = x) };
}

test('a TV break counts down from when the board saw it, then shows BACK', () => {
  const { board, feed } = rig();
  const t0 = KICK + 30 * MIN;
  feed(t0, game());
  feed(t0 + 10_000, game({ play: 'Official Timeout', playId: '2' }));
  const g = board.games()[0];
  assert.equal(board.breakLeft(g, t0 + 10_000 + 52_000), 100_000);

  feed(t0 + 160_000, game({ play: 'Rush', playId: '3' }));
  const back = board.games()[0];
  assert.equal(board.breakLeft(back, t0 + 160_000), null);
  assert.equal(board.isBack(back, t0 + 160_000 + 60_000), true);
  assert.equal(board.isBack(back, t0 + 160_000 + 100_000), false);
});

test('a break already running when the board starts has no countdown', () => {
  const { board, feed } = rig();
  feed(KICK + 30 * MIN, game({ play: 'Official Timeout' }));
  assert.equal(board.breakLeft(board.games()[0], KICK + 31 * MIN), null);
});

test('a TV timeout logged during a quarter break keeps the longer clock', () => {
  const { board, feed } = rig();
  const t0 = KICK + 30 * MIN;
  feed(t0, game());
  feed(t0 + 1000, game({ status: 'STATUS_END_PERIOD', play: 'End Period', playId: '2' }));
  feed(t0 + 20_000, game({ status: 'STATUS_END_PERIOD', play: 'Official Timeout', playId: '3' }));
  assert.equal(board.breakLeft(board.games()[0], t0 + 1000), 202_000);
});

test('an overturned touchdown takes its trace and flash with it', () => {
  const { board, feed } = rig();
  const t0 = KICK + 30 * MIN;
  feed(t0, game());
  feed(t0 + 5000, game({ home: 7, play: 'Passing Touchdown', playId: '2' }));
  const h = board.hist(board.games()[0]);
  assert.deepEqual(h.events.map((e) => e.kind), ['TD']);
  feed(t0 + 60_000, game({ home: 0, play: 'Passing Touchdown', playId: '2' }));
  feed(t0 + 65_000, game({ home: 0, play: 'Kickoff', playId: '3' }));
  assert.deepEqual(h.events, []);
  assert.equal(h.flash, null);
});

test('a live game whose feed stops moving is flagged, but not during a break', () => {
  const { board, feed } = rig();
  const t0 = KICK + 30 * MIN;
  feed(t0, game());
  feed(t0 + 7 * MIN, game());
  assert.equal(board.isQuiet(board.games()[0], t0 + 7 * MIN), true);
  feed(t0 + 8 * MIN, game({ play: 'Official Timeout', playId: '2' }));
  assert.equal(board.isQuiet(board.games()[0], t0 + 20 * MIN), false);
});

test('partition: live, pregame within 30 min, a fresh final, and the rest to the rail', () => {
  const { board, feed } = rig();
  const t0 = KICK + 3 * 60 * MIN;
  feed(
    t0,
    game({ id: 'live' }),
    game({ id: 'ending' }),
    game({ id: 'soon', state: 'pre', kickoff: t0 + 20 * MIN }),
    game({ id: 'night', state: 'pre', kickoff: t0 + 4 * 60 * MIN }),
    game({ id: 'old', state: 'post', status: 'STATUS_FINAL' }),
  );
  feed(t0 + MIN, game({ id: 'live' }), game({ id: 'ending', state: 'post', status: 'STATUS_FINAL' }));
  const p = board.partition(t0 + 2 * MIN);
  assert.deepEqual(p.live.map((g) => g.id), ['live']);
  assert.deepEqual(p.fin.map((g) => g.id), ['ending']);
  assert.equal(board.partition(t0 + 12 * MIN).fin.length, 0);
});

test('with nothing live, the next window previews however far off it is', () => {
  const { board, feed } = rig();
  const friday = KICK - 2 * 24 * 60 * MIN;
  feed(
    friday,
    game({ id: 'a', state: 'pre' }),
    game({ id: 'b', state: 'pre' }),
    game({ id: 'late', state: 'pre', kickoff: KICK + 3 * 60 * MIN }),
  );
  const p = board.partition(friday);
  assert.deepEqual(p.pre.map((g) => g.id), ['a', 'b']);
  assert.deepEqual(p.later.map((g) => g.id), ['late']);
});
