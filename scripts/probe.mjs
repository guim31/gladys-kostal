#!/usr/bin/env node
// -----------------------------------------------------------------------------
// Read-only probe of a real Kostal inverter, with the integration's own client
// (src/kostal/). For the maintainer, from a machine on the inverter's network:
//
//   node scripts/probe.mjs 192.0.2.20
//   KOSTAL_PASSWORD='…' node scripts/probe.mjs 192.0.2.20
//
// 1. Without a password: API version (no login), anonymous session, then ONE
//    login attempt with a made-up password, which the inverter must refuse
//    (HTTP 400): it proves the whole handshake reaches the inverter. Skip it
//    with --no-fake-login (failed logins count towards the account lock).
// 2. With KOSTAL_PASSWORD: the real login, then everything the integration
//    reads: process data ids present or missing, their values and units, the
//    battery settings and whether the owner may write them, the active alarm
//    count. Nothing is written to the inverter.
//
// Never printed: the password, the session id, the full serial number, the
// host name. The values printed (powers, counters) are not personal data, but
// read the output before sharing it.
// -----------------------------------------------------------------------------

import { createClient } from '../src/kostal/client.js';
import { parseHost } from '../src/config.js';
import {
  BATTERY_SETTINGS,
  MODULES,
  WANTED_PROCESS_DATA,
  identityRequest,
  parseInventory,
  parseReading,
  processDataIndex,
  processRequest,
  settingsIndex,
} from '../src/kostal/parse.js';

const FAKE_PASSWORD = 'gladys-probe-not-the-password';

/** The first two characters, the rest hidden. */
export function mask(text) {
  const value = String(text ?? '');
  return value.length <= 2 ? '**' : `${value.slice(0, 2)}${'*'.repeat(value.length - 2)}`;
}

/**
 * @param {object} options
 * @param {string} options.host what the user would type in the configuration
 * @param {string} [options.password] the plant owner password
 * @param {boolean} [options.fakeLogin] try a made-up password first
 * @param {Function} [options.transport] for the tests
 * @param {(line: string) => void} [options.print]
 * @returns {Promise<number>} the exit code
 */
export async function probe({ host, password, fakeLogin = true, transport, print = console.log }) {
  const { baseUrl, valid } = parseHost(host);
  if (!valid || !baseUrl) {
    print('Usage: node scripts/probe.mjs <inverter address> (KOSTAL_PASSWORD in the environment)');
    return 2;
  }
  const options = (secret) => ({
    baseUrl,
    password: () => secret,
    ...(transport ? { transport } : {}),
  });
  print(`Inverter: ${baseUrl}`);

  const anonymous = createClient(options(''));
  try {
    const version = await anonymous.version();
    print(
      `API: ${version?.name ?? '?'} ${version?.api_version ?? '?'}, firmware ${version?.sw_version ?? '?'}`,
    );
    const me = await anonymous.me();
    print(
      `Anonymous session: role ${me?.role ?? '?'}, authenticated ${me?.authenticated === true}`,
    );
  } catch (err) {
    print(`Not reachable: ${err.message}`);
    return 1;
  }

  if (fakeLogin) {
    try {
      await createClient(options(FAKE_PASSWORD)).login();
      print('UNEXPECTED: a made-up password was accepted');
      return 1;
    } catch (err) {
      print(
        err.kind === 'auth'
          ? `Made-up password refused as expected (${err.message})`
          : `Made-up password: unexpected answer (${err.kind}: ${err.message})`,
      );
      if (err.kind !== 'auth') return 1;
    }
  }

  if (!password) {
    print('No KOSTAL_PASSWORD: stopping here.');
    return 0;
  }

  const client = createClient(options(password));
  try {
    await client.login();
    const me = await client.me();
    print(`Logged in: role ${me?.role ?? '?'}`);

    const version = await client.version();
    const processData = await client.processDataList();
    const settings = await client.settingsList();
    const identity = await client.settingValues(identityRequest(settingsIndex(settings)));
    const inventory = parseInventory({ version, processData, settings, identity });
    print(
      `Inverter: ${inventory.model ?? '?'}, serial ${mask(inventory.serial)}, ` +
        `IOC ${inventory.versions.ioc ?? '?'}, MC ${inventory.versions.mc ?? '?'}`,
    );
    print(
      `PV strings: ${inventory.pvStrings.join(', ') || 'none'}; battery: ${inventory.hasBattery}`,
    );

    const available = processDataIndex(processData);
    print(`Modules: ${Object.keys(available).sort().join(', ')}`);
    for (const [module, ids] of Object.entries(WANTED_PROCESS_DATA)) {
      const missing = ids.filter((id) => !available[module]?.has(id));
      if (missing.length > 0) print(`  missing in ${module}: ${missing.join(', ')}`);
    }

    const raw = await client.processValues(processRequest(inventory));
    for (const entry of raw) {
      for (const data of entry.processdata) {
        print(`  ${entry.moduleid}/${data.id} = ${data.value} ${data.unit}`);
      }
    }
    const reading = parseReading(inventory, raw);
    print(
      `Signs: grid ${reading.gridPower} W (import > 0?), battery ${reading.battery?.power ?? '-'} W ` +
        `(discharge > 0?), house ${reading.homePower} W, solar ${reading.pvPower} W`,
    );

    const meta = settingsIndex(settings)[MODULES.local] ?? {};
    for (const id of Object.values(BATTERY_SETTINGS)) {
      print(
        `Setting ${id}: ${meta[id] ? `${meta[id].access}, ${meta[id].min ?? ''}..${meta[id].max ?? ''}` : 'absent'}`,
      );
    }
    const present = Object.values(BATTERY_SETTINGS).filter((id) => meta[id]);
    if (present.length > 0) {
      const values = await client.settingValues([{ moduleid: MODULES.local, settingids: present }]);
      for (const setting of values[0]?.settings ?? []) {
        print(`  ${setting.id} = ${setting.value}`);
      }
    }
    print(`Active alarms: ${reading.activeErrors ?? 'not listed'}`);
    return 0;
  } catch (err) {
    print(`Failed: ${err.kind ?? 'error'}: ${err.message}`);
    return 1;
  } finally {
    await client.logout().catch(() => {});
  }
}

// Run from the command line (not when imported by the tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const host = args.find((arg) => !arg.startsWith('--'));
  const code = await probe({
    host,
    password: process.env.KOSTAL_PASSWORD,
    fakeLogin: !args.includes('--no-fake-login'),
  });
  process.exit(code);
}
