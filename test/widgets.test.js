// -----------------------------------------------------------------------------
// The "energy_flow" widget: rendered exactly as sent (validateWidgetContent of
// the SDK), within the budget of the core, bound to features that exist,
// built without any request to the inverter.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateWidgetContent } from '@gladysassistant/integration-sdk';
import { createWorld } from './helpers/world.js';

async function content(world) {
  const answer = await world.gladys.fake.widgetGet('energy_flow');
  assert.equal(answer.success, true);
  return answer.data.content;
}

/** Every external id the content binds must be a feature of the published device. */
function assertBound(world, widget) {
  const known = new Set(world.device.features.map((f) => f.external_id));
  for (const component of widget.components) {
    for (const id of [component.device_feature, ...(component.device_features ?? [])].filter(
      Boolean,
    )) {
      assert.ok(known.has(id), `${id} is not a feature of the device`);
    }
  }
}

for (const scenario of [
  { label: 'battery, by day', system: 'plenticore_battery' },
  { label: 'battery, at night', system: 'plenticore_battery', night: true },
  { label: 'no battery', system: 'plenticore_pv' },
  {
    label: 'battery settings allowed',
    system: 'plenticore_battery',
    config: { allow_settings: true },
  },
]) {
  test(`the content is valid and within the budget (${scenario.label})`, async () => {
    const world = await createWorld(scenario);
    const widget = await content(world);
    assert.deepEqual(validateWidgetContent(widget), []);
    assert.ok(widget.components.length <= 8);
    assert.ok(widget.components.filter((c) => c.type === 'value').length <= 6);
    assertBound(world, widget);
    await world.app.stop();
  });
}

test('the tiles follow the device live; the status says what the tiles cannot', async () => {
  const world = await createWorld({ config: { allow_settings: true } });
  const widget = await content(world);
  const tiles = widget.components.filter((c) => c.type === 'value');
  assert.deepEqual(
    tiles.map((tile) => tile.device_feature.split(':').pop()),
    ['pv_power', 'home_power', 'grid_power', 'battery_level', 'production_today'],
  );
  const status = widget.components.find((c) => c.type === 'status').items;
  const rows = Object.fromEntries(
    status.map((item) => [item.label.en, item.value.en ?? item.value]),
  );
  assert.equal(rows.Grid, 'Export 2120 W');
  assert.equal(rows.Battery, 'Charging 1500 W');
  assert.equal(rows.Inverter, 'Feeding in');
  assert.equal(rows.Alarms, 'No alarm');
  assert.equal(rows['Autarky today'], '87%');
  assert.equal(rows['Discharge limit'], '5%');
  assert.equal(rows['Smart battery control'], 'Off');
  assert.equal(rows.Updated, '10:00', 'Paris time');
  assert.ok(status.length <= 10);
  await world.app.stop();
});

test('the widget costs no request when the device exists', async () => {
  const world = await createWorld();
  const before = world.kostal.requests.length;
  await content(world);
  await content(world);
  assert.equal(world.kostal.requests.length, before);
  await world.app.stop();
});

test('without the device: cached values, the inverter read at the configured pace at most', async () => {
  const world = await createWorld({ create: false });
  const widget = await content(world);
  assert.deepEqual(validateWidgetContent(widget), []);
  const solar = widget.components.find((c) => c.type === 'value');
  assert.equal(solar.value, 7012);
  assert.ok(!widget.components.some((c) => c.type === 'chart'), 'no history without the device');
  const reads = world.kostal.count('processdata', 'POST');
  await content(world);
  assert.equal(world.kostal.count('processdata', 'POST'), reads);
  world.clock.advance(15000);
  await content(world);
  assert.equal(world.kostal.count('processdata', 'POST'), reads + 1);
  await world.app.stop();
});

test('not configured, or nothing read yet: one sentence', async () => {
  const empty = await createWorld({ config: { host: '' }, create: false });
  const widget = await content(empty);
  assert.deepEqual(validateWidgetContent(widget), []);
  assert.match(widget.components[0].text.fr, /Saisissez l'adresse/);
  await empty.app.stop();

  const down = await createWorld({ create: false, before: (kostal) => kostal.goDown() });
  assert.match((await content(down)).components[0].text.en, /No reading/);
  await down.app.stop();
});

test('an active alarm shows its text in red', async () => {
  const world = await createWorld();
  world.kostal.state.events.unshift({
    description: 'Grid frequency out of range',
    category: 'error',
    is_active: true,
    code: 3101,
    start_time: '2026-06-21T08:05:00',
    end_time: '2026-06-21T08:05:00',
    group: 'Error',
    long_description: 'Grid frequency out of range',
  });
  world.kostal.set('scb:event', 'Event:ActiveErrorCnt', 1);
  world.clock.advance(15000);
  await world.app.cycle();
  const status = (await content(world)).components.find((c) => c.type === 'status').items;
  const alarm = status.find((item) => item.label.en === 'Alarms');
  assert.equal(alarm.value.fr, 'Grid frequency out of range');
  assert.equal(alarm.color, 'danger');
  await world.app.stop();
});
