// -----------------------------------------------------------------------------
// Registers every SDK handler on a GladysIntegration (or the SDK's fake) and
// returns the hub, so index.js stays a few lines and the tests drive the very
// same wiring.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { normalizeConfig } from './config.js';
import { deviceName } from './devices.js';
import { ElgatoClient } from './elgato/client.js';
import { ElgatoHub } from './hub.js';
import { SCENE_ACTIONS } from './scenes.js';
import { Store } from './store.js';
import { IDENTIFY_TEXT, INIT_FAILED, localized, searchMessage } from './texts.js';

const logger = createLogger({ name: 'elgato-app' });

/**
 * @param {object} gladys GladysIntegration instance
 * @param {object} [options] test seams: store, timers, timings, clientTimings, now
 */
export function registerHandlers(gladys, options = {}) {
  const hub = new ElgatoHub({
    gladys,
    store: options.store ?? new Store(),
    client: new ElgatoClient({ timings: options.clientTimings }),
    timers: options.timers ?? true,
    timings: options.timings,
    now: options.now,
  });

  // Resolved once the hub has started; every handler waits for it, so a
  // command arriving during the first search is not lost.
  let resolveReady;
  const ready = new Promise((resolve) => {
    resolveReady = resolve;
  });
  let started = false;
  const whenReady =
    (fn) =>
    async (...args) => {
      await ready;
      return fn(...args);
    };

  gladys.on('connected', async () => {
    try {
      const config = normalizeConfig(await gladys.getConfig());
      if (started) {
        // A reconnection (Gladys restarted): re-sync what Gladys may have lost.
        await hub.resync(config);
        return;
      }
      started = true;
      await hub.start(config);
    } catch (err) {
      logger.error('Initialization failed', err);
      await gladys.setConnectionStatus(false, INIT_FAILED).catch(() => {});
    } finally {
      resolveReady();
    }
  });

  gladys.onScanRequest(whenReady(() => hub.rediscover()));

  gladys.onSetValue(whenReady((device, feature, value) => hub.setValue(device, feature, value)));

  // The devices are published with should_poll: false (read by the hub's own
  // timer); this only serves a Gladys that would poll anyway.
  gladys.onPoll(whenReady((device) => hub.pollFromCore(device)));

  gladys.onDeviceCreated(whenReady((device) => hub.onDeviceCreated(device)));

  gladys.onConfigUpdated(
    whenReady(async (newConfig) => {
      await hub.reconfigure(normalizeConfig(newConfig));
    }),
  );

  gladys.onAction(
    'search',
    whenReady(async () => {
      logger.info('Search for Elgato lights asked from the Configuration screen');
      await hub.rediscover();
      return searchMessage(hub.summary());
    }),
  );

  gladys.onAction(
    'identify',
    whenReady(async (fields) => {
      const record = hub.resolveDevice(fields?.device);
      if (!record) {
        return localized(IDENTIFY_TEXT, 'unknown');
      }
      const name = deviceName(record);
      try {
        await hub.identify(fields.device);
      } catch (err) {
        logger.warn(`Identify: ${err.message}`);
        return localized(IDENTIFY_TEXT, 'unreachable', name);
      }
      logger.info(`${hub.label(record)} blinks (asked from the Configuration screen)`);
      return localized(IDENTIFY_TEXT, 'done', name);
    }),
  );

  for (const [key, handler] of Object.entries(SCENE_ACTIONS)) {
    gladys.onSceneAction(
      key,
      whenReady((fields) => handler(hub, { fields })),
    );
  }

  return {
    hub,
    ready,
    stop: () => hub.stop(),
  };
}
