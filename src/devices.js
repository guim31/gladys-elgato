// -----------------------------------------------------------------------------
// From an Elgato light to a Gladys device, and back: discovery payload, state
// values, and the body of the PUT /elgato/lights of each command.
//
// One Gladys device per light, keyed on its serial number. Every light gets
// on/off, brightness and colour temperature; a Light Strip also gets hue,
// saturation and a colour; a Key Light Mini its battery level and whether it
// is charging.
//
// Feature keys are part of the external ids: permanent.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as CATEGORIES,
  DEVICE_FEATURE_TYPES as TYPES,
  DEVICE_FEATURE_UNITS as UNITS,
} from '@gladysassistant/integration-sdk';
import {
  BATTERY_CHARGING,
  BRIGHTNESS_MAX,
  BRIGHTNESS_MIN,
  KELVIN_MAX,
  KELVIN_MIN,
  clamp,
  hsToRgbInt,
  kelvinToMired,
  miredToKelvin,
  rgbIntToHs,
} from './elgato/model.js';

export const DEVICE_TYPE = 'elgato';

export const FEATURE_KEYS = {
  POWER: 'power',
  BRIGHTNESS: 'brightness',
  TEMPERATURE: 'color-temperature',
  HUE: 'hue',
  SATURATION: 'saturation',
  COLOR: 'color',
  BATTERY: 'battery',
  CHARGING: 'charging',
};

// Feature names are frozen when the user creates the device: written in the
// language chosen in the configuration at that moment. The words are the ones
// of the Gladys light panel.
export const NAMES = {
  en: {
    power: 'Light',
    brightness: 'Brightness',
    'color-temperature': 'Color temperature',
    hue: 'Hue',
    saturation: 'Saturation',
    color: 'Color',
    battery: 'Battery',
    charging: 'Charging',
  },
  fr: {
    power: 'Éclairage',
    brightness: 'Luminosité',
    'color-temperature': 'Température de couleur',
    hue: 'Teinte',
    saturation: 'Saturation',
    color: 'Couleur',
    battery: 'Batterie',
    charging: 'En charge',
  },
  de: {
    power: 'Licht',
    brightness: 'Helligkeit',
    'color-temperature': 'Farbtemperatur',
    hue: 'Farbton',
    saturation: 'Sättigung',
    color: 'Farbe',
    battery: 'Akku',
    charging: 'Lädt',
  },
  es: {
    power: 'Luz',
    brightness: 'Brillo',
    'color-temperature': 'Temperatura de color',
    hue: 'Tono',
    saturation: 'Saturación',
    color: 'Color',
    battery: 'Batería',
    charging: 'Cargando',
  },
};

export const namesFor = (language) => NAMES[language] ?? NAMES.en;

/** External ids of the Gladys device of a light. */
export const deviceIds = (gladys, id) => gladys.externalIds(DEVICE_TYPE, id);

/**
 * Default name: the name given in the Elgato Control Center, else the product
 * and the end of the serial number. The user renames it in Gladys anyway.
 */
export function deviceName(record) {
  const { displayName, productName, serialNumber } = record.info;
  if (displayName && displayName !== productName) {
    return displayName.slice(0, 60);
  }
  const product = productName.startsWith('Elgato') ? productName : `Elgato ${productName}`;
  return `${product} ${serialNumber.slice(-4).toUpperCase()}`;
}

/**
 * Feature specs of a device, in publication order.
 * @param {object} caps capabilitiesOf() of the light
 * @param {string} language
 */
export function featureSpecs(caps, language) {
  const names = namesFor(language);
  const specs = [
    {
      key: FEATURE_KEYS.POWER,
      category: CATEGORIES.LIGHT,
      type: TYPES.LIGHT.BINARY,
      min: 0,
      max: 1,
      history: true,
    },
    {
      key: FEATURE_KEYS.BRIGHTNESS,
      category: CATEGORIES.LIGHT,
      type: TYPES.LIGHT.BRIGHTNESS,
      unit: UNITS.PERCENT,
      min: 0,
      max: 100,
      history: true,
    },
    {
      // In kelvins: the Gladys light panel reads the `kelvin` unit as a
      // physical scale, the history and the scenes show what the user knows.
      key: FEATURE_KEYS.TEMPERATURE,
      category: CATEGORIES.LIGHT,
      type: TYPES.LIGHT.TEMPERATURE,
      unit: UNITS.KELVIN,
      min: KELVIN_MIN,
      max: KELVIN_MAX,
      history: true,
    },
  ];
  if (caps.color) {
    specs.push(
      {
        key: FEATURE_KEYS.HUE,
        category: CATEGORIES.LIGHT,
        type: TYPES.LIGHT.HUE,
        min: 0,
        max: 360,
        history: false,
      },
      {
        key: FEATURE_KEYS.SATURATION,
        category: CATEGORIES.LIGHT,
        type: TYPES.LIGHT.SATURATION,
        unit: UNITS.PERCENT,
        min: 0,
        max: 100,
        history: false,
      },
      {
        // The colour wheel of the light panel; the strip shows it at the
        // brightness of the brightness feature.
        key: FEATURE_KEYS.COLOR,
        category: CATEGORIES.LIGHT,
        type: TYPES.LIGHT.COLOR,
        min: 0,
        max: 0xffffff,
        history: true,
      },
    );
  }
  if (caps.battery) {
    specs.push(
      {
        key: FEATURE_KEYS.BATTERY,
        category: CATEGORIES.BATTERY,
        type: TYPES.BATTERY.INTEGER,
        unit: UNITS.PERCENT,
        min: 0,
        max: 100,
        read_only: true,
        history: true,
      },
      {
        key: FEATURE_KEYS.CHARGING,
        category: CATEGORIES.BATTERY,
        type: TYPES.BATTERY.CHARGING,
        min: 0,
        max: 1,
        read_only: true,
        history: true,
      },
    );
  }
  return specs.map((spec) => ({ ...spec, name: names[spec.key] }));
}

/** Discovery payload of one light. */
export function buildDevice(gladys, record, language) {
  const ids = deviceIds(gladys, record.id);
  const { info } = record;
  return {
    name: deviceName(record),
    external_id: ids.device,
    model: info.productName,
    // The container reads every light itself at the configured pace: the
    // Gladys scheduler cannot be trusted with it (GladysAssistant/Gladys#3198).
    should_poll: false,
    params: [
      { name: 'IP_ADDRESS', value: record.host },
      ...(record.port !== 9123 ? [{ name: 'PORT', value: String(record.port) }] : []),
      { name: 'SERIAL_NUMBER', value: info.serialNumber },
      ...(info.firmwareVersion ? [{ name: 'FIRMWARE', value: info.firmwareVersion }] : []),
      ...(info.macAddress ? [{ name: 'MAC_ADDRESS', value: info.macAddress }] : []),
    ],
    features: featureSpecs(record.caps, language).map((spec) => {
      const feature = {
        name: spec.name,
        external_id: ids.feature(spec.key),
        category: spec.category,
        type: spec.type,
        min: spec.min,
        max: spec.max,
        read_only: spec.read_only === true,
        has_feedback: true,
        keep_history: spec.history,
      };
      if (spec.unit) {
        feature.unit = spec.unit;
      }
      return feature;
    }),
  };
}

const isNumber = (value) => typeof value === 'number' && Number.isFinite(value);

/** True when the light shows a colour (hue and saturation), false for a white. */
export function inColorMode(record) {
  return record.caps.color && isNumber(record.state?.hue);
}

/**
 * Feature values of a device, by feature key. Only what the last reading
 * told: a strip in white mode has no hue, one in colour mode no temperature.
 */
export function deviceValues(record) {
  const state = record.state ?? {};
  const values = {};
  if (isNumber(state.on)) {
    values[FEATURE_KEYS.POWER] = state.on > 0 ? 1 : 0;
  }
  if (isNumber(state.brightness)) {
    values[FEATURE_KEYS.BRIGHTNESS] = clamp(Math.round(state.brightness), 0, 100);
  }
  if (inColorMode(record)) {
    const hue = clamp(Math.round(state.hue), 0, 360);
    const saturation = clamp(Math.round(isNumber(state.saturation) ? state.saturation : 0), 0, 100);
    values[FEATURE_KEYS.HUE] = hue;
    values[FEATURE_KEYS.SATURATION] = saturation;
    // The colour Gladys sent, while the strip still shows it: the conversion
    // to hue and saturation is not exactly reversible.
    const sent = record.sentColor;
    values[FEATURE_KEYS.COLOR] =
      sent && sent.hue === hue && sent.saturation === saturation
        ? sent.value
        : hsToRgbInt(hue, saturation);
  } else if (isNumber(state.temperature) && state.temperature > 0) {
    const mired = Math.round(state.temperature);
    const sent = record.sentKelvin;
    // Same for the kelvins: 4500 K is mired 222, read back as 4500, not 4500 ± 10.
    values[FEATURE_KEYS.TEMPERATURE] =
      sent && sent.mired === mired ? sent.value : miredToKelvin(mired);
  }
  if (record.caps.battery && record.battery) {
    if (isNumber(record.battery.level)) {
      values[FEATURE_KEYS.BATTERY] = clamp(Math.round(record.battery.level), 0, 100);
    }
    if (isNumber(record.battery.status)) {
      values[FEATURE_KEYS.CHARGING] = record.battery.status === BATTERY_CHARGING ? 1 : 0;
    }
  }
  return values;
}

/**
 * The body of the PUT /elgato/lights of a Gladys command, with what Gladys
 * must remember of it (`sentKelvin`, `sentColor`). Like the other Gladys
 * lights, a brightness, a temperature or a colour also turns the light on;
 * a brightness of 0 turns it off.
 * @param {object} record the light (caps, state)
 * @param {string} key feature key
 * @param {number|string} value
 */
export function commandFor(record, key, value) {
  const number = Number(value);
  const state = record.state ?? {};
  if (!Number.isFinite(number)) {
    throw new Error(`Invalid value "${value}" for ${key}`);
  }
  switch (key) {
    case FEATURE_KEYS.POWER:
      return { light: { on: number > 0 ? 1 : 0 } };

    case FEATURE_KEYS.BRIGHTNESS: {
      if (!(number > 0)) {
        return { light: { on: 0 } };
      }
      const light = {
        on: 1,
        brightness: clamp(Math.round(number), BRIGHTNESS_MIN, BRIGHTNESS_MAX),
      };
      // A Light Strip in white mode given a brightness alone jumps back to its
      // last colour (Home Assistant resends the temperature for this reason).
      if (record.caps.color && !inColorMode(record) && isNumber(state.temperature)) {
        light.temperature = Math.round(state.temperature);
      }
      return { light };
    }

    case FEATURE_KEYS.TEMPERATURE: {
      const kelvin = clamp(Math.round(number), KELVIN_MIN, KELVIN_MAX);
      const mired = kelvinToMired(kelvin);
      return { light: { on: 1, temperature: mired }, sentKelvin: { mired, value: kelvin } };
    }

    case FEATURE_KEYS.HUE:
    case FEATURE_KEYS.SATURATION:
    case FEATURE_KEYS.COLOR: {
      if (!record.caps.color) {
        break;
      }
      let hue;
      let saturation;
      let sentColor = null;
      if (key === FEATURE_KEYS.COLOR) {
        ({ hue, saturation } = rgbIntToHs(number));
        sentColor = { hue, saturation, value: clamp(Math.round(number), 0, 0xffffff) };
      } else {
        // The other half of the colour: the current one, else a full colour
        // (a strip in white mode has no hue, and saturation 0 is white).
        const current = inColorMode(record);
        hue =
          key === FEATURE_KEYS.HUE
            ? clamp(Math.round(number), 0, 360)
            : current
              ? Math.round(state.hue)
              : 0;
        saturation =
          key === FEATURE_KEYS.SATURATION
            ? clamp(Math.round(number), 0, 100)
            : current && isNumber(state.saturation)
              ? Math.round(state.saturation)
              : 100;
      }
      return { light: { on: 1, hue, saturation }, sentColor };
    }

    default:
      break;
  }
  throw new Error(`Feature "${key}" cannot be set on this Elgato light`);
}

/**
 * What the light shows once a PUT is applied, without waiting for the next
 * reading: a temperature clears the colour, a colour the temperature.
 */
export function applyCommand(state, light) {
  const next = { ...state, ...light };
  if (light.temperature !== undefined && light.hue === undefined) {
    delete next.hue;
    delete next.saturation;
  }
  if (light.hue !== undefined) {
    delete next.temperature;
  }
  return next;
}
