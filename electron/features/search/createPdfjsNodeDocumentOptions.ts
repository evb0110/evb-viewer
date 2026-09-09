import { existsSync } from 'fs';
import {
    join,
    sep,
} from 'path';
import { pathToFileURL } from 'url';
import type { DocumentInitParameters } from 'pdfjs-dist/types/src/display/api';

interface IPdfjsRuntimeWithVerbosity { VerbosityLevel?: {ERRORS?: number;}; }

const PDFJS_NODE_MAX_INTERMEDIATE_CANVAS_BYTES = 128 * 1024 * 1024;

let pdfjsAssetRoot: string | null = null;

function getElectronResourcesPath() {
    const resourcesPath = (process as NodeJS.Process & {resourcesPath?: unknown}).resourcesPath;
    return typeof resourcesPath === 'string' && resourcesPath.length > 0 ? resourcesPath : null;
}

function getPdfjsAssetRootCandidates() {
    const candidates: string[] = [];
    const resourcesPath = getElectronResourcesPath();
    if (resourcesPath) {
        candidates.push(
            join(resourcesPath, 'app.asar', 'nuxt-output', 'public', 'pdf'),
            join(resourcesPath, 'app', 'nuxt-output', 'public', 'pdf'),
        );
    }
    candidates.push(
        join(process.cwd(), 'nuxt-output', 'public', 'pdf'),
        join(process.cwd(), 'public', 'pdf'),
    );
    return candidates;
}

function resolvePdfjsAssetRoot() {
    if (pdfjsAssetRoot) {
        return pdfjsAssetRoot;
    }

    for (const candidate of getPdfjsAssetRootCandidates()) {
        if (existsSync(join(candidate, 'standard_fonts'))) {
            pdfjsAssetRoot = candidate;
            return pdfjsAssetRoot;
        }
    }

    throw new Error(`PDF.js asset root is missing. Checked: ${getPdfjsAssetRootCandidates().join(', ')}`);
}

function toDirectoryFileUrl(path: string) {
    const pathWithTrailingSeparator = path.endsWith(sep) ? path : `${path}${sep}`;
    return pathToFileURL(pathWithTrailingSeparator).href;
}

function resolvePdfjsAssetDirUrl(directoryName: string) {
    const assetDir = join(resolvePdfjsAssetRoot(), directoryName);
    if (!existsSync(assetDir)) {
        throw new Error(`PDF.js asset directory is missing: ${assetDir}`);
    }
    return toDirectoryFileUrl(assetDir);
}

export function createPdfjsNodeDocumentOptions(
    runtime?: IPdfjsRuntimeWithVerbosity,
) {
    return {
        ...(typeof runtime?.VerbosityLevel?.ERRORS === 'number'
            ? {verbosity: runtime.VerbosityLevel.ERRORS}
            : {}),
        standardFontDataUrl: resolvePdfjsAssetDirUrl('standard_fonts'),
        cMapUrl: resolvePdfjsAssetDirUrl('cmaps'),
        cMapPacked: true,
        wasmUrl: resolvePdfjsAssetDirUrl('wasm'),
        iccUrl: resolvePdfjsAssetDirUrl('iccs'),
        useSystemFonts: false,
        useWorkerFetch: false,
        canvasMaxAreaInBytes: PDFJS_NODE_MAX_INTERMEDIATE_CANVAS_BYTES,
    } satisfies Partial<DocumentInitParameters>;
}
