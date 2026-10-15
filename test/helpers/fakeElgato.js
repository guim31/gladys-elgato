// -----------------------------------------------------------------------------
// A fake Elgato light: a real HTTP server on 127.0.0.1 that answers the local
// API from a fixture (test/fixtures/elgato), and applies the PUTs like a light
// does (a temperature clears the colour, a colour the temperature). Stopping
// it makes the light unreachable (connection refused); `hang` makes it time
// out instead.
// -----------------------------------------------------------------------------

import http from 'node:http';
import { readFileSync, readdirSync } from 'node:fs';

const FIXTURES = new URL('../fixtures/elgato/', import.meta.url);

export const FIXTURE_NAMES = readdirSync(FIXTURES)
  .filter((name) => name.endsWith('.json'))
  .map((name) => name.replace(/\.json$/, ''))
  .sort();

export function loadFixture(name) {
  return JSON.parse(readFileSync(new URL(`${name}.json`, FIXTURES), 'utf8'));
}

export class FakeElgato {
  constructor(name) {
    const fixture = loadFixture(name);
    this.name = name;
    this.info = fixture.info;
    this.settings = fixture.settings;
    this.state = structuredClone(fixture.lights.lights[0]);
    this.batteryInfo = fixture.battery ? structuredClone(fixture.battery) : null;
    /** @type {Array<{ method: string, path: string, body: any }>} */
    this.requests = [];
    this.identified = 0;
    // 'hang': accept and never answer; 'error': HTTP 500.
    this.mode = null;
    this.port = null;
    this.server = null;
  }

  get serial() {
    return this.info.serialNumber;
  }

  /** The id the integration keys the light on. */
  get id() {
    return this.serial.toLowerCase();
  }

  get target() {
    return { host: '127.0.0.1', port: this.port };
  }

  /** `127.0.0.1:<port>`, as typed in the configuration. */
  get address() {
    return `127.0.0.1:${this.port}`;
  }

  async start(interfaceAddress = '127.0.0.1') {
    this.server = http.createServer((request, response) => this.serve(request, response));
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.port ?? 0, interfaceAddress, resolve);
    });
    this.port = this.server.address().port;
    return this;
  }

  /** The light is unplugged: the connections are refused. */
  async stop() {
    if (!this.server) {
      return;
    }
    const server = this.server;
    this.server = null;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }

  /** An mDNS answer of the Gladys core for this light. */
  mdnsAnswer() {
    const suffix = this.serial.slice(-4);
    return {
      name: `${this.info.productName} ${suffix}._elg._tcp.local`,
      host: `elgato-${suffix.toLowerCase()}.local`,
      addresses: ['fe80::3e6a:9dff:fe00:1', '127.0.0.1'],
      port: this.port,
      txt: [
        'mf=Elgato',
        `dt=${this.info.hardwareBoardType}`,
        `id=${this.info.macAddress ?? '3C:6A:9D:00:00:FF'}`,
        `md=${this.info.productName} 20GAK9901`,
        'pv=1.0',
      ],
    };
  }

  serve(request, response) {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      let body;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = text;
      }
      this.requests.push({ method: request.method, path: request.url, body });
      if (this.mode === 'hang') {
        return;
      }
      if (this.mode === 'error') {
        response.writeHead(500).end('Internal error');
        return;
      }
      const answer = this.handle(request.method, request.url, body);
      if (answer === undefined) {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(answer === null ? '' : JSON.stringify(answer));
    });
  }

  handle(method, path, body) {
    const key = `${method} ${path}`;
    switch (key) {
      case 'GET /elgato/accessory-info':
        return this.info;
      case 'GET /elgato/lights/settings':
        return this.settings;
      case 'GET /elgato/lights':
        return { numberOfLights: 1, lights: [this.state] };
      case 'GET /elgato/battery-info':
        return this.batteryInfo ?? undefined;
      case 'POST /elgato/identify':
        this.identified += 1;
        return null;
      case 'PUT /elgato/lights': {
        const change = body?.lights?.[0] ?? {};
        Object.assign(this.state, change);
        if (change.temperature !== undefined && change.hue === undefined) {
          delete this.state.hue;
          delete this.state.saturation;
        }
        if (change.hue !== undefined) {
          delete this.state.temperature;
        }
        return { numberOfLights: 1, lights: [this.state] };
      }
      default:
        return undefined;
    }
  }

  /** The bodies of the PUT /elgato/lights received, in order. */
  puts() {
    return this.requests
      .filter((request) => request.method === 'PUT')
      .map((request) => request.body.lights[0]);
  }
}

/** Start one fake light per fixture name. */
export async function startLights(names) {
  return Promise.all(names.map((name) => new FakeElgato(name).start()));
}
