# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Added

- One Gladys device per Elgato light (Key Light, Key Light Air, Key Light
  Mini, Ring Light, Light Strip), found automatically on the local network
  through Gladys (mDNS `_elg._tcp`), or by IP address. No account, no cloud.
- On/off, brightness and colour temperature (2900 to 7000 K) on every light;
  hue, saturation and a colour for the colour wheel on the Light Strip;
  battery level and charging on the Key Light Mini.
- Changes made from Elgato Control Center, a Stream Deck or the buttons of
  the light reach Gladys within the refresh interval (10 seconds by default,
  5 to 60). A light that stops answering is shown unreachable, and found
  again by its serial number when its address changes.
- Two scene actions on one or more lights: "Make Elgato lights blink", and
  "Set Elgato lights" (on, brightness and white in a single request, for a
  video call).
- Two buttons in the Configuration screen: "Search for Elgato lights" and
  "Make a light blink".
- Texts and documentation in English, French, German and Spanish.
- `scripts/probe.mjs`: a read-only check of a real light, safe to share.

[Unreleased]: https://github.com/guim31/gladys-elgato/commits/main
