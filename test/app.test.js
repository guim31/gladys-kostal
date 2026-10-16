// -----------------------------------------------------------------------------
// The life of the integration: its own refresh timer (no onPoll needed), the
// onPoll fallback, reachability (status, badge, one log line per change), a
// refused password not retried, an expired session, quiet logs, no secret in
// the logs, the inventory kept in /data, the action, the configuration.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, TEST_HOST } from './helpers/world.js';
import { TEST_PASSWORD } from './helpers/fakeKostal.js';
import { createMemoryStore } from '../src/store.js';
import { AUTH_RETRY_MS, HEARTBEAT_MS } from '../src/app.js';

const settle = async () => {
  for (let i = 0; i < 50; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};

test('the states refresh on the container timer, without any onPoll', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const world = await createWorld({ timers: true, config: { poll_interval: '10' } });
  assert.equal(world.state('home_power'), 1050);
  for (const [watts, expected] of [
    [1800.2, 1800],
    [2500.6, 2501],
  ]) {
    world.kostal.set('devices:local', 'Home_P', watts);
    world.clock.advance(10000);
    t.mock.timers.tick(10000);
    await settle();
    assert.equal(world.state('home_power'), expected);
  }
  // The fake Gladys never sent a poll: the refreshes are the container's.
  assert.ok(world.gladys.fake.wsMessages.every((message) => message.type !== 'poll'));
  await world.app.stop();
});

test('onPoll is a fallback: skipped while the timer is on time, a refresh when it is late', async () => {
  const world = await createWorld();
  const before = world.kostal.count('processdata', 'POST');
  world.clock.advance(5000);
  assert.deepEqual(await world.gladys.fake.poll(world.device), { success: true });
  assert.equal(world.kostal.count('processdata', 'POST'), before, 'read 5 s ago: skipped');
  world.clock.advance(20000);
  await world.gladys.fake.poll(world.device);
  assert.equal(world.kostal.count('processdata', 'POST'), before + 1);
  await world.app.stop();
});

test('a refresh is a single request to the inverter', async () => {
  const world = await createWorld();
  const before = world.kostal.requests.length;
  world.clock.advance(15000);
  await world.app.cycle();
  assert.deepEqual(world.kostal.requests.slice(before), [{ method: 'POST', path: 'processdata' }]);
  await world.app.stop();
});

test('without the device added, the inverter is not read after the discovery', async () => {
  const world = await createWorld({ create: false });
  const before = world.kostal.requests.length;
  world.clock.advance(60000);
  await world.app.cycle();
  await world.app.cycle();
  assert.equal(world.kostal.requests.length, before);
  assert.equal(world.gladys.fake.states.length, 0);
  await world.app.stop();
});

test('the device just added receives its states at once, then the widget is nudged', async () => {
  const world = await createWorld({ create: false });
  // The widget read the inverter once (nothing else did).
  await world.gladys.fake.widgetGet('energy_flow');
  const before = world.kostal.requests.length;
  await world.gladys.fake.deviceCreated(world.device);
  assert.equal(world.kostal.requests.length, before, 'no request to the inverter');
  assert.equal(world.state('pv_power'), 7012);
  assert.equal(
    world.state('inverter_state').text ?? world.state('inverter_state'),
    'En production',
  );
  assert.ok(world.gladys.fake.widgetRefreshes.includes('energy_flow'));
  await world.app.stop();
});

test('only what changed is published, and an unchanged value again after the heartbeat', async (t) => {
  // The SDK dates the published values with Date.now().
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const world = await createWorld();
  const count = () => world.gladys.fake.states.length;
  const start = count();
  world.clock.advance(15000);
  await world.app.cycle();
  assert.equal(count(), start, 'same readings: nothing sent');
  world.kostal.set('devices:local', 'Grid_P', 150.4);
  world.clock.advance(15000);
  await world.app.cycle();
  assert.equal(count(), start + 1);
  assert.equal(world.state('grid_power'), 150);
  world.clock.advance(HEARTBEAT_MS);
  t.mock.timers.tick(HEARTBEAT_MS);
  await world.app.cycle();
  assert.ok(count() > start + 10, 'every value sent again after the heartbeat');
  assert.ok(HEARTBEAT_MS <= 12 * 3600 * 1000);
  await world.app.stop();
});

test('a normal cycle writes nothing at info level or above', async () => {
  const world = await createWorld({ config: { allow_settings: true } });
  const before = world.logs.lines.filter((line) => line.level !== 'debug').length;
  for (let i = 0; i < 6; i += 1) {
    world.clock.advance(15000);
    await world.app.cycle();
  }
  await world.gladys.fake.widgetGet('energy_flow');
  await world.gladys.fake.poll(world.device);
  assert.equal(world.logs.lines.filter((line) => line.level !== 'debug').length, before);
  assert.ok(world.logs.at('debug').length > 0, 'the details are in debug');
  await world.app.stop();
});

test('the start writes one info line about the inverter found', async () => {
  const world = await createWorld();
  assert.deepEqual(
    world.logs.lines.filter((line) => line.level !== 'debug').map((line) => line.text),
    [
      'Kostal inverter at http://192.0.2.20: Kostal PLENTICORE plus 10 (firmware 01.26.09454): 2 PV string(s), battery',
    ],
  );
  assert.equal(world.gladys.fake.connectionStatus.connected, true);
  await world.app.stop();
});

test('lost and back: one warning, one info line, the status and the badge follow', async () => {
  const world = await createWorld();
  world.kostal.goDown('EHOSTUNREACH');
  for (let i = 0; i < 5; i += 1) {
    world.clock.advance(15000);
    await world.app.cycle();
  }
  assert.equal(world.logs.at('warn').length, 1, 'one warning, not one per cycle');
  assert.match(world.logs.at('warn')[0].text, /unreachable.*EHOSTUNREACH/);
  const lost = world.gladys.fake.connectionStatus;
  assert.equal(lost.connected, false);
  assert.match(lost.message.fr, /ne répond pas \(processdata: EHOSTUNREACH\)/);
  assert.equal(world.gladys.fake.transports.at(-1).transport, 'unreachable');

  world.kostal.comeBack();
  world.clock.advance(15000);
  await world.app.cycle();
  world.clock.advance(15000);
  await world.app.cycle();
  assert.deepEqual(
    world.logs.at('info').map((line) => line.text),
    [
      'Kostal inverter at http://192.0.2.20: Kostal PLENTICORE plus 10 (firmware 01.26.09454): 2 PV string(s), battery',
      'The inverter answers again',
    ],
  );
  assert.equal(world.gladys.fake.connectionStatus.connected, true);
  assert.equal(world.gladys.fake.transports.at(-1).transport, 'local');
  await world.app.stop();
});

test('an expired session (inverter restarted) logs in again silently', async () => {
  const world = await createWorld();
  const logins = world.kostal.count('auth/create_session');
  world.kostal.dropSessions();
  world.kostal.set('devices:local', 'Home_P', 777);
  world.clock.advance(15000);
  await world.app.cycle();
  assert.equal(world.state('home_power'), 777);
  assert.equal(world.kostal.count('auth/create_session'), logins + 1);
  assert.equal(world.logs.lines.filter((line) => line.level !== 'debug').length, 1);
  await world.app.stop();
});

test('the session is kept: one login for many refreshes, a logout on stop', async () => {
  const world = await createWorld();
  for (let i = 0; i < 10; i += 1) {
    world.clock.advance(15000);
    await world.app.cycle();
  }
  assert.equal(world.kostal.count('auth/create_session'), 1);
  assert.equal(world.kostal.sessions.size, 1);
  await world.app.stop();
  assert.equal(world.kostal.sessions.size, 0, 'the inverter keeps only a few sessions');
});

test('a refused password: a clear status, no new try for 15 minutes, then once', async () => {
  const world = await createWorld({ config: { password: 'wrong-password' }, create: false });
  assert.equal(world.kostal.failedLogins, 1);
  const status = world.gladys.fake.connectionStatus;
  assert.equal(status.connected, false);
  assert.match(status.message.fr, /a refusé le mot de passe/);
  assert.equal(world.logs.at('warn').length, 1);
  for (let i = 0; i < 20; i += 1) {
    world.clock.advance(15000);
    await world.app.cycle();
    await world.gladys.fake.widgetGet('energy_flow');
  }
  assert.equal(world.kostal.failedLogins, 1, 'the account is not locked by retries');
  world.clock.advance(AUTH_RETRY_MS);
  await world.app.cycle();
  assert.equal(world.kostal.failedLogins, 2);
  assert.equal(world.logs.at('warn').length, 1, 'said once');
  await world.app.stop();
});

test('saving the right password logs in at once', async () => {
  const world = await createWorld({ config: { password: 'wrong-password' } });
  assert.equal(world.gladys.fake.discoveredDevices.length, 0);
  await world.gladys.fake.configUpdated({ host: TEST_HOST, password: TEST_PASSWORD });
  assert.equal(world.gladys.fake.connectionStatus.connected, true);
  assert.equal(world.gladys.fake.discoveredDevices.length, 1);
  assert.ok(
    world.logs.at('info').some((line) => line.text === 'The inverter accepts the password again'),
  );
  await world.app.stop();
});

test('a locked account says so', async () => {
  const world = await createWorld({
    create: false,
    before: (kostal) => {
      kostal.state.locked = true;
    },
  });
  assert.match(world.gladys.fake.connectionStatus.message.en, /locked the plant owner account/);
  const result = await world.gladys.fake.action('test_connection');
  assert.match(result.data.message.en, /locked/);
  await world.app.stop();
});

test('no secret ever reaches the logs nor Gladys', async () => {
  const world = await createWorld({
    config: { host: 'http://admin:typed-in-url@192.0.2.20', allow_settings: true },
  });
  world.kostal.goDown();
  world.clock.advance(15000);
  await world.app.cycle();
  world.kostal.comeBack();
  world.kostal.dropSessions();
  world.clock.advance(15000);
  await world.app.cycle();
  await world.gladys.fake.action('test_connection');
  await world.gladys.fake.configUpdated({ host: TEST_HOST, password: 'another-wrong-one' });
  const everything = JSON.stringify([
    world.logs.lines,
    world.gladys.fake.requests.filter((request) => request.path !== '/config'),
    world.gladys.fake.wsMessages,
  ]);
  for (const secret of [
    TEST_PASSWORD,
    'another-wrong-one',
    'typed-in-url',
    'admin:',
    ...world.kostal.sessions,
  ]) {
    assert.ok(!everything.includes(secret), `"${secret}" leaked`);
  }
  await world.app.stop();
});

test('the inventory kept in /data publishes the device even when the inverter is down', async () => {
  const store = createMemoryStore();
  const first = await createWorld({ store });
  const expected = first.device.external_id;
  await first.app.stop();
  assert.ok(
    !JSON.stringify([...store.files.values()]).includes(TEST_PASSWORD),
    'no secret in /data',
  );

  const second = await createWorld({ store, before: (kostal) => kostal.goDown() });
  assert.equal(second.device.external_id, expected);
  assert.equal(second.gladys.fake.connectionStatus.connected, false);
  await second.app.stop();
});

test('the connection test lists what it found', async () => {
  const world = await createWorld({ config: { allow_settings: true } });
  const result = await world.gladys.fake.action('test_connection');
  assert.equal(result.success, true);
  assert.equal(
    result.data.message.fr,
    'Kostal PLENTICORE plus 10 trouvé, 2 chaîne(s) PV, batterie, firmware 01.26.09454. Réglages de la batterie : modifiables avec ce mot de passe.',
  );
  const pv = await createWorld({ system: 'plenticore_pv' });
  const answer = await pv.gladys.fake.action('test_connection');
  assert.match(
    answer.data.message.en,
    /3 PV string\(s\), no battery.*not allowed in the configuration/,
  );
  await world.app.stop();
  await pv.app.stop();
});

test('without address or password: a status that says what to do, nothing read', async () => {
  const world = await createWorld({ config: { password: '' }, create: false });
  assert.equal(world.kostal.requests.length, 0);
  assert.match(world.gladys.fake.connectionStatus.message.fr, /mot de passe propriétaire/);
  const invalid = await createWorld({ config: { host: 'http://' }, create: false });
  assert.match(invalid.gladys.fake.connectionStatus.message.en, /not valid/);
  await world.app.stop();
  await invalid.app.stop();
});

test('an alarm: its text is read from the inverter, in the configured language', async () => {
  const world = await createWorld({
    config: { language: 'de' },
    before: (kostal) => {
      kostal.state.events.unshift({
        descriptions: { en: 'Insulation fault', de: 'Isolationsfehler' },
        description: 'Insulation fault',
        category: 'error',
        is_active: true,
        code: 3013,
        start_time: '2026-06-21T07:58:00',
        end_time: '2026-06-21T07:58:00',
        group: 'Error',
        long_description: 'Insulation fault',
      });
    },
  });
  assert.equal(world.state('latest_alarm').text ?? world.state('latest_alarm'), 'Kein Alarm');
  world.kostal.set('scb:event', 'Event:ActiveErrorCnt', 1);
  world.clock.advance(15000);
  await world.app.cycle();
  assert.equal(world.state('active_alarms'), 1);
  const text = world.gladys.fake.lastState(`${world.device.external_id}:latest_alarm`);
  assert.equal(text.text ?? text, 'Isolationsfehler');
  // Read once, not at every cycle while the alarm lasts.
  const reads = world.kostal.count('events/latest');
  world.clock.advance(15000);
  await world.app.cycle();
  assert.equal(world.kostal.count('events/latest'), reads);
  await world.app.stop();
});
