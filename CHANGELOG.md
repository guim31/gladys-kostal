# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Added

- Kostal PLENTICORE plus, PLENTICORE BI and PIKO IQ / MP inverters, read on the
  local network through their REST API with the plant owner password (no
  cloud, no Modbus). One device per inverter: solar production (total and per
  PV string), house consumption, grid exchange, AC output, battery (level,
  charging and discharging power, cycles), the day's production, lifetime
  counters (production, house from the grid, grid export, battery charge and
  discharge), inverter state, active alarms and the text of the latest alarm.
- Energy tracking: the energy the house takes from the grid is a consumption
  index, from which Gladys derives a 30-minute consumption and its cost.
- The "Kostal" dashboard widget: live tiles, a 24 h production and consumption
  chart, a status list (grid and battery flows, inverter state, alarms,
  autarky and self-consumption of the day).
- Scene triggers: a new inverter alarm (with its code and text), battery full
  and battery empty (with hysteresis).
- Scene actions, off by default: the battery reserve (minimum state of charge)
  and the smart battery control, when the inverter lets the plant owner change
  them.
- A "Test the connection" button, and the documentation in English, French,
  German and Spanish.

[Unreleased]: https://github.com/guim31/gladys-kostal/commits/main
