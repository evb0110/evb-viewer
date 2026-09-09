import {
    describe,
    expect,
    it,
} from 'vitest';
import { resolveWorkerPaths } from '@electron/features/ocr/worker/resolveWorkerPaths';

const requiredWorkerPaths = {
    tesseractBinary: '/bin/tesseract',
    tessdataPath: '/share/tessdata',
    pdftoppmBinary: '/bin/pdftoppm',
    qpdfBinary: '/bin/qpdf',
    tempDir: '/tmp/ocr',
};

describe('resolveWorkerPaths', () => {
    it('accepts required and optional OCR worker paths', () => {
        expect(resolveWorkerPaths({
            ...requiredWorkerPaths,
            pdftotextBinary: '/bin/pdftotext',
            pdfimagesBinary: '/bin/pdfimages',
            popplerDataDir: '/share/poppler',
            popplerFontConfigDir: '/share/fontconfig',
            pdfPageOpsBinary: '/bin/evb-pdf-page-ops',
            unpaperBinary: '/bin/unpaper',
        })).toEqual({
            ...requiredWorkerPaths,
            pdftotextBinary: '/bin/pdftotext',
            pdfimagesBinary: '/bin/pdfimages',
            popplerDataDir: '/share/poppler',
            popplerFontConfigDir: '/share/fontconfig',
            pdfPageOpsBinary: '/bin/evb-pdf-page-ops',
            unpaperBinary: '/bin/unpaper',
        });
    });

    it('normalizes missing or blank optional paths to undefined', () => {
        expect(resolveWorkerPaths({
            ...requiredWorkerPaths,
            pdftotextBinary: '',
            pdfimagesBinary: '',
            pdfPageOpsBinary: '',
            popplerDataDir: '   ',
        })).toEqual(requiredWorkerPaths);
    });

    it('does not require pdftotext for the OCR worker pipeline', () => {
        expect(resolveWorkerPaths(requiredWorkerPaths)).toEqual(requiredWorkerPaths);
    });

    it('rejects missing required OCR worker paths', () => {
        expect(() => resolveWorkerPaths({
            ...requiredWorkerPaths,
            qpdfBinary: '',
        })).toThrow('Invalid OCR workerData.qpdfBinary path');
    });
});
