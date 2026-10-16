// -----------------------------------------------------------------------------
// Every text the code shows to the user, in the four languages of the Gladys
// interface (en, fr, de, es). German says "du", Spanish says "usted".
// test/i18n.test.js checks that each one exists in all four, is not empty
// and fits where it is shown, and that no other source file writes a text.
//
// Vocabulary taken from the Gladys interface (front/src/config/i18n):
// Netzleistung (Bezug +, Einspeisung −), Ladestand; potencia de la red
// (importación +, exportación −), nivel de batería. Brand and product names
// (Kostal, PLENTICORE, PIKO) are not translated.
// -----------------------------------------------------------------------------

export const LANGUAGES = ['en', 'fr', 'de', 'es'];

/** The text of one language, English when it is missing. */
export function pick(text, language) {
  return text[language] ?? text.en;
}

/** A multi-language object built by one function per language. */
export function localize(build) {
  return Object.fromEntries(LANGUAGES.map((language) => [language, build(language)]));
}

/** Decimal number in the conventions of a language, without thousands separator. */
export function formatNumber(value, digits, language) {
  const text = Number(value).toFixed(digits);
  return language === 'en' ? text : text.replace('.', ',');
}

/** A percentage as written in a language ("42%" in English, "42 %" otherwise). */
export function formatPercent(value, language) {
  return language === 'en' ? `${Math.round(value)}%` : `${Math.round(value)} %`;
}

// --- Device and feature names (frozen by Gladys when the device is created) ---

export const DEVICE_NAMES = {
  inverter: {
    en: 'Kostal inverter',
    fr: 'Onduleur Kostal',
    de: 'Kostal-Wechselrichter',
    es: 'Inversor Kostal',
  },
};

export const FEATURE_NAMES = {
  pvPower: {
    en: 'Solar production',
    fr: 'Production solaire',
    de: 'Solarproduktion',
    es: 'Producción solar',
  },
  stringPower: (n) => ({
    en: `PV string ${n}`,
    fr: `Chaîne PV ${n}`,
    de: `PV-String ${n}`,
    es: `Cadena FV ${n}`,
  }),
  acPower: {
    en: 'Inverter AC output',
    fr: "Sortie AC de l'onduleur",
    de: 'AC-Leistung des Wechselrichters',
    es: 'Salida CA del inversor',
  },
  homePower: {
    en: 'House consumption',
    fr: 'Consommation de la maison',
    de: 'Hausverbrauch',
    es: 'Consumo de la casa',
  },
  gridPower: {
    en: 'Grid (import +, export −)',
    fr: 'Réseau (soutirage +, injection −)',
    de: 'Netz (Bezug +, Einspeisung −)',
    es: 'Red (importación +, exportación −)',
  },
  batteryLevel: {
    en: 'Battery level',
    fr: 'Niveau de la batterie',
    de: 'Ladestand der Batterie',
    es: 'Nivel de batería',
  },
  batteryCharge: {
    en: 'Battery charging',
    fr: 'Charge de la batterie',
    de: 'Batterieladung',
    es: 'Carga de la batería',
  },
  batteryDischarge: {
    en: 'Battery discharging',
    fr: 'Décharge de la batterie',
    de: 'Batterieentladung',
    es: 'Descarga de la batería',
  },
  batteryCycles: {
    en: 'Battery cycles',
    fr: 'Cycles de la batterie',
    de: 'Batteriezyklen',
    es: 'Ciclos de la batería',
  },
  productionToday: {
    en: 'Production today',
    fr: 'Production du jour',
    de: 'Produktion heute',
    es: 'Producción de hoy',
  },
  productionTotal: {
    en: 'Total production',
    fr: 'Production totale',
    de: 'Gesamtproduktion',
    es: 'Producción total',
  },
  homeGridTotal: {
    en: 'House from the grid (total)',
    fr: 'Maison depuis le réseau (total)',
    de: 'Haus aus dem Netz (gesamt)',
    es: 'Casa desde la red (total)',
  },
  exportTotal: {
    en: 'Grid export (total)',
    fr: 'Injection dans le réseau (total)',
    de: 'Einspeisung (gesamt)',
    es: 'Exportación a la red (total)',
  },
  chargeTotal: {
    en: 'Energy charged (total)',
    fr: 'Énergie chargée (total)',
    de: 'Geladene Energie (gesamt)',
    es: 'Energía cargada (total)',
  },
  dischargeTotal: {
    en: 'Energy discharged (total)',
    fr: 'Énergie déchargée (total)',
    de: 'Entladene Energie (gesamt)',
    es: 'Energía descargada (total)',
  },
  inverterState: {
    en: 'Inverter state',
    fr: "État de l'onduleur",
    de: 'Wechselrichterstatus',
    es: 'Estado del inversor',
  },
  activeAlarms: {
    en: 'Active alarms',
    fr: 'Alarmes actives',
    de: 'Aktive Alarme',
    es: 'Alarmas activas',
  },
  alarmText: {
    en: 'Latest alarm',
    fr: 'Dernière alarme',
    de: 'Letzter Alarm',
    es: 'Última alarma',
  },
};

// --- Text states ------------------------------------------------------------------

// Inverter:State codes (Home Assistant helper, from the Kostal documentation).
export const INVERTER_STATES = {
  0: { en: 'Off', fr: 'Éteint', de: 'Aus', es: 'Apagado' },
  1: { en: 'Initialising', fr: 'Initialisation', de: 'Initialisierung', es: 'Inicialización' },
  2: {
    en: 'Insulation check',
    fr: "Mesure d'isolement",
    de: 'Isolationsmessung',
    es: 'Medición de aislamiento',
  },
  3: { en: 'Grid check', fr: 'Contrôle du réseau', de: 'Netzprüfung', es: 'Comprobación de red' },
  4: { en: 'Starting', fr: 'Démarrage', de: 'Startet', es: 'Arrancando' },
  6: { en: 'Feeding in', fr: 'En production', de: 'Speist ein', es: 'Produciendo' },
  7: { en: 'Throttled', fr: 'Bridé', de: 'Abgeregelt', es: 'Limitado' },
  8: {
    en: 'External switch-off',
    fr: 'Arrêt externe',
    de: 'Externe Abschaltung',
    es: 'Desconexión externa',
  },
  9: { en: 'Updating', fr: 'Mise à jour', de: 'Aktualisierung', es: 'Actualizando' },
  10: { en: 'Standby', fr: 'Veille', de: 'Standby', es: 'En espera' },
  11: {
    en: 'Grid synchronisation',
    fr: 'Synchronisation réseau',
    de: 'Netzsynchronisation',
    es: 'Sincronización de red',
  },
  12: {
    en: 'Grid pre-check',
    fr: 'Pré-contrôle du réseau',
    de: 'Netzvorprüfung',
    es: 'Comprobación previa de red',
  },
  13: {
    en: 'Grid switch-off',
    fr: 'Déconnexion du réseau',
    de: 'Netztrennung',
    es: 'Desconexión de la red',
  },
  14: { en: 'Overheating', fr: 'Surchauffe', de: 'Überhitzung', es: 'Sobrecalentamiento' },
  15: { en: 'Shutting down', fr: 'Arrêt en cours', de: 'Fährt herunter', es: 'Apagándose' },
  16: {
    en: 'Improper DC voltage',
    fr: 'Tension DC incorrecte',
    de: 'Unzulässige DC-Spannung',
    es: 'Tensión CC incorrecta',
  },
  17: {
    en: 'Emergency power',
    fr: 'Alimentation de secours',
    de: 'Notstrombetrieb',
    es: 'Alimentación de emergencia',
  },
  18: { en: 'DC check', fr: 'Contrôle DC', de: 'DC-Prüfung', es: 'Comprobación CC' },
};

/** The text of an inverter state code, the code itself when unknown. */
export function inverterStateText(code) {
  return (
    INVERTER_STATES[code] ??
    localize((language) => `${pick(TEXTS.unknownState, language)} (${code})`)
  );
}

export const TEXTS = {
  unknownState: {
    en: 'Unknown state',
    fr: 'État inconnu',
    de: 'Unbekannter Status',
    es: 'Estado desconocido',
  },
  noAlarm: { en: 'No alarm', fr: 'Aucune alarme', de: 'Kein Alarm', es: 'Sin alarmas' },
  alarmPending: {
    en: 'Alarm in progress',
    fr: 'Alarme en cours',
    de: 'Alarm aktiv',
    es: 'Alarma en curso',
  },
  alarmCode: (code) => ({
    en: `Alarm ${code}`,
    fr: `Alarme ${code}`,
    de: `Alarm ${code}`,
    es: `Alarma ${code}`,
  }),
};

// --- Configuration screen: connection status and the action ------------------------

export const MESSAGES = {
  notConfigured: {
    en: 'Enter the address of the inverter and its plant owner password, then save.',
    fr: "Saisissez l'adresse de l'onduleur et son mot de passe propriétaire, puis enregistrez.",
    de: 'Gib die Adresse des Wechselrichters und das Anlagenbetreiber-Passwort ein und speichere.',
    es: 'Introduzca la dirección del inversor y su contraseña de propietario y guarde.',
  },
  invalidHost: {
    en: 'This address is not valid: enter an IP address such as 192.0.2.20, or a host name.',
    fr: "Cette adresse n'est pas valide : saisissez une adresse IP comme 192.0.2.20, ou un nom d'hôte.",
    de: 'Diese Adresse ist ungültig: Gib eine IP-Adresse wie 192.0.2.20 oder einen Hostnamen ein.',
    es: 'Esta dirección no es válida: introduzca una dirección IP como 192.0.2.20 o un nombre de host.',
  },
  unreachable: (reason) => ({
    en: `The inverter does not answer (${reason}). Check its address and that it is on the network.`,
    fr: `L'onduleur ne répond pas (${reason}). Vérifiez son adresse et qu'il est bien sur le réseau.`,
    de: `Der Wechselrichter antwortet nicht (${reason}). Prüfe seine Adresse und ob er im Netzwerk ist.`,
    es: `El inversor no responde (${reason}). Compruebe su dirección y que esté en la red.`,
  }),
  authFailed: {
    en: 'The inverter refused the password. Enter the plant owner password of its web interface. Next try in 15 minutes, or when you save the configuration.',
    fr: "L'onduleur a refusé le mot de passe. Saisissez le mot de passe propriétaire de son interface web. Nouvel essai dans 15 minutes, ou dès que vous enregistrez la configuration.",
    de: 'Der Wechselrichter hat das Passwort abgelehnt. Gib das Anlagenbetreiber-Passwort seiner Weboberfläche ein. Neuer Versuch in 15 Minuten oder sobald du die Konfiguration speicherst.',
    es: 'El inversor ha rechazado la contraseña. Introduzca la contraseña de propietario de su interfaz web. Nuevo intento en 15 minutos, o cuando guarde la configuración.',
  },
  locked: {
    en: 'The inverter locked the plant owner account after failed logins. Wait until it unlocks (see its web interface), then save the configuration again.',
    fr: "L'onduleur a bloqué le compte propriétaire après des connexions refusées. Attendez son déblocage (voir son interface web), puis enregistrez à nouveau la configuration.",
    de: 'Der Wechselrichter hat das Anlagenbetreiber-Konto nach fehlgeschlagenen Anmeldungen gesperrt. Warte, bis es entsperrt ist (siehe Weboberfläche), und speichere die Konfiguration dann erneut.',
    es: 'El inversor ha bloqueado la cuenta de propietario tras inicios de sesión fallidos. Espere a que se desbloquee (vea su interfaz web) y vuelva a guardar la configuración.',
  },
  noSerial: {
    en: 'The inverter answers but gives no serial number: this model is not supported yet.',
    fr: "L'onduleur répond mais ne donne pas de numéro de série : ce modèle n'est pas encore pris en charge.",
    de: 'Der Wechselrichter antwortet, liefert aber keine Seriennummer: Dieses Modell wird noch nicht unterstützt.',
    es: 'El inversor responde pero no da número de serie: este modelo aún no es compatible.',
  },
  publishFailed: (reason) => ({
    en: `Gladys refused the inverter device (${reason}). See the integration logs.`,
    fr: `Gladys a refusé l'appareil onduleur (${reason}). Consultez les journaux de l'intégration.`,
    de: `Gladys hat das Wechselrichter-Gerät abgelehnt (${reason}). Sieh in den Protokollen der Integration nach.`,
    es: `Gladys ha rechazado el dispositivo inversor (${reason}). Consulte los registros de la integración.`,
  }),
  /**
   * Result of the connection test.
   * @param {{ model: string, firmware: string|null, strings: number, battery: boolean, settings: string }} found
   */
  found: ({ model, firmware, strings, battery, settings }) => {
    const parts = {
      en: [`${model} found`, `${strings} PV string(s)`, battery ? 'battery' : 'no battery'],
      fr: [`${model} trouvé`, `${strings} chaîne(s) PV`, battery ? 'batterie' : 'sans batterie'],
      de: [`${model} gefunden`, `${strings} PV-String(s)`, battery ? 'Batterie' : 'ohne Batterie'],
      es: [`${model} encontrado`, `${strings} cadena(s) FV`, battery ? 'batería' : 'sin batería'],
    };
    const firmwareLabel = { en: 'firmware', fr: 'firmware', de: 'Firmware', es: 'firmware' };
    return localize((language) => {
      const list = [...parts[language]];
      if (firmware) list.push(`${firmwareLabel[language]} ${firmware}`);
      return `${list.join(', ')}. ${pick(SETTINGS_STATUS[settings], language)}`;
    });
  },
};

// What the connection test says about the battery settings.
export const SETTINGS_STATUS = {
  disabled: {
    en: 'Battery settings: not allowed in the configuration.',
    fr: 'Réglages de la batterie : non autorisés dans la configuration.',
    de: 'Batterieeinstellungen: in der Konfiguration nicht erlaubt.',
    es: 'Ajustes de la batería: no permitidos en la configuración.',
  },
  writable: {
    en: 'Battery settings: writable with this password.',
    fr: 'Réglages de la batterie : modifiables avec ce mot de passe.',
    de: 'Batterieeinstellungen: mit diesem Passwort änderbar.',
    es: 'Ajustes de la batería: modificables con esta contraseña.',
  },
  readOnly: {
    en: 'Battery settings: read-only for the plant owner on this inverter.',
    fr: 'Réglages de la batterie : en lecture seule pour le propriétaire sur cet onduleur.',
    de: 'Batterieeinstellungen: für den Anlagenbetreiber auf diesem Wechselrichter nur lesbar.',
    es: 'Ajustes de la batería: solo lectura para el propietario en este inversor.',
  },
  none: {
    en: 'Battery settings: none on this inverter.',
    fr: 'Réglages de la batterie : aucun sur cet onduleur.',
    de: 'Batterieeinstellungen: keine auf diesem Wechselrichter.',
    es: 'Ajustes de la batería: ninguno en este inversor.',
  },
};

// --- Scene actions: errors shown in the scene logs (the configured language) ---

export const SCENE_ERRORS = {
  notAllowed: {
    en: 'Battery settings are not allowed: enable them in the Kostal configuration.',
    fr: 'Les réglages de la batterie ne sont pas autorisés : activez-les dans la configuration Kostal.',
    de: 'Batterieeinstellungen sind nicht erlaubt: Aktiviere sie in der Kostal-Konfiguration.',
    es: 'Los ajustes de la batería no están permitidos: actívelos en la configuración de Kostal.',
  },
  notReady: {
    en: 'The inverter is not connected yet.',
    fr: "L'onduleur n'est pas encore connecté.",
    de: 'Der Wechselrichter ist noch nicht verbunden.',
    es: 'El inversor aún no está conectado.',
  },
  unavailable: {
    en: 'This inverter does not let the plant owner change this setting.',
    fr: 'Cet onduleur ne permet pas au propriétaire de modifier ce réglage.',
    de: 'Dieser Wechselrichter erlaubt dem Anlagenbetreiber nicht, diese Einstellung zu ändern.',
    es: 'Este inversor no permite al propietario cambiar este ajuste.',
  },
  outOfRange: (min, max) => ({
    en: `The minimum state of charge must be between ${min} and ${max} %.`,
    fr: `Le seuil de décharge minimal doit être compris entre ${min} et ${max} %.`,
    de: `Der minimale Ladestand muss zwischen ${min} und ${max} % liegen.`,
    es: `El estado de carga mínimo debe estar entre ${min} y ${max} %.`,
  }),
  refused: (reason) => ({
    en: `The inverter refused the setting (${reason}).`,
    fr: `L'onduleur a refusé le réglage (${reason}).`,
    de: `Der Wechselrichter hat die Einstellung abgelehnt (${reason}).`,
    es: `El inversor ha rechazado el ajuste (${reason}).`,
  }),
};

// --- Widget ------------------------------------------------------------------------

export const WIDGET_TEXT = {
  solar: { en: 'Solar', fr: 'Solaire', de: 'Solar', es: 'Solar' },
  house: { en: 'House', fr: 'Maison', de: 'Haus', es: 'Casa' },
  grid: { en: 'Grid', fr: 'Réseau', de: 'Netz', es: 'Red' },
  battery: { en: 'Battery', fr: 'Batterie', de: 'Batterie', es: 'Batería' },
  today: { en: 'Today', fr: "Aujourd'hui", de: 'Heute', es: 'Hoy' },
  chartTitle: {
    en: 'Production and consumption',
    fr: 'Production et consommation',
    de: 'Produktion und Verbrauch',
    es: 'Producción y consumo',
  },
  gridFlow: { en: 'Grid', fr: 'Réseau', de: 'Netz', es: 'Red' },
  importing: { en: 'Import', fr: 'Soutirage', de: 'Bezug', es: 'Importación' },
  exporting: { en: 'Export', fr: 'Injection', de: 'Einspeisung', es: 'Exportación' },
  balanced: { en: 'Balanced', fr: 'Équilibré', de: 'Ausgeglichen', es: 'Equilibrado' },
  batteryFlow: { en: 'Battery', fr: 'Batterie', de: 'Batterie', es: 'Batería' },
  charging: { en: 'Charging', fr: 'En charge', de: 'Lädt', es: 'Cargando' },
  discharging: { en: 'Discharging', fr: 'En décharge', de: 'Entlädt', es: 'Descargando' },
  idle: { en: 'Idle', fr: 'Au repos', de: 'Ruht', es: 'En reposo' },
  inverter: { en: 'Inverter', fr: 'Onduleur', de: 'Wechselrichter', es: 'Inversor' },
  alarms: { en: 'Alarms', fr: 'Alarmes', de: 'Alarme', es: 'Alarmas' },
  autarky: {
    en: 'Autarky today',
    fr: 'Autonomie du jour',
    de: 'Autarkie heute',
    es: 'Autarquía de hoy',
  },
  ownConsumption: {
    en: 'Self-consumption today',
    fr: 'Autoconsommation du jour',
    de: 'Eigenverbrauch heute',
    es: 'Autoconsumo de hoy',
  },
  houseToday: {
    en: 'House today',
    fr: "Maison aujourd'hui",
    de: 'Haus heute',
    es: 'Casa hoy',
  },
  minSoc: {
    en: 'Discharge limit',
    fr: 'Seuil de décharge',
    de: 'Entladegrenze',
    es: 'Límite de descarga',
  },
  smartControl: {
    en: 'Smart battery control',
    fr: 'Gestion intelligente',
    de: 'Intelligente Steuerung',
    es: 'Control inteligente',
  },
  on: { en: 'On', fr: 'Activée', de: 'An', es: 'Activado' },
  off: { en: 'Off', fr: 'Désactivée', de: 'Aus', es: 'Desactivado' },
  updated: { en: 'Updated', fr: 'Mis à jour', de: 'Aktualisiert', es: 'Actualizado' },
};

export const WIDGET_MESSAGES = {
  notConfigured: {
    en: 'Enter the address and the plant owner password of your Kostal inverter in the integration configuration.',
    fr: "Saisissez l'adresse et le mot de passe propriétaire de votre onduleur Kostal dans la configuration de l'intégration.",
    de: 'Gib die Adresse und das Anlagenbetreiber-Passwort deines Kostal-Wechselrichters in der Konfiguration der Integration ein.',
    es: 'Introduzca la dirección y la contraseña de propietario de su inversor Kostal en la configuración de la integración.',
  },
  noData: {
    en: 'No reading from the inverter yet: check the connection status in the integration configuration.',
    fr: "Aucune lecture de l'onduleur pour l'instant : vérifiez l'état de la connexion dans la configuration de l'intégration.",
    de: 'Noch keine Werte vom Wechselrichter: Prüfe den Verbindungsstatus in der Konfiguration der Integration.',
    es: 'Aún no hay lecturas del inversor: compruebe el estado de la conexión en la configuración de la integración.',
  },
};
