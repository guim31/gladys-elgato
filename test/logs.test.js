// -----------------------------------------------------------------------------
// What the container writes at the default level (info): the life of the
// lights and of Gladys, never one line per reading, and a repeated failure
// once. Nothing private either: the Wi-Fi network a light reports stays out
// of the logs and of Gladys. Also: the hub reads the lights by its own timer,
// without onPoll.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GladysApiError } from '@gladysassistant/integration-sdk';
import { FEATURE_KEYS } from '../src/devices.js';
import {
  FIXTURE_NAMES,
  KEY_LIGHT,
  createAll,
  createWorld,
  featureId,
  startLights,
} from './helpers/world.js';

/** Everything written on stdout and stderr while `fn` runs, at LOG_LEVEL=`level`. */
async function capture(t, fn, level = 'info') {
  const lines = [];
  const previous = process.env.LOG_LEVEL;
  process.env.LOG_LEVEL = level;
  const write = (chunk) => {
    lines.push(...String(chunk).split('\n').filter(Boolean));
    return true;
  };
  const stdout = t.mock.method(process.stdout, 'write', write);
  const stderr = t.mock.method(process.stderr, 'write', write);
  try {
    await fn();
  } finally {
    stdout.mock.restore();
    stderr.mock.restore();
    process.env.LOG_LEVEL = previous;
  }
  return lines;
}

async function createdWorld(t, names = [KEY_LIGHT], options = {}) {
  const w = await createWorld({ lights: await startLights(names), ...options });
  t.after(() => w.close());
  await createAll(w);
  return w;
}

const brightness = (w) =>
  w.fake.lastState(featureId(w.gladys, w.lights[0], FEATURE_KEYS.BRIGHTNESS));

test('logs: normal readings, with changes, and a search write nothing at the info level', async (t) => {
  const w = await createdWorld(t);
  const [light] = w.lights;
  const lines = await capture(t, async () => {
    for (const value of [20, 40, 60, 60]) {
      light.state.brightness = value;
      await w.poll();
    }
    await w.hub.rediscover();
    await w.hub.idle();
  });
  assert.equal(brightness(w), 60);
  assert.deepEqual(lines, []);
});

test('logs: Gladys refusing the states at every reading is said once, and its return once', async (t) => {
  const w = await createdWorld(t);
  const [light] = w.lights;
  const refusal = t.mock.method(w.gladys, 'publishChangedStates', async () => {
    throw new GladysApiError(503, 'SERVICE_UNAVAILABLE', 'Gladys is restarting');
  });
  const failing = await capture(t, async () => {
    for (const value of [20, 30, 40, 50]) {
      light.state.brightness = value;
      await w.poll();
    }
    await w.hub.idle();
  });
  assert.equal(failing.length, 1, failing.join('\n'));
  assert.match(
    failing[0],
    /\[WARN\].*Gladys does not take the Elgato updates: Gladys is restarting/,
  );

  refusal.mock.restore();
  const back = await capture(t, async () => {
    await w.poll();
    await w.poll();
  });
  assert.equal(back.length, 1, back.join('\n'));
  assert.match(back[0], /\[INFO\].*Gladys takes the Elgato updates again/);
  assert.equal(brightness(w), 50);
});

test('logs: a light answering errors is said once, and its return once', async (t) => {
  const w = await createdWorld(t);
  const [light] = w.lights;
  light.mode = 'error';
  const failing = await capture(t, async () => {
    for (let poll = 0; poll < 4; poll += 1) {
      await w.poll();
    }
  });
  assert.equal(failing.length, 1, failing.join('\n'));
  assert.match(failing[0], /\[WARN\].*Cannot read Elgato Key Light CN00A0A00001 .*HTTP 500/);

  light.mode = null;
  const back = await capture(t, async () => {
    await w.poll();
    await w.poll();
  });
  assert.equal(back.length, 1, back.join('\n'));
  assert.match(back[0], /\[INFO\].*reads again/);
});

test('logs: a light leaving the network is one line, its return another', async (t) => {
  const w = await createdWorld(t);
  const [light] = w.lights;
  await light.stop();
  const gone = await capture(t, async () => {
    for (let poll = 0; poll < 5; poll += 1) {
      await w.poll();
    }
  });
  assert.equal(gone.length, 1, gone.join('\n'));
  assert.match(gone[0], /\[INFO\].*no longer answers at 127\.0\.0\.1/);
  await light.start();
  const back = await capture(t, () => w.poll());
  assert.equal(back.length, 1, back.join('\n'));
  assert.match(back[0], /\[INFO\].*answers again/);
});

test('logs: a core without mDNS discovery is said once; a busy one is not a warning', async (t) => {
  const w = await createdWorld(t);
  const scan = t.mock.method(w.gladys, 'scanNetwork', async () => {
    throw new GladysApiError(403, 'FORBIDDEN', 'network_discovery not declared');
  });
  const refused = await capture(t, async () => {
    for (let round = 0; round < 3; round += 1) {
      await w.hub.track(w.hub.rediscover());
    }
  });
  assert.equal(refused.length, 1, refused.join('\n'));
  assert.match(refused[0], /\[WARN\].*Elgato discovery through Gladys \(mDNS _elg\._tcp\) failed/);

  scan.mock.mockImplementation(async () => {
    throw new GladysApiError(409, 'CONFLICT', 'A scan is already running');
  });
  const busy = await capture(t, () => w.hub.track(w.hub.rediscover()));
  assert.deepEqual(busy, []);
  assert.equal(w.hub.summary().scan, 'busy');
});

test('logs: a bug in a background task is logged with its stack, not hidden', async (t) => {
  const w = await createdWorld(t);
  t.mock.method(w.hub, 'publishTransports', async () => {
    throw new RangeError('a bug');
  });
  const lines = await capture(t, () => w.hub.track(w.hub.rediscover()));
  const text = lines.join('\n');
  assert.match(text, /\[ERROR\].*Background task failed/);
  assert.match(text, /RangeError: a bug\n\s+at /);
});

test('privacy: the Wi-Fi network of a light never reaches the logs, /data or Gladys', async (t) => {
  const lights = await startLights(FIXTURE_NAMES);
  let w;
  const lines = await capture(
    t,
    async () => {
      w = await createWorld({ lights });
      await createAll(w);
      await w.poll();
      await w.fake.action('search', {});
      await w.app.stop();
    },
    'debug',
  );
  t.after(() => w.close());
  assert.ok(lights[0].info['wifi-info'].ssid, 'the fixture has one');
  const { readFile } = await import('node:fs/promises');
  const stored = await readFile(`${w.dataDir}/elgato-state.json`, 'utf8');
  const everything = [
    lines.join('\n'),
    stored,
    JSON.stringify(w.fake.requests),
    JSON.stringify(w.fake.discoveredDevices),
  ].join('\n');
  assert.ok(lines.length > 10, 'the debug level shows the readings');
  assert.ok(!everything.includes('example-ssid'));
  assert.ok(!everything.includes('wifi-info'));
});

test('polling: the hub reads by its own timer, without any onPoll; devices have should_poll false', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const w = await createdWorld(t, [KEY_LIGHT], { timers: true, config: { poll_interval: '15' } });
  assert.ok(w.fake.discoveredDevices.every((device) => device.should_poll === false));
  const polls = t.mock.method(w.hub, 'refresh');
  const [light] = w.lights;
  light.state.brightness = 30;
  w.clock.now += 60_000;
  t.mock.timers.tick(14_000);
  await w.hub.idle();
  assert.equal(polls.mock.callCount(), 0, 'not before the interval');
  t.mock.timers.tick(1_000);
  await w.hub.idle();
  assert.equal(polls.mock.callCount(), 1);
  assert.equal(brightness(w), 30);
});
