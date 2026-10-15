#!/usr/bin/env node
// -----------------------------------------------------------------------------
// Read-only check of a real Elgato light, with the integration's own client
// and mapping:
//
//   node scripts/probe.mjs <ip[:port]> [more addresses...]
//
// It only reads (GET accessory-info, lights/settings, lights, battery-info):
// no PUT, no identify, nothing changes on the light. What it prints is safe
// to paste in an issue: the Wi-Fi network name is never read out, the serial
// number and the MAC address are shortened.
// -----------------------------------------------------------------------------

import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { parseAddress } from '../src/config.js';
import { buildDevice, deviceValues } from '../src/devices.js';
import { ElgatoClient } from '../src/elgato/client.js';
import { capabilitiesOf, pickInfo, platformId } from '../src/elgato/model.js';

const mask = (text) => (text ? `…${String(text).slice(-4)}` : text);

async function probe(client, target) {
  const rawInfo = await client.info(target);
  const info = pickInfo(rawInfo);
  const settings = await client.settings(target);
  const state = await client.state(target);
  const caps = capabilitiesOf({ info, settings, state });
  const battery = caps.battery ? await client.battery(target).catch((err) => err) : null;
  const id = platformId(info);

  console.log(`\n== ${target.host}:${target.port}`);
  console.log('Product        :', info.productName, `(board ${info.hardwareBoardType})`);
  console.log('Firmware       :', info.firmwareVersion, `(build ${info.firmwareBuildNumber})`);
  console.log('Serial / MAC   :', mask(info.serialNumber), '/', mask(info.macAddress));
  console.log('Id usable      :', id ? 'yes' : 'NO (no serial number)');
  console.log('Wi-Fi info     :', rawInfo['wifi-info'] ? 'present (not shown)' : 'absent');
  console.log('Capabilities   :', JSON.stringify(caps));
  console.log('Settings keys  :', Object.keys(settings ?? {}).join(', '));
  console.log('State          :', JSON.stringify(state));
  if (caps.battery) {
    console.log(
      'Battery        :',
      battery instanceof Error ? `error: ${battery.message}` : JSON.stringify(battery),
    );
  }
  if (!id) {
    return;
  }
  const record = {
    id,
    host: target.host,
    port: target.port,
    info,
    caps,
    state,
    battery: battery instanceof Error ? null : battery,
  };
  const device = buildDevice(createFakeGladys(), record, 'en');
  const values = deviceValues(record);
  console.log('Gladys device  :', device.model, `(${device.features.length} features)`);
  for (const feature of device.features) {
    const key = feature.external_id.split(':').pop();
    console.log(
      `  - ${feature.name.padEnd(18)} ${`${feature.category}/${feature.type}`.padEnd(22)}`,
      values[key] === undefined ? '(no value now)' : values[key],
    );
  }
}

const addresses = process.argv.slice(2);
if (addresses.length === 0) {
  console.error('Usage: node scripts/probe.mjs <ip[:port]> [more addresses...]');
  process.exit(2);
}
const client = new ElgatoClient({ timings: { timeoutMs: 5_000 } });
let failed = false;
for (const raw of addresses) {
  const target = parseAddress(raw);
  if (!target) {
    console.error(`\n== ${raw}: not an address`);
    failed = true;
    continue;
  }
  try {
    await probe(client, target);
  } catch (err) {
    console.error(`\n== ${target.host}:${target.port}: ${err.message}`);
    failed = true;
  }
}
process.exit(failed ? 1 : 0);
