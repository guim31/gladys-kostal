// -----------------------------------------------------------------------------
// The integration, wired to a Gladys client (the SDK's GladysIntegration, or
// its fake Gladys in the tests).
//
// Life of the integration:
// 1. On connection and on every configuration change: the devices kept in
//    /data are published at once, then each inverter is logged in and read
//    whole (discovery) and the devices published again.
// 2. Every refresh interval (10 to 60 s), the container's own timer runs a
//    cycle over every inverter, one after the other: one request for the
//    measurements (plus the alarm texts while an alarm is active, and the
//    battery settings every 5 minutes when allowed), then the states that
//    changed, the scene events, the widget nudge. Gladys's onPoll is only a
//    fallback, skipped when the timer just ran (GladysAssistant/Gladys#3198: a
//    device created without should_poll is never polled by Gladys 5.2).
// 3. Only a device the user added is refreshed: without it, nothing is read
//    (except for the widget, at most once per interval).
// 4. A refused password is not retried for 15 minutes (or until the
//    configuration is saved): the inverter locks the account after several
//    failed logins. Each inverter has its own back-off (src/unit.js).
//
// Up to three inverters (src/config.js), one Gladys device each, keyed on
// the serial number. The connection status of the Configuration screen is
// the integration's: connected when every inverter answers, otherwise the
// problem of the first one that fails, named when there are several.
//
// Logs: info for the life cycle only (start, inverter found, lost and back,
// one line per user action); a normal cycle writes debug lines only. The
// passwords and the session ids are never written.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { DEFAULT_CONFIG, isConfigured, normalizeConfig } from './config.js';
import { httpRequest } from './kostal/client.js';
import { buildInverter, deviceName } from './devices/inverter.js';
import { createSceneActions } from './scenes.js';
import { createIssueLog } from './issues.js';
import { MESSAGES, aboutInverter, localize, pick } from './i18n.js';
import { createInverterUnit } from './unit.js';
import { WIDGET_KEY, buildFlowContent, noDataContent, notConfiguredContent } from './widgets.js';

export {
  AUTH_RETRY_MS,
  EVENTS_REFRESH_MS,
  HEARTBEAT_MS,
  REDISCOVERY_MS,
  SETTINGS_REFRESH_MS,
} from './unit.js';

export const ACTIONS = { testConnection: 'test_connection' };
export const WIDGETS = [WIDGET_KEY];

// The widget content follows the states: one nudge a minute at most.
const WIDGET_NUDGE_MS = 60 * 1000;

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

  let config = normalizeConfig(DEFAULT_CONFIG);
  /** @type {Map<number, ReturnType<typeof createInverterUnit>>} by slot, in slot order */
  let units = new Map();
  let timer = null;
  let stopped = false;
  let running = null; // the cycle in progress
  let lastNudgeAt = -Infinity;
  let publishError = null; // why Gladys refused the devices, while it does
  let lastStatus = null; // the connection status last sent

  const unitList = () => [...units.values()];
  const unitOf = (externalId) =>
    externalId ? (unitList().find((unit) => unit.externalId === externalId) ?? null) : null;
  const several = () => config.inverters.length + config.invalidSlots.length > 1;
  // With several inverters, a message says which one it is about.
  const about = (slot, message) => (several() ? aboutInverter(slot, message) : message);

  // --- Connection status --------------------------------------------------------

  function currentStatus() {
    if (!isConfigured(config)) {
      const invalid = config.invalidSlots.length > 0;
      return { connected: false, message: invalid ? MESSAGES.invalidHost : MESSAGES.notConfigured };
    }
    if (publishError) {
      return { connected: false, message: MESSAGES.publishFailed(publishError) };
    }
    const failing = unitList().find((unit) => unit.failure);
    if (failing) {
      return { connected: false, message: about(failing.slot, failing.failure) };
    }
    if (config.invalidSlots.length > 0) {
      return { connected: false, message: about(config.invalidSlots[0], MESSAGES.invalidHost) };
    }
    if (unitList().every((unit) => unit.reachable === true)) {
      return { connected: true };
    }
    return null; // an inverter not known yet: say nothing before it is
  }

  /** Send the connection status when it changed. */
  async function refreshStatus() {
    const status = currentStatus();
    const key = JSON.stringify(status);
    if (!status || key === lastStatus) {
      return;
    }
    lastStatus = key;
    await gladys.setConnectionStatus(status.connected, status.message).catch((err) => {
      logger.debug(`Connection status not sent (${err.message})`);
    });
  }

  // --- Devices and widget ---------------------------------------------------------

  /** The devices of every inverter known, as one list (it replaces the previous one). */
  async function publishDevices() {
    const devices = [];
    for (const unit of unitList()) {
      const { inventory } = unit.service;
      if (inventory && !devices.some((device) => device.external_id === unit.externalId)) {
        devices.push(buildInverter(gladys, inventory, config));
      }
    }
    if (devices.length === 0) {
      return;
    }
    try {
      await gladys.publishDiscoveredDevices(devices);
      issues.ok('publish', 'Devices accepted by Gladys again');
      publishError = null;
    } catch (err) {
      issues.fail('publish', `Gladys refused the devices (${err.message})`);
      publishError = err.message;
    }
    await refreshStatus();
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

  function createUnit(inverter) {
    return createInverterUnit({
      inverter,
      gladys,
      store,
      transport,
      logger,
      now,
      config: () => config,
      publishDevices,
      statusChanged: refreshStatus,
    });
  }

  // --- The cycle -------------------------------------------------------------------

  async function runCycle() {
    if (!isConfigured(config) || gladys.connected === false) {
      logger.debug('Cycle skipped (not configured or Gladys unreachable)');
      return;
    }
    let read = false;
    for (const unit of unitList()) {
      if (await unit.cycle()) {
        read = true;
      }
    }
    if (read) {
      nudgeWidget();
    }
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
    config = normalizeConfig(raw ?? {});
    // Said again after a (re)connection or a save, even if unchanged.
    lastStatus = null;
    // An inverter whose address changed, or that was removed, is a new one.
    const next = new Map();
    let loaded = false;
    for (const inverter of config.inverters) {
      let unit = units.get(inverter.slot);
      if (unit && unit.baseUrl === inverter.baseUrl) {
        unit.setPassword(inverter.password);
      } else {
        unit = createUnit(inverter);
        // Known from a previous run: its device is there even if the
        // inverter does not answer right now.
        loaded = (await unit.load()) || loaded;
      }
      // Saving the configuration is the user's go for a new login attempt.
      unit.unblock();
      next.set(inverter.slot, unit);
    }
    for (const [slot, unit] of units) {
      if (next.get(slot) !== unit) {
        await unit.logout();
      }
    }
    units = next;
    if (config.invalidSlots.length > 0) {
      logger.info(`Invalid inverter address (inverter ${config.invalidSlots.join(', ')})`);
    }
    if (!isConfigured(config)) {
      clearTimeout(timer);
      if (config.invalidSlots.length === 0) {
        logger.info('Waiting for the address and the password of the inverter');
      }
      await refreshStatus();
      return;
    }
    if (loaded) {
      await publishDevices();
    }
    // Each discovery reports its own failure; the timer tries again.
    for (const unit of unitList()) {
      await unit.start();
    }
    await refreshStatus();
    schedule();
  }

  const sceneActions = createSceneActions({
    config: () => config,
    units: unitList,
    afterWrite: async (unit, what) => {
      logger.info(`Scene action on the inverter at ${unit.baseUrl}: ${what}`);
      await unit.updateBatterySettings(true);
      nudgeWidget(true);
    },
  });

  // --- Handlers --------------------------------------------------------------------

  const handlers = {
    async scanRequest() {
      logger.info('Discovery requested from Gladys');
      for (const unit of unitList()) {
        if (!unit.blocked) {
          await unit.discover().catch(() => {});
        }
      }
      await publishDevices();
    },

    /** The core's onPoll: a fallback, skipped while the timer is on time. */
    async poll(device) {
      const unit = unitOf(device.external_id);
      if (!unit) {
        return;
      }
      const age = now() - Math.max(unit.lastCycleAt, unit.service.snapshot?.fetchedAt ?? -Infinity);
      if (age < config.pollIntervalMs * 0.9) {
        logger.debug(`onPoll ${device.external_id}: read ${age} ms ago, skipped`);
        return;
      }
      await cycle();
    },

    /** A device was just added (or updated): Gladys needs all its states now. */
    async deviceChanged(device) {
      const unit = unitOf(device.external_id);
      if (!unit) {
        return;
      }
      if (unit.service.snapshot) {
        await unit.publishSnapshot();
      } else {
        await cycle();
      }
      nudgeWidget(true);
    },

    async testConnection() {
      logger.info('Action: test the connection');
      if (!isConfigured(config)) {
        return config.invalidSlots.length > 0 ? MESSAGES.invalidHost : MESSAGES.notConfigured;
      }
      const answers = [];
      for (const unit of unitList()) {
        answers.push({ slot: unit.slot, message: await unit.testConnection() });
      }
      await refreshStatus();
      if (!several()) {
        return answers[0].message;
      }
      for (const slot of config.invalidSlots) {
        answers.push({ slot, message: MESSAGES.invalidHost });
      }
      answers.sort((a, b) => a.slot - b.slot);
      const lines = answers.map(({ slot, message }) => aboutInverter(slot, message));
      return localize((language) => lines.map((line) => pick(line, language)).join('\n'));
    },

    /**
     * The widget of one inverter: the one chosen in its settings, the first
     * one otherwise (a widget placed with 1.0 has no setting).
     */
    async widgetGet({ settings } = {}) {
      if (!isConfigured(config) || units.size === 0) {
        return notConfiguredContent();
      }
      const unit = unitOf(settings?.device) ?? unitList()[0];
      const { service } = unit;
      const { device, features } = unit.createdOnGladys();
      // Without the device added, no cycle runs: read for the widget, at the
      // configured pace at most.
      if (service.inventory && !device && !unit.blocked) {
        const age = now() - (service.snapshot?.fetchedAt ?? -Infinity);
        if (age >= config.pollIntervalMs) {
          await unit
            .read()
            .catch((err) => logger.debug(`Widget: inverter not read (${err.message})`));
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
        // With several inverters, the widget says which one it shows.
        title:
          units.size > 1 ? (device?.name ?? deviceName(service.inventory, config.language)) : null,
      });
    },

    sceneActions,
  };

  return {
    handlers,
    get config() {
      return config;
    },
    /** The inverters, in slot order. */
    get units() {
      return unitList();
    },
    /** The service of the first inverter. */
    get service() {
      return unitList()[0]?.service ?? null;
    },
    cycle,

    /** Register every handler on the Gladys client (before connect()). */
    register() {
      gladys.onScanRequest(() => handlers.scanRequest());
      gladys.onPoll((device) => handlers.poll(device));
      gladys.onDeviceCreated((device) => handlers.deviceChanged(device));
      gladys.onDeviceUpdated((device) => handlers.deviceChanged(device));
      gladys.onAction(ACTIONS.testConnection, () => handlers.testConnection());
      gladys.onWidgetGet(WIDGET_KEY, (request) => handlers.widgetGet(request));
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
      // Free the inverters' sessions (each keeps only a few).
      for (const unit of unitList()) {
        await unit.logout();
      }
    },
  };
}
