# Elgato fixtures

Answers of real Elgato lights to the local HTTP API (port 9123), one file per
device: `info` is `GET /elgato/accessory-info`, `settings` is
`GET /elgato/lights/settings`, `lights` is `GET /elgato/lights` and `battery`
is `GET /elgato/battery-info` (Key Light Mini only).

They come from the tests of [python-elgato](https://github.com/frenck/python-elgato)
(MIT, Franck Nijhof) and of the Home Assistant `elgato` integration
([home-assistant/core](https://github.com/home-assistant/core), Apache-2.0); the
`source` key of each file says which. Anonymized: serial numbers, MAC addresses,
Wi-Fi network names and display names are invented.

`ring-light-constructed.json` is **not** a recording: no published fixture of a
Ring Light exists. It is a Key Light answer with the Ring Light's product name,
to check that a white light the integration does not know by name is handled
like a Key Light.
