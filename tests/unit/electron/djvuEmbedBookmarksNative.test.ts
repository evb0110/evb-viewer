import type * as TViMockOriginalModule from '@electron/pdf/nativeToolPaths';

import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type {IPdfBookmarkEntry} from '@contracts/pdfBookmarkEntry';
import {requirePageIndex} from '@contracts/pageNumbers';

const mocks = vi.hoisted(() => {
    const copyFile = vi.fn(async () => undefined);
    const mkdtemp = vi.fn(async () => '/tmp/djvu-bookmarks-native');
    const readFile = vi.fn(async () => new Uint8Array([
        1,
        2,
        3,
    ]));
    const rm = vi.fn(async () => undefined);
    const stat = vi.fn(async () => ({size: 321}));
    const writeFile = vi.fn(async () => undefined);
    const load = vi.fn(async () => ({save: vi.fn(async () => new Uint8Array([9]))}));
    const writePdfBookmarkOutlines = vi.fn();
    const runNativeToolCommand = vi.fn(async (_command: string, _args: string[], options?: {
        cancelGroup?: string;
        commandLabel?: string;
        signal?: AbortSignal;
    }) => ({
        stdout: options?.commandLabel === 'qpdf(djvu-bookmark-page-count)' ? '3\n' : '',
        stderr: '',
        success: true,
        exitCode: 0,
    }));
    const isNativePageOpsDisabled = vi.fn(() => false);
    const resolveNativePageOpsPath = vi.fn(() => '/native/evb-pdf-page-ops');
    const getPdfNativeToolPaths = vi.fn(() => ({qpdf: '/native/qpdf'}));
    const debug = vi.fn();

    return {
        copyFile,
        mkdtemp,
        readFile,
        rm,
        stat,
        writeFile,
        load,
        writePdfBookmarkOutlines,
        runNativeToolCommand,
        isNativePageOpsDisabled,
        resolveNativePageOpsPath,
        getPdfNativeToolPaths,
        debug,
    };
});

vi.mock('fs/promises', () => ({
    copyFile: mocks.copyFile,
    mkdtemp: mocks.mkdtemp,
    readFile: mocks.readFile,
    rm: mocks.rm,
    stat: mocks.stat,
    writeFile: mocks.writeFile,
}));

vi.mock('pdf-lib', () => ({PDFDocument: {load: mocks.load}}));

vi.mock('@pdf-core', () => ({writePdfBookmarkOutlines: mocks.writePdfBookmarkOutlines}));

vi.mock('@electron/native-tools/runNativeToolCommand', () => ({runNativeToolCommand: mocks.runNativeToolCommand}));

vi.mock('@electron/features/page-ops/public/nativePageOpsPath', () => ({
    isNativePageOpsDisabled: mocks.isNativePageOpsDisabled,
    resolveNativePageOpsPath: mocks.resolveNativePageOpsPath,
}));

vi.mock('@electron/pdf/nativeToolPaths', async (importOriginal) => ({
    ...(await importOriginal<typeof TViMockOriginalModule>()),
    getPdfNativeToolPaths: mocks.getPdfNativeToolPaths,
}));

vi.mock('@electron/utils/createLogger', () => ({createLogger: () => ({
    debug: mocks.debug,
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
})}));

const { embedBookmarksIntoPdfFile } = await import('@electron/features/djvu/main/embedBookmarksIntoPdfFile');

const bookmarks: IPdfBookmarkEntry[] = [{
    title: 'Chapter 1',
    pageIndex: requirePageIndex(0),
    namedDest: null,
    bold: false,
    italic: false,
    color: null,
    items: [],
}];

describe('embedBookmarksIntoPdfFile native path', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.isNativePageOpsDisabled.mockReturnValue(false);
        mocks.resolveNativePageOpsPath.mockReturnValue('/native/evb-pdf-page-ops');
        mocks.getPdfNativeToolPaths.mockReturnValue({qpdf: '/native/qpdf'});
        mocks.runNativeToolCommand.mockImplementation(async (_command: string, _args: string[], options?: {
            cancelGroup?: string;
            commandLabel?: string;
            signal?: AbortSignal;
        }) => ({
            stdout: options?.commandLabel === 'qpdf(djvu-bookmark-page-count)' ? '3\n' : '',
            stderr: '',
            success: true,
            exitCode: 0,
        }));
        mocks.stat.mockResolvedValue({size: 321});
    });

    afterEach(() => {
        vi.unstubAllEnvs();
        vi.useRealTimers();
    });

    it('uses evb-pdf-page-ops save-mutations without loading the PDF into pdf-lib', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-02-03T04:05:06.789Z'));
        const expectedBookmarkMutation = {
            totalPages: 3,
            untitledLabel: 'Untitled',
            items: bookmarks,
        };

        const size = await embedBookmarksIntoPdfFile('/tmp/input.pdf', '/tmp/output.pdf', bookmarks);

        expect(size).toBe(321);
        expect(mocks.getPdfNativeToolPaths).toHaveBeenCalled();
        expect(mocks.runNativeToolCommand).toHaveBeenCalledWith(
            '/native/qpdf',
            [
                '--show-npages',
                '/tmp/input.pdf',
            ],
            expect.objectContaining({
                commandLabel: 'qpdf(djvu-bookmark-page-count)',
                allowedExitCodes: [
                    0,
                    3,
                ],
            }),
        );
        expect(mocks.copyFile).toHaveBeenNthCalledWith(1, '/tmp/input.pdf', '/tmp/djvu-bookmarks-native/input.pdf');
        expect(mocks.copyFile).toHaveBeenNthCalledWith(2, '/tmp/djvu-bookmarks-native/input.pdf', '/tmp/output.pdf');
        expect(mocks.writeFile).toHaveBeenCalledWith(
            '/tmp/djvu-bookmarks-native/bookmarks.json',
            JSON.stringify({bookmarks: expectedBookmarkMutation}),
            'utf8',
        );
        expect(mocks.runNativeToolCommand).toHaveBeenCalledWith(
            '/native/evb-pdf-page-ops',
            expect.arrayContaining([
                'save-mutations',
                '--input',
                '/tmp/djvu-bookmarks-native/input.pdf',
                '--output',
                '/tmp/djvu-bookmarks-native/input.pdf',
                '--mutations-file',
                '/tmp/djvu-bookmarks-native/bookmarks.json',
                '--qpdf',
                '/native/qpdf',
                '--modified-at',
                'D:20260203040506Z',
                '--append',
            ]),
            expect.objectContaining({commandLabel: 'evb-pdf-page-ops(djvu-bookmarks)'}),
        );
        const publishOutputOrder = mocks.copyFile.mock.invocationCallOrder[1] ?? 0;
        const commandOrder = mocks.runNativeToolCommand.mock.invocationCallOrder[1] ?? 0;
        expect(publishOutputOrder).toBeGreaterThan(commandOrder);
        expect(mocks.load).not.toHaveBeenCalled();
        expect(mocks.readFile).not.toHaveBeenCalled();
        expect(mocks.rm).toHaveBeenCalledWith('/tmp/djvu-bookmarks-native', {
            recursive: true,
            force: true,
        });
    });

    it('threads one cancellation scope through native page-count and bookmark mutation commands', async () => {
        const controller = new AbortController();

        await embedBookmarksIntoPdfFile('/tmp/input.pdf', '/tmp/output.pdf', bookmarks, controller.signal);

        const qpdfOptions = mocks.runNativeToolCommand.mock.calls[0]?.[2];
        const pageOpsOptions = mocks.runNativeToolCommand.mock.calls[1]?.[2];
        expect(qpdfOptions).toMatchObject({
            commandLabel: 'qpdf(djvu-bookmark-page-count)',
            signal: controller.signal,
        });
        expect(pageOpsOptions).toMatchObject({
            commandLabel: 'evb-pdf-page-ops(djvu-bookmarks)',
            signal: controller.signal,
        });
        expect(qpdfOptions?.cancelGroup).toMatch(/^djvu-bookmarks:/u);
        expect(pageOpsOptions?.cancelGroup).toBe(qpdfOptions?.cancelGroup);
    });

    it('returns a typed native capability error when the native command fails', async () => {
        mocks.runNativeToolCommand
            .mockImplementationOnce(async () => ({
                stdout: '3\n',
                stderr: '',
                success: true,
                exitCode: 0,
            }))
            .mockRejectedValueOnce(new Error('native failed'));

        const error = await embedBookmarksIntoPdfFile('/tmp/input.pdf', '/tmp/output.pdf', bookmarks)
            .catch((caughtError: unknown) => caughtError);

        expect(error).toMatchObject({
            code: 'native-failure',
            name: 'PdfCombineCapabilityError',
            operation: 'djvu-bookmarks',
            cause: expect.objectContaining({message: 'native failed'}),
        });
        expect(mocks.readFile).not.toHaveBeenCalled();
        expect(mocks.load).not.toHaveBeenCalled();
        expect(mocks.writeFile).not.toHaveBeenCalledWith('/tmp/output.pdf', expect.anything());
    });

    it('returns a typed capability error when native page ops are disabled', async () => {
        mocks.isNativePageOpsDisabled.mockReturnValue(true);

        await expect(embedBookmarksIntoPdfFile('/tmp/input.pdf', '/tmp/output.pdf', bookmarks))
            .rejects
            .toMatchObject({
                code: 'native-unavailable',
                name: 'PdfCombineCapabilityError',
                operation: 'djvu-bookmarks',
            });

        expect(mocks.runNativeToolCommand).not.toHaveBeenCalled();
        expect(mocks.readFile).not.toHaveBeenCalled();
        expect(mocks.load).not.toHaveBeenCalled();
    });
});
