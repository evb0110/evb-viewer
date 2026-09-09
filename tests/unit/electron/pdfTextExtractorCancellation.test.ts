import type * as TViMockOriginalModule from '@electron/pdf/nativeToolPaths';

import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

const mocks = vi.hoisted(() => ({
    runCommand: vi.fn(),
    getPdfNativeToolPaths: vi.fn(),
}));

vi.mock('@electron/utils/createLogger', () => ({createLogger: () => ({debug: vi.fn()})}));

vi.mock('@electron/utils/runElectronCommand', () => ({runElectronCommand: mocks.runCommand}));

vi.mock('@electron/pdf/nativeToolPaths', async (importOriginal) => ({
    ...(await importOriginal<typeof TViMockOriginalModule>()),
    getPdfNativeToolPaths: mocks.getPdfNativeToolPaths,
}));

function createAbortError() {
    const error = new Error('The operation was aborted');
    error.name = 'AbortError';
    return error;
}

describe('extractTextFromPdf cancellation', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getPdfNativeToolPaths.mockReturnValue({pdftotext: 'pdftotext'});
    });

    it('returns AbortError immediately when signal is already aborted', async () => {
        const { extractTextFromPdf } = await import('@electron/features/search/extractTextFromPdf');
        const controller = new AbortController();
        controller.abort();

        await expect(
            extractTextFromPdf('/tmp/file.pdf', {signal: controller.signal}),
        ).rejects.toMatchObject({ name: 'AbortError' });
        expect(mocks.runCommand).not.toHaveBeenCalled();
    });

    it('forwards signal to runCommand and preserves paging behavior', async () => {
        const { extractTextFromPdf } = await import('@electron/features/search/extractTextFromPdf');
        const controller = new AbortController();

        mocks.runCommand.mockResolvedValue({
            stdout: 'page-1\f',
            stderr: '',
            exitCode: 0,
        });

        const result = await extractTextFromPdf('/tmp/file.pdf', {
            pageCount: 2,
            signal: controller.signal,
        });

        expect(mocks.runCommand).toHaveBeenCalledWith(
            'pdftotext',
            [
                '-layout',
                '-f',
                '1',
                '-l',
                '2',
                '/tmp/file.pdf',
                '-',
            ],
            {
                signal: controller.signal,
                timeoutMs: 120000,
                maxStdoutBytes: 8 * 1024 * 1024,
                rejectOnStdoutTruncation: true,
            },
        );
        expect(result).toEqual([
            {
                pageNumber: 1,
                text: 'page-1',
            },
            {
                pageNumber: 2,
                text: '',
            },
        ]);
    });

    it('extracts only requested page ranges with pdftotext', async () => {
        const { extractTextFromPdf } = await import('@electron/features/search/extractTextFromPdf');
        mocks.runCommand
            .mockResolvedValueOnce({
                stdout: 'page-2\f',
                stderr: '',
                exitCode: 0,
            })
            .mockResolvedValueOnce({
                stdout: 'page-4\fpage-5\f',
                stderr: '',
                exitCode: 0,
            });

        const result = await extractTextFromPdf('/tmp/file.pdf', {
            pageCount: 10,
            pages: [
                5,
                2,
                4,
                4,
                99,
            ],
        });

        expect(mocks.runCommand).toHaveBeenNthCalledWith(
            1,
            'pdftotext',
            [
                '-layout',
                '-f',
                '2',
                '-l',
                '2',
                '/tmp/file.pdf',
                '-',
            ],
            {
                timeoutMs: 120000,
                maxStdoutBytes: 8 * 1024 * 1024,
                rejectOnStdoutTruncation: true,
            },
        );
        expect(mocks.runCommand).toHaveBeenNthCalledWith(
            2,
            'pdftotext',
            [
                '-layout',
                '-f',
                '4',
                '-l',
                '5',
                '/tmp/file.pdf',
                '-',
            ],
            {
                timeoutMs: 120000,
                maxStdoutBytes: 8 * 1024 * 1024,
                rejectOnStdoutTruncation: true,
            },
        );
        expect(result).toEqual([
            {
                pageNumber: 2,
                text: 'page-2',
            },
            {
                pageNumber: 4,
                text: 'page-4',
            },
            {
                pageNumber: 5,
                text: 'page-5',
            },
        ]);
    });

    it('falls back to full-document extraction when requested pages normalize away', async () => {
        const { extractTextFromPdf } = await import('@electron/features/search/extractTextFromPdf');
        mocks.runCommand.mockResolvedValue({
            stdout: 'page-1\fpage-2',
            stderr: '',
            exitCode: 0,
        });

        await expect(extractTextFromPdf('/tmp/file.pdf', {
            pageCount: 2,
            pages: [
                0,
                -1,
                Number.NaN,
                Number.POSITIVE_INFINITY,
            ],
        })).resolves.toEqual([
            {
                pageNumber: 1,
                text: 'page-1',
            },
            {
                pageNumber: 2,
                text: 'page-2',
            },
        ]);
        expect(mocks.runCommand).toHaveBeenCalledWith(
            'pdftotext',
            [
                '-layout',
                '-f',
                '1',
                '-l',
                '2',
                '/tmp/file.pdf',
                '-',
            ],
            expect.objectContaining({
                timeoutMs: 120000,
                maxStdoutBytes: 8 * 1024 * 1024,
            }),
        );
    });

    it('passes bundled Poppler runtime environment to pdftotext', async () => {
        const { extractTextFromPdf } = await import('@electron/features/search/extractTextFromPdf');
        mocks.getPdfNativeToolPaths.mockReturnValue({
            pdftotext: 'pdftotext',
            popplerDataDir: '/mock/poppler/share/poppler',
            popplerFontConfigDir: '/mock/poppler/etc/fonts',
        });
        mocks.runCommand.mockResolvedValue({
            stdout: 'page-1',
            stderr: '',
            exitCode: 0,
        });

        await extractTextFromPdf('/tmp/file.pdf', {pageCount: 1});

        expect(mocks.runCommand).toHaveBeenCalledWith(
            'pdftotext',
            [
                '-layout',
                '-f',
                '1',
                '-l',
                '1',
                '/tmp/file.pdf',
                '-',
            ],
            {
                env: {
                    POPPLER_DATADIR: '/mock/poppler/share/poppler',
                    FONTCONFIG_PATH: '/mock/poppler/etc/fonts',
                    FONTCONFIG_FILE: '/mock/poppler/etc/fonts/fonts.conf',
                },
                timeoutMs: 120000,
                maxStdoutBytes: 8 * 1024 * 1024,
                rejectOnStdoutTruncation: true,
            },
        );
    });

    it('rethrows AbortError from runCommand without wrapping', async () => {
        const { extractTextFromPdf } = await import('@electron/features/search/extractTextFromPdf');
        const abortError = createAbortError();
        mocks.runCommand.mockRejectedValue(abortError);

        await expect(
            extractTextFromPdf('/tmp/file.pdf', {
                pageCount: 1,
                signal: new AbortController().signal,
            }),
        ).rejects.toBe(abortError);
    });
});
