import type { TLocale } from '@i18n-core/localeCodes';

export interface IPrivacySectionMessages {
    heading: string;
    body: string;
}

export interface IPrivacyMessages {
    seo: {
        title: string;
        description: string;
    };
    hero: {
        title: string;
        subtitle: string;
        effectiveDate: string;
    };
    documents: IPrivacySectionMessages;
    assistant: IPrivacySectionMessages;
    diagnostics: IPrivacySectionMessages;
    analytics: IPrivacySectionMessages;
    settings: IPrivacySectionMessages;
    storage: IPrivacySectionMessages;
    retention: IPrivacySectionMessages;
    contact: {
        heading: string;
        intro: string;
        linkLabel: string;
    };
}

export const PRIVACY_MESSAGES = {
    'en': {
        seo: {
            title: 'Privacy Policy',
            description: 'Privacy policy for EVB Viewer desktop, browser, website, and optional assistant features.',
        },
        hero: {
            title: 'Privacy Policy',
            subtitle: 'How EVB Viewer handles documents, settings, analytics, and optional assistant features.',
            effectiveDate: 'Effective September 4, 2026',
        },
        documents: {
            heading: 'Documents and local processing',
            body: 'EVB Viewer opens documents selected by you. Desktop document viewing, OCR, annotation, page operations, and export are performed on your device. The browser app processes selected documents in your browser unless you choose a feature that explicitly uses an external service. EVB Viewer does not upload your documents to the developer by default.',
        },
        assistant: {
            heading: 'Optional assistant services',
            body: 'Assistant features are optional. When you use an assistant backed by Codex, OpenAI, or Anthropic Claude, prompts and any content or attachments you choose to include are sent to that provider under your account and are governed by that provider’s terms and privacy policy. EVB Viewer does not sell this information.',
        },
        diagnostics: {
            heading: 'Optional Sentry error reports',
            body: 'EVB Viewer is the controller and uses Functional Software, Inc. d/b/a Sentry as its processor for optional client error reports. Desktop and browser reports are sent only with your consent. A report may contain a random Error ID, time, severity, closed diagnostic code, runtime and operation, app release and distribution, platform and runtime major versions, canonical application file, function, line and column, bounded non-content context, and a suppressed-error count. It never contains document contents or text, raw error messages or stacks, local paths or logs, URLs or request data, console arguments, attachments, account data, IP address, or identity. Reports are used only to diagnose crashes and product errors, never for analytics, advertising, profiling, AI, or training. Sentry stores events in the EU region for up to 90 days and may use its published subprocessors and the DPA and Standard Contractual Clauses for limited onward transfers. You can withdraw consent at any time to stop future reports. Use the issue tracker below and an Error ID, if available, to request access or deletion; you may also complain to your data-protection authority. Server-side Nitro reporting is disabled pending separate legal approval. Its objection control does not authorize processing while it is disabled.',
        },
        analytics: {
            heading: 'Analytics and technical information',
            body: 'The EVB Viewer website and browser app may collect limited usage and technical events, such as page paths, feature events, locale, screen category, referrer, browser user agent, approximate region, and a rotating hashed visitor identifier. This information is used to understand reliability and product usage. It is not used to identify document contents.',
        },
        settings: {
            heading: 'Settings, recent files, and updates',
            body: 'App preferences, workspace state, and recent-file references may be stored locally on your device. The desktop app may contact GitHub to check for and download software updates. Operating-system and app-store services may process additional technical information under their own policies.',
        },
        storage: {
            heading: 'Cookies and browser storage',
            body: 'EVB Viewer uses first-party preference cookies to remember language and, in the browser app, theme. Language cookies may last up to one year, and the theme cookie may last up to 180 days. The download site uses an opaque, HttpOnly cohort cookie for up to 90 days to keep staged release recommendations consistent; it is not used for advertising or cross-site tracking. The browser app also uses local storage, session storage, and IndexedDB for preferences, recent-file references, workspace state, document data you choose to retain, and a random per-session analytics identifier. EVB Viewer does not set advertising or third-party cookies. You can remove cookies and browser-stored data through your browser’s site-data controls; doing so resets preferences and locally retained app data.',
        },
        retention: {
            heading: 'Retention and choices',
            body: 'Local app data remains on your device until you remove it or uninstall the app. You control which documents and attachments are opened or sent to optional assistant services. Website analytics records are retained only as needed for product operation, security, and trend analysis and are scheduled for automatic deletion after 90 days.',
        },
        contact: {
            heading: 'Contact',
            intro: 'Questions or privacy requests can be submitted through the',
            linkLabel: 'EVB Viewer issue tracker',
        },
    },
    'de': {
        seo: {
            title: 'Datenschutzerklärung',
            description: 'Datenschutzerklärung für die Desktop- und Browser-App, die Website und optionale Assistentenfunktionen von EVB Viewer.',
        },
        hero: {
            title: 'Datenschutzerklärung',
            subtitle: 'Wie EVB Viewer Dokumente, Einstellungen, Analysedaten und optionale Assistentenfunktionen behandelt.',
            effectiveDate: 'Gültig ab 4. September 2026',
        },
        documents: {
            heading: 'Dokumente und lokale Verarbeitung',
            body: 'EVB Viewer öffnet die von dir ausgewählten Dokumente. In der Desktop-App erfolgen Dokumentanzeige, OCR, Anmerkungen, Seitenoperationen und Export auf deinem Gerät. Die Browser-App verarbeitet ausgewählte Dokumente im Browser, sofern du keine Funktion wählst, die ausdrücklich einen externen Dienst nutzt. Standardmäßig lädt EVB Viewer deine Dokumente nicht zum Entwickler hoch.',
        },
        assistant: {
            heading: 'Optionale Assistentendienste',
            body: 'Assistentenfunktionen sind optional. Wenn du einen auf Codex, OpenAI oder Anthropic Claude basierenden Assistenten verwendest, werden Eingaben sowie von dir ausgewählte Inhalte oder Anhänge über dein Konto an den jeweiligen Anbieter gesendet und unterliegen dessen Bedingungen und Datenschutzerklärung. EVB Viewer verkauft diese Informationen nicht.',
        },
        diagnostics: {
            heading: 'Optionale Sentry-Fehlerberichte',
            body: 'EVB Viewer ist der Verantwortliche und nutzt Functional Software, Inc. d/b/a Sentry als Auftragsverarbeiter für optionale Fehlerberichte des Clients. Desktop- und Browserberichte werden nur mit deiner Einwilligung gesendet. Ein Bericht kann eine zufällige Fehler-ID, Zeitpunkt, Schweregrad, geschlossenen Diagnosecode, Laufzeit und Vorgang, App-Version und Distribution, Plattform- und Laufzeit-Hauptversionen, kanonische App-Datei, Funktion, Zeile und Spalte, begrenzten inhaltsfreien Kontext und die Zahl unterdrückter Fehler enthalten. Er enthält niemals Dokumentinhalte oder Text, rohe Fehlermeldungen oder Stacks, lokale Pfade oder Protokolle, URLs oder Anfragedaten, Konsolenargumente, Anhänge, Kontodaten, IP-Adresse oder Identität. Die Berichte dienen nur der Diagnose von Abstürzen und Produktfehlern, nie Analyse, Werbung, Profiling, KI oder Training. Sentry speichert Ereignisse bis zu 90 Tage in der EU-Region und kann veröffentlichte Unterauftragsverarbeiter sowie den DPA und Standardvertragsklauseln für begrenzte Weiterübermittlungen nutzen. Du kannst die Einwilligung jederzeit widerrufen und damit künftige Berichte stoppen. Über den Issue-Tracker unten und, falls vorhanden, die Fehler-ID kannst du Auskunft oder Löschung verlangen; außerdem kannst du dich bei deiner Datenschutzaufsicht beschweren. Serverseitige Nitro-Berichte bleiben bis zu einer gesonderten rechtlichen Freigabe deaktiviert. Die Widerspruchseinstellung erlaubt keine Verarbeitung, solange diese Berichte deaktiviert sind.',
        },
        analytics: {
            heading: 'Analyse- und technische Informationen',
            body: 'Die EVB-Viewer-Website und Browser-App können begrenzte Nutzungs- und technische Ereignisse erfassen, etwa Seitenpfade, Funktionsereignisse, Sprache, Bildschirmkategorie, Referrer, Browser-User-Agent, ungefähre Region und eine regelmäßig wechselnde gehashte Besucherkennung. Diese Daten dienen dazu, Zuverlässigkeit und Produktnutzung zu verstehen, und nicht dazu, Dokumentinhalte zu identifizieren.',
        },
        settings: {
            heading: 'Einstellungen, zuletzt verwendete Dateien und Updates',
            body: 'App-Einstellungen, Arbeitsbereichszustand und Verweise auf zuletzt verwendete Dateien können lokal auf deinem Gerät gespeichert werden. Die Desktop-App kann GitHub kontaktieren, um Softwareupdates zu suchen und herunterzuladen. Betriebssystem- und App-Store-Dienste können nach ihren eigenen Richtlinien weitere technische Informationen verarbeiten.',
        },
        storage: {
            heading: 'Cookies und Browserspeicher',
            body: 'EVB Viewer verwendet eigene Präferenz-Cookies, um die Sprache und in der Browser-App das Design zu speichern. Sprach-Cookies können bis zu ein Jahr und das Design-Cookie bis zu 180 Tage gespeichert werden. Die Download-Website verwendet bis zu 90 Tage lang ein undurchsichtiges HttpOnly-Kohorten-Cookie, damit Empfehlungen bei gestaffelten Veröffentlichungen konsistent bleiben; es wird weder für Werbung noch für websiteübergreifendes Tracking eingesetzt. Die Browser-App verwendet außerdem lokalen Speicher, Sitzungsspeicher und IndexedDB für Einstellungen, Verweise auf zuletzt verwendete Dateien, den Arbeitsbereichszustand, von dir zur Aufbewahrung ausgewählte Dokumentdaten und eine zufällige Analysekennung pro Sitzung. EVB Viewer setzt keine Werbe- oder Drittanbieter-Cookies. Cookies und gespeicherte Browserdaten kannst du über die Website-Datenverwaltung deines Browsers löschen; dadurch werden Einstellungen und lokal gespeicherte App-Daten zurückgesetzt.',
        },
        retention: {
            heading: 'Aufbewahrung und Wahlmöglichkeiten',
            body: 'Lokale App-Daten verbleiben auf deinem Gerät, bis du sie entfernst oder die App deinstallierst. Du entscheidest, welche Dokumente und Anhänge geöffnet oder an optionale Assistentendienste gesendet werden. Website-Analysedaten werden nur so lange gespeichert, wie es für Produktbetrieb, Sicherheit und Trendanalysen erforderlich ist, und nach 90 Tagen zur automatischen Löschung eingeplant.',
        },
        contact: {
            heading: 'Kontakt',
            intro: 'Fragen oder Datenschutzanfragen kannst du über den',
            linkLabel: 'Issue-Tracker von EVB Viewer',
        },
    },
    'es': {
        seo: {
            title: 'Política de privacidad',
            description: 'Política de privacidad de la aplicación de escritorio, la aplicación web, el sitio y las funciones opcionales de asistente de EVB Viewer.',
        },
        hero: {
            title: 'Política de privacidad',
            subtitle: 'Cómo gestiona EVB Viewer los documentos, la configuración, los datos analíticos y las funciones opcionales de asistente.',
            effectiveDate: 'En vigor desde el 4 de septiembre de 2026',
        },
        documents: {
            heading: 'Documentos y procesamiento local',
            body: 'EVB Viewer abre los documentos que seleccionas. En la aplicación de escritorio, la visualización, el OCR, las anotaciones, las operaciones de página y la exportación se realizan en tu dispositivo. La aplicación web procesa los documentos seleccionados en el navegador, salvo que elijas una función que use expresamente un servicio externo. De forma predeterminada, EVB Viewer no sube tus documentos al desarrollador.',
        },
        assistant: {
            heading: 'Servicios opcionales de asistente',
            body: 'Las funciones de asistente son opcionales. Cuando utilizas un asistente basado en Codex, OpenAI o Anthropic Claude, las instrucciones y el contenido o los archivos adjuntos que decidas incluir se envían a ese proveedor mediante tu cuenta y se rigen por sus condiciones y política de privacidad. EVB Viewer no vende esta información.',
        },
        diagnostics: {
            heading: 'Informes de errores opcionales de Sentry',
            body: 'EVB Viewer es el responsable del tratamiento y utiliza Functional Software, Inc. d/b/a Sentry como encargado para los informes opcionales de errores del cliente. Los informes del escritorio y del navegador se envían solo con tu consentimiento. Un informe puede incluir un Error ID aleatorio, fecha y hora, gravedad, código de diagnóstico cerrado, entorno y operación, versión y distribución de la aplicación, versiones principales de la plataforma y del entorno, archivo, función, línea y columna canónicos de la aplicación, contexto limitado sin contenido y número de errores suprimidos. Nunca incluye documentos o texto, mensajes o pilas sin filtrar, rutas o registros locales, URL o datos de solicitudes, argumentos de consola, adjuntos, datos de cuenta, dirección IP ni identidad. Se usa solo para diagnosticar fallos y errores del producto, nunca para análisis, publicidad, perfiles, IA o entrenamiento. Sentry conserva los eventos hasta 90 días en la región de la UE y puede usar sus subencargados publicados y el DPA y las Cláusulas Contractuales Tipo para transferencias ulteriores limitadas. Puedes retirar el consentimiento en cualquier momento para detener futuros informes. Usa el seguimiento de incidencias de abajo y, si lo tienes, el Error ID para solicitar acceso o eliminación; también puedes reclamar ante tu autoridad de protección de datos. Los informes Nitro del servidor están desactivados hasta una aprobación jurídica independiente. El control de oposición no autoriza el tratamiento mientras estén desactivados.',
        },
        analytics: {
            heading: 'Datos analíticos e información técnica',
            body: 'El sitio y la aplicación web de EVB Viewer pueden recopilar eventos limitados de uso e información técnica, como rutas de páginas, eventos de funciones, idioma, categoría de pantalla, sitio de referencia, agente de usuario del navegador, región aproximada y un identificador de visitante cifrado que cambia periódicamente. Esta información se usa para comprender la fiabilidad y el uso del producto, no para identificar el contenido de los documentos.',
        },
        settings: {
            heading: 'Configuración, archivos recientes y actualizaciones',
            body: 'Las preferencias de la aplicación, el estado del espacio de trabajo y las referencias a archivos recientes pueden almacenarse localmente en tu dispositivo. La aplicación de escritorio puede contactar con GitHub para buscar y descargar actualizaciones. El sistema operativo y los servicios de la tienda de aplicaciones pueden tratar información técnica adicional conforme a sus propias políticas.',
        },
        storage: {
            heading: 'Cookies y almacenamiento del navegador',
            body: 'EVB Viewer utiliza cookies propias de preferencias para recordar el idioma y, en la aplicación web, el tema. Las cookies de idioma pueden durar hasta un año y la cookie del tema hasta 180 días. El sitio de descargas utiliza durante un máximo de 90 días una cookie de cohorte opaca y HttpOnly para mantener coherentes las recomendaciones durante los lanzamientos graduales; no se utiliza para publicidad ni seguimiento entre sitios. La aplicación web también utiliza almacenamiento local, almacenamiento de sesión e IndexedDB para preferencias, referencias a archivos recientes, estado del espacio de trabajo, datos de documentos que decidas conservar y un identificador analítico aleatorio por sesión. EVB Viewer no instala cookies publicitarias ni de terceros. Puedes eliminar las cookies y los datos almacenados por el navegador mediante los controles de datos de sitios del navegador; al hacerlo se restablecen las preferencias y los datos locales de la aplicación.',
        },
        retention: {
            heading: 'Conservación y opciones',
            body: 'Los datos locales de la aplicación permanecen en tu dispositivo hasta que los eliminas o desinstalas la aplicación. Tú controlas qué documentos y archivos adjuntos se abren o se envían a los servicios opcionales de asistente. Los registros analíticos del sitio se conservan solo el tiempo necesario para el funcionamiento del producto, la seguridad y el análisis de tendencias y se programa su eliminación automática después de 90 días.',
        },
        contact: {
            heading: 'Contacto',
            intro: 'Puedes enviar preguntas o solicitudes de privacidad mediante el',
            linkLabel: 'seguimiento de incidencias de EVB Viewer',
        },
    },
    'fr': {
        seo: {
            title: 'Politique de confidentialité',
            description: 'Politique de confidentialité de l’application de bureau, de l’application web, du site et des fonctions d’assistant optionnelles d’EVB Viewer.',
        },
        hero: {
            title: 'Politique de confidentialité',
            subtitle: 'Comment EVB Viewer traite les documents, les réglages, les données analytiques et les fonctions d’assistant optionnelles.',
            effectiveDate: 'En vigueur le 4 septembre 2026',
        },
        documents: {
            heading: 'Documents et traitement local',
            body: 'EVB Viewer ouvre les documents que vous sélectionnez. Dans l’application de bureau, la consultation, l’OCR, les annotations, les opérations sur les pages et l’export sont effectués sur votre appareil. L’application web traite les documents sélectionnés dans votre navigateur, sauf si vous choisissez une fonction qui utilise explicitement un service externe. Par défaut, EVB Viewer ne transmet pas vos documents au développeur.',
        },
        assistant: {
            heading: 'Services d’assistant optionnels',
            body: 'Les fonctions d’assistant sont optionnelles. Lorsque vous utilisez un assistant reposant sur Codex, OpenAI ou Anthropic Claude, les requêtes ainsi que le contenu ou les pièces jointes que vous choisissez d’inclure sont envoyés à ce fournisseur avec votre compte et relèvent de ses conditions et de sa politique de confidentialité. EVB Viewer ne vend pas ces informations.',
        },
        diagnostics: {
            heading: 'Rapports d’erreur Sentry facultatifs',
            body: 'EVB Viewer est le responsable du traitement et utilise Functional Software, Inc. d/b/a Sentry comme sous-traitant pour les rapports d’erreur facultatifs du client. Les rapports de l’application de bureau et du navigateur ne sont envoyés qu’avec votre consentement. Un rapport peut contenir un Error ID aléatoire, la date, la gravité, un code de diagnostic fermé, l’environnement et l’opération, la version et la distribution de l’application, les versions majeures de la plateforme et des moteurs, le fichier, la fonction, la ligne et la colonne canoniques de l’application, un contexte limité sans contenu et le nombre d’erreurs supprimées. Il ne contient jamais de document ou de texte, de message ou pile brute, de chemin ou journal local, d’URL ou donnée de requête, d’argument de console, de pièce jointe, de donnée de compte, d’adresse IP ou d’identité. Il sert uniquement à diagnostiquer les plantages et erreurs du produit, jamais à l’analyse, la publicité, au profilage, à l’IA ou à l’entraînement. Sentry conserve les événements jusqu’à 90 jours dans la région UE et peut recourir à ses sous-traitants publiés ainsi qu’au DPA et aux clauses contractuelles types pour des transferts ultérieurs limités. Vous pouvez retirer votre consentement à tout moment. Utilisez le suivi ci-dessous et, si disponible, l’Error ID pour demander accès ou suppression; vous pouvez aussi saisir votre autorité de protection des données. Les rapports Nitro côté serveur restent désactivés dans l’attente d’une approbation juridique distincte. Le contrôle d’opposition n’autorise aucun traitement tant qu’ils restent désactivés.',
        },
        analytics: {
            heading: 'Données analytiques et techniques',
            body: 'Le site et l’application web EVB Viewer peuvent recueillir des événements d’utilisation et des données techniques limités, notamment les chemins de pages, les événements de fonctionnalités, la langue, la catégorie d’écran, le site référent, l’agent utilisateur du navigateur, la région approximative et un identifiant de visiteur haché et renouvelé. Ces données servent à comprendre la fiabilité et l’utilisation du produit, pas à identifier le contenu des documents.',
        },
        settings: {
            heading: 'Réglages, fichiers récents et mises à jour',
            body: 'Les préférences de l’application, l’état de l’espace de travail et les références aux fichiers récents peuvent être stockés localement sur votre appareil. L’application de bureau peut contacter GitHub pour rechercher et télécharger des mises à jour. Le système d’exploitation et les services de la boutique d’applications peuvent traiter d’autres données techniques selon leurs propres politiques.',
        },
        storage: {
            heading: 'Cookies et stockage du navigateur',
            body: 'EVB Viewer utilise des cookies de préférence internes pour mémoriser la langue et, dans l’application web, le thème. Les cookies de langue peuvent être conservés jusqu’à un an et le cookie de thème jusqu’à 180 jours. Le site de téléchargement utilise pendant 90 jours au maximum un cookie de cohorte opaque et HttpOnly afin de maintenir la cohérence des recommandations lors des déploiements progressifs ; il n’est pas utilisé à des fins publicitaires ni pour le suivi intersite. L’application web utilise également le stockage local, le stockage de session et IndexedDB pour les préférences, les références aux fichiers récents, l’état de l’espace de travail, les données de documents que vous choisissez de conserver et un identifiant analytique aléatoire propre à la session. EVB Viewer ne dépose aucun cookie publicitaire ou tiers. Vous pouvez supprimer les cookies et les données stockées par le navigateur depuis les contrôles de données de site de votre navigateur ; cette opération réinitialise les préférences et les données locales de l’application.',
        },
        retention: {
            heading: 'Conservation et choix',
            body: 'Les données locales de l’application restent sur votre appareil jusqu’à ce que vous les supprimiez ou désinstalliez l’application. Vous choisissez les documents et pièces jointes ouverts ou envoyés aux services d’assistant optionnels. Les données analytiques du site ne sont conservées que le temps nécessaire au fonctionnement du produit, à la sécurité et à l’analyse des tendances, et leur suppression automatique est programmée après 90 jours.',
        },
        contact: {
            heading: 'Contact',
            intro: 'Les questions ou demandes relatives à la confidentialité peuvent être envoyées via le',
            linkLabel: 'système de suivi d’EVB Viewer',
        },
    },
    'it': {
        seo: {
            title: 'Informativa sulla privacy',
            description: 'Informativa sulla privacy per l’app desktop, l’app browser, il sito e le funzionalità opzionali dell’assistente di EVB Viewer.',
        },
        hero: {
            title: 'Informativa sulla privacy',
            subtitle: 'Come EVB Viewer gestisce documenti, impostazioni, dati analitici e funzionalità opzionali dell’assistente.',
            effectiveDate: 'In vigore dal 4 settembre 2026',
        },
        documents: {
            heading: 'Documenti ed elaborazione locale',
            body: 'EVB Viewer apre i documenti selezionati da te. Nell’app desktop, visualizzazione, OCR, annotazioni, operazioni sulle pagine ed esportazione avvengono sul tuo dispositivo. L’app browser elabora i documenti selezionati nel browser, a meno che tu non scelga una funzionalità che usa esplicitamente un servizio esterno. Per impostazione predefinita, EVB Viewer non carica i tuoi documenti presso lo sviluppatore.',
        },
        assistant: {
            heading: 'Servizi opzionali dell’assistente',
            body: 'Le funzionalità dell’assistente sono opzionali. Quando utilizzi un assistente basato su Codex, OpenAI o Anthropic Claude, le richieste e gli eventuali contenuti o allegati che scegli di includere vengono inviati a quel fornitore tramite il tuo account e sono regolati dai suoi termini e dalla sua informativa sulla privacy. EVB Viewer non vende queste informazioni.',
        },
        diagnostics: {
            heading: 'Report di errore Sentry opzionali',
            body: 'EVB Viewer è il titolare del trattamento e usa Functional Software, Inc. d/b/a Sentry come responsabile per i report di errore opzionali del client. I report desktop e browser vengono inviati solo con il tuo consenso. Un report può contenere un Error ID casuale, data e ora, gravità, codice diagnostico chiuso, runtime e operazione, versione e distribuzione dell’app, versioni principali della piattaforma e dei runtime, file, funzione, riga e colonna canonici dell’applicazione, contesto limitato privo di contenuti e numero di errori soppressi. Non contiene mai documenti o testo, messaggi o stack grezzi, percorsi o registri locali, URL o dati della richiesta, argomenti della console, allegati, dati dell’account, indirizzo IP o identità. Serve solo a diagnosticare arresti anomali ed errori del prodotto, mai per analisi, pubblicità, profilazione, IA o addestramento. Sentry conserva gli eventi per un massimo di 90 giorni nella regione UE e può usare i sub-responsabili pubblicati e il DPA e le Clausole Contrattuali Standard per trasferimenti successivi limitati. Puoi revocare il consenso in qualsiasi momento. Usa il tracker qui sotto e, se disponibile, l’Error ID per chiedere accesso o eliminazione; puoi anche presentare reclamo all’autorità di protezione dei dati. I report Nitro lato server restano disattivati in attesa di un’approvazione legale separata. Il controllo di opposizione non autorizza il trattamento mentre sono disattivati.',
        },
        analytics: {
            heading: 'Dati analitici e informazioni tecniche',
            body: 'Il sito e l’app browser di EVB Viewer possono raccogliere eventi d’uso e dati tecnici limitati, come percorsi delle pagine, eventi delle funzionalità, lingua, categoria dello schermo, referrer, user agent del browser, area geografica approssimativa e un identificatore del visitatore sottoposto a hash e ruotato. Questi dati servono a comprendere affidabilità e utilizzo del prodotto, non a identificare il contenuto dei documenti.',
        },
        settings: {
            heading: 'Impostazioni, file recenti e aggiornamenti',
            body: 'Le preferenze dell’app, lo stato dell’area di lavoro e i riferimenti ai file recenti possono essere archiviati localmente sul tuo dispositivo. L’app desktop può contattare GitHub per cercare e scaricare aggiornamenti software. Il sistema operativo e i servizi dello store possono elaborare ulteriori informazioni tecniche secondo le proprie politiche.',
        },
        storage: {
            heading: 'Cookie e archiviazione del browser',
            body: 'EVB Viewer utilizza cookie di preferenza proprietari per ricordare la lingua e, nell’app browser, il tema. I cookie della lingua possono durare fino a un anno e quello del tema fino a 180 giorni. Il sito di download utilizza per un massimo di 90 giorni un cookie di coorte opaco e HttpOnly per mantenere coerenti i suggerimenti durante i rilasci graduali; non viene usato per pubblicità o tracciamento tra siti. L’app browser utilizza inoltre archiviazione locale, archiviazione di sessione e IndexedDB per preferenze, riferimenti ai file recenti, stato dell’area di lavoro, dati dei documenti che scegli di conservare e un identificatore analitico casuale per sessione. EVB Viewer non imposta cookie pubblicitari o di terze parti. Puoi eliminare cookie e dati memorizzati dal browser tramite i controlli dei dati dei siti del browser; questa operazione reimposta le preferenze e i dati locali dell’app.',
        },
        retention: {
            heading: 'Conservazione e scelte',
            body: 'I dati locali dell’app rimangono sul dispositivo finché non li rimuovi o disinstalli l’app. Sei tu a decidere quali documenti e allegati aprire o inviare ai servizi opzionali dell’assistente. I dati analitici del sito vengono conservati solo per il tempo necessario al funzionamento del prodotto, alla sicurezza e all’analisi delle tendenze e ne è programmata l’eliminazione automatica dopo 90 giorni.',
        },
        contact: {
            heading: 'Contatti',
            intro: 'Puoi inviare domande o richieste relative alla privacy tramite il',
            linkLabel: 'tracker delle segnalazioni di EVB Viewer',
        },
    },
    'nl': {
        seo: {
            title: 'Privacybeleid',
            description: 'Privacybeleid voor de desktop-app, browser-app, website en optionele assistentfuncties van EVB Viewer.',
        },
        hero: {
            title: 'Privacybeleid',
            subtitle: 'Hoe EVB Viewer omgaat met documenten, instellingen, analysegegevens en optionele assistentfuncties.',
            effectiveDate: 'Van kracht vanaf 4 september 2026',
        },
        documents: {
            heading: 'Documenten en lokale verwerking',
            body: 'EVB Viewer opent documenten die je zelf selecteert. In de desktop-app worden documentweergave, OCR, annotaties, paginabewerkingen en export op je apparaat uitgevoerd. De browser-app verwerkt geselecteerde documenten in je browser, tenzij je een functie kiest die uitdrukkelijk een externe dienst gebruikt. EVB Viewer uploadt je documenten standaard niet naar de ontwikkelaar.',
        },
        assistant: {
            heading: 'Optionele assistentdiensten',
            body: 'Assistentfuncties zijn optioneel. Wanneer je een assistent gebruikt die is gebaseerd op Codex, OpenAI of Anthropic Claude, worden prompts en alle inhoud of bijlagen die je kiest via je account naar die aanbieder gestuurd en vallen ze onder de voorwaarden en het privacybeleid van die aanbieder. EVB Viewer verkoopt deze informatie niet.',
        },
        diagnostics: {
            heading: 'Optionele Sentry-foutrapporten',
            body: 'EVB Viewer is de verwerkingsverantwoordelijke en gebruikt Functional Software, Inc. d/b/a Sentry als verwerker voor optionele foutrapporten van de client. Desktop- en browserrapporten worden alleen met je toestemming verzonden. Een rapport kan een willekeurige Error ID, tijd, ernst, gesloten diagnostische code, runtime en bewerking, appversie en distributie, hoofdversies van platform en runtimes, canoniek appbestand, functie, regel en kolom, beperkte inhoudsvrije context en het aantal onderdrukte fouten bevatten. Het bevat nooit documenten of tekst, ruwe foutmeldingen of stacks, lokale paden of logboeken, URL’s of aanvraaggegevens, consoleargumenten, bijlagen, accountgegevens, IP-adres of identiteit. Rapporten worden alleen gebruikt om crashes en productfouten op te lossen, nooit voor analyse, advertenties, profilering, AI of training. Sentry bewaart gebeurtenissen maximaal 90 dagen in de EU-regio en kan zijn gepubliceerde subverwerkers en de DPA en standaardcontractbepalingen gebruiken voor beperkte doorgiften. Je kunt je toestemming altijd intrekken. Gebruik de issue-tracker hieronder en, indien beschikbaar, de Error ID om inzage of verwijdering te vragen; je kunt ook een klacht indienen bij je privacytoezichthouder. Server-side Nitro-rapportage blijft uitgeschakeld tot afzonderlijke juridische goedkeuring. De bezwaarinstelling geeft geen toestemming voor verwerking zolang deze rapportage is uitgeschakeld.',
        },
        analytics: {
            heading: 'Analyse- en technische gegevens',
            body: 'De website en browser-app van EVB Viewer kunnen beperkte gebruiksgebeurtenissen en technische gegevens verzamelen, zoals paginapaden, functiegebeurtenissen, taal, schermcategorie, verwijzende site, browser-user-agent, geschatte regio en een wisselende gehashte bezoekerscode. Deze gegevens worden gebruikt om de betrouwbaarheid en het productgebruik te begrijpen en niet om de inhoud van documenten vast te stellen.',
        },
        settings: {
            heading: 'Instellingen, recente bestanden en updates',
            body: 'Appvoorkeuren, de status van de werkruimte en verwijzingen naar recente bestanden kunnen lokaal op je apparaat worden opgeslagen. De desktop-app kan GitHub benaderen om software-updates te controleren en te downloaden. Het besturingssysteem en appstorediensten kunnen aanvullende technische gegevens verwerken volgens hun eigen beleid.',
        },
        storage: {
            heading: 'Cookies en browseropslag',
            body: 'EVB Viewer gebruikt eigen voorkeurscookies om de taal en, in de browser-app, het thema te onthouden. Taalcookies kunnen maximaal één jaar worden bewaard en de themacookie maximaal 180 dagen. De downloadsite gebruikt maximaal 90 dagen een ondoorzichtige HttpOnly-cohortcookie om aanbevelingen tijdens gefaseerde releases consistent te houden; deze wordt niet gebruikt voor advertenties of tracking tussen websites. De browser-app gebruikt daarnaast lokale opslag, sessieopslag en IndexedDB voor voorkeuren, verwijzingen naar recente bestanden, de status van de werkruimte, documentgegevens die je wilt bewaren en een willekeurige analyse-ID per sessie. EVB Viewer plaatst geen advertentiecookies of cookies van derden. Je kunt cookies en door de browser opgeslagen gegevens verwijderen via de instellingen voor websitegegevens van je browser; hierdoor worden voorkeuren en lokaal opgeslagen appgegevens gewist.',
        },
        retention: {
            heading: 'Bewaartermijnen en keuzes',
            body: 'Lokale appgegevens blijven op je apparaat totdat je ze verwijdert of de app deïnstalleert. Je bepaalt zelf welke documenten en bijlagen worden geopend of naar optionele assistentdiensten worden gestuurd. Analysegegevens van de website worden alleen bewaard zolang dat nodig is voor de werking en beveiliging van het product en voor trendanalyse en worden na 90 dagen automatisch voor verwijdering ingepland.',
        },
        contact: {
            heading: 'Contact',
            intro: 'Vragen of privacyverzoeken kun je indienen via de',
            linkLabel: 'issue-tracker van EVB Viewer',
        },
    },
    'pt': {
        seo: {
            title: 'Política de privacidade',
            description: 'Política de privacidade da aplicação desktop, da aplicação no navegador, do site e das funcionalidades opcionais do assistente do EVB Viewer.',
        },
        hero: {
            title: 'Política de privacidade',
            subtitle: 'Como o EVB Viewer trata documentos, definições, dados analíticos e funcionalidades opcionais do assistente.',
            effectiveDate: 'Em vigor desde 4 de setembro de 2026',
        },
        documents: {
            heading: 'Documentos e processamento local',
            body: 'O EVB Viewer abre os documentos que selecionar. Na aplicação desktop, a visualização, o OCR, as anotações, as operações de página e a exportação são efetuados no seu dispositivo. A aplicação no navegador processa os documentos selecionados no navegador, exceto se escolher uma funcionalidade que utilize explicitamente um serviço externo. Por predefinição, o EVB Viewer não envia os seus documentos para o programador.',
        },
        assistant: {
            heading: 'Serviços opcionais do assistente',
            body: 'As funcionalidades do assistente são opcionais. Quando utiliza um assistente baseado no Codex, OpenAI ou Anthropic Claude, os pedidos e qualquer conteúdo ou anexo que decida incluir são enviados a esse fornecedor através da sua conta e regem-se pelos respetivos termos e política de privacidade. O EVB Viewer não vende estas informações.',
        },
        diagnostics: {
            heading: 'Relatórios de erros opcionais do Sentry',
            body: 'O EVB Viewer é o responsável pelo tratamento e utiliza a Functional Software, Inc. d/b/a Sentry como subcontratante para relatórios opcionais de erros do cliente. Os relatórios da aplicação desktop e do navegador só são enviados com o seu consentimento. Um relatório pode conter um Error ID aleatório, data e hora, gravidade, código de diagnóstico fechado, ambiente e operação, versão e distribuição da aplicação, versões principais da plataforma e dos ambientes, ficheiro, função, linha e coluna canónicos da aplicação, contexto limitado sem conteúdo e número de erros suprimidos. Nunca contém documentos ou texto, mensagens ou pilhas brutas, caminhos ou registos locais, URLs ou dados do pedido, argumentos da consola, anexos, dados da conta, endereço IP ou identidade. Serve apenas para diagnosticar falhas e erros do produto, nunca para análise, publicidade, definição de perfis, IA ou treino. O Sentry conserva eventos por até 90 dias na região da UE e pode utilizar os subcontratantes publicados e o DPA e as Cláusulas Contratuais-Tipo para transferências ulteriores limitadas. Pode retirar o consentimento a qualquer momento. Utilize o sistema abaixo e, se disponível, o Error ID para pedir acesso ou eliminação; também pode reclamar junto da autoridade de proteção de dados. Os relatórios Nitro do servidor permanecem desativados até aprovação jurídica separada. O controlo de oposição não autoriza o tratamento enquanto estiverem desativados.',
        },
        analytics: {
            heading: 'Dados analíticos e informações técnicas',
            body: 'O site e a aplicação no navegador do EVB Viewer podem recolher eventos limitados de utilização e dados técnicos, como caminhos de páginas, eventos de funcionalidades, idioma, categoria do ecrã, referenciador, agente do utilizador do navegador, região aproximada e um identificador de visitante com hash que muda periodicamente. Estas informações ajudam a compreender a fiabilidade e a utilização do produto e não são usadas para identificar o conteúdo dos documentos.',
        },
        settings: {
            heading: 'Definições, ficheiros recentes e atualizações',
            body: 'As preferências da aplicação, o estado da área de trabalho e as referências a ficheiros recentes podem ser armazenados localmente no seu dispositivo. A aplicação desktop pode contactar o GitHub para procurar e transferir atualizações. O sistema operativo e os serviços da loja de aplicações podem processar informações técnicas adicionais segundo as respetivas políticas.',
        },
        storage: {
            heading: 'Cookies e armazenamento do navegador',
            body: 'O EVB Viewer utiliza cookies próprios de preferências para memorizar o idioma e, na aplicação no navegador, o tema. Os cookies de idioma podem durar até um ano e o cookie do tema até 180 dias. O site de transferências utiliza durante um máximo de 90 dias um cookie de coorte opaco e HttpOnly para manter consistentes as recomendações durante lançamentos faseados; não é utilizado para publicidade nem rastreamento entre sites. A aplicação no navegador também utiliza armazenamento local, armazenamento de sessão e IndexedDB para preferências, referências a ficheiros recentes, estado da área de trabalho, dados de documentos que decida conservar e um identificador analítico aleatório por sessão. O EVB Viewer não define cookies publicitários nem de terceiros. Pode remover cookies e dados guardados pelo navegador através dos controlos de dados de sites do navegador; ao fazê-lo, repõe as preferências e os dados locais da aplicação.',
        },
        retention: {
            heading: 'Conservação e opções',
            body: 'Os dados locais da aplicação permanecem no seu dispositivo até os remover ou desinstalar a aplicação. Controla quais os documentos e anexos que são abertos ou enviados para serviços opcionais do assistente. Os registos analíticos do site são conservados apenas durante o período necessário ao funcionamento do produto, à segurança e à análise de tendências e têm eliminação automática programada após 90 dias.',
        },
        contact: {
            heading: 'Contacto',
            intro: 'Pode enviar perguntas ou pedidos sobre privacidade através do',
            linkLabel: 'sistema de acompanhamento de problemas do EVB Viewer',
        },
    },
    'pt-BR': {
        seo: {
            title: 'Política de privacidade',
            description: 'Política de privacidade do aplicativo desktop, do aplicativo web, do site e dos recursos opcionais do assistente do EVB Viewer.',
        },
        hero: {
            title: 'Política de privacidade',
            subtitle: 'Como o EVB Viewer trata documentos, configurações, dados analíticos e recursos opcionais do assistente.',
            effectiveDate: 'Em vigor desde 4 de setembro de 2026',
        },
        documents: {
            heading: 'Documentos e processamento local',
            body: 'O EVB Viewer abre os documentos que você selecionar. No aplicativo desktop, a visualização, o OCR, as anotações, as operações de página e a exportação são realizados no seu dispositivo. O aplicativo web processa os documentos selecionados no navegador, a menos que você escolha um recurso que use explicitamente um serviço externo. Por padrão, o EVB Viewer não envia seus documentos ao desenvolvedor.',
        },
        assistant: {
            heading: 'Serviços opcionais do assistente',
            body: 'Os recursos do assistente são opcionais. Quando você usa um assistente baseado no Codex, OpenAI ou Anthropic Claude, as solicitações e qualquer conteúdo ou anexo que você decidir incluir são enviados a esse provedor por meio da sua conta e seguem os termos e a política de privacidade dele. O EVB Viewer não vende essas informações.',
        },
        diagnostics: {
            heading: 'Relatórios de erros opcionais do Sentry',
            body: 'O EVB Viewer é o controlador e usa a Functional Software, Inc. d/b/a Sentry como operadora para relatórios opcionais de erros do cliente. Os relatórios do aplicativo desktop e do navegador só são enviados com o seu consentimento. Um relatório pode conter um Error ID aleatório, data e hora, gravidade, código de diagnóstico fechado, ambiente e operação, versão e distribuição do aplicativo, versões principais da plataforma e dos ambientes, arquivo, função, linha e coluna canônicos do aplicativo, contexto limitado sem conteúdo e número de erros suprimidos. Nunca contém documentos ou texto, mensagens ou pilhas brutas, caminhos ou registros locais, URLs ou dados da solicitação, argumentos do console, anexos, dados da conta, endereço IP nem identidade. É usado somente para diagnosticar falhas e erros do produto, nunca para análise, publicidade, criação de perfil, IA ou treinamento. O Sentry mantém os eventos por até 90 dias na região da UE e pode usar seus suboperadores publicados e o DPA e as Cláusulas Contratuais Padrão para transferências posteriores limitadas. Você pode retirar o consentimento a qualquer momento. Use o rastreador abaixo e, se disponível, o Error ID para pedir acesso ou exclusão; você também pode reclamar à autoridade de proteção de dados. Os relatórios Nitro do servidor permanecem desativados até uma aprovação jurídica separada. O controle de oposição não autoriza o tratamento enquanto estiverem desativados.',
        },
        analytics: {
            heading: 'Dados analíticos e informações técnicas',
            body: 'O site e o aplicativo web do EVB Viewer podem coletar eventos limitados de uso e dados técnicos, como caminhos de páginas, eventos de recursos, idioma, categoria de tela, referenciador, agente do usuário do navegador, região aproximada e um identificador de visitante com hash que muda periodicamente. Essas informações ajudam a entender a confiabilidade e o uso do produto e não são usadas para identificar o conteúdo dos documentos.',
        },
        settings: {
            heading: 'Configurações, arquivos recentes e atualizações',
            body: 'As preferências do aplicativo, o estado da área de trabalho e as referências a arquivos recentes podem ser armazenados localmente no seu dispositivo. O aplicativo desktop pode acessar o GitHub para procurar e baixar atualizações. O sistema operacional e os serviços da loja de aplicativos podem processar outras informações técnicas conforme suas próprias políticas.',
        },
        storage: {
            heading: 'Cookies e armazenamento do navegador',
            body: 'O EVB Viewer usa cookies próprios de preferências para lembrar o idioma e, no aplicativo web, o tema. Os cookies de idioma podem durar até um ano e o cookie do tema até 180 dias. O site de downloads usa por até 90 dias um cookie de coorte opaco e HttpOnly para manter consistentes as recomendações durante lançamentos graduais; ele não é usado para publicidade nem rastreamento entre sites. O aplicativo web também usa armazenamento local, armazenamento de sessão e IndexedDB para preferências, referências a arquivos recentes, estado do espaço de trabalho, dados de documentos que você decidir manter e um identificador analítico aleatório por sessão. O EVB Viewer não define cookies de publicidade nem de terceiros. Você pode remover cookies e dados armazenados pelo navegador usando os controles de dados de sites do navegador; isso redefine as preferências e os dados locais do aplicativo.',
        },
        retention: {
            heading: 'Retenção e escolhas',
            body: 'Os dados locais do aplicativo permanecem no seu dispositivo até que você os remova ou desinstale o aplicativo. Você controla quais documentos e anexos são abertos ou enviados aos serviços opcionais do assistente. Os registros analíticos do site são mantidos apenas pelo tempo necessário para a operação do produto, a segurança e a análise de tendências e têm exclusão automática programada após 90 dias.',
        },
        contact: {
            heading: 'Contato',
            intro: 'Dúvidas ou solicitações de privacidade podem ser enviadas pelo',
            linkLabel: 'rastreador de problemas do EVB Viewer',
        },
    },
    'ru': {
        seo: {
            title: 'Политика конфиденциальности',
            description: 'Политика конфиденциальности десктопного приложения, браузерной версии, сайта и опциональных функций ассистента EVB Viewer.',
        },
        hero: {
            title: 'Политика конфиденциальности',
            subtitle: 'Как EVB Viewer обрабатывает документы, настройки, аналитику и данные опциональных функций ассистента.',
            effectiveDate: 'Действует с 4 сентября 2026 года',
        },
        documents: {
            heading: 'Документы и локальная обработка',
            body: 'EVB Viewer открывает выбранные вами документы. В десктопном приложении просмотр документов, OCR, аннотирование, операции со страницами и экспорт выполняются на вашем устройстве. Браузерная версия обрабатывает выбранные документы в браузере, если только вы не выберете функцию, которая явно использует внешний сервис. По умолчанию EVB Viewer не загружает ваши документы разработчику.',
        },
        assistant: {
            heading: 'Опциональные сервисы ассистента',
            body: 'Функции ассистента необязательны. При использовании ассистента на базе Codex, OpenAI или Anthropic Claude запросы, а также выбранные вами материалы и вложения отправляются соответствующему провайдеру через вашу учётную запись и регулируются его условиями и политикой конфиденциальности. EVB Viewer не продаёт эту информацию.',
        },
        diagnostics: {
            heading: 'Необязательные отчёты об ошибках через Sentry',
            body: 'EVB Viewer является контролёром и использует Functional Software, Inc. d/b/a Sentry как обработчика необязательных клиентских отчётов об ошибках. Десктопное приложение и браузер отправляют отчёты только с вашего согласия. Отчёт может содержать случайный Error ID, время, уровень серьёзности, закрытый код диагностики, среду и операцию, версию и дистрибутив приложения, основные версии платформы и сред выполнения, канонические имя файла приложения, функцию, строку и столбец, ограниченный контекст без пользовательского содержимого и число подавленных ошибок. В нём никогда нет документов или текста, исходных сообщений или стеков, локальных путей или журналов, URL или данных запроса, аргументов консоли, вложений, данных учётной записи, IP-адреса или личности. Отчёты используются только для диагностики сбоев и ошибок продукта, а не для аналитики, рекламы, профилирования, ИИ или обучения. Sentry хранит события до 90 дней в регионе ЕС и может использовать опубликованных субобработчиков, DPA и Стандартные договорные положения для ограниченной дальнейшей передачи. Вы можете в любой момент отозвать согласие и остановить будущие отчёты. Через трекер ниже и Error ID, если он есть, можно запросить доступ или удаление; также можно пожаловаться в орган по защите данных. Серверные отчёты Nitro отключены до отдельного юридического одобрения. Настройка возражения не разрешает обработку, пока эти отчёты отключены.',
        },
        analytics: {
            heading: 'Аналитика и техническая информация',
            body: 'Сайт и браузерная версия EVB Viewer могут собирать ограниченные данные об использовании и технические события: пути страниц, события функций, язык, категорию экрана, источник перехода, user agent браузера, приблизительный регион и регулярно меняющийся хешированный идентификатор посетителя. Эти данные помогают оценивать надёжность и использование продукта и не применяются для определения содержимого документов.',
        },
        settings: {
            heading: 'Настройки, недавние файлы и обновления',
            body: 'Настройки приложения, состояние рабочего пространства и ссылки на недавние файлы могут храниться локально на вашем устройстве. Десктопное приложение может обращаться к GitHub для проверки и загрузки обновлений. Службы операционной системы и магазина приложений могут обрабатывать дополнительную техническую информацию согласно собственным политикам.',
        },
        storage: {
            heading: 'Файлы cookie и хранилища браузера',
            body: 'EVB Viewer использует собственные файлы cookie с настройками, чтобы запоминать язык и, в браузерной версии, тему. Файлы cookie языка могут храниться до одного года, а файл cookie темы — до 180 дней. Сайт загрузки использует непрозрачный файл cookie когорты с атрибутом HttpOnly сроком до 90 дней, чтобы рекомендации по поэтапно выпускаемым версиям оставались согласованными; он не используется для рекламы или межсайтового отслеживания. Браузерная версия также использует локальное и сеансовое хранилища и IndexedDB для настроек, ссылок на недавние файлы, состояния рабочего пространства, данных документов, которые вы решили сохранить, и случайного идентификатора аналитической сессии. EVB Viewer не устанавливает рекламные или сторонние файлы cookie. Удалить файлы cookie и данные браузера можно в настройках данных сайтов вашего браузера; при этом настройки и локально сохранённые данные приложения будут сброшены.',
        },
        retention: {
            heading: 'Хранение данных и ваш выбор',
            body: 'Локальные данные приложения остаются на устройстве, пока вы их не удалите или не удалите приложение. Вы сами выбираете, какие документы и вложения открывать или отправлять опциональным сервисам ассистента. Аналитические данные сайта хранятся только столько, сколько необходимо для работы продукта, безопасности и анализа тенденций, и планируются к автоматическому удалению через 90 дней.',
        },
        contact: {
            heading: 'Связаться с нами',
            intro: 'Вопросы и запросы о конфиденциальности можно отправить через',
            linkLabel: 'трекер задач EVB Viewer',
        },
    },
} satisfies Record<TLocale, IPrivacyMessages>;
