import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {requirePageNumber} from '@contracts/pageNumbers';
import { estimateOcrRequestBytes } from '@electron/features/ocr/main/estimateOcrRequestBytes';
import type { TOcrSearchablePdfPages } from '@contracts/electronApiOcr';

const PAGE_BYTES_AT_300_DPI = Math.ceil(8.5 * 300) * Math.ceil(11 * 300) * 4;
const PAGE_BYTES_AT_600_DPI = Math.ceil(8.5 * 600) * Math.ceil(11 * 600) * 4;

function buildPages(count: number): TOcrSearchablePdfPages {
    return Array.from({length: count}, (_, index) => ({
        pageNumber: requirePageNumber(index + 1),
        languages: ['eng'],
    }));
}

describe('estimateOcrRequestBytes', () => {
    beforeEach(() => {
        vi.stubEnv('OCR_CONCURRENCY', '4');
    });

    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it('estimates only the pages that can be rendered at once, not the whole document', () => {
        expect(estimateOcrRequestBytes(buildPages(5_000), {}))
            .toBe(estimateOcrRequestBytes(buildPages(4), {}));
        expect(estimateOcrRequestBytes(buildPages(5_000), {})).toBe(4 * PAGE_BYTES_AT_300_DPI);
    });

    it('estimates a short request from its own page count', () => {
        expect(estimateOcrRequestBytes(buildPages(2), {})).toBe(2 * PAGE_BYTES_AT_300_DPI);
    });

    it('scales with the render DPI', () => {
        expect(estimateOcrRequestBytes(buildPages(100), {renderDpi: 600})).toBe(4 * PAGE_BYTES_AT_600_DPI);
    });
});
