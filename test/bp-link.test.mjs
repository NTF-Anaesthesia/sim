import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BP_PAIRS, linkedValue } from '../src/controller/params.js';

test('every BP pair links both ways', () => {
  for (const [a, b] of Object.entries(BP_PAIRS)) assert.equal(BP_PAIRS[b], a);
});

test('moving sys keeps the current sys:dia ratio', () => {
  assert.equal(linkedValue('nibpSys', 60, 120, 80), 40);
  assert.equal(linkedValue('nibpSys', 180, 120, 60), 90);
});

test('moving dia moves sys by the same ratio', () => {
  assert.equal(linkedValue('nibpDia', 40, 80, 120), 60);
});

test('no ratio to keep: dia is 0.6 of sys', () => {
  assert.equal(linkedValue('abpSys', 100, 0, 0), 60);
  assert.equal(linkedValue('abpDia', 60, 0, 0), 100);
});

test('arrest goes to 0, dia stays below sys, within limits', () => {
  assert.equal(linkedValue('nibpSys', 0, 120, 80), 0);
  assert.ok(linkedValue('nibpSys', 10, 20, 19) <= 5);
  assert.ok(linkedValue('nibpDia', 240, 100, 200) <= 300);
  assert.ok(linkedValue('nibpSys', 300, 100, 99) <= 250);
});
