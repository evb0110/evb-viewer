import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {mainJobBroker} from '@electron/resources/jobBroker';

const mocks = vi.hoisted(() => ({
    cleanupWorkingCopy: vi.fn(async (_workingPath: string, _ownerWebContentsId?: number) => undefined),
    addRecentInputs: vi.fn(async (_paths: string[], _owner?: unknown) => undefined),
    allowOpenPaths: vi.fn(),
    buildCombinedPdfOutputPath: vi.fn((_paths: string[]) => '/tmp/combined.pdf'),
    createPdfFileFromInputPaths: vi.fn(async (
        _inputPaths: string[],
        outputPath: string,
        _options?: unknown,
    ) => outputPath),
    createWorkingCopy: vi.fn(async (_originalPath: string, _ownerWebContentsId?: number) => '/tmp/working/original.pdf'),
    createWorkingCopyWithOutcome: vi.fn(async (
        originalPath: string,
        ownerWebContentsId?: number,
        _password?: string,
        _signal?: AbortSignal,
    ): Promise<{
        workingPath: string;
        wasEncrypted: true | undefined
    }> => ({
        workingPath: await mocks.createWorkingCopy(originalPath, ownerWebContentsId),
        wasEncrypted: undefined,
    })),
    createWorkingCopyFromPath: vi.fn(async (
        _sourcePath: string,
        _originalPath?: string,
        _ownerWebContentsId?: number,
    ) => '/tmp/working/combined.pdf'),
    existsSync: vi.fn((_path: string) => true),
    isDjvuPath: vi.fn((path: string) => /\.(?:djvu|djv)$/iu.test(path)),
    isPdfPath: vi.fn((path: string) => /\.pdf$/iu.test(path)),
    isScanCleanupGeneratedOutputPath: vi.fn((_path: string) => false),
    isSupportedOpenPath: vi.fn((_path: string) => true),
    mkdtemp: vi.fn(async (_prefix: string) => COMBINE_TEMP_DIR),
    requireOpenPath: vi.fn((path: string, _owner?: unknown) => path),
    rm: vi.fn(async (_path: string, _options?: unknown) => undefined),
    stat: vi.fn(async (_path: string) => ({size: 8 * 1024 * 1024})),
    touchScanCleanupGeneratedOutput: vi.fn(async (_path: string) => true),
    PdfDecryptAttemptError: class PdfDecryptAttemptError extends Error {
        readonly outcome: 'needs-password' | 'unsupported-encryption';

        constructor(outcome: 'needs-password' | 'unsupported-encryption') {
            super(outcome);
            this.name = 'PdfDecryptAttemptError';
            this.outcome = outcome;
        }
    },
}));

// mkdtemp answers with a fresh directory inside the OS temp root. Cleanup owns
// exactly that directory, so the mock nests it one level down: the parent
// stands in for the shared temp root an rm one level too high would take.
const COMBINE_TEMP_PARENT = '/tmp/pdf-combine-open-parent';
const COMBINE_TEMP_DIR = `${COMBINE_TEMP_PARENT}/pdf-combine-open-test`;
const COMBINE_TEMP_OUTPUT = `${COMBINE_TEMP_DIR}/combined.pdf`;

vi.mock('fs', () => ({existsSync: (path: string) => mocks.existsSync(path)}));
vi.mock('fs/promises', () => ({
    mkdtemp: (...args: [string]) => mocks.mkdtemp(...args),
    rm: (...args: [string, unknown]) => mocks.rm(...args),
    stat: (...args: [string]) => mocks.stat(...args),
}));
vi.mock('@electron/image/pdfConversion', () => ({
    buildCombinedPdfOutputPath: (...args: [string[]]) => mocks.buildCombinedPdfOutputPath(...args),
    createPdfFileFromInputPaths: (
        inputPaths: string[],
        outputPath: string,
        options?: unknown,
    ) => mocks.createPdfFileFromInputPaths(inputPaths, outputPath, options),
    isDjvuPath: (path: string) => mocks.isDjvuPath(path),
    isPdfPath: (path: string) => mocks.isPdfPath(path),
    isSupportedOpenPath: (path: string) => mocks.isSupportedOpenPath(path),
}));
vi.mock('@electron/file-access/workingCopyCreation', () => ({
    createWorkingCopy: (originalPath: string, ownerWebContentsId?: number) =>
        mocks.createWorkingCopy(originalPath, ownerWebContentsId),
    createWorkingCopyWithOutcome: (...args: [string, number | undefined, string | undefined, AbortSignal | undefined]) =>
        mocks.createWorkingCopyWithOutcome(...args),
    createWorkingCopyFromPath: (
        sourcePath: string,
        originalPath?: string,
        ownerWebContentsId?: number,
    ) => mocks.createWorkingCopyFromPath(sourcePath, originalPath, ownerWebContentsId),
}));
vi.mock('@electron/file-access/workingCopyDecryption', () => ({PdfDecryptAttemptError: mocks.PdfDecryptAttemptError}));
vi.mock('@electron/file-access/workingCopyCleanup', () => ({cleanupWorkingCopy: (
    workingPath: string,
    ownerWebContentsId?: number,
) => mocks.cleanupWorkingCopy(workingPath, ownerWebContentsId)}));
vi.mock('@electron/file-access/openPathCapabilities', () => ({
    allowOpenPaths: (...args: unknown[]) => mocks.allowOpenPaths(...args),
    requireOpenPath: (path: string, owner?: unknown) => mocks.requireOpenPath(path, owner),
}));
vi.mock('@electron/features/documents/main/addRecentInputs.service', () => ({addRecentInputs: (paths: string[], owner?: unknown) => mocks.addRecentInputs(paths, owner)}));
vi.mock('@electron/features/scan-cleanup/public/generatedOutputs', () => ({
    isScanCleanupGeneratedOutputPath: (path: string) => mocks.isScanCleanupGeneratedOutputPath(path),
    touchScanCleanupGeneratedOutput: (path: string) => mocks.touchScanCleanupGeneratedOutput(path),
}));
vi.mock('@electron/utils/normalizePossiblyEncodedExistingPath', () => ({normalizePossiblyEncodedExistingPath: () => null}));
vi.mock('@electron/te', () => ({te: (key: string) => key}));
vi.mock('@electron/utils/createLogger', () => ({createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
})}));

describe('openInputPaths', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.isScanCleanupGeneratedOutputPath.mockReturnValue(false);
    });

    it('mints the generated combined PDF temp path before creating a working copy', async () => {
        const owner = { id: 42 };
        const { openInputPaths } = await import('@electron/features/documents/main/openInputPaths.service');

        const result = await openInputPaths([
            '/tmp/a.png',
            '/tmp/b.jpg',
        ], {}, owner as never);

        expect(result).toEqual({
            kind: 'pdf',
            workingPath: '/tmp/working/combined.pdf',
            originalPath: '/tmp/combined.pdf',
            isGenerated: true,
        });
        expect(mocks.createPdfFileFromInputPaths).toHaveBeenCalledWith(
            [
                '/tmp/a.png',
                '/tmp/b.jpg',
            ],
            COMBINE_TEMP_OUTPUT,
            { signal: expect.any(AbortSignal) },
        );
        expect(mocks.allowOpenPaths).toHaveBeenCalledWith([
            '/tmp/a.png',
            '/tmp/b.jpg',
        ], owner);
        expect(mocks.allowOpenPaths).toHaveBeenCalledWith([COMBINE_TEMP_OUTPUT], owner);
        expect(mocks.requireOpenPath).toHaveBeenCalledWith(COMBINE_TEMP_OUTPUT, owner);
        expect(mocks.createWorkingCopyFromPath).toHaveBeenCalledWith(
            COMBINE_TEMP_OUTPUT,
            '/tmp/combined.pdf',
            42,
        );
        expect(mocks.rm).toHaveBeenCalledOnce();
        const [
            removedPath,
            removeOptions,
        ] = mocks.rm.mock.calls[0]!;
        expect(removedPath).toBe(COMBINE_TEMP_DIR);
        expect(removeOptions).toEqual({
            recursive: true,
            force: true,
        });
        // The sentinel parent is what a one-level-too-high cleanup would take.
        expect(mocks.rm).not.toHaveBeenCalledWith(COMBINE_TEMP_PARENT, expect.anything());
    });

    it('does not add source PDFs or DjVu files to recents for generated combined PDFs', async () => {
        const owner = { id: 42 };
        const { openInputPaths } = await import('@electron/features/documents/main/openInputPaths.service');

        await expect(openInputPaths([
            '/tmp/source-a.pdf',
            '/tmp/source-b.djvu',
        ], {}, owner as never)).resolves.toEqual({
            kind: 'pdf',
            workingPath: '/tmp/working/combined.pdf',
            originalPath: '/tmp/combined.pdf',
            isGenerated: true,
        });

        expect(mocks.addRecentInputs).not.toHaveBeenCalled();
    });

    it('keeps adding single PDF opens to recents', async () => {
        const owner = { id: 42 };
        const { openInputPaths } = await import('@electron/features/documents/main/openInputPaths.service');

        await expect(openInputPaths(['/tmp/source.pdf'], {}, owner as never)).resolves.toEqual({
            kind: 'pdf',
            workingPath: '/tmp/working/original.pdf',
            originalPath: '/tmp/source.pdf',
        });

        expect(mocks.addRecentInputs).toHaveBeenCalledWith(['/tmp/source.pdf'], owner);
        expect(mocks.touchScanCleanupGeneratedOutput).not.toHaveBeenCalled();
    });

    it('opens an encrypted PDF with the supplied password before publishing the copy', async () => {
        const owner = {id: 42};
        mocks.createWorkingCopyWithOutcome.mockResolvedValueOnce({
            workingPath: '/tmp/working/decrypted.pdf',
            wasEncrypted: true,
        });
        const {openInputPaths} = await import('@electron/features/documents/main/openInputPaths.service');

        await expect(openInputPaths(
            ['/tmp/source.pdf'],
            {password: 'correct-password'},
            owner as never,
        )).resolves.toEqual({
            kind: 'pdf',
            workingPath: '/tmp/working/decrypted.pdf',
            originalPath: '/tmp/source.pdf',
            wasEncrypted: true,
        });

        expect(mocks.createWorkingCopyWithOutcome).toHaveBeenCalledWith(
            '/tmp/source.pdf',
            42,
            'correct-password',
            expect.any(AbortSignal),
        );
        expect(mocks.cleanupWorkingCopy).not.toHaveBeenCalled();
    });

    it('returns a retryable needs-password result without publishing a failed copy', async () => {
        const owner = {id: 42};
        mocks.createWorkingCopyWithOutcome.mockRejectedValueOnce(
            new mocks.PdfDecryptAttemptError('needs-password'),
        );
        const {openInputPaths} = await import('@electron/features/documents/main/openInputPaths.service');

        await expect(openInputPaths(
            ['/tmp/source.pdf'],
            {password: 'wrong-password'},
            owner as never,
        )).resolves.toEqual({
            kind: 'pdf-needs-password',
            originalPath: '/tmp/source.pdf',
        });

        expect(mocks.cleanupWorkingCopy).not.toHaveBeenCalled();
        expect(mocks.addRecentInputs).not.toHaveBeenCalled();
    });

    it('returns unsupported encryption without publishing a working copy', async () => {
        const owner = {id: 42};
        mocks.createWorkingCopyWithOutcome.mockRejectedValueOnce(
            new mocks.PdfDecryptAttemptError('unsupported-encryption'),
        );
        const {openInputPaths} = await import('@electron/features/documents/main/openInputPaths.service');

        await expect(openInputPaths(['/tmp/source.pdf'], {}, owner as never)).resolves.toEqual({
            kind: 'pdf-unsupported-encryption',
            originalPath: '/tmp/source.pdf',
        });

        expect(mocks.cleanupWorkingCopy).not.toHaveBeenCalled();
        expect(mocks.addRecentInputs).not.toHaveBeenCalled();
    });

    it('admits a single PDF open through the bounded interactive lane', async () => {
        const owner = {id: 42};
        const acquire = vi.spyOn(mainJobBroker, 'acquire');
        try {
            const {openInputPaths} = await import('@electron/features/documents/main/openInputPaths.service');

            await openInputPaths(['/tmp/source.pdf'], {}, owner as never);

            expect(acquire).toHaveBeenCalledWith(expect.objectContaining({
                ownerId: 'pdf-open:42',
                kind: 'pdf-working-copy',
                priority: 'foreground',
                admissionClass: 'interactive',
                resources: expect.objectContaining({
                    cpuTokens: 0,
                    nativeProcesses: 0,
                    ioWeight: 1,
                }),
            }));
        } finally {
            acquire.mockRestore();
        }
    });

    it('marks managed cleanup PDFs as generated and refreshes their retention instead of adding recents', async () => {
        mocks.isScanCleanupGeneratedOutputPath.mockReturnValueOnce(true);
        const owner = {id: 42};
        const {openInputPaths} = await import('@electron/features/documents/main/openInputPaths.service');

        await expect(openInputPaths(
            ['/tmp/scan-cleanup/output/generated-id/source — cleaned.pdf'],
            {},
            owner as never,
        )).resolves.toEqual({
            kind: 'pdf',
            workingPath: '/tmp/working/original.pdf',
            originalPath: '/tmp/scan-cleanup/output/generated-id/source — cleaned.pdf',
            isGenerated: true,
        });

        expect(mocks.addRecentInputs).not.toHaveBeenCalled();
        expect(mocks.touchScanCleanupGeneratedOutput)
            .toHaveBeenCalledWith('/tmp/scan-cleanup/output/generated-id/source — cleaned.pdf');
    });

    it('returns a PDF source before recent-file inspection and persistence settle', async () => {
        let resolveRecent!: () => void;
        const recentPersistence = new Promise<undefined>(resolve => {
            resolveRecent = () => resolve(undefined);
        });
        mocks.addRecentInputs.mockImplementationOnce(() => recentPersistence);
        const owner = {id: 42};
        const {openInputPaths} = await import('@electron/features/documents/main/openInputPaths.service');

        await expect(openInputPaths(['/tmp/slow-stat.pdf'], {}, owner as never)).resolves.toEqual({
            kind: 'pdf',
            workingPath: '/tmp/working/original.pdf',
            originalPath: '/tmp/slow-stat.pdf',
        });

        expect(mocks.addRecentInputs).toHaveBeenCalledWith(['/tmp/slow-stat.pdf'], owner);
        resolveRecent();
        await recentPersistence;
    });

    it('always generates a new PDF for a forced single-PDF combine', async () => {
        const owner = { id: 42 };
        const { openInputPaths } = await import('@electron/features/documents/main/openInputPaths.service');

        await expect(openInputPaths(
            ['/tmp/source.pdf'],
            {forceCombine: true},
            owner as never,
        )).resolves.toMatchObject({
            kind: 'pdf',
            isGenerated: true,
            workingPath: '/tmp/working/combined.pdf',
        });
        expect(mocks.createPdfFileFromInputPaths).toHaveBeenCalledOnce();
        expect(mocks.createWorkingCopy).not.toHaveBeenCalled();
    });

    it('keeps adding single DjVu opens to recents', async () => {
        const owner = { id: 42 };
        const { openInputPaths } = await import('@electron/features/documents/main/openInputPaths.service');

        await expect(openInputPaths(['/tmp/source.djvu'], {}, owner as never)).resolves.toEqual({
            kind: 'djvu',
            workingPath: '',
            originalPath: '/tmp/source.djvu',
        });

        expect(mocks.addRecentInputs).toHaveBeenCalledWith(['/tmp/source.djvu'], owner);
    });

    it('always generates a new PDF for a forced single-DjVu combine', async () => {
        const owner = { id: 42 };
        const { openInputPaths } = await import('@electron/features/documents/main/openInputPaths.service');

        await expect(openInputPaths(
            ['/tmp/source.djvu'],
            {forceCombine: true},
            owner as never,
        )).resolves.toMatchObject({
            kind: 'pdf',
            isGenerated: true,
        });
        expect(mocks.createPdfFileFromInputPaths).toHaveBeenCalledOnce();
    });

    it('refuses to create a working copy for an already-canceled open', async () => {
        const owner = {id: 42};
        const controller = new AbortController();
        controller.abort(new Error('canceled before admission'));
        const {openInputPaths} = await import('@electron/features/documents/main/openInputPaths.service');

        await expect(openInputPaths(
            ['/tmp/source.pdf'],
            {signal: controller.signal},
            owner as never,
        )).rejects.toThrow('canceled before admission');

        expect(mocks.stat).not.toHaveBeenCalled();
        expect(mocks.createWorkingCopy).not.toHaveBeenCalled();
        expect(mocks.cleanupWorkingCopy).not.toHaveBeenCalled();
    });

    it('never starts working-copy creation when admission is canceled while deferred', async () => {
        const owner = {id: 42};
        const controller = new AbortController();
        const admitted = Promise.withResolvers<true>();
        const acquire = vi.spyOn(mainJobBroker, 'acquire').mockImplementation(request => (
            new Promise((_resolve, reject) => {
                admitted.resolve(true);
                request.signal?.addEventListener('abort', () => reject(new Error('admission canceled')), {once: true});
            })
        ));
        try {
            const {openInputPaths} = await import('@electron/features/documents/main/openInputPaths.service');

            const open = openInputPaths(['/tmp/source.pdf'], {signal: controller.signal}, owner as never);
            await admitted.promise;
            controller.abort(new Error('canceled during admission'));

            await expect(open).rejects.toThrow('admission canceled');
            expect(mocks.createWorkingCopy).not.toHaveBeenCalled();
            expect(mocks.cleanupWorkingCopy).not.toHaveBeenCalled();
        } finally {
            acquire.mockRestore();
        }
    });

    it('discards the eventual copy of an open canceled while the copy was still running', async () => {
        const owner = {id: 42};
        const controller = new AbortController();
        const copying = Promise.withResolvers<true>();
        const copied = Promise.withResolvers<string>();
        mocks.createWorkingCopy.mockImplementationOnce(() => {
            copying.resolve(true);
            return copied.promise;
        });
        const {openInputPaths} = await import('@electron/features/documents/main/openInputPaths.service');

        const open = openInputPaths(['/tmp/source.pdf'], {signal: controller.signal}, owner as never);
        await copying.promise;
        controller.abort(new Error('canceled during copy'));
        copied.resolve('/tmp/working/late.pdf');

        await expect(open).rejects.toThrow('canceled during copy');
        expect(mocks.cleanupWorkingCopy).toHaveBeenCalledWith('/tmp/working/late.pdf', 42);
        // Releasing the copy goes through working-copy cleanup only. A single
        // PDF open mints no temp directory, so it must remove nothing itself
        // and above all not the source it was asked to open.
        expect(mocks.rm).not.toHaveBeenCalled();
    });

    it('cleans the copy without touching generated retention when the cancel lands first', async () => {
        mocks.isScanCleanupGeneratedOutputPath.mockReturnValueOnce(true);
        const owner = {id: 42};
        const controller = new AbortController();
        mocks.createWorkingCopy.mockImplementationOnce(async () => {
            controller.abort(new Error('canceled after copy'));
            return '/tmp/working/generated.pdf';
        });
        const {openInputPaths} = await import('@electron/features/documents/main/openInputPaths.service');

        await expect(openInputPaths(
            ['/tmp/scan-cleanup/output/generated-id/source — cleaned.pdf'],
            {signal: controller.signal},
            owner as never,
        )).rejects.toThrow('canceled after copy');

        expect(mocks.touchScanCleanupGeneratedOutput).not.toHaveBeenCalled();
        expect(mocks.cleanupWorkingCopy).toHaveBeenCalledWith('/tmp/working/generated.pdf', 42);
    });

    it('releases the interactive open lease even when the open is canceled', async () => {
        const owner = {id: 42};
        const controller = new AbortController();
        const release = vi.fn();
        const acquire = vi.spyOn(mainJobBroker, 'acquire')
            .mockResolvedValue({release} as never);
        try {
            mocks.createWorkingCopy.mockImplementationOnce(async () => {
                controller.abort(new Error('canceled after admission'));
                return '/tmp/working/original.pdf';
            });
            const {openInputPaths} = await import('@electron/features/documents/main/openInputPaths.service');

            await expect(openInputPaths(
                ['/tmp/source.pdf'],
                {signal: controller.signal},
                owner as never,
            )).rejects.toThrow('canceled after admission');

            expect(release).toHaveBeenCalledOnce();
            expect(mocks.cleanupWorkingCopy).toHaveBeenCalledWith('/tmp/working/original.pdf', 42);
        } finally {
            acquire.mockRestore();
        }
    });

    it('cleans up the minted combine directory when the combine admission throws', async () => {
        const owner = {id: 42};
        const acquire = vi.spyOn(mainJobBroker, 'acquire').mockRejectedValue(
            new Error('combine admission failed'),
        );
        try {
            const {openInputPaths} = await import('@electron/features/documents/main/openInputPaths.service');

            await expect(openInputPaths([
                '/tmp/a.png',
                '/tmp/b.jpg',
            ], {}, owner as never)).rejects.toThrow('combine admission failed');

            // A combine open takes one lease, and the directory is minted
            // before that admission, so the throw has to unwind through the
            // same cleanup a granted open uses.
            expect(acquire).toHaveBeenCalledOnce();
            expect(acquire).toHaveBeenCalledWith(expect.objectContaining({
                ownerId: 'pdf-combine:42',
                kind: 'pdf-combine',
            }));
            expect(mocks.rm).toHaveBeenCalledOnce();
            expect(mocks.rm.mock.calls[0]![0]).toBe(COMBINE_TEMP_DIR);
            expect(mocks.rm).not.toHaveBeenCalledWith(COMBINE_TEMP_PARENT, expect.anything());
            expect(mocks.createPdfFileFromInputPaths).not.toHaveBeenCalled();
            expect(mocks.createWorkingCopyFromPath).not.toHaveBeenCalled();
        } finally {
            acquire.mockRestore();
        }
    });

    it('rejects oversized open batches before granting paths or creating temp files', async () => {
        const { openInputPaths } = await import('@electron/features/documents/main/openInputPaths.service');
        const paths = Array.from({length: 513}, (_, index) => `/tmp/input-${index}.png`);

        await expect(openInputPaths(paths)).rejects.toThrow('errors.file.invalid');

        expect(mocks.allowOpenPaths).not.toHaveBeenCalled();
        expect(mocks.createPdfFileFromInputPaths).not.toHaveBeenCalled();
        expect(mocks.mkdtemp).not.toHaveBeenCalled();
    });
});
