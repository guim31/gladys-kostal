// -----------------------------------------------------------------------------
// The integration, wired to a Gladys client (the SDK's GladysIntegration, or
// its fake Gladys in the tests).
//
// Life of the integration:
// 1. On connection and on every configuration change: the device kept in
//    /data is published at once, then the inverter is logged in and read
//    whole (discovery) and its device published again.
// 2. Every refresh interval (10 to 60 s), the container's own timer runs a
//    cycle: one request for the measurements (plus the alarm texts while an
//    alarm is active, and the battery settings every 5 minutes when allowed),
//    then the states that changed, the scene events, the widget nudge.
//    Gladys's onPoll is only a fallback, skipped when the timer just ran
//    (GladysAssistant/Gladys#3198: a device created without should_poll is
//    never polled by Gladys 5.2).
// 3. Only a device the user added is refreshed: without it, nothing is read
//    (except for the widget, at most once per interval).
// 4. A refused password is not retried for 15 minutes (or until the
//    configuration is saved): the inverter locks the account after several
//    failed logins.
//
// Logs: info for the life cycle only (start, inverter found, lost and back,
// one line per user action); a normal cycle writes debug lines only. The
// password and the session id are never written.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { DEFAULT_CONFIG, isConfigured, normalizeConfig } from './config.js';
import { createClient, httpRequest } from './kostal/client.js';
import { createKostalService } from './kostal/service.js';
import { buildInverter, deviceName, inverterIds, inverterStates } from './devices/inverter.js';
import { createTriggerWatcher } from './triggers.js';
import { createSceneActions } from './scenes.js';
import { createIssueLog } from './issues.js';
import { MESSAGES } from './i18n.js';
import { WIDGET_KEY, buildFlowContent, noDataContent, notConfiguredContent } from './widgets.js';

export const ACTIONS = { testConnection: 'test_connection' };
export const WIDGETS = [WIDGET_KEY];

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
// The widget content follows the states: one nudge a minute at most.
const WIDGET_NUDGE_MS = 60 * 1000;

const AUTH_KINDS = new Set(['auth', 'locked']);

/**
 * @param {object} options
 * @param {object} options.gladys GladysIntegration or the SDK's fake Gladys
 * @param {{ read: Function, write: Function }} options.store /data
 * @param {Function} [options.transport] HTTP transport (node:http by default)
 * @param {object} [options.logger]
 * @param {() => number} [options.now]
 * @param {boolean} [options.timers] run the refresh timer (tests may drive cycles by hand)
 * @param {string} [options.timeZone] defaults to TZ
 */
export function createApp({
  gladys,
  store,
  transport = httpRequest,
  logger = createLogger({ name: 'kostal' }),
  now = () => Date.now(),
  timers = true,
  timeZone = process.env.TZ || undefined,
}) {
  const issues = createIssueLog(logger);
  const triggers = createTriggerWatcher({ gladys, logger, now });

  let config = normalizeConfig(DEFAULT_CONFIG);
  let client = null;
  let service = null;
  let timer = null;
  let stopped = false;
  let running = null; // the cycle in progress
  let lastCycleAt = -Infinity;
  let discoveredAt = -Infinity;
  let lastNudgeAt = -Infinity;
  let eventsReadAt = -Infinity;
  let eventsCount = 0;
  let reachable = null; // null: not known yet
  let authBlockedUntil = -Infinity;

  // --- Helpers -----------------------------------------------------------------

  /** The device (if the user added it) and its feature ids. */
  function createdOnGladys() {
    const features = new Set();
    const inventory = service?.inventory;
    if (!inventory) {
      return { device: null, features };
    }
    const externalId = inverterIds(gladys, inventory).device;
    const device = (gladys.devices ?? []).find((entry) => entry.external_id === externalId) ?? null;
    for (const feature of device?.features ?? []) {
      features.add(feature.external_id);
    }
    return { device, features };
  }

  async function setStatus(connected, message) {
    await gladys.setConnectionStatus(connected, message).catch((err) => {
      logger.debug(`Connection status not sent (${err.message})`);
    });
  }

  async function publishTransport(transport) {
    const { device } = createdOnGladys();
    if (!device) {
      return;
    }
    await gladys
      .publishTransports([{ external_id: device.external_id, transport }])
      .catch((err) => logger.debug(`Transport badge not sent (${err.message})`));
  }

  async function markReachable() {
    issues.ok('auth', 'The inverter accepts the password again');
    if (reachable === true) {
      return;
    }
    reachable = true;
    issues.ok('kostal', 'The inverter answers again');
    await setStatus(true);
    await publishTransport('local');
  }

  /** Report a failed exchange with the inverter: the password, or the network. */
  async function markFailed(err) {
    if (AUTH_KINDS.has(err.kind)) {
      // Not retried before the delay: the inverter locks the account.
      authBlockedUntil = now() + AUTH_RETRY_MS;
      client?.forget();
      issues.fail(
        'auth',
        `The inverter refused the login (${err.message}): next try in 15 minutes`,
      );
      reachable = false;
      await setStatus(false, err.kind === 'locked' ? MESSAGES.locked : MESSAGES.authFailed);
      await publishTransport('unreachable');
      return;
    }
    if (err.noSerial) {
      issues.fail('kostal', `The inverter at ${config.baseUrl} gives no serial number`);
      reachable = false;
      await setStatus(false, MESSAGES.noSerial);
      return;
    }
    issues.fail('kostal', `Inverter unreachable at ${config.baseUrl} (${err.message})`);
    if (reachable === false) {
      return;
    }
    reachable = false;
    await setStatus(false, MESSAGES.unreachable(err.message));
    await publishTransport('unreachable');
  }

  async function publishDevice() {
    if (!service?.inventory) {
      return;
    }
    try {
      await gladys.publishDiscoveredDevices([buildInverter(gladys, service.inventory, config)]);
      issues.ok('publish', 'Device accepted by Gladys again');
    } catch (err) {
      issues.fail('publish', `Gladys refused the device (${err.message})`);
      await setStatus(false, MESSAGES.publishFailed(err.message));
    }
  }

  function describe(inventory) {
    return (
      `${deviceName(inventory, 'en')} (firmware ${inventory.versions.software ?? '?'}): ` +
      `${inventory.pvStrings.length} PV string(s), ${inventory.hasBattery ? 'battery' : 'no battery'}`
    );
  }

  /**
   * Log in if needed, read what the inverter is, publish its device.
   * @throws the error (after reporting it)
   */
  async function discoverAndPublish() {
    let result;
    try {
      result = await service.discover();
    } catch (err) {
      if (err.message === 'the inverter gives no serial number') {
        err.noSerial = true;
      }
      await markFailed(err);
      throw err;
    }
    discoveredAt = now();
    // Said once per connection, and when the inverter changes.
    if (result.changed || reachable !== true) {
      logger.info(`Kostal inverter at ${config.baseUrl}: ${describe(result.inventory)}`);
    }
    await markReachable();
    await publishDevice();
    return result;
  }

  function nudgeWidget(force = false) {
    if (!force && now() - lastNudgeAt < WIDGET_NUDGE_MS) {
      return;
    }
    lastNudgeAt = now();
    try {
      // Synchronous, fire and forget: dropped by the SDK while disconnected.
      gladys.requestWidgetRefresh(WIDGET_KEY);
    } catch (err) {
      logger.debug(`Widget nudge not sent (${err.message})`);
    }
  }

  /** Publish the states of the cached reading (no request to the inverter). */
  async function publishSnapshot() {
    const { features } = createdOnGladys();
    if (!service?.snapshot || features.size === 0) {
      return;
    }
    const states = inverterStates(gladys, service.inventory, {
      reading: service.snapshot,
      events: service.events,
      config,
    }).filter((state) => features.has(state.device_feature_external_id));
    try {
      const { count } = await gladys.publishChangedStates(states, { heartbeat: HEARTBEAT_MS });
      issues.ok('states', 'States accepted by Gladys again');
      logger.debug(`${count} state(s) published out of ${states.length}`);
    } catch (err) {
      issues.fail('states', `States not published (${err.message})`);
    }
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
      await service.readEvents(config.language);
      eventsReadAt = now();
      eventsCount = count;
      issues.ok('events', 'Inverter events read again');
    } catch (err) {
      issues.fail('events', `Inverter events not read (${err.message})`);
    }
  }

  async function updateBatterySettings(force = false) {
    if (!config.allowSettings || !service.inventory?.hasBattery) {
      return;
    }
    const age = now() - (service.batterySettings?.readAt ?? -Infinity);
    if (!force && age < SETTINGS_REFRESH_MS) {
      return;
    }
    try {
      await service.readBatterySettings();
      issues.ok('settings', 'Battery settings read again');
    } catch (err) {
      issues.fail('settings', `Battery settings not read (${err.message})`);
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

  // --- The cycle -------------------------------------------------------------------

  async function runCycle() {
    if (!isConfigured(config) || !service || gladys.connected === false) {
      logger.debug('Cycle skipped (not configured or Gladys unreachable)');
      return;
    }
    if (now() < authBlockedUntil) {
      logger.debug('Cycle skipped (password refused, waiting before the next try)');
      return;
    }
    if (!service.inventory || now() - discoveredAt >= REDISCOVERY_MS) {
      try {
        await discoverAndPublish();
      } catch {
        if (!service.inventory || now() < authBlockedUntil) {
          return;
        }
      }
    }
    if (!createdOnGladys().device) {
      logger.debug('Kostal inverter not added to Gladys yet: nothing to refresh');
      return;
    }
    let snapshot;
    try {
      snapshot = await read();
    } catch (err) {
      await markFailed(err);
      return;
    }
    await publishSnapshot();
    await triggers.evaluate(service.inventory, snapshot, service.events, config);
    nudgeWidget();
  }

  /** One cycle at a time: a caller arriving during a cycle waits for it. */
  function cycle() {
    if (!running) {
      running = runCycle()
        .catch((err) => logger.error(`Refresh cycle failed (${err.message})`))
        .finally(() => {
          running = null;
        });
    }
    return running;
  }

  function schedule() {
    clearTimeout(timer);
    timer = null;
    if (!timers || stopped || !isConfigured(config)) {
      return;
    }
    timer = setTimeout(async () => {
      timer = null;
      await cycle();
      schedule();
    }, config.pollIntervalMs);
  }

  // --- Configuration -------------------------------------------------------------

  async function applyConfig(raw) {
    const next = normalizeConfig(raw ?? {});
    const hostChanged = next.baseUrl !== config.baseUrl || !service;
    const passwordChanged = next.password !== config.password;
    config = next;
    // Saving the configuration is the user's go for a new login attempt.
    authBlockedUntil = -Infinity;
    if (!isConfigured(config)) {
      clearTimeout(timer);
      await client?.logout().catch(() => {});
      client = null;
      service = null;
      logger.info(
        config.hostValid
          ? 'Waiting for the address and the password of the inverter'
          : 'Invalid inverter address',
      );
      await setStatus(false, config.hostValid ? MESSAGES.notConfigured : MESSAGES.invalidHost);
      return;
    }
    if (hostChanged) {
      await client?.logout().catch(() => {});
      client = createClient({
        baseUrl: config.baseUrl,
        password: () => config.password,
        transport,
      });
      service = createKostalService({ client, store, now });
      triggers.reset();
      reachable = null;
      discoveredAt = -Infinity;
      if (await service.load()) {
        // Known from a previous run: the device is there even if the
        // inverter does not answer right now.
        await publishDevice();
      }
    } else if (passwordChanged) {
      client.forget();
    }
    // The discovery reports its own failure; the timer tries again.
    const discovered = await discoverAndPublish().then(
      () => true,
      () => false,
    );
    if (discovered && createdOnGladys().device) {
      try {
        await read();
        await publishSnapshot();
        await triggers.evaluate(service.inventory, service.snapshot, service.events, config);
      } catch (err) {
        await markFailed(err);
      }
    }
    schedule();
  }

  const sceneActions = createSceneActions({
    config: () => config,
    service: () => service,
    ready: () => reachable === true,
    afterWrite: async (what) => {
      logger.info(`Scene action: ${what}`);
      await updateBatterySettings(true);
      nudgeWidget(true);
    },
  });

  // --- Handlers --------------------------------------------------------------------

  const handlers = {
    async scanRequest() {
      logger.info('Discovery requested from Gladys');
      if (!service || now() < authBlockedUntil) {
        await publishDevice();
        return;
      }
      await discoverAndPublish().catch(() => publishDevice());
    },

    /** The core's onPoll: a fallback, skipped while the timer is on time. */
    async poll(device) {
      if (!service || device.external_id !== createdOnGladys().device?.external_id) {
        return;
      }
      const age = now() - Math.max(lastCycleAt, service.snapshot?.fetchedAt ?? -Infinity);
      if (age < config.pollIntervalMs * 0.9) {
        logger.debug(`onPoll ${device.external_id}: read ${age} ms ago, skipped`);
        return;
      }
      await cycle();
    },

    /** The device was just added (or updated): Gladys needs all its states now. */
    async deviceChanged(device) {
      if (!service || device.external_id !== createdOnGladys().device?.external_id) {
        return;
      }
      if (service.snapshot) {
        await publishSnapshot();
      } else {
        await cycle();
      }
      nudgeWidget(true);
    },

    async testConnection() {
      logger.info('Action: test the connection');
      if (!isConfigured(config)) {
        return config.hostValid ? MESSAGES.notConfigured : MESSAGES.invalidHost;
      }
      // A user's explicit try is allowed even while the password is blocked.
      authBlockedUntil = -Infinity;
      try {
        const { inventory } = await discoverAndPublish();
        const { minSoc, smartControl } = inventory.settings;
        const known = [minSoc, smartControl].filter(Boolean);
        let settings = 'none';
        if (!config.allowSettings) settings = 'disabled';
        else if (known.some((meta) => meta.writable)) settings = 'writable';
        else if (known.length > 0) settings = 'readOnly';
        return MESSAGES.found({
          model: deviceName(inventory, config.language),
          firmware: inventory.versions.software,
          strings: inventory.pvStrings.length,
          battery: inventory.hasBattery,
          settings,
        });
      } catch (err) {
        if (err.kind === 'locked') return MESSAGES.locked;
        if (err.kind === 'auth') return MESSAGES.authFailed;
        if (err.noSerial) return MESSAGES.noSerial;
        return MESSAGES.unreachable(err.message);
      }
    },

    async widgetGet() {
      if (!isConfigured(config) || !service) {
        return notConfiguredContent();
      }
      const { device, features } = createdOnGladys();
      // Without the device added, no cycle runs: read for the widget, at the
      // configured pace at most.
      if (service.inventory && !device && now() >= authBlockedUntil) {
        const age = now() - (service.snapshot?.fetchedAt ?? -Infinity);
        if (age >= config.pollIntervalMs) {
          await read().catch((err) => logger.debug(`Widget: inverter not read (${err.message})`));
        }
      }
      if (!service.inventory || !service.snapshot) {
        return noDataContent();
      }
      return buildFlowContent({
        gladys,
        inventory: service.inventory,
        snapshot: service.snapshot,
        events: service.events,
        batterySettings: service.batterySettings,
        created: features,
        config,
        timeZone,
      });
    },

    sceneActions,
  };

  return {
    handlers,
    get config() {
      return config;
    },
    get service() {
      return service;
    },
    cycle,

    /** Register every handler on the Gladys client (before connect()). */
    register() {
      gladys.onScanRequest(() => handlers.scanRequest());
      gladys.onPoll((device) => handlers.poll(device));
      gladys.onDeviceCreated((device) => handlers.deviceChanged(device));
      gladys.onDeviceUpdated((device) => handlers.deviceChanged(device));
      gladys.onAction(ACTIONS.testConnection, () => handlers.testConnection());
      gladys.onWidgetGet(WIDGET_KEY, () => handlers.widgetGet());
      for (const [key, handler] of Object.entries(sceneActions)) {
        gladys.onSceneAction(key, (fields) => handler(fields));
      }
      gladys.onConfigUpdated(async (raw) => {
        logger.info('Configuration updated');
        await applyConfig(raw);
      });
      gladys.on('connected', async () => {
        try {
          await applyConfig(await gladys.getConfig());
        } catch (err) {
          logger.error(`Initialization failed (${err.message})`);
        }
      });
    },

    async stop() {
      stopped = true;
      clearTimeout(timer);
      timer = null;
      await running;
      // Free the inverter's session (it only keeps a few).
      await client?.logout().catch(() => {});
    },
  };
}
