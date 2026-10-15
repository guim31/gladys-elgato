// -----------------------------------------------------------------------------
// The integration end to end: the SDK's fake Gladys, fake Elgato lights that
// are real HTTP servers, discovery, states, commands, reachability, restarts.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FEATURE_KEYS as K } from '../src/devices.js';
import { hsToRgbInt } from '../src/elgato/model.js';
import {
  FIXTURE_NAMES,
  KEY_LIGHT,
  KEY_LIGHT_MINI,
  STRIP_COLOR,
  STRIP_WHITE,
  createAll,
  createWorld,
  deviceId,
  deviceOf,
  featureId,
  featureOf,
  startLights,
} from './helpers/world.js';

async function world(t, options = {}) {
  const created = await createWorld(options);
  t.after(() => created.close());
  return created;
}

async function createdWorld(t, names, options = {}) {
  const w = await world(t, { lights: await startLights(names), ...options });
  await createAll(w);
  return w;
}

const state = (w, light, key) => w.fake.lastState(featureId(w.gladys, light, key));
const param = (device, name) => device.params.find((entry) => entry.name === name)?.value;
const lastTransport = (w, light) =>
  w.fake.transports.filter((entry) => entry.device_external_id === deviceId(w.gladys, light)).at(-1)
    ?.transport;

test('discovery: one device per light found by mDNS, nothing published before it is added', async (t) => {
  const w = await world(t, { lights: await startLights(FIXTURE_NAMES) });
  const devices = w.fake.discoveredDevices;
  assert.equal(devices.length, FIXTURE_NAMES.length);
  assert.deepEqual(w.fake.scans, [{ type: 'mdns', timeout_seconds: 5 }]);

  const [keyLight] = w.lights;
  const device = devices.find((entry) => entry.external_id === deviceId(w.gladys, keyLight));
  assert.equal(device.name, 'Desk left', 'the name given in Control Center');
  assert.equal(device.model, 'Elgato Key Light');
  assert.equal(device.should_poll, false);
  assert.equal(device.poll_frequency, undefined);
  assert.equal(param(device, 'IP_ADDRESS'), '127.0.0.1');
  assert.equal(param(device, 'PORT'), String(keyLight.port));
  assert.equal(param(device, 'SERIAL_NUMBER'), 'CN00A0A00001');
  assert.equal(param(device, 'FIRMWARE'), '1.0.3');
  assert.equal(param(device, 'MAC_ADDRESS'), '3c:6a:9d:00:00:01');
  // No display name: the product and the end of the serial number.
  assert.ok(devices.some((entry) => entry.name === 'Elgato Key Light Air 0002'));

  assert.deepEqual(w.fake.states, [], 'Gladys drops the states of a device not added yet');
  assert.deepEqual(w.fake.connectionStatus, { connected: true });
});

test('discovery: a typed address works without mDNS; a wrong one is reported', async (t) => {
  const lights = await startLights([KEY_LIGHT]);
  const w = await world(t, {
    lights,
    scan: false,
    config: { language: 'en', hosts: `${lights[0].address}, 300.1.1.1` },
  });
  assert.equal(w.fake.discoveredDevices.length, 1);
  const ack = await w.fake.action('search', {});
  assert.equal(ack.success, true);
  assert.match(
    ack.data.message.en,
    /^1 light\(s\), 1 answering: Desk left \(127\.0\.0\.1, Elgato Key Light\)\. Ignored addresses: 300\.1\.1\.1\.$/,
  );
  assert.match(ack.data.message.fr, /1 lampe\(s\), 1 répondent/);
});

test('nothing found: Gladys says so in the four languages', async (t) => {
  const w = await world(t, { lights: [] });
  assert.equal(w.fake.connectionStatus.connected, false);
  assert.match(w.fake.connectionStatus.message.de, /Keine Elgato-Leuchte gefunden/);
  const ack = await w.fake.action('search', {});
  assert.equal(ack.data.message.es, 'No se ha encontrado ninguna luz Elgato.');
});

test('states: added lights publish what they show, in the units of Gladys', async (t) => {
  const w = await createdWorld(t, [KEY_LIGHT, KEY_LIGHT_MINI, STRIP_COLOR, STRIP_WHITE]);
  const [keyLight, mini, stripColor, stripWhite] = w.lights;

  assert.equal(state(w, keyLight, K.POWER), 1);
  assert.equal(state(w, keyLight, K.BRIGHTNESS), 21);
  assert.equal(state(w, keyLight, K.TEMPERATURE), 3370, 'mired 297 in kelvins');

  assert.equal(state(w, mini, K.BATTERY), 79);
  assert.equal(state(w, mini, K.CHARGING), 1);

  assert.equal(state(w, stripColor, K.HUE), 358);
  assert.equal(state(w, stripColor, K.SATURATION), 6);
  assert.equal(state(w, stripColor, K.COLOR), hsToRgbInt(358, 6));
  assert.equal(state(w, stripColor, K.TEMPERATURE), undefined, 'no white in colour mode');

  assert.equal(state(w, stripWhite, K.TEMPERATURE), 3370);
  assert.equal(state(w, stripWhite, K.HUE), undefined, 'no colour in white mode');
  for (const light of w.lights) {
    assert.equal(lastTransport(w, light), 'local');
  }
});

test('states: a change made outside Gladys is published at the next reading, only once', async (t) => {
  const w = await createdWorld(t, [KEY_LIGHT_MINI]);
  const [mini] = w.lights;
  const count = w.fake.states.length;
  await w.poll();
  assert.equal(w.fake.states.length, count, 'nothing changed, nothing sent');

  mini.state.on = 0;
  mini.state.brightness = 60;
  mini.batteryInfo.level = 50.2;
  mini.batteryInfo.status = 0;
  await w.poll();
  assert.equal(state(w, mini, K.POWER), 0);
  assert.equal(state(w, mini, K.BRIGHTNESS), 60);
  assert.equal(state(w, mini, K.BATTERY), 50);
  assert.equal(state(w, mini, K.CHARGING), 0);
  assert.equal(w.fake.states.length, count + 4);
});

test('states: an unchanged value is published again after the heartbeat', async (t) => {
  const w = await createdWorld(t, [KEY_LIGHT]);
  const calls = t.mock.method(w.gladys, 'publishChangedStates');
  await w.poll();
  assert.equal(calls.mock.calls[0].arguments[1].heartbeat, 6 * 60 * 60_000);
});

test('commands: on/off, brightness and temperature on a Key Light', async (t) => {
  const w = await createdWorld(t, [KEY_LIGHT]);
  const [light] = w.lights;
  const set = (key, value) => w.fake.setValue(deviceOf(w, light), featureOf(w, light, key), value);

  assert.equal((await set(K.POWER, 0)).success, true);
  assert.equal((await set(K.BRIGHTNESS, 55)).success, true);
  assert.equal((await set(K.TEMPERATURE, 4500)).success, true);
  assert.equal((await set(K.BRIGHTNESS, 0)).success, true);
  assert.equal((await set(K.BRIGHTNESS, 0.4)).success, true);
  assert.deepEqual(light.puts(), [
    { on: 0 },
    { on: 1, brightness: 55 },
    { on: 1, temperature: 222 },
    { on: 0 },
    { on: 1, brightness: 1 },
  ]);
  // 4500 K is mired 222, read back as 4505 K: Gladys keeps what it sent.
  assert.equal(state(w, light, K.TEMPERATURE), 4500);
  await w.poll();
  assert.equal(state(w, light, K.TEMPERATURE), 4500);
  assert.equal(state(w, light, K.BRIGHTNESS), 1);

  // The temperature changed in Control Center: the reading wins.
  light.state.temperature = 250;
  await w.poll();
  assert.equal(state(w, light, K.TEMPERATURE), 4000);

  const refused = await set(K.COLOR, 0xff0000);
  assert.equal(refused.success, false);
  assert.match(refused.error, /cannot be set/);
});

test('commands: colour, hue and saturation on a Light Strip, and back to white', async (t) => {
  const w = await createdWorld(t, [STRIP_WHITE]);
  const [strip] = w.lights;
  const set = (key, value) => w.fake.setValue(deviceOf(w, strip), featureOf(w, strip, key), value);

  // In white mode, a brightness alone would bring the last colour back.
  await set(K.BRIGHTNESS, 70);
  assert.deepEqual(strip.puts().at(-1), { on: 1, brightness: 70, temperature: 297 });

  // A saturation from white mode starts from red.
  await set(K.SATURATION, 40);
  assert.deepEqual(strip.puts().at(-1), { on: 1, hue: 0, saturation: 40 });

  await set(K.COLOR, 0x3366ff);
  assert.deepEqual(strip.puts().at(-1), { on: 1, hue: 225, saturation: 80 });
  assert.equal(state(w, strip, K.COLOR), 0x3366ff, 'the colour sent, not its rounding');
  assert.equal(state(w, strip, K.HUE), 225);
  await w.poll();
  assert.equal(state(w, strip, K.COLOR), 0x3366ff);

  await set(K.HUE, 120);
  assert.deepEqual(strip.puts().at(-1), { on: 1, hue: 120, saturation: 80 });
  assert.equal(state(w, strip, K.COLOR), hsToRgbInt(120, 80));

  // In colour mode, a brightness does not touch the colour.
  await set(K.BRIGHTNESS, 30);
  assert.deepEqual(strip.puts().at(-1), { on: 1, brightness: 30 });

  await set(K.TEMPERATURE, 2900);
  assert.deepEqual(strip.puts().at(-1), { on: 1, temperature: 344 });
  assert.equal(strip.state.hue, undefined);
  await w.poll();
  assert.equal(state(w, strip, K.TEMPERATURE), 2900);
});

test('commands: an unknown device or a light that does not answer fails the command', async (t) => {
  const w = await createdWorld(t, [KEY_LIGHT]);
  const [light] = w.lights;
  const device = deviceOf(w, light);
  const feature = featureOf(w, light, K.POWER);

  const unknown = await w.fake.setValue({ ...device, external_id: 'elgato:nope' }, feature, 1);
  assert.equal(unknown.success, false);

  await light.stop();
  const ack = await w.fake.setValue(device, feature, 0);
  assert.equal(ack.success, false);
  assert.match(ack.error, /does not answer at 127\.0\.0\.1/);
});

test('reachability: a light off the network is unreachable after two readings, back when it answers', async (t) => {
  const w = await createdWorld(t, [KEY_LIGHT]);
  const [light] = w.lights;
  await light.stop();
  await w.poll();
  assert.equal(lastTransport(w, light), 'local', 'one missed reading is not enough');
  await w.poll();
  assert.equal(lastTransport(w, light), 'unreachable');
  assert.equal(w.fake.connectionStatus.connected, false);
  assert.equal(state(w, light, K.POWER), 1, 'its last state stays');

  await light.start();
  light.state.on = 0;
  await w.poll();
  assert.equal(lastTransport(w, light), 'local');
  assert.equal(w.fake.connectionStatus.connected, true);
  assert.equal(state(w, light, K.POWER), 0);
});

test('a light that changes address keeps its device; Gladys gets the new address', async (t) => {
  const w = await createdWorld(t, [KEY_LIGHT]);
  const [light] = w.lights;
  const before = deviceId(w.gladys, light);
  const oldPort = light.port;
  await light.stop();
  light.port = null;
  await light.start();
  assert.notEqual(light.port, oldPort);
  w.fake.scanResults.mdns = [light.mdnsAnswer()];

  await w.fake.scanRequest();
  const devices = w.fake.discoveredDevices;
  assert.equal(devices.length, 1);
  assert.equal(devices[0].external_id, before);
  assert.equal(param(devices[0], 'PORT'), String(light.port));
  light.state.brightness = 80;
  await w.poll();
  assert.equal(state(w, light, K.BRIGHTNESS), 80);
});

test('after a restart, the lights known in /data stay in Discovery while they are off', async (t) => {
  const lights = await startLights([STRIP_COLOR]);
  const first = await createWorld({ lights });
  await first.app.stop();
  await lights[0].stop();

  const second = await world(t, { lights, scan: false, dataDir: first.dataDir });
  const devices = second.fake.discoveredDevices;
  assert.equal(devices.length, 1);
  assert.equal(devices[0].name, 'Elgato Light Strip 0005');
  assert.ok(devices[0].features.some((feature) => feature.external_id.endsWith(':hue')));
  assert.equal(second.fake.connectionStatus.connected, false);
});

test('without /data, the lights added to Gladys are found again from their device', async (t) => {
  const lights = await startLights([KEY_LIGHT_MINI]);
  const probe = await createWorld({ lights });
  const [device] = probe.fake.discoveredDevices;
  await probe.app.stop();

  const w = await world(t, { lights, scan: false, created: [device] });
  assert.equal(w.fake.discoveredDevices.length, 1);
  assert.equal(state(w, lights[0], K.BATTERY), 79, 'read and published at start');
  assert.equal(lastTransport(w, lights[0]), 'local');
});

test("onPoll is a fallback: skipped right after the timer's reading, served otherwise", async (t) => {
  const w = await createdWorld(t, [KEY_LIGHT]);
  const { clock } = w;
  const [light] = w.lights;
  const reads = () => light.requests.filter((r) => r.path === '/elgato/lights').length;
  const device = deviceOf(w, light);

  await w.poll();
  const before = reads();
  clock.now += 5_000;
  assert.equal((await w.fake.poll(device)).success, true);
  assert.equal(reads(), before, 'read 5 s ago: skipped');
  clock.now += 5_000;
  await w.fake.poll(device);
  assert.equal(reads(), before + 1, 'read 10 s ago: served');

  // The timer skips a light onPoll read less than half an interval ago.
  clock.now += 2_000;
  await w.hub.pollAll();
  assert.equal(reads(), before + 1);
});

test('the identify button makes the chosen light blink and says so', async (t) => {
  const w = await createdWorld(t, [KEY_LIGHT]);
  const [light] = w.lights;
  const ack = await w.fake.action('identify', { device: deviceId(w.gladys, light) });
  assert.equal(light.identified, 1);
  assert.deepEqual(ack.data.message, {
    en: 'Desk left blinks.',
    fr: 'Desk left clignote.',
    de: 'Desk left blinkt.',
    es: 'Desk left parpadea.',
  });
  await light.stop();
  const down = await w.fake.action('identify', { device: deviceId(w.gladys, light) });
  assert.match(down.data.message.fr, /ne répond pas/);
  const unknown = await w.fake.action('identify', { device: 'elgato:nope' });
  assert.match(unknown.data.message.en, /not known/);
});

test('a reconnection to Gladys publishes everything again', async (t) => {
  const w = await createdWorld(t, [KEY_LIGHT]);
  const count = w.fake.states.length;
  await w.gladys.disconnect();
  await w.gladys.connect();
  await w.hub.idle();
  assert.equal(w.fake.states.length, count * 2);
});
