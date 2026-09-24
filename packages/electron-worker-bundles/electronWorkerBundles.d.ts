export type TWorkerBundleId =
    | 'pdf-combine'
    | 'pdf-conformance'
    | 'pdf-print-layout'
    | 'document-save-utility'
    | 'scan-cleanup'
    | 'search'
    | 'page-ops-crop'
    | 'image-export-tiff'
    | 'djvu-pdf';

export interface IWorkerBundleEntry {
    id: TWorkerBundleId;
    entryPoint: string;
    fileName: string;
    format: 'esm';
    unpacked: boolean;
}

export const WORKER_BUNDLES: readonly IWorkerBundleEntry[];
export const WORKER_BUNDLES_BY_ID: Readonly<Record<TWorkerBundleId, IWorkerBundleEntry>>;
