// -----------------------------------------------------------------------------
// Scene action handlers (manifest `scene_actions`, Gladys 5.1+).
//
// On, off, brightness and temperature are already Gladys scene actions on the
// light features. These two add what only Elgato does, or does better in one
// request:
//   - identify: the light blinks (to find it, or as a silent signal: a
//     doorbell for someone streaming with headphones on);
//   - set_lighting: on, brightness and temperature at once, the "video call"
//     preset, without the light showing its previous setting first.
// Both take one or more lights: Key Lights often come in pairs. Every light
// is tried; the action fails only when none answered.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';

const logger = createLogger({ name: 'elgato-scenes' });

/** The chosen lights, as a list of external ids (one or several). */
function chosen(fields) {
  const value = fields?.devices;
  const list = Array.isArray(value) ? value : value ? [value] : [];
  const ids = [...new Set(list.filter((id) => typeof id === 'string' && id !== ''))];
  if (ids.length === 0) {
    throw new Error('Choose at least one Elgato light');
  }
  return ids;
}

async function onEach(fields, action) {
  const ids = chosen(fields);
  const failures = [];
  for (const id of ids) {
    try {
      await action(id);
    } catch (err) {
      failures.push(err.message);
    }
  }
  if (failures.length === ids.length) {
    throw new Error(failures.join('; '));
  }
  if (failures.length > 0) {
    logger.warn(`Scene action: ${failures.join('; ')}`);
  }
  return { reached: ids.length - failures.length };
}

export const SCENE_ACTIONS = {
  identify(hub, { fields }) {
    return onEach(fields, (id) => hub.identify(id));
  },

  set_lighting(hub, { fields }) {
    return onEach(fields, (id) =>
      hub.setLighting(id, { brightness: fields.brightness, temperature: fields.temperature }),
    );
  },
};
