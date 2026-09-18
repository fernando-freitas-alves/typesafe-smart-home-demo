import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSplitCommands } from '../providers.mjs';

test('accepts the fenced JSON format returned by the live Haiku API', () => {
  const response = '```json\n["turn off the kitchen lights", "lock the office door"]\n```';
  assert.deepEqual(parseSplitCommands(response), ['turn off the kitchen lights', 'lock the office door']);
});

test('accepts bare JSON and unlabelled fences while preserving command order', () => {
  assert.deepEqual(parseSplitCommands(' [" lights off ", "lock the door"] '), ['lights off', 'lock the door']);
  assert.deepEqual(parseSplitCommands('```\n["lights off", "lock the door"]\n```'), ['lights off', 'lock the door']);
});

test('rejects malformed, truncated, excessive, and non-string command lists', () => {
  for (const response of [undefined, '', 'Here is the list: ["a","b"]', '```json\n["a","b"]', '{}', '["a"]', '["a",null]', '["a",""]', '["a"," "]', JSON.stringify(Array(7).fill('a')), JSON.stringify(['a', 'b'.repeat(1501)])]) {
    assert.throws(() => parseSplitCommands(response), /LLM/);
  }
});
