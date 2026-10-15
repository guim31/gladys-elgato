// -----------------------------------------------------------------------------
// Where to look for Elgato lights: the `_elg._tcp` services the Gladys core
// finds by mDNS for the integration, the addresses typed in the
// configuration, and the addresses already known.
//
// The integration container sits on a bridge network: mDNS never reaches it.
// So the core browses (mediated `mdns` discovery, service declared in the
// manifest `network_discovery`) and relays the raw answers; the integration
// then talks to each light in unicast HTTP, which crosses the bridge.
// -----------------------------------------------------------------------------

import { parseMdnsTxt } from '@gladysassistant/integration-sdk';
import { ELGATO_PORT } from './elgato/client.js';
import { normalizeMac } from './elgato/model.js';

export const MDNS_SERVICE = '_elg._tcp';
export const SCAN_TIMEOUT_SECONDS = 5;

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/**
 * Lights announced by mDNS: `[{ host, port, mac, model }]`, one per address.
 * The `.local` name is useless in the container (no mDNS there): only the
 * IPv4 addresses are kept, and an IPv6-only answer is dropped.
 * @param {Array} services raw results `[{ name, host, addresses, port, txt }]`
 */
export function parseMdnsServices(services) {
  const found = new Map();
  for (const service of Array.isArray(services) ? services : []) {
    if (!service || typeof service !== 'object') {
      continue;
    }
    const host = (Array.isArray(service.addresses) ? service.addresses : []).find(
      (address) => typeof address === 'string' && IPV4.test(address),
    );
    if (!host) {
      continue;
    }
    const port =
      Number.isInteger(service.port) && service.port > 0 && service.port <= 65535
        ? service.port
        : ELGATO_PORT;
    const txt = parseMdnsTxt(service.txt);
    const key = `${host}:${port}`;
    if (!found.has(key)) {
      found.set(key, {
        host,
        port,
        // The TXT record of an Elgato light: id (MAC), md (model), dt (board
        // type), mf (Elgato), pv. Hints only: the light's own answer decides.
        mac: normalizeMac(typeof txt.id === 'string' ? txt.id : null),
        model: typeof txt.md === 'string' ? txt.md : null,
      });
    }
  }
  return [...found.values()];
}

/**
 * Run `task` on every item, `limit` at a time; resolves with the results in
 * order (`{ value }` or `{ error }`).
 */
export async function mapLimit(items, limit, task) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      try {
        results[index] = { value: await task(items[index]) };
      } catch (error) {
        results[index] = { error };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
