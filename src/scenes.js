// -----------------------------------------------------------------------------
// Scene actions: the two battery settings the plant owner can change, when the
// user allowed it in the configuration (off by default).
//
// - `set_battery_min_soc`: the minimum state of charge the battery keeps
//   (keep a reserve before a storm, lower it again in summer).
// - `set_smart_battery_control`: Kostal's smart battery management on or off.
//
// They are scene actions, not device features: nothing on a dashboard can
// change them by a mistaken tap, and every change is one info line in the
// logs. A setting the inverter does not offer as writable to the plant owner
// is refused before any request.
//
// Each action has an optional "Inverter" field: empty, it acts on the first
// inverter with a battery (with a single inverter, the scenes made with 1.0
// keep working unchanged).
// -----------------------------------------------------------------------------

import { SCENE_ERRORS, pick } from './i18n.js';

export const SCENE_ACTIONS = {
  setMinSoc: 'set_battery_min_soc',
  setSmartControl: 'set_smart_battery_control',
};
export const SCENE_ACTION_KEYS = Object.values(SCENE_ACTIONS);

// The Kostal web interface and Home Assistant move the minimum state of
// charge by steps of 5 %.
export const MIN_SOC_STEP = 5;

/** An error whose message is in the configured language (shown in the scene logs). */
function fail(text, language) {
  return new Error(pick(text, language));
}

/**
 * @param {object} options
 * @param {() => object} options.config the normalized configuration
 * @param {() => Array<object>} options.units the inverters (src/unit.js), in slot order
 * @param {(unit: object, what: string) => Promise<void>} options.afterWrite read the settings back, log the change
 */
export function createSceneActions({ config, units, afterWrite }) {
  /** The inverter a scene asks for: by its device, or the first with a battery. */
  function target(fields, language) {
    const list = units();
    const wanted = typeof fields?.device === 'string' ? fields.device : '';
    if (wanted === '') {
      return list.find((unit) => unit.service.inventory?.hasBattery) ?? list[0] ?? null;
    }
    const unit = list.find((entry) => entry.externalId === wanted);
    if (!unit && list.every((entry) => entry.externalId)) {
      throw fail(SCENE_ERRORS.unknownInverter, language);
    }
    return unit ?? null;
  }

  function check(setting, fields) {
    const { language, allowSettings } = config();
    if (!allowSettings) {
      throw fail(SCENE_ERRORS.notAllowed, language);
    }
    const unit = target(fields, language);
    const kostal = unit?.service;
    if (!kostal?.inventory || unit.reachable !== true) {
      throw fail(SCENE_ERRORS.notReady, language);
    }
    const meta = kostal.inventory.settings[setting];
    if (!meta?.writable) {
      throw fail(SCENE_ERRORS.unavailable, language);
    }
    return { unit, kostal, meta, language };
  }

  async function write(language, task) {
    try {
      await task();
    } catch (err) {
      throw fail(SCENE_ERRORS.refused(err.message), language);
    }
  }

  return {
    async [SCENE_ACTIONS.setMinSoc](fields) {
      const { unit, kostal, meta, language } = check('minSoc', fields);
      const asked = Number(fields?.level);
      if (!Number.isFinite(asked) || asked < meta.min || asked > meta.max) {
        throw fail(SCENE_ERRORS.outOfRange(meta.min, meta.max), language);
      }
      const rounded = Math.round(asked / MIN_SOC_STEP) * MIN_SOC_STEP;
      const level = Math.min(Math.max(rounded, meta.min), meta.max);
      await write(language, () => kostal.writeMinSoc(level));
      await afterWrite(unit, `minimum state of charge set to ${level} %`);
      return { min_soc: level };
    },

    async [SCENE_ACTIONS.setSmartControl](fields) {
      const { unit, kostal, language } = check('smartControl', fields);
      const enabled = fields?.enabled === 'on' || fields?.enabled === true;
      await write(language, () => kostal.writeSmartControl(enabled));
      await afterWrite(unit, `smart battery control ${enabled ? 'on' : 'off'}`);
      return { enabled };
    },
  };
}
