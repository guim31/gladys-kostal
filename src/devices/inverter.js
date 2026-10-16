// -----------------------------------------------------------------------------
// The Gladys device of one Kostal inverter, built from its inventory, and its
// states, built from the latest reading.
//
// One device per inverter: solar production (total and per string), house
// consumption, grid exchange, battery (when there is one), the day's and the
// lifetime counters, the inverter state and its alarms. Every feature is a
// read-only measurement: the battery settings are changed through the scene
// actions only, when the user allowed them (src/scenes.js).
//
// A feature exists only when the inverter lists the process data behind it.
// Its external id is built from the serial number of the inverter and a
// stable key: never rename a key.
// -----------------------------------------------------------------------------

import { DEVICE_NAMES, FEATURE_NAMES, TEXTS, inverterStateText, pick } from '../i18n.js';
import { MODULES } from '../kostal/parse.js';
import {
  COUPLES,
  CORE_POLL_FREQUENCY,
  KIND,
  feature,
  kwh,
  numericState,
  positive,
  textState,
} from './helpers.js';

export const INVERTER_TYPE = 'inverter';

export const FEATURES = {
  pvPower: 'pv_power',
  stringPower: (n) => `pv${n}_power`,
  acPower: 'ac_power',
  homePower: 'home_power',
  gridPower: 'grid_power',
  batteryLevel: 'battery_level',
  batteryCharge: 'battery_charge_power',
  batteryDischarge: 'battery_discharge_power',
  batteryCycles: 'battery_cycles',
  productionToday: 'production_today',
  productionTotal: 'production_total',
  homeGridTotal: 'home_grid_total',
  exportTotal: 'grid_export_total',
  chargeTotal: 'battery_charge_total',
  dischargeTotal: 'battery_discharge_total',
  inverterState: 'inverter_state',
  activeAlarms: 'active_alarms',
  latestAlarm: 'latest_alarm',
};

export const inverterIds = (gladys, inventory) =>
  gladys.externalIds(INVERTER_TYPE, inventory.serial);

const hasStat = (inventory, id) =>
  inventory.process[MODULES.stats]?.includes(`Statistic:${id}`) ?? false;

/** The device name: the model as the inverter gives it ("Kostal PLENTICORE plus 10"). */
export function deviceName(inventory, language) {
  return inventory.model ? `Kostal ${inventory.model}` : pick(DEVICE_NAMES.inverter, language);
}

export function buildInverter(gladys, inventory, config) {
  const ids = inverterIds(gladys, inventory);
  const { language } = config;
  const F = FEATURES;
  const add = (key, name, couple, kind) =>
    features.push(feature(ids, key, name, language, couple, kind));
  const features = [];

  const hasDc = inventory.process[MODULES.local]?.includes('Dc_P') ?? false;
  if (inventory.pvStrings.length > 0 || hasDc) {
    add(F.pvPower, FEATURE_NAMES.pvPower, COUPLES.productionPower, KIND.power);
  }
  // One string: its power is the solar power, no second feature.
  if (inventory.pvStrings.length > 1) {
    for (const n of inventory.pvStrings) {
      add(F.stringPower(n), FEATURE_NAMES.stringPower(n), COUPLES.productionPower, KIND.power);
    }
  }
  if (inventory.hasHome) {
    add(F.homePower, FEATURE_NAMES.homePower, COUPLES.homePower, KIND.power);
  }
  if (inventory.hasGrid) {
    add(F.gridPower, FEATURE_NAMES.gridPower, COUPLES.gridPower, KIND.signedPower);
  }
  if (inventory.hasAc) {
    add(F.acPower, FEATURE_NAMES.acPower, COUPLES.acOutput, KIND.power);
  }
  if (inventory.hasBattery) {
    add(F.batteryLevel, FEATURE_NAMES.batteryLevel, COUPLES.batteryLevel, KIND.percent);
    if (inventory.process[MODULES.battery]?.includes('P')) {
      add(F.batteryCharge, FEATURE_NAMES.batteryCharge, COUPLES.batteryCharge, KIND.power);
      add(F.batteryDischarge, FEATURE_NAMES.batteryDischarge, COUPLES.batteryDischarge, KIND.power);
    }
    if (inventory.process[MODULES.battery]?.includes('Cycles')) {
      add(F.batteryCycles, FEATURE_NAMES.batteryCycles, COUPLES.counter, KIND.count);
    }
  }
  if (hasStat(inventory, 'Yield:Day')) {
    add(F.productionToday, FEATURE_NAMES.productionToday, COUPLES.productionToday, KIND.dayEnergy);
  }
  if (hasStat(inventory, 'Yield:Total')) {
    add(F.productionTotal, FEATURE_NAMES.productionTotal, COUPLES.productionIndex, KIND.index);
  }
  if (hasStat(inventory, 'EnergyHomeGrid:Total')) {
    add(F.homeGridTotal, FEATURE_NAMES.homeGridTotal, COUPLES.homeGridIndex, KIND.index);
  }
  if (
    ['Yield:Total', 'EnergyHomePv:Total', 'EnergyHomeBat:Total'].every((id) =>
      hasStat(inventory, id),
    )
  ) {
    add(F.exportTotal, FEATURE_NAMES.exportTotal, COUPLES.gridExportIndex, KIND.index);
  }
  if (inventory.hasBattery && hasStat(inventory, 'EnergyChargePv:Total')) {
    add(F.chargeTotal, FEATURE_NAMES.chargeTotal, COUPLES.batteryChargeIndex, KIND.index);
  }
  if (inventory.hasBattery && hasStat(inventory, 'EnergyDischarge:Total')) {
    add(F.dischargeTotal, FEATURE_NAMES.dischargeTotal, COUPLES.batteryDischargeIndex, KIND.index);
  }
  if (inventory.process[MODULES.local]?.includes('Inverter:State')) {
    add(F.inverterState, FEATURE_NAMES.inverterState, COUPLES.text, KIND.text);
  }
  if (inventory.hasEvents) {
    add(F.activeAlarms, FEATURE_NAMES.activeAlarms, COUPLES.counter, KIND.count);
    add(F.latestAlarm, FEATURE_NAMES.alarmText, COUPLES.text, KIND.text);
  }

  return {
    name: deviceName(inventory, language),
    external_id: ids.device,
    should_poll: true,
    poll_frequency: CORE_POLL_FREQUENCY,
    features,
  };
}

/**
 * The text of the latest active alarm, or "No alarm".
 * @param {number} activeErrors the inverter's count
 * @param {Array} events the active events read, newest first
 */
export function latestAlarmText(activeErrors, events, language) {
  if (!(activeErrors > 0)) {
    return pick(TEXTS.noAlarm, language);
  }
  const [latest] = events;
  if (!latest) {
    // Counted, but its description not read (yet).
    return pick(TEXTS.alarmPending, language);
  }
  if (latest.description) {
    return latest.description;
  }
  return pick(TEXTS.alarmCode(latest.code ?? '?'), language);
}

/**
 * The states of the device, from a reading.
 * @param {object} ctx
 * @param {object} ctx.reading parseReading()
 * @param {Array} ctx.events the active events, newest first
 * @param {object} ctx.config
 */
export function inverterStates(gladys, inventory, { reading, events, config }) {
  const ids = inverterIds(gladys, inventory);
  const F = FEATURES;
  const id = (key) => ids.feature(key);
  const states = [];
  numericState(states, id(F.pvPower), reading.pvPower, 0);
  if (inventory.pvStrings.length > 1) {
    for (const n of inventory.pvStrings) {
      numericState(states, id(F.stringPower(n)), reading.strings[n], 0);
    }
  }
  numericState(states, id(F.homePower), positive(reading.homePower), 0);
  numericState(states, id(F.gridPower), reading.gridPower, 0);
  numericState(states, id(F.acPower), positive(reading.acPower), 0);
  if (reading.battery) {
    const { soc, power, cycles } = reading.battery;
    numericState(states, id(F.batteryLevel), soc, 0);
    if (power !== null) {
      // The API counts a discharge positive, a charge negative.
      numericState(states, id(F.batteryCharge), Math.max(-power, 0), 0);
      numericState(states, id(F.batteryDischarge), Math.max(power, 0), 0);
    }
    numericState(states, id(F.batteryCycles), cycles, 0);
  }
  numericState(states, id(F.productionToday), kwh(reading.yieldDay), 2);
  // Lifetime counters: never publish 0, an index that drops to zero breaks
  // the energy graphs and the derived consumption.
  for (const [key, wh] of [
    [F.productionTotal, reading.yieldTotal],
    [F.homeGridTotal, reading.homeGridTotal],
    [F.exportTotal, reading.exportTotal],
    [F.chargeTotal, reading.chargeTotal],
    [F.dischargeTotal, reading.dischargeTotal],
  ]) {
    if (wh) {
      numericState(states, id(key), kwh(wh), 2);
    }
  }
  if (reading.inverterState !== null) {
    textState(
      states,
      id(F.inverterState),
      pick(inverterStateText(reading.inverterState), config.language),
    );
  }
  if (inventory.hasEvents && reading.activeErrors !== null) {
    numericState(states, id(F.activeAlarms), reading.activeErrors, 0);
    textState(
      states,
      id(F.latestAlarm),
      latestAlarmText(reading.activeErrors, events, config.language).slice(0, 255),
    );
  }
  // Only the features the device has (a feature dropped from the inventory
  // would be refused).
  const known = new Set(
    buildInverter(gladys, inventory, config).features.map((f) => f.external_id),
  );
  return states.filter((state) => known.has(state.device_feature_external_id));
}
