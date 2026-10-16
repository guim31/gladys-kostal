// -----------------------------------------------------------------------------
// The pure parsers: what the inverter is (inventory) and what it measures
// (reading), on the fixtures, plus the odd answers a firmware can give.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  identityRequest,
  parseActiveEvents,
  parseBatterySettings,
  parseInventory,
  parseReading,
  processRequest,
  settingsIndex,
} from '../src/kostal/parse.js';
import { loadSystem } from './helpers/fakeKostal.js';

/** The discovery answers of a fixture, as the API gives them. */
function answers(system, edit = (fixture) => fixture) {
  const fixture = edit(structuredClone(loadSystem(system)));
  const processData = Object.entries(fixture.processdata.day).map(([moduleid, ids]) => ({
    moduleid,
    processdataids: Object.keys(ids),
  }));
  const request = identityRequest(settingsIndex(fixture.settings));
  const identity = request.map(({ moduleid, settingids }) => ({
    moduleid,
    settings: settingids.map((id) => ({ id, value: fixture.settingValues[moduleid][id] })),
  }));
  return { fixture, version: fixture.version, processData, settings: fixture.settings, identity };
}

function valuesOf(fixture, inventory, time = 'day') {
  return processRequest(inventory).map(({ moduleid, processdataids }) => ({
    moduleid,
    processdata: processdataids.map((id) => ({
      id,
      unit: '',
      value: fixture.processdata[time][moduleid][id],
    })),
  }));
}

test('inventory of a PLENTICORE plus with a battery on the third input', () => {
  const inventory = parseInventory(answers('plenticore_battery'));
  assert.equal(inventory.serial, '99999ZZZ000123');
  assert.equal(inventory.model, 'PLENTICORE plus 10');
  assert.equal(inventory.hostname, 'scb');
  assert.deepEqual(inventory.versions, {
    api: '0.2.0',
    software: '01.26.09454',
    ioc: '01.45',
    mc: '01.46',
  });
  // String count 2: pv3 (the battery input) is not a PV string.
  assert.deepEqual(inventory.pvStrings, [1, 2]);
  assert.equal(inventory.process['devices:local:pv3'], undefined);
  assert.equal(inventory.hasBattery, true);
  assert.deepEqual(inventory.settings, {
    minSoc: { writable: true, min: 5, max: 100 },
    smartControl: { writable: true },
    timeControl: true,
  });
});

test('inventory of a PLENTICORE plus without battery: the battery module is ignored', () => {
  const inventory = parseInventory(answers('plenticore_pv'));
  assert.equal(inventory.hostname, 'plenticore', 'Network:Hostname on this firmware');
  assert.deepEqual(inventory.pvStrings, [1, 2, 3]);
  assert.equal(inventory.hasBattery, false);
  assert.equal(inventory.process['devices:local:battery'], undefined);
  assert.deepEqual(inventory.settings, { minSoc: null, smartControl: null, timeControl: false });
});

test('ids the inverter does not list are never requested', () => {
  const { fixture, ...rest } = answers('plenticore_battery', (f) => {
    delete f.processdata.day['scb:event'];
    delete f.processdata.day['devices:local'].Home_P;
    return f;
  });
  const inventory = parseInventory(rest);
  assert.equal(inventory.hasEvents, false);
  assert.equal(inventory.hasHome, false);
  const requested = processRequest(inventory).flatMap((r) =>
    r.processdataids.map((id) => `${r.moduleid}/${id}`),
  );
  assert.ok(!requested.includes('devices:local/Home_P'));
  assert.ok(!requested.some((id) => id.startsWith('scb:event')));
  assert.ok(fixture);
});

test('no serial number: no identity, discovery refused', () => {
  const { fixture: _fixture, ...rest } = answers('plenticore_battery', (f) => {
    f.settingValues['devices:local']['Properties:SerialNo'] = '  ';
    return f;
  });
  assert.throws(() => parseInventory(rest), /no serial number/);
});

test('a read-only setting for the plant owner is known as such', () => {
  const { fixture: _fixture, ...rest } = answers('plenticore_battery', (f) => {
    f.settings[0].settings.find((s) => s.id === 'Battery:MinSoc').access = 'readonly';
    return f;
  });
  assert.equal(parseInventory(rest).settings.minSoc.writable, false);
});

test('reading by day: solar = sum of the strings, signs as the API gives them', () => {
  const { fixture, ...rest } = answers('plenticore_battery');
  const inventory = parseInventory(rest);
  const reading = parseReading(inventory, valuesOf(fixture, inventory));
  assert.equal(Math.round(reading.pvPower), 7012);
  assert.deepEqual(reading.strings, { 1: 3820.4, 2: 3191.9 });
  assert.equal(reading.gridPower, -2121.6, 'exporting');
  assert.equal(reading.battery.power, -1495.1, 'charging');
  assert.equal(reading.battery.soc, 64);
  assert.equal(reading.inverterState, 6);
  assert.equal(reading.activeErrors, 0);
  assert.equal(reading.yieldTotal, 41235123.4);
  // Yield − house from PV − house from battery.
  assert.equal(Math.round(reading.exportTotal * 10) / 10, 15765987.8);
  assert.equal(Math.round(reading.chargeTotal * 10) / 10, 5135801.8);
  assert.equal(reading.autarkyDay, 87.3);
});

test('reading at night: no negative solar power', () => {
  const { fixture, ...rest } = answers('plenticore_pv');
  const inventory = parseInventory(rest);
  const reading = parseReading(inventory, valuesOf(fixture, inventory, 'night'));
  assert.equal(reading.pvPower, 0);
  assert.equal(reading.battery, null);
  assert.equal(reading.gridPower, 512.7);
  const tiny = parseReading(inventory, [
    { moduleid: 'devices:local:pv1', processdata: [{ id: 'P', value: -0.11253988 }] },
  ]);
  assert.equal(tiny.strings[1], 0);
});

test('missing or null values stay null, never 0', () => {
  const { ...rest } = answers('plenticore_battery');
  const inventory = parseInventory(rest);
  const reading = parseReading(inventory, [
    { moduleid: 'devices:local', processdata: [{ id: 'Home_P', value: null }] },
  ]);
  assert.equal(reading.homePower, null);
  assert.equal(reading.pvPower, null);
  assert.equal(reading.exportTotal, null);
  assert.equal(reading.chargeTotal, null);
});

test('battery settings and active events', () => {
  assert.deepEqual(
    parseBatterySettings([
      {
        moduleid: 'devices:local',
        settings: [
          { id: 'Battery:MinSoc', value: '15' },
          { id: 'Battery:SmartBatteryControl:Enable', value: '1' },
        ],
      },
    ]),
    { minSoc: 15, smartControl: true },
  );
  assert.deepEqual(parseBatterySettings([]), { minSoc: null, smartControl: null });
  const events = parseActiveEvents([
    ...loadSystem('plenticore_battery').events,
    {
      code: 3013,
      description: 'Old',
      is_active: true,
      start_time: '2026-06-20T10:00:00',
      category: 'error',
    },
    {
      code: 6011,
      description: 'New',
      is_active: true,
      start_time: '2026-06-21T07:58:00',
      category: 'warning',
    },
  ]);
  assert.deepEqual(
    events.map((e) => [e.code, e.description]),
    [
      [6011, 'New'],
      [3013, 'Old'],
    ],
  );
  assert.deepEqual(parseActiveEvents(null), []);
});
