/* eslint-disable @typescript-eslint/naming-convention */

export const MAX_CANONICAL_APP_FRAMES = 64;
export const MAX_CANONICAL_FRAME_MODULE_LENGTH = 512;
export const MAX_CANONICAL_FRAME_FUNCTION_LENGTH = 256;
export const MAX_CANONICAL_FRAME_COORDINATE = Number.MAX_SAFE_INTEGER;
const MAX_CANONICAL_FRAME_CANDIDATES = MAX_CANONICAL_APP_FRAMES * 8;

export interface CanonicalAppFrame {
    module: string;
    function?: string;
    line?: number;
    column?: number;
}

export interface CanonicalDebugImage {code_file: string;}

export interface CanonicalDebugMeta {images: readonly CanonicalDebugImage[];}

export interface CanonicalApplicationFrameNormalization {
    frames: readonly CanonicalAppFrame[];
    debugMeta: CanonicalDebugMeta;
}

interface ParsedStackFrame {
    source: unknown;
    functionName?: unknown;
    line?: unknown;
    column?: unknown;
}

const APPLICATION_SOURCE_ROOTS = new Set([
    'app',
    'electron',
    'landing',
    'packages',
    'server',
]);

const BUNDLE_SOURCE_ROOTS = new Set([
    '.nuxt',
    '.output',
    '_nuxt',
    'dist-electron',
    'node_modules',
    'vendor',
]);

const NON_APPLICATION_BUNDLE_PREFIXES = [
    'node_modules/.pnpm/@vitest+',
    'node_modules/.pnpm/vitest@',
    'node_modules/@vitest/',
    'node_modules/vitest/',
] as const;

const TRUSTED_ORIGIN_HOSTS = new Set([
    '127.0.0.1',
    '0.0.0.0',
    '::1',
    'localhost',
    'evb-viewer.com',
    'www.evb-viewer.com',
    'web.evb-viewer.com',
]);

const WRAPPER_FUNCTIONS = new Set([
    '__commonjs',
    '__to_common_js',
    '__to_esm',
    '__tocommonjs',
    '__toesm',
    '__vite__mapdeps',
    '__vitepreload',
    '__vite_ssr_dynamic_import__',
    '__vite_ssr_exports__',
    '__vite_ssr_import__',
    '__webpack_modules__',
    '__webpack_require__',
    'apply',
    'call',
    'eval',
    'module._compile',
    'module._extensions..js',
    'new promise',
    'object.<anonymous>',
    'processticksandrejections',
    'runmicrotasks',
    'webpackbootstrap',
    'webpackuniversalmoduledefinition',
]);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return false;
    }
    try {
        const prototype = Reflect.getPrototypeOf(value);
        return prototype === Object.prototype || prototype === null;
    } catch {
        return false;
    }
}

function hasUnsafeCharacters(value: string) {
    return value.split('').some(character => {
        const codePoint = character.codePointAt(0);
        return codePoint !== undefined && (codePoint < 0x20 || codePoint === 0x7f);
    });
}

function isUnknownArray(value: unknown): value is unknown[] {
    return Array.isArray(value);
}

function decodePathComponent(value: string): string | null {
    try {
        return decodeURIComponent(value);
    } catch {
        return null;
    }
}

function splitPath(value: string): string[] | null {
    const decoded = decodePathComponent(value.replaceAll('\\', '/'));
    if (decoded === null || hasUnsafeCharacters(decoded)) {
        return null;
    }

    const segments = decoded.split('/').filter(segment => segment.length > 0 && segment !== '.');
    if (segments.some(segment => segment === '..' || segment.includes('\0'))) {
        return null;
    }
    return segments;
}

function isProjectRootSegment(segment: string) {
    return /^evb-viewer(?:-[A-Za-z0-9._]+)?$/u.test(segment);
}

function isTrustedOriginHost(hostname: string) {
    const normalized = hostname.toLowerCase();
    if (TRUSTED_ORIGIN_HOSTS.has(normalized)) {
        return true;
    }
    try {
        return globalThis.location.hostname.toLowerCase() === normalized;
    } catch {
        return false;
    }
}

interface ExtractedPath {
    path: string;
    trustedOrigin: boolean;
    absolute: boolean;
    sourceMap: boolean;
}

function extractPath(value: string): ExtractedPath | null {
    const raw = value.trim();
    if (raw.length === 0 || hasUnsafeCharacters(raw)) {
        return null;
    }

    if (/^(?:evb-viewer|https?|file|webpack|vite):/iu.test(raw)) {
        try {
            const url = new URL(raw);
            const protocol = url.protocol.toLowerCase();
            const trustedOrigin = protocol === 'file:'
                || (protocol === 'http:' || protocol === 'https:') && isTrustedOriginHost(url.hostname)
                || protocol === 'evb-viewer:' && url.hostname === 'app'
                || (protocol === 'webpack:' || protocol === 'vite:')
                    && (url.hostname.length === 0 || url.hostname === '.' || url.hostname === 'evb-viewer');
            if (!trustedOrigin) {
                return null;
            }
            const decodedPath = decodePathComponent(url.pathname);
            if (decodedPath === null) {
                return null;
            }
            return {
                path: decodedPath,
                trustedOrigin: true,
                absolute: true,
                sourceMap: protocol === 'webpack:' || protocol === 'vite:',
            };
        } catch {
            return null;
        }
    }

    const withoutQuery = raw.split(/[?#]/u, 1)[0];
    if (withoutQuery === undefined || withoutQuery.length === 0) {
        return null;
    }
    const normalized = withoutQuery.replaceAll('\\', '/');
    return {
        path: normalized,
        trustedOrigin: false,
        absolute: normalized.startsWith('/') || /^[A-Za-z]:\//u.test(normalized),
        sourceMap: false,
    };
}

function canonicalizePath(value: unknown): string | null {
    if (typeof value !== 'string') {
        return null;
    }

    const extracted = extractPath(value);
    if (extracted === null) {
        return null;
    }

    const path = extracted.path.replace(/^\/+/u, '');
    const segments = splitPath(path);
    if (segments === null || segments.length === 0) {
        return null;
    }

    if (segments[0] !== undefined && /^[A-Za-z]:$/u.test(segments[0])) {
        segments.shift();
    }

    let canonicalSegments: string[] | null = null;
    const projectRootIndex = segments.findIndex(isProjectRootSegment);
    if (projectRootIndex >= 0) {
        canonicalSegments = segments.slice(projectRootIndex + 1);
    } else {
        const asarIndex = segments.findIndex(segment => segment.toLowerCase() === 'app.asar');
        if (asarIndex >= 0) {
            canonicalSegments = segments.slice(asarIndex + 1);
        } else if (
            extracted.absolute
            && segments[0] === 'var'
            && segments[1] === 'task'
        ) {
            const outputServerIndex = segments.findIndex((segment, index) => (
                segment === '.output' && segments[index + 1] === 'server'
            ));
            const serverChunksIndex = segments.findIndex((segment, index) => (
                segment === 'server' && segments[index + 1] === 'chunks'
            ));
            if (outputServerIndex >= 0) {
                canonicalSegments = segments.slice(outputServerIndex);
            } else if (serverChunksIndex >= 0) {
                canonicalSegments = [
                    'server-bundle',
                    ...segments.slice(serverChunksIndex + 1),
                ];
            }
        } else if (!extracted.absolute || extracted.trustedOrigin || extracted.sourceMap) {
            canonicalSegments = segments;
        }
    }

    if (canonicalSegments === null || canonicalSegments.length === 0) {
        return null;
    }

    if (
        canonicalSegments[0] === '.output'
        && canonicalSegments[1] === 'public'
        && canonicalSegments[2] === '_nuxt'
    ) {
        canonicalSegments = [
            '_nuxt',
            ...canonicalSegments.slice(3),
        ];
    } else if (
        canonicalSegments[0] === '.output'
        && canonicalSegments[1] === 'server'
    ) {
        canonicalSegments = [
            'server-bundle',
            ...canonicalSegments.slice(2),
        ];
    }

    const firstSegment = canonicalSegments[0];
    if (
        firstSegment === undefined
        || (!APPLICATION_SOURCE_ROOTS.has(firstSegment) && !BUNDLE_SOURCE_ROOTS.has(firstSegment)
            && firstSegment !== 'server-bundle')
    ) {
        return null;
    }

    const normalized = canonicalSegments.join('/');
    if (NON_APPLICATION_BUNDLE_PREFIXES.some(prefix => normalized.startsWith(prefix))) {
        return null;
    }
    return normalized.length > 0 && normalized.length <= MAX_CANONICAL_FRAME_MODULE_LENGTH
        ? normalized
        : null;
}

export function normalizeCanonicalApplicationModule(value: unknown): string | null {
    return canonicalizePath(value);
}

function normalizeFunctionName(value: unknown): string | undefined {
    if (typeof value !== 'string') {
        return undefined;
    }
    let normalized = value.trim();
    normalized = normalized.replace(/^async\s+/u, '').replace(/^new\s+/u, '');
    if (
        normalized.length === 0
        || normalized.length > MAX_CANONICAL_FRAME_FUNCTION_LENGTH
        || hasUnsafeCharacters(normalized)
        || normalized.includes('/')
        || normalized.includes('\\')
        || normalized.includes('?')
        || normalized.includes('#')
        || normalized.includes('://')
        || !/^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*|\.<anonymous>)*(?:\s+\[as\s+[A-Za-z_$][A-Za-z0-9_$]*\])?$/u.test(normalized)
    ) {
        return undefined;
    }

    return normalized;
}

function isWrapperFunction(value: string | undefined) {
    if (value === undefined) {
        return false;
    }
    const normalized = value.toLowerCase().replaceAll(' ', '');
    return WRAPPER_FUNCTIONS.has(normalized)
        || normalized.startsWith('__vite_ssr_import__')
        || normalized.startsWith('__webpack_require__');
}

function normalizeCoordinate(value: unknown): number | undefined {
    return typeof value === 'number'
        && Number.isSafeInteger(value)
        && value >= 1
        && value <= MAX_CANONICAL_FRAME_COORDINATE
        ? value
        : undefined;
}

function parseStackLine(value: string): ParsedStackFrame | null {
    let candidate = value.trim();
    if (candidate.length === 0) {
        return null;
    }
    if (candidate.startsWith('at ')) {
        candidate = candidate.slice(3).trim();
    }

    const locationMatch = candidate.match(/:(\d+)(?::(\d+))?\)?$/u);
    let line: number | undefined;
    let column: number | undefined;
    if (locationMatch !== null && locationMatch.index !== undefined) {
        const parsedLine = Number(locationMatch[1]);
        line = normalizeCoordinate(parsedLine);
        if (line === undefined) {
            return null;
        }
        if (locationMatch[2] !== undefined) {
            column = normalizeCoordinate(Number(locationMatch[2]));
            if (column === undefined) {
                return null;
            }
        }
        candidate = candidate.slice(0, locationMatch.index).trim();
    }

    let functionName: string | undefined;
    let source = candidate;
    const functionLocationIndex = candidate.lastIndexOf(' (');
    if (functionLocationIndex >= 0) {
        functionName = candidate.slice(0, functionLocationIndex).trim();
        source = candidate.slice(functionLocationIndex + 2).trim();
    } else {
        const functionSeparatorIndex = candidate.indexOf('@');
        if (functionSeparatorIndex > 0) {
            functionName = candidate.slice(0, functionSeparatorIndex).trim();
            source = candidate.slice(functionSeparatorIndex + 1).trim();
        }
    }

    if (source.startsWith('eval at ') || source === '<anonymous>' || source === 'native') {
        return null;
    }
    return {
        source,
        ...(functionName === undefined ? {} : {functionName}),
        ...(line === undefined ? {} : {line}),
        ...(column === undefined ? {} : {column}),
    };
}

function parseObjectFrame(value: Record<string, unknown>): ParsedStackFrame | null {
    const allowedKeys = new Set([
        'module',
        'filename',
        'fileName',
        'source',
        'url',
        'function',
        'functionName',
        'line',
        'lineno',
        'column',
        'colno',
    ]);
    try {
        const keys = Reflect.ownKeys(value);
        if (keys.some(key => typeof key !== 'string' || !allowedKeys.has(key))) {
            return null;
        }

        const sourceKeys = [
            'module',
            'filename',
            'fileName',
            'source',
            'url',
        ]
            .filter(key => Object.hasOwn(value, key));
        const [sourceKey] = sourceKeys;
        if (sourceKey === undefined || sourceKeys.length > 1) {
            return null;
        }
        const functionKeys = [
            'function',
            'functionName',
        ].filter(key => Object.hasOwn(value, key));
        const lineKeys = [
            'line',
            'lineno',
        ].filter(key => Object.hasOwn(value, key));
        const columnKeys = [
            'column',
            'colno',
        ].filter(key => Object.hasOwn(value, key));
        if (functionKeys.length > 1 || lineKeys.length > 1 || columnKeys.length > 1) {
            return null;
        }
        const [functionKey] = functionKeys;
        const [lineKey] = lineKeys;
        const [columnKey] = columnKeys;
        return {
            source: value[sourceKey],
            ...(functionKey === undefined ? {} : {functionName: value[functionKey]}),
            ...(lineKey === undefined ? {} : {line: value[lineKey]}),
            ...(columnKey === undefined ? {} : {column: value[columnKey]}),
        };
    } catch {
        return null;
    }
}

function parseFrame(value: unknown): ParsedStackFrame | null {
    if (typeof value === 'string') {
        return parseStackLine(value);
    }
    return isPlainRecord(value) ? parseObjectFrame(value) : null;
}

function normalizeFrame(value: unknown): CanonicalAppFrame | null {
    const parsed = parseFrame(value);
    if (parsed === null) {
        return null;
    }
    const module = normalizeCanonicalApplicationModule(parsed.source);
    if (module === null) {
        return null;
    }
    const functionName = normalizeFunctionName(parsed.functionName);
    if (isWrapperFunction(functionName)) {
        return null;
    }

    const line = parsed.line === undefined
        ? undefined
        : normalizeCoordinate(parsed.line);
    const column = parsed.column === undefined
        ? undefined
        : normalizeCoordinate(parsed.column);
    if ((parsed.line !== undefined && line === undefined)
        || (parsed.column !== undefined && column === undefined)) {
        return null;
    }

    return {
        module,
        ...(functionName === undefined ? {} : {function: functionName}),
        ...(line === undefined ? {} : {line}),
        ...(column === undefined ? {} : {column}),
    };
}

function normalizeFrames(value: unknown): CanonicalAppFrame[] {
    const values = typeof value === 'string'
        ? value.split('\n', MAX_CANONICAL_FRAME_CANDIDATES)
        : isUnknownArray(value) ? value : [];
    const frames: CanonicalAppFrame[] = [];
    const candidateLimit = Math.min(values.length, MAX_CANONICAL_FRAME_CANDIDATES);
    for (let index = 0; index < candidateLimit && frames.length < MAX_CANONICAL_APP_FRAMES; index += 1) {
        if (!Object.hasOwn(values, index)) {
            continue;
        }
        const frame = normalizeFrame(values[index]);
        if (frame !== null) {
            frames.push(frame);
        }
    }
    return frames;
}

function normalizeDebugMeta(value: unknown): CanonicalDebugMeta {
    if (!isPlainRecord(value) || !isUnknownArray(value.images)) {
        return {images: []};
    }

    const images: CanonicalDebugImage[] = [];
    for (let index = 0; index < value.images.length && images.length < MAX_CANONICAL_APP_FRAMES; index += 1) {
        if (!Object.hasOwn(value.images, index)) {
            continue;
        }
        const image = value.images[index];
        if (!isPlainRecord(image) || typeof image.code_file !== 'string') {
            continue;
        }
        const codeFile = normalizeCanonicalApplicationModule(image.code_file);
        if (codeFile === null || images.some(candidate => candidate.code_file === codeFile)) {
            continue;
        }
        images.push({code_file: codeFile});
    }
    return {images};
}

export function decodeCanonicalAppFrame(value: unknown): CanonicalAppFrame | null {
    if (!isPlainRecord(value)) {
        return null;
    }
    try {
        const keys = Reflect.ownKeys(value);
        const allowedKeys = new Set([
            'module',
            'function',
            'line',
            'column',
        ]);
        if (keys.some(key => typeof key !== 'string' || !allowedKeys.has(key))) {
            return null;
        }
        if (!Object.hasOwn(value, 'module')) {
            return null;
        }
        const module = normalizeCanonicalApplicationModule(value.module);
        if (module === null || module !== value.module) {
            return null;
        }
        if (
            (Object.hasOwn(value, 'function') && value.function === undefined)
            || (Object.hasOwn(value, 'line') && value.line === undefined)
            || (Object.hasOwn(value, 'column') && value.column === undefined)
        ) {
            return null;
        }
        const functionValue = Object.hasOwn(value, 'function') ? value.function : undefined;
        const lineValue = Object.hasOwn(value, 'line') ? value.line : undefined;
        const columnValue = Object.hasOwn(value, 'column') ? value.column : undefined;
        const functionName = functionValue === undefined
            ? undefined
            : normalizeFunctionName(functionValue);
        if (functionValue !== undefined && (functionName === undefined || isWrapperFunction(functionName))) {
            return null;
        }
        const line = lineValue === undefined ? undefined : normalizeCoordinate(lineValue);
        const column = columnValue === undefined ? undefined : normalizeCoordinate(columnValue);
        if ((lineValue !== undefined && line === undefined)
            || (columnValue !== undefined && column === undefined)) {
            return null;
        }
        return {
            module,
            ...(functionName === undefined ? {} : {function: functionName}),
            ...(line === undefined ? {} : {line}),
            ...(column === undefined ? {} : {column}),
        };
    } catch {
        return null;
    }
}

export function isCanonicalAppFrame(value: unknown): value is CanonicalAppFrame {
    return decodeCanonicalAppFrame(value) !== null;
}

export function normalizeCanonicalApplicationFrames(
    stackOrInput: unknown,
    debugMetaValue?: unknown,
): CanonicalApplicationFrameNormalization {
    let stack = stackOrInput;
    let debugMeta = debugMetaValue;
    if (isPlainRecord(stackOrInput)) {
        if (Object.hasOwn(stackOrInput, 'stack')) {
            stack = stackOrInput.stack;
        } else if (Object.hasOwn(stackOrInput, 'frames')) {
            stack = stackOrInput.frames;
        }
        if (debugMeta === undefined) {
            debugMeta = Object.hasOwn(stackOrInput, 'debugMeta')
                ? stackOrInput.debugMeta
                : stackOrInput.debug_meta;
        }
    }

    return {
        frames: normalizeFrames(stack),
        debugMeta: normalizeDebugMeta(debugMeta),
    };
}

export const normalizeCanonicalAppFrames = normalizeCanonicalApplicationFrames;
export const parseCanonicalApplicationFrames = normalizeCanonicalApplicationFrames;
