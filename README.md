# Kostal Plenticore for Gladys Assistant

A [Gladys Assistant](https://gladysassistant.com) integration for **Kostal
PLENTICORE plus, PLENTICORE BI and PIKO IQ / PIKO MP** inverters, read on the
local network through the REST API of the inverter (the one its web interface
uses), with the plant owner password. No Kostal cloud, no Modbus register to
configure.

> **Developed without the hardware: feedback welcome.** Everything was built
> from the documentation of the API as the Home Assistant integration and the
> pykoplenti library use it, and tested against a simulated inverter that
> implements the real login handshake. If you own one of these inverters,
> please tell us how it goes (forum or GitHub issue), with
> `node scripts/probe.mjs <address>` output if something looks wrong.

This integration is not affiliated with KOSTAL Solar Electric. Kostal,
PLENTICORE and PIKO are trademarks of their owners.

## What it does

One Gladys device per inverter, with what the inverter actually measures:

- solar production, total and per PV string;
- house consumption, the grid exchange (one signed value: import +, export −),
  the AC output of the inverter;
- the battery, when there is one: state of charge, charging and discharging
  power, cycles;
- energy counters: production of the day and since commissioning, energy the
  house took from the grid (the one consumption index, for the Gladys energy
  tracking), energy fed into the grid, battery charge and discharge;
- the inverter state (feeding in, standby, throttled…), the active alarm count
  and the text of the latest alarm, as the inverter words it.

And around the device:

- a **dashboard widget**: live tiles, a 24 h production / consumption chart,
  a status list (grid and battery flows, inverter state, alarms, autarky and
  self-consumption of the day, battery settings);
- **scene triggers**: a new inverter alarm (with its code and text), battery
  full, battery empty (with hysteresis);
- **scene actions**, off by default: the battery reserve (minimum state of
  charge) and Kostal's smart battery control, when the inverter lets the plant
  owner change them.

The user documentation is in [`docs/`](docs) (English, French, German,
Spanish); Gladys shows it from the Configuration screen.

## Requirements

- Gladys 5.1 or later (5.2 for the energy tracking of the counters at its
  best).
- A Kostal PLENTICORE plus / BI or PIKO IQ / MP on the same network as Gladys,
  with a fixed IP address.
- The plant owner password of the inverter's web interface. The installer
  service code is not needed (and not supported).

## Installation

1. In Gladys, open **Integrations → Install from GitHub** and enter
   `https://github.com/guim31/gladys-kostal` (or install it from the store
   once it is listed).
2. In the **Configuration** tab, enter the address of the inverter and the
   plant owner password, and save. **Test the connection** says what was
   found.
3. In the **Discovery** tab, add the inverter: it is refreshed only once
   added.
4. Add the **Kostal** widget to a dashboard, and use the triggers in your
   scenes.

## How it works

- Login: SCRAM-SHA-256 then an AES-GCM encrypted session request, as the web
  interface does (`src/kostal/scram.js`); the password never travels. The
  session is kept; a request answered 401 logs in again once.
- Refresh: one `POST /api/v1/processdata` every 10 to 60 seconds (15 by
  default), all modules at once; only the ids the inverter lists are asked.
  The alarm texts are read only while an alarm is active, the battery settings
  every 5 minutes and only when allowed, the inventory every 30 minutes.
- The integration refreshes the device with its own timer; the poll of the
  Gladys core (once a minute) is only a fallback (GladysAssistant/Gladys#3198).
- Only the values that changed are sent to Gladys, plus every value again
  every 6 hours.
- A refused password is not retried for 15 minutes (or until the
  configuration is saved): the inverter locks the account after several failed
  logins. The integration logs out when it stops.
- The inventory (serial number, model, the measurements available) is kept in
  `/data`, so the device is published again after a restart even if the
  inverter does not answer. No secret is written there.

## Limits

- Developed without the hardware: the signs (grid, battery), the measurements
  of each model and the writable settings are taken from the documentation and
  the Home Assistant integration.
- Plant owner access only: no installer (master key + service code) settings.
- One inverter per installation of the integration; no mediated discovery
  (Kostal inverters announce nothing in mDNS or SSDP that Gladys relays).
- The grid export counter is computed (yield minus the house consumption served
  by the inverter), like pykoplenti's virtual value.
- The Gladys 5.2 core does not derive a half-hourly production from the
  production index of an external integration yet.

## Development

Node.js 22 or later, ESM, no build step. The only runtime dependency is
[`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js).

```bash
npm install
npm test                 # node --test, against the SDK's fake Gladys and a fake inverter
npm run lint             # ESLint
npm run format:check     # Prettier, as the CI runs it
npx github:GladysAssistant/integration-store --skip-image-check .   # store checks
```

Check a real inverter, read-only, from a machine on its network:

```bash
node scripts/probe.mjs 192.0.2.20                            # version + a made-up password refused
KOSTAL_PASSWORD='…' node scripts/probe.mjs 192.0.2.20        # everything the integration reads
```

The probe never prints the password, the session, the full serial number nor
the host name, and writes nothing to the inverter.

Run the integration against a real inverter, outside Docker:

```bash
GLADYS_HOST_API_URL="http://localhost:1443" \
GLADYS_INTEGRATION_TOKEN="<token>" \
GLADYS_INTEGRATION_SELECTOR="kostal" \
KOSTAL_DATA_DIR=./data \
LOG_LEVEL=debug \
npm start
```

Project layout:

```
index.js                SDK wiring
src/app.js              handlers, refresh cycle, reachability, login back-off, widget, action
src/kostal/             REST client, login handshake, parsers, service (inventory + readings)
src/devices/            the inverter device and its states
src/triggers.js         scene triggers
src/scenes.js           scene actions (battery settings)
src/widgets.js          the "Kostal" widget
src/i18n.js             every user-visible text, in en / fr / de / es
scripts/probe.mjs       read-only probe of a real inverter
test/                   node --test; test/helpers/fakeKostal.js is the fake inverter
```

`test/gladys-rules.test.js` checks the device built from the fixtures against
the couples, units and polling values the Gladys core accepts.

## Releasing

Releases are made from GitHub: describe the change under `## [Unreleased]` in
[`CHANGELOG.md`](CHANGELOG.md), then **Actions → Release → Run workflow**
(`patch`, `minor` or `major`). The workflow bumps the version in
`package.json` and in the manifest (`version` and `docker_image`), builds the
multi-arch image to `ghcr.io/guim31/gladys-kostal`, tags and publishes the
GitHub Release.

> A hand-pushed `vX.Y.Z` tag triggers the same build, but does not touch
> `package.json`, the manifest or the changelog: bump `version` in
> `package.json` and in `gladys-assistant-integration.json` (with the
> `docker_image` tag) and commit it before tagging.

## Credits

- [**pykoplenti**](https://github.com/stegm/pykoplenti) by @stegm
  (Apache 2.0): the login handshake (SCRAM + AES-GCM session), the endpoints,
  status codes and the "virtual" grid export counter are ported from it.
- The Home Assistant
  [**kostal_plenticore**](https://github.com/home-assistant/core/tree/dev/homeassistant/components/kostal_plenticore)
  integration (Apache 2.0): the process data and settings it reads, the
  inverter state codes, the battery settings and their test fixtures.
- [kostal-RESTAPI](https://github.com/kilianknoll/kostal-RESTAPI) by Kilian
  Knoll, credited by pykoplenti for the first reading of this API.

## License

[Apache-2.0](LICENSE)
