// -----------------------------------------------------------------------------
// Shared pieces of the device: feature builder, category/type couples,
// display bounds, state helpers.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
  DEVICE_FEATURE_UNITS as U,
  DEVICE_POLL_FREQUENCIES,
} from '@gladysassistant/integration-sdk';
import { pick } from '../i18n.js';

// The container refreshes the device itself (src/app.js). The device still
// asks the core to poll it once a minute: onPoll is the fallback if the
// container's timer ever stalls (GladysAssistant/Gladys#3198).
export const CORE_POLL_FREQUENCY = DEVICE_POLL_FREQUENCIES.EVERY_MINUTES;

// Display bounds (the core never applies them to the values). The signed
// grid power gets symmetric bounds, so a gauge puts zero in the middle.
export const KIND = {
  power: { unit: U.WATT, min: 0, max: 100000 },
  signedPower: { unit: U.WATT, min: -100000, max: 100000 },
  dayEnergy: { unit: U.KILOWATT_HOUR, min: 0, max: 10000 },
  index: { unit: U.KILOWATT_HOUR, min: 0, max: 1000000000 },
  percent: { unit: U.PERCENT, min: 0, max: 100 },
  count: { min: 0, max: 1000000 },
  text: { min: 0, max: 0 },
};

/**
 * One read-only feature.
 * @param {{ feature: (key: string) => string }} ids
 * @param {string} key the stable feature key (part of the external id: never renamed)
 * @param {Record<string, string>} name multi-language name
 * @param {string} language the language of the names (config)
 * @param {[string, string]} couple [category, type]
 * @param {object} kind one of KIND
 */
export function feature(ids, key, name, language, [category, type], kind) {
  return {
    name: pick(name, language),
    external_id: ids.feature(key),
    category,
    type,
    ...(kind.unit ? { unit: kind.unit } : {}),
    min: kind.min,
    max: kind.max,
    read_only: true,
    has_feedback: false,
    keep_history: kind !== KIND.text,
  };
}

export const COUPLES = {
  productionPower: [C.ENERGY_PRODUCTION_SENSOR, T.ENERGY_PRODUCTION_SENSOR.POWER],
  productionToday: [C.ENERGY_PRODUCTION_SENSOR, T.ENERGY_PRODUCTION_SENSOR.DAILY_PRODUCTION],
  // The lifetime production counter. The 5.2 core does not derive the
  // half-hourly production of an external integration from it yet.
  productionIndex: [C.ENERGY_PRODUCTION_SENSOR, T.ENERGY_PRODUCTION_SENSOR.INDEX],
  // What the inverter itself delivers on its AC side.
  acOutput: [C.HOME_OUTPUT_SENSOR, T.HOME_OUTPUT_SENSOR.POWER],
  // The house consumption an inverter measures goes to energy-sensor, not to
  // home-output-sensor (server/utils/constants.js of the core).
  homePower: [C.ENERGY_SENSOR, T.ENERGY_SENSOR.POWER],
  // Kostal reports the grid exchange as ONE signed value: the core asks to
  // map the form the device natively reports, never both.
  gridPower: [C.GRID_SENSOR, T.GRID_SENSOR.POWER],
  gridExportIndex: [C.GRID_SENSOR, T.GRID_SENSOR.OUTPUT_INDEX],
  // The one consumption index: the energy the house took from the grid,
  // close to what the supplier bills. The core derives its 30-minute
  // consumption and its cost from it (ENERGY_INDEX_FEATURE_TYPES).
  homeGridIndex: [C.ENERGY_SENSOR, T.ENERGY_SENSOR.INDEX],
  batteryLevel: [C.BATTERY_STORAGE, T.BATTERY_STORAGE.BATTERY_LEVEL],
  batteryCharge: [C.BATTERY_STORAGE, T.BATTERY_STORAGE.CHARGE_POWER],
  batteryDischarge: [C.BATTERY_STORAGE, T.BATTERY_STORAGE.DISCHARGE_POWER],
  batteryChargeIndex: [C.BATTERY_STORAGE, T.BATTERY_STORAGE.CHARGE_INDEX],
  batteryDischargeIndex: [C.BATTERY_STORAGE, T.BATTERY_STORAGE.DISCHARGE_INDEX],
  counter: [C.COUNTER_SENSOR, T.SENSOR.INTEGER],
  text: [C.TEXT, T.TEXT.TEXT],
};

/** Round to a number of decimals (the values move less, fewer states are sent). */
export function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** A numeric state, or nothing when the value is unknown. */
export function numericState(list, externalId, value, digits) {
  if (value !== null && value !== undefined && Number.isFinite(value)) {
    // `+ 0` turns a rounded -0 into 0.
    list.push({ device_feature_external_id: externalId, state: round(value, digits) + 0 });
  }
}

/** A text state, or nothing when the text is empty (Gladys ignores those). */
export function textState(list, externalId, text) {
  if (typeof text === 'string' && text.trim() !== '') {
    list.push({ device_feature_external_id: externalId, text });
  }
}

/** Wh → kWh, null kept. */
export const kwh = (wh) => (wh === null || wh === undefined ? null : wh / 1000);

/** The positive part of a signed value (null kept). */
export const positive = (value) =>
  value === null || value === undefined ? null : Math.max(value, 0);
