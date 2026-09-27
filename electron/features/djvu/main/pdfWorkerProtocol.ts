import type { IPdfBookmarkEntry } from '@contracts/pdfBookmarkEntry';
import type { IWorkerTaskErrorFrame } from '@electron/utils/workerTask';

interface IDjvuPdfBuildTask {
    type: 'buildPdf';
    imagePaths: string[];
    dpi: number;
}

interface IDjvuPdfEstimateTask {
    type: 'estimatePdfSize';
    imagePath: string;
    dpi: number;
}

interface IDjvuPdfBookmarkTask {
    type: 'embedBookmarksInFile';
    inputPdfPath: string;
    outputPdfPath: string;
    bookmarks: IPdfBookmarkEntry[];
}

export type TDjvuPdfWorkerTask =
    | IDjvuPdfBuildTask
    | IDjvuPdfEstimateTask
    | IDjvuPdfBookmarkTask;

export interface IDjvuPdfWorkerProgressMessage {
    type: 'progress';
    phase: 'buildPdf';
    page: number;
    total: number;
}

interface IDjvuPdfWorkerSuccessMessage {
    type: 'result';
    ok: true;
    data: Uint8Array | ArrayBuffer | number;
}

interface IDjvuPdfWorkerErrorMessage {
    type: 'result';
    ok: false;
    error: string;
    errorFrame?: IWorkerTaskErrorFrame;
}

export type TDjvuPdfWorkerMessage =
    | IDjvuPdfWorkerProgressMessage
    | IDjvuPdfWorkerSuccessMessage
    | IDjvuPdfWorkerErrorMessage;
