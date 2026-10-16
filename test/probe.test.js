// -----------------------------------------------------------------------------
// scripts/probe.mjs, against the fake inverter on the loopback interface: the
// made-up password is refused, the real one reads everything, nothing
// sensitive is printed, nothing is written.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mask, probe } from '../scripts/probe.mjs';
import { TEST_PASSWORD, createFakeKostal } from './helpers/fakeKostal.js';

async function run(t, options) {
  const kostal = createFakeKostal('plenticore_battery');
  const server = await kostal.serve();
  t.after(() => server.close());
  const lines = [];
  const code = await probe({ host: server.url, print: (line) => lines.push(line), ...options });
  return { kostal, code, lines, output: lines.join('\n') };
}

test('without a password: version, then a made-up password refused', async (t) => {
  const { code, output, kostal } = await run(t, {});
  assert.equal(code, 0);
  assert.match(output, /API: PUCK RESTful API 0\.2\.0, firmware 01\.26\.09454/);
  assert.match(output, /Made-up password refused as expected \(auth\/finish: HTTP 400/);
  assert.equal(kostal.failedLogins, 1);
  assert.equal(kostal.sessions.size, 0);
});

test('with the password: everything the integration reads, nothing sensitive, nothing written', async (t) => {
  const { code, output, kostal } = await run(t, { password: TEST_PASSWORD, fakeLogin: false });
  assert.equal(code, 0, output);
  assert.equal(kostal.failedLogins, 0);
  assert.match(output, /Inverter: PLENTICORE plus 10, serial 99\*{12}/);
  assert.match(output, /devices:local\/Grid_P = -2121\.6 W/);
  assert.match(output, /Signs: grid -2121\.6 W/);
  assert.match(output, /Setting Battery:MinSoc: readwrite, 5\.\.100/);
  // (The host name of this fixture, "scb", is also a module prefix: not checked.)
  for (const secret of [TEST_PASSWORD, '99999ZZZ000123', ...kostal.sessions]) {
    assert.ok(!output.includes(secret), `"${secret}" printed`);
  }
  assert.deepEqual(kostal.writes, []);
  assert.equal(kostal.requests.filter((r) => r.method === 'PUT').length, 0);
  assert.equal(kostal.sessions.size, 0, 'logged out');
});

test('a wrong password, an unreachable inverter, a bad address: a non-zero exit', async (t) => {
  assert.equal((await run(t, { password: 'nope', fakeLogin: false })).code, 1);
  const lines = [];
  assert.equal(await probe({ host: '127.0.0.1:1', print: (l) => lines.push(l) }), 1);
  assert.match(lines.join('\n'), /Not reachable: info\/version: ECONNREFUSED/);
  assert.equal(await probe({ host: '', print: () => {} }), 2);
  assert.equal(mask('ab'), '**');
});
