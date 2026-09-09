import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    SEARCH_JS_WHOLE_VALUE_MAX_BYTES,
    SEARCH_XLARGE_PAGE_COUNT_THRESHOLD,
    classifyXlargeSearchPath,
    ensureXlargeSearchIndex,
    resetXlargeSearchIndexBuilds,
} from '@electron/features/search/public';
import {requireDocumentRevisionToken} from '@contracts/documentRevision';

const mocks = vi.hoisted(() => ({buildXlargeSearchIndex: vi.fn()}));

vi.mock('@electron/features/search/xlargeIndexBuilder', () => ({buildXlargeSearchIndex: mocks.buildXlargeSearchIndex}));

const BUILD_RESULT = {
    indexPath: '/tmp/document.pdf.index.evb-search-v2.bin',
    documentRevision: requireDocumentRevisionToken('revision-token'),
    pageCount: 3,
    pagesScanned: 3,
    pagesWritten: 3,
    textBytes: 10,
    truncated: false,
    complete: true,
};

describe('xlarge search routing', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        resetXlargeSearchIndexBuilds();
    });

    it('uses size and page count as routing hints without rejecting a large document', () => {
        expect(classifyXlargeSearchPath({
            pathSizeBytes: SEARCH_JS_WHOLE_VALUE_MAX_BYTES,
            pageCount: SEARCH_XLARGE_PAGE_COUNT_THRESHOLD,
        })).toMatchObject({
            isXlarge: false,
            reasons: [],
        });
        expect(classifyXlargeSearchPath({pathSizeBytes: SEARCH_JS_WHOLE_VALUE_MAX_BYTES + 1})).toMatchObject({
            isXlarge: true,
            reasons: ['path-size'],
        });
        expect(classifyXlargeSearchPath({pageCount: SEARCH_XLARGE_PAGE_COUNT_THRESHOLD + 1})).toMatchObject({
            isXlarge: true,
            reasons: ['page-count'],
        });
    });

    it('coalesces same-revision builds while allowing one caller to cancel', async () => {
        let resolveBuild!: (result: typeof BUILD_RESULT) => void;
        let buildSignal!: AbortSignal;
        mocks.buildXlargeSearchIndex.mockImplementation(async (options: {signal: AbortSignal}) => {
            buildSignal = options.signal;
            return new Promise(resolve => {
                resolveBuild = resolve;
            });
        });
        const firstController = new AbortController();
        const first = ensureXlargeSearchIndex({
            pdfPath: '/tmp/document.pdf',
            documentRevision: requireDocumentRevisionToken('revision-token'),
            pageCount: 3,
            signal: firstController.signal,
        });
        const second = ensureXlargeSearchIndex({
            pdfPath: '/tmp/document.pdf',
            documentRevision: requireDocumentRevisionToken('revision-token'),
            pageCount: 3,
        });

        await vi.waitFor(() => expect(mocks.buildXlargeSearchIndex).toHaveBeenCalledOnce());
        firstController.abort(new Error('first caller cancelled'));
        await expect(first).rejects.toThrow('first caller cancelled');
        expect(buildSignal.aborted).toBe(false);

        resolveBuild(BUILD_RESULT);
        await expect(second).resolves.toEqual(BUILD_RESULT);
        expect(mocks.buildXlargeSearchIndex).toHaveBeenCalledOnce();
    });

    it('removes an orphaned flight before aborting when all waiters cancel', async () => {
        const builds: Array<{
            resolve: (result: typeof BUILD_RESULT) => void;
            signal: AbortSignal;
        }> = [];
        mocks.buildXlargeSearchIndex.mockImplementation((options: {signal: AbortSignal}) => (
            new Promise(resolve => {
                builds.push({
                    resolve,
                    signal: options.signal,
                });
            })
        ));
        const firstController = new AbortController();
        const secondController = new AbortController();
        const request = {
            pdfPath: '/tmp/document.pdf',
            documentRevision: requireDocumentRevisionToken('revision-token'),
            pageCount: 3,
        };
        const first = ensureXlargeSearchIndex({
            ...request,
            signal: firstController.signal,
        });
        const second = ensureXlargeSearchIndex({
            ...request,
            signal: secondController.signal,
        });
        await vi.waitFor(() => expect(builds).toHaveLength(1));

        firstController.abort(new Error('first caller cancelled'));
        secondController.abort(new Error('second caller cancelled'));
        await expect(first).rejects.toThrow('first caller cancelled');
        await expect(second).rejects.toThrow('second caller cancelled');

        const retry = ensureXlargeSearchIndex(request);
        await vi.waitFor(() => expect(builds).toHaveLength(2));
        builds[1]?.resolve(BUILD_RESULT);
        await expect(retry).resolves.toEqual(BUILD_RESULT);
        expect(builds[0]?.signal.aborted).toBe(true);
    });

    it('invalidates flights before aborting so reset retries do not join them', async () => {
        const builds: Array<{
            reject: (error: Error) => void;
            resolve: (result: typeof BUILD_RESULT) => void;
            signal: AbortSignal;
        }> = [];
        mocks.buildXlargeSearchIndex.mockImplementation((options: {signal: AbortSignal}) => (
            new Promise((resolve, reject) => {
                builds.push({
                    resolve,
                    reject,
                    signal: options.signal,
                });
                options.signal.addEventListener('abort', () => reject(options.signal.reason), {once: true});
            })
        ));
        const request = {
            pdfPath: '/tmp/document.pdf',
            documentRevision: requireDocumentRevisionToken('revision-token'),
            pageCount: 3,
        };
        const first = ensureXlargeSearchIndex(request);
        void first.catch(() => undefined);
        await vi.waitFor(() => expect(builds).toHaveLength(1));

        resetXlargeSearchIndexBuilds('reset for retry');
        const retry = ensureXlargeSearchIndex(request);
        await vi.waitFor(() => expect(builds).toHaveLength(2));
        await expect(first).rejects.toThrow('reset for retry');
        builds[1]?.resolve(BUILD_RESULT);
        await expect(retry).resolves.toEqual(BUILD_RESULT);
        expect(builds[0]?.signal.aborted).toBe(true);
    });

    it('allows a fresh request after the aborted flight settles', async () => {
        const builds: Array<{
            reject: (error: Error) => void;
            resolve: (result: typeof BUILD_RESULT) => void;
        }> = [];
        mocks.buildXlargeSearchIndex.mockImplementation(() => (
            new Promise((resolve, reject) => builds.push({
                resolve,
                reject,
            }))
        ));
        const request = {
            pdfPath: '/tmp/document.pdf',
            documentRevision: requireDocumentRevisionToken('revision-token'),
            pageCount: 3,
        };
        const controller = new AbortController();
        const first = ensureXlargeSearchIndex({
            ...request,
            signal: controller.signal,
        });
        await vi.waitFor(() => expect(builds).toHaveLength(1));
        controller.abort(new Error('cancelled build'));
        await expect(first).rejects.toThrow('cancelled build');

        const retry = ensureXlargeSearchIndex(request);
        await vi.waitFor(() => expect(builds).toHaveLength(2));
        builds[1]?.resolve(BUILD_RESULT);
        await expect(retry).resolves.toEqual(BUILD_RESULT);
    });
});
