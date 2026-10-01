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

    const locationLike: unknown = Reflect.get(globalThis, 'location');
    const protocolValue: unknown = typeof locationLike === 'object' && locationLike !== null
        ? Reflect.get(locationLike, 'protocol')
        : '';
    const protocol = typeof protocolValue === 'string' ? protocolValue : '';
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
export const AnnotationMode = getMergedRuntimeExport('AnnotationMode', DEFAULT_ANNOTATION_MODE);
export const ImageKind = getMergedRuntimeExport('ImageKind', DEFAULT_IMAGE_KIND);
export const TextLayer = getRuntimeExport('TextLayer');
