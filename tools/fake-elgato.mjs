#!/usr/bin/env node
// -----------------------------------------------------------------------------
// A fake Elgato light on this machine, to try the integration with a real
// Gladys without the hardware:
//
//   node tools/fake-elgato.mjs [fixture] [port]
//
// fixture: a file name of test/fixtures/elgato without .json (default
// key-light-1.0.3); port: 9123 by default. Then type this machine's address
// (and the port, if not 9123) in the configuration of the integration. It
// listens on every interface: stop it when done.
// -----------------------------------------------------------------------------

import { FIXTURE_NAMES, FakeElgato } from '../test/helpers/fakeElgato.js';

const [name = 'key-light-1.0.3', portText = '9123'] = process.argv.slice(2);
if (!FIXTURE_NAMES.includes(name)) {
  console.error(`Unknown fixture "${name}". Available: ${FIXTURE_NAMES.join(', ')}`);
  process.exit(2);
}
const light = new FakeElgato(name);
light.port = Number(portText);
await light.start('0.0.0.0');
console.log(`Fake ${light.info.productName} listening on port ${light.port}`);
let seen = 0;
setInterval(() => {
  for (const { method, path, body } of light.requests.slice(seen)) {
    console.log(method, path, body ? JSON.stringify(body) : '');
  }
  seen = light.requests.length;
}, 500);
