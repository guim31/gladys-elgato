// -----------------------------------------------------------------------------
// The scene actions (src/scenes.js): make lights blink, set several lights in
// one go.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FEATURE_KEYS as K } from '../src/devices.js';
import {
  KEY_LIGHT,
  KEY_LIGHT_MINI,
  STRIP_COLOR,
  createAll,
  createWorld,
  deviceId,
  featureId,
  startLights,
} from './helpers/world.js';

async function createdWorld(t, names) {
  const w = await createWorld({ lights: await startLights(names) });
  t.after(() => w.close());
  await createAll(w);
  return w;
}

const ids = (w) => w.lights.map((light) => deviceId(w.gladys, light));
const state = (w, light, key) => w.fake.lastState(featureId(w.gladys, light, key));

test('identify: every chosen light blinks', async (t) => {
  const w = await createdWorld(t, [KEY_LIGHT, KEY_LIGHT_MINI]);
  const ack = await w.fake.sceneAction('identify', { devices: ids(w) });
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(ack.data.outputs, { reached: 2 });
  assert.deepEqual(
    w.lights.map((light) => light.identified),
    [1, 1],
  );
});

test('set_lighting: on, brightness and white in one request per light', async (t) => {
  const w = await createdWorld(t, [KEY_LIGHT, STRIP_COLOR]);
  const [keyLight, strip] = w.lights;
  keyLight.state.on = 0;
  const ack = await w.fake.sceneAction('set_lighting', {
    devices: ids(w),
    brightness: 40,
    temperature: 5000,
  });
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(keyLight.puts(), [{ on: 1, brightness: 40, temperature: 200 }]);
  assert.deepEqual(strip.puts(), [{ on: 1, brightness: 40, temperature: 200 }]);
  assert.equal(state(w, keyLight, K.POWER), 1);
  assert.equal(state(w, keyLight, K.TEMPERATURE), 5000);
  assert.equal(state(w, strip, K.TEMPERATURE), 5000);
  assert.equal(strip.state.hue, undefined, 'the strip leaves its colour for the white');
});

test('set_lighting: empty fields leave the setting unchanged; out of range is clamped', async (t) => {
  const w = await createdWorld(t, [KEY_LIGHT]);
  const [light] = w.lights;
  await w.fake.sceneAction('set_lighting', { devices: ids(w), brightness: '', temperature: null });
  await w.fake.sceneAction('set_lighting', { devices: ids(w)[0], brightness: 250 });
  await w.fake.sceneAction('set_lighting', { devices: ids(w), temperature: 1500 });
  assert.deepEqual(light.puts(), [
    { on: 1 },
    { on: 1, brightness: 100 },
    { on: 1, temperature: 344 },
  ]);
  const invalid = await w.fake.sceneAction('set_lighting', { devices: ids(w), brightness: 'a' });
  assert.equal(invalid.success, false);
});

test('a light that does not answer: the others still act, the action fails only if none did', async (t) => {
  const w = await createdWorld(t, [KEY_LIGHT, KEY_LIGHT_MINI]);
  const [first, second] = w.lights;
  await second.stop();
  const partial = await w.fake.sceneAction('identify', { devices: ids(w) });
  assert.equal(partial.success, true);
  assert.deepEqual(partial.data.outputs, { reached: 1 });
  assert.equal(first.identified, 1);

  await first.stop();
  const none = await w.fake.sceneAction('identify', { devices: ids(w) });
  assert.equal(none.success, false);
  assert.match(none.error, /does not answer/);

  const empty = await w.fake.sceneAction('identify', { devices: [] });
  assert.equal(empty.success, false);
  assert.match(empty.error, /at least one/);
});
