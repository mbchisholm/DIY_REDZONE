import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ScoreWatch, breakKind, classifyPlay, inBreak, normalizeEvent, playEvents, yardsToEndzone } from '../feed.js';

const ATL_NO = { home: { abbr: 'ATL' }, away: { abbr: 'NO' } };

test('yards to end zone reads the spot text', () => {
  assert.equal(yardsToEndzone({ possessionText: 'NO 10', yardLine: 90 }, ATL_NO, 'away'), 90);
  assert.equal(yardsToEndzone({ possessionText: 'NO 8', yardLine: 92 }, ATL_NO, 'home'), 8);
  assert.equal(yardsToEndzone({ possessionText: '50', yardLine: 50 }, ATL_NO, 'home'), 50);
});

test('yards to end zone falls back to the home-relative yard line', () => {
  assert.equal(yardsToEndzone({ yardLine: 90 }, ATL_NO, 'away'), 90);
  assert.equal(yardsToEndzone({ yardLine: 90 }, ATL_NO, 'home'), 10);
  assert.equal(yardsToEndzone({ yardLine: 90 }, ATL_NO, null), null);
});

test('play types classify into score, turnover and stoppage', () => {
  const c = (t) => classifyPlay(t);
  assert.deepEqual(c('Rush'), { score: null, turnover: null, stoppage: null });
  assert.equal(c('Passing Touchdown').score, 'TD');
  assert.equal(c('Blocked Punt Touchdown').score, 'TD');
  assert.equal(c('Field Goal Good').score, 'FG');
  assert.equal(c('Field Goal Missed').score, null);
  assert.equal(c('Pass Interception Return').turnover, 'INTERCEPTION');
  assert.deepEqual(c('Interception Return Touchdown'), { score: 'TD', turnover: 'INTERCEPTION', stoppage: null });
  assert.equal(c('Fumble Recovery (Opponent)').turnover, 'FUMBLE');
  assert.equal(c('Sack Opp Fumble Recovery').turnover, 'FUMBLE');
  assert.equal(c('Fumble Recovery (Own)').turnover, null);
  assert.equal(c('Muffed Punt Recovery (Opponent)').turnover, 'MUFFED PUNT');
  assert.equal(c('Official Timeout').stoppage, 'TV TIMEOUT');
  assert.equal(c('Timeout').stoppage, 'TIMEOUT');
  assert.equal(c('Two-minute warning').stoppage, '2-MIN WARNING');
  assert.equal(c('End Period').stoppage, 'END OF QUARTER');
  assert.equal(c('End of Half').stoppage, 'HALFTIME');
});

// Shaped like a live ESPN scoreboard event (4th quarter, NO ball after a punt).
function liveEvent(situation) {
  return {
    id: '401437650',
    date: '2022-09-11T17:00Z',
    competitions: [
      {
        status: {
          period: 4,
          displayClock: '0:48',
          type: { name: 'STATUS_IN_PROGRESS', state: 'in', shortDetail: '0:48 - 4th' },
        },
        broadcasts: [{ names: ['FOX'] }],
        competitors: [
          { homeAway: 'home', score: '26', team: { id: '1', abbreviation: 'ATL', color: 'a71930', alternateColor: '000000' } },
          { homeAway: 'away', score: '27', team: { id: '18', abbreviation: 'NO', color: 'd3bc8d', alternateColor: '000000' } },
        ],
        situation,
      },
    ],
  };
}

test('live situation normalizes', () => {
  const g = normalizeEvent(
    liveEvent({
      down: 1,
      yardLine: 90,
      distance: 10,
      downDistanceText: '1st & 10 at NO 10',
      possessionText: 'NO 10',
      isRedZone: false,
      homeTimeouts: 3,
      awayTimeouts: 0,
      possession: '18',
      lastPlay: {
        id: '4014376504013',
        type: { text: 'Punt' },
        text: 'B.Pinion punts 37 yards to NO 10, fair catch by D.Harty.',
        probability: { homeWinPercentage: 0.924 },
        drive: { start: { yardLine: 25 } },
        start: { yardLine: 53, team: { id: '1' } },
        end: { yardLine: 90, team: { id: '18' } },
      },
    }),
  );
  assert.equal(g.state, 'in');
  assert.equal(g.network, 'FOX');
  assert.equal(g.home.score, 26);
  assert.equal(g.away.color, '#d3bc8d');
  assert.deepEqual(
    { ...g.situation, timeouts: undefined },
    { offense: 'away', down: 1, distance: 10, text: '1st & 10 at NO 10', spot: 'NO 10', toGo: 90, redZone: false, timeouts: undefined, driveStart: null },
  );
  assert.deepEqual(g.situation.timeouts, { home: 3, away: 0 });
  assert.equal(g.lastPlay.homeWin, 0.924);
  assert.equal(g.lastPlay.stoppage, null);
});

test('drive start is kept only when the last play kept possession', () => {
  const sit = (possession, yardLine) => ({
    down: 2,
    distance: 4,
    possession,
    possessionText: 'ATL 40',
    lastPlay: {
      id: '1',
      type: { text: 'Rush' },
      drive: { start: { yardLine } },
      start: { team: { id: possession } },
      end: { team: { id: possession } },
    },
  });
  assert.equal(normalizeEvent(liveEvent(sit('1', 25))).situation.driveStart, 25); // ATL from its own 25
  assert.equal(normalizeEvent(liveEvent(sit('18', 80))).situation.driveStart, 20); // NO from its own 20
});

test('red zone is derived when the feed omits the flag', () => {
  const g = normalizeEvent(liveEvent({ down: 1, distance: 8, possession: '1', possessionText: 'NO 8' }));
  assert.equal(g.situation.toGo, 8);
  assert.equal(g.situation.redZone, true);
});

// Minimal board games for event detection.
function game({ home = 0, away = 0, play = null, offense = 'home', down = 1, state = 'in', status = 'STATUS_IN_PROGRESS' } = {}) {
  return {
    id: 'g',
    state,
    status,
    home: { score: home },
    away: { score: away },
    situation: { offense, down },
    lastPlay: play && { id: play.id, type: play.type, text: play.type, ...classifyPlay(play.type) },
  };
}

// Feed a ScoreWatch a sequence of snapshots; return what each step produced.
function watch(...snaps) {
  const w = new ScoreWatch(snaps[0]);
  return snaps.slice(1).map((g, i) => {
    const { events, reversed } = w.update(snaps[i], g);
    return { events: events.map((e) => `${e.kind}:${e.side}`), reversed };
  });
}

test('a touchdown fires at once when the play says so, and not again for the extra point', () => {
  const steps = watch(
    game({ play: { id: '1', type: 'Rush' } }),
    game({ home: 6, play: { id: '2', type: 'Rushing Touchdown' } }),
    game({ home: 7, play: { id: '2', type: 'Rushing Touchdown' } }),
  );
  assert.deepEqual(steps.map((x) => x.events), [['TD:home'], []]);
});

test('a score with no scoring play waits one look before it counts', () => {
  const steps = watch(
    game({ play: { id: '1', type: 'Rush' } }),
    game({ away: 3, play: { id: '1', type: 'Rush' } }),
    game({ away: 3, play: { id: '2', type: 'Kickoff' } }),
  );
  assert.deepEqual(steps.map((x) => x.events), [[], ['FG:away']]);
});

test('a one-update spike never fires (ESPN posted 6 -> 20 -> 6)', () => {
  const steps = watch(
    game({ away: 6, play: { id: '1', type: 'Rush' } }),
    game({ away: 20, play: { id: '2', type: 'Pass Reception' } }),
    game({ away: 6, play: { id: '3', type: 'Sack' } }),
  );
  assert.deepEqual(steps.map((x) => x.events), [[], []]);
});

test('a dip to 0-0 and back never fires (ESPN posted 10-7 -> 0-0 -> 10-7)', () => {
  const steps = watch(
    game({ home: 7, away: 10, play: { id: '1', type: 'Rush' } }),
    game({ play: { id: '2', type: 'Two-minute warning' } }),
    game({ home: 7, away: 10, play: { id: '3', type: 'Pass Reception' } }),
  );
  assert.deepEqual(steps, [{ events: [], reversed: [] }, { events: [], reversed: [] }]);
});

test('a score that stays lowered is a reversal', () => {
  const steps = watch(
    game({ home: 7, play: { id: '1', type: 'Passing Touchdown' } }),
    game({ home: 0, play: { id: '1', type: 'Passing Touchdown' } }),
    game({ home: 0, play: { id: '2', type: 'Kickoff' } }),
  );
  assert.deepEqual(steps.map((x) => x.reversed), [[], ['home']]);
});

test('a two-point try does not fire; a typed safety does', () => {
  assert.deepEqual(
    watch(game({ away: 6, play: { id: '2', type: 'Passing Touchdown' } }), game({ away: 8, play: { id: '3', type: 'Two Point Pass' } }), game({ away: 8, play: { id: '4', type: 'Kickoff' } }))
      .map((x) => x.events),
    [[], []],
  );
  assert.deepEqual(watch(game({ play: { id: '1', type: 'Sack' } }), game({ home: 2, play: { id: '2', type: 'Safety' } }))[0].events, ['SAFETY:home']);
});

test('a walk-off score still fires as the game goes final', () => {
  const steps = watch(game({ home: 20, away: 21, play: { id: '1', type: 'Rush' } }), game({ home: 23, away: 21, state: 'post', play: { id: '2', type: 'Field Goal Good' } }));
  assert.deepEqual(steps[0].events, ['FG:home']);
});

test('interception fires a turnover for the new offense', () => {
  const before = game({ offense: 'home', play: { id: '1', type: 'Rush' } });
  const pick = game({ offense: 'away', play: { id: '2', type: 'Pass Interception Return' } });
  assert.deepEqual(
    playEvents(before, pick).map((e) => [e.kind, e.label, e.side]),
    [['TURNOVER', 'INTERCEPTION', 'away']],
  );
});

test('a pick-six is left to the touchdown', () => {
  const before = game({ offense: 'home', play: { id: '1', type: 'Rush' } });
  assert.deepEqual(playEvents(before, game({ away: 6, offense: 'away', play: { id: '2', type: 'Interception Return Touchdown' } })), []);
});

test('failed fourth down is a turnover on downs; a punt is not', () => {
  const fourth = game({ offense: 'home', down: 4, play: { id: '1', type: 'Rush' } });
  const stop = game({ offense: 'away', play: { id: '2', type: 'Pass Incompletion' } });
  assert.equal(playEvents(fourth, stop)[0]?.label, 'TURNOVER ON DOWNS');
  const punt = game({ offense: 'away', play: { id: '2', type: 'Punt' } });
  assert.deepEqual(playEvents(fourth, punt), []);
});

test('TV timeouts and period breaks count as a break; team timeouts do not', () => {
  assert.equal(breakKind(game({ play: { id: '1', type: 'Official Timeout' } })), 'TV');
  assert.equal(breakKind(game({ play: { id: '1', type: 'Two-minute warning' } })), 'TWO_MIN');
  assert.equal(breakKind(game({ status: 'STATUS_END_PERIOD' })), 'QUARTER');
  assert.equal(breakKind(game({ status: 'STATUS_HALFTIME' })), 'HALF');
  assert.equal(inBreak(game({ play: { id: '1', type: 'Timeout' } })), false);
  assert.equal(inBreak(game({ state: 'post', status: 'STATUS_FINAL' })), false);
});
