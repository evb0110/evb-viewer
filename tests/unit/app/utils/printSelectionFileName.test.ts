import {describe, expect, it} from 'vitest';
import {buildPrintSelectionFileName} from '@app/utils/buildPrintSelectionFileName';

const formatters = {
    formatPage: (page: number) => `page ${String(page)}`,
    formatPages: (pages: string) => `pages ${pages}`,
    formatSelection: (selection: {count: number; first: number; last: number; fingerprint: string}) =>
        `pages ${String(selection.count)}-selected_${String(selection.first)}-to-${String(selection.last)}` +
        `_id-${selection.fingerprint}`,
};

function buildFileName(options?: {fileName?: string | null; pageNumbers?: number[]; totalPages?: number}) {
    return buildPrintSelectionFileName({
        fileName: options?.fileName ?? 'document.pdf',
        pageNumbers: options?.pageNumbers,
        totalPages: options?.totalPages ?? 20,
        ...formatters,
    });
}

describe('print selection file names', () => {
    it('keeps the source name when all pages are printed', () => {
        expect(buildFileName()).toBe('document.pdf');
        expect(
            buildFileName({
                pageNumbers: [3, 1, 2],
                totalPages: 3,
            }),
        ).toBe('document.pdf');
    });

    it('sanitizes and bounds all-page print names without adding a page label', () => {
        const longStem = `folder/${'Ա'.repeat(240)}:approved`;
        const fileName = buildFileName({fileName: longStem});

        expect(new TextEncoder().encode(fileName).byteLength).toBeLessThanOrEqual(180);
        expect(fileName.length).toBeLessThanOrEqual(180);
        expect(fileName).toMatch(/~\.pdf$/u);
        expect(fileName).not.toContain(':');
        expect(buildFileName({fileName: 'notes'})).toBe('notes.pdf');
    });

    it('adds the page number for a one-page selection', () => {
        expect(
            buildFileName({
                fileName: 'source.PDF',
                pageNumbers: [4],
            }),
        ).toBe('source - page 4.pdf');
    });

    it('compresses contiguous page selections into a range', () => {
        const pageNumbers = [6, 4, 5];

        expect(buildFileName({pageNumbers})).toBe('document - pages 4-6.pdf');
    });

    it('joins disjoint ranges with underscores instead of commas', () => {
        const pageNumbers = [12, 4, 5, 6, 8, 11, 4];
        const fileName = buildFileName({pageNumbers});

        expect(fileName).toBe('document - pages 4-6_8_11-12.pdf');
        expect(fileName).not.toContain(',');
    });

    it('normalizes invalid page numbers before describing the selection', () => {
        const pageNumbers = [0, 7, 7, 3.5, 21];

        expect(buildFileName({pageNumbers})).toBe('document - page 7.pdf');
    });

    it('adds a PDF extension when the source name does not have one', () => {
        expect(
            buildFileName({
                fileName: 'notes',
                pageNumbers: [2],
            }),
        ).toBe('notes - page 2.pdf');
    });

    it('uses a bounded deterministic summary for highly fragmented selections', () => {
        const pageNumbers = Array.from({length: 500}, (_, index) => index * 2 + 1);
        const first = buildFileName({
            pageNumbers,
            totalPages: 1000,
        });
        const second = buildFileName({
            pageNumbers,
            totalPages: 1000,
        });

        expect(first).toBe(second);
        expect(first).toBe('document - pages 500-selected_1-to-999_id-edce9f76.pdf');
        expect(first).not.toContain(',');
    });

    it('keeps modified names within a cross-platform component budget', () => {
        const longStem = 'Ա'.repeat(240);
        const fileName = buildFileName({
            fileName: `${longStem}.pdf`,
            pageNumbers: [9],
        });

        expect(new TextEncoder().encode(fileName).byteLength).toBeLessThanOrEqual(180);
        expect(fileName.length).toBeLessThanOrEqual(180);
        expect(fileName).toMatch(/~ - page 9\.pdf$/u);
        expect(fileName).not.toContain('\uFFFD');
    });

    it('sanitizes Windows-forbidden source characters without removing legal commas', () => {
        expect(
            buildFileName({
                fileName: 'budget: final, approved?.pdf',
                pageNumbers: [1, 2],
            }),
        ).toBe('budget_ final, approved_ - pages 1-2.pdf');
    });

    it('guards reserved Windows device names in modified suggestions', () => {
        expect(
            buildFileName({
                fileName: 'C:\\incoming\\CON.pdf',
                pageNumbers: [1, 2],
            }),
        ).toBe('_CON - pages 1-2.pdf');
    });
});
