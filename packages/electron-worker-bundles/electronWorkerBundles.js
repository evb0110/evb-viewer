/**
 * @typedef {'pdf-combine' | 'pdf-conformance' | 'pdf-print-layout' | 'document-save-utility' | 'ocr' | 'scan-cleanup' | 'search' | 'page-ops-crop' | 'image-export-tiff' | 'djvu-pdf'} TWorkerBundleId
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
        id: 'pdf-combine',
        entryPoint: 'electron/image/pdfCombineWorker.ts',
        fileName: 'pdfCombineWorker.js',
        format: 'esm',
        unpacked: true,
    },
    {
        id: 'pdf-conformance',
        entryPoint: 'electron/features/documents/main/pdfConformanceWorker.ts',
        fileName: 'pdfConformanceWorker.js',
        format: 'esm',
        unpacked: true,
    },
    {
        id: 'pdf-print-layout',
        entryPoint: 'electron/features/documents/main/pdfPrintLayoutUtilityProcess.ts',
        fileName: 'pdf-print-layout-utility.js',
        format: 'esm',
        unpacked: true,
    },
    {
        id: 'document-save-utility',
        entryPoint: 'electron/features/documents/main/documentSaveUtilityProcess.ts',
        fileName: 'document-save-utility.js',
        format: 'esm',
        unpacked: true,
    },
    {
        id: 'ocr',
        entryPoint: 'electron/ocr/worker/main.ts',
        fileName: 'ocr-worker.js',
        format: 'esm',
        unpacked: true,
    },
    {
        id: 'scan-cleanup',
        entryPoint: 'electron/features/scan-cleanup/worker/main.ts',
        fileName: 'scan-cleanup-worker.js',
        format: 'esm',
        unpacked: true,
    },
    {
        id: 'search',
        entryPoint: 'electron/features/search/worker.ts',
        fileName: 'search-worker.js',
        format: 'esm',
        unpacked: true,
    },
    {
        id: 'page-ops-crop',
        entryPoint: 'electron/features/page-ops/main/cropWorker.ts',
        fileName: 'page-ops-cropWorker.js',
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
        id: 'djvu-pdf',
        entryPoint: 'electron/features/djvu/main/pdfWorker.ts',
        fileName: 'djvu-pdfWorker.js',
        format: 'esm',
        unpacked: true,
    },
];

/** @type {Readonly<Record<TWorkerBundleId, IWorkerBundleEntry>>} */
export const WORKER_BUNDLES_BY_ID = Object.freeze(
    Object.fromEntries(WORKER_BUNDLES.map(bundle => [
        bundle.id,
        bundle,
    ])),
);
