// -----------------------------------------------------------------------------
// The two scene actions on the battery settings: off by default, refused
// before any request when not allowed or not writable, written as the
// inverter expects, read back and logged once.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorld } from './helpers/world.js';

const MIN_SOC = 'set_battery_min_soc';
const SMART = 'set_smart_battery_control';

test('off by default: refused, nothing written, the error says how to enable it', async () => {
  const world = await createWorld();
  const result = await world.gladys.fake.sceneAction(MIN_SOC, { level: 30 });
  assert.equal(result.success, false);
  assert.match(result.error, /activez-les dans la configuration Kostal/);
  assert.deepEqual(world.kostal.writes, []);
  assert.equal(world.kostal.count('settings', 'POST') > 0, true, 'the identity only');
  assert.equal(
    world.kostal.requests.filter((r) => r.method === 'PUT').length,
    0,
    'no write request at all',
  );
  await world.app.stop();
});

test('allowed: the reserve is written in steps of 5 %, read back, logged once', async () => {
  const world = await createWorld({ config: { allow_settings: true, language: 'en' } });
  const result = await world.gladys.fake.sceneAction(MIN_SOC, { level: 32 });
  assert.deepEqual(result, { success: true, data: { outputs: { min_soc: 30 } } });
  assert.deepEqual(world.kostal.writes, [
    { moduleid: 'devices:local', id: 'Battery:MinSoc', value: '30' },
  ]);
  assert.equal(world.app.service.batterySettings.minSoc, 30, 'read back');
  assert.deepEqual(
    world.logs
      .at('info')
      .map((line) => line.text)
      .slice(1),
    ['Scene action: minimum state of charge set to 30 %'],
  );
  await world.app.stop();
});

test('out of the range the inverter gives: refused before any request', async () => {
  const world = await createWorld({ config: { allow_settings: true, language: 'de' } });
  for (const level of [0, 2, 101, 'abc']) {
    const result = await world.gladys.fake.sceneAction(MIN_SOC, { level });
    assert.equal(result.success, false, `level ${level}`);
    assert.match(result.error, /zwischen 5 und 100 %/);
  }
  assert.deepEqual(world.kostal.writes, []);
  await world.app.stop();
});

test('smart battery control on turns the time control off first, as the inverter expects', async () => {
  const world = await createWorld({ config: { allow_settings: true } });
  assert.deepEqual(await world.gladys.fake.sceneAction(SMART, { enabled: 'on' }), {
    success: true,
    data: { outputs: { enabled: true } },
  });
  assert.deepEqual(world.kostal.writes, [
    { moduleid: 'devices:local', id: 'Battery:TimeControl:Enable', value: '0' },
    { moduleid: 'devices:local', id: 'Battery:SmartBatteryControl:Enable', value: '1' },
  ]);
  assert.equal(world.app.service.batterySettings.smartControl, true);
  await world.gladys.fake.sceneAction(SMART, { enabled: 'off' });
  assert.deepEqual(world.kostal.writes.at(-1), {
    moduleid: 'devices:local',
    id: 'Battery:SmartBatteryControl:Enable',
    value: '0',
  });
  assert.equal(world.kostal.writes.length, 3, 'turning it off touches nothing else');
  await world.app.stop();
});

test('a setting read-only for the plant owner is refused without a request', async () => {
  const world = await createWorld({
    config: { allow_settings: true, language: 'es' },
    before: (kostal) => {
      kostal.state.settings[0].settings.find((s) => s.id === 'Battery:MinSoc').access = 'readonly';
    },
  });
  const result = await world.gladys.fake.sceneAction(MIN_SOC, { level: 20 });
  assert.equal(result.success, false);
  assert.match(result.error, /no permite al propietario/);
  assert.deepEqual(world.kostal.writes, []);
  await world.app.stop();
});

test('the inverter refusing the write: the scene logs say why', async () => {
  const world = await createWorld({ config: { allow_settings: true, language: 'en' } });
  // Listed as writable, refused on the write (a firmware that changed its mind).
  world.kostal.state.settings[0].settings.find((s) => s.id === 'Battery:MinSoc').access =
    'readonly';
  const result = await world.gladys.fake.sceneAction(MIN_SOC, { level: 20 });
  assert.equal(result.success, false);
  assert.match(result.error, /refused the setting \(settings: HTTP 403 permission denied\)/);
  assert.equal(world.gladys.fake.connectionStatus.connected, true, 'not a login problem');
  await world.app.stop();
});

test('an inverter without battery has no setting to change', async () => {
  const world = await createWorld({ system: 'plenticore_pv', config: { allow_settings: true } });
  const result = await world.gladys.fake.sceneAction(SMART, { enabled: 'on' });
  assert.equal(result.success, false);
  assert.deepEqual(world.kostal.writes, []);
  await world.app.stop();
});

test('the inverter unreachable: refused, nothing queued', async () => {
  const world = await createWorld({ config: { allow_settings: true, language: 'en' } });
  world.kostal.goDown();
  world.clock.advance(15000);
  await world.app.cycle();
  const result = await world.gladys.fake.sceneAction(MIN_SOC, { level: 20 });
  assert.equal(result.success, false);
  assert.match(result.error, /not connected/);
  await world.app.stop();
});

test('the settings are read only when allowed, every 5 minutes', async () => {
  const off = await createWorld();
  assert.equal(off.app.service.batterySettings, null);
  await off.app.stop();

  const world = await createWorld({ config: { allow_settings: true } });
  assert.deepEqual(
    {
      minSoc: world.app.service.batterySettings.minSoc,
      smart: world.app.service.batterySettings.smartControl,
    },
    { minSoc: 5, smart: false },
  );
  const reads = () => world.kostal.count('settings', 'POST');
  const before = reads();
  world.clock.advance(60000);
  await world.app.cycle();
  assert.equal(reads(), before);
  world.clock.advance(5 * 60000);
  await world.app.cycle();
  assert.equal(reads(), before + 1);
  await world.app.stop();
});
