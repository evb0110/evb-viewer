/**
 * The one privacy boundary for Sentry reports from main, renderer and the
 * hosted browser build. It keeps an allowlist of event fields and rewrites
 * free text so that no local path, file name, URL, quoted value or document
 * text leaves the machine. Free-form messages become stable labels. Breadcrumbs,
 * request data, user data, extra data,
 * local variables, source context and attachments are never sent.
 */

type TRecord = Record<string, unknown>;

const KEPT_EVENT_KEYS = [
    'event_id',
    'timestamp',
    'level',
    'platform',
    'release',
    'dist',
    'environment',
    'sdk',
] as const;
const KEPT_CONTEXT_KEYS: Record<string, readonly string[]> = {
    app: ['app_version'],
    browser: [
        'name',
        'version',
    ],
    os: [
        'name',
        'version',
    ],
    runtime: [
        'name',
        'version',
    ],
};
const KEPT_FRAME_KEYS = [
    'function',
    'lineno',
    'colno',
    'in_app',
    'platform',
    'instruction_addr',
] as const;
const APP_PATH_MARKER = /(?:^|[\\/])((?:app\.asar|dist-electron|nuxt-output|_nuxt)[\\/].*)$/u;
const APP_ORIGIN_PREFIX = /^(?:evb-viewer:\/\/app|app:\/\/[^/]*)\//u;
function isRecord(value: unknown): value is TRecord {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pick(source: TRecord, keys: readonly string[]) {
    const result: TRecord = {};
    for (const key of keys) {
        if (source[key] !== undefined) {
            result[key] = source[key];
        }
    }
    return result;
}

/** App bundles keep relative paths for source maps; other local paths are hidden. */
export function scrubSentryFramePath(value: string) {
    const normalized = value.replace(APP_ORIGIN_PREFIX, 'app:///');
    if (normalized.startsWith('app:///') || normalized.startsWith('node:')) {
        return normalized;
    }
    const appRelative = APP_PATH_MARKER.exec(normalized)?.[1];
    if (appRelative !== undefined) {
        return `app:///${appRelative.replaceAll('\\', '/')}`;
    }
    return '<external>';
}

function scrubFrame(frame: unknown) {
    if (!isRecord(frame)) {
        return {};
    }
    const result = pick(frame, KEPT_FRAME_KEYS);
    for (const key of [
        'filename',
        'abs_path',
    ] as const) {
        const path = frame[key];
        if (typeof path === 'string') {
            result[key] = scrubSentryFramePath(path);
        }
    }
    return result;
}

function scrubException(value: unknown) {
    if (!isRecord(value)) {
        return {};
    }
    const result: TRecord = {};
    if (typeof value.type === 'string' || typeof value.value === 'string') {
        result.type = 'Error';
        result.value = 'Application error';
    }
    if (isRecord(value.mechanism)) {
        result.mechanism = pick(value.mechanism, [
            'type',
            'handled',
        ]);
    }
    const frames = isRecord(value.stacktrace) ? value.stacktrace.frames : undefined;
    if (Array.isArray(frames)) {
        result.stacktrace = {frames: frames.map(scrubFrame)};
    }
    return result;
}

function scrubContexts(contexts: TRecord) {
    const result: TRecord = {};
    for (const [
        name,
        keys,
    ] of Object.entries(KEPT_CONTEXT_KEYS)) {
        const context = contexts[name];
        if (isRecord(context)) {
            result[name] = pick(context, keys);
        }
    }
    return result;
}

function scrubDebugImage(image: unknown) {
    if (!isRecord(image)) {
        return {};
    }
    const result = pick(image, [
        'type',
        'debug_id',
        'code_id',
        'image_addr',
        'image_size',
        'arch',
    ]);
    for (const key of [
        'code_file',
        'debug_file',
    ] as const) {
        const path = image[key];
        if (typeof path === 'string') {
            result[key] = scrubSentryFramePath(path);
        }
    }
    return result;
}

export function scrubSentryEvent<T extends object>(event: T): T {
    const source = event as TRecord;
    const result = pick(source, KEPT_EVENT_KEYS);
    if (isRecord(source.tags)) {
        const tags = Object.fromEntries(Object.entries(source.tags).filter(([
            key,
            value,
        ]) =>
            key === 'diagnostic_code' && typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/u.test(value)
            || key === 'event.process' && (value === 'browser' || value === 'main'),
        ));
        if (Object.keys(tags).length > 0) {
            result.tags = tags;
        }
        const code = tags.diagnostic_code;
        if (typeof code === 'string') {
            result.fingerprint = [
                '{{ default }}',
                code,
            ];
        }
    }
    const message = isRecord(source.message) ? source.message.formatted : source.message;
    if (typeof message === 'string') {
        result.message = 'Application error';
    }
    if (isRecord(source.exception) && Array.isArray(source.exception.values)) {
        result.exception = {values: source.exception.values.map(scrubException)};
    }
    if (isRecord(source.contexts)) {
        result.contexts = scrubContexts(source.contexts);
    }
    if (isRecord(source.debug_meta) && Array.isArray(source.debug_meta.images)) {
        result.debug_meta = {images: source.debug_meta.images.map(scrubDebugImage)};
    }
    return result as T;
}

/** `beforeSend` for every Sentry client. Attachments such as minidumps carry process memory, so they never leave. */
export function beforeSendSentryEvent<T extends object>(event: T, hint: {attachments?: unknown[]}) {
    hint.attachments = [];
    return scrubSentryEvent(event);
}

/** Integrations every client drops: breadcrumbs and page context are not scrubbed text, and the renderer error guard owns global handlers. */
export const SENTRY_EXCLUDED_INTEGRATIONS: ReadonlySet<string> = new Set([
    'Breadcrumbs',
    'BrowserApiErrors',
    'BrowserSession',
    'GlobalHandlers',
    'HttpContext',
]);
