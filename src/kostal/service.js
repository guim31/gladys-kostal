// -----------------------------------------------------------------------------
// One Kostal inverter: what it is (inventory, kept in /data so its device is
// published again after a restart even if the inverter does not answer yet),
// what it measures (snapshot), its active events and its battery settings.
//
// Requests per refresh: one POST processdata. Discovery (start, every 30
// minutes, a manual test): version, process data list, settings list,
// identity settings. Events: only while the inverter reports an active error.
// Battery settings: read only when the user allowed them.
// -----------------------------------------------------------------------------

import {
  BATTERY_SETTINGS,
  MODULES,
  batterySettingsRequest,
  identityRequest,
  parseActiveEvents,
  parseBatterySettings,
  parseInventory,
  parseReading,
  processRequest,
  settingsIndex,
} from './parse.js';

export const INVENTORY_FILE = 'inventory';

/**
 * @param {object} options
 * @param {object} options.client createClient()
 * @param {{ read: Function, write: Function }} options.store
 * @param {() => number} options.now
 */
export function createKostalService({ client, store, now }) {
  let inventory = null;
  let snapshot = null;
  let events = [];
  let batterySettings = null;

  return {
    get inventory() {
      return inventory;
    },
    get snapshot() {
      return snapshot;
    },
    get events() {
      return events;
    },
    get batterySettings() {
      return batterySettings;
    },

    /** The inventory of a previous run, if any. */
    async load() {
      const saved = await store.read(INVENTORY_FILE);
      if (saved?.serial && saved.process) {
        inventory = saved;
        return true;
      }
      return false;
    },

    /**
     * Read what the inverter is.
     * @returns {Promise<{ inventory: object, changed: boolean }>}
     */
    async discover() {
      const version = await client.version();
      const processData = await client.processDataList();
      const settings = await client.settingsList();
      const request = identityRequest(settingsIndex(settings));
      const identity = request.length > 0 ? await client.settingValues(request) : [];
      const next = parseInventory({ version, processData, settings, identity });
      const changed = JSON.stringify(next) !== JSON.stringify(inventory);
      inventory = next;
      if (changed) {
        await store.write(INVENTORY_FILE, inventory);
      }
      return { inventory, changed };
    },

    /** Read the measurements (one request). */
    async refresh() {
      const response = await client.processValues(processRequest(inventory));
      snapshot = { ...parseReading(inventory, response), fetchedAt: now() };
      return snapshot;
    },

    /** Read the active events, described in `language`. */
    async readEvents(language) {
      events = parseActiveEvents(await client.events(language, 10));
      return events;
    },

    /** No active error any more: forget the events without asking. */
    clearEvents() {
      events = [];
    },

    /** Read the battery settings the inverter has. */
    async readBatterySettings() {
      const request = batterySettingsRequest(inventory);
      if (request.length === 0) {
        batterySettings = null;
        return null;
      }
      batterySettings = {
        ...parseBatterySettings(await client.settingValues(request)),
        readAt: now(),
      };
      return batterySettings;
    },

    /** Write the minimum state of charge (an integer %). */
    async writeMinSoc(level) {
      await client.writeSettings(MODULES.local, { [BATTERY_SETTINGS.minSoc]: String(level) });
    },

    /**
     * Switch the smart battery control. Turning it on turns the time control
     * off first: the inverter runs one battery strategy at a time (the Home
     * Assistant select does the same).
     */
    async writeSmartControl(enabled) {
      if (enabled && inventory.settings.timeControl) {
        await client.writeSettings(MODULES.local, { [BATTERY_SETTINGS.timeControl]: '0' });
      }
      await client.writeSettings(MODULES.local, {
        [BATTERY_SETTINGS.smartControl]: enabled ? '1' : '0',
      });
    },
  };
}
