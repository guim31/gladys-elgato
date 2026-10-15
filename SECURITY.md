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

- **Secrets**: none. The Elgato local API has no password nor key, and the
  integration asks for no account.
- **Stored in `/data`**: `elgato-state.json`, the Elgato lights seen so far:
  their IP address and port, product name, serial number, firmware version,
  MAC address, the name given in Control Center, and whether they have colour
  or a battery. The Wi-Fi network name a light reports is never read out nor
  kept.
- **Network**: plain HTTP on TCP port 9123 (or the port typed in the
  configuration), only to the Elgato lights of the local network (the
  addresses found by the discovery or typed in the configuration). The mDNS
  browse for `_elg._tcp` is done by the Gladys core on the integration's
  behalf (manifest `network_discovery`). The integration opens no listening
  port and calls no cloud service.

Anyone on the local network can drive an Elgato light the same way: its API
has no authentication. This is how Elgato lights work, not something the
integration adds.

Out of scope: Gladys Assistant itself (see its
[security policy](https://github.com/GladysAssistant/Gladys/security/policy)),
the Elgato lights and apps, and the other devices of your network.
