// -----------------------------------------------------------------------------
// Several inverters (1.1): one Gladys device each, keyed on the serial number,
// their own session and password back-off, a status that names the one that
// fails, scene actions and widget per inverter, and the 1.0 configuration
// (`host` + `password`) running on unchanged.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { validateWidgetContent } from '@gladysassistant/integration-sdk';
import { createApp, AUTH_RETRY_MS } from '../src/app.js';
import { createMemoryStore } from '../src/store.js';
import { normalizeConfig } from '../src/config.js';
import { TEST_PASSWORD, createFakeKostal, loadSystem } from './helpers/fakeKostal.js';
import { TEST_HOST, createClock, createRecordingLogger, createWorld } from './helpers/world.js';

const SECOND_HOST = '192.0.2.21';
const SECOND_PASSWORD = 'second-owner-pw';

/**
 * The plant of the forum request: inverter 1 without battery, inverter 2
 * with the battery and its own password.
 */
async function createPlant({ config = {}, create = true, store = createMemoryStore() } = {}) {
  const first = createFakeKostal('plenticore_pv');
  const second = createFakeKostal('plenticore_battery', { password: SECOND_PASSWORD });
  const byHost = { [TEST_HOST]: first, [SECOND_HOST]: second };
  const transport = (request) => byHost[new URL(request.url).host].transport(request);
  const clock = createClock();
  const logs = createRecordingLogger();
  const gladys = createFakeGladys({
    config: {
      host: TEST_HOST,
      password: TEST_PASSWORD,
      host_2: SECOND_HOST,
      password_2: SECOND_PASSWORD,
      ...config,
    },
  });
  const app = createApp({
    gladys,
    store,
    transport,
    logger: logs.logger,
    now: clock.now,
    timers: false,
    timeZone: 'Europe/Paris',
  });
  app.register();
  await gladys.connect();
  if (create) {
    for (const device of gladys.fake.discoveredDevices) {
      await gladys.fake.deviceCreated(device);
    }
  }
  const devices = () => gladys.fake.discoveredDevices;
  const deviceOf = (kostal) => {
    const serial = serialOf(kostal === first ? 'plenticore_pv' : 'plenticore_battery');
    return devices().find((device) => device.external_id.endsWith(serial));
  };
  return { gladys, app, first, second, clock, logs, store, devices, deviceOf };
}

/** The serial number of a fixture (test/fixtures/kostal): the platform id of its device. */
const serialOf = (system) =>
  loadSystem(system).settingValues['devices:local']['Properties:SerialNo'];

const cycle = async (plant, ms = 15000) => {
  plant.clock.advance(ms);
  await plant.app.cycle();
};

test('the configuration: up to three slots, the 1.0 keys first, the first password by default', () => {
  const legacy = normalizeConfig({ host: '192.0.2.20', password: 'pw' });
  assert.deepEqual(legacy.inverters, [{ slot: 1, baseUrl: 'http://192.0.2.20', password: 'pw' }]);
  assert.deepEqual(legacy.invalidSlots, []);

  const three = normalizeConfig({
    host: '192.0.2.20',
    password: 'pw',
    host_2: '192.0.2.21',
    password_2: 'other',
    host_3: '192.0.2.22',
  });
  assert.deepEqual(three.inverters, [
    { slot: 1, baseUrl: 'http://192.0.2.20', password: 'pw' },
    { slot: 2, baseUrl: 'http://192.0.2.21', password: 'other' },
    { slot: 3, baseUrl: 'http://192.0.2.22', password: 'pw' },
  ]);

  const odd = normalizeConfig({
    host: '',
    password: 'pw',
    host_2: 'http://',
    host_3: '192.0.2.22',
  });
  assert.deepEqual(odd.inverters, [{ slot: 3, baseUrl: 'http://192.0.2.22', password: 'pw' }]);
  assert.deepEqual(odd.invalidSlots, [2]);

  const twice = normalizeConfig({ host: '192.0.2.20', password: 'pw', host_2: '192.0.2.20' });
  assert.equal(twice.inverters.length, 1, 'the same inverter is read once');
  assert.equal(normalizeConfig({ host_2: '192.0.2.21' }).inverters.length, 0, 'no password');
});

test('two inverters: two devices, each with what it has, read with its own password', async () => {
  const plant = await createPlant();
  assert.equal(plant.devices().length, 2);
  const pv = plant.deviceOf(plant.first);
  const battery = plant.deviceOf(plant.second);
  assert.ok(pv && battery);
  const keys = (device) => device.features.map((f) => f.external_id.split(':').pop());
  assert.ok(!keys(pv).includes('battery_level'), 'no battery feature without a battery');
  assert.ok(keys(battery).includes('battery_level'));
  assert.equal(plant.first.failedLogins + plant.second.failedLogins, 0);
  assert.equal(plant.gladys.fake.connectionStatus.connected, true);
  // Each device has its states, from its own inverter.
  const state = (device, key) => plant.gladys.fake.lastState(`${device.external_id}:${key}`);
  plant.first.set('devices:local', 'Home_P', 111);
  plant.second.set('devices:local', 'Home_P', 222);
  const before = [plant.first, plant.second].map((k) => k.count('processdata', 'POST'));
  await cycle(plant);
  assert.equal(state(pv, 'home_power'), 111);
  assert.equal(state(battery, 'home_power'), 222);
  assert.deepEqual(
    [plant.first, plant.second].map((k) => k.count('processdata', 'POST')),
    before.map((n) => n + 1),
    'one request per inverter and per cycle',
  );
  // One inventory file per inverter, the first one under the 1.0 name.
  assert.deepEqual([...plant.store.files.keys()].sort(), ['inventory', 'inventory_2']);
  await plant.app.stop();
  assert.equal(plant.first.sessions.size + plant.second.sessions.size, 0, 'both logged out');
});

test('a 1.0 installation gets its second inverter without touching the first device', async () => {
  const store = createMemoryStore();
  const before = await createWorld({ system: 'plenticore_pv', store });
  const expected = before.device.external_id;
  await before.app.stop();
  const plant = await createPlant({ store });
  assert.ok(plant.devices().some((device) => device.external_id === expected));
  assert.equal(plant.deviceOf(plant.first).external_id, expected);
  await plant.app.stop();
});

test('one inverter down: the other one keeps refreshing, the status names the lost one', async () => {
  const plant = await createPlant();
  plant.second.goDown('EHOSTUNREACH');
  plant.first.set('devices:local', 'Home_P', 333);
  await cycle(plant);
  await cycle(plant);
  const pv = plant.deviceOf(plant.first);
  assert.equal(plant.gladys.fake.lastState(`${pv.external_id}:home_power`), 333);
  const status = plant.gladys.fake.connectionStatus;
  assert.equal(status.connected, false);
  assert.match(status.message.fr, /^Onduleur 2 : L'onduleur ne répond pas/);
  assert.match(status.message.en, /^Inverter 2: The inverter does not answer/);
  assert.equal(plant.logs.at('warn').length, 1);
  assert.match(plant.logs.at('warn')[0].text, /192\.0\.2\.21/);
  plant.second.comeBack();
  await cycle(plant);
  assert.equal(plant.gladys.fake.connectionStatus.connected, true);
  await plant.app.stop();
});

test('a refused password blocks that inverter only', async () => {
  const plant = await createPlant({ config: { password_2: 'wrong-password' } });
  assert.equal(plant.second.failedLogins, 1);
  assert.match(plant.gladys.fake.connectionStatus.message.fr, /^Onduleur 2 : .*mot de passe/);
  const reads = plant.first.count('processdata', 'POST');
  for (let i = 0; i < 10; i += 1) {
    await cycle(plant);
  }
  assert.equal(plant.first.count('processdata', 'POST'), reads + 10);
  assert.equal(plant.second.failedLogins, 1, 'not retried before 15 minutes');
  await cycle(plant, AUTH_RETRY_MS);
  assert.equal(plant.second.failedLogins, 2);
  await plant.app.stop();
});

test('an empty password reuses the first one', async () => {
  const plant = await createPlant({ config: { password_2: '' } });
  // The battery inverter has its own password: refused, the other one read.
  assert.equal(plant.second.failedLogins, 1);
  assert.equal(plant.first.failedLogins, 0);
  await plant.app.stop();
});

test('an invalid second address is said, the first inverter is read', async () => {
  const plant = await createPlant({ config: { host_2: 'ftp://192.0.2.21' } });
  assert.equal(plant.devices().length, 1);
  assert.match(plant.gladys.fake.connectionStatus.message.en, /^Inverter 2: This address/);
  await plant.app.stop();
});

test('the connection test answers for each inverter', async () => {
  const plant = await createPlant();
  const result = await plant.gladys.fake.action('test_connection');
  const lines = result.data.message.fr.split('\n');
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^Onduleur 1 : Kostal PLENTICORE plus 5.5 trouvé, 3 chaîne\(s\) PV/);
  assert.match(lines[1], /^Onduleur 2 : Kostal PLENTICORE plus 10 trouvé, .*batterie/);
  await plant.app.stop();
});

test('the triggers carry the device of the inverter they come from', async () => {
  const plant = await createPlant({ config: { battery_full_level: 90 } });
  plant.second.set('devices:local:battery', 'SoC', 95);
  await cycle(plant);
  const events = plant.gladys.fake.sceneEvents.filter((e) => e.key === 'battery_full');
  assert.deepEqual(events, [
    {
      key: 'battery_full',
      data: { device: plant.deviceOf(plant.second).external_id, level: 95 },
    },
  ]);
  await plant.app.stop();
});

test('scene actions: the battery inverter by default, or the one chosen', async () => {
  const plant = await createPlant({ config: { allow_settings: true, language: 'en' } });
  const result = await plant.gladys.fake.sceneAction('set_battery_min_soc', { level: 40 });
  assert.deepEqual(result, { success: true, data: { outputs: { min_soc: 40 } } });
  assert.equal(plant.second.writes.length, 1, 'written to the inverter with the battery');
  assert.equal(plant.first.writes.length, 0);

  const chosen = await plant.gladys.fake.sceneAction('set_battery_min_soc', {
    device: plant.deviceOf(plant.second).external_id,
    level: 20,
  });
  assert.equal(chosen.success, true);
  assert.equal(plant.second.writes.length, 2);

  const noBattery = await plant.gladys.fake.sceneAction('set_smart_battery_control', {
    device: plant.deviceOf(plant.first).external_id,
    enabled: 'on',
  });
  assert.equal(noBattery.success, false);
  assert.match(noBattery.error, /does not let the plant owner/);

  const gone = await plant.gladys.fake.sceneAction('set_battery_min_soc', {
    device: 'kostal:inverter:00000',
    level: 20,
  });
  assert.equal(gone.success, false);
  assert.match(gone.error, /not in the Kostal configuration any more/);
  assert.equal(plant.first.writes.length, 0);
  await plant.app.stop();
});

test('the widget shows the inverter chosen in its settings, named', async () => {
  const plant = await createPlant();
  const content = async (settings) =>
    (await plant.gladys.fake.widgetGet('energy_flow', { settings })).data.content;
  const battery = plant.deviceOf(plant.second);
  const chosen = await content({ device: battery.external_id });
  assert.deepEqual(validateWidgetContent(chosen), []);
  assert.ok(chosen.components.length <= 8);
  assert.equal(chosen.components[0].type, 'text');
  assert.equal(chosen.components[0].text, battery.name);
  const known = new Set(battery.features.map((f) => f.external_id));
  for (const component of chosen.components) {
    for (const id of [component.device_feature, ...(component.device_features ?? [])]) {
      assert.ok(!id || known.has(id), `${id} belongs to the chosen inverter`);
    }
  }
  // A widget placed with 1.0 has no setting: the first inverter.
  const placed = await content({});
  assert.equal(placed.components[0].text, plant.deviceOf(plant.first).name);
  await plant.app.stop();
});

test('a single inverter: no heading in the widget, messages as in 1.0', async () => {
  const world = await createWorld();
  const answer = await world.gladys.fake.widgetGet('energy_flow');
  assert.ok(answer.data.content.components.every((c) => c.type !== 'text'));
  const result = await world.gladys.fake.action('test_connection');
  assert.match(result.data.message.fr, /^Kostal PLENTICORE plus 10 trouvé/);
  await world.app.stop();
});

test('removing the second inverter logs it out and drops its device from the discovery', async () => {
  const plant = await createPlant();
  await plant.gladys.fake.configUpdated({ host: TEST_HOST, password: TEST_PASSWORD });
  assert.equal(plant.second.sessions.size, 0);
  assert.equal(plant.devices().length, 1);
  assert.equal(plant.app.units.length, 1);
  await plant.app.stop();
});
