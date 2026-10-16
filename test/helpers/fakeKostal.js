// -----------------------------------------------------------------------------
// A fake Kostal inverter: the REST API of test/fixtures/kostal/<system>.json,
// the SERVER side of the login handshake (it checks the proof against its own
// password and signs back, so a wrong password or a broken client is refused
// exactly as a real inverter would), sessions, settings writes, events.
//
// Use `transport` as the app's HTTP transport (no socket), or `serve()` to
// put it on the loopback interface (client and probe tests).
// -----------------------------------------------------------------------------

import { createDecipheriv, createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import http from 'node:http';

export const SYSTEMS = ['plenticore_battery', 'plenticore_pv'];
export const TEST_PASSWORD = 'owner-pw-4711';
// The iteration count Kostal inverters announce in auth/start.
const ROUNDS = 29000;

const hmac = (key, ...parts) => {
  const mac = createHmac('sha256', key);
  for (const part of parts) mac.update(part);
  return mac.digest();
};
const b64 = (buffer) => Buffer.from(buffer).toString('base64');
const unb64 = (text) => Buffer.from(String(text ?? ''), 'base64');

export function loadSystem(system) {
  return JSON.parse(
    readFileSync(new URL(`../fixtures/kostal/${system}.json`, import.meta.url), 'utf8'),
  );
}

/** The unit the API gives a process data id. */
function unitOf(id) {
  if (/^Statistic:(Autarky|OwnConsumptionRate)/.test(id) || id === 'SoC') return '%';
  if (/^Statistic:/.test(id)) return 'Wh';
  if (/(^|_)P$/.test(id) || id === 'P') return 'W';
  if (/(^|_)U$/.test(id)) return 'V';
  if (/(^|_)I$/.test(id)) return 'A';
  if (id === 'Frequency') return 'Hz';
  return '';
}

/**
 * @param {string} system a file of test/fixtures/kostal
 * @param {object} [options]
 * @param {boolean} [options.night] serve the night readings
 * @param {string} [options.password]
 */
export function createFakeKostal(
  system = 'plenticore_battery',
  { night = false, password = TEST_PASSWORD } = {},
) {
  const fixture = loadSystem(system);
  const state = {
    password,
    values: structuredClone(fixture.processdata[night ? 'night' : 'day']),
    settingValues: structuredClone(fixture.settingValues),
    settings: structuredClone(fixture.settings),
    events: structuredClone(fixture.events),
    version: structuredClone(fixture.version),
    down: null,
    locked: false,
  };
  const transactions = new Map();
  const sessions = new Set();
  const requests = [];
  const writes = [];
  let failedLogins = 0;

  const json = (status, body) => ({ status, text: JSON.stringify(body) });
  const error = (status, message) => json(status, { message });

  function settingMeta(moduleid, id) {
    return state.settings.find((m) => m.moduleid === moduleid)?.settings.find((s) => s.id === id);
  }

  function authStart(body) {
    if (body?.username !== 'user' && body?.username !== 'master') {
      return error(400, 'invalid user');
    }
    const transactionId = randomBytes(16);
    const serverNonce = randomBytes(16);
    const salt = randomBytes(16);
    transactions.set(b64(transactionId), {
      username: body.username,
      clientNonce: unb64(body.nonce),
      serverNonce,
      salt,
    });
    return json(200, {
      nonce: b64(serverNonce),
      transactionId: b64(transactionId),
      salt: b64(salt),
      rounds: ROUNDS,
    });
  }

  function authFinish(body) {
    const tx = transactions.get(body?.transactionId);
    if (!tx) return error(400, 'unknown transaction');
    if (state.locked) return error(403, 'user is locked');
    const salted = pbkdf2Sync(Buffer.from(state.password, 'utf8'), tx.salt, ROUNDS, 32, 'sha256');
    const clientKey = hmac(salted, 'Client Key');
    const storedKey = createHash('sha256').update(clientKey).digest();
    const authMessage =
      `n=${tx.username},r=${b64(tx.clientNonce)},r=${b64(tx.serverNonce)},` +
      `s=${b64(tx.salt)},i=${ROUNDS},c=biws,r=${b64(tx.serverNonce)}`;
    const clientSignature = hmac(storedKey, authMessage);
    const proof = unb64(body.proof);
    const recovered = Buffer.alloc(clientSignature.length);
    for (let i = 0; i < recovered.length; i += 1)
      recovered[i] = (proof[i] ?? 0) ^ clientSignature[i];
    if (proof.length !== 32 || !createHash('sha256').update(recovered).digest().equals(storedKey)) {
      failedLogins += 1;
      transactions.delete(body.transactionId);
      return error(400, 'authentication failed');
    }
    tx.token = randomBytes(16).toString('hex');
    tx.protocolKey = hmac(storedKey, 'Session Key', authMessage, clientKey);
    return json(200, {
      token: tx.token,
      signature: b64(hmac(hmac(salted, 'Server Key'), authMessage)),
    });
  }

  function createSession(body) {
    const tx = transactions.get(body?.transactionId);
    transactions.delete(body?.transactionId);
    if (!tx?.token) return error(400, 'unknown transaction');
    try {
      const decipher = createDecipheriv('aes-256-gcm', tx.protocolKey, unb64(body.iv));
      decipher.setAuthTag(unb64(body.tag));
      const token = Buffer.concat([
        decipher.update(unb64(body.payload)),
        decipher.final(),
      ]).toString('utf8');
      if (token !== tx.token) return error(400, 'invalid token');
    } catch {
      return error(400, 'invalid payload');
    }
    const sessionId = randomBytes(24).toString('hex');
    sessions.add(sessionId);
    return json(200, { sessionId });
  }

  function processDataList() {
    return json(
      200,
      Object.entries(state.values).map(([moduleid, ids]) => ({
        moduleid,
        processdataids: Object.keys(ids),
      })),
    );
  }

  function processValues(body) {
    const answer = [];
    for (const { moduleid, processdataids } of body ?? []) {
      const module = state.values[moduleid];
      if (!module) return error(404, 'module not found');
      const processdata = [];
      for (const id of processdataids) {
        if (!(id in module)) return error(404, 'processdata not found');
        processdata.push({ id, unit: unitOf(id), value: module[id] });
      }
      answer.push({ moduleid, processdata });
    }
    return json(200, answer);
  }

  function settingValues(body) {
    const answer = [];
    for (const { moduleid, settingids } of body ?? []) {
      const settings = [];
      for (const id of settingids) {
        if (!settingMeta(moduleid, id)) return error(404, 'setting not found');
        settings.push({ id, value: state.settingValues[moduleid]?.[id] ?? null });
      }
      answer.push({ moduleid, settings });
    }
    return json(200, answer);
  }

  function writeSettings(body) {
    for (const { moduleid, settings } of body ?? []) {
      for (const { id } of settings) {
        const meta = settingMeta(moduleid, id);
        if (!meta) return error(404, 'setting not found');
        if (meta.access !== 'readwrite') return error(403, 'permission denied');
      }
    }
    for (const { moduleid, settings } of body ?? []) {
      for (const { id, value } of settings) {
        state.settingValues[moduleid][id] = value;
        writes.push({ moduleid, id, value });
      }
    }
    return { status: 200, text: '' };
  }

  function events(body) {
    const language = String(body?.language ?? 'en-gb').slice(0, 2);
    return json(
      200,
      state.events.slice(0, body?.max ?? 10).map((event) => ({
        ...event,
        description: event.descriptions?.[language] ?? event.description,
        descriptions: undefined,
      })),
    );
  }

  /** The API, one request at a time: { method, path, headers, body } → { status, text }. */
  function handle({ method, path, headers, body }) {
    requests.push({ method, path });
    if (path === 'info/version' && method === 'GET') return json(200, state.version);
    if (path === 'auth/start' && method === 'POST') return authStart(body);
    if (path === 'auth/finish' && method === 'POST') return authFinish(body);
    if (path === 'auth/create_session' && method === 'POST') return createSession(body);
    const session = /^Session (.+)$/.exec(headers?.authorization ?? '')?.[1];
    const authenticated = session !== undefined && sessions.has(session);
    if (path === 'auth/me' && method === 'GET') {
      return json(200, {
        role: authenticated ? 'USER' : 'NONE',
        anonymous: !authenticated,
        locked: state.locked,
        permissions: [],
        active: authenticated,
        authenticated,
      });
    }
    if (!authenticated) return error(401, 'not authorized');
    if (path === 'auth/logout' && method === 'POST') {
      sessions.delete(session);
      return { status: 200, text: '' };
    }
    if (path === 'processdata' && method === 'GET') return processDataList();
    if (path === 'processdata' && method === 'POST') return processValues(body);
    if (path === 'settings' && method === 'GET') return json(200, state.settings);
    if (path === 'settings' && method === 'POST') return settingValues(body);
    if (path === 'settings' && method === 'PUT') return writeSettings(body);
    if (path === 'events/latest' && method === 'POST') return events(body);
    return error(404, 'not found');
  }

  const fake = {
    state,
    requests,
    writes,
    sessions,
    get failedLogins() {
      return failedLogins;
    },

    /** The app's transport: no socket. */
    async transport({ method, url, headers, body }) {
      if (state.down) {
        const err = new Error(`connect ${state.down}`);
        err.code = state.down;
        throw err;
      }
      const { pathname } = new URL(url);
      if (!pathname.startsWith('/api/v1/')) return error(404, 'not found');
      return handle({
        method,
        path: pathname.slice('/api/v1/'.length),
        headers,
        body: body === undefined ? undefined : JSON.parse(body),
      });
    },

    /** How many requests reached `path` (and `method`). */
    count(path, method) {
      return requests.filter((r) => r.path === path && (!method || r.method === method)).length;
    },
    /** Set a process data value. */
    set(moduleid, id, value) {
      state.values[moduleid][id] = value;
    },
    goDown(code = 'EHOSTUNREACH') {
      state.down = code;
    },
    comeBack() {
      state.down = null;
    },
    /** The inverter restarted: every session is gone. */
    dropSessions() {
      sessions.clear();
    },

    /** Put the fake on 127.0.0.1 (random port); resolves { url, close }. */
    serve() {
      const server = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', (chunk) => chunks.push(chunk));
        req.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          const { pathname } = new URL(req.url, 'http://localhost');
          const answer = pathname.startsWith('/api/v1/')
            ? handle({
                method: req.method,
                path: pathname.slice('/api/v1/'.length),
                headers: req.headers,
                body: text ? JSON.parse(text) : undefined,
              })
            : error(404, 'not found');
          res.writeHead(answer.status, { 'content-type': 'application/json' });
          res.end(answer.text);
        });
      });
      return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
          resolve({
            url: `http://127.0.0.1:${server.address().port}`,
            close: () => new Promise((done) => server.close(done)),
          });
        });
      });
    },
  };
  fake.transport = fake.transport.bind(fake);
  return fake;
}
