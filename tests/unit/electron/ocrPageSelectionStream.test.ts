import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    getLastOcrSelectionPage,
    getOcrSelectionLanguages,
    normalizeOcrPageSelection,
} from '@electron/features/ocr/worker/ocrPageSelectionStream';
import {requirePageNumber} from '@contracts/pageNumbers';
import type {IOcrSearchablePdfPage} from '@contracts/electronApiOcr';
import type {TOcrPdfPageSelection} from '@electron/ocr/worker/types';

function page(pageNumber: number, languages: string[] = ['eng']): IOcrSearchablePdfPage {
    return {
        pageNumber: requirePageNumber(pageNumber),
        languages,
    };
}

describe('OCR page selection stream helpers', () => {
    it('finds the last page for every selection shape', () => {
        expect(getLastOcrSelectionPage([
            page(4),
            page(9),
        ])).toBe(9);
        expect(getLastOcrSelectionPage({
            kind: 'all',
            pageCount: 12,
            languages: ['eng'],
        })).toBe(12);
        expect(getLastOcrSelectionPage({
            kind: 'range',
            firstPage: 3,
            lastPage: 7,
            languages: ['eng'],
        })).toBe(7);
        expect(getLastOcrSelectionPage({
            kind: 'ranges',
            ranges: [
                {
                    firstPage: 2,
                    lastPage: 4,
                },
                {
                    firstPage: 10,
                    lastPage: 11,
                },
            ],
            languages: ['eng'],
        })).toBe(11);
        expect(getLastOcrSelectionPage({
            kind: 'pages',
            pages: [page(6)],
        })).toBe(6);
        expect(getLastOcrSelectionPage([])).toBe(0);
        expect(getLastOcrSelectionPage({
            kind: 'ranges',
            ranges: [],
            languages: ['eng'],
        })).toBe(0);
    });

    it('deduplicates languages across scalar and explicit page selections', () => {
        expect(getOcrSelectionLanguages({
            kind: 'all',
            pageCount: 3,
            languages: [
                'eng',
                'rus',
                'eng',
            ],
        })).toEqual([
            'eng',
            'rus',
        ]);
        expect(getOcrSelectionLanguages([
            page(1, [
                'eng',
                'rus',
            ]),
            page(2, [
                'rus',
                'deu',
            ]),
        ])).toEqual([
            'eng',
            'rus',
            'deu',
        ]);
        expect(getOcrSelectionLanguages({
            kind: 'pages',
            pages: [
                page(1, ['eng']),
                page(2, [
                    'eng',
                    'deu',
                ]),
            ],
        })).toEqual([
            'eng',
            'deu',
        ]);
    });

    it('sorts explicit pages while preserving scalar selections', () => {
        const explicitPages: TOcrPdfPageSelection = [
            page(5),
            page(2),
        ];
        expect(normalizeOcrPageSelection(explicitPages)).toEqual([
            page(2),
            page(5),
        ]);

        const pagesSelection: TOcrPdfPageSelection = {
            kind: 'pages',
            pages: [
                page(8),
                page(3),
            ],
        };
        expect(normalizeOcrPageSelection(pagesSelection)).toEqual({
            kind: 'pages',
            pages: [
                page(3),
                page(8),
            ],
        });

        const rangeSelection: TOcrPdfPageSelection = {
            kind: 'range',
            firstPage: 4,
            lastPage: 6,
            languages: ['eng'],
        };
        expect(normalizeOcrPageSelection(rangeSelection)).toBe(rangeSelection);
    });

    it('rejects duplicate explicit page numbers', () => {
        expect(() => normalizeOcrPageSelection([
            page(2),
            page(2, ['rus']),
        ])).toThrow('Duplicate OCR page number 2');
        expect(() => normalizeOcrPageSelection({
            kind: 'pages',
            pages: [
                page(4),
                page(4),
            ],
        })).toThrow('Duplicate OCR page number 4');
    });
});
