// -----------------------------------------------------------------------------
// Consistency checks between `gladys-assistant-integration.json` and the code.
// The manifest is validated by the store indexer, but nothing there can know
// which handlers the code actually registers — these tests keep both in sync.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { SCENE_TRIGGER_KEYS } from '../src/triggers.js';
import { SCENE_ACTION_KEYS } from '../src/scenes.js';
import { ACTIONS, WIDGETS } from '../src/app.js';
import { DEFAULT_CONFIG, LANGUAGE_OPTIONS, POLL_INTERVALS_S } from '../src/config.js';

const manifest = JSON.parse(
  await readFile(new URL('../gladys-assistant-integration.json', import.meta.url), 'utf8'),
);
const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

// Every list of form fields the manifest can declare (same field grammar).
const allFields = [
  ...(manifest.config_schema ?? []),
  ...(manifest.contact_schema ?? []),
  ...[
    ...(manifest.actions ?? []),
    ...(manifest.scene_triggers ?? []),
    ...(manifest.scene_actions ?? []),
  ].flatMap((item) => item.fields ?? []),
  ...(manifest.widgets ?? []).flatMap((widget) => widget.settings ?? []),
];

// Manifest fields older Gladys releases reject as unknown, with the first
// release accepting them. The store validator refuses a manifest whose
// `gladys_version` minimum is lower: these tests catch it before a release.
const CAPABILITY_FIELDS = ['scene_triggers', 'scene_actions', 'widgets'];
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

test('every manifest action has a registered handler, and vice versa', () => {
  assert.deepEqual(keysOf(manifest.actions).sort(), Object.values(ACTIONS).sort());
});

test('declaring catalog categories requires Gladys >= 4.86.0', () => {
  // The store vocabulary itself is checked by the store validator (unknown
  // keys are dropped with a warning there) — what this test pins is the
  // coupling rule: older cores reject any unknown manifest field, so a
  // manifest declaring `categories` must not claim compatibility below the
  // first release that accepts it.
  assert.ok(manifest.categories.length >= 1 && manifest.categories.length <= 3);
  assert.ok(
    isAtLeast(minGladysVersion(), CATEGORIES_MIN_GLADYS_VERSION),
    `categories requires gladys_version >= 4.86.0, got "${manifest.gladys_version}"`,
  );
});

test('declaring scene triggers, scene actions or widgets requires Gladys >= 5.1.0', () => {
  const declared = CAPABILITY_FIELDS.filter((field) => manifest[field] !== undefined);
  assert.ok(declared.length > 0, 'the integration declares capability fields');
  assert.ok(
    isAtLeast(minGladysVersion(), CAPABILITY_MIN_GLADYS_VERSION),
    `${declared.join(', ')} requires gladys_version >= 5.1.0, got "${manifest.gladys_version}"`,
  );
});

test('every scene_actions key has an onSceneAction handler, and vice versa', () => {
  assert.deepEqual(keysOf(manifest.scene_actions).sort(), [...SCENE_ACTION_KEYS].sort());
});

test('every widgets key has an onWidgetGet handler, and vice versa', () => {
  assert.deepEqual(keysOf(manifest.widgets).sort(), [...WIDGETS].sort());
});

test('every scene trigger the code fires is declared in scene_triggers, and vice versa', () => {
  // An undeclared key is a 404 on publishSceneEvent; a declared key nobody
  // fires is a dead card in the scene editor.
  const declared = keysOf(manifest.scene_triggers);
  for (const key of SCENE_TRIGGER_KEYS) {
    assert.ok(declared.includes(key), `trigger "${key}" is fired but not declared`);
  }
  for (const key of declared) {
    assert.ok(SCENE_TRIGGER_KEYS.includes(key), `trigger "${key}" is declared but never fired`);
  }
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
});

test('section fields are purely presentational', () => {
  const sections = manifest.config_schema.filter((f) => f.type === 'section');
  assert.ok(sections.length > 0, 'the form opens with a section block');
  for (const section of sections) {
    // A section stores NO value: declaring `required`, `default` or
    // `placeholder` on it rejects the manifest, and its key must never leak
    // into the config the code manipulates.
    assert.equal(section.required, undefined, `section "${section.key}" must not be required`);
    assert.equal(section.default, undefined, `section "${section.key}" must not have a default`);
    assert.equal(
      section.placeholder,
      undefined,
      `section "${section.key}" must not have a placeholder`,
    );
    assert.ok(section.label?.en, `section "${section.key}" needs an English label`);
    assert.ok(
      !(section.key in DEFAULT_CONFIG),
      `section "${section.key}" stores no value and must not appear in DEFAULT_CONFIG`,
    );
    for (const link of section.links ?? []) {
      assert.match(link.url, /^https:\/\//, 'section links must be https');
    }
  }
});

test('dynamic selects declare a source and no static options', () => {
  const dynamicSelects = allFields.filter((f) => f.source !== undefined);
  assert.ok(dynamicSelects.length > 0, 'the scene cards pick a device');
  for (const field of dynamicSelects) {
    assert.equal(field.source, 'devices', 'the only core-defined source in V1 is "devices"');
    assert.equal(
      field.options,
      undefined,
      `field "${field.key}": declaring source and options together rejects the manifest`,
    );
  }
});

test('the manifest version is the package version, and the image is tagged with it', () => {
  // The Release workflow writes all three: a mismatch means one was edited by
  // hand, and Gladys would offer a version whose image is another one.
  assert.equal(manifest.version, pkg.version, 'manifest version must match package.json');
  assert.ok(
    manifest.docker_image.endsWith(`:${manifest.version}`),
    `docker_image must be tagged :${manifest.version}, got "${manifest.docker_image}"`,
  );
});

test('the catalog description holds 10 to 100 characters per language', () => {
  // A store rule (the catalog card is short): a longer text rejects the
  // manifest.
  assert.ok(manifest.description.en, 'the description needs an English text');
  for (const [lang, text] of Object.entries(manifest.description)) {
    assert.ok(
      text.length >= 10 && text.length <= 100,
      `description.${lang} has ${text.length} characters (10 to 100 allowed)`,
    );
  }
});

test('field placeholders are multi-language objects', () => {
  // Like `label` and `description`: a plain string rejects the manifest.
  const withPlaceholder = allFields.filter((f) => f.placeholder !== undefined);
  assert.ok(withPlaceholder.length > 0, 'the address shows a placeholder');
  for (const field of withPlaceholder) {
    assert.equal(typeof field.placeholder, 'object', `field "${field.key}": placeholder`);
    assert.ok(field.placeholder.en, `field "${field.key}": placeholder needs an English text`);
  }
});

test('the select options are the values the code understands', () => {
  const field = (key) => manifest.config_schema.find((f) => f.key === key);
  assert.deepEqual(
    field('poll_interval').options.map((option) => Number(option.value)),
    POLL_INTERVALS_S,
  );
  assert.deepEqual(
    field('language').options.map((option) => option.value),
    LANGUAGE_OPTIONS,
  );
});

test('number fields: integer bounds and defaults (the form has no step)', () => {
  const numbers = allFields.filter((f) => f.type === 'number');
  assert.ok(numbers.length >= 3);
  for (const field of numbers) {
    for (const key of ['min', 'max', 'default']) {
      if (field[key] !== undefined) {
        assert.ok(Number.isInteger(field[key]), `${field.key}.${key} must be an integer`);
      }
    }
  }
});

test('the password is a secret field, and no action asks for a secret', () => {
  // A secret in an action's fields cannot be filled in (Gladys#3154).
  assert.equal(manifest.config_schema.find((f) => f.key === 'password').type, 'secret');
  for (const item of [...(manifest.actions ?? []), ...(manifest.scene_actions ?? [])]) {
    for (const field of item.fields ?? []) {
      assert.notEqual(field.type, 'secret', `${item.key}.${field.key}`);
    }
  }
});

test('the battery settings are off by default', () => {
  const field = manifest.config_schema.find((f) => f.key === 'allow_settings');
  assert.equal(field.type, 'boolean');
  assert.equal(field.default, false);
  assert.equal(DEFAULT_CONFIG.allow_settings, false);
});

test('the store card: name, image, local transport only, energy shelf', () => {
  assert.equal(manifest.name, 'Kostal Plenticore');
  assert.match(manifest.docker_image, /^ghcr\.io\/guim31\/gladys-kostal:/);
  assert.deepEqual(manifest.transports, ['local']);
  assert.deepEqual(manifest.categories, ['energy']);
  // No widget button opening a form (#3168): 5.1.0 is enough.
  assert.equal(manifest.gladys_version, '>=5.1.0');
});

test('the scene declarations match the data the code sends and returns', () => {
  for (const trigger of manifest.scene_triggers) {
    assert.deepEqual(
      trigger.fields.map((f) => f.key),
      ['device'],
      `${trigger.key}: filtered by device only`,
    );
  }
  const variables = Object.fromEntries(
    manifest.scene_triggers.map((t) => [t.key, t.variables.map((v) => v.key).sort()]),
  );
  assert.deepEqual(variables, {
    inverter_alarm: ['category', 'code', 'description'],
    battery_full: ['level'],
    battery_empty: ['level'],
  });
  const actions = Object.fromEntries(
    manifest.scene_actions.map((a) => [
      a.key,
      { fields: a.fields.map((f) => f.key), outputs: a.outputs.map((o) => o.key) },
    ]),
  );
  assert.deepEqual(actions, {
    set_battery_min_soc: { fields: ['level'], outputs: ['min_soc'] },
    set_smart_battery_control: { fields: ['enabled'], outputs: ['enabled'] },
  });
});
