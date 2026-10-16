// -----------------------------------------------------------------------------
// The Gladys device and its states: which features exist for which inverter,
// their couples (one consumption index only), the values and the signs.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorld } from './helpers/world.js';

const keys = (device) => device.features.map((f) => f.external_id.split(':').pop());
const text = (state) => (state && typeof state === 'object' ? state.text : state);

test('the inverter with a battery: every feature, in a stable order', async () => {
  const world = await createWorld();
  assert.equal(world.device.name, 'Kostal PLENTICORE plus 10');
  assert.equal(world.device.external_id, 'ext:test-integration:inverter:99999ZZZ000123');
  assert.deepEqual(keys(world.device), [
    'pv_power',
    'pv1_power',
    'pv2_power',
    'home_power',
    'grid_power',
    'ac_power',
    'battery_level',
    'battery_charge_power',
    'battery_discharge_power',
    'battery_cycles',
    'production_today',
    'production_total',
    'home_grid_total',
    'grid_export_total',
    'battery_charge_total',
    'battery_discharge_total',
    'inverter_state',
    'active_alarms',
    'latest_alarm',
  ]);
  await world.app.stop();
});

test('the inverter without battery: no battery feature, three strings', async () => {
  const world = await createWorld({ system: 'plenticore_pv' });
  const list = keys(world.device);
  assert.ok(list.includes('pv3_power'));
  assert.ok(!list.some((key) => key.startsWith('battery_')));
  await world.app.stop();
});

test('one string only: its power is the solar power, no second feature', async () => {
  const world = await createWorld({
    system: 'plenticore_pv',
    before: (kostal) => {
      kostal.state.settingValues['devices:local']['Properties:StringCnt'] = '1';
    },
  });
  assert.ok(!keys(world.device).some((key) => /^pv\d_power$/.test(key)));
  assert.equal(world.state('pv_power'), 1702);
  await world.app.stop();
});

test('the energy couples: one consumption index only, and the lifetime counters', async () => {
  const world = await createWorld();
  const byKey = Object.fromEntries(
    world.device.features.map((f) => [f.external_id.split(':').pop(), f]),
  );
  const couple = (key) => `${byKey[key].category}/${byKey[key].type}`;
  // The core derives a 30-minute consumption and its cost from EVERY
  // energy-sensor index: only the energy taken from the grid may be one.
  const indexes = world.device.features.filter(
    (f) => f.category === 'energy-sensor' && ['index', 'energy'].includes(f.type),
  );
  assert.deepEqual(
    indexes.map((f) => f.external_id.split(':').pop()),
    ['home_grid_total'],
  );
  assert.equal(couple('production_total'), 'energy-production-sensor/index');
  assert.equal(couple('grid_export_total'), 'grid-sensor/output-index');
  assert.equal(couple('battery_charge_total'), 'battery-storage/charge-index');
  assert.equal(couple('battery_discharge_total'), 'battery-storage/discharge-index');
  // The signed grid power, as Kostal reports it.
  assert.equal(couple('grid_power'), 'grid-sensor/power');
  assert.deepEqual([byKey.grid_power.min, byKey.grid_power.max], [-100000, 100000]);
  assert.equal(couple('home_power'), 'energy-sensor/power');
  for (const feature of world.device.features) {
    assert.equal(feature.read_only, true, `${feature.name} is read-only`);
  }
  await world.app.stop();
});

test('the states by day: exporting and charging', async () => {
  const world = await createWorld();
  assert.equal(world.state('pv_power'), 7012);
  assert.equal(world.state('grid_power'), -2122);
  assert.equal(world.state('battery_charge_power'), 1495);
  assert.equal(world.state('battery_discharge_power'), 0);
  assert.equal(world.state('battery_level'), 64);
  assert.equal(world.state('production_today'), 18.44);
  assert.equal(world.state('production_total'), 41235.12);
  assert.equal(world.state('home_grid_total'), 9123.46);
  assert.equal(world.state('grid_export_total'), 15765.99);
  assert.equal(text(world.state('inverter_state')), 'En production');
  assert.equal(text(world.state('latest_alarm')), 'Aucune alarme');
  await world.app.stop();
});

test('the states at night: importing, discharging, standby', async () => {
  const world = await createWorld({ night: true, config: { language: 'en' } });
  assert.equal(world.state('pv_power'), 0);
  assert.equal(world.state('grid_power'), 312);
  assert.equal(world.state('battery_charge_power'), 0);
  assert.equal(world.state('battery_discharge_power'), 108);
  assert.equal(text(world.state('inverter_state')), 'Standby');
  assert.equal(world.device.features[0].name, 'Solar production');
  await world.app.stop();
});

test('a lifetime counter read as 0 is not published', async () => {
  const world = await createWorld({ system: 'plenticore_pv' });
  // No battery here, and the fixture's battery counters are 0 anyway.
  assert.equal(
    world.gladys.fake.states.filter(
      (s) => s.state === 0 && /_total$/.test(s.device_feature_external_id),
    ).length,
    0,
  );
  await world.app.stop();
});

test('an unknown inverter state is said with its code', async () => {
  const world = await createWorld({
    config: { language: 'es' },
    before: (kostal) => kostal.set('devices:local', 'Inverter:State', 42),
  });
  assert.equal(text(world.state('inverter_state')), 'Estado desconocido (42)');
  await world.app.stop();
});
