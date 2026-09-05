import { ensurePdfjsSsrGlobals } from '@app/services/pdfjs/ensurePdfjsSsrGlobals';
import {
    getPdfjsAssetDir,
    getViewerAssetResolver,
} from '@app/utils/viewerAssets';

ensurePdfjsSsrGlobals();

const pdfjsLib = await (
    import.meta.server
        ? import('pdfjs-dist/legacy/build/pdf.mjs')
        : import('pdfjs-dist')
);

type TPdfjsRuntimeLib = typeof pdfjsLib;
type TPdfjsDocumentInit = Parameters<TPdfjsRuntimeLib['getDocument']>[0];

type TPdfjsRuntimeLike = Record<PropertyKey, unknown>;

interface IPdfjsBrowserRuntime {
    version: string;
    getDocument: TPdfjsRuntimeLib['getDocument'];
    GlobalWorkerOptions: {workerSrc?: string};
    VerbosityLevel: {ERRORS: number};
}

interface IPdfjsVendoredAssetVersionOptions {
    force?: boolean;
    readVersionStamp?: (() => Promise<string>) | undefined;
    stampUrl?: string | undefined;
}

const PDFJS_VENDORED_VERSION_STAMP_URL = '/pdf/.pdfjs-version';
const PDFJS_MAX_INTERMEDIATE_CANVAS_BYTES = 128 * 1024 * 1024;

const DEFAULT_ANNOTATION_MODE = {
    DISABLE: 0,
    ENABLE: 1,
    ENABLE_FORMS: 2,
    ENABLE_STORAGE: 3,
};

const DEFAULT_IMAGE_KIND = {
    GRAYSCALE_1BPP: 1,
    RGB_24BPP: 2,
    RGBA_32BPP: 3,
};

const REQUIRED_ANNOTATION_EDITOR_UI_MANAGER_METHODS = [
    'addCommands',
    'addEditListeners',
    'addToAnnotationStorage',
    'delete',
    'destroy',
    'getEditors',
    'getMode',
    'onPageChanging',
    'onScaleChanging',
    'removeEditListeners',
    'setSelected',
    'updateParams',
    'waitForEditorsRendered',
] as const;

const REQUIRED_RUNTIME_FUNCTION_EXPORTS = [
    'AnnotationLayer',
    'AnnotationEditorLayer',
    'AnnotationEditorUIManager',
    'DrawLayer',
    'PDFDateString',
    'TextLayer',
] as const;

const REQUIRED_ANNOTATION_EDITOR_TYPE_KEYS = [
    'DISABLE',
    'NONE',
    'FREETEXT',
    'HIGHLIGHT',
    'STAMP',
    'INK',
    'POPUP',
] as const;

const REQUIRED_ANNOTATION_EDITOR_PARAMS_TYPE_KEYS = [
    'RESIZE',
    'CREATE',
    'FREETEXT_SIZE',
    'FREETEXT_COLOR',
    'INK_COLOR',
    'INK_THICKNESS',
    'INK_OPACITY',
    'HIGHLIGHT_COLOR',
    'HIGHLIGHT_THICKNESS',
    'HIGHLIGHT_FREE',
    'HIGHLIGHT_SHOW_ALL',
    'DRAW_STEP',
] as const;

const REQUIRED_ANNOTATION_MODE_KEYS = [
    'DISABLE',
    'ENABLE',
    'ENABLE_FORMS',
    'ENABLE_STORAGE',
] as const;

const REQUIRED_PIXELS_PER_INCH_KEYS = [
    'CSS',
    'PDF',
    'PDF_TO_CSS_UNITS',
] as const;

let vendoredAssetVersionPromise: Promise<void> | null = null;

function isRuntimeLike(value: unknown): value is TPdfjsRuntimeLike {
    return (typeof value === 'object' && value !== null) || typeof value === 'function';
}

function getRuntimeVersion(runtime: unknown) {
    if (!isRuntimeLike(runtime)) {
        return 'unknown';
    }
    const version = getRuntimeProperty(runtime, 'version');
    return typeof version === 'string' && version.trim().length > 0
        ? version.trim()
        : 'unknown';
}

function getRuntimeProperty(
    runtime: TPdfjsRuntimeLike,
    name: PropertyKey,
) {
    try {
        return name in runtime ? runtime[name] : undefined;
    } catch {
        return undefined;
    }
}

function getRuntimeObject(
    runtime: TPdfjsRuntimeLike,
    name: string,
) {
    const value = getRuntimeProperty(runtime, name);
    return isRuntimeLike(value) ? value : null;
}

function getRuntimeFunctionProbeFailures(
    runtime: TPdfjsRuntimeLike,
    names: readonly string[],
) {
    const failures: string[] = [];
    for (const name of names) {
        if (typeof getRuntimeProperty(runtime, name) !== 'function') {
            failures.push(`${name} export is not a function`);
        }
    }
    return failures;
}

function getRuntimeNumberMapProbeFailures(
    runtime: TPdfjsRuntimeLike,
    name: string,
    keys: readonly string[],
) {
    const value = getRuntimeObject(runtime, name);
    if (!value) {
        return [`${name} export is not an object`];
    }

    return keys.flatMap((key) => {
        const candidate = getRuntimeProperty(value, key);
        return typeof candidate === 'number' && Number.isFinite(candidate)
            ? []
            : [`${name}.${key} is not a finite number`];
    });
}

function hasPrototypeFunction(
    value: unknown,
    method: string,
) {
    if (!isRuntimeLike(value)) {
        return false;
    }
    const prototype = getRuntimeProperty(value, 'prototype');
    return isRuntimeLike(prototype) && typeof getRuntimeProperty(prototype, method) === 'function';
}

function getAnnotationEditorUiManagerProbeFailures(runtime: TPdfjsRuntimeLike) {
    const failures: string[] = [];
    const manager = getRuntimeProperty(runtime, 'AnnotationEditorUIManager');
    if (typeof manager !== 'function') {
        failures.push('AnnotationEditorUIManager export is not a constructor');
        return failures;
    }

    for (const method of REQUIRED_ANNOTATION_EDITOR_UI_MANAGER_METHODS) {
        if (!hasPrototypeFunction(manager, method)) {
            failures.push(`AnnotationEditorUIManager.${method} is missing`);
        }
    }

    return failures;
}

function getPdfDateStringProbeFailures(runtime: TPdfjsRuntimeLike) {
    const value = getRuntimeProperty(runtime, 'PDFDateString');
    if (!isRuntimeLike(value) || typeof getRuntimeProperty(value, 'toDateObject') !== 'function') {
        return ['PDFDateString.toDateObject is missing'];
    }
    return [];
}

function hasWritableWorkerSrc(runtime: TPdfjsRuntimeLike) {
    const globalWorkerOptions = getRuntimeObject(runtime, 'GlobalWorkerOptions');
    if (!globalWorkerOptions) {
        return false;
    }

    const previous = globalWorkerOptions.workerSrc;
    try {
        globalWorkerOptions.workerSrc = previous;
        return true;
    } catch {
        return false;
    }
}

function getBrowserRuntimeProbeFailures(runtime: unknown) {
    if (!isRuntimeLike(runtime)) {
        return ['PDF.js runtime is not an object'];
    }

    const failures: string[] = [];
    const version = getRuntimeProperty(runtime, 'version');
    if (typeof version !== 'string' || version.trim().length === 0) {
        failures.push('version export is missing');
    }
    if (typeof getRuntimeProperty(runtime, 'getDocument') !== 'function') {
        failures.push('getDocument export is not a function');
    }
    if (!hasWritableWorkerSrc(runtime)) {
        failures.push('GlobalWorkerOptions.workerSrc is not writable');
    }
    const verbosityLevel = getRuntimeObject(runtime, 'VerbosityLevel');
    if (!verbosityLevel || typeof getRuntimeProperty(verbosityLevel, 'ERRORS') !== 'number') {
        failures.push('VerbosityLevel.ERRORS is missing');
    }
    if (typeof getRuntimeProperty(runtime, 'PDFDataRangeTransport') !== 'function') {
        failures.push('PDFDataRangeTransport export is not a constructor');
    }
    return failures;
}

function isBrowserAssetVersionCheckRequired(force: boolean | undefined) {
    if (force === true) {
        return true;
    }
    if (typeof fetch !== 'function') {
        return false;
    }

    const locationLike = (globalThis as typeof globalThis & {location?: {protocol?: string} | undefined}).location;
    const protocol = locationLike?.protocol ?? '';
    return protocol === 'http:' || protocol === 'https:' || protocol === 'evb-viewer:';
}

async function fetchPdfjsVendoredVersionStamp(stampUrl: string) {
    const response = await fetch(stampUrl, { cache: 'no-store' });
    if (!response.ok) {
        throw new Error(`PDF.js vendored asset version stamp is unavailable at ${stampUrl}: HTTP ${response.status}`);
    }
    return response.text();
}

function getRuntimeExport<K extends keyof TPdfjsRuntimeLib>(
    name: K,
    fallback?: TPdfjsRuntimeLib[K],
) {
    return (name in pdfjsLib ? pdfjsLib[name] : fallback) as NonNullable<TPdfjsRuntimeLib[K]>;
}

function getMergedRuntimeExport<K extends keyof TPdfjsRuntimeLib, T extends Record<string, unknown>>(
    name: K,
    defaults: T,
) {
    const value = getRuntimeExport(name);
    return {
        ...defaults,
        ...(value && typeof value === 'object' ? value : {}),
    } as TPdfjsRuntimeLib[K] & T;
}

export default pdfjsLib;

export function getPdfjsBrowserRuntimeProbeFailures(runtime: unknown = pdfjsLib) {
    return getBrowserRuntimeProbeFailures(runtime);
}

function assertPdfjsBrowserRuntimeCompatibility(runtime: unknown = pdfjsLib) {
    const failures = getPdfjsBrowserRuntimeProbeFailures(runtime);
    if (failures.length === 0) {
        return;
    }
    throw new Error(`PDF.js browser runtime is incompatible with pdfjs-dist ${getRuntimeVersion(runtime)}: ${failures.join('; ')}`);
}

export function getPdfjsRuntimeProbeFailures(runtime: unknown = pdfjsLib) {
    const browserFailures = getPdfjsBrowserRuntimeProbeFailures(runtime);
    if (!isRuntimeLike(runtime)) {
        return browserFailures;
    }

    return [
        ...browserFailures,
        ...getRuntimeFunctionProbeFailures(runtime, REQUIRED_RUNTIME_FUNCTION_EXPORTS),
        ...getRuntimeNumberMapProbeFailures(runtime, 'AnnotationEditorType', REQUIRED_ANNOTATION_EDITOR_TYPE_KEYS),
        ...getRuntimeNumberMapProbeFailures(runtime, 'AnnotationEditorParamsType', REQUIRED_ANNOTATION_EDITOR_PARAMS_TYPE_KEYS),
        ...getRuntimeNumberMapProbeFailures(runtime, 'AnnotationMode', REQUIRED_ANNOTATION_MODE_KEYS),
        ...getRuntimeNumberMapProbeFailures(runtime, 'PixelsPerInch', REQUIRED_PIXELS_PER_INCH_KEYS),
        ...getAnnotationEditorUiManagerProbeFailures(runtime),
        ...getPdfDateStringProbeFailures(runtime),
    ];
}

export function assertPdfjsRuntimeCompatibility(runtime: unknown = pdfjsLib) {
    const failures = getPdfjsRuntimeProbeFailures(runtime);
    if (failures.length === 0) {
        return;
    }
    throw new Error(`PDF.js app runtime is incompatible with pdfjs-dist ${getRuntimeVersion(runtime)}: ${failures.join('; ')}`);
}

export function configurePdfjsWorkerSrc(runtime: IPdfjsBrowserRuntime = pdfjsLib) {
    assertPdfjsBrowserRuntimeCompatibility(runtime);
    const workerSrc = getViewerAssetResolver().pdfWorkerUrl();
    if (runtime.GlobalWorkerOptions.workerSrc !== workerSrc) {
        runtime.GlobalWorkerOptions.workerSrc = workerSrc;
    }
    return workerSrc;
}

export function createPdfjsDocumentOptions(runtime: IPdfjsBrowserRuntime = pdfjsLib) {
    assertPdfjsBrowserRuntimeCompatibility(runtime);
    return {
        verbosity: runtime.VerbosityLevel.ERRORS,
        standardFontDataUrl: getPdfjsAssetDir('standard_fonts'),
        cMapUrl: getPdfjsAssetDir('cmaps'),
        cMapPacked: true,
        wasmUrl: getPdfjsAssetDir('wasm'),
        iccUrl: getPdfjsAssetDir('iccs'),
        useSystemFonts: false,
        // PDF.js uses this to proportionally downscale oversized intermediate
        // image canvases. Do not use maxImageSize: that option drops images.
        canvasMaxAreaInBytes: PDFJS_MAX_INTERMEDIATE_CANVAS_BYTES,
    } satisfies Partial<TPdfjsDocumentInit>;
}

export async function assertPdfjsVendoredAssetVersion(
    runtime: unknown = pdfjsLib,
    options: IPdfjsVendoredAssetVersionOptions = {},
) {
    if (!isBrowserAssetVersionCheckRequired(options.force)) {
        return;
    }
    const version = isRuntimeLike(runtime) ? getRuntimeProperty(runtime, 'version') : null;
    if (typeof version !== 'string' || version.trim().length === 0) {
        throw new Error('PDF.js vendored asset version cannot be checked because pdfjsLib.version is missing');
    }

    const expectedVersion = version.trim();
    const stampUrl = options.stampUrl ?? PDFJS_VENDORED_VERSION_STAMP_URL;
    const rawStamp = await (
        options.readVersionStamp
            ? options.readVersionStamp()
            : fetchPdfjsVendoredVersionStamp(stampUrl)
    );
    const stampedVersion = rawStamp.trim();
    if (stampedVersion.length === 0) {
        throw new Error(`PDF.js vendored asset version stamp is empty at ${stampUrl}; expected ${expectedVersion}`);
    }
    if (stampedVersion !== expectedVersion) {
        throw new Error(`PDF.js vendored asset version mismatch at ${stampUrl}: installed runtime is ${expectedVersion}, vendored assets are ${stampedVersion}`);
    }
}

async function assertPdfjsVendoredAssetVersionOnce(
    runtime: unknown = pdfjsLib,
    options: IPdfjsVendoredAssetVersionOptions = {},
) {
    if (options.force === true || options.readVersionStamp || options.stampUrl) {
        await assertPdfjsVendoredAssetVersion(runtime, options);
        return;
    }
    vendoredAssetVersionPromise ??= assertPdfjsVendoredAssetVersion(runtime, options);
    await vendoredAssetVersionPromise;
}

export async function preparePdfjsBrowserRuntime(runtime: IPdfjsBrowserRuntime = pdfjsLib) {
    configurePdfjsWorkerSrc(runtime);
    await assertPdfjsVendoredAssetVersionOnce(runtime);
}

export const AnnotationLayer = getRuntimeExport('AnnotationLayer');
export const AnnotationEditorLayer = getRuntimeExport('AnnotationEditorLayer');
export const AnnotationEditorUIManager = getRuntimeExport('AnnotationEditorUIManager');
export const AnnotationMode = getMergedRuntimeExport('AnnotationMode', DEFAULT_ANNOTATION_MODE);
export const DrawLayer = getRuntimeExport('DrawLayer');
export const ImageKind = getMergedRuntimeExport('ImageKind', DEFAULT_IMAGE_KIND);
export const TextLayer = getRuntimeExport('TextLayer');
