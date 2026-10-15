// -----------------------------------------------------------------------------
// Capabilities and unit conversions of the Elgato lights (src/elgato/model.js).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  KELVIN_MAX,
  KELVIN_MIN,
  MIRED_MAX,
  MIRED_MIN,
  capabilitiesOf,
  hsToRgbInt,
  kelvinToMired,
  miredToKelvin,
  normalizeMac,
  pickInfo,
  platformId,
  rgbIntToHs,
} from '../src/elgato/model.js';
import { FIXTURE_NAMES, loadFixture } from './helpers/fakeElgato.js';

const capsOf = (name) => {
  const fixture = loadFixture(name);
  return capabilitiesOf({
    info: fixture.info,
    settings: fixture.settings,
    state: fixture.lights.lights[0],
  });
};

test('capabilities of every fixture: colour for the strips, battery for the Mini', () => {
  const expected = {
    'key-light-1.0.3': { color: false, battery: false },
    'key-light-air-1.0.3': { color: false, battery: false },
    'key-light-mini-1.0.4': { color: false, battery: true },
    'key-light-mini-on-battery-1.0.4': { color: false, battery: true },
    'light-strip-color-1.0.4': { color: true, battery: false },
    'light-strip-white-1.0.3': { color: true, battery: false },
    'ring-light-constructed': { color: false, battery: false },
  };
  assert.deepEqual(Object.keys(expected), FIXTURE_NAMES);
  for (const name of FIXTURE_NAMES) {
    assert.deepEqual(capsOf(name), expected[name], name);
  }
});

test('a light is colour by name, by its power-on hue or by a hue in its state', () => {
  const info = { productName: 'Elgato Light Strip Pro' };
  assert.equal(capabilitiesOf({ info }).color, true);
  assert.equal(capabilitiesOf({ info: {}, settings: { powerOnHue: 0 } }).color, true);
  assert.equal(capabilitiesOf({ info: {}, state: { hue: 12 } }).color, true);
  assert.equal(capabilitiesOf({ info: { productName: 'Elgato Key Light' } }).color, false);
});

test('pickInfo keeps what identifies the light, never the Wi-Fi network', () => {
  const info = pickInfo(loadFixture('key-light-1.0.3').info);
  assert.deepEqual(info, {
    productName: 'Elgato Key Light',
    serialNumber: 'CN00A0A00001',
    firmwareVersion: '1.0.3',
    firmwareBuildNumber: 218,
    hardwareBoardType: 53,
    displayName: 'Desk left',
    macAddress: '3c:6a:9d:00:00:01',
  });
  assert.ok(!JSON.stringify(info).includes('example-ssid'));
  assert.equal(pickInfo(null).productName, 'Elgato Light');
});

test('the id is the serial number, lowercased, letters and digits only', () => {
  assert.equal(platformId({ serialNumber: 'CN00A0A00001' }), 'cn00a0a00001');
  assert.equal(platformId({ serialNumber: ' gw-00 l0a ' }), 'gw00l0a');
  assert.equal(platformId({ serialNumber: '' }), null);
  assert.equal(platformId({}), null);
  assert.equal(normalizeMac('3C-6A-9D-00-00-01'), '3c:6a:9d:00:00:01');
  assert.equal(normalizeMac('nope'), null);
});

test('colour temperature: mireds 143-344 are 7000-2900 K, rounded to 10 K', () => {
  assert.equal(miredToKelvin(MIRED_MIN), 6990);
  assert.equal(miredToKelvin(MIRED_MAX), 2910);
  assert.equal(miredToKelvin(297), 3370);
  assert.equal(miredToKelvin(1000), KELVIN_MIN);
  assert.equal(miredToKelvin(100), KELVIN_MAX);
  assert.equal(kelvinToMired(KELVIN_MIN), MIRED_MAX);
  assert.equal(kelvinToMired(KELVIN_MAX), MIRED_MIN);
  assert.equal(kelvinToMired(4500), 222);
  assert.equal(kelvinToMired(1000), MIRED_MAX);
  assert.equal(kelvinToMired(10000), MIRED_MIN);
  // Every mired value survives the trip through kelvins.
  for (let mired = MIRED_MIN; mired <= MIRED_MAX; mired += 1) {
    assert.ok(Math.abs(kelvinToMired(miredToKelvin(mired)) - mired) <= 1, `mired ${mired}`);
  }
});

test('hue and saturation to RGB at full value, and back', () => {
  assert.equal(hsToRgbInt(0, 100), 0xff0000);
  assert.equal(hsToRgbInt(120, 100), 0x00ff00);
  assert.equal(hsToRgbInt(240, 100), 0x0000ff);
  assert.equal(hsToRgbInt(0, 0), 0xffffff);
  assert.equal(hsToRgbInt(360, 100), 0xff0000);
  assert.deepEqual(rgbIntToHs(0xff0000), { hue: 0, saturation: 100 });
  assert.deepEqual(rgbIntToHs(0x00ff00), { hue: 120, saturation: 100 });
  assert.deepEqual(rgbIntToHs(0x0000ff), { hue: 240, saturation: 100 });
  assert.deepEqual(rgbIntToHs(0xffffff), { hue: 0, saturation: 0 });
  assert.deepEqual(rgbIntToHs(0x000000), { hue: 0, saturation: 0 });
  // A darker red is the same hue and saturation: the darkness is brightness.
  assert.deepEqual(rgbIntToHs(0x800000), { hue: 0, saturation: 100 });
  for (const [hue, saturation] of [
    [30, 50],
    [200, 80],
    [358, 6],
  ]) {
    // 8 bits per channel: a pale colour loses a little hue (358 comes back 0).
    const back = rgbIntToHs(hsToRgbInt(hue, saturation));
    const hueGap = Math.min(Math.abs(back.hue - hue), 360 - Math.abs(back.hue - hue));
    assert.ok(hueGap <= 2 && Math.abs(back.saturation - saturation) <= 1, `${hue}/${saturation}`);
  }
});
