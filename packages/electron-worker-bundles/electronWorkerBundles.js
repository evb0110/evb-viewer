/**
 * @typedef {'pdf-search' | 'pdf-text' | 'pdf-page-ops' | 'image-export-tiff' | 'djvu-engine' | 'ocr-engine-host' | 'ocr-engine'} TWorkerBundleId
 */

/**
 * @typedef {{
 *   id: TWorkerBundleId,
 *   entryPoint: string,
 *   fileName: string,
 *   format: 'esm',
 *   unpacked: boolean,
 * }} IWorkerBundleEntry
 */

/** @type {readonly IWorkerBundleEntry[]} */
export const WORKER_BUNDLES = [
    {
        id: 'pdf-search',
        entryPoint: 'electron/features/search/pdfSearchWorker.ts',
        fileName: 'pdf-search-worker.js',
        format: 'esm',
        unpacked: true,
    },
    {
        id: 'pdf-text',
        entryPoint: 'electron/features/search/pdfTextWorker.ts',
        fileName: 'pdf-text-worker.js',
        format: 'esm',
        unpacked: true,
    },
    {
        id: 'pdf-page-ops',
        entryPoint: 'electron/native-tools/pdfPageOpsWorker.ts',
        fileName: 'pdf-page-ops-worker.js',
        format: 'esm',
        unpacked: true,
    },
    {
        id: 'image-export-tiff',
        entryPoint: 'electron/features/image-export/main/tiffCombineWorker.ts',
        fileName: 'image-export-tiff-worker.js',
        format: 'esm',
        unpacked: true,
    },
    {
        id: 'djvu-engine',
        entryPoint: 'electron/features/djvu/main/djvuEngineWorker.ts',
        fileName: 'djvu-engine-worker.js',
        format: 'esm',
        unpacked: true,
    },
    {
        id: 'ocr-engine-host',
        entryPoint: 'electron/features/ocr/main/ocrEngineHost.ts',
        fileName: 'ocr-engine-host.js',
        format: 'esm',
        unpacked: true,
    },
    {
        id: 'ocr-engine',
        entryPoint: 'electron/features/ocr/main/ocrEngineWorker.ts',
        fileName: 'ocr-engine-worker.js',
        format: 'esm',
        unpacked: true,
    },
];

/** @type {Readonly<Record<TWorkerBundleId, IWorkerBundleEntry>>} */
export const WORKER_BUNDLES_BY_ID = Object.freeze(Object.fromEntries(WORKER_BUNDLES.map((bundle) => [bundle.id, bundle])));
