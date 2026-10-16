// -----------------------------------------------------------------------------
// The configuration as the form sends it, normalized.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, isConfigured, normalizeConfig, parseHost } from '../src/config.js';

test('the address: IP, port, host name, scheme; credentials and path dropped', () => {
  assert.deepEqual(parseHost('192.0.2.20'), { baseUrl: 'http://192.0.2.20', valid: true });
  assert.deepEqual(parseHost(' 192.0.2.20:8080 '), {
    baseUrl: 'http://192.0.2.20:8080',
    valid: true,
  });
  assert.deepEqual(parseHost('https://plenticore.local/api/v1/'), {
    baseUrl: 'https://plenticore.local',
    valid: true,
  });
  assert.deepEqual(parseHost('http://admin:secret@192.0.2.20'), {
    baseUrl: 'http://192.0.2.20',
    valid: true,
  });
  assert.deepEqual(parseHost(''), { baseUrl: '', valid: true });
  assert.equal(parseHost('ftp://192.0.2.20').valid, false);
  assert.equal(parseHost('http://').valid, false);
});

test('the defaults, and what a form can send', () => {
  const config = normalizeConfig(DEFAULT_CONFIG);
  assert.equal(config.pollIntervalMs, 15000);
  assert.equal(config.language, 'fr');
  assert.equal(config.allowSettings, false);
  assert.equal(isConfigured(config), false);
  const set = normalizeConfig({
    host: '192.0.2.20',
    password: 'pw',
    poll_interval: '60',
    language: 'es',
    allow_settings: true,
  });
  assert.equal(isConfigured(set), true);
  assert.equal(set.pollIntervalMs, 60000);
  assert.equal(set.language, 'es');
  assert.equal(set.allowSettings, true);
  assert.equal(normalizeConfig({ allow_settings: 'true' }).allowSettings, true);
  assert.equal(normalizeConfig({ allow_settings: 'false' }).allowSettings, false);
  assert.equal(normalizeConfig({ poll_interval: '5' }).pollIntervalMs, 15000);
  assert.equal(normalizeConfig({ language: 'it' }).language, 'fr');
  assert.equal(
    isConfigured(normalizeConfig({ host: '192.0.2.20' })),
    false,
    'a password is needed',
  );
});

test('battery thresholds: bounds, and a gap between empty and full', () => {
  assert.equal(normalizeConfig({ battery_full_level: 20 }).batteryFullLevel, 100);
  assert.equal(normalizeConfig({ battery_empty_level: 80 }).batteryEmptyLevel, 5);
  const close = normalizeConfig({ battery_full_level: 55, battery_empty_level: 50 });
  assert.equal(close.batteryEmptyLevel, 45);
});
