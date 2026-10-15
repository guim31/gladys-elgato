// -----------------------------------------------------------------------------
// Texts the integration sends to Gladys: connection status and the messages
// of the Configuration screen's buttons. Four languages, the four of the
// Gladys interface; German says "du", Spanish "usted".
// test/i18n.test.js checks every table.
// -----------------------------------------------------------------------------

export const INIT_FAILED = {
  en: 'Initialization failed, check the integration logs.',
  fr: "L'initialisation a échoué, consultez les logs de l'intégration.",
  de: 'Initialisierung fehlgeschlagen, sieh dir die Protokolle der Integration an.',
  es: 'La inicialización ha fallado, consulte los registros de la integración.',
};

// Shown by Gladys under the integration name when it is not connected.
export const CONNECTION_TEXT = {
  noDevice: {
    en: 'No Elgato light found. Check that it is on the same network as Gladys, or enter its IP address.',
    fr: "Aucune lampe Elgato trouvée. Vérifiez qu'elle est sur le même réseau que Gladys, ou saisissez son adresse IP.",
    de: 'Keine Elgato-Leuchte gefunden. Prüfe, ob sie im selben Netzwerk wie Gladys ist, oder gib ihre IP-Adresse ein.',
    es: 'No se ha encontrado ninguna luz Elgato. Compruebe que está en la misma red que Gladys o introduzca su dirección IP.',
  },
  noAnswer: {
    en: 'No Elgato light answers.',
    fr: 'Aucune lampe Elgato ne répond.',
    de: 'Keine Elgato-Leuchte antwortet.',
    es: 'Ninguna luz Elgato responde.',
  },
};

const MAX_LISTED = 8;

// The pieces of the "Search for Elgato lights" report, one table per language.
export const SEARCH_TEXT = {
  en: {
    none: 'No Elgato light found.',
    count: (total, reachable) => `${total} light(s), ${reachable} answering:`,
    unreachable: 'not answering',
    unavailable:
      'Automatic discovery through Gladys is unavailable (Gladys 5.1 or later needed): enter the IP addresses.',
    busy: 'Another search is running: try again in a few seconds.',
    ignored: (list) => `Ignored addresses: ${list}.`,
  },
  fr: {
    none: 'Aucune lampe Elgato trouvée.',
    count: (total, reachable) => `${total} lampe(s), ${reachable} répondent :`,
    unreachable: 'ne répond pas',
    unavailable:
      'La découverte automatique par Gladys est indisponible (Gladys 5.1 ou plus récent) : saisissez les adresses IP.',
    busy: 'Une autre recherche est en cours : réessayez dans quelques secondes.',
    ignored: (list) => `Adresses ignorées : ${list}.`,
  },
  de: {
    none: 'Keine Elgato-Leuchte gefunden.',
    count: (total, reachable) => `${total} Leuchte(n), davon ${reachable} erreichbar:`,
    unreachable: 'antwortet nicht',
    unavailable:
      'Die automatische Erkennung über Gladys ist nicht verfügbar (Gladys 5.1 oder neuer nötig): Gib die IP-Adressen ein.',
    busy: 'Gerade läuft eine andere Suche: Versuch es in ein paar Sekunden noch einmal.',
    ignored: (list) => `Ignorierte Adressen: ${list}.`,
  },
  es: {
    none: 'No se ha encontrado ninguna luz Elgato.',
    count: (total, reachable) => `${total} luz/luces, ${reachable} responden:`,
    unreachable: 'no responde',
    unavailable:
      'El descubrimiento automático a través de Gladys no está disponible (se necesita Gladys 5.1 o posterior): introduzca las direcciones IP.',
    busy: 'Hay otra búsqueda en curso: inténtelo de nuevo dentro de unos segundos.',
    ignored: (list) => `Direcciones ignoradas: ${list}.`,
  },
};

// The answers of the "Make a light blink" button.
export const IDENTIFY_TEXT = {
  en: {
    done: (name) => `${name} blinks.`,
    unreachable: (name) => `${name} does not answer: is it switched on and connected to the Wi-Fi?`,
    unknown: 'This light is not known (yet): run a search first.',
  },
  fr: {
    done: (name) => `${name} clignote.`,
    unreachable: (name) => `${name} ne répond pas : est-elle allumée et connectée au Wi-Fi ?`,
    unknown: "Cette lampe n'est pas (encore) connue : lancez d'abord une recherche.",
  },
  de: {
    done: (name) => `${name} blinkt.`,
    unreachable: (name) =>
      `${name} antwortet nicht: Ist sie eingeschaltet und mit dem WLAN verbunden?`,
    unknown: 'Diese Leuchte ist (noch) nicht bekannt: Starte zuerst eine Suche.',
  },
  es: {
    done: (name) => `${name} parpadea.`,
    unreachable: (name) => `${name} no responde: ¿está encendida y conectada al Wi-Fi?`,
    unknown: 'Esta luz no es conocida (todavía): realice primero una búsqueda.',
  },
};

/** One message of a table, in every language. */
export function localized(table, key, ...args) {
  return Object.fromEntries(
    Object.entries(table).map(([language, texts]) => {
      const text = texts[key];
      return [language, typeof text === 'function' ? text(...args) : text];
    }),
  );
}

/** The report shown under the "Search" button, in every language. */
export function searchMessage(summary) {
  return Object.fromEntries(
    Object.entries(SEARCH_TEXT).map(([language, text]) => [language, searchReport(summary, text)]),
  );
}

function searchReport({ devices, scan, invalidHosts }, text) {
  const lines = [];
  if (devices.length === 0) {
    lines.push(text.none);
  } else {
    const reachable = devices.filter((device) => device.reachable).length;
    lines.push(text.count(devices.length, reachable));
    // The first ones: the message stays readable under the button.
    const list = devices
      .slice(0, MAX_LISTED)
      .map(
        ({ name, host, product, reachable: up }) =>
          `${name} (${host}${product && !name.includes(product) ? `, ${product}` : ''}${up ? '' : `, ${text.unreachable}`})`,
      );
    lines.push(`${list.join(', ')}${devices.length > MAX_LISTED ? '…' : '.'}`);
  }
  if (scan === 'unavailable') {
    lines.push(text.unavailable);
  } else if (scan === 'busy') {
    lines.push(text.busy);
  }
  if (invalidHosts.length > 0) {
    lines.push(text.ignored(invalidHosts.slice(0, 3).join(', ')));
  }
  return lines.join(' ');
}
