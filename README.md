# Elgato Light for Gladys Assistant

A [Gladys Assistant](https://gladysassistant.com) integration for the
[Elgato](https://www.elgato.com) lights: Key Light, Key Light Air, Key Light
Mini, Ring Light and Light Strip, driven over the local network with the HTTP
API the Elgato Control Center app uses. No account, no cloud.

> **Developed without the hardware: feedback welcome.** Everything was built
> and tested against real answers of Elgato lights (recorded by the
> python-elgato and Home Assistant projects) and against a simulated light,
> not against a real one. Please report what works and what does not on the
> [Gladys forum](https://community.gladysassistant.com) or in the
> [issues](https://github.com/guim31/gladys-elgato/issues).

## Features

- **Automatic discovery**: Gladys browses the network for the `_elg._tcp`
  mDNS service on behalf of the integration. IP addresses (or names, with an
  optional port) can be typed for the lights on another network.
- **One Gladys device per light**:
  - on/off, brightness, and colour temperature in kelvins (2900 to 7000 K)
    for every light;
  - hue, saturation and a colour (for the colour wheel of the dashboard) for
    the Light Strip;
  - battery level and charging for the Key Light Mini.
- **Follows the changes made elsewhere** (Control Center, Stream Deck, the
  buttons of the light) within the refresh interval, 10 seconds by default.
- **Scene actions** on one or more lights: _Make Elgato lights blink_, and
  _Set Elgato lights_ (on, brightness and white in a single request: the
  video call preset).
- **Configuration buttons**: _Search for Elgato lights_ and _Make a light
  blink_ (to tell which light is which).
- No dedicated widget: the light panel of the Gladys dashboard already drives
  every feature.
- English, French, German and Spanish, in the interface, the feature names and
  the [documentation](docs/en.md) ([fr](docs/fr.md), [de](docs/de.md),
  [es](docs/es.md)).

## Requirements

- Gladys Assistant **5.1.0** or later.
- Elgato lights set up with Elgato Control Center, on the network of Gladys.

## Installation

In Gladys, open **Integrations**, then **Install from GitHub**, and enter the
address of this repository:

```
https://github.com/guim31/gladys-elgato
```

Then open the **Discover** tab of the integration and add the lights. The
[documentation](docs/en.md) details the options and the scenes.

## How it works

- The Elgato local API is plain HTTP on port 9123, without authentication:
  `GET /elgato/accessory-info` (product, serial number, firmware),
  `GET /elgato/lights/settings` (a `battery` block on a Key Light Mini, a
  power-on hue on a colour light), `GET` and `PUT /elgato/lights` (state and
  commands), `GET /elgato/battery-info`, `POST /elgato/identify`. One request
  at a time per light, each on its own connection, like Home Assistant
  serializes its calls.
- The integration runs in an isolated container on a Docker bridge, where
  mDNS never arrives. The **mDNS browse** is done by the Gladys core (`mdns`
  mediated discovery, `_elg._tcp` declared in the manifest); the integration
  reads the IPv4 addresses and ports it relays, then talks to each light in
  unicast.
- **Polling**: the lights push nothing. The integration reads each light added
  to Gladys at the configured interval (one `GET /elgato/lights`, plus
  `/elgato/battery-info` on a Key Light Mini), with its own timer: the devices
  are published with `should_poll: false` (GladysAssistant/Gladys#3198), and a
  poll from the core is served only when the timer did not just read the
  light.
- **Units**: the API speaks mireds (143 to 344); Gladys gets kelvins with the
  `kelvin` unit, which its light panel reads as a physical scale. A value sent
  from Gladys is shown back as sent (4500 K stays 4500 K, although mired 222
  is 4505 K). The Light Strip speaks hue and saturation; the colour feature is
  their RGB at full value, brightness apart.
- Like Home Assistant, a brightness sent to a Light Strip in white mode also
  carries its temperature, or the strip would jump back to its last colour.
- A light that stops answering two readings in a row gets the _unreachable_
  badge and keeps its last state: Elgato lights may drop off the Wi-Fi while
  still lit.
- Each light is identified by its serial number: a light that changes address
  (DHCP) keeps its Gladys device, and its new address reaches Gladys at the
  next search (every 15 minutes). The lights seen are kept in
  `/data/elgato-state.json`; without it, the lights added to Gladys are found
  again from the address stored in their device.

## Checked, and what was not

Checked:

- every model of the fixtures (Key Light, Key Light Air, Key Light Mini on
  mains and on battery, Light Strip in colour and in white mode, and a
  constructed Ring Light) against the rules of the Gladys core (feature
  couples, bounds, units, poll frequencies) in the four languages;
- the whole integration against the fake Gladys of the SDK and fake lights
  that are real HTTP servers: discovery, states, every command, unreachable
  lights, address changes, restarts, the scene actions, the logs;
- the manifest against the store validator.

Not checked, for want of hardware or of a Gladys instance:

- a real Elgato light: whether every firmware answers a `PUT` with the new
  state (the integration falls back on the state it sent), whether a Key
  Light accepts a brightness of 1 % (the Control Center minimum is 3 %), the
  real colour temperature range of the Light Strip, the TXT record of the
  mDNS announcement (only used as a hint);
- the mDNS browse through a real Gladys core on a real LAN;
- the rendering of the light panel and of the scene cards in the Gladys
  interface.

`node scripts/probe.mjs <ip>` checks a real light, read-only, and prints what
the integration would publish; its output is safe to paste in an issue.

## Limitations

- Changes made outside Gladys are seen at the next reading (5 to 60 s).
- Not offered: power-on behaviour, fade durations, studio mode and energy
  saving of the Key Light Mini, firmware updates, the scenes of the Light
  Strip Pro.
- The Ring Light is handled as a white light like the Key Light; no published
  answer of a real Ring Light was available.

## Development

```bash
npm ci
npm run format:check
npm run lint
npm test
npx -y github:GladysAssistant/integration-store --skip-image-check .
```

`node tools/fake-elgato.mjs [fixture] [port]` runs a simulated light on this
machine, to try the integration with a real Gladys without the hardware.

## Credits

- [python-elgato](https://github.com/frenck/python-elgato) (MIT License,
  © Franck Nijhof): the API, the units and their bounds, and the real device
  answers used as test fixtures.
- The [Home Assistant Elgato integration](https://github.com/home-assistant/core/tree/dev/homeassistant/components/elgato)
  (Apache License 2.0, © the Home Assistant authors): the discovery, polling
  and colour choices, the Light Strip brightness fix, and test fixtures.
- Built from the official
  [Gladys integration template](https://github.com/GladysAssistant/integration-template-js).

## Disclaimer

This project is not affiliated with, endorsed by or connected to Elgato or
Corsair. Elgato, Key Light, Ring Light and Light Strip are trademarks of
Corsair Memory, Inc.

## License

[Apache License 2.0](LICENSE).
