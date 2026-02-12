import type { IOcrWord } from '../../../app/types/shared';

export interface IWorkerPaths {
    tesseractBinary: string;
    tessdataPath: string;
    pdftoppmBinary: string;
    pdfimagesBinary?: string;
    qpdfBinary: string;
    tempDir: string;
}

export type TWorkerLog = (level: 'debug' | 'warn' | 'error', message: string) => void;

export interface IOcrPdfPageRequest {
    pageNumber: number;
    languages: string[];
}

export interface IOcrPageWithWords {
    pageNumber: number;
    words: IOcrWord[];
    text: string;
    imageWidth: number;
    imageHeight: number;
}

export interface IOcrFileResult {
    success: boolean;
    pageData: IOcrPageWithWords | null;
    pdfPath: string | null;
    error?: string;
}

export type TRotation = 0 | 90 | 180 | 270;


export interface IOcrIndexV2Manifest {
    version: 2;
    createdAt: number;
    source: { pdfPath: string };
    pageCount: number;
    pageBox: 'crop';
    ocr: {
        engine: 'tesseract';
        languages: string[];
        renderDpi: number;
    };
    pages: Record<number, { path: string }>;
}

export interface IOcrIndexV2Page {
    pageNumber: number;
    rotation: TRotation;
    render: {
        dpi: number;
        imagePx: {
            w: number;
            h: number;
        };
    };
    text: string;
    words: IOcrWord[];
}

export interface IRunCommandResult {
    stdout: string;
    stderr: string;
    exitCode: number;
}
