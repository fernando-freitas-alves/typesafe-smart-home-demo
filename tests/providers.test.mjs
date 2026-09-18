import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSplitCommands, evaluate } from '../providers.mjs';

test('Jev receives identity and location even without device states; mock request format stays compatible', async t => {
  const previous = process.env.TYPESAFE_API_KEY; process.env.TYPESAFE_API_KEY = 'test-key';
  t.after(() => { if (previous === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = previous; });
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'https://api.typesafe.ai/v1/systemone'); requests.push(JSON.parse(options.body));
    return Response.json({ answers: {}, model: 'jev-test' });
  });
  const user = { name: 'Fernando', office: { id: 'a', name: 'Fernando’s office' }, location: { id: 'b', name: 'Kitchen' } };
  const devices = [{ id: 'example' }]; const command = 'Turn on the lights here';
  await evaluate(command, devices, 'none', undefined, {}, user);
  assert.deepEqual(requests.at(-1).state, { request: command, user });
  await evaluate(command, devices, 'devices', undefined, {}, user);
  assert.deepEqual(requests.at(-1).state, { request: command, user, devices });
  await evaluate(command, devices, 'none', undefined, {});
  assert.equal(requests.at(-1).state, command);
  await evaluate(command, devices, 'devices', undefined, {});
  assert.deepEqual(requests.at(-1).state, { request: command, devices });
});

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
