import { test } from 'node:test';
import assert from 'node:assert/strict';
import { plan, parseConfig } from '../roku.js';

const TL = 0, TR = 1, BL = 2, BR = 3;

test('quad moves never cross an edge', () => {
  assert.deepEqual(plan({ tile: TR, full: false }, { tile: TL, full: false }), ['Left']);
  assert.deepEqual(plan({ tile: TL, full: false }, { tile: BR, full: false }), ['Down', 'Right']);
  assert.deepEqual(plan({ tile: BR, full: false }, { tile: TL, full: false }), ['Up', 'Left']);
  assert.deepEqual(plan({ tile: BL, full: false }, { tile: BL, full: false }), []);
});

test('full screen goes through the quad', () => {
  assert.deepEqual(plan({ tile: TR, full: false }, { tile: TR, full: true }), ['Select']);
  assert.deepEqual(plan({ tile: TR, full: true }, { tile: TR, full: false }), ['Back']);
  assert.deepEqual(plan({ tile: TR, full: true }, { tile: BL, full: true }), ['Back', 'Down', 'Left', 'Select']);
  assert.deepEqual(plan({ tile: TR, full: true }, { tile: TR, full: true }), []);
});

test('tv.txt', () => {
  const c = parseConfig('# x\nauto\nkc buf  phi dal\nbl\n');
  assert.deepEqual(c, { mode: 'auto', teams: ['KC', 'BUF', 'PHI', 'DAL'], tile: BL });
  assert.equal(parseConfig('').mode, 'off');
});
