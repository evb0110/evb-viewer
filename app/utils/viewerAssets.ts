interface IViewerAssetResolver {
    pdfWorkerUrl(): string;
    pdfAssetUrl(path: string): string;
    standardFontUrl(fileName: string): string;
}

const PDF_ASSET_BASE_URL = '/pdf/';
const PDF_WORKER_FILE = 'pdf.worker.min.mjs';
const STANDARD_FONT_DIR = 'standard_fonts/';

function trimLeadingSlash(path: string) {
    return path.replace(/^\/+/u, '');
}

function ensureTrailingSlash(path: string) {
    return path.endsWith('/') ? path : `${path}/`;
}

const browserViewerAssets = {
    pdfWorkerUrl() {
        return `${PDF_ASSET_BASE_URL}${PDF_WORKER_FILE}`;
    },
    pdfAssetUrl(path: string) {
        return `${PDF_ASSET_BASE_URL}${trimLeadingSlash(path)}`;
    },
    standardFontUrl(fileName: string) {
        return `${PDF_ASSET_BASE_URL}${STANDARD_FONT_DIR}${trimLeadingSlash(fileName)}`;
    },
} satisfies IViewerAssetResolver;

export function getViewerAssetResolver(): IViewerAssetResolver {
    return browserViewerAssets;
}

export function getPdfjsAssetDir(path: string) {
    return ensureTrailingSlash(getViewerAssetResolver().pdfAssetUrl(path));
}
