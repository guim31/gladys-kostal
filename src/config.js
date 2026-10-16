// -----------------------------------------------------------------------------
// Configuration of the integration, as filled in by the user from the
// manifest `config_schema`. DEFAULT_CONFIG mirrors the manifest defaults
// (test/manifest.test.js keeps them equal); normalizeConfig() turns whatever
// the form sends into checked values, so the rest of the code never deals
// with an empty or malformed field.
// -----------------------------------------------------------------------------

export const LANGUAGE_OPTIONS = ['fr', 'en', 'de', 'es'];
// Refresh intervals offered in the form, in seconds: one request each.
export const POLL_INTERVALS_S = [10, 15, 30, 60];

export const DEFAULT_CONFIG = {
  host: '',
  password: '',
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

/**
 * @param {Record<string, unknown>} [raw] the config from the SDK
 */
export function normalizeConfig(raw = {}) {
  const { baseUrl, valid } = parseHost(raw.host ?? DEFAULT_CONFIG.host);
  const interval = Number(raw.poll_interval ?? DEFAULT_CONFIG.poll_interval);
  const full = integerIn(raw.battery_full_level, 50, 100, DEFAULT_CONFIG.battery_full_level);
  const empty = integerIn(raw.battery_empty_level, 0, 50, DEFAULT_CONFIG.battery_empty_level);
  return {
    baseUrl,
    hostValid: valid,
    password: typeof raw.password === 'string' ? raw.password : '',
    pollIntervalMs:
      (POLL_INTERVALS_S.includes(interval) ? interval : Number(DEFAULT_CONFIG.poll_interval)) *
      1000,
    language: LANGUAGE_OPTIONS.includes(raw.language) ? raw.language : DEFAULT_CONFIG.language,
    batteryFullLevel: full,
    // An "empty" level at or above the "full" one would fire both: keep a gap.
    batteryEmptyLevel: Math.min(empty, full - 10),
    // The form sends a boolean; an older core may send the text.
    allowSettings: raw.allow_settings === true || raw.allow_settings === 'true',
  };
}

/** The inverter can be reached once an address and a password are set. */
export function isConfigured(config) {
  return config.baseUrl !== '' && config.password !== '';
}
