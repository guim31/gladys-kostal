// -----------------------------------------------------------------------------
// One configured inverter (one slot of the configuration): its REST client,
// its service (inventory, readings), its reachability and login back-off,
// its scene triggers. The app runs one per inverter and owns what they
// share: the timer, the connection status, the list of discovered devices,
// the widget and the scene actions.
//
// Each inverter has its own session, its own password back-off (a refused
// password locks that inverter's account, not the others) and its own
// trigger memory (battery hysteresis, alarms already seen).
// -----------------------------------------------------------------------------

import { createClient } from './kostal/client.js';
import { createKostalService, inventoryFile } from './kostal/service.js';
import { deviceName, inverterIds, inverterStates } from './devices/inverter.js';
import { createTriggerWatcher } from './triggers.js';
import { createIssueLog } from './issues.js';
import { MESSAGES } from './i18n.js';

// A value that does not change is published again after this delay, so
// Gladys never shows "no recent value" (it does past 48 hours).
export const HEARTBEAT_MS = 6 * 60 * 60 * 1000;
// The inventory is read again this often (a battery installed, a firmware
// update): four light requests.
export const REDISCOVERY_MS = 30 * 60 * 1000;
// A refused password is tried again after this delay only.
export const AUTH_RETRY_MS = 15 * 60 * 1000;
// The battery settings are read again this often (when allowed).
export const SETTINGS_REFRESH_MS = 5 * 60 * 1000;
// The alarm texts are read again this often while an alarm stays active.
export const EVENTS_REFRESH_MS = 5 * 60 * 1000;

const AUTH_KINDS = new Set(['auth', 'locked']);
const NO_SERIAL = 'the inverter gives no serial number';

/**
 * @param {object} options
 * @param {{ slot: number, baseUrl: string, password: string }} options.inverter
 * @param {object} options.gladys
 * @param {{ read: Function, write: Function }} options.store
 * @param {Function} options.transport
 * @param {object} options.logger
 * @param {() => number} options.now
 * @param {() => object} options.config the normalized configuration
 * @param {() => Promise<void>} options.publishDevices publish the devices of every inverter
 * @param {() => Promise<void>} options.statusChanged the reachability of this inverter changed
 */
export function createInverterUnit({
  inverter,
  gladys,
  store,
  transport,
  logger,
  now,
  config,
  publishDevices,
  statusChanged,
}) {
  const { slot, baseUrl } = inverter;
  let password = inverter.password;
  const issues = createIssueLog(logger);
  const triggers = createTriggerWatcher({ gladys, logger, now });
  const client = createClient({ baseUrl, password: () => password, transport });
  const service = createKostalService({ client, store, now, file: inventoryFile(slot) });

  let reachable = null; // null: not known yet
  let failure = null; // the status message while it fails
  let authBlockedUntil = -Infinity;
  let discoveredAt = -Infinity;
  let lastCycleAt = -Infinity;
  let eventsReadAt = -Infinity;
  let eventsCount = 0;

  const externalId = () =>
    service.inventory ? inverterIds(gladys, service.inventory).device : null;

  /** The device (if the user added it) and its feature ids. */
  function createdOnGladys() {
    const features = new Set();
    const id = externalId();
    if (!id) {
      return { device: null, features };
    }
    const device = (gladys.devices ?? []).find((entry) => entry.external_id === id) ?? null;
    for (const feature of device?.features ?? []) {
      features.add(feature.external_id);
    }
    return { device, features };
  }

  async function publishTransport(value) {
    const { device } = createdOnGladys();
    if (!device) {
      return;
    }
    await gladys
      .publishTransports([{ external_id: device.external_id, transport: value }])
      .catch((err) => logger.debug(`Transport badge not sent (${err.message})`));
  }

  async function markReachable() {
    issues.ok('auth', `The inverter at ${baseUrl} accepts the password again`);
    failure = null;
    if (reachable === true) {
      return;
    }
    reachable = true;
    issues.ok('kostal', `The inverter at ${baseUrl} answers again`);
    await statusChanged();
    await publishTransport('local');
  }

  /** Report a failed exchange with the inverter: the password, or the network. */
  async function markFailed(err) {
    if (AUTH_KINDS.has(err.kind)) {
      // Not retried before the delay: the inverter locks the account.
      authBlockedUntil = now() + AUTH_RETRY_MS;
      client.forget();
      issues.fail(
        'auth',
        `The inverter at ${baseUrl} refused the login (${err.message}): next try in 15 minutes`,
      );
      reachable = false;
      failure = err.kind === 'locked' ? MESSAGES.locked : MESSAGES.authFailed;
      await statusChanged();
      await publishTransport('unreachable');
      return;
    }
    if (err.message === NO_SERIAL) {
      issues.fail('kostal', `The inverter at ${baseUrl} gives no serial number`);
      reachable = false;
      failure = MESSAGES.noSerial;
      await statusChanged();
      return;
    }
    issues.fail('kostal', `Inverter unreachable at ${baseUrl} (${err.message})`);
    if (reachable === false) {
      return;
    }
    reachable = false;
    failure = MESSAGES.unreachable(err.message);
    await statusChanged();
    await publishTransport('unreachable');
  }

  function describe(inventory) {
    return (
      `${deviceName(inventory, 'en')} (firmware ${inventory.versions.software ?? '?'}): ` +
      `${inventory.pvStrings.length} PV string(s), ${inventory.hasBattery ? 'battery' : 'no battery'}`
    );
  }

  /**
   * Log in if needed, read what the inverter is, publish the devices.
   * @throws the error (after reporting it)
   */
  async function discover() {
    let result;
    try {
      result = await service.discover();
    } catch (err) {
      await markFailed(err);
      throw err;
    }
    discoveredAt = now();
    // Said once per connection, and when the inverter changes.
    if (result.changed || reachable !== true) {
      logger.info(`Kostal inverter at ${baseUrl}: ${describe(result.inventory)}`);
    }
    await markReachable();
    await publishDevices();
    return result;
  }

  /** Alarm texts: read while an alarm is active, when the count moves or every 5 minutes. */
  async function updateEvents(snapshot) {
    const count = snapshot.activeErrors ?? 0;
    if (!(count > 0)) {
      service.clearEvents();
      eventsCount = 0;
      return;
    }
    if (count === eventsCount && now() - eventsReadAt < EVENTS_REFRESH_MS) {
      return;
    }
    try {
      await service.readEvents(config().language);
      eventsReadAt = now();
      eventsCount = count;
      issues.ok('events', `Events of the inverter at ${baseUrl} read again`);
    } catch (err) {
      issues.fail('events', `Events of the inverter at ${baseUrl} not read (${err.message})`);
    }
  }

  async function updateBatterySettings(force = false) {
    if (!config().allowSettings || !service.inventory?.hasBattery) {
      return;
    }
    const age = now() - (service.batterySettings?.readAt ?? -Infinity);
    if (!force && age < SETTINGS_REFRESH_MS) {
      return;
    }
    try {
      await service.readBatterySettings();
      issues.ok('settings', `Battery settings of the inverter at ${baseUrl} read again`);
    } catch (err) {
      issues.fail(
        'settings',
        `Battery settings of the inverter at ${baseUrl} not read (${err.message})`,
      );
    }
  }

  /** Read the measurements (and what goes with them). */
  async function read() {
    const snapshot = await service.refresh();
    lastCycleAt = now();
    await markReachable();
    await updateEvents(snapshot);
    await updateBatterySettings();
    return snapshot;
  }

  /** Publish the states of the cached reading (no request to the inverter). */
  async function publishSnapshot() {
    const { features } = createdOnGladys();
    if (!service.snapshot || features.size === 0) {
      return;
    }
    const states = inverterStates(gladys, service.inventory, {
      reading: service.snapshot,
      events: service.events,
      config: config(),
    }).filter((state) => features.has(state.device_feature_external_id));
    try {
      const { count } = await gladys.publishChangedStates(states, { heartbeat: HEARTBEAT_MS });
      issues.ok('states', `States of the inverter at ${baseUrl} accepted by Gladys again`);
      logger.debug(`${baseUrl}: ${count} state(s) published out of ${states.length}`);
    } catch (err) {
      issues.fail('states', `States of the inverter at ${baseUrl} not published (${err.message})`);
    }
  }

  async function evaluateTriggers() {
    await triggers.evaluate(service.inventory, service.snapshot, service.events, config());
  }

  /** Read, publish, fire the scene events. */
  async function readAndPublish() {
    await read();
    await publishSnapshot();
    await evaluateTriggers();
  }

  return {
    slot,
    baseUrl,
    service,
    get reachable() {
      return reachable;
    },
    /** The connection status message while this inverter fails, null otherwise. */
    get failure() {
      return failure;
    },
    get externalId() {
      return externalId();
    },
    get lastCycleAt() {
      return lastCycleAt;
    },
    get blocked() {
      return now() < authBlockedUntil;
    },
    createdOnGladys,
    discover,
    read,
    publishSnapshot,
    updateBatterySettings,

    /** The inventory of a previous run, if any. */
    load: () => service.load(),

    /** A new password typed in: the session of the old one is dropped. */
    setPassword(next) {
      if (next !== password) {
        password = next;
        client.forget();
      }
    },

    /** Saving the configuration, or a test, is the user's go for a new login. */
    unblock() {
      authBlockedUntil = -Infinity;
    },

    /** Discovery, then a first reading when the device is added. */
    async start() {
      const discovered = await discover().then(
        () => true,
        () => false,
      );
      if (discovered && createdOnGladys().device) {
        try {
          await readAndPublish();
        } catch (err) {
          await markFailed(err);
        }
      }
    },

    /**
     * One refresh of this inverter.
     * @returns {Promise<boolean>} true when it was read and published
     */
    async cycle() {
      if (now() < authBlockedUntil) {
        logger.debug(`${baseUrl}: password refused, waiting before the next try`);
        return false;
      }
      if (!service.inventory || now() - discoveredAt >= REDISCOVERY_MS) {
        try {
          await discover();
        } catch {
          if (!service.inventory || now() < authBlockedUntil) {
            return false;
          }
        }
      }
      if (!createdOnGladys().device) {
        logger.debug(`Kostal inverter at ${baseUrl} not added to Gladys yet: nothing to refresh`);
        return false;
      }
      try {
        await read();
      } catch (err) {
        await markFailed(err);
        return false;
      }
      await publishSnapshot();
      await evaluateTriggers();
      return true;
    },

    /** The "Test the connection" answer for this inverter. */
    async testConnection() {
      // A user's explicit try is allowed even while the password is blocked.
      authBlockedUntil = -Infinity;
      try {
        const { inventory } = await discover();
        const { allowSettings, language } = config();
        const { minSoc, smartControl } = inventory.settings;
        const known = [minSoc, smartControl].filter(Boolean);
        let settings = 'none';
        if (!allowSettings) settings = 'disabled';
        else if (known.some((meta) => meta.writable)) settings = 'writable';
        else if (known.length > 0) settings = 'readOnly';
        return MESSAGES.found({
          model: deviceName(inventory, language),
          firmware: inventory.versions.software,
          strings: inventory.pvStrings.length,
          battery: inventory.hasBattery,
          settings,
        });
      } catch (err) {
        if (err.kind === 'locked') return MESSAGES.locked;
        if (err.kind === 'auth') return MESSAGES.authFailed;
        if (err.message === NO_SERIAL) return MESSAGES.noSerial;
        return MESSAGES.unreachable(err.message);
      }
    },

    /** Free the inverter's session (it only keeps a few). */
    async logout() {
      await client.logout().catch(() => {});
    },
  };
}
