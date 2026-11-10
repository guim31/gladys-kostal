// -----------------------------------------------------------------------------
// Configuration of the integration, as filled in by the user from the
// manifest `config_schema`. DEFAULT_CONFIG mirrors the manifest defaults
// (test/manifest.test.js keeps them equal); normalizeConfig() turns whatever
// the form sends into checked values, so the rest of the code never deals
// with an empty or malformed field.
//
// Up to three inverters, one "slot" each. The first keeps the keys of 1.0
// (`host`, `password`) so an existing installation runs on unchanged; the
// others are `host_2` / `password_2` and `host_3` / `password_3`. An empty
// password reuses the first one (installers often set the same everywhere).
// A device is keyed on the serial number of its inverter, never on its slot:
// moving an inverter to another slot keeps its device and history.
// -----------------------------------------------------------------------------

export const LANGUAGE_OPTIONS = ['fr', 'en', 'de', 'es'];
// Refresh intervals offered in the form, in seconds: one request each.
export const POLL_INTERVALS_S = [10, 15, 30, 60];

export const SLOTS = [1, 2, 3];
export const hostKey = (slot) => (slot === 1 ? 'host' : `host_${slot}`);
export const passwordKey = (slot) => (slot === 1 ? 'password' : `password_${slot}`);

export const DEFAULT_CONFIG = {
  host: '',
  password: '',
  host_2: '',
  password_2: '',
  host_3: '',
  password_3: '',
  poll_interval: '15',
  language: 'fr',
  battery_full_level: 100,
  battery_empty_level: 5,
  allow_settings: false,
};

/**
 * Turn what the user typed into the base URL of the inverter.
 * "192.0.2.20", "192.0.2.20:8080", "http://plenticore.local/", "https://..."
 * are accepted; a path is dropped, and so are credentials typed in the
 * address (they must not end up in a log line).
 * @returns {{ baseUrl: string, valid: boolean }} baseUrl '' when empty or invalid
 */
export function parseHost(raw) {
  const text = String(raw ?? '').trim();
  if (text === '') {
    return { baseUrl: '', valid: true };
  }
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`;
  let url;
  try {
    url = new URL(withScheme);
  } catch {
    return { baseUrl: '', valid: false };
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.hostname === '') {
    return { baseUrl: '', valid: false };
  }
  return { baseUrl: `${url.protocol}//${url.host}`, valid: true };
}

function integerIn(value, min, max, fallback) {
  const n = Number(value);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}

const secret = (value) => (typeof value === 'string' ? value : '');

/**
 * The inverters to read, in slot order: an address that parses and a
 * password (its own, or the first one). A slot with nothing typed is skipped;
 * one whose address does not parse is listed in `invalidSlots`; one that
 * repeats the address of a previous slot is ignored.
 */
function inverterSlots(raw) {
  const inverters = [];
  const invalidSlots = [];
  const firstPassword = secret(raw[passwordKey(1)]);
  for (const slot of SLOTS) {
    const { baseUrl, valid } = parseHost(raw[hostKey(slot)] ?? '');
    if (!valid) {
      invalidSlots.push(slot);
      continue;
    }
    if (baseUrl === '' || inverters.some((inverter) => inverter.baseUrl === baseUrl)) {
      continue;
    }
    // Not trimmed: a password may start or end with a space.
    const password = secret(raw[passwordKey(slot)]) || firstPassword;
    if (password !== '') {
      inverters.push({ slot, baseUrl, password });
    }
  }
  return { inverters, invalidSlots };
}

/**
 * @param {Record<string, unknown>} [raw] the config from the SDK
 */
export function normalizeConfig(raw = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const interval = Number(source.poll_interval ?? DEFAULT_CONFIG.poll_interval);
  const full = integerIn(source.battery_full_level, 50, 100, DEFAULT_CONFIG.battery_full_level);
  const empty = integerIn(source.battery_empty_level, 0, 50, DEFAULT_CONFIG.battery_empty_level);
  return {
    ...inverterSlots(source),
    pollIntervalMs:
      (POLL_INTERVALS_S.includes(interval) ? interval : Number(DEFAULT_CONFIG.poll_interval)) *
      1000,
    language: LANGUAGE_OPTIONS.includes(source.language)
      ? source.language
      : DEFAULT_CONFIG.language,
    batteryFullLevel: full,
    // An "empty" level at or above the "full" one would fire both: keep a gap.
    batteryEmptyLevel: Math.min(empty, full - 10),
    // The form sends a boolean; an older core may send the text.
    allowSettings: source.allow_settings === true || source.allow_settings === 'true',
  };
}

/** At least one inverter can be reached: an address and a password are set. */
export function isConfigured(config) {
  return config.inverters.length > 0;
}
