import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { getPageCount } from '@electron/features/ocr/worker/pdfAssembler';

const mocks = vi.hoisted(() => ({ runOcrCommand: vi.fn() }));

vi.mock('@electron/features/ocr/worker/runOcrCommand', () => ({ runOcrCommand: mocks.runOcrCommand }));

describe('getPageCount', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('surfaces a warning when qpdf page-count falls back', async () => {
        mocks.runOcrCommand.mockRejectedValueOnce(new Error('qpdf unavailable'));

        await expect(getPageCount('/bin/qpdf', '/tmp/source.pdf', 7)).resolves.toEqual({
            pageCount: 7,
            warnings: ['qpdf page-count failed; using OCR page fallback 7: qpdf unavailable'],
        });
    });
});
