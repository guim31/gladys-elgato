// -----------------------------------------------------------------------------
// A complete test world: the SDK's fake Gladys, fake Elgato lights (real HTTP
// servers on 127.0.0.1), and a temporary /data, with the integration wired on
// top through registerHandlers. No timer runs unless asked: the tests read
// the lights with `world.poll()`, which first moves the hub's clock one minute
// on (a light read less than half an interval ago is skipped).
// -----------------------------------------------------------------------------

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { registerHandlers } from '../../src/app.js';
import { Store } from '../../src/store.js';
import { FIXTURE_NAMES, FakeElgato, startLights } from './fakeElgato.js';

// The integration logs every change; keep the test output readable.
process.env.LOG_LEVEL ??= 'silent';

// A light that does not answer fails in 300 ms.
export const FAST_CLIENT = { timeoutMs: 300 };

export const KEY_LIGHT = 'key-light-1.0.3';
export const KEY_LIGHT_MINI = 'key-light-mini-1.0.4';
export const STRIP_COLOR = 'light-strip-color-1.0.4';
export const STRIP_WHITE = 'light-strip-white-1.0.3';

/**
 * @param {object} [options]
 * @param {FakeElgato[]} [options.lights] the fake lights of the network (started)
 * @param {boolean} [options.scan] whether the core's mDNS browse finds them
 * @param {object} [options.config] raw integration config
 * @param {Array} [options.created] devices already created in Gladys
 * @param {boolean} [options.timers] the hub's own timers (off: the tests poll)
 */
export async function createWorld({
  lights,
  scan = true,
  config = { language: 'en' },
  created = [],
  connect = true,
  dataDir = mkdtempSync(join(tmpdir(), 'gladys-elgato-')),
  timings = {},
  timers = false,
  now,
} = {}) {
  const clock = { now: 1_000_000 };
  const network = lights ?? (await startLights([KEY_LIGHT]));
  const gladys = createFakeGladys({
    config,
    devices: created,
    scanResults: { mdns: scan ? network.map((light) => light.mdnsAnswer()) : [] },
  });
  const app = registerHandlers(gladys, {
    store: new Store(dataDir),
    timers,
    timings,
    clientTimings: FAST_CLIENT,
    now: now ?? (() => clock.now),
  });
  if (connect) {
    await gladys.connect();
    await app.ready;
  }
  const world = { gladys, fake: gladys.fake, lights: network, app, hub: app.hub, dataDir };
  world.clock = clock;
  world.poll = async () => {
    clock.now += 60_000;
    await app.hub.pollAll();
  };
  world.close = async () => {
    await app.stop();
    await Promise.all(network.map((light) => light.stop()));
  };
  return world;
}

export const deviceId = (gladys, light) => gladys.externalIds('elgato', light.id).device;
export const featureId = (gladys, light, key) =>
  gladys.externalIds('elgato', light.id).feature(key);

/** Add every discovered device in Gladys, as the user would. */
export async function createAll(world) {
  for (const device of world.fake.discoveredDevices) {
    await world.fake.deviceCreated(device);
  }
  await world.hub.idle();
}

/** The Gladys device of a fake light, as created. */
export function deviceOf(world, light) {
  const id = deviceId(world.gladys, light);
  return world.fake.devices.find((device) => device.external_id === id);
}

/** The created feature of a fake light. */
export function featureOf(world, light, key) {
  const id = featureId(world.gladys, light, key);
  return deviceOf(world, light).features.find((feature) => feature.external_id === id);
}

export { FIXTURE_NAMES, FakeElgato, startLights };
