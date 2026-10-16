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
 * @param {() => object|null} options.service the Kostal service, null when not configured
 * @param {() => boolean} options.ready the inverter answered and its inventory is known
 * @param {(what: string) => Promise<void>} options.afterWrite read the settings back, log the change
 */
export function createSceneActions({ config, service, ready, afterWrite }) {
  function check(setting) {
    const { language, allowSettings } = config();
    if (!allowSettings) {
      throw fail(SCENE_ERRORS.notAllowed, language);
    }
    const kostal = service();
    if (!kostal?.inventory || !ready()) {
      throw fail(SCENE_ERRORS.notReady, language);
    }
    const meta = kostal.inventory.settings[setting];
    if (!meta?.writable) {
      throw fail(SCENE_ERRORS.unavailable, language);
    }
    return { kostal, meta, language };
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
      const { kostal, meta, language } = check('minSoc');
      const asked = Number(fields?.level);
      if (!Number.isFinite(asked) || asked < meta.min || asked > meta.max) {
        throw fail(SCENE_ERRORS.outOfRange(meta.min, meta.max), language);
      }
      const rounded = Math.round(asked / MIN_SOC_STEP) * MIN_SOC_STEP;
      const level = Math.min(Math.max(rounded, meta.min), meta.max);
      await write(language, () => kostal.writeMinSoc(level));
      await afterWrite(`minimum state of charge set to ${level} %`);
      return { min_soc: level };
    },

    async [SCENE_ACTIONS.setSmartControl](fields) {
      const { kostal, language } = check('smartControl');
      const enabled = fields?.enabled === 'on' || fields?.enabled === true;
      await write(language, () => kostal.writeSmartControl(enabled));
      await afterWrite(`smart battery control ${enabled ? 'on' : 'off'}`);
      return { enabled };
    },
  };
}
