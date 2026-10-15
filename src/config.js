// -----------------------------------------------------------------------------
// Integration configuration: defaults (they mirror the `default` values of the
// manifest `config_schema`, see test/manifest.test.js) and normalization, so
// the rest of the code never deals with strings, blanks or `undefined`.
// -----------------------------------------------------------------------------

import { ELGATO_PORT } from './elgato/client.js';

export const LANGUAGES = ['en', 'fr', 'de', 'es'];

// Seconds between two reads of every Elgato light (`poll_interval` options).
// Home Assistant reads them every 10 s.
export const POLL_INTERVALS = [5, 10, 15, 30, 60];

export const DEFAULT_CONFIG = {
  hosts: '',
  poll_interval: '10',
  language: 'fr',
};

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
// A DNS name: labels of letters, digits and hyphens.
const HOSTNAME =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
const MAX_HOSTS = 64;

/**
 * One typed address: `192.0.2.10`, `192.0.2.10:9123` or `keylight.lan`.
 * @returns {{ host: string, port: number } | null}
 */
export function parseAddress(raw) {
  const text = String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '');
  const match = text.match(/^([^:]+)(?::(\d{1,5}))?$/);
  if (!match) {
    return null;
  }
  const [, name, portText] = match;
  const port = portText === undefined ? ELGATO_PORT : Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return null;
  }
  const ipv4 = name.match(IPV4);
  if (ipv4) {
    if (!ipv4.slice(1).every((part) => Number(part) <= 255)) {
      return null;
    }
    // Leading zeros would make another string for the same address.
    return { host: ipv4.slice(1).map(Number).join('.'), port };
  }
  // A name made of digits and dots only is a mistyped address, not a name.
  if (/^[\d.]+$/.test(name) || !HOSTNAME.test(name)) {
    return null;
  }
  return { host: name, port };
}

/**
 * Parse the manual address list (commas, semicolons, spaces or new lines).
 * @param {unknown} raw
 * @returns {{ hosts: Array<{ host: string, port: number }>, invalid: string[] }}
 */
export function parseHosts(raw) {
  const hosts = [];
  const invalid = [];
  const entries = typeof raw === 'string' ? raw.split(/[\s,;]+/) : [];
  for (const entry of entries) {
    if (!entry.trim()) {
      continue;
    }
    const address = parseAddress(entry);
    if (!address) {
      invalid.push(entry.trim());
    } else if (
      !hosts.some((known) => known.host === address.host && known.port === address.port) &&
      hosts.length < MAX_HOSTS
    ) {
      hosts.push(address);
    }
  }
  return { hosts, invalid };
}

/**
 * @param {Record<string, unknown>} raw the configuration returned by the SDK
 */
export function normalizeConfig(raw = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const { hosts, invalid } = parseHosts(
    typeof source.hosts === 'string' ? source.hosts : DEFAULT_CONFIG.hosts,
  );
  const interval = Number(source.poll_interval ?? DEFAULT_CONFIG.poll_interval);
  return {
    hosts,
    invalidHosts: invalid,
    pollSeconds: POLL_INTERVALS.includes(interval)
      ? interval
      : Number(DEFAULT_CONFIG.poll_interval),
    language: LANGUAGES.includes(source.language) ? source.language : DEFAULT_CONFIG.language,
  };
}
