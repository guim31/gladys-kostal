// -----------------------------------------------------------------------------
// The REST client and the login handshake, against the fake inverter served
// on the loopback interface (real HTTP, real SCRAM, real AES-GCM): the
// session, the 401 re-login, the error kinds, nothing secret in a message.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac, pbkdf2Sync } from 'node:crypto';
import { KostalError, createClient } from '../src/kostal/client.js';
import { computeProof, isServerSignatureValid, sessionRequest } from '../src/kostal/scram.js';
import { TEST_PASSWORD, createFakeKostal } from './helpers/fakeKostal.js';

async function served(t, options) {
  const kostal = createFakeKostal('plenticore_battery', options);
  const server = await kostal.serve();
  t.after(() => server.close());
  return { kostal, url: server.url };
}

test('the proof follows RFC 5802 with the Kostal message layout', () => {
  const clientNonce = Buffer.alloc(12, 1);
  const start = {
    nonce: Buffer.alloc(16, 2).toString('base64'),
    salt: Buffer.alloc(16, 3).toString('base64'),
    rounds: 1000,
  };
  const { proof, serverSignature, authMessage } = computeProof({
    username: 'user',
    password: 'pencil',
    clientNonce,
    start,
  });
  assert.equal(
    authMessage,
    `n=user,r=${clientNonce.toString('base64')},r=${start.nonce},s=${start.salt},i=1000,c=biws,r=${start.nonce}`,
  );
  // Recompute independently: proof = ClientKey XOR HMAC(StoredKey, AuthMessage).
  const salted = pbkdf2Sync('pencil', Buffer.alloc(16, 3), 1000, 32, 'sha256');
  const clientKey = createHmac('sha256', salted).update('Client Key').digest();
  const storedKey = createHash('sha256').update(clientKey).digest();
  const signature = createHmac('sha256', storedKey).update(authMessage).digest();
  const expected = Buffer.from(clientKey.map((byte, i) => byte ^ signature[i]));
  assert.equal(proof, expected.toString('base64'));
  assert.ok(isServerSignatureValid(serverSignature, serverSignature.toString('base64')));
  assert.ok(!isServerSignatureValid(serverSignature, Buffer.alloc(32).toString('base64')));
  assert.ok(!isServerSignatureValid(serverSignature, undefined));
  const body = sessionRequest(Buffer.alloc(32, 9), 'token', Buffer.alloc(16, 4).toString('base64'));
  assert.deepEqual(Object.keys(body).sort(), ['iv', 'payload', 'tag', 'transactionId']);
  assert.throws(() => computeProof({ username: 'user', password: 'x', clientNonce, start: {} }));
});

test('login over HTTP, then process data on the session', async (t) => {
  const { kostal, url } = await served(t);
  const client = createClient({ baseUrl: url, password: () => TEST_PASSWORD });
  assert.equal(client.loggedIn, false);
  const values = await client.processValues([
    { moduleid: 'devices:local', processdataids: ['Home_P', 'Grid_P'] },
  ]);
  assert.deepEqual(values, [
    {
      moduleid: 'devices:local',
      processdata: [
        { id: 'Home_P', unit: 'W', value: 1049.7 },
        { id: 'Grid_P', unit: 'W', value: -2121.6 },
      ],
    },
  ]);
  assert.equal(client.loggedIn, true);
  assert.equal((await client.me()).role, 'USER');
  assert.equal(kostal.sessions.size, 1);
  await client.logout();
  assert.equal(kostal.sessions.size, 0);
  assert.equal(client.loggedIn, false);
});

test('a 401 logs in again once and replays the request', async (t) => {
  const { kostal, url } = await served(t);
  const client = createClient({ baseUrl: url, password: () => TEST_PASSWORD });
  await client.processDataList();
  kostal.dropSessions();
  const list = await client.processDataList();
  assert.ok(list.some((entry) => entry.moduleid === 'scb:statistic:EnergyFlow'));
  assert.equal(kostal.count('auth/create_session'), 2);
});

test('a wrong password is an "auth" error, a locked account a "locked" one', async (t) => {
  const { kostal, url } = await served(t);
  const wrong = createClient({ baseUrl: url, password: () => 'not-it' });
  await assert.rejects(wrong.processDataList(), (err) => {
    assert.ok(err instanceof KostalError);
    assert.equal(err.kind, 'auth');
    assert.equal(err.status, 400);
    assert.ok(!err.message.includes('not-it'));
    return true;
  });
  kostal.state.locked = true;
  const right = createClient({ baseUrl: url, password: () => TEST_PASSWORD });
  await assert.rejects(right.login(), { kind: 'locked' });
  await assert.rejects(createClient({ baseUrl: url, password: () => '' }).login(), {
    kind: 'auth',
  });
});

test('a fake inverter that cannot sign back is refused', async () => {
  const kostal = createFakeKostal();
  const transport = async (request) => {
    const answer = await kostal.transport(request);
    if (request.url.endsWith('auth/finish') && answer.status === 200) {
      const body = JSON.parse(answer.text);
      body.signature = Buffer.alloc(32, 7).toString('base64');
      return { status: 200, text: JSON.stringify(body) };
    }
    return answer;
  };
  const client = createClient({
    baseUrl: 'http://192.0.2.20',
    password: () => TEST_PASSWORD,
    transport,
  });
  await assert.rejects(client.login(), { kind: 'protocol' });
  assert.equal(client.loggedIn, false);
});

test('network errors and timeouts are "network" errors naming the endpoint', async (t) => {
  const refused = createClient({ baseUrl: 'http://127.0.0.1:1', password: () => TEST_PASSWORD });
  await assert.rejects(refused.version(), (err) => {
    assert.equal(err.kind, 'network');
    assert.match(err.message, /^info\/version: ECONNREFUSED/);
    return true;
  });
  // A server that never answers.
  const { createServer } = await import('node:http');
  const silent = createServer(() => {});
  await new Promise((resolve) => silent.listen(0, '127.0.0.1', resolve));
  t.after(() => silent.close());
  silent.on('connection', (socket) => t.after(() => socket.destroy()));
  const slow = createClient({
    baseUrl: `http://127.0.0.1:${silent.address().port}`,
    password: () => TEST_PASSWORD,
    timeoutMs: 100,
  });
  await assert.rejects(slow.version(), /no answer within 100 ms/);
});

test('an unknown id is a "notFound" error; a non-JSON answer a "protocol" one', async (t) => {
  const { url } = await served(t);
  const client = createClient({ baseUrl: url, password: () => TEST_PASSWORD });
  await assert.rejects(
    client.processValues([{ moduleid: 'devices:local', processdataids: ['Nope'] }]),
    { kind: 'notFound' },
  );
  const html = createClient({
    baseUrl: 'http://192.0.2.20',
    password: () => TEST_PASSWORD,
    transport: async () => ({ status: 200, text: '<html>router login</html>' }),
  });
  await assert.rejects(html.version(), { kind: 'protocol' });
});

test('requests run one at a time', async () => {
  const kostal = createFakeKostal();
  let inFlight = 0;
  let max = 0;
  const transport = async (request) => {
    inFlight += 1;
    max = Math.max(max, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 2));
    inFlight -= 1;
    return kostal.transport(request);
  };
  const client = createClient({
    baseUrl: 'http://192.0.2.20',
    password: () => TEST_PASSWORD,
    transport,
  });
  await Promise.all([
    client.version(),
    client.processDataList(),
    client.settingsList(),
    client.me(),
  ]);
  assert.equal(max, 1);
});

test('settings are written as strings, events asked in the configured language', async () => {
  const kostal = createFakeKostal();
  const seen = [];
  const transport = async (request) => {
    seen.push(request);
    return kostal.transport(request);
  };
  const client = createClient({
    baseUrl: 'http://192.0.2.20',
    password: () => TEST_PASSWORD,
    transport,
  });
  await client.writeSettings('devices:local', { 'Battery:MinSoc': '20' });
  assert.deepEqual(kostal.writes, [
    { moduleid: 'devices:local', id: 'Battery:MinSoc', value: '20' },
  ]);
  await client.events('fr', 5);
  assert.deepEqual(JSON.parse(seen.at(-1).body), { language: 'fr-fr', max: 5 });
  await client.events('xx');
  assert.equal(JSON.parse(seen.at(-1).body).language, 'en-gb');
});
