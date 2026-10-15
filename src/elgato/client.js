// -----------------------------------------------------------------------------
// The local HTTP API of the Elgato lights (port 9123, no authentication), as
// python-elgato and the Elgato Control Center use it:
//
//   GET  /elgato/accessory-info   product, serial number, firmware, MAC
//   GET  /elgato/lights/settings  power-on defaults, `battery` on a Key Light Mini
//   GET  /elgato/lights           { numberOfLights, lights: [{ on, brightness, ... }] }
//   PUT  /elgato/lights           same shape, only the keys to change
//   GET  /elgato/battery-info     Key Light Mini only
//   POST /elgato/identify         the light blinks
//
// One request at a time per light, each on its own connection (no keep-alive):
// the light's small HTTP server is known to get stuck under parallel traffic
// (Home Assistant serializes its calls too).
// -----------------------------------------------------------------------------

import http from 'node:http';

export const ELGATO_PORT = 9123;

export const CLIENT_TIMINGS = {
  // python-elgato waits 8 s; a light that answers at all answers in well
  // under a second.
  timeoutMs: 5_000,
};

// Answers are a few hundred bytes: anything much bigger is not an Elgato.
const MAX_BODY_BYTES = 64 * 1024;

/** An Elgato light could not be reached (refused, timeout, network). */
export class ElgatoUnreachableError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'ElgatoUnreachableError';
    this.unreachable = true;
  }
}

/** The light answered, but not what was expected (HTTP error, not JSON). */
export class ElgatoResponseError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'ElgatoResponseError';
    this.status = status;
  }
}

export class ElgatoClient {
  /**
   * @param {object} [options]
   * @param {object} [options.timings] CLIENT_TIMINGS overrides
   */
  constructor({ timings } = {}) {
    this.timings = { ...CLIENT_TIMINGS, ...timings };
    /** @type {Map<string, Promise>} the last request queued, per light */
    this.queues = new Map();
  }

  info(target) {
    return this.request(target, 'GET', 'accessory-info');
  }

  settings(target) {
    return this.request(target, 'GET', 'lights/settings');
  }

  /** The state of the (single) light: `{ on, brightness, temperature | hue, saturation }`. */
  async state(target) {
    return firstLight(await this.request(target, 'GET', 'lights'));
  }

  battery(target) {
    return this.request(target, 'GET', 'battery-info');
  }

  /**
   * Change the light: only the keys given. Resolves with the state the light
   * answers with, or null when its answer carries none.
   */
  async setLight(target, light) {
    const answer = await this.request(target, 'PUT', 'lights', {
      numberOfLights: 1,
      lights: [light],
    });
    try {
      return firstLight(answer);
    } catch {
      return null;
    }
  }

  async identify(target) {
    await this.request(target, 'POST', 'identify');
  }

  /**
   * One request, queued behind the previous ones to the same light.
   * @param {{ host: string, port: number }} target
   */
  request(target, method, path, body) {
    const key = `${target.host}:${target.port}`;
    const previous = this.queues.get(key) ?? Promise.resolve();
    const run = previous.then(
      () => this.send(target, method, path, body),
      () => this.send(target, method, path, body),
    );
    const settled = run.catch(() => {});
    this.queues.set(key, settled);
    settled.then(() => {
      if (this.queues.get(key) === settled) {
        this.queues.delete(key);
      }
    });
    return run;
  }

  send({ host, port }, method, path, body) {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const where = `${method} /elgato/${path} on ${host}:${port}`;
    return new Promise((resolve, reject) => {
      const request = http.request(
        {
          host,
          port,
          method,
          path: `/elgato/${path}`,
          agent: false,
          timeout: this.timings.timeoutMs,
          headers: {
            Accept: 'application/json',
            Connection: 'close',
            ...(payload
              ? { 'Content-Type': 'application/json', 'Content-Length': payload.length }
              : {}),
          },
        },
        (response) => {
          const chunks = [];
          let size = 0;
          response.on('data', (chunk) => {
            size += chunk.length;
            if (size > MAX_BODY_BYTES) {
              response.destroy(new ElgatoResponseError(`${where}: answer too large`));
              return;
            }
            chunks.push(chunk);
          });
          response.on('error', (err) =>
            reject(
              err instanceof ElgatoResponseError
                ? err
                : new ElgatoUnreachableError(`${where}: ${err.message}`, { cause: err }),
            ),
          );
          response.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            if (response.statusCode < 200 || response.statusCode >= 300) {
              reject(
                new ElgatoResponseError(
                  `${where}: HTTP ${response.statusCode}`,
                  response.statusCode,
                ),
              );
              return;
            }
            if (text.trim() === '') {
              resolve(null);
              return;
            }
            try {
              resolve(JSON.parse(text));
            } catch {
              reject(new ElgatoResponseError(`${where}: the answer is not JSON`));
            }
          });
        },
      );
      request.on('timeout', () => {
        request.destroy(new Error(`no answer within ${this.timings.timeoutMs} ms`));
      });
      request.on('error', (err) => {
        const code = err.code && !err.message.includes(err.code) ? ` (${err.code})` : '';
        reject(new ElgatoUnreachableError(`${where}: ${err.message}${code}`, { cause: err }));
      });
      request.end(payload ?? undefined);
    });
  }
}

/** The first light of a `/elgato/lights` answer; the API serves one per device. */
function firstLight(answer) {
  const light = Array.isArray(answer?.lights) ? answer.lights[0] : null;
  if (!light || typeof light !== 'object') {
    throw new ElgatoResponseError('The answer of /elgato/lights holds no light');
  }
  return light;
}
