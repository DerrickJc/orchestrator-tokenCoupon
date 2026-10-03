import test from 'node:test';
import assert from 'node:assert/strict';

import { greet } from './greet.mjs';

test('greet returns a greeting for a normal name', () => {
  assert.strictEqual(greet('World'), 'Hello, World!');
});

test('greet interpolates an empty string name verbatim', () => {
  assert.strictEqual(greet(''), 'Hello, !');
});
