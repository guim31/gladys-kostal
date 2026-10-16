// -----------------------------------------------------------------------------
// A whole integration under test: the app wired to the SDK's fake Gladys and
// to a fake Kostal inverter, a clock the test moves, an in-memory /data and a
// logger that records every line.
// -----------------------------------------------------------------------------

import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { createApp } from '../../src/app.js';
import { createMemoryStore } from '../../src/store.js';
import { TEST_PASSWORD, createFakeKostal } from './fakeKostal.js';

export const TEST_HOST = '192.0.2.20';
// A summer morning in Paris, panels producing.
export const MORNING = Date.parse('2026-06-21T08:00:00Z');

/** A logger recording its lines: `{ level, text }`. */
export function createRecordingLogger() {
  const lines = [];
  const write =
    (level) =>
    (...args) =>
      lines.push({
        level,
        text: args.map((arg) => (arg instanceof Error ? arg.message : String(arg))).join(' '),
      });
  const logger = {
    debug: write('debug'),
    info: write('info'),
    warn: write('warn'),
    error: write('error'),
    child: () => logger,
  };
  return { logger, lines, at: (level) => lines.filter((line) => line.level === level) };
}

export function createClock(start = MORNING) {
  const clock = {
    time: start,
    now: () => clock.time,
    advance(ms) {
      clock.time += ms;
    },
  };
  return clock;
}

/**
 * @param {object} [options]
 * @param {string} [options.system] a file of test/fixtures/kostal
 * @param {object} [options.config] config values (host and password default to the test ones)
 * @param {boolean} [options.night] serve the night readings
 * @param {boolean} [options.create] the user adds the discovered device
 * @param {boolean} [options.timers] run the app's refresh timer
 * @param {object} [options.store]
 * @param {object} [options.clock]
 * @param {Function} [options.before] (kostal) => void, before the connection
 */
export async function createWorld({
  system = 'plenticore_battery',
  config = {},
  night = false,
  create = true,
  timers = false,
  store = createMemoryStore(),
  clock = createClock(),
  before,
} = {}) {
  const kostal = createFakeKostal(system, { night });
  before?.(kostal);
  const logs = createRecordingLogger();
  const gladys = createFakeGladys({
    config: { host: TEST_HOST, password: TEST_PASSWORD, ...config },
  });
  const app = createApp({
    gladys,
    store,
    transport: kostal.transport,
    logger: logs.logger,
    now: clock.now,
    timers,
    timeZone: 'Europe/Paris',
  });
  app.register();
  await gladys.connect();
  if (create) {
    for (const device of gladys.fake.discoveredDevices) {
      await gladys.fake.deviceCreated(device);
    }
  }
  return {
    gladys,
    app,
    kostal,
    logs,
    clock,
    store,
    /** The published inverter device. */
    get device() {
      return gladys.fake.discoveredDevices[0];
    },
    /** The last state of a feature of the inverter, by key. */
    state(key) {
      return gladys.fake.lastState(`${gladys.fake.discoveredDevices[0].external_id}:${key}`);
    },
  };
}
