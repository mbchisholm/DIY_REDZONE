// Replays LAC @ KC, 2026-10-18 (KC home), from a trimmed copy of ESPN's
// play-by-play, through the same normalizer the live feed uses.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ScoreWatch, inBreak, normalizeEvent, playEvents } from '../feed.js';
import { prepare } from '../sim.js';

const { event, summary } = JSON.parse(readFileSync(new URL('./fixtures/lac-kc-2026-10-18.json', import.meta.url)));
const at = prepare(event, summary);
const gameAt = (t) => normalizeEvent(at(t));

const plays = summary.drives.previous.flatMap((d) => d.plays);
const find = (pred) => {
  const p = plays.find(pred);
  assert.ok(p, 'fixture play not found');
  return { p, t: Date.parse(p.wallclock) };
};

test('before kickoff the game is scheduled', () => {
  const g = gameAt(Date.parse(event.date) - 60_000);
  assert.equal(g.state, 'pre');
  assert.equal(g.situation, null);
});

test('a touchdown play updates the score and fires a flash', () => {
  const { p, t } = find((q) => q.type.text === 'Rushing Touchdown');
  const before = gameAt(t - 1);
  const after = gameAt(t);
  assert.equal(after.home.score, p.homeScore);
  assert.equal(after.lastPlay.score, 'TD');
  const { events } = new ScoreWatch(before).update(before, after);
  assert.deepEqual(
    events.map((e) => [e.kind, e.side]),
    [['TD', 'home']],
  );
});

test('team timeouts count down within the half', () => {
  const { t } = find((q) => q.text.startsWith('Timeout #1 by KC'));
  const g = gameAt(t);
  assert.deepEqual(g.situation.timeouts, { home: 2, away: 3 });
});

test('ball at the LAC 2 with KC on offense is red zone, 2 to go', () => {
  const { t } = find((q) => q.text.startsWith('Timeout #2 by KC'));
  const g = gameAt(t);
  assert.equal(g.situation.offense, 'home');
  assert.equal(g.situation.toGo, 2);
  assert.equal(g.situation.redZone, true);
});

test('an interception is a turnover to the team that picked it off', () => {
  const { p, t } = find((q) => q.type.text === 'Pass Interception Return');
  const kc = event.competitions[0].competitors.find((c) => c.homeAway === 'home').team.id;
  const events = playEvents(gameAt(t - 1), gameAt(t));
  assert.deepEqual(
    events.map((e) => [e.kind, e.label, e.side]),
    [['TURNOVER', 'INTERCEPTION', p.end.team.id === kc ? 'home' : 'away']],
  );
});

test('a TV timeout reads as a break', () => {
  const { t } = find((q) => q.type.text === 'Official Timeout');
  assert.equal(inBreak(gameAt(t)), true);
});

test('end of half is halftime', () => {
  const { t } = find((q) => q.type.text === 'End of Half');
  const g = gameAt(t);
  assert.equal(g.status, 'STATUS_HALFTIME');
  assert.equal(inBreak(g), true);
});

test('after the last play the game is final with a winner', () => {
  const { p, t } = find((q) => q.type.text === 'End of Game');
  const g = gameAt(t + 1);
  assert.equal(g.state, 'post');
  assert.equal(g.home.score, p.homeScore);
  assert.equal(g.home.winner, p.homeScore > p.awayScore);
  assert.equal(g.away.winner, p.awayScore > p.homeScore);
});

test('scores come only from scoring plays, so a bad score row is ignored', () => {
  const copy = structuredClone(summary);
  const rush = copy.drives.previous.flatMap((d) => d.plays).find((q) => q.type.text === 'Rush' && q.awayScore === 0);
  rush.awayScore = 99;
  const g = normalizeEvent(prepare(event, copy)(Date.parse(rush.wallclock)));
  assert.equal(g.away.score, 0);
});
