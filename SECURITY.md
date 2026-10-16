# Security policy

## Reporting a vulnerability

Please do **not** report a security problem in a public issue, pull request or
forum post.

Report it privately through GitHub instead: open the **Security** tab of this
repository, then **Report a vulnerability**.

No such button? Private reporting is not enabled yet: open an issue that only
asks the maintainers for a private contact, without any detail of the problem,
and send the report there.

Include, when you can:

- the version of the integration and of Gladys;
- what an attacker can do, and the steps to reproduce it;
- the log lines that help (remove tokens, passwords and addresses first).

The fix ships as a new version of the integration, and the advisory is
published once users can update.

## Supported versions

Only the latest release receives security fixes: update the integration from
Gladys before reporting a problem.

## Scope

In scope: the code of this repository and the Docker image it publishes.

What the integration handles:

- **Secrets**: the plant owner password of the inverter lives in the Gladys
  configuration only. It never travels in clear (the login is a SCRAM-SHA-256
  handshake) and is never written to the logs nor to `/data`. The session id
  the inverter gives lives in memory only, and the integration logs out when it
  stops.
- **`/data`**: one JSON file with the inventory of the inverter (serial number,
  model, firmware versions, the measurements available). No secret.
- **Network**: the integration only talks to the address configured, over
  HTTP on the local network (HTTPS when typed, with the inverter's self-signed
  certificate accepted). It writes to the inverter only through the two battery
  scene actions, which are off by default.

Out of scope: Gladys Assistant itself (see its
[security policy](https://github.com/GladysAssistant/Gladys/security/policy)),
the inverter and its firmware, and the Kostal cloud services.
