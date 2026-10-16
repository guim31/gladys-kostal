// -----------------------------------------------------------------------------
// Pure functions over the answers of the Kostal REST API: what the inverter
// has (inventory) and what it measures now (reading). No request here.
//
// Ids and modules are the ones the Home Assistant integration and pykoplenti
// (Apache 2.0) read; their meaning and signs are documented in CLAUDE.md
// ("Kostal: what the code relies on"). Units of the API: W, Wh, %, V, A.
// -----------------------------------------------------------------------------

export const MODULES = {
  local: 'devices:local',
  ac: 'devices:local:ac',
  battery: 'devices:local:battery',
  stats: 'scb:statistic:EnergyFlow',
  events: 'scb:event',
  network: 'scb:network',
  pv: (n) => `devices:local:pv${n}`,
};

export const PV_STRINGS = [1, 2, 3];

// What a refresh reads, by module. An id the inverter does not list is never
// requested: an unknown id fails the whole request.
export const WANTED_PROCESS_DATA = {
  [MODULES.local]: ['Dc_P', 'Grid_P', 'Home_P', 'Inverter:State'],
  [MODULES.ac]: ['P'],
  [MODULES.battery]: ['P', 'SoC', 'Cycles'],
  [MODULES.stats]: [
    'Statistic:Yield:Day',
    'Statistic:Yield:Total',
    'Statistic:EnergyHome:Day',
    'Statistic:EnergyHomeGrid:Total',
    'Statistic:EnergyHomePv:Total',
    'Statistic:EnergyHomeBat:Total',
    'Statistic:EnergyChargePv:Total',
    'Statistic:EnergyChargeGrid:Total',
    'Statistic:EnergyDischarge:Total',
    'Statistic:Autarky:Day',
    'Statistic:OwnConsumptionRate:Day',
  ],
  [MODULES.events]: ['Event:ActiveErrorCnt'],
  ...Object.fromEntries(PV_STRINGS.map((n) => [MODULES.pv(n), ['P']])),
};

// Settings read once per discovery (identity of the inverter).
export const IDENTITY_SETTINGS = [
  'Properties:SerialNo',
  'Branding:ProductName1',
  'Branding:ProductName2',
  'Properties:VersionIOC',
  'Properties:VersionMC',
  'Properties:StringCnt',
  'Battery:Type',
];
// The host name setting changed name across firmwares (Home Assistant helper).
export const HOSTNAME_SETTINGS = ['Network:Hostname', 'Hostname'];

// The battery settings this integration can write (owner password).
export const BATTERY_SETTINGS = {
  minSoc: 'Battery:MinSoc',
  smartControl: 'Battery:SmartBatteryControl:Enable',
  timeControl: 'Battery:TimeControl:Enable',
};

const asArray = (value) => (Array.isArray(value) ? value : []);

/** [{ moduleid, processdataids }] → { moduleid: Set(ids) } */
export function processDataIndex(list) {
  const index = {};
  for (const entry of asArray(list)) {
    if (typeof entry?.moduleid === 'string') {
      index[entry.moduleid] = new Set(
        asArray(entry.processdataids).filter((id) => typeof id === 'string'),
      );
    }
  }
  return index;
}

/** [{ moduleid, settings: [...] }] → { moduleid: { id: metadata } } */
export function settingsIndex(list) {
  const index = {};
  for (const entry of asArray(list)) {
    if (typeof entry?.moduleid !== 'string') {
      continue;
    }
    index[entry.moduleid] = {};
    for (const setting of asArray(entry.settings)) {
      if (typeof setting?.id === 'string') {
        index[entry.moduleid][setting.id] = setting;
      }
    }
  }
  return index;
}

/** The settings to read for the identity, limited to those the inverter lists. */
export function identityRequest(settings) {
  const request = [];
  const local = IDENTITY_SETTINGS.filter((id) => settings[MODULES.local]?.[id]);
  if (local.length > 0) {
    request.push({ moduleid: MODULES.local, settingids: local });
  }
  const hostname = HOSTNAME_SETTINGS.find((id) => settings[MODULES.network]?.[id]);
  if (hostname) {
    request.push({ moduleid: MODULES.network, settingids: [hostname] });
  }
  return request;
}

/** [{ moduleid, settings: [{ id, value }] }] → { 'module/id': 'value' } */
export function settingValuesMap(response) {
  const values = {};
  for (const entry of asArray(response)) {
    for (const setting of asArray(entry?.settings)) {
      if (typeof setting?.id === 'string') {
        values[`${entry.moduleid}/${setting.id}`] =
          setting.value === null ? null : String(setting.value);
      }
    }
  }
  return values;
}

/** [{ moduleid, processdata: [{ id, value }] }] → { 'module/id': number } */
export function processValuesMap(response) {
  const values = {};
  for (const entry of asArray(response)) {
    for (const data of asArray(entry?.processdata)) {
      const value = Number(data?.value);
      if (typeof data?.id === 'string' && data.value !== null && Number.isFinite(value)) {
        values[`${entry.moduleid}/${data.id}`] = value;
      }
    }
  }
  return values;
}

function writable(meta) {
  return meta?.access === 'readwrite';
}

function numberOrNull(text) {
  const n = Number(text);
  return text !== null && text !== undefined && text !== '' && Number.isFinite(n) ? n : null;
}

/**
 * What the inverter is and what it measures, from the discovery answers.
 * @param {object} answers
 * @param {object} answers.version info/version
 * @param {Array} answers.processData GET processdata
 * @param {Array} answers.settings GET settings
 * @param {Array} answers.identity POST settings (identityRequest)
 * @returns {object} the inventory
 * @throws when the inverter gives no serial number (no stable identity)
 */
export function parseInventory({ version, processData, settings, identity }) {
  const available = processDataIndex(processData);
  const settingsMeta = settingsIndex(settings);
  const values = settingValuesMap(identity);
  const local = (id) => values[`${MODULES.local}/${id}`] ?? null;

  const serial = (local('Properties:SerialNo') ?? '').trim();
  if (!serial) {
    throw new Error('the inverter gives no serial number');
  }

  // Only the ids this integration reads, among those the inverter lists.
  const wanted = {};
  for (const [module, ids] of Object.entries(WANTED_PROCESS_DATA)) {
    const present = ids.filter((id) => available[module]?.has(id));
    if (present.length > 0) {
      wanted[module] = present;
    }
  }
  const has = (module, id) => wanted[module]?.includes(id) ?? false;

  // A string used for a battery (Plenticore plus with a battery on DC3) is
  // still listed: the string count of the inverter bounds the PV strings.
  const stringCount = numberOrNull(local('Properties:StringCnt'));
  const pvStrings = PV_STRINGS.filter(
    (n) => has(MODULES.pv(n), 'P') && (stringCount === null || n <= stringCount),
  );
  for (const n of PV_STRINGS) {
    if (!pvStrings.includes(n)) {
      delete wanted[MODULES.pv(n)];
    }
  }

  // Battery:Type 0 means no battery; the battery module is listed anyway.
  const batteryType = local('Battery:Type');
  const hasBattery =
    has(MODULES.battery, 'SoC') && (batteryType === null || Number(batteryType) !== 0);
  if (!hasBattery) {
    delete wanted[MODULES.battery];
  }

  const minSoc = settingsMeta[MODULES.local]?.[BATTERY_SETTINGS.minSoc];
  const smart = settingsMeta[MODULES.local]?.[BATTERY_SETTINGS.smartControl];
  const time = settingsMeta[MODULES.local]?.[BATTERY_SETTINGS.timeControl];
  const product = [local('Branding:ProductName1'), local('Branding:ProductName2')]
    .filter((part) => part && part.trim())
    .join(' ')
    .trim();
  const hostnameId = HOSTNAME_SETTINGS.find(
    (id) => values[`${MODULES.network}/${id}`] !== undefined,
  );

  return {
    serial,
    model: product || null,
    hostname: hostnameId ? values[`${MODULES.network}/${hostnameId}`] : null,
    versions: {
      api: version?.api_version ?? null,
      software: version?.sw_version ?? null,
      ioc: local('Properties:VersionIOC'),
      mc: local('Properties:VersionMC'),
    },
    process: wanted,
    pvStrings,
    hasBattery,
    hasGrid: has(MODULES.local, 'Grid_P'),
    hasHome: has(MODULES.local, 'Home_P'),
    hasAc: has(MODULES.ac, 'P'),
    hasEvents: has(MODULES.events, 'Event:ActiveErrorCnt'),
    settings: hasBattery
      ? {
          minSoc: minSoc
            ? {
                writable: writable(minSoc),
                min: numberOrNull(minSoc.min) ?? 5,
                max: numberOrNull(minSoc.max) ?? 100,
              }
            : null,
          smartControl: smart ? { writable: writable(smart) } : null,
          timeControl: Boolean(time),
        }
      : { minSoc: null, smartControl: null, timeControl: false },
  };
}

/** The request of a refresh: every wanted id, all modules in one POST. */
export function processRequest(inventory) {
  return Object.entries(inventory.process).map(([moduleid, processdataids]) => ({
    moduleid,
    processdataids,
  }));
}

/** The battery settings to read, among those the inverter has. */
export function batterySettingsRequest(inventory) {
  const ids = [];
  if (inventory.settings.minSoc) ids.push(BATTERY_SETTINGS.minSoc);
  if (inventory.settings.smartControl) ids.push(BATTERY_SETTINGS.smartControl);
  return ids.length > 0 ? [{ moduleid: MODULES.local, settingids: ids }] : [];
}

/** { minSoc: number|null, smartControl: boolean|null } from setting values. */
export function parseBatterySettings(response) {
  const values = settingValuesMap(response);
  const minSoc = numberOrNull(values[`${MODULES.local}/${BATTERY_SETTINGS.minSoc}`]);
  const smart = values[`${MODULES.local}/${BATTERY_SETTINGS.smartControl}`];
  return {
    minSoc,
    smartControl: smart === undefined || smart === null ? null : smart === '1',
  };
}

const sum = (values) => values.reduce((total, value) => total + value, 0);

/**
 * The measurements of one refresh, in the API units, signs as the API gives
 * them (Grid_P > 0 import; battery P > 0 discharge). null when not measured.
 * @param {object} inventory
 * @param {Array} response POST processdata
 */
export function parseReading(inventory, response) {
  const values = processValuesMap(response);
  const get = (module, id) => values[`${module}/${id}`] ?? null;
  const stat = (id) => get(MODULES.stats, `Statistic:${id}`);

  const strings = {};
  for (const n of inventory.pvStrings) {
    const power = get(MODULES.pv(n), 'P');
    // At night a string reads a few tenths of a watt below zero.
    strings[n] = power === null ? null : Math.max(power, 0);
  }
  const stringPowers = Object.values(strings).filter((power) => power !== null);
  // Dc_P includes the battery: the sum of the strings is the solar power.
  const dc = get(MODULES.local, 'Dc_P');
  const pvPower =
    stringPowers.length > 0 ? sum(stringPowers) : dc === null ? null : Math.max(dc, 0);

  const yieldTotal = stat('Yield:Total');
  const homePv = stat('EnergyHomePv:Total');
  const homeBat = stat('EnergyHomeBat:Total');
  // pykoplenti's "energy to grid": what the inverter produced minus what the
  // house took from it (directly and through the battery).
  const exportTotal =
    yieldTotal !== null && homePv !== null && homeBat !== null
      ? Math.max(yieldTotal - homePv - homeBat, 0)
      : null;
  const chargePv = stat('EnergyChargePv:Total');
  const chargeGrid = stat('EnergyChargeGrid:Total');

  const battery = inventory.hasBattery
    ? {
        soc: get(MODULES.battery, 'SoC'),
        power: get(MODULES.battery, 'P'),
        cycles: get(MODULES.battery, 'Cycles'),
      }
    : null;

  return {
    pvPower,
    strings,
    acPower: get(MODULES.ac, 'P'),
    homePower: get(MODULES.local, 'Home_P'),
    gridPower: get(MODULES.local, 'Grid_P'),
    battery,
    inverterState: get(MODULES.local, 'Inverter:State'),
    activeErrors: get(MODULES.events, 'Event:ActiveErrorCnt'),
    yieldDay: stat('Yield:Day'),
    yieldTotal,
    homeDay: stat('EnergyHome:Day'),
    homeGridTotal: stat('EnergyHomeGrid:Total'),
    exportTotal,
    chargeTotal: chargePv === null ? null : chargePv + (chargeGrid ?? 0),
    dischargeTotal: stat('EnergyDischarge:Total'),
    autarkyDay: stat('Autarky:Day'),
    ownConsumptionDay: stat('OwnConsumptionRate:Day'),
  };
}

/**
 * The active events, newest first: { code, description, category, start }.
 * @param {Array} response POST events/latest
 */
export function parseActiveEvents(response) {
  return asArray(response)
    .filter((event) => event?.is_active === true)
    .map((event) => ({
      code: Number.isFinite(Number(event.code)) ? Number(event.code) : null,
      description: String(event.description ?? event.long_description ?? '').trim(),
      category: typeof event.category === 'string' ? event.category : null,
      start: typeof event.start_time === 'string' ? event.start_time : null,
    }))
    .sort((a, b) => String(b.start ?? '').localeCompare(String(a.start ?? '')));
}
