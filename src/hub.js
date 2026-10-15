// -----------------------------------------------------------------------------
// The Elgato hub: finds the lights, reads them at the configured pace,
// publishes their devices and states to Gladys, and runs the commands.
//
// Polling only: the Elgato API pushes nothing. The hub reads every light the
// user added to Gladys (GET /elgato/lights, plus /elgato/battery-info on a Key
// Light Mini), every 10 s by default like Home Assistant. Gladys does not
// poll these devices (should_poll: false, GladysAssistant/Gladys#3198); its
// onPoll, if it ever comes, is served unless the timer just read the light.
// -----------------------------------------------------------------------------

import { GladysApiError, createLogger } from '@gladysassistant/integration-sdk';
import {
  FEATURE_KEYS,
  applyCommand,
  buildDevice,
  commandFor,
  deviceIds,
  deviceName,
  deviceValues,
  featureSpecs,
} from './devices.js';
import { MDNS_SERVICE, SCAN_TIMEOUT_SECONDS, mapLimit, parseMdnsServices } from './discovery.js';
import { ELGATO_PORT } from './elgato/client.js';
import {
  BRIGHTNESS_MAX,
  BRIGHTNESS_MIN,
  KELVIN_MAX,
  KELVIN_MIN,
  capabilitiesOf,
  clamp,
  kelvinToMired,
  pickInfo,
  platformId,
} from './elgato/model.js';
import { ProblemLog } from './problems.js';
import { CONNECTION_TEXT } from './texts.js';

const logger = createLogger({ name: 'elgato-hub' });

export const HUB_TIMINGS = {
  // New search, to follow DHCP changes and find new lights (Home Assistant
  // follows DHCP; mDNS every 15 minutes is the equivalent here).
  rediscoveryMs: 15 * 60_000,
  // Reads in a row without answer before a light is "unreachable".
  unreachableAfter: 2,
  // An unchanged value is published again after this long: Gladys shows "no
  // recent value" past 48 h.
  heartbeatMs: 6 * 60 * 60_000,
};

// A read asked by the Gladys scheduler (onPoll) is skipped when the timer
// read the light less than this share of the interval ago, and the timer
// skips a light onPoll just read (half an interval).
const CORE_POLL_GAP = 0.9;
const TIMER_POLL_GAP = 0.5;

const PROBE_CONCURRENCY = 8;
const POLL_CONCURRENCY = 8;

const isNumber = (value) => typeof value === 'number' && Number.isFinite(value);

/**
 * Gladys refused a call or did not answer (restart, network, rate limit): a
 * passing condition, unlike a bug in the integration.
 */
const isGladysFailure = (err) =>
  err instanceof GladysApiError ||
  err?.name === 'TimeoutError' ||
  err?.name === 'AbortError' ||
  (err instanceof TypeError && err.message === 'fetch failed');

/** "fetch failed (ECONNREFUSED)": the low-level code Node hides in `cause`. */
const describe = (err) => {
  const code = err?.cause?.code;
  return code && !err.message.includes(code) ? `${err.message} (${code})` : err.message;
};

const isGiven = (value) => value !== undefined && value !== null && String(value).trim() !== '';

export class ElgatoHub {
  /**
   * @param {object} options
   * @param {object} options.gladys GladysIntegration (or the SDK's fake)
   * @param {object} options.store persistence (src/store.js)
   * @param {object} options.client ElgatoClient
   * @param {boolean} [options.timers] periodic timers (off in tests)
   * @param {object} [options.timings] HUB_TIMINGS overrides
   * @param {() => number} [options.now]
   */
  constructor({ gladys, store, client, timers = true, timings, now = () => Date.now() }) {
    this.gladys = gladys;
    this.store = store;
    this.client = client;
    this.timersEnabled = timers;
    this.timings = { ...HUB_TIMINGS, ...timings };
    this.now = now;
    this.config = null;
    /** @type {Map<string, object>} light records, by serial-number id */
    this.records = new Map();
    this.pending = new Set();
    this.pollTimer = null;
    this.rediscoveryTimer = null;
    this.polling = null;
    this.discovering = null;
    this.lastScan = { status: 'not-run', found: 0 };
    this.stopped = false;
    // Repeated failures (Gladys refusing, a light answering errors): one
    // line when they start and one when they end.
    this.problems = new ProblemLog(logger);
  }

  // --- Lifecycle -------------------------------------------------------------

  async start(config) {
    this.config = config;
    await this.restore();
    await this.discover();
    await this.publishDevices();
    await this.publishAllStates();
    await this.publishTransports();
    await this.publishConnectionStatus();
    this.startTimers();
  }

  /** Gladys came back (restart, network): it may have lost what was published. */
  async resync(config) {
    this.config = config;
    this.gladys.forgetPublishedStates();
    this.seedFromGladys();
    await this.publishDevices();
    await this.publishAllStates();
    await this.publishTransports();
    await this.publishConnectionStatus();
    this.gladysRecovered();
  }

  async reconfigure(config) {
    const previous = this.config;
    this.config = config;
    const addresses = (list) => list.map(({ host, port }) => `${host}:${port}`).join(',');
    if (!previous || addresses(previous.hosts) !== addresses(config.hosts)) {
      await this.discover();
    }
    if (previous && previous.pollSeconds !== config.pollSeconds) {
      this.startTimers();
    }
    // New lights, or names in another language for the Discovery list.
    await this.publishDevices();
    await this.publishAllStates();
    await this.publishTransports();
    await this.publishConnectionStatus();
  }

  startTimers() {
    if (!this.timersEnabled || this.stopped) {
      return;
    }
    clearInterval(this.pollTimer);
    clearInterval(this.rediscoveryTimer);
    this.pollTimer = setInterval(() => this.track(this.pollAll()), this.config.pollSeconds * 1000);
    this.rediscoveryTimer = setInterval(
      () => this.track(this.rediscover()),
      this.timings.rediscoveryMs,
    );
  }

  async stop() {
    this.stopped = true;
    clearInterval(this.pollTimer);
    clearInterval(this.rediscoveryTimer);
    await this.idle();
    await this.store.flush();
  }

  /** Keep track of background work, so the tests (and stop) can wait for it. */
  track(promise) {
    const tracked = Promise.resolve(promise)
      .catch((err) => this.backgroundFailed(err))
      .finally(() => this.pending.delete(tracked));
    this.pending.add(tracked);
    return tracked;
  }

  /**
   * A periodic task failed. Gladys refusing or away is said once until it
   * accepts again; a bug is logged with its stack, once per message.
   */
  backgroundFailed(err) {
    if (isGladysFailure(err)) {
      this.problems.fail('gladys', `Gladys does not take the Elgato updates: ${describe(err)}`);
    } else {
      this.problems.fail(`bug:${err?.message}`, 'Background task failed', 'error', err);
    }
  }

  gladysRecovered() {
    this.problems.recover('gladys', 'Gladys takes the Elgato updates again');
  }

  /** Resolves once no background work is left. */
  async idle() {
    while (this.pending.size > 0) {
      await Promise.all([...this.pending]);
    }
  }

  // --- Persistence -----------------------------------------------------------

  async restore() {
    const data = await this.store.load();
    for (const [id, saved] of Object.entries(data.lights ?? {})) {
      if (!saved || typeof saved.host !== 'string' || !saved.info || !saved.caps) {
        continue;
      }
      const info = pickInfo(saved.info);
      if (platformId(info) !== id) {
        continue;
      }
      const record = this.createRecord(id, saved.host, saved.port);
      record.info = info;
      record.caps = { color: saved.caps.color === true, battery: saved.caps.battery === true };
      this.records.set(id, record);
    }
    this.seedFromGladys();
  }

  /**
   * The lights added to Gladys that /data does not know (a volume lost, a
   * reinstall): their address and model are in the Gladys device.
   */
  seedFromGladys() {
    const prefix = deviceIds(this.gladys, '').device;
    for (const device of this.gladys.devices ?? []) {
      const id = device?.external_id?.startsWith(prefix)
        ? device.external_id.slice(prefix.length)
        : null;
      if (!id || this.records.has(id)) {
        continue;
      }
      const param = (name) => (device.params ?? []).find((entry) => entry.name === name)?.value;
      const host = param('IP_ADDRESS');
      if (typeof host !== 'string' || host === '') {
        continue;
      }
      const port = Number(param('PORT') ?? ELGATO_PORT);
      const keys = (device.features ?? []).map((feature) =>
        String(feature.external_id ?? '').slice(device.external_id.length + 1),
      );
      const record = this.createRecord(id, host, Number.isInteger(port) ? port : ELGATO_PORT);
      record.info = pickInfo({
        productName: device.model,
        serialNumber: param('SERIAL_NUMBER') ?? id,
        firmwareVersion: param('FIRMWARE'),
        macAddress: param('MAC_ADDRESS'),
      });
      record.caps = {
        color: keys.includes(FEATURE_KEYS.HUE),
        battery: keys.includes(FEATURE_KEYS.BATTERY),
      };
      this.records.set(id, record);
    }
  }

  save() {
    const lights = {};
    for (const record of this.records.values()) {
      lights[record.id] = {
        host: record.host,
        port: record.port,
        info: record.info,
        caps: record.caps,
      };
    }
    return this.store.save({ lights });
  }

  // --- Discovery -------------------------------------------------------------

  createRecord(id, host, port = ELGATO_PORT) {
    return {
      id,
      host,
      port,
      info: null,
      caps: null,
      state: null,
      battery: null,
      // null until the first answer or the first search without one.
      reachable: null,
      failures: 0,
      lastReadAt: null,
      // Bumped on every command: a reading started before it is stale.
      commandSeq: 0,
      sentKelvin: null,
      sentColor: null,
    };
  }

  /**
   * Search through the Gladys core, then probe the typed, found and known
   * addresses. Resolves with the number of lights answering.
   */
  discover() {
    this.discovering ??= this.runDiscovery().finally(() => {
      this.discovering = null;
    });
    return this.discovering;
  }

  async runDiscovery() {
    // Priority when one light answers on several addresses: the typed one,
    // then the one mDNS found, then the one known from before.
    const targets = [];
    const add = ({ host, port }) => {
      if (!targets.some((target) => target.host === host && target.port === port)) {
        targets.push({ host, port });
      }
    };
    this.config.hosts.forEach(add);
    (await this.scan()).forEach(add);
    [...this.records.values()].forEach(add);

    const results = await mapLimit(targets, PROBE_CONCURRENCY, (target) => this.probe(target));
    const answers = new Map();
    results.forEach((result, index) => {
      const { host, port } = targets[index];
      if (result.error) {
        logger.debug(`No Elgato answer from ${host}:${port}: ${result.error.message}`);
      } else if (!answers.has(result.value.id)) {
        answers.set(result.value.id, result.value);
      }
    });
    for (const answer of answers.values()) {
      const record = this.adopt(answer);
      await this.applyReading(record, answer.state, answer.battery);
    }
    for (const record of this.records.values()) {
      if (!answers.has(record.id) && record.reachable === null) {
        // Known from before, silent since the start: unreachable, quietly.
        record.reachable = false;
      }
    }
    await this.save();
    return answers.size;
  }

  /** One mDNS browse through the Gladys core: `[{ host, port }]`. */
  async scan() {
    try {
      const found = parseMdnsServices(
        await this.gladys.scanNetwork('mdns', { timeoutSeconds: SCAN_TIMEOUT_SECONDS }),
      );
      this.lastScan = { status: 'ok', found: found.length };
      this.problems.recover('scan', 'Elgato discovery through Gladys works again');
      return found;
    } catch (err) {
      // 403: a core without mediated discovery; 409 or 429: a scan is
      // already running. The typed and known addresses still work.
      // Said once, not at every rediscovery; "busy" passes by itself.
      const status = err.status === 429 || err.status === 409 ? 'busy' : 'unavailable';
      const message = `Elgato discovery through Gladys (mDNS ${MDNS_SERVICE}) failed: ${describe(err)}`;
      if (status === 'busy') {
        logger.debug(message);
      } else {
        this.problems.fail('scan', message);
      }
      this.lastScan = { status, found: 0 };
      return [];
    }
  }

  /**
   * Ask one address what it is: `{ host, port, id, info, caps, state,
   * battery }`. The settings of a light already known (same firmware) are not
   * asked again.
   */
  async probe(target) {
    const info = pickInfo(await this.client.info(target));
    const id = platformId(info);
    if (!id) {
      throw new Error(`${target.host}:${target.port} answered without a serial number`);
    }
    const known = this.records.get(id);
    const state = await this.client.state(target);
    let caps;
    if (known?.caps && known.info?.firmwareVersion === info.firmwareVersion) {
      caps = { ...known.caps };
      // A strip known as white-only from an old answer learns its colours.
      caps.color = caps.color || capabilitiesOf({ info, state }).color;
    } else {
      caps = capabilitiesOf({ info, settings: await this.client.settings(target), state });
    }
    const battery = caps.battery ? await this.optionalBattery(target) : null;
    return { ...target, id, info, caps, state, battery };
  }

  /** The battery of a Key Light Mini, or null when it does not answer it. */
  async optionalBattery(target) {
    try {
      return await this.client.battery(target);
    } catch (err) {
      if (err.unreachable) {
        throw err;
      }
      logger.debug(`No battery answer from ${target.host}: ${err.message}`);
      return null;
    }
  }

  /** Take a probe answer: a new light is added, a known one may have moved. */
  adopt(answer) {
    let record = this.records.get(answer.id);
    if (!record) {
      record = this.createRecord(answer.id, answer.host, answer.port);
      this.records.set(answer.id, record);
      logger.info(
        `${answer.info.productName} ${answer.info.serialNumber} found at ${answer.host}:${answer.port}`,
      );
    } else if (record.host !== answer.host || record.port !== answer.port) {
      logger.info(
        `${this.label(record)} moved from ${record.host}:${record.port} to ${answer.host}:${answer.port}`,
      );
    }
    Object.assign(record, {
      host: answer.host,
      port: answer.port,
      info: answer.info,
      caps: answer.caps,
    });
    return record;
  }

  async rediscover() {
    await this.discover();
    // New lights, and new addresses (DHCP) for the params of the created
    // devices.
    await this.publishDevices();
    await this.publishTransports();
    await this.publishConnectionStatus();
    this.gladysRecovered();
  }

  // --- Devices ---------------------------------------------------------------

  async publishDevices() {
    const devices = [...this.records.values()]
      .filter((record) => record.info && record.caps)
      .map((record) => buildDevice(this.gladys, record, this.config.language));
    await this.gladys.publishDiscoveredDevices(devices);
  }

  /** The record behind a Gladys device external id, or null. */
  resolveDevice(externalId) {
    if (typeof externalId !== 'string') {
      return null;
    }
    const prefix = deviceIds(this.gladys, '').device;
    if (!externalId.startsWith(prefix)) {
      return null;
    }
    return this.records.get(externalId.slice(prefix.length)) ?? null;
  }

  isCreated(record) {
    const id = deviceIds(this.gladys, record.id).device;
    return (this.gladys.devices ?? []).some((device) => device.external_id === id);
  }

  require(externalId) {
    const record = this.resolveDevice(externalId);
    if (!record) {
      throw new Error(`Unknown Elgato light ${externalId}`);
    }
    return record;
  }

  // --- States ----------------------------------------------------------------

  /**
   * Publish what changed for one light, if the user created it (Gladys caps
   * states at 300 a minute and re-evaluates scenes on each one). The SDK
   * sends only the changed values, and an unchanged one again after the
   * heartbeat.
   */
  async publishStates(record) {
    if (!record.caps || !this.isCreated(record)) {
      return;
    }
    const ids = deviceIds(this.gladys, record.id);
    const values = deviceValues(record);
    const states = featureSpecs(record.caps, this.config.language)
      .filter((spec) => values[spec.key] !== undefined)
      .map((spec) => ({
        device_feature_external_id: ids.feature(spec.key),
        state: values[spec.key],
      }));
    const { count } = await this.gladys.publishChangedStates(states, {
      heartbeat: this.timings.heartbeatMs,
    });
    if (count > 0) {
      logger.debug(`${this.label(record)}: ${count} state(s) sent to Gladys`);
    }
  }

  async publishAllStates() {
    for (const record of this.records.values()) {
      try {
        await this.publishStates(record);
      } catch (err) {
        logger.debug(`Cannot publish the states of ${record.id}: ${err.message}`);
        this.backgroundFailed(err);
      }
    }
  }

  /**
   * The user added a device: the states sent before were dropped by Gladys,
   * and so was the transport badge. Read the light and send them again.
   */
  async onDeviceCreated(device) {
    const record = this.resolveDevice(device?.external_id);
    if (!record) {
      return;
    }
    this.gladys.forgetPublishedStates(device.external_id);
    await this.refresh(record, { minGap: 0 });
    await this.publishStates(record);
    await this.publishTransports([record]);
  }

  async publishTransports(records = [...this.records.values()]) {
    const entries = records
      .filter((record) => this.isCreated(record))
      .map((record) => ({
        external_id: deviceIds(this.gladys, record.id).device,
        transport: record.reachable === true ? 'local' : 'unreachable',
      }));
    for (let at = 0; at < entries.length; at += 100) {
      await this.gladys.publishTransports(entries.slice(at, at + 100));
    }
  }

  async publishConnectionStatus() {
    const records = [...this.records.values()];
    if (records.length === 0) {
      await this.gladys.setConnectionStatus(false, CONNECTION_TEXT.noDevice);
    } else if (!records.some((record) => record.reachable === true)) {
      await this.gladys.setConnectionStatus(false, CONNECTION_TEXT.noAnswer);
    } else {
      await this.gladys.setConnectionStatus(true);
    }
  }

  // --- Polling -----------------------------------------------------------------

  /** Read every light added to Gladys once (the timer's job). */
  pollAll() {
    this.polling ??= mapLimit(
      [...this.records.values()].filter((record) => this.isCreated(record)),
      POLL_CONCURRENCY,
      (record) => this.refresh(record, { minGap: TIMER_POLL_GAP }),
    )
      .then((results) => {
        // A light that does not answer is handled by refresh; what is left
        // is Gladys refusing the states (or a bug).
        const errors = results.filter((result) => result.error).map((result) => result.error);
        errors.forEach((err) => this.backgroundFailed(err));
        if (errors.length === 0) {
          this.gladysRecovered();
        }
      })
      .finally(() => {
        this.polling = null;
      });
    return this.polling;
  }

  /** The Gladys scheduler asks for a reading (should not happen, should_poll is false). */
  async pollFromCore(device) {
    const record = this.resolveDevice(device?.external_id);
    if (record) {
      await this.refresh(record, { minGap: CORE_POLL_GAP });
    }
  }

  /**
   * Read one light and publish what changed. Skipped when it was read less
   * than `minGap` intervals ago.
   */
  async refresh(record, { minGap = 0 } = {}) {
    const periodMs = this.config.pollSeconds * 1000;
    if (record.lastReadAt !== null && this.now() - record.lastReadAt < periodMs * minGap) {
      logger.debug(`${this.label(record)} read ${this.now() - record.lastReadAt} ms ago, skipped`);
      return;
    }
    record.lastReadAt = this.now();
    const seq = record.commandSeq;
    let state;
    let battery = null;
    try {
      state = await this.client.state(record);
      if (record.caps?.battery) {
        battery = await this.optionalBattery(record);
      }
    } catch (err) {
      if (err.unreachable) {
        await this.failed(record);
      } else {
        this.problems.fail(
          `read:${record.id}`,
          `Cannot read ${this.label(record)} at ${record.host}: ${err.message}`,
        );
      }
      return;
    }
    this.problems.recover(`read:${record.id}`, `${this.label(record)} reads again`);
    if (seq !== record.commandSeq) {
      // A Gladys command ran meanwhile: this reading may predate it.
      return;
    }
    await this.applyReading(record, state, battery);
  }

  /** A fresh reading: publish what changed, follow the reachability. */
  async applyReading(record, state, battery) {
    record.state = state && typeof state === 'object' ? state : {};
    logger.debug(
      `${this.label(record)}: ${JSON.stringify(record.state)}${battery ? ` battery ${JSON.stringify(pickBattery(battery))}` : ''}`,
    );
    if (battery && typeof battery === 'object') {
      record.battery = battery;
    }
    if (record.caps && !record.caps.color && isNumber(record.state.hue)) {
      // A colour light the first answers did not reveal: published again
      // with its colour features, Gladys offers "Update" in Discovery.
      record.caps = { ...record.caps, color: true };
      this.track(this.publishDevices());
      this.track(this.save());
    }
    record.failures = 0;
    if (record.reachable !== true) {
      if (record.reachable === false) {
        logger.info(`${this.label(record)} answers again at ${record.host}`);
      }
      record.reachable = true;
      await this.publishTransports([record]);
      await this.publishConnectionStatus();
    }
    await this.publishStates(record);
  }

  /**
   * A reading without answer. After a few in a row the light is unreachable:
   * its badge says so, its last state stays (Elgato lights are known to drop
   * off the Wi-Fi while still lit, so "off" would often be wrong).
   */
  async failed(record) {
    if (this.stopped) {
      return;
    }
    record.failures += 1;
    if (record.failures < this.timings.unreachableAfter || record.reachable === false) {
      return;
    }
    record.reachable = false;
    logger.info(`${this.label(record)} no longer answers at ${record.host}`);
    await this.publishTransports([record]);
    await this.publishConnectionStatus();
  }

  label(record) {
    return record.info ? `${record.info.productName} ${record.info.serialNumber}` : record.id;
  }

  // --- Commands ----------------------------------------------------------------

  /** Send a PUT /elgato/lights, then publish the state it gives without waiting. */
  async send(record, light, { sentKelvin, sentColor } = {}) {
    record.commandSeq += 1;
    let answer;
    try {
      answer = await this.client.setLight(record, light);
    } catch (err) {
      if (err.unreachable) {
        await this.failed(record);
        throw new Error(`${this.label(record)} does not answer at ${record.host}`, { cause: err });
      }
      throw err;
    }
    if (sentKelvin !== undefined) {
      record.sentKelvin = sentKelvin;
    }
    if (sentColor !== undefined) {
      record.sentColor = sentColor;
    }
    // The light answers with its new state; read back at the next poll anyway.
    const next = answer && isNumber(answer.on) ? answer : applyCommand(record.state ?? {}, light);
    await this.applyReading(record, next, null);
  }

  /** A Gladys command on a feature of one of the lights. */
  async setValue(device, feature, value) {
    const record = this.require(device?.external_id);
    const prefix = `${device.external_id}:`;
    const key = feature?.external_id?.startsWith(prefix)
      ? feature.external_id.slice(prefix.length)
      : null;
    const { light, sentKelvin, sentColor } = commandFor(record, key, value);
    logger.debug(`${this.label(record)}: ${key} = ${value}`);
    await this.send(record, light, { sentKelvin, sentColor });
  }

  /** Make a light blink (POST /elgato/identify). */
  async identify(deviceExternalId) {
    const record = this.require(deviceExternalId);
    try {
      await this.client.identify(record);
    } catch (err) {
      if (err.unreachable) {
        await this.failed(record);
        throw new Error(`${this.label(record)} does not answer at ${record.host}`, { cause: err });
      }
      throw err;
    }
    return record;
  }

  /**
   * Turn a light on with a brightness (1-100 %) and a colour temperature
   * (2900-7000 K), both optional, in one request: the light does not show
   * its previous setting first.
   */
  async setLighting(deviceExternalId, { brightness, temperature }) {
    const record = this.require(deviceExternalId);
    const light = { on: 1 };
    let sentKelvin;
    if (isGiven(brightness)) {
      const number = Number(brightness);
      if (!Number.isFinite(number)) {
        throw new Error(`Invalid brightness "${brightness}"`);
      }
      light.brightness = clamp(Math.round(number), BRIGHTNESS_MIN, BRIGHTNESS_MAX);
    }
    if (isGiven(temperature)) {
      const number = Number(temperature);
      if (!Number.isFinite(number)) {
        throw new Error(`Invalid colour temperature "${temperature}"`);
      }
      const kelvin = clamp(Math.round(number), KELVIN_MIN, KELVIN_MAX);
      light.temperature = kelvinToMired(kelvin);
      sentKelvin = { mired: light.temperature, value: kelvin };
    }
    await this.send(record, light, { sentKelvin });
    return record;
  }

  /** What the Configuration screen's "Search" action reports. */
  summary() {
    return {
      scan: this.lastScan.status,
      invalidHosts: this.config.invalidHosts,
      devices: [...this.records.values()]
        .filter((record) => record.info)
        .map((record) => ({
          name: deviceName(record),
          host: record.host,
          product: record.info.productName,
          reachable: record.reachable === true,
        })),
    };
  }
}

/** The battery figures worth a debug line. */
function pickBattery(battery) {
  const { level, status, powerSource } = battery;
  return { level, status, powerSource };
}
