// -----------------------------------------------------------------------------
// Scene triggers: a new alarm (with its text), battery full / empty with
// hysteresis, nothing replayed after a start.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorld } from './helpers/world.js';
import { ALARM_EVENT_GAP_MS } from '../src/triggers.js';

const ALARM = {
  descriptions: { en: 'Insulation fault', fr: "Défaut d'isolement" },
  description: 'Insulation fault',
  category: 'error',
  is_active: true,
  code: 3013,
  start_time: '2026-06-21T08:01:00',
  end_time: '2026-06-21T08:01:00',
  group: 'Error',
  long_description: 'Insulation fault',
};

const cycle = async (world, ms = 15000) => {
  world.clock.advance(ms);
  await world.app.cycle();
};

test('a new alarm fires inverter_alarm once, with its code and its text', async () => {
  const world = await createWorld();
  world.kostal.state.events.unshift(structuredClone(ALARM));
  world.kostal.set('scb:event', 'Event:ActiveErrorCnt', 1);
  await cycle(world);
  await cycle(world);
  assert.deepEqual(world.gladys.fake.sceneEvents, [
    {
      key: 'inverter_alarm',
      data: {
        device: world.device.external_id,
        code: 3013,
        description: "Défaut d'isolement",
        category: 'error',
      },
    },
  ]);
  assert.equal(world.logs.at('warn').length, 1);
  await world.app.stop();
});

test('an alarm already active at start is not replayed', async () => {
  const world = await createWorld({
    before: (kostal) => {
      kostal.state.events.unshift(structuredClone(ALARM));
      kostal.set('scb:event', 'Event:ActiveErrorCnt', 1);
    },
  });
  await cycle(world);
  assert.deepEqual(world.gladys.fake.sceneEvents, []);
  await world.app.stop();
});

test('the same alarm coming back fires again after 10 minutes only', async () => {
  const world = await createWorld();
  const raise = async (start) => {
    world.kostal.state.events = [{ ...structuredClone(ALARM), start_time: start }];
    world.kostal.set('scb:event', 'Event:ActiveErrorCnt', 1);
    await cycle(world);
    world.kostal.set('scb:event', 'Event:ActiveErrorCnt', 0);
    await cycle(world);
  };
  await raise('2026-06-21T08:01:00');
  await raise('2026-06-21T08:02:00');
  assert.equal(world.gladys.fake.sceneEvents.length, 1);
  world.clock.advance(ALARM_EVENT_GAP_MS);
  await raise('2026-06-21T08:20:00');
  assert.equal(world.gladys.fake.sceneEvents.length, 2);
  await world.app.stop();
});

test('battery full and empty, with 5 points of hysteresis', async () => {
  const world = await createWorld({ config: { battery_full_level: 95, battery_empty_level: 10 } });
  const soc = async (value) => {
    world.kostal.set('devices:local:battery', 'SoC', value);
    await cycle(world);
  };
  for (const value of [80, 95, 96, 94, 95, 90, 95]) {
    await soc(value);
  }
  for (const value of [30, 10, 9, 11, 10, 15, 10]) {
    await soc(value);
  }
  assert.deepEqual(
    world.gladys.fake.sceneEvents.map((event) => [event.key, event.data.level]),
    [
      ['battery_full', 95],
      ['battery_full', 95],
      ['battery_empty', 10],
      ['battery_empty', 10],
    ],
  );
  assert.equal(world.gladys.fake.sceneEvents[0].data.device, world.device.external_id);
  await world.app.stop();
});

test('a battery already full at start fires nothing', async () => {
  const world = await createWorld({
    before: (kostal) => kostal.set('devices:local:battery', 'SoC', 100),
  });
  await cycle(world);
  await cycle(world);
  assert.deepEqual(world.gladys.fake.sceneEvents, []);
  await world.app.stop();
});
