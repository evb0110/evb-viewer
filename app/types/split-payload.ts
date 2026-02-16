export interface IEmptySplitPayload {kind: 'empty';}

export interface IDjvuSplitPayload {
    kind: 'djvu';
    sourcePath: string;
}

export interface IPdfSnapshotSplitPayload {
    kind: 'pdfSnapshot';
    fileName: string;
    originalPath: string | null;
    data: Uint8Array;
    isDirty: boolean;
}

export type TSplitPayload = IEmptySplitPayload | IDjvuSplitPayload | IPdfSnapshotSplitPayload;
