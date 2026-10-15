// -----------------------------------------------------------------------------
// The mDNS answers relayed by the Gladys core (src/discovery.js).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapLimit, parseMdnsServices } from '../src/discovery.js';

const answer = (overrides = {}) => ({
  name: 'Elgato Key Light 0001._elg._tcp.local',
  host: 'elgato-key-light-0001.local',
  addresses: ['fe80::3e6a:9dff:fe00:1', '192.0.2.10'],
  port: 9123,
  txt: ['mf=Elgato', 'dt=53', 'id=3C:6A:9D:00:00:01', 'md=Elgato Key Light 20GAK9901', 'pv=1.0'],
  ...overrides,
});

test('an mDNS answer gives the IPv4 address, the port and the TXT hints', () => {
  assert.deepEqual(parseMdnsServices([answer()]), [
    {
      host: '192.0.2.10',
      port: 9123,
      mac: '3c:6a:9d:00:00:01',
      model: 'Elgato Key Light 20GAK9901',
    },
  ]);
});

test('IPv6-only, malformed and duplicate answers are dropped; a missing port is 9123', () => {
  const found = parseMdnsServices([
    answer({ addresses: ['fe80::1'] }),
    answer({ addresses: [] }),
    null,
    'garbage',
    answer(),
    answer({ name: 'twice' }),
    answer({ addresses: ['192.0.2.11'], port: null, txt: undefined }),
  ]);
  assert.deepEqual(found, [
    {
      host: '192.0.2.10',
      port: 9123,
      mac: '3c:6a:9d:00:00:01',
      model: 'Elgato Key Light 20GAK9901',
    },
    { host: '192.0.2.11', port: 9123, mac: null, model: null },
  ]);
  assert.deepEqual(parseMdnsServices(undefined), []);
});

test('mapLimit keeps the order and the errors, with bounded concurrency', async () => {
  let running = 0;
  let peak = 0;
  const results = await mapLimit([1, 2, 3, 4, 5], 2, async (n) => {
    running += 1;
    peak = Math.max(peak, running);
    await new Promise((resolve) => setTimeout(resolve, 5));
    running -= 1;
    if (n === 3) {
      throw new Error('three');
    }
    return n * 10;
  });
  assert.equal(peak, 2);
  assert.deepEqual(
    results.map((result) => result.value ?? result.error.message),
    [10, 20, 'three', 40, 50],
  );
});
