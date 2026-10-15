// -----------------------------------------------------------------------------
// What an Elgato light can do, and the conversions between its units and the
// ones Gladys shows.
//
// - Colour temperature: the API speaks mireds, 143 to 344 (python-elgato
//   refuses anything else), i.e. about 7000 K to 2900 K. Gladys gets kelvins
//   (unit `kelvin`), which its light panel and the history read as such.
// - Colour (Light Strip): the API speaks hue (0-360) and saturation (0-100),
//   brightness apart. Gladys gets the two, and an RGB colour at full value for
//   the colour wheel.
// -----------------------------------------------------------------------------

export const MIRED_MIN = 143;
export const MIRED_MAX = 344;
// The kelvin range shown in Gladys: the mired range, rounded outwards.
export const KELVIN_MIN = 2900;
export const KELVIN_MAX = 7000;

export const BRIGHTNESS_MIN = 1;
export const BRIGHTNESS_MAX = 100;

// `status` of /elgato/battery-info (python-elgato BatteryStatus).
export const BATTERY_CHARGING = 2;

const COLOR_PRODUCTS = ['elgato light strip'];

export const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

const isNumber = (value) => typeof value === 'number' && Number.isFinite(value);

/** The parts of /elgato/accessory-info the integration keeps (never the Wi-Fi network). */
export function pickInfo(info) {
  const source = info && typeof info === 'object' ? info : {};
  const text = (value) => (typeof value === 'string' ? value.trim() : '');
  return {
    productName: text(source.productName) || 'Elgato Light',
    serialNumber: text(source.serialNumber),
    firmwareVersion: text(source.firmwareVersion) || null,
    firmwareBuildNumber: isNumber(source.firmwareBuildNumber) ? source.firmwareBuildNumber : null,
    hardwareBoardType: isNumber(source.hardwareBoardType) ? source.hardwareBoardType : null,
    displayName: text(source.displayName),
    macAddress: normalizeMac(source.macAddress),
  };
}

/** `aa:bb:cc:dd:ee:ff`, or null. */
export function normalizeMac(raw) {
  if (typeof raw !== 'string') {
    return null;
  }
  const hex = raw.toLowerCase().replace(/[^0-9a-f]/g, '');
  return hex.length === 12 ? hex.match(/../g).join(':') : null;
}

/**
 * The stable id of a light: its serial number (Home Assistant keys its
 * entries on it too), lowercased, letters and digits only. Null without one.
 */
export function platformId(info) {
  const id = String(info?.serialNumber ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
  return id.length >= 4 ? id : null;
}

/**
 * Capabilities of a light, from its three first answers. Colour like Home
 * Assistant decides it: a Light Strip by name, or a light whose settings or
 * state carry a hue.
 */
export function capabilitiesOf({ info, settings, state }) {
  const product = (info?.productName ?? '').toLowerCase();
  const color =
    COLOR_PRODUCTS.some((name) => product.startsWith(name)) ||
    isNumber(settings?.powerOnHue) ||
    isNumber(state?.hue);
  return {
    color,
    battery: Boolean(settings?.battery && typeof settings.battery === 'object'),
  };
}

/** Mireds to kelvins, rounded to 10 K (the steps of the API are coarser near 7000 K). */
export function miredToKelvin(mired) {
  return clamp(Math.round(1_000_000 / mired / 10) * 10, KELVIN_MIN, KELVIN_MAX);
}

/** Kelvins to the nearest mired value the API accepts. */
export function kelvinToMired(kelvin) {
  return clamp(Math.round(1_000_000 / kelvin), MIRED_MIN, MIRED_MAX);
}

/** Hue (0-360) and saturation (0-100) at full value, as a 0xRRGGBB integer. */
export function hsToRgbInt(hue, saturation) {
  const h = (((hue % 360) + 360) % 360) / 60;
  const s = clamp(saturation, 0, 100) / 100;
  const chroma = s;
  const x = chroma * (1 - Math.abs((h % 2) - 1));
  const m = 1 - chroma;
  const [r, g, b] =
    h < 1
      ? [chroma, x, 0]
      : h < 2
        ? [x, chroma, 0]
        : h < 3
          ? [0, chroma, x]
          : h < 4
            ? [0, x, chroma]
            : h < 5
              ? [x, 0, chroma]
              : [chroma, 0, x];
  const byte = (channel) => Math.round((channel + m) * 255);
  return (byte(r) << 16) | (byte(g) << 8) | byte(b);
}

/** A 0xRRGGBB integer to hue (0-360) and saturation (0-100); the value goes to brightness. */
export function rgbIntToHs(value) {
  const color = clamp(Math.round(Number(value) || 0), 0, 0xffffff);
  const r = ((color >> 16) & 0xff) / 255;
  const g = ((color >> 8) & 0xff) / 255;
  const b = (color & 0xff) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  let hue = 0;
  if (delta > 0) {
    if (max === r) {
      hue = 60 * (((g - b) / delta) % 6);
    } else if (max === g) {
      hue = 60 * ((b - r) / delta + 2);
    } else {
      hue = 60 * ((r - g) / delta + 4);
    }
  }
  return {
    hue: Math.round((hue + 360) % 360),
    saturation: max === 0 ? 0 : Math.round((delta / max) * 100),
  };
}
