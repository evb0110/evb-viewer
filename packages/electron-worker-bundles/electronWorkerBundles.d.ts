export type TWorkerBundleId =
    | 'pdf-search'
    | 'pdf-text'
    | 'pdf-page-ops'
    | 'image-export-tiff'
    | 'djvu-engine'
    | 'ocr-engine-host'
    | 'ocr-engine';

export interface IWorkerBundleEntry {
    id: TWorkerBundleId;
    entryPoint: string;
    fileName: string;
    format: 'esm';
    unpacked: boolean;
}

export const WORKER_BUNDLES: readonly IWorkerBundleEntry[];
export const WORKER_BUNDLES_BY_ID: Readonly<Record<TWorkerBundleId, IWorkerBundleEntry>>;
