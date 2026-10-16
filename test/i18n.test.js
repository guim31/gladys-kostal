// -----------------------------------------------------------------------------
// Every text shown to the user exists in the four languages of the Gladys
// interface (en, fr, de, es), is not empty, fits where it is shown, and the
// German one says "du" (the register chosen for guim31's integrations).
//
// The manifest is walked whole: any object carrying a language key is a
// multi-language text. The code texts all live in src/i18n.js, and a scan of
// the sources makes sure none is written anywhere else. The four user docs
// (docs/<lang>.md) must have the same sections.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import {
  DEVICE_NAMES,
  FEATURE_NAMES,
  INVERTER_STATES,
  LANGUAGES,
  MESSAGES,
  SCENE_ERRORS,
  SETTINGS_STATUS,
  TEXTS,
  WIDGET_MESSAGES,
  WIDGET_TEXT,
  inverterStateText,
} from '../src/i18n.js';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');
const manifest = JSON.parse(await read('../gladys-assistant-integration.json'));

const LANGUAGE_KEYS = new Set(['en', 'fr', 'de', 'es', 'it', 'nl', 'pt', 'pl']);
// The formal German address, capitalized ("Sie", "Ihr"...): never, German
// says "du". Lowercase "sie"/"ihr" (they, her) stay allowed.
const FORMAL_GERMAN = /\b(Sie|Ihr|Ihre|Ihren|Ihrem|Ihrer|Ihres|Ihnen)\b/;

/**
 * Check one multi-language object.
 * @param {object} text
 * @param {string} path where it was found, for the messages
 * @param {number} max the bound, in characters per language
 */
function checkText(text, path, max) {
  assert.deepEqual(Object.keys(text).sort(), [...LANGUAGES].sort(), `${path}: en, fr, de, es`);
  for (const lang of LANGUAGES) {
    const value = text[lang];
    assert.equal(typeof value, 'string', `${path}.${lang} is a string`);
    assert.ok(value.trim().length > 0, `${path}.${lang} is empty`);
    assert.ok(value.length <= max, `${path}.${lang} is ${value.length} characters, ${max} max`);
  }
  assert.doesNotMatch(text.de, FORMAL_GERMAN, `${path}.de must say "du"`);
}

/** The bound of a manifest text, from where it sits. */
function manifestBound(path) {
  if (path === 'description') return 100;
  if (/^widgets\[\d+\]\.label$/.test(path)) return 30;
  if (/^widgets\[\d+\]\.description$/.test(path)) return 100;
  if (/\.label$/.test(path)) return 60;
  return 400;
}

/** Every multi-language object of a JSON tree, with its path. */
function* multiLanguageObjects(node, path = '') {
  if (Array.isArray(node)) {
    for (const [index, item] of node.entries()) {
      yield* multiLanguageObjects(item, `${path}[${index}]`);
    }
    return;
  }
  if (node === null || typeof node !== 'object') return;
  if (Object.keys(node).some((key) => LANGUAGE_KEYS.has(key))) {
    yield [path, node];
    return;
  }
  for (const [key, value] of Object.entries(node)) {
    yield* multiLanguageObjects(value, path ? `${path}.${key}` : key);
  }
}

test('every multi-language text of the manifest has en, fr, de and es', () => {
  const found = [...multiLanguageObjects(manifest)];
  // Guard against a walk that silently finds nothing.
  assert.ok(found.length >= 50, `only ${found.length} texts found in the manifest`);
  for (const [path, text] of found) {
    checkText(text, path, manifestBound(path));
  }
});

test('the store name is the same in every language, 3 to 30 characters', () => {
  assert.equal(typeof manifest.name, 'string');
  assert.ok(manifest.name.length >= 3 && manifest.name.length <= 30);
});

test('device and feature names, text states: four languages, short', () => {
  checkText(DEVICE_NAMES.inverter, 'DEVICE_NAMES.inverter', 40);
  for (const [key, name] of Object.entries(FEATURE_NAMES)) {
    checkText(typeof name === 'function' ? name(3) : name, `FEATURE_NAMES.${key}`, 40);
  }
  // Shown as status values in the widget: 40 characters at most.
  for (const [code, text] of Object.entries(INVERTER_STATES)) {
    checkText(text, `INVERTER_STATES.${code}`, 40);
  }
  checkText(inverterStateText(255), 'inverterStateText(255)', 40);
  checkText(TEXTS.unknownState, 'TEXTS.unknownState', 30);
  checkText(TEXTS.noAlarm, 'TEXTS.noAlarm', 40);
  checkText(TEXTS.alarmPending, 'TEXTS.alarmPending', 40);
  checkText(TEXTS.alarmCode(65535), 'TEXTS.alarmCode', 40);
});

test('widget texts: tile and status labels within the SDK bounds', () => {
  for (const [key, text] of Object.entries(WIDGET_TEXT)) {
    // Tile labels: 24 characters; the chart title is longer.
    checkText(text, `WIDGET_TEXT.${key}`, key === 'chartTitle' ? 40 : 24);
  }
  for (const [key, text] of Object.entries(WIDGET_MESSAGES)) {
    checkText(text, `WIDGET_MESSAGES.${key}`, 300);
  }
});

test('connection status, action and scene messages, built with values as long as real ones', () => {
  for (const key of ['notConfigured', 'invalidHost', 'authFailed', 'locked', 'noSerial']) {
    checkText(MESSAGES[key], `MESSAGES.${key}`, 300);
  }
  checkText(
    MESSAGES.unreachable('processdata: no answer within 10000 ms'),
    'MESSAGES.unreachable',
    300,
  );
  checkText(
    MESSAGES.publishFailed('Request failed with status code 422'),
    'MESSAGES.publishFailed',
    300,
  );
  for (const settings of Object.keys(SETTINGS_STATUS)) {
    for (const battery of [true, false]) {
      checkText(
        MESSAGES.found({
          model: 'Kostal PLENTICORE plus 10 G3',
          firmware: '01.26.09454',
          strings: 3,
          battery,
          settings,
        }),
        'MESSAGES.found',
        300,
      );
    }
  }
  for (const [key, text] of Object.entries(SCENE_ERRORS)) {
    const built =
      key === 'outOfRange'
        ? text(5, 100)
        : key === 'refused'
          ? text('settings: HTTP 403 permission denied')
          : text;
    checkText(built, `SCENE_ERRORS.${key}`, 300);
  }
});

test('no multi-language text is written outside src/i18n.js', async () => {
  const sources = ['../index.js', '../scripts/probe.mjs'];
  for (const dir of ['../src/', '../src/devices/', '../src/kostal/']) {
    for (const entry of await readdir(new URL(dir, import.meta.url), { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.js') && entry.name !== 'i18n.js') {
        sources.push(`${dir}${entry.name}`);
      }
    }
  }
  assert.ok(sources.length >= 15, 'every source file is scanned');
  for (const path of sources) {
    const source = await read(path);
    assert.doesNotMatch(
      source,
      /\b(en|fr|de|es)\s*:\s*['"`]/,
      `${path} writes a text by hand: move it to src/i18n.js`,
    );
  }
});

/** The outline of a Markdown doc: the level of each heading, in order. */
function outline(markdown) {
  return markdown
    .split('\n')
    .filter((line) => /^#{1,3} /.test(line))
    .map((line) => line.match(/^#+/)[0].length);
}

test('the four user docs exist and have the same sections', async () => {
  const docs = {};
  for (const lang of LANGUAGES) {
    docs[lang] = await read(`../docs/${lang}.md`);
  }
  const reference = outline(docs.en);
  assert.ok(reference.filter((level) => level === 2).length >= 8, 'en: at least 8 sections');
  for (const lang of LANGUAGES) {
    assert.deepEqual(outline(docs[lang]), reference, `docs/${lang}.md: same sections as en`);
    assert.ok(docs[lang].length >= 3000, `docs/${lang}.md is complete`);
    assert.match(docs[lang], /Kostal/);
  }
  // Developed without the hardware: said in every language.
  assert.match(docs.en, /without the hardware/i);
  assert.match(docs.fr, /sans le matériel/i);
  assert.match(docs.de, /ohne die Hardware/i);
  assert.match(docs.es, /sin el hardware/i);
  assert.doesNotMatch(docs.de, FORMAL_GERMAN, 'docs/de.md must say "du"');
});

test('the checks catch a missing language and the formal German address', () => {
  assert.throws(() => checkText({ en: 'Play', fr: 'Lecture', de: 'Abspielen' }, 'x', 24));
  assert.throws(() => checkText({ en: 'a', fr: 'a', de: 'a', es: '' }, 'x', 24));
  assert.throws(() => checkText({ en: 'a', fr: 'a', de: 'a'.repeat(25), es: 'a' }, 'x', 24));
  assert.throws(() =>
    checkText({ en: 'a', fr: 'a', de: 'Geben Sie Ihre IP-Adresse ein', es: 'a' }, 'x', 60),
  );
  checkText({ en: 'a', fr: 'a', de: 'Gib deine IP-Adresse ein', es: 'a' }, 'x', 60);
  assert.notDeepEqual(outline('# A\n## B\n## C'), outline('# A\n## B\n### C'));
});
