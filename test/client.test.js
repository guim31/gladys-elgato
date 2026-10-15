// -----------------------------------------------------------------------------
// The HTTP client of the Elgato API (src/elgato/client.js), against a fake
// light that is a real HTTP server.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { ElgatoClient } from '../src/elgato/client.js';
import { FakeElgato } from './helpers/fakeElgato.js';

const client = new ElgatoClient({ timings: { timeoutMs: 200 } });

async function light(t, name = 'key-light-mini-1.0.4') {
  const fake = await new FakeElgato(name).start();
  t.after(() => fake.stop());
  return fake;
}

test('reads the info, the settings, the state and the battery', async (t) => {
  const fake = await light(t);
  assert.equal((await client.info(fake.target)).serialNumber, 'GW00L0A00003');
  assert.equal((await client.settings(fake.target)).battery.bypass, 0);
  assert.deepEqual(await client.state(fake.target), { on: 1, brightness: 21, temperature: 297 });
  assert.equal((await client.battery(fake.target)).level, 78.57);
  assert.deepEqual(
    fake.requests.map((request) => `${request.method} ${request.path}`),
    [
      'GET /elgato/accessory-info',
      'GET /elgato/lights/settings',
      'GET /elgato/lights',
      'GET /elgato/battery-info',
    ],
  );
});

test('setLight sends one light and resolves with the new state; identify posts', async (t) => {
  const fake = await light(t, 'light-strip-white-1.0.3');
  const state = await client.setLight(fake.target, { on: 1, hue: 120, saturation: 80 });
  assert.deepEqual(state, { on: 1, brightness: 21, hue: 120, saturation: 80 });
  assert.deepEqual(fake.requests.at(-1).body, {
    numberOfLights: 1,
    lights: [{ on: 1, hue: 120, saturation: 80 }],
  });
  await client.identify(fake.target);
  assert.equal(fake.identified, 1);
});

test('a light that is off the network is unreachable: refused or silent', async (t) => {
  const fake = await light(t);
  await fake.stop();
  await assert.rejects(client.state(fake.target), (err) => {
    assert.equal(err.unreachable, true);
    assert.match(err.message, /ECONNREFUSED/);
    return true;
  });
  await fake.start();
  fake.mode = 'hang';
  await assert.rejects(client.state(fake.target), (err) => {
    assert.equal(err.unreachable, true);
    assert.match(err.message, /no answer within 200 ms/);
    return true;
  });
});

test('an HTTP error or an answer that is not JSON is a response error', async (t) => {
  const fake = await light(t);
  fake.mode = 'error';
  await assert.rejects(client.state(fake.target), (err) => {
    assert.equal(err.unreachable, undefined);
    assert.equal(err.status, 500);
    return true;
  });
  fake.mode = null;
  await assert.rejects(client.request(fake.target, 'GET', 'nothing-here'), /HTTP 404/);

  const server = http.createServer((request, response) => response.end('<html>'));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const target = { host: '127.0.0.1', port: server.address().port };
  await assert.rejects(client.info(target), /not JSON/);
  await assert.rejects(client.state({ ...target }), /not JSON/);
});

test('one request at a time per light, each on its own connection', async (t) => {
  let running = 0;
  let peak = 0;
  const connections = [];
  const server = http.createServer((request, response) => {
    connections.push(request.headers.connection);
    running += 1;
    peak = Math.max(peak, running);
    setTimeout(() => {
      running -= 1;
      response.end(JSON.stringify({ numberOfLights: 1, lights: [{ on: 1 }] }));
    }, 10);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const target = { host: '127.0.0.1', port: server.address().port };
  await Promise.all([
    client.state(target),
    client.state(target),
    client.setLight(target, { on: 0 }),
  ]);
  assert.equal(peak, 1);
  assert.deepEqual(connections, ['close', 'close', 'close']);
  assert.equal(client.queues.size, 0, 'nothing left queued');
});
