// -----------------------------------------------------------------------------
// Scene triggers: things that HAPPEN, worth more than a condition on a state.
//
// - `inverter_alarm`: a new alarm appears in the inverter's event list. One
//   event per alarm, carrying its code and its description as the inverter
//   words it (in the configured language): the "Active alarms" feature only
//   counts them. The same code fires at most once every 10 minutes, so an
//   alarm that comes and goes does not flood the scenes.
// - `battery_full` / `battery_empty`: the charge level reaches the configured
//   threshold. Hysteresis of 5 points: a battery hovering at 99-100 % fires
//   once, and again only after it went down to 95 %. A device-state trigger
//   on the charge level cannot do that.
//
// "Solar surplus above X W" is not a trigger: the core's device-state trigger
// on the grid feature already has the threshold and the duration.
//
// No event on the first reading after a start: nothing has changed yet, and a
// restart must not replay the "battery full" of the morning nor an old alarm.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { inverterIds } from './devices/inverter.js';

export const SCENE_TRIGGERS = {
  inverterAlarm: 'inverter_alarm',
  batteryFull: 'battery_full',
  batteryEmpty: 'battery_empty',
};
export const SCENE_TRIGGER_KEYS = Object.values(SCENE_TRIGGERS);

export const ALARM_EVENT_GAP_MS = 10 * 60 * 1000;
export const BATTERY_HYSTERESIS = 5;

const alarmKey = (event) => `${event.code}@${event.start}`;

/**
 * @param {object} options
 * @param {object} options.gladys
 * @param {object} [options.logger]
 * @param {() => number} [options.now]
 */
export function createTriggerWatcher({
  gladys,
  logger = createLogger({ name: 'triggers' }),
  now = () => Date.now(),
}) {
  let knownAlarms = null; // Set of alarm keys, null before the first reading
  const lastFiredByCode = new Map();
  let battery = null; // { fullArmed, emptyArmed }

  async function fire(key, data) {
    try {
      await gladys.publishSceneEvent(key, data);
    } catch (err) {
      logger.warn(`Scene event ${key} refused by Gladys (${err.message})`);
    }
  }

  async function watchAlarms(inventory, reading, events) {
    if (!inventory.hasEvents || reading.activeErrors === null) {
      return;
    }
    const active = reading.activeErrors > 0 ? events : [];
    const keys = new Set(active.map(alarmKey));
    const previous = knownAlarms;
    knownAlarms = keys;
    if (previous === null) {
      return;
    }
    for (const event of active) {
      if (previous.has(alarmKey(event))) {
        continue;
      }
      const code = event.code ?? 0;
      if (now() - (lastFiredByCode.get(code) ?? -Infinity) < ALARM_EVENT_GAP_MS) {
        logger.debug(`Alarm ${code} again: event skipped (too soon)`);
        continue;
      }
      lastFiredByCode.set(code, now());
      logger.warn(`Inverter alarm ${code}: ${event.description}`);
      await fire(SCENE_TRIGGERS.inverterAlarm, {
        device: inverterIds(gladys, inventory).device,
        code,
        description: event.description.slice(0, 1000),
        category: event.category ?? '',
      });
    }
  }

  async function watchBattery(inventory, reading, config) {
    const soc = reading.battery?.soc;
    if (!inventory.hasBattery || soc === null || soc === undefined) {
      return;
    }
    const level = Math.round(soc);
    const full = config.batteryFullLevel;
    const empty = config.batteryEmptyLevel;
    if (!battery) {
      battery = { fullArmed: level < full, emptyArmed: level > empty };
      return;
    }
    const data = { device: inverterIds(gladys, inventory).device, level };
    if (battery.fullArmed && level >= full) {
      battery.fullArmed = false;
      logger.debug(`Battery full (${level} %)`);
      await fire(SCENE_TRIGGERS.batteryFull, data);
    } else if (!battery.fullArmed && level <= full - BATTERY_HYSTERESIS) {
      battery.fullArmed = true;
    }
    if (battery.emptyArmed && level <= empty) {
      battery.emptyArmed = false;
      logger.debug(`Battery empty (${level} %)`);
      await fire(SCENE_TRIGGERS.batteryEmpty, data);
    } else if (!battery.emptyArmed && level >= empty + BATTERY_HYSTERESIS) {
      battery.emptyArmed = true;
    }
  }

  return {
    /** Compare a new reading with the previous ones and fire what happened. */
    async evaluate(inventory, reading, events, config) {
      await watchAlarms(inventory, reading, events);
      await watchBattery(inventory, reading, config);
    },
    /** Another inverter was configured: forget the previous states. */
    reset() {
      knownAlarms = null;
      lastFiredByCode.clear();
      battery = null;
    },
  };
}
