// -----------------------------------------------------------------------------
// Normalization of the configuration (src/config.js).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, normalizeConfig, parseAddress, parseHosts } from '../src/config.js';

test('the defaults: no address, 10 s, French names', () => {
  assert.deepEqual(normalizeConfig({}), {
    hosts: [],
    invalidHosts: [],
    pollSeconds: 10,
    language: 'fr',
  });
  assert.deepEqual(normalizeConfig(null), normalizeConfig(DEFAULT_CONFIG));
});

test('an unknown interval or language falls back to the default', () => {
  const config = normalizeConfig({ poll_interval: '7', language: 'it' });
  assert.equal(config.pollSeconds, 10);
  assert.equal(config.language, 'fr');
  assert.equal(normalizeConfig({ poll_interval: '60', language: 'es' }).pollSeconds, 60);
});

test('addresses: IPv4, a name, an optional port, separators of all kinds', () => {
  const { hosts, invalid } = parseHosts(
    '192.0.2.10, 192.0.2.011;keylight.lan\n192.0.2.12:9124  http://192.0.2.13/elgato 300.1.1.1 1.2.3 bad_name 192.0.2.10:70000',
  );
  assert.deepEqual(hosts, [
    { host: '192.0.2.10', port: 9123 },
    { host: '192.0.2.11', port: 9123 },
    { host: 'keylight.lan', port: 9123 },
    { host: '192.0.2.12', port: 9124 },
    { host: '192.0.2.13', port: 9123 },
  ]);
  assert.deepEqual(invalid, ['300.1.1.1', '1.2.3', 'bad_name', '192.0.2.10:70000']);
  assert.deepEqual(parseHosts('192.0.2.10 192.0.2.10:9123').hosts, [
    { host: '192.0.2.10', port: 9123 },
  ]);
  assert.equal(parseAddress('Elgato-Key-Light.local').host, 'elgato-key-light.local');
  assert.deepEqual(parseHosts(undefined), { hosts: [], invalid: [] });
});
