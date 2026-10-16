// -----------------------------------------------------------------------------
// HTTP client of the Kostal REST API (`http://<inverter>/api/v1/`), the one the
// inverter's own web interface uses. Same endpoints and status codes as
// pykoplenti (Apache 2.0), the library of the Home Assistant integration.
//
// - One request at a time: the inverter's board is small, and a refresh is a
//   single request anyway.
// - The session is kept. A request answered 401 (session expired, inverter
//   restarted) logs in again once and is replayed.
// - Error messages carry the endpoint and the status, never the password, the
//   session id nor a request body.
// -----------------------------------------------------------------------------

import http from 'node:http';
import https from 'node:https';
import {
  computeProof,
  createClientNonce,
  encodeBase64,
  isServerSignatureValid,
  sessionRequest,
} from './scram.js';

export const API_PATH = '/api/v1/';
export const REQUEST_TIMEOUT_MS = 10000;
// The plant owner. The installer ("master") needs the master key and a
// service code: not supported, nothing here needs it.
export const OWNER_USERNAME = 'user';

/** An error of the inverter or of the network, with a kind the app can act on. */
export class KostalError extends Error {
  /**
   * @param {string} kind auth | unauthorized | locked | notFound | busy | http | network | protocol
   * @param {string} message
   * @param {number} [status]
   */
  constructor(kind, message, status) {
    super(message);
    this.name = 'KostalError';
    this.kind = kind;
    this.status = status;
  }
}

// Status codes of the API (pykoplenti `_check_response`).
const KIND_BY_STATUS = {
  400: 'auth',
  401: 'unauthorized',
  403: 'locked',
  404: 'notFound',
  503: 'busy',
};

/**
 * The default transport: node:http (or https when the user typed it; the
 * inverter's certificate is self-signed, and no secret travels in clear).
 * @param {{ method: string, url: string, headers: object, body?: string, timeoutMs: number }} request
 * @returns {Promise<{ status: number, text: string }>}
 */
export function httpRequest({ method, url, headers, body, timeoutMs }) {
  const target = new URL(url);
  const lib = target.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = lib.request(
      target,
      {
        method,
        headers:
          body === undefined ? headers : { ...headers, 'content-length': Buffer.byteLength(body) },
        timeout: timeoutMs,
        ...(target.protocol === 'https:' ? { rejectUnauthorized: false } : {}),
      },
      (res) => {
        const chunks = [];
        let size = 0;
        res.on('data', (chunk) => {
          size += chunk.length;
          // A process data answer is a few kB; refuse anything absurd.
          if (size > 2 * 1024 * 1024) {
            req.destroy(new Error('answer too large'));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () =>
          resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }),
        );
        res.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(new Error(`no answer within ${timeoutMs} ms`)));
    req.on('error', reject);
    if (body !== undefined) {
      req.write(body);
    }
    req.end();
  });
}

/** The message of a network error, without anything sensitive. */
function networkReason(err) {
  return err.code ?? err.message ?? String(err);
}

/**
 * @param {object} options
 * @param {string} options.baseUrl e.g. http://192.0.2.20 (no credentials, no path)
 * @param {() => string} options.password read at each login (the config may change)
 * @param {Function} [options.transport] see httpRequest
 * @param {number} [options.timeoutMs]
 */
export function createClient({
  baseUrl,
  password,
  transport = httpRequest,
  timeoutMs = REQUEST_TIMEOUT_MS,
}) {
  let sessionId = null;
  let queue = Promise.resolve();

  /** Run one request after the previous one finished. */
  function serialize(task) {
    const run = queue.then(task, task);
    queue = run.catch(() => {});
    return run;
  }

  async function send(method, path, body, { session = true } = {}) {
    const headers = { accept: 'application/json' };
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
    }
    if (session && sessionId) {
      headers.authorization = `Session ${sessionId}`;
    }
    let response;
    try {
      response = await transport({
        method,
        url: `${baseUrl}${API_PATH}${path}`,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        timeoutMs,
      });
    } catch (err) {
      throw new KostalError('network', `${path}: ${networkReason(err)}`);
    }
    let json;
    try {
      json = response.text ? JSON.parse(response.text) : null;
    } catch {
      json = null;
    }
    if (response.status === 200) {
      if (json === null && response.text) {
        throw new KostalError('protocol', `${path}: the answer is not JSON`, 200);
      }
      return json;
    }
    const kind = KIND_BY_STATUS[response.status] ?? 'http';
    // The inverter's own message ("authentication failed", "user locked"…)
    // carries nothing secret; it is kept short.
    const detail = typeof json?.message === 'string' ? ` ${json.message.slice(0, 120)}` : '';
    throw new KostalError(kind, `${path}: HTTP ${response.status}${detail}`, response.status);
  }

  async function login() {
    sessionId = null;
    const secret = password();
    if (!secret) {
      throw new KostalError('auth', 'no password configured');
    }
    const clientNonce = createClientNonce();
    const start = await send(
      'POST',
      'auth/start',
      { username: OWNER_USERNAME, nonce: encodeBase64(clientNonce) },
      { session: false },
    );
    if (!start?.nonce || !start?.salt || !start?.transactionId) {
      throw new KostalError('protocol', 'auth/start: unexpected answer');
    }
    let handshake;
    try {
      handshake = computeProof({ username: OWNER_USERNAME, password: secret, clientNonce, start });
    } catch (err) {
      throw new KostalError('protocol', `auth/start: ${err.message}`);
    }
    const finish = await send(
      'POST',
      'auth/finish',
      { transactionId: start.transactionId, proof: handshake.proof },
      { session: false },
    );
    if (!finish?.token || !isServerSignatureValid(handshake.serverSignature, finish.signature)) {
      throw new KostalError('protocol', 'auth/finish: the inverter signature does not match');
    }
    const created = await send(
      'POST',
      'auth/create_session',
      sessionRequest(handshake.protocolKey, finish.token, start.transactionId),
      { session: false },
    );
    if (!created?.sessionId) {
      throw new KostalError('protocol', 'auth/create_session: no session');
    }
    sessionId = created.sessionId;
  }

  /** A request on the session: log in first if needed, once more on a 401. */
  async function authed(method, path, body) {
    if (!sessionId) {
      await login();
    }
    try {
      return await send(method, path, body);
    } catch (err) {
      if (err.kind !== 'unauthorized') {
        throw err;
      }
      await login();
      return send(method, path, body);
    }
  }

  return {
    get loggedIn() {
      return sessionId !== null;
    },

    /** Log in now (the connection test, the probe). */
    login: () => serialize(login),

    /** Close the session on the inverter (best effort). */
    logout: () =>
      serialize(async () => {
        if (!sessionId) {
          return;
        }
        try {
          await send('POST', 'auth/logout');
        } finally {
          sessionId = null;
        }
      }),

    /** Forget the session without telling the inverter (the password changed). */
    forget() {
      sessionId = null;
    },

    /** API and firmware version; no login needed. */
    version: () => serialize(() => send('GET', 'info/version', undefined, { session: false })),

    /** Who the session is (role, authenticated). */
    me: () => serialize(() => send('GET', 'auth/me')),

    /** Every process data id, by module: [{ moduleid, processdataids }]. */
    processDataList: () => serialize(() => authed('GET', 'processdata')),

    /**
     * Values of several process data of several modules, in one request.
     * @param {{ moduleid: string, processdataids: string[] }[]} request
     * @returns {Promise<{ moduleid: string, processdata: { id: string, unit: string, value: number }[] }[]>}
     */
    processValues: (request) => serialize(() => authed('POST', 'processdata', request)),

    /** Every setting with its metadata, by module: [{ moduleid, settings: [{ id, access, min, max, ... }] }]. */
    settingsList: () => serialize(() => authed('GET', 'settings')),

    /**
     * Values of several settings (strings).
     * @param {{ moduleid: string, settingids: string[] }[]} request
     * @returns {Promise<{ moduleid: string, settings: { id: string, value: string }[] }[]>}
     */
    settingValues: (request) => serialize(() => authed('POST', 'settings', request)),

    /**
     * Write settings of one module (values are strings).
     * @param {string} moduleId
     * @param {Record<string, string>} values
     */
    writeSettings: (moduleId, values) =>
      serialize(() =>
        authed('PUT', 'settings', [
          {
            moduleid: moduleId,
            settings: Object.entries(values).map(([id, value]) => ({ id, value })),
          },
        ]),
      ),

    /**
     * The latest events, described in a language the inverter knows.
     * @param {string} language en | fr | de | es
     * @param {number} [max]
     */
    events: (language, max = 10) =>
      serialize(() =>
        authed('POST', 'events/latest', {
          language: EVENT_LANGUAGES.get(language) ?? 'en-gb',
          max,
        }),
      ),
  };
}

// The language variants the inverter accepts (pykoplenti SUPPORTED_LANGUAGES).
export const EVENT_LANGUAGES = new Map([
  ['en', 'en-gb'],
  ['fr', 'fr-fr'],
  ['de', 'de-de'],
  ['es', 'es-es'],
]);
