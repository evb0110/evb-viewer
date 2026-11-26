export type TWorkerBundleId =
    | 'pdf-search'
    | 'pdf-text'
    | 'image-export-tiff'
    | 'djvu-pdf'
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
