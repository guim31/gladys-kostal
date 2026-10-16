// -----------------------------------------------------------------------------
// The "Kostal" dashboard widget: production, house, grid and battery, today's
// production, a 24 h chart and a status list (grid direction, battery flow,
// inverter state, alarms, autarky, battery settings).
//
// A widget never costs a request to the inverter: the content is built from
// the reading of the last cycle. Tiles and chart are bound to the published
// features when the device exists in Gladys (the core then animates them live
// from the states); otherwise the tiles carry the cached values.
//
// Budget of the core: 8 components at most, 6 tiles, 1 focal, 1 status. This
// content uses at most 5 tiles + 1 chart + 1 status = 7.
// -----------------------------------------------------------------------------

import {
  WIDGET_CHART_INTERVALS,
  WIDGET_CHART_TYPES,
  WIDGET_COLORS,
} from '@gladysassistant/integration-sdk';
import {
  WIDGET_MESSAGES,
  WIDGET_TEXT,
  formatNumber,
  formatPercent,
  inverterStateText,
  localize,
  pick,
} from './i18n.js';
import { FEATURES, inverterIds, latestAlarmText } from './devices/inverter.js';

export const WIDGET_KEY = 'energy_flow';
export const WIDGET_TTL_SECONDS = 60;

// Inverter:State codes worth a colour: feeding in (6) is the normal day, a
// fault-like state is shown in orange.
const PRODUCING_STATES = new Set([6]);
const WARNING_STATES = new Set([7, 8, 13, 14, 16]);

/** A sentence instead of data (not configured, nothing read yet). */
export function messageContent(message) {
  return {
    ttl_seconds: WIDGET_TTL_SECONDS,
    components: [{ type: 'text', variant: 'body', text: message }],
  };
}

export const notConfiguredContent = () => messageContent(WIDGET_MESSAGES.notConfigured);
export const noDataContent = () => messageContent(WIDGET_MESSAGES.noData);

/** kWh as a short text: one decimal under 1000 kWh, none above (tiles are narrow). */
function energyText(kwhValue, language) {
  return formatNumber(kwhValue, kwhValue >= 1000 ? 0 : 1, language);
}

function clockText(ms, timeZone) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(ms));
}

/**
 * A tile bound to a feature when Gladys has it, the cached value otherwise.
 * @param {Set<string>} created the feature external ids Gladys knows
 */
function tile(created, { label, icon, externalId, value, unit }) {
  if (created.has(externalId)) {
    return { type: 'value', label, icon, device_feature: externalId };
  }
  if (value === null || value === undefined) {
    return null;
  }
  return { type: 'value', label, icon, value, unit };
}

const watts = (value) => (value === null || value === undefined ? null : Math.round(value));

/**
 * @param {object} input
 * @param {object} input.gladys only for the external ids
 * @param {object} input.inventory
 * @param {object} input.snapshot the last reading
 * @param {Array} input.events the active events, newest first
 * @param {object|null} input.batterySettings { minSoc, smartControl } when read
 * @param {Set<string>} input.created feature external ids of the device in Gladys
 * @param {object} input.config
 * @param {string} [input.timeZone]
 * @returns {object} the widget content
 */
export function buildFlowContent({
  gladys,
  inventory,
  snapshot,
  events,
  batterySettings,
  created,
  config,
  timeZone,
}) {
  const ids = inverterIds(gladys, inventory);
  const id = (key) => ids.feature(key);
  const F = FEATURES;

  const tiles = [
    tile(created, {
      label: WIDGET_TEXT.solar,
      icon: 'sun',
      externalId: id(F.pvPower),
      value: watts(snapshot.pvPower),
      unit: 'W',
    }),
  ];
  if (inventory.hasHome) {
    tiles.push(
      tile(created, {
        label: WIDGET_TEXT.house,
        icon: 'home',
        externalId: id(F.homePower),
        value: watts(Math.max(snapshot.homePower ?? 0, 0)),
        unit: 'W',
      }),
    );
  }
  if (inventory.hasGrid) {
    tiles.push(
      tile(created, {
        label: WIDGET_TEXT.grid,
        icon: 'zap',
        externalId: id(F.gridPower),
        value: watts(snapshot.gridPower),
        unit: 'W',
      }),
    );
  }
  if (inventory.hasBattery) {
    tiles.push(
      tile(created, {
        label: WIDGET_TEXT.battery,
        icon: 'battery',
        externalId: id(F.batteryLevel),
        value:
          snapshot.battery?.soc === null || snapshot.battery?.soc === undefined
            ? null
            : Math.round(snapshot.battery.soc),
        unit: '%',
      }),
    );
  }
  tiles.push(
    tile(created, {
      label: WIDGET_TEXT.today,
      icon: 'sunrise',
      externalId: id(F.productionToday),
      value:
        snapshot.yieldDay === null
          ? null
          : localize((language) => energyText(snapshot.yieldDay / 1000, language)),
      unit: 'kWh',
    }),
  );
  const components = tiles.filter(Boolean);

  // The chart needs the history Gladys keeps: only for created features.
  const charted = [id(F.pvPower), id(F.homePower)].filter((externalId) => created.has(externalId));
  if (charted.length > 0) {
    components.push({
      type: 'chart',
      title: WIDGET_TEXT.chartTitle,
      device_features: charted,
      interval: WIDGET_CHART_INTERVALS.LAST_DAY,
      chart_type: WIDGET_CHART_TYPES.LINE,
    });
  }

  components.push({
    type: 'status',
    items: statusItems({ inventory, snapshot, events, batterySettings, config, timeZone }),
  });
  return { ttl_seconds: WIDGET_TTL_SECONDS, components };
}

function flowText(power, positiveLabel, negativeLabel, zeroLabel) {
  // Rounded first: an idle battery reads a few watts either way.
  const rounded = Math.round(power / 10) * 10;
  const label = rounded > 0 ? positiveLabel : rounded < 0 ? negativeLabel : zeroLabel;
  return localize((language) =>
    rounded === 0 ? pick(label, language) : `${pick(label, language)} ${Math.abs(rounded)} W`,
  );
}

function statusItems({ inventory, snapshot, events, batterySettings, config, timeZone }) {
  const items = [];
  if (inventory.hasGrid && snapshot.gridPower !== null) {
    items.push({
      label: WIDGET_TEXT.gridFlow,
      value: flowText(
        snapshot.gridPower,
        WIDGET_TEXT.importing,
        WIDGET_TEXT.exporting,
        WIDGET_TEXT.balanced,
      ),
      icon: snapshot.gridPower < 0 ? 'upload' : 'download',
    });
  }
  if (
    inventory.hasBattery &&
    snapshot.battery?.power !== null &&
    snapshot.battery?.power !== undefined
  ) {
    items.push({
      label: WIDGET_TEXT.batteryFlow,
      // The API counts a discharge positive.
      value: flowText(
        snapshot.battery.power,
        WIDGET_TEXT.discharging,
        WIDGET_TEXT.charging,
        WIDGET_TEXT.idle,
      ),
      icon: 'battery-charging',
    });
  }
  if (snapshot.inverterState !== null) {
    const state = snapshot.inverterState;
    items.push({
      label: WIDGET_TEXT.inverter,
      value: inverterStateText(state),
      icon: 'cpu',
      color: PRODUCING_STATES.has(state)
        ? WIDGET_COLORS.SUCCESS
        : WARNING_STATES.has(state)
          ? WIDGET_COLORS.WARNING
          : WIDGET_COLORS.NEUTRAL,
    });
  }
  if (inventory.hasEvents && snapshot.activeErrors !== null) {
    const active = snapshot.activeErrors > 0;
    items.push({
      label: WIDGET_TEXT.alarms,
      value: localize((language) =>
        latestAlarmText(snapshot.activeErrors, events, language).slice(0, 40),
      ),
      icon: active ? 'alert-triangle' : 'check-circle',
      color: active ? WIDGET_COLORS.DANGER : WIDGET_COLORS.SUCCESS,
    });
  }
  if (snapshot.autarkyDay !== null) {
    items.push({
      label: WIDGET_TEXT.autarky,
      value: localize((language) => formatPercent(snapshot.autarkyDay, language)),
      icon: 'shield',
    });
  }
  if (snapshot.ownConsumptionDay !== null) {
    items.push({
      label: WIDGET_TEXT.ownConsumption,
      value: localize((language) => formatPercent(snapshot.ownConsumptionDay, language)),
      icon: 'refresh-cw',
    });
  }
  if (snapshot.homeDay !== null) {
    items.push({
      label: WIDGET_TEXT.houseToday,
      value: localize((language) => `${energyText(snapshot.homeDay / 1000, language)} kWh`),
      icon: 'home',
    });
  }
  if (config.allowSettings && batterySettings) {
    if (batterySettings.minSoc !== null) {
      items.push({
        label: WIDGET_TEXT.minSoc,
        value: localize((language) => formatPercent(batterySettings.minSoc, language)),
        icon: 'battery',
      });
    }
    if (batterySettings.smartControl !== null) {
      items.push({
        label: WIDGET_TEXT.smartControl,
        value: batterySettings.smartControl ? WIDGET_TEXT.on : WIDGET_TEXT.off,
        icon: batterySettings.smartControl ? 'check-circle' : 'circle',
      });
    }
  }
  // The last row says how fresh the rest is: kept whatever the count.
  return [
    ...items.slice(0, 9),
    { label: WIDGET_TEXT.updated, value: clockText(snapshot.fetchedAt, timeZone), icon: 'clock' },
  ];
}
