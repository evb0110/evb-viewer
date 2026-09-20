import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

const mocks = vi.hoisted(() => ({
    isSupportedOpenPath: vi.fn((path: string) => path.endsWith('.pdf')),
    opendir: vi.fn(),
    openInputPaths: vi.fn(async (
        _paths: string[],
        _options?: {
            signal?: AbortSignal;
            forceCombine?: boolean;
        },
        _owner?: unknown,
    ): Promise<unknown> => null),
    realpath: vi.fn(),
    requireOpenPath: vi.fn((path: string, _owner?: unknown) => path),
    stat: vi.fn(),
}));

vi.mock('fs/promises', () => ({
    opendir: (path: string) => mocks.opendir(path),
    realpath: (path: string) => mocks.realpath(path),
    stat: (path: string) => mocks.stat(path),
}));
vi.mock('@electron/image/pdfConversion', () => ({isSupportedOpenPath: (path: string) => mocks.isSupportedOpenPath(path)}));
vi.mock('@electron/features/documents/main/openInputPaths.service', () => ({openInputPaths: (
    paths: string[],
    options?: {
        signal?: AbortSignal;
        forceCombine?: boolean;
    },
    owner?: unknown,
) => mocks.openInputPaths(paths, options, owner)}));
vi.mock('@electron/file-access/openPathCapabilities', () => ({
    allowOpenPath: vi.fn(),
    logRejectedOpenPath: vi.fn(),
    requireOpenPath: (path: string, owner?: unknown) => mocks.requireOpenPath(path, owner),
}));
vi.mock('@electron/recentFiles', () => ({getRecentFiles: vi.fn(async () => [])}));
vi.mock('@electron/te', () => ({te: (key: string) => key}));
vi.mock('@electron/utils/createLogger', () => ({createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
})}));

function senderContext(id: number) {
    return {sender: {
        id,
        isDestroyed: () => false,
        send: vi.fn(),
    }};
}

type TSenderContext = ReturnType<typeof senderContext>;

function handlerContext(context: TSenderContext) {
    return context as never;
}

describe('direct batch open cancellation', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.resetModules();
    });

    it('cancels a single-PDF batch request that did not force a combine', async () => {
        const handlers = await import('@electron/features/documents/main/documentOpenHandlers');
        const context = senderContext(7);
        const started = Promise.withResolvers<AbortSignal>();
        mocks.openInputPaths.mockImplementationOnce(async (_paths, options) => {
            started.resolve(options!.signal!);
            return new Promise(() => undefined);
        });

        void handlers.handleOpenPdfDirectBatch(handlerContext(context), ['/tmp/generated.pdf'], 'open-1');
        const signal = await started.promise;

        expect(signal.aborted).toBe(false);
        expect(handlers.handleCancelOpenDocumentDirectBatch(handlerContext(context), 'open-1')).toBe(true);
        expect(signal.aborted).toBe(true);
        expect(mocks.openInputPaths).toHaveBeenCalledWith(
            ['/tmp/generated.pdf'],
            expect.objectContaining({forceCombine: false}),
            context.sender,
        );
    });

    it('refuses to cancel a request another sender owns', async () => {
        const handlers = await import('@electron/features/documents/main/documentOpenHandlers');
        const owningContext = senderContext(7);
        const otherContext = senderContext(9);
        const started = Promise.withResolvers<AbortSignal>();
        mocks.openInputPaths.mockImplementationOnce(async (_paths, options) => {
            started.resolve(options!.signal!);
            return new Promise(() => undefined);
        });

        void handlers.handleOpenPdfDirectBatch(handlerContext(owningContext), ['/tmp/generated.pdf'], 'shared-id');
        const signal = await started.promise;

        expect(handlers.handleCancelOpenDocumentDirectBatch(handlerContext(otherContext), 'shared-id')).toBe(false);
        expect(signal.aborted).toBe(false);
        expect(handlers.handleCancelOpenDocumentDirectBatch(handlerContext(owningContext), 'shared-id')).toBe(true);
        expect(signal.aborted).toBe(true);
    });

    it('stops tracking a request once it settles', async () => {
        const handlers = await import('@electron/features/documents/main/documentOpenHandlers');
        const context = senderContext(7);
        mocks.openInputPaths.mockResolvedValueOnce({
            kind: 'pdf',
            workingPath: '/tmp/work/generated.pdf',
            originalPath: '/tmp/generated.pdf',
            isGenerated: true,
        });

        await expect(handlers.handleOpenPdfDirectBatch(handlerContext(context), ['/tmp/generated.pdf'], 'open-2'))
            .resolves.toMatchObject({kind: 'pdf'});

        expect(handlers.handleCancelOpenDocumentDirectBatch(handlerContext(context), 'open-2')).toBe(false);
    });

    it('supersedes only the same sender and request id', async () => {
        const handlers = await import('@electron/features/documents/main/documentOpenHandlers');
        const context = senderContext(7);
        const otherContext = senderContext(9);
        const signals: AbortSignal[] = [];
        // Every open this test starts stays pending on purpose. That standing
        // implementation has to come off the shared mock again, or the next
        // test's opens never answer either.
        mocks.openInputPaths.mockImplementation(async (_paths, options) => {
            signals.push(options!.signal!);
            return new Promise(() => undefined);
        });
        try {
            void handlers.handleOpenPdfDirectBatch(handlerContext(context), ['/tmp/a.pdf'], 'reused-id');
            void handlers.handleOpenPdfDirectBatch(handlerContext(otherContext), ['/tmp/b.pdf'], 'reused-id');
            await vi.waitFor(() => expect(signals).toHaveLength(2));
            void handlers.handleOpenPdfDirectBatch(handlerContext(context), ['/tmp/c.pdf'], 'reused-id');
            await vi.waitFor(() => expect(signals).toHaveLength(3));

            expect(signals[0]!.aborted).toBe(true);
            expect(signals[1]!.aborted).toBe(false);
            expect(signals[2]!.aborted).toBe(false);
        } finally {
            mocks.openInputPaths.mockReset();
        }

        await expect(mocks.openInputPaths(['/tmp/restored.pdf'])).resolves.toBeNull();
    });

    it('leaves an unidentified batch request uncancellable', async () => {
        const handlers = await import('@electron/features/documents/main/documentOpenHandlers');
        const context = senderContext(7);
        const started = Promise.withResolvers<{signal?: AbortSignal}>();
        mocks.openInputPaths.mockImplementationOnce(async (_paths, options) => {
            started.resolve(options ?? {});
            return new Promise(() => undefined);
        });

        void handlers.handleOpenPdfDirectBatch(handlerContext(context), ['/tmp/generated.pdf']);
        const options = await started.promise;

        expect(options.signal).toBeUndefined();
        expect(handlers.handleCancelOpenDocumentDirectBatch(handlerContext(context), '')).toBe(false);
    });

    it('allows a forced combine batch above the ordinary direct-open limit', async () => {
        const handlers = await import('@electron/features/documents/main/documentOpenHandlers');
        const context = senderContext(7);
        const paths = Array.from({length: 513}, (_, index) => `/tmp/input-${index}.png`);
        const result = {
            kind: 'pdf' as const,
            workingPath: '/tmp/work/combined.pdf',
            originalPath: '/tmp/combined.pdf',
            isGenerated: true as const,
        };
        mocks.openInputPaths.mockResolvedValueOnce(result);

        await expect(handlers.handleOpenPdfDirectBatch(
            handlerContext(context),
            paths,
            'combine-1',
            {forceCombine: true},
        )).resolves.toEqual(result);

        expect(mocks.openInputPaths).toHaveBeenCalledWith(
            paths,
            expect.objectContaining({forceCombine: true}),
            context.sender,
        );
    });

    it('rejects a supported-extension symlink whose target extension is unsupported', async () => {
        const handlers = await import('@electron/features/documents/main/documentOpenHandlers');
        mocks.opendir.mockResolvedValue((async function* () {
            yield {name: 'linked.pdf'};
        })());
        mocks.realpath
            .mockResolvedValueOnce('/tmp/source-folder')
            .mockResolvedValueOnce('/tmp/source-folder/target.txt');

        await expect(handlers.collectSupportedFolderPaths('/tmp/source-folder')).resolves.toEqual([]);
        expect(mocks.stat).not.toHaveBeenCalled();
        expect(mocks.isSupportedOpenPath).toHaveBeenNthCalledWith(1, '/tmp/source-folder/linked.pdf');
        expect(mocks.isSupportedOpenPath).toHaveBeenNthCalledWith(2, '/tmp/source-folder/target.txt');
    });
});
