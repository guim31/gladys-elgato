// -----------------------------------------------------------------------------
// Consistency checks between `gladys-assistant-integration.json` and the code.
// The manifest is validated by the store indexer, but nothing there can know
// which handlers the code actually registers — these tests keep both in sync.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DEFAULT_CONFIG, POLL_INTERVALS } from '../src/config.js';
import { MDNS_SERVICE } from '../src/discovery.js';
import { BRIGHTNESS_MAX, BRIGHTNESS_MIN, KELVIN_MAX, KELVIN_MIN } from '../src/elgato/model.js';
import { SCENE_ACTIONS } from '../src/scenes.js';
import { createWorld } from './helpers/world.js';

const manifest = JSON.parse(
  await readFile(new URL('../gladys-assistant-integration.json', import.meta.url), 'utf8'),
);
const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

// Every list of form fields the manifest can declare (same field grammar).
const allFields = [
  ...(manifest.config_schema ?? []),
  ...[
    ...(manifest.actions ?? []),
    ...(manifest.scene_triggers ?? []),
    ...(manifest.scene_actions ?? []),
  ].flatMap((item) => item.fields ?? []),
  ...(manifest.widgets ?? []).flatMap((widget) => widget.settings ?? []),
];

const CAPABILITY_MIN_GLADYS_VERSION = [5, 1, 0];
const CATEGORIES_MIN_GLADYS_VERSION = [4, 86, 0];

const keysOf = (list) => (list ?? []).map((entry) => entry.key);

// Minimum version of the manifest `gladys_version` range, e.g. [5, 1, 0].
function minGladysVersion() {
  const match = manifest.gladys_version.match(/>=\s*(\d+)\.(\d+)\.(\d+)/);
  assert.ok(match, 'gladys_version must declare a minimum version');
  return match.slice(1).map(Number);
}

function isAtLeast(version, required) {
  for (let i = 0; i < required.length; i += 1) {
    if (version[i] !== required[i]) {
      return version[i] > required[i];
    }
  }
  return true;
}

test('identity: name, image, cover, local transport, lighting, mDNS discovery', () => {
  assert.equal(manifest.name, 'Elgato Light');
  assert.equal(manifest.type, 'device');
  assert.match(manifest.docker_image, /^ghcr\.io\/guim31\/gladys-elgato:/);
  assert.equal(
    manifest.cover_image,
    'https://raw.githubusercontent.com/guim31/gladys-elgato/main/cover.png',
  );
  assert.deepEqual(manifest.transports, ['local']);
  assert.deepEqual(manifest.categories, ['lighting']);
  // The service the code browses must be declared, or the core answers 403.
  assert.deepEqual(manifest.network_discovery, [{ type: 'mdns', service: MDNS_SERVICE }]);
});

test('every manifest action has a handler', async (t) => {
  const world = await createWorld();
  t.after(() => world.close());
  assert.deepEqual(keysOf(manifest.actions), ['search', 'identify']);
  for (const action of manifest.actions) {
    const ack = await world.fake.action(action.key, {});
    assert.equal(ack.success, true, `${action.key}: ${ack.error}`);
  }
});

test('declaring catalog categories requires Gladys >= 4.86.0', () => {
  assert.ok(manifest.categories.length >= 1 && manifest.categories.length <= 3);
  assert.ok(isAtLeast(minGladysVersion(), CATEGORIES_MIN_GLADYS_VERSION));
});

test('scene actions, no trigger nor widget; Gladys >= 5.1.0', () => {
  // No trigger: the light's own states already trigger scenes. No widget: the
  // light panel of Gladys has every control of an Elgato light.
  assert.equal(manifest.scene_triggers, undefined);
  assert.equal(manifest.widgets, undefined);
  assert.ok(
    isAtLeast(minGladysVersion(), CAPABILITY_MIN_GLADYS_VERSION),
    `scene_actions requires gladys_version >= 5.1.0, got "${manifest.gladys_version}"`,
  );
});

test('every scene_actions key has an onSceneAction handler, and vice versa', () => {
  assert.deepEqual(keysOf(manifest.scene_actions), Object.keys(SCENE_ACTIONS));
  for (const action of manifest.scene_actions) {
    const devices = action.fields.find((field) => field.key === 'devices');
    assert.equal(devices.type, 'multi_select');
    assert.equal(devices.required, true);
    assert.deepEqual(keysOf(action.outputs), ['reached']);
  }
});

test('the number fields of set_lighting match the bounds of the code, and are optional', () => {
  const fields = manifest.scene_actions.find((action) => action.key === 'set_lighting').fields;
  const field = (key) => fields.find((entry) => entry.key === key);
  assert.deepEqual(
    [field('brightness').min, field('brightness').max],
    [BRIGHTNESS_MIN, BRIGHTNESS_MAX],
  );
  assert.deepEqual([field('temperature').min, field('temperature').max], [KELVIN_MIN, KELVIN_MAX]);
  // A scene action applies no default and requires the required fields.
  for (const key of ['brightness', 'temperature']) {
    assert.equal(field(key).required, false);
    assert.equal(field(key).default, undefined);
    // Number fields have no step: integer bounds only.
    assert.ok(Number.isInteger(field(key).min) && Number.isInteger(field(key).max));
  }
});

test('the refresh intervals of the manifest are the ones the code accepts', () => {
  const field = manifest.config_schema.find((entry) => entry.key === 'poll_interval');
  assert.deepEqual(
    field.options.map((option) => Number(option.value)),
    POLL_INTERVALS,
  );
});

test('config_schema defaults stay consistent with DEFAULT_CONFIG', () => {
  for (const field of manifest.config_schema) {
    if (field.default !== undefined) {
      assert.equal(
        DEFAULT_CONFIG[field.key],
        field.default,
        `DEFAULT_CONFIG.${field.key} must match the manifest default`,
      );
    }
  }
  assert.equal(DEFAULT_CONFIG.language, 'fr');
});

test('section fields are purely presentational', () => {
  const sections = manifest.config_schema.filter((f) => f.type === 'section');
  assert.ok(sections.length > 0, 'the configuration opens with a section block');
  for (const section of sections) {
    assert.equal(section.required, undefined);
    assert.equal(section.default, undefined);
    assert.equal(section.placeholder, undefined);
    assert.ok(!(section.key in DEFAULT_CONFIG));
    for (const link of section.links ?? []) {
      assert.match(link.url, /^https:\/\//, 'section links must be https');
    }
  }
});

test('dynamic selects declare a source and no static options', () => {
  const dynamicSelects = allFields.filter((f) => f.source !== undefined);
  assert.equal(dynamicSelects.length, 3);
  for (const field of dynamicSelects) {
    assert.equal(field.source, 'devices');
    assert.equal(field.options, undefined);
  }
});

test('no secret field: the Elgato API has no password', () => {
  assert.deepEqual(
    allFields.filter((field) => field.type === 'secret'),
    [],
  );
});

test('the manifest version is the package version, and the image is tagged with it', () => {
  assert.equal(manifest.version, pkg.version, 'manifest version must match package.json');
  assert.ok(
    manifest.docker_image.endsWith(`:${manifest.version}`),
    `docker_image must be tagged :${manifest.version}, got "${manifest.docker_image}"`,
  );
});

test('the catalog description holds 10 to 100 characters per language', () => {
  for (const [lang, text] of Object.entries(manifest.description)) {
    assert.ok(
      text.length >= 10 && text.length <= 100,
      `description.${lang} has ${text.length} characters (10 to 100 allowed)`,
    );
  }
});

test('field placeholders are multi-language objects', () => {
  const withPlaceholder = allFields.filter((f) => f.placeholder !== undefined);
  assert.ok(withPlaceholder.length > 0, 'the address field has a placeholder');
  for (const field of withPlaceholder) {
    assert.equal(typeof field.placeholder, 'object', `field "${field.key}": placeholder`);
    assert.ok(field.placeholder.en, `field "${field.key}": placeholder needs an English text`);
  }
});
