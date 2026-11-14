import {getOptimizedPdfName} from '@app/platform/browser-api/browserFileName';
import type * as TBrowserQpdfEngineClient from '@app/platform/browser-api/browserQpdfEngineClient';
import type * as TBrowserWindowTabs from '@app/platform/browserWindowTabs';
import {createHash} from 'node:crypto';
import {requirePdfDateString} from '@contracts/pdfDateString';
import {createBrowserStoreStagedArtifact} from '@app/platform/browser/browserStagedArtifact';
import {
    afterAll,
    beforeEach,
    describe,
    expect,
    it,
    onTestFinished,
    vi,
} from 'vitest';
import {
    mkdtemp, readFile, rm,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {createNodeStorePort} from '@document-store/nodeStorePort';
import {join} from 'node:path';
import { PDFDocument } from 'pdf-lib';
import type {
    IDocumentsFileCapability,
    IDocumentsOpenCapability,
} from '@contracts/electronApiDocuments';
import type {TDocumentRef} from '@contracts/documentRef';
import {requireDocumentRef} from '@contracts/documentRef';
import {requireRequestId} from '@contracts/shared';
import type { BrowserDocumentStore } from '@app/platform/browserDocumentStore';
import {BROWSER_MAX_FULL_READ_BYTES as BROWSER_FULL_READ_LIMIT} from '@app/platform/browser/browserDocumentConstants';
import {BROWSER_PDF_COMBINE_MAX_REQUEST_BYTES} from '@contracts/browserPdfCombineWorker';
import {BROWSER_QPDF_MAX_INPUT_BYTES} from '@contracts/browserQpdfEngine';
import {
    FakeLockManager,
    MemoryStorage,
} from '@tests/unit/app/platform/browserPlatformTestDoubles';

import type {IDocxExportFileCapability} from '@contracts/docxExport';

// The download fallback refused files above this size before downloads were assembled from chunks.
const FORMER_DOWNLOAD_FALLBACK_MAX_BYTES = 64 * 1024 * 1024;

const PDF_SOURCE_OPTIONS = {
    mimeType: 'application/pdf',
    kind: 'source',
    saveKind: 'pdf',
} as const;

type TBrowserFilePermissionMode = 'read' | 'readwrite';
type TBrowserFilePermissionState = 'granted' | 'denied' | 'prompt';

interface IFileSystemFileHandlePermissionMethods {
    readonly queryPermission?: (descriptor?: {mode?: TBrowserFilePermissionMode}) => Promise<TBrowserFilePermissionState>;
    readonly requestPermission?: (descriptor?: {mode?: TBrowserFilePermissionMode}) => Promise<TBrowserFilePermissionState>;
}

interface IFileSystemWritableFileStreamFixtureOptions {
    readonly abort?: FileSystemWritableFileStream['abort'];
    readonly close?: FileSystemWritableFileStream['close'];
    readonly seek?: FileSystemWritableFileStream['seek'];
    readonly truncate?: FileSystemWritableFileStream['truncate'];
    readonly write?: FileSystemWritableFileStream['write'];
}

interface IFileSystemFileHandleFixtureOptions extends IFileSystemFileHandlePermissionMethods {
    readonly name: string;
    readonly createWritable?: FileSystemFileHandle['createWritable'];
    readonly getFile?: FileSystemFileHandle['getFile'];
    readonly isSameEntry?: FileSystemFileHandle['isSameEntry'];
}

function createFileSystemWritableFileStream(
    options: IFileSystemWritableFileStreamFixtureOptions = {},
): FileSystemWritableFileStream {
    const writable = Object.assign(new WritableStream(), {
        abort: options.abort ?? (async (_reason?: unknown) => {}),
        close: options.close ?? (async () => {}),
        seek: options.seek ?? (async (_position: number) => {}),
        truncate: options.truncate ?? (async (_size: number) => {}),
        write: options.write ?? (async (_chunk: FileSystemWriteChunkType) => {}),
    });
    return writable satisfies FileSystemWritableFileStream;
}

function requireArrayBufferChunk(chunk: FileSystemWriteChunkType): ArrayBuffer {
    if (!(chunk instanceof ArrayBuffer)) {
        throw new TypeError('Expected browser file writer to receive an ArrayBuffer');
    }
    return chunk;
}

function createFileSystemFileHandle(
    options: IFileSystemFileHandleFixtureOptions,
): FileSystemFileHandle & IFileSystemFileHandlePermissionMethods {
    const defaultFile = new File([], options.name);
    const handle = {
        kind: 'file',
        name: options.name,
        getFile: options.getFile ?? (async () => defaultFile),
        isSameEntry: options.isSameEntry ?? (async (_other: FileSystemHandle) => false),
        createWritable: options.createWritable
            ?? (async () => createFileSystemWritableFileStream()),
        createSyncAccessHandle: async () => {
            throw new Error('Synchronous access is not part of this file handle fixture');
        },
        ...(options.queryPermission ? {queryPermission: options.queryPermission} : {}),
        ...(options.requestPermission ? {requestPermission: options.requestPermission} : {}),
    } satisfies FileSystemFileHandle & IFileSystemFileHandlePermissionMethods;
    return handle;
}

function createOversizedPdfFile(fileName: string, size: number): File {
    const file = new File([], fileName, {type: 'application/pdf'});
    Object.defineProperty(file, 'size', {
        configurable: true,
        value: size,
    });
    vi.spyOn(file, 'slice').mockImplementation((start = 0, end = size) => (
        new Blob([new Uint8Array(Math.max(0, end - start))], {type: 'application/pdf'})
    ));
    return file;
}

const qpdfRun = vi.hoisted(() => vi.fn());
vi.mock('@app/platform/browser-api/browserQpdfEngineClient', async importOriginal => ({
    ...await importOriginal<typeof TBrowserQpdfEngineClient>(),
    runBrowserQpdfCommand: qpdfRun,
}));

const browserPdfCombineWorkerMock = vi.hoisted(() => ({
    canUse: vi.fn(() => false),
    cloneInput: vi.fn((fileName: string, data: Uint8Array) => ({
        fileName,
        data,
    })),
    run: vi.fn(),
}));
const browserDjvuCapabilityMock = vi.hoisted(() => ({
    cancel: vi.fn(async () => ({canceled: true})),
    runConversion: vi.fn(),
}));
const browserAnnotationParseMock = vi.hoisted(() => ({run: vi.fn()}));
/** The bytes the engine appends after a document for a native edit. */
const nativeEditTail = vi.hoisted(() => ({bytes: Uint8Array.of(2, 3)}));
const utifMock = vi.hoisted(() => ({
    decode: vi.fn(() => []),
    decodeImage: vi.fn(),
    toRGBA8: vi.fn(() => new Uint8Array()),
}));
const pdfjsModule = vi.hoisted(() => {
    class MockPdfDataRangeTransport {
        public onDataRange = vi.fn();
        public onDataProgress = vi.fn();
    }

    return {
        version: '6.3.311',
        GlobalWorkerOptions: {},
        PDFDataRangeTransport: MockPdfDataRangeTransport,
        VerbosityLevel: {ERRORS: 3},
        getDocument: vi.fn((_rawInit: unknown) => (createLoadedPdfTask())),
    };
});

// A PDF.js loading task whose document disposes through it, as PDF.js does.
function createLoadedPdfTask() {
    const destroy = vi.fn(async () => {});
    return {
        promise: Promise.resolve({loadingTask: {destroy}}),
        destroy,
    };
}

vi.mock('@app/platform/browserWindowTabs', async importOriginal => ({
    ...await importOriginal<typeof TBrowserWindowTabs>(),
    reserveBrowserDocumentWorkingCopy: async (fileName: string) => {
        const {createBrowserDocumentRef} = await import('@app/platform/browser/browserDocumentRefs');
        return createBrowserDocumentRef(fileName);
    },
    retireBrowserDocumentWorkingCopy: async () => {},
}));

vi.mock('@app/platform/browser-api/browserPdfCombineWorkerClient', () => ({
    BrowserPdfCombineWorkerUnavailableError: class BrowserPdfCombineWorkerUnavailableError extends Error {},
    canUseBrowserPdfCombineWorker: () => browserPdfCombineWorkerMock.canUse(),
    cloneCombineWorkerInput: (fileName: string, data: Uint8Array) =>
        browserPdfCombineWorkerMock.cloneInput(fileName, data),
    runBrowserPdfCombineWorkerRequest: (type: string, payload: unknown) =>
        browserPdfCombineWorkerMock.run(type, payload),
}));
vi.mock('@app/platform/browser-api/browserDjvuCapability', () => ({browserDjvuCapability: {cancel: browserDjvuCapabilityMock.cancel}}));
vi.mock('@app/platform/browser-api/browserDjvuConversionPipeline', () => ({runBrowserDjvuConversion: browserDjvuCapabilityMock.runConversion}));
vi.mock('@app/platform/browser-api/browserPageOpsWorkerClient', () => ({runBrowserPageOpsWorkerRequest: (...args: unknown[]) => browserAnnotationParseMock.run(...args)}));
// The engine appends the tail after the document's bytes in its own file, as a native edit's revision.
vi.mock('@app/platform/browser/browserStorePort', async importOriginal => ({
    ...await importOriginal<typeof import('@app/platform/browser/browserStorePort')>(),
    appendPdfMutationsToStoreFile: async (file: {writeAt(offset: number, bytes: Uint8Array): Promise<void>}, base: number) => {
        await file.writeAt(base, nativeEditTail.bytes);
        return {pageCount: 1, length: base + nativeEditTail.bytes.byteLength, identityBindings: [], sha256: 'a'.repeat(64)};
    },
}));

function withNativeEditTail(bytes: Uint8Array) {
    const edited = new Uint8Array(bytes.byteLength + nativeEditTail.bytes.byteLength);
    edited.set(bytes);
    edited.set(nativeEditTail.bytes, bytes.byteLength);
    return edited;
}
vi.mock('utif', () => {
    const decode = (...args: Parameters<typeof utifMock.decode>) => utifMock.decode(...args);
    const decodeImage = (...args: Parameters<typeof utifMock.decodeImage>) => utifMock.decodeImage(...args);
    const toRGBA8 = (...args: Parameters<typeof utifMock.toRGBA8>) => utifMock.toRGBA8(...args);
    return {
        decode,
        decodeImage,
        toRGBA8,
        default: {
            decode,
            decodeImage,
            toRGBA8,
        },
    };
});
vi.mock('pdfjs-dist', () => pdfjsModule);

async function createPdfBytes(pageSize?: [number, number]) {
    const document = await PDFDocument.create();
    document.addPage(pageSize);
    return new Uint8Array(await document.save());
}

async function getRevisionOptions(
    browserDocumentStore: Pick<BrowserDocumentStore, 'getDocumentRevision'>,
    ref: string,
) {
    const revision = await browserDocumentStore.getDocumentRevision(ref);
    return { expectedDocumentRevisionToken: revision.token };
}

function createMockElement(tagName: string) {
    const listeners = new Map<string, () => void>();
    return {
        tagName: tagName.toUpperCase(),
        accept: '',
        multiple: false,
        type: '',
        style: {},
        files: null,
        content: {
            firstChild: null,
            appendChild() {},
        },
        relList: { supports() { return true; } },
        setAttribute() {},
        appendChild() {},
        append() {},
        remove() {},
        click() {
            listeners.get('change')?.();
        },
        addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
            if (typeof listener === 'function') {
                listeners.set(type, () => listener(new Event(type)));
            }
        },
        removeEventListener() {},
        getContext() {
            return null;
        },
    };
}

interface ILoadBrowserDocumentsFileCapabilityOptions {
    clearSearchCaches?: (pdfPath?: string) => void;
    inputFiles?: File[];
    windowOverrides?: Record<string, unknown>;
}

interface ILoadedBrowserDocumentsFileCapability {
    BROWSER_DOCUMENT_CHUNK_SIZE: number;
    BROWSER_MAX_FULL_READ_BYTES: number;
    browserDocumentStore: BrowserDocumentStore;
    capability: IDocumentsFileCapability & IDocxExportFileCapability;
}

async function loadCreateCombinedPdfFromPaths() {
    const module = await import('@app/platform/browser-api/createBrowserDocumentsFileCapability');
    return module.createBrowserCombinedPdfFromPaths;
}

async function loadBrowserOpenProgressListener(): Promise<
    IDocumentsOpenCapability['onOpenDocumentDirectBatchProgress']
> {
    const module = await import('@app/platform/browser-api/documentsMenuCapability');
    return module.onBrowserOpenDocumentDirectBatchProgress;
}

async function loadBrowserDocumentsFileCapability(
    options?: ILoadBrowserDocumentsFileCapabilityOptions,
): Promise<ILoadedBrowserDocumentsFileCapability> {
    vi.resetModules();
    const localStorage = new MemoryStorage();
    const sessionStorage = new MemoryStorage();
    vi.stubGlobal('window', {
        localStorage,
        sessionStorage,
        addEventListener() {},
        removeEventListener() {},
        setTimeout,
        clearTimeout,
        ...options?.windowOverrides,
    });
    vi.stubGlobal('document', {
        cookie: '',
        body: {
            append() {},
            appendChild() {},
            removeChild() {},
        },
        createElement(tagName: string) {
            const element = createMockElement(tagName);
            if (tagName === 'input' && options?.inputFiles) {
                (element as { files: File[] | null }).files = options.inputFiles;
            }
            return element;
        },
        createElementNS(_namespace: string, tagName: string) {
            return createMockElement(tagName);
        },
        createTextNode(text: string) {
            return { nodeValue: text };
        },
        createComment(text: string) {
            return { nodeValue: text };
        },
        querySelector() {
            return null;
        },
    });

    // Its mock's factory is asynchronous: settle it before the modules that import it load.
    const {createMemoryStorePort} = await import('@app/platform/browser/browserStorePort');
    const [
        { createBrowserDocumentsFileCapability },
        {
            BROWSER_DOCUMENT_CHUNK_SIZE,
            BROWSER_MAX_FULL_READ_BYTES,
            browserDocumentStore,
        },
        {browserPublication},
    ] = await Promise.all([
        import('@app/platform/browser-api/createBrowserDocumentsFileCapability'),
        import('@app/platform/browserDocumentStore'),
        import('@app/platform/browser/browserPublication'),
    ]);
    // Node has no origin private file system: the store's durable documents live in a temporary directory,
    // through the core's Node port.
    const storeRoot = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), 'browser-document-store-'));
    storeRoots.push(storeRoot);
    vi.spyOn(browserDocumentStore, 'stores').mockResolvedValue({
        durable: {port: createNodeStorePort(storeRoot), publication: browserPublication},
        memory: {port: createMemoryStorePort(), publication: browserPublication},
    });

    return {
        BROWSER_DOCUMENT_CHUNK_SIZE,
        BROWSER_MAX_FULL_READ_BYTES,
        capability: createBrowserDocumentsFileCapability({clearSearchCaches: options?.clearSearchCaches ?? (() => {})}),
        browserDocumentStore,
    };
}

const storeRoots: string[] = [];

afterAll(async () => {
    await Promise.all(storeRoots.map(root => rm(root, {recursive: true, force: true})));
});

describe('createBrowserDocumentsFileCapability', {timeout: 20_000}, () => {
    beforeEach(() => {
        vi.unstubAllGlobals();
        qpdfRun.mockReset();
        qpdfRun.mockImplementation(async command => ({
            exitCode: 0,
            stdout: command === 'page-count' ? '1' : '',
            stderr: '',
            output: null,
        }));
        browserPdfCombineWorkerMock.canUse.mockReset();
        browserPdfCombineWorkerMock.canUse.mockReturnValue(false);
        browserPdfCombineWorkerMock.cloneInput.mockClear();
        browserPdfCombineWorkerMock.run.mockReset();
        browserDjvuCapabilityMock.runConversion.mockReset();
        browserAnnotationParseMock.run.mockReset();
        utifMock.decode.mockReset();
        utifMock.decode.mockReturnValue([]);
        utifMock.decodeImage.mockReset();
        utifMock.toRGBA8.mockReset();
        utifMock.toRGBA8.mockReturnValue(new Uint8Array());
        pdfjsModule.getDocument.mockReset();
        pdfjsModule.getDocument.mockReturnValue(createLoadedPdfTask());
    });

    it.each([
        'commit',
        'cancel',
        'denied',
        'large-download',
    ])('preserves native Save bytes through %s', async (outcome) => {
        const original = outcome === 'large-download'
            ? new Uint8Array(FORMER_DOWNLOAD_FALLBACK_MAX_BYTES + 1)
            : Uint8Array.of(37, 80, 68, 70, 1);
        const edited = withNativeEditTail(original);
        const downloads: Blob[] = [];
        if (outcome === 'large-download') {
            class DownloadURL extends URL {}
            Object.defineProperties(DownloadURL, {
                createObjectURL: {value: (blob: Blob) => {
                    downloads.push(blob);
                    return 'blob:staged-download';
                }},
                revokeObjectURL: {value: () => {}},
            });
            vi.stubGlobal('URL', DownloadURL);
        }
        let physical = original.slice();
        const handle = createFileSystemFileHandle({
            name: 'native.pdf',
            getFile: async () => new File([physical], 'native.pdf', {type: 'application/pdf'}),
            createWritable: async () => {
                if (outcome === 'denied') throw new DOMException('Write denied', 'NotAllowedError');
                return createFileSystemWritableFileStream({write: async chunk => {
                    physical = new Uint8Array(requireArrayBufferChunk(chunk));
                }});
            },
        });
        const {
            capability, browserDocumentStore: store,
        } = await loadBrowserDocumentsFileCapability({windowOverrides: {showSaveFilePicker: outcome === 'large-download' ? undefined : async () => {
            if (outcome === 'cancel') throw new DOMException('Canceled', 'AbortError');
            return handle;
        }}});
        const source = await store.createStoredDocument('native.pdf', original, PDF_SOURCE_OPTIONS);
        const working = await store.cloneAsWorkingCopy(source);
        const revision = await store.getDocumentRevision(working);
        const {stagedOutput: receipt} = await capability.applyPdfNativeMutationsToWorkingCopy!(
            working,
            {},
            requirePdfDateString('D:20260102000000Z'),
            {expectedDocumentRevisionToken: revision.token},
        );
        if (!receipt) throw new Error('Expected the native edit to stage');
        // Staging appends to the working copy without committing: readers keep its revision.
        expect((await store.stat(working)).size).toBe(original.byteLength);
        const commit = capability.commitStagedPdfNativeMutations!(working, receipt, {expectedDocumentRevisionToken: revision.token});
        if (outcome === 'denied') await expect(commit).rejects.toThrow('Write denied');
        else expect((await commit).applied).toBe(outcome === 'commit' || outcome === 'large-download');
        const expected = outcome === 'commit' || outcome === 'large-download' ? edited : original;
        if (outcome === 'large-download') {
            expect(downloads).toHaveLength(1);
            expect(new Uint8Array(await downloads[0]!.arrayBuffer())).toEqual(edited);
        } else expect(physical).toEqual(expected);
        // A Save the file refused keeps the edits it committed in the working copy, unsaved; a cancelled pick commits nothing.
        await expect(store.read(working)).resolves.toEqual(outcome === 'cancel' ? original : edited);
        await expect(store.read(source)).resolves.toEqual(expected);
        const token = (await store.getDocumentRevision(working)).token;
        if (outcome === 'cancel') expect(token).toBe(revision.token);
        if (outcome === 'denied') expect(token).not.toBe(revision.token);
    });

    it.each([
        [
            'structured',
            'download',
            'proxy',
        ],
        [
            'structured',
            'download',
            'edited',
        ],
        [
            'structured',
            'handle',
            'proxy',
        ],
        [
            'structured',
            'handle',
            'edited',
        ],
        [
            'native',
            'download',
            'edited',
        ],
        [
            'native',
            'handle',
            'edited',
        ],
    ] as const)('returns its committed revision after a reader write during %s %s %s settlement', async (path, target, content) => {
        let afterCommit = async () => {};
        let physical = Uint8Array.of(37, 80, 68, 70, 1);
        const handle = createFileSystemFileHandle({
            name: 'receipt.pdf',
            getFile: async () => new File([physical], 'receipt.pdf', {lastModified: 1}),
            createWritable: async () => createFileSystemWritableFileStream({write: async chunk => {
                physical = new Uint8Array(requireArrayBufferChunk(chunk));
            }}),
        });
        if (target === 'download') {
            class DownloadURL extends URL {}
            Object.defineProperties(DownloadURL, {
                createObjectURL: {value: () => 'blob:receipt-download'},
                revokeObjectURL: {value: () => {}},
            });
            vi.stubGlobal('URL', DownloadURL);
        }
        const {
            capability, browserDocumentStore: store,
        } = await loadBrowserDocumentsFileCapability({
            windowOverrides: {showSaveFilePicker: target === 'handle' ? async () => handle : undefined},
            clearSearchCaches: async () => afterCommit(),
        });
        const source = await store.createStoredDocument('receipt.pdf', physical, PDF_SOURCE_OPTIONS);
        const working = await store.cloneAsWorkingCopy(source);
        if (content === 'edited') await store.write(working, Uint8Array.of(37, 80, 68, 70, 2), await getRevisionOptions(store, working));
        const revisionOptions = await getRevisionOptions(store, working);
        const committedBytes = withNativeEditTail(await store.read(working));
        const stagedOutput = path === 'native'
            ? (await capability.applyPdfNativeMutationsToWorkingCopy!(working, {}, requirePdfDateString('D:20260102000000Z'), revisionOptions)).stagedOutput!
            : undefined;
        let ownRevision: Awaited<ReturnType<typeof store.getDocumentRevision>> | undefined;
        afterCommit = async () => {
            ownRevision = await store.getDocumentRevision(working);
            await store.write(working, Uint8Array.of(37, 80, 68, 70, 4), {expectedDocumentRevisionToken: ownRevision.token});
        };
        const result = path === 'structured'
            ? await capability.saveFileStructured(working, revisionOptions)
            : await capability.commitStagedPdfNativeMutations!(working, stagedOutput!, revisionOptions);
        expect(result).toMatchObject({documentRevision: ownRevision});
        expect(ownRevision).toBeDefined();
        expect((await store.getDocumentRevision(working)).token).not.toBe(ownRevision?.token);
        await expect(store.read(working)).resolves.toEqual(Uint8Array.of(37, 80, 68, 70, 4));
        if (path === 'native') expect(physical).toEqual(target === 'handle' ? committedBytes : physical);
    });

    it('returns typed unsupported results for desktop-only folder actions', async () => {
        const { capability } = await loadBrowserDocumentsFileCapability();

        await expect(capability.showItemInFolder(requireDocumentRef('browser://documents/source.pdf'))).resolves.toBe(false);
    });

    it('parses a working copy through WASM after checking the browser full-read budget', async () => {
        const {
            capability,
            browserDocumentStore,
        } = await loadBrowserDocumentsFileCapability();
        const workingRef = await browserDocumentStore.createStoredDocument(
            'writer-parse.pdf',
            await createPdfBytes(),
            {
                ...PDF_SOURCE_OPTIONS,
                kind: 'working',
            },
        );
        const revisionOptions = await getRevisionOptions(browserDocumentStore, workingRef);
        browserAnnotationParseMock.run.mockResolvedValue({data: new TextEncoder().encode([
            JSON.stringify({
                format: 'evb-pdf-annotation-parse',
                schemaVersion: 1,
                pageCount: 1,
                chunkBytes: 4 * 1024 * 1024,
            }),
            JSON.stringify({
                chunkIndex: 0,
                entries: [{
                    kind: 'foreign',
                    pageIndex: 0,
                    objectNumber: 4,
                    generationNumber: 0,
                    name: 'link',
                    subtype: 'Link',
                    reason: 'unsupported annotation subtype /Link',
                }],
            }),
        ].join('\n') + '\n')});

        await expect(capability.parsePdfAnnotations(workingRef, revisionOptions)).resolves.toEqual({
            documentRevisionToken: revisionOptions.expectedDocumentRevisionToken,
            pageCount: 1,
            entities: [],
            foreign: [{
                kind: 'foreign',
                pageIndex: 0,
                objectNumber: 4,
                generationNumber: 0,
                name: 'link',
                subtype: 'Link',
                reason: 'unsupported annotation subtype /Link',
            }],
        });
        expect(browserAnnotationParseMock.run).toHaveBeenCalledWith(
            'parseAnnotations',
            {data: expect.any(Uint8Array)},
            {
                dedicated: true,
                signal: undefined,
            },
        );
    });

    it('reads page labels whatever happened to the outline, and reports their own failure', async () => {
        const {
            capability,
            browserDocumentStore,
        } = await loadBrowserDocumentsFileCapability();
        const workingRef = await browserDocumentStore.createStoredDocument(
            'page-label-parts.pdf',
            await createPdfBytes(),
            {
                ...PDF_SOURCE_OPTIONS,
                kind: 'working',
            },
        );
        browserAnnotationParseMock.run.mockResolvedValueOnce({
            bookmarksError: 'PDF catalog /Outlines must be a dictionary',
            pageLabels: [{
                pageIndex: 0,
                style: 'r',
            }],
        });
        await expect(capability.readPdfPageLabelRanges(workingRef)).resolves.toEqual([{
            startPage: 1,
            style: 'r',
            prefix: '',
            startNumber: 1,
        }]);
        browserAnnotationParseMock.run.mockResolvedValueOnce({
            bookmarks: [],
            pageLabelsError: 'PageLabels Nums must contain key/value pairs',
        });
        await expect(capability.readPdfPageLabelRanges(workingRef)).rejects.toThrow('PageLabels Nums must contain key/value pairs');
    });

    it('reads compact page-label ranges through the browser catalog worker', async () => {
        const {
            capability,
            browserDocumentStore,
        } = await loadBrowserDocumentsFileCapability();
        const workingRef = await browserDocumentStore.createStoredDocument(
            'page-labels.pdf',
            await createPdfBytes(),
            {
                ...PDF_SOURCE_OPTIONS,
                kind: 'working',
            },
        );
        browserAnnotationParseMock.run.mockResolvedValueOnce({
            bookmarks: [],
            pageLabels: [
                {
                    pageIndex: 0,
                    style: 'r',
                },
                {
                    pageIndex: 1,
                    prefix: 'Appendix ',
                    start: 3,
                },
            ],
        });

        await expect(capability.readPdfPageLabelRanges(workingRef)).resolves.toEqual([
            {
                startPage: 1,
                style: 'r',
                prefix: '',
                startNumber: 1,
            },
            {
                startPage: 2,
                style: null,
                prefix: 'Appendix ',
                startNumber: 3,
            },
        ]);
        expect(browserAnnotationParseMock.run).toHaveBeenCalledWith(
            'readCatalog',
            {data: expect.any(Uint8Array)},
            {dedicated: true},
        );
    });

    it('registers browser files for open after ingestion completes', async () => {
        const file = new File([Uint8Array.of(1, 2, 3)], 'drop.pdf', { type: 'application/pdf' });
        const {
            capability,
            browserDocumentStore,
        } = await loadBrowserDocumentsFileCapability();

        const refs = await capability.registerFilesForOpen([file]);

        expect(refs).toHaveLength(1);
        const [ref] = refs;
        expect(ref).toBeDefined();
        await expect(browserDocumentStore.read(ref as string)).resolves.toEqual(Uint8Array.of(1, 2, 3));
    });

    it.each([
        {
            name: 'combine',
            open: (capability: IDocumentsFileCapability) => capability.openCombineDialog(),
            acceptKey: 'application/octet-stream',
            expectedExtensions: [
                '.djvu',
                '.djv',
            ],
        },
        {
            name: 'image',
            open: (capability: IDocumentsFileCapability) => capability.openImageDialog(),
            acceptKey: 'image/*',
            expectedExtensions: [],
        },
    ])('applies the browser $name picker format policy', async ({
        open,
        acceptKey,
        expectedExtensions,
    }) => {
        const showOpenFilePicker = vi.fn(async () => []);
        const { capability } = await loadBrowserDocumentsFileCapability({ windowOverrides: { showOpenFilePicker } });

        await expect(open(capability)).resolves.toBeNull();

        const firstCall = showOpenFilePicker.mock.calls[0] as [{types?: Array<{ accept: Record<string, string[]>; }>;}] | undefined;
        const accept = firstCall?.[0]?.types?.[0]?.accept;
        expect(showOpenFilePicker).toHaveBeenCalledTimes(1);
        expect(accept?.['image/*']).not.toContain('.svgz');
        if (expectedExtensions.length > 0) {
            expect(accept?.[acceptKey]).toEqual(expectedExtensions);
        }
    });

    it('surfaces first file-handle denial before using the fallback on the next user action', async () => {
        const pdfBytes = await createPdfBytes();
        const pickedPdf = new File([pdfBytes], 'fallback.pdf', { type: 'application/pdf' });
        const deniedHandle = createFileSystemFileHandle({
            name: 'denied.pdf',
            getFile: vi.fn(async () => {
                throw new DOMException('Not allowed', 'NotAllowedError');
            }),
        });
        const showOpenFilePicker = vi.fn(async () => [deniedHandle]);
        const { capability } = await loadBrowserDocumentsFileCapability({
            inputFiles: [pickedPdf],
            windowOverrides: { showOpenFilePicker },
        });

        await expect(capability.openDocumentDialog()).rejects.toMatchObject({
            message: 'browser-file-picker-setup-denied',
            name: 'BrowserFilePickerSetupDeniedError',
        });
        const fallbackResult = await capability.openDocumentDialog();

        expect(showOpenFilePicker).toHaveBeenCalledTimes(1);
        expect(fallbackResult?.kind).toBe('pdf');
    });

    it('validates oversized browser PDFs through range reads without a full read', async () => {
        const {
            capability,
            browserDocumentStore,
        } = await loadBrowserDocumentsFileCapability();
        const path = requireDocumentRef('browser://documents/source/large-validation.pdf');
        const largeSize = BROWSER_QPDF_MAX_INPUT_BYTES + 1;
        const statSpy = vi.spyOn(browserDocumentStore, 'stat').mockResolvedValue({
            size: largeSize,
            modifiedAt: 0,
        });
        const snapshotSpy = vi.spyOn(browserDocumentStore, 'getContentSnapshot').mockResolvedValue({
            size: largeSize,
            modifiedAt: 0,
            contentSignature: 'large-validation',
        });
        const readSpy = vi.spyOn(browserDocumentStore, 'read').mockRejectedValue(
            new Error('full browser reads are forbidden for this test'),
        );
        const readRangeSpy = vi.spyOn(browserDocumentStore, 'readRange').mockResolvedValue(
            new Uint8Array(4 * 1024 * 1024),
        );
        pdfjsModule.getDocument.mockReturnValue(createLoadedPdfTask());

        await expect(capability.validatePdfPath(path)).resolves.toEqual({
            isValid: true,
            tool: 'browser',
            errors: [],
            warnings: [expect.stringContaining(`${Math.round(BROWSER_QPDF_MAX_INPUT_BYTES / (1024 * 1024))} MiB`)],
        });

        expect(readSpy).not.toHaveBeenCalled();
        expect(readRangeSpy).toHaveBeenCalledWith(path, 0, 4 * 1024 * 1024);
        statSpy.mockRestore();
        snapshotSpy.mockRestore();
        readSpy.mockRestore();
        readRangeSpy.mockRestore();
    });

    it('requests later PDF ranges through the public validator without reading the whole source', async () => {
        const {
            capability,
            browserDocumentStore,
        } = await loadBrowserDocumentsFileCapability();
        const path = requireDocumentRef('browser://documents/source/multi-range-validation.pdf');
        const chunkSize = 4 * 1024 * 1024;
        const largeSize = BROWSER_QPDF_MAX_INPUT_BYTES + 1;
        const statSpy = vi.spyOn(browserDocumentStore, 'stat').mockResolvedValue({
            size: largeSize,
            modifiedAt: 0,
        });
        const snapshotSpy = vi.spyOn(browserDocumentStore, 'getContentSnapshot').mockResolvedValue({
            size: largeSize,
            modifiedAt: 0,
            contentSignature: 'multi-range-validation',
        });
        const readSpy = vi.spyOn(browserDocumentStore, 'read').mockRejectedValue(
            new Error('whole browser reads are forbidden for this test'),
        );
        const readRangeSpy = vi.spyOn(browserDocumentStore, 'readRange').mockImplementation(
            async (_path, _offset, length) => new Uint8Array(length),
        );
        pdfjsModule.getDocument.mockImplementation((rawInit: unknown) => {
            const init = rawInit as {range: {
                requestDataRange: (begin: number, end: number) => void;
                onDataRange: (...args: unknown[]) => void;
            }};
            const destroy = vi.fn(async () => {});
            const promise = new Promise<{loadingTask: {destroy: typeof destroy}}>(resolve => {
                init.range.onDataRange = () => resolve({loadingTask: {destroy}});
                init.range.requestDataRange(chunkSize, chunkSize * 2);
            });
            return {
                promise,
                destroy,
            };
        });

        await expect(capability.validatePdfPath(path)).resolves.toEqual({
            isValid: true,
            tool: 'browser',
            errors: [],
            warnings: [expect.stringContaining(`${Math.round(BROWSER_QPDF_MAX_INPUT_BYTES / (1024 * 1024))} MiB`)],
        });

        expect(readSpy).not.toHaveBeenCalled();
        expect(readRangeSpy).toHaveBeenNthCalledWith(1, path, 0, chunkSize);
        expect(readRangeSpy).toHaveBeenNthCalledWith(2, path, chunkSize, chunkSize);
        expect(readRangeSpy).toHaveBeenCalledTimes(2);
        statSpy.mockRestore();
        snapshotSpy.mockRestore();
        readSpy.mockRestore();
        readRangeSpy.mockRestore();
    });

    it('propagates a failed later PDF range through the public validator without a whole read', async () => {
        const {
            capability,
            browserDocumentStore,
        } = await loadBrowserDocumentsFileCapability();
        const path = requireDocumentRef('browser://documents/source/failed-range-validation.pdf');
        const chunkSize = 4 * 1024 * 1024;
        const largeSize = BROWSER_QPDF_MAX_INPUT_BYTES + 1;
        const statSpy = vi.spyOn(browserDocumentStore, 'stat').mockResolvedValue({
            size: largeSize,
            modifiedAt: 0,
        });
        const snapshotSpy = vi.spyOn(browserDocumentStore, 'getContentSnapshot').mockResolvedValue({
            size: largeSize,
            modifiedAt: 0,
            contentSignature: 'failed-range-validation',
        });
        const readSpy = vi.spyOn(browserDocumentStore, 'read').mockRejectedValue(
            new Error('whole browser reads are forbidden for this test'),
        );
        const rangeFailure = new Error('second PDF range failed');
        const readRangeSpy = vi.spyOn(browserDocumentStore, 'readRange').mockImplementation(
            async (_path, offset, length) => {
                if (offset === 0) {
                    return new Uint8Array(length);
                }
                throw rangeFailure;
            },
        );
        pdfjsModule.getDocument.mockImplementation((rawInit: unknown) => {
            const init = rawInit as {range: {
                requestDataRange: (begin: number, end: number) => void;
                onDataRange: (...args: unknown[]) => void;
            }};
            const destroy = vi.fn(async () => {});
            const promise = new Promise<{loadingTask: {destroy: typeof destroy}}>(() => {
                init.range.onDataRange = () => undefined;
                init.range.requestDataRange(chunkSize, chunkSize * 2);
            });
            return {
                promise,
                destroy,
            };
        });

        await expect(capability.validatePdfPath(path)).resolves.toEqual({
            isValid: false,
            tool: 'browser',
            errors: ['second PDF range failed'],
            warnings: [],
        });

        expect(readSpy).not.toHaveBeenCalled();
        expect(readRangeSpy).toHaveBeenNthCalledWith(1, path, 0, chunkSize);
        expect(readRangeSpy).toHaveBeenNthCalledWith(2, path, chunkSize, chunkSize);
        expect(readRangeSpy).toHaveBeenCalledTimes(2);
        statSpy.mockRestore();
        snapshotSpy.mockRestore();
        readSpy.mockRestore();
        readRangeSpy.mockRestore();
    });

    it('emits browser batch-open progress while combining multiple inputs', async () => {
        const { browserDocumentStore } = await loadBrowserDocumentsFileCapability();
        const [
            createCombinedPdfFromPaths,
            onOpenDocumentDirectBatchProgress,
        ] = await Promise.all([
            loadCreateCombinedPdfFromPaths(),
            loadBrowserOpenProgressListener(),
        ]);
        const firstRef = await browserDocumentStore.createStoredDocument(
            'first.pdf',
            Uint8Array.of(1, 2, 3),
            {...PDF_SOURCE_OPTIONS},
        );
        const secondRef = await browserDocumentStore.createStoredDocument(
            'second.pdf',
            Uint8Array.of(4, 5, 6),
            {...PDF_SOURCE_OPTIONS},
        );
        browserPdfCombineWorkerMock.canUse.mockReturnValue(true);
        browserAnnotationParseMock.run.mockResolvedValue({status: 'written', pageCount: 2, length: 3, data: Uint8Array.of(9, 8, 7)});

        const progressEvents: Array<{
            operation: string;
            requestId: string;
            processed: number;
            total: number;
            percent: number;
            elapsedMs: number;
            estimatedRemainingMs: number | null;
        }> = [];
        const stopListening = onOpenDocumentDirectBatchProgress((progress) => {
            progressEvents.push(progress);
        });

        try {
            await createCombinedPdfFromPaths(
                [
                    firstRef,
                    secondRef,
                ],
                { requestId: requireRequestId('browser-batch-1') },
            );
        } finally {
            stopListening();
        }

        expect(progressEvents).toEqual(expect.arrayContaining([
            expect.objectContaining({
                operation: 'document-open',
                requestId: 'browser-batch-1',
                processed: 1,
                total: 2,
            }),
            expect.objectContaining({
                operation: 'document-open',
                requestId: 'browser-batch-1',
                processed: 2,
                total: 2,
                percent: 95,
            }),
        ]));
    });

    // PDFs are merged by range and have no such budget.
    it.each([
        [
            'png',
            BROWSER_PDF_COMBINE_MAX_REQUEST_BYTES,
        ],
    ] as const)('rejects a %s selection exceeding its combined request budget before reading its files', async (extension, budget) => {
        const {browserDocumentStore} = await loadBrowserDocumentsFileCapability();
        const createCombinedPdfFromPaths = await loadCreateCombinedPdfFromPaths();
        const refs = await Promise.all([
            'first',
            'second',
        ].map(name => browserDocumentStore.createStoredDocument(
            `${name}.${extension}`,
            Uint8Array.of(1),
            PDF_SOURCE_OPTIONS,
        )));
        browserPdfCombineWorkerMock.canUse.mockReturnValue(true);
        const stat = vi.spyOn(browserDocumentStore, 'stat').mockResolvedValue({
            size: Math.floor(budget / 2) + 1,
            modifiedAt: 0,
        });
        const read = vi.spyOn(browserDocumentStore, 'read');
        try {
            await expect(createCombinedPdfFromPaths(refs)).rejects.toMatchObject({errorEnvelope: {
                code: 'browser-byte-limit',
                maxBytes: budget,
            }});
            expect(read).not.toHaveBeenCalled();
            expect(browserPdfCombineWorkerMock.run).not.toHaveBeenCalled();
        } finally {
            stat.mockRestore();
            read.mockRestore();
        }
        await expect(browserDocumentStore.read(refs[0]!)).resolves.toEqual(Uint8Array.of(1));
    });

    it('offloads supported mixed PDF and raster-image combine jobs to the browser worker', async () => {
        const { browserDocumentStore } = await loadBrowserDocumentsFileCapability();
        const createCombinedPdfFromPaths = await loadCreateCombinedPdfFromPaths();
        const pdfRef = await browserDocumentStore.createStoredDocument(
            'first.pdf',
            Uint8Array.of(1, 2, 3),
            {...PDF_SOURCE_OPTIONS},
        );
        const imageRef = await browserDocumentStore.createStoredDocument(
            'photo.png',
            Uint8Array.of(4, 5, 6),
            {
                mimeType: 'image/png',
                kind: 'source',
                saveKind: 'generic',
            },
        );
        browserPdfCombineWorkerMock.canUse.mockReturnValue(true);
        browserPdfCombineWorkerMock.run.mockResolvedValue({data: Uint8Array.of(7, 8)});
        browserAnnotationParseMock.run.mockResolvedValue({status: 'written', pageCount: 2, length: 3, data: Uint8Array.of(7, 8, 9)});

        const result = await createCombinedPdfFromPaths([
            pdfRef,
            imageRef,
        ]);

        await expect(browserDocumentStore.read(result)).resolves.toEqual(Uint8Array.of(7, 8, 9));
        // The image becomes a PDF in the combine worker; the page tool merges it after the PDF, read in place.
        expect(browserPdfCombineWorkerMock.run).toHaveBeenCalledWith('combinePdfs', {inputs: [{
            fileName: 'photo.png',
            data: Uint8Array.of(4, 5, 6),
        }]});
        const [type, request] = browserAnnotationParseMock.run.mock.calls[0]!;
        expect(type).toBe('pageStructure');
        expect(request).toMatchObject({edit: {kind: 'merge'}, output: null});
        const sources = (request as {sources: Blob[]}).sources;
        await expect(Promise.all(sources.map(async source => [...new Uint8Array(await source.arrayBuffer())])))
            .resolves.toEqual([[1, 2, 3], [7, 8]]);
    });

    it('does not publish a direct batch when the browser combine worker is unavailable', async () => {
        const {
            browserDocumentStore, capability,
        } = await loadBrowserDocumentsFileCapability();
        const pdfBytes = await createPdfBytes();
        const pdfRef = await browserDocumentStore.createStoredDocument(
            'first.pdf',
            pdfBytes,
            {
                ...PDF_SOURCE_OPTIONS,
                retention: 'transient',
            },
        );
        const imageBytes = Uint8Array.of(1, 2, 3);
        const imageRef = await browserDocumentStore.createStoredDocument(
            'photo.png',
            imageBytes,
            {
                mimeType: 'image/png',
                kind: 'source',
                saveKind: 'generic',
                retention: 'transient',
            },
        );
        browserPdfCombineWorkerMock.canUse.mockReturnValue(false);

        await expect(capability.openDocumentDirectBatch([
            pdfRef,
            imageRef,
        ])).rejects.toThrow('Browser PDF combine worker is unavailable');

        expect(browserPdfCombineWorkerMock.run).not.toHaveBeenCalled();
        await expect(browserDocumentStore.read(pdfRef)).resolves.toEqual(pdfBytes);
        await expect(browserDocumentStore.read(imageRef)).resolves.toEqual(imageBytes);
        await expect(capability.recentFiles.get()).resolves.toEqual([]);
    });

    it('converts DjVu files before combining mixed browser batches', async () => {
        const {
            browserDocumentStore, capability,
        } = await loadBrowserDocumentsFileCapability();
        const pdfBytes = await createPdfBytes([
            100,
            100,
        ]);
        const convertedPdfBytes = await createPdfBytes([
            200,
            100,
        ]);
        const djvuBytes = new Uint8Array(await readFile(join(
            process.cwd(),
            'tests/fixtures/djvu/sources/bitonal-faint-pencil.djvu',
        )));
        const pdfRef = await browserDocumentStore.createStoredDocument(
            'first.pdf',
            pdfBytes,
            {...PDF_SOURCE_OPTIONS},
        );
        const djvuRef = await browserDocumentStore.createStoredDocument(
            'scan.djvu',
            djvuBytes,
            {
                mimeType: 'image/vnd.djvu',
                kind: 'source',
                saveKind: 'generic',
            },
        );
        const existingRecentRef = await browserDocumentStore.createStoredDocument(
            'existing.pdf',
            await createPdfBytes(),
            {
                ...PDF_SOURCE_OPTIONS,
                retention: 'durable',
            },
        );
        await browserDocumentStore.touchRecentFile(existingRecentRef);
        let convertedRef: string | null = null;
        browserDjvuCapabilityMock.runConversion.mockImplementation(async (_djvuPath: string, outputPath: string) => {
            convertedRef = outputPath;
            await browserDocumentStore.write(outputPath, convertedPdfBytes);
            return {
                success: true,
                pdfPath: outputPath,
            };
        });
        browserPdfCombineWorkerMock.canUse.mockReturnValue(true);
        browserAnnotationParseMock.run.mockImplementation(async (_type, payload) => {
            const combinedDocument = await PDFDocument.create();
            for (const source of (payload as {sources: Blob[]}).sources) {
                const sourceDocument = await PDFDocument.load(await source.arrayBuffer());
                const pages = await combinedDocument.copyPages(
                    sourceDocument,
                    sourceDocument.getPageIndices(),
                );
                pages.forEach(page => combinedDocument.addPage(page));
            }
            const data = new Uint8Array(await combinedDocument.save());
            return {status: 'written', pageCount: combinedDocument.getPageCount(), length: data.byteLength, data};
        });

        const result = await capability.openDocumentDirectBatch([
            pdfRef,
            djvuRef,
        ]);
        if (!result || !result.originalPath) {
            throw new Error('Expected a generated PDF result for the mixed browser batch');
        }

        const generatedPdf = await PDFDocument.load(
            await browserDocumentStore.read(result.originalPath),
        );
        expect(generatedPdf.getPages().map(page => page.getWidth())).toEqual([
            100,
            200,
        ]);
        expect(browserDjvuCapabilityMock.runConversion).toHaveBeenCalledWith(
            djvuRef,
            expect.stringMatching(/^browser:\/\/documents\//u),
            expect.objectContaining({
                pdfStrategy: 'compact-djvu-aware',
                subsample: 2,
                preserveBookmarks: true,
                jobId: expect.stringMatching(/^browser-pdf-combine-djvu-/u),
            }),
        );
        expect(convertedRef).not.toBeNull();
        await expect(browserDocumentStore.exists(convertedRef!)).resolves.toBe(false);
        await expect(browserDocumentStore.read(djvuRef)).resolves.toEqual(djvuBytes);

        const recentFiles = await capability.recentFiles.get();
        expect(recentFiles).toHaveLength(2);
        expect(recentFiles).toEqual(expect.arrayContaining([
            expect.objectContaining({originalPath: result.originalPath}),
            expect.objectContaining({originalPath: existingRecentRef}),
        ]));
        expect(recentFiles.map(file => file.originalPath)).not.toContain(pdfRef);
        expect(recentFiles.map(file => file.originalPath)).not.toContain(djvuRef);
        expect(recentFiles.map(file => file.originalPath)).not.toContain(convertedRef);
    });

    it('cleans converted DjVu inputs when the browser worker combine fails', async () => {
        const {
            browserDocumentStore, capability,
        } = await loadBrowserDocumentsFileCapability();
        const pdfRef = await browserDocumentStore.createStoredDocument(
            'first.pdf',
            await createPdfBytes(),
            {...PDF_SOURCE_OPTIONS},
        );
        const djvuBytes = new Uint8Array(await readFile(join(
            process.cwd(),
            'tests/fixtures/djvu/sources/bitonal-faint-pencil.djvu',
        )));
        const djvuRef = await browserDocumentStore.createStoredDocument(
            'scan.djvu',
            djvuBytes,
            {
                mimeType: 'image/vnd.djvu',
                kind: 'source',
                saveKind: 'generic',
            },
        );
        let convertedRef: string | null = null;
        browserDjvuCapabilityMock.runConversion.mockImplementation(async (_djvuPath: string, outputPath: string) => {
            convertedRef = outputPath;
            await browserDocumentStore.write(outputPath, await createPdfBytes());
            return {
                success: true,
                pdfPath: outputPath,
            };
        });
        browserPdfCombineWorkerMock.canUse.mockReturnValue(true);
        browserAnnotationParseMock.run.mockRejectedValue(new Error('browser worker failed'));

        await expect(capability.openDocumentDirectBatch([
            pdfRef,
            djvuRef,
        ]))
            .rejects.toThrow('browser worker failed');

        expect(convertedRef).not.toBeNull();
        await expect(browserDocumentStore.exists(convertedRef!)).resolves.toBe(false);
        await expect(browserDocumentStore.read(djvuRef)).resolves.toEqual(djvuBytes);
        await expect(capability.recentFiles.get()).resolves.toEqual([]);
    });

    it('cancels browser DjVu pre-conversion when the combine signal aborts', async () => {
        const {browserDocumentStore} = await loadBrowserDocumentsFileCapability();
        const createCombinedPdfFromPaths = await loadCreateCombinedPdfFromPaths();
        const djvuRef = await browserDocumentStore.createStoredDocument(
            'scan.djvu',
            Uint8Array.of(1, 2, 3),
            {
                mimeType: 'application/octet-stream',
                kind: 'source',
                saveKind: 'generic',
            },
        );
        let finishConversion: (() => void) | undefined;
        let conversionJobId: string | undefined;
        browserDjvuCapabilityMock.runConversion.mockImplementationOnce(async (
            _djvuPath: string,
            _outputPath: string,
            options: {jobId?: string},
        ) => new Promise(resolve => {
            conversionJobId = options.jobId;
            finishConversion = () => resolve({success: true});
        }));
        browserDjvuCapabilityMock.cancel.mockImplementationOnce(async () => {
            finishConversion?.();
            return {canceled: true};
        });
        const controller = new AbortController();
        const promise = createCombinedPdfFromPaths([djvuRef], {signal: controller.signal});
        await vi.waitFor(() => {
            expect(browserDjvuCapabilityMock.runConversion).toHaveBeenCalledTimes(1);
        });
        const jobId = conversionJobId;
        expect(jobId).toEqual(expect.stringMatching(/^browser-pdf-combine-djvu-/u));
        controller.abort(new DOMException('combine canceled', 'AbortError'));

        await expect(promise).rejects.toThrow('combine canceled');
        expect(browserDjvuCapabilityMock.cancel).toHaveBeenCalledWith(jobId);
    });

    it('rejects unsupported image combine formats before worker admission', async () => {
        const { browserDocumentStore } = await loadBrowserDocumentsFileCapability();
        const createCombinedPdfFromPaths = await loadCreateCombinedPdfFromPaths();
        const svgRef = await browserDocumentStore.createStoredDocument(
            'vector.svg',
            Uint8Array.of(60, 115, 118, 103, 62),
            {
                mimeType: 'image/svg+xml',
                kind: 'source',
                saveKind: 'generic',
            },
        );
        browserPdfCombineWorkerMock.canUse.mockReturnValue(true);

        await expect(createCombinedPdfFromPaths([svgRef])).rejects.toThrow();
        expect(browserPdfCombineWorkerMock.run).not.toHaveBeenCalled();
    });

    it('cleans up transient combine refs when opening picked browser inputs fails', async () => {
        const uuid = vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue('00000000-0000-4000-8000-000000000006');
        onTestFinished(() => uuid.mockRestore());
        const brokenPng = new File([Uint8Array.of(1, 2, 3)], 'broken.png', { type: 'image/png' });
        const {
            capability,
            browserDocumentStore,
        } = await loadBrowserDocumentsFileCapability({ inputFiles: [brokenPng] });
        const failedRef = 'browser://documents/00000000-0000-4000-8000-000000000006/broken.png';

        await expect(capability.openCombineDialog()).rejects.toThrow();
        await expect(browserDocumentStore.exists(failedRef)).resolves.toBe(false);
    });

    it('publishes only the generated PDF to recents when opening a direct-batch PDF and DjVu', async () => {
        const {
            capability,
            browserDocumentStore,
        } = await loadBrowserDocumentsFileCapability();
        const pdfBytes = await createPdfBytes();
        const pdfRef = await browserDocumentStore.createStoredDocument(
            'first.pdf',
            pdfBytes,
            {...PDF_SOURCE_OPTIONS},
        );
        const djvuRef = await browserDocumentStore.createStoredDocument(
            'second.djvu',
            Uint8Array.of(1),
            {
                mimeType: 'image/vnd.djvu',
                kind: 'source',
                saveKind: 'generic',
            },
        );
        browserDjvuCapabilityMock.runConversion.mockImplementation(async (_path: string, outputRef: string) => {
            await browserDocumentStore.write(outputRef, pdfBytes);
            return {success: true};
        });
        browserPdfCombineWorkerMock.canUse.mockReturnValue(true);
        browserAnnotationParseMock.run.mockResolvedValue({status: 'written', pageCount: 2, length: pdfBytes.byteLength, data: pdfBytes});

        const result = await capability.openDocumentDirectBatch([
            pdfRef,
            djvuRef,
        ]);

        expect(result).toEqual(expect.objectContaining({
            kind: 'pdf',
            isGenerated: true,
        }));
        await expect(capability.recentFiles.get()).resolves.toEqual([expect.objectContaining({
            originalPath: result!.originalPath,
            fileName: expect.stringMatching(/^combined-\d+\.pdf$/u),
        })]);
    });

    it('keeps recent entries when direct browser handle reopen is denied', async () => {
        const {
            capability,
            browserDocumentStore,
        } = await loadBrowserDocumentsFileCapability();
        const handle = createFileSystemFileHandle({
            name: 'denied.pdf',
            getFile: vi.fn(async () => {
                throw new DOMException('Not allowed', 'NotAllowedError');
            }),
        });
        const sourceRef = await browserDocumentStore.createStoredDocument(
            'denied.pdf',
            new Uint8Array(),
            {
                ...PDF_SOURCE_OPTIONS,
                saveHandle: handle,
                storageMode: 'handle',
            },
        );
        await browserDocumentStore.touchRecentFile(sourceRef);

        await expect(capability.openDocumentDirect(sourceRef)).rejects.toThrow('Not allowed');
        const recentFiles = await capability.recentFiles.get();
        expect(recentFiles).toEqual([expect.objectContaining({
            originalPath: sourceRef,
            fileName: 'denied.pdf',
        })]);
    });

    it('names an optimized dot-file without dropping its name', () => {
        expect(getOptimizedPdfName('.hidden')).toBe('.hidden-optimized.pdf');
        expect(getOptimizedPdfName('book.pdf')).toBe('book-optimized.pdf');
    });

    it('remembers a DjVu source reading view only while its file is the version it was left on', async () => {
        const {
            capability, browserDocumentStore,
        } = await loadBrowserDocumentsFileCapability();
        const {browserSettingsCapability} = await import('@app/platform/browser-api/browserSettingsCapability');
        await browserSettingsCapability.save({rememberDocumentView: true});
        let physical = new File([Uint8Array.of(65, 84, 38, 84)], 'book.djvu', {lastModified: 1_000});
        const source = await browserDocumentStore.registerFile(physical, {
            kind: 'source',
            saveKind: 'generic',
            saveHandle: createFileSystemFileHandle({
                name: physical.name,
                getFile: async () => physical,
            }),
        });
        await browserDocumentStore.touchRecentFile(source);
        const view = {
            currentPage: 2,
            pageCount: 3,
            zoom: 1.5,
            zoomMode: 'custom',
            viewMode: 'facing',
            continuousScroll: true,
            viewRotation: 90,
        } as const;
        await capability.recentFiles.rememberReadingView(source, view);
        await expect(capability.recentFiles.readingView(source)).resolves.toEqual(view);

        // Another write gives the file a new modification time: the view was left on a version it no longer is.
        physical = new File([Uint8Array.of(65, 84, 38, 85)], 'book.djvu', {lastModified: 2_000});
        await expect(capability.recentFiles.readingView(source)).resolves.toBeNull();
    });

    it('reopens a Recent PDF where the reader left it, only on the bytes it was left on', async () => {
        const view = {
            currentPage: 1,
            pageCount: 1,
            zoom: 1.5,
            zoomMode: 'custom',
            viewMode: 'single',
            continuousScroll: true,
            viewRotation: 90,
        } as const;
        let physical = new File([await createPdfBytes()], 'book.pdf', {
            type: 'application/pdf',
            lastModified: 1_000,
        });
        const handle = createFileSystemFileHandle({
            name: 'book.pdf',
            getFile: async () => physical,
        });
        const {
            capability, browserDocumentStore,
        } = await loadBrowserDocumentsFileCapability({windowOverrides: {showOpenFilePicker: async () => [handle]}});
        const {browserSettingsCapability} = await import('@app/platform/browser-api/browserSettingsCapability');
        const opened = await capability.openDocumentDialog();
        if (opened?.kind !== 'pdf') throw new Error('Expected the picked PDF to open');
        const workingCopy = requireDocumentRef(opened.workingPath);
        await capability.recentFiles.rememberReadingView(workingCopy, view);
        // Another document's open rewrites the list; the entry keeps its view.
        await browserDocumentStore.touchRecentFile(await browserDocumentStore.createStoredDocument('other.pdf', await createPdfBytes(), PDF_SOURCE_OPTIONS));
        const reopen = async () => {
            const reopened = await capability.openDocumentDirect(requireDocumentRef(opened.originalPath));
            if (reopened?.kind !== 'pdf') throw new Error('Expected the Recent PDF to reopen');
            return requireDocumentRef(reopened.workingPath);
        };

        await expect(capability.recentFiles.readingView(await reopen())).resolves.toBeNull();
        await browserSettingsCapability.save({rememberDocumentView: true});
        await expect(capability.recentFiles.readingView(await reopen())).resolves.toEqual(view);
        expect((await capability.recentFiles.get()).find(file => file.originalPath === opened.originalPath))
            .not.toHaveProperty('readingView');

        physical = new File([await createPdfBytes([
            300,
            400,
        ])], 'book.pdf', {
            type: 'application/pdf',
            lastModified: 2_000,
        });
        await expect(capability.recentFiles.readingView(await reopen())).resolves.toBeNull();
    });

    // An ordinary Save writes the reader's own bytes to the file it opened, or
    // downloads them where the browser has no file access; the view left on
    // them must survive the next Recent reopen.
    it.each([
        'file handle',
        'download',
    ] as const)('keeps the Recent reading view across an ordinary Save to a %s', async (target) => {
        const view = {
            currentPage: 1,
            pageCount: 1,
            zoom: 2,
            zoomMode: 'custom',
            viewMode: 'single',
            continuousScroll: true,
            viewRotation: 180,
        } as const;
        let physical = new File([await createPdfBytes()], 'saved.pdf', {
            type: 'application/pdf',
            lastModified: 1_000,
        });
        const handle = createFileSystemFileHandle({
            name: 'saved.pdf',
            getFile: async () => physical,
            createWritable: async () => {
                const chunks: Array<Uint8Array<ArrayBuffer>> = [];
                return createFileSystemWritableFileStream({
                    write: async (chunk) => {
                        chunks.push(new Uint8Array(requireArrayBufferChunk(chunk)));
                    },
                    close: async () => {
                        physical = new File(chunks, 'saved.pdf', {
                            type: 'application/pdf',
                            lastModified: physical.lastModified + 1_000,
                        });
                    },
                });
            },
        });
        if (target === 'download') {
            class DownloadURL extends URL {}
            Object.defineProperties(DownloadURL, {
                createObjectURL: {value: () => 'blob:saved-download'},
                revokeObjectURL: {value: () => {}},
            });
            vi.stubGlobal('URL', DownloadURL);
        }
        const {
            capability, browserDocumentStore,
        } = await loadBrowserDocumentsFileCapability(target === 'download'
            ? {inputFiles: [physical]}
            : {windowOverrides: {showOpenFilePicker: async () => [handle]}});
        const {browserSettingsCapability} = await import('@app/platform/browser-api/browserSettingsCapability');
        await browserSettingsCapability.save({rememberDocumentView: true});
        const opened = await capability.openDocumentDialog();
        if (opened?.kind !== 'pdf') throw new Error('Expected the picked PDF to open');
        const workingCopy = requireDocumentRef(opened.workingPath);
        await browserDocumentStore.write(workingCopy, await createPdfBytes([
            300,
            400,
        ]), await getRevisionOptions(browserDocumentStore, workingCopy));
        await expect(capability.saveFileStructured(workingCopy, await getRevisionOptions(browserDocumentStore, workingCopy)))
            .resolves.toMatchObject({ok: true});
        await capability.recentFiles.rememberReadingView(workingCopy, view);

        const reopened = await capability.openDocumentDirect(requireDocumentRef(opened.originalPath));
        if (reopened?.kind !== 'pdf') throw new Error('Expected the Recent PDF to reopen');
        expect(reopened.originalPath).toBe(opened.originalPath);
        await expect(capability.recentFiles.readingView(requireDocumentRef(reopened.workingPath))).resolves.toEqual(view);
    });

    it('opens oversized sources with range-backed working copies', async () => {
        const {
            BROWSER_MAX_FULL_READ_BYTES,
            capability,
            browserDocumentStore,
        } = await loadBrowserDocumentsFileCapability();
        const getFile = vi.fn(async () => createOversizedPdfFile(
            'huge.pdf',
            BROWSER_MAX_FULL_READ_BYTES + 1,
        ));
        const handle = createFileSystemFileHandle({
            name: 'huge.pdf',
            getFile,
        });
        const sourceRef = await browserDocumentStore.createStoredDocument(
            'huge.pdf',
            new Uint8Array(),
            {
                ...PDF_SOURCE_OPTIONS,
                saveHandle: handle,
                storageMode: 'handle',
            },
        );

        await expect(capability.openDocumentDirect(sourceRef)).resolves.toMatchObject({kind: 'pdf'});
    });

    it('streams oversized browser saves to an existing file handle', async () => {
        const {
            BROWSER_MAX_FULL_READ_BYTES,
            capability,
            browserDocumentStore,
        } = await loadBrowserDocumentsFileCapability();
        const writes: Uint8Array[] = [];
        const savedBytes = new Uint8Array(BROWSER_MAX_FULL_READ_BYTES + 1);
        const queryPermission = vi.fn(async () => 'granted' as const);
        const requestPermission = vi.fn(async () => 'granted' as const);
        const handle = createFileSystemFileHandle({
            name: 'large-save.pdf',
            getFile: vi.fn(async () => new File([savedBytes], 'large-save.pdf', {
                type: 'application/pdf',
                lastModified: 1,
            })),
            queryPermission,
            requestPermission,
            createWritable: vi.fn(async () => createFileSystemWritableFileStream({write: vi.fn(async (chunk: FileSystemWriteChunkType) => {
                const chunkBytes = new Uint8Array(requireArrayBufferChunk(chunk));
                const offset = writes.reduce((sum, current) => sum + current.byteLength, 0);
                savedBytes.set(chunkBytes, offset);
                writes.push(chunkBytes);
            })})),
        });
        const sourceRef = await browserDocumentStore.createStoredDocument(
            'large-save.pdf',
            new Uint8Array(),
            {
                ...PDF_SOURCE_OPTIONS,
                saveHandle: handle,
                storageMode: 'handle',
            },
        );
        const workingRef = await browserDocumentStore.cloneAsWorkingCopy(sourceRef);
        const oversizedBytes = new Uint8Array(BROWSER_MAX_FULL_READ_BYTES + 1);
        oversizedBytes[0] = 37;
        oversizedBytes[1] = 80;
        oversizedBytes[2] = 68;
        oversizedBytes[3] = 70;
        await browserDocumentStore.write(workingRef, oversizedBytes, await getRevisionOptions(browserDocumentStore, workingRef));

        await expect(capability.saveFileStructured(
            workingRef,
            await getRevisionOptions(browserDocumentStore, workingRef),
        )).resolves.toMatchObject({ ok: true });

        expect(queryPermission).toHaveBeenCalledWith({ mode: 'readwrite' });
        expect(requestPermission).not.toHaveBeenCalled();
        const savedEntry = await browserDocumentStore.requireEntry(sourceRef);
        expect(savedEntry.saveHandle).toBe(handle);
        await expect(browserDocumentStore.stat(sourceRef)).resolves.toEqual({
            size: BROWSER_MAX_FULL_READ_BYTES + 1,
            modifiedAt: expect.any(Number),
        });
        expect(writes.length).toBeGreaterThan(1);
        expect(writes[0]?.slice(0, 4)).toEqual(Uint8Array.of(37, 80, 68, 70));
    });

    it('requests browser write permission before saving to an existing file handle', async () => {
        const {
            capability,
            browserDocumentStore,
        } = await loadBrowserDocumentsFileCapability();
        // The opened source has read access; saving still needs readwrite permission.
        const grantedModes = new Set<string>(['read']);
        const queryPermission = vi.fn(async (descriptor?: {mode?: string}) => (
            grantedModes.has(descriptor?.mode ?? '') ? 'granted' as const : 'prompt' as const
        ));
        const requestPermission = vi.fn(async (descriptor?: {mode?: string}) => {
            grantedModes.add(descriptor?.mode ?? '');
            return 'granted' as const;
        });
        let physical = Uint8Array.of(1);
        const createWritable = vi.fn(async () => createFileSystemWritableFileStream({write: vi.fn(async (chunk: FileSystemWriteChunkType) => {
            physical = new Uint8Array(requireArrayBufferChunk(chunk));
        })}));
        const handle = createFileSystemFileHandle({
            name: 'needs-permission.pdf',
            getFile: vi.fn(async () => new File([physical], 'needs-permission.pdf', {
                type: 'application/pdf',
                lastModified: 1,
            })),
            queryPermission,
            requestPermission,
            createWritable,
        });
        const sourceRef = await browserDocumentStore.createStoredDocument(
            'needs-permission.pdf',
            new Uint8Array(),
            {
                ...PDF_SOURCE_OPTIONS,
                saveHandle: handle,
                storageMode: 'handle',
            },
        );
        const workingRef = await browserDocumentStore.cloneAsWorkingCopy(sourceRef);
        await browserDocumentStore.write(workingRef, Uint8Array.of(37, 80, 68, 70), await getRevisionOptions(browserDocumentStore, workingRef));

        await expect(capability.saveFileStructured(
            workingRef,
            await getRevisionOptions(browserDocumentStore, workingRef),
        )).resolves.toMatchObject({ ok: true });

        expect(queryPermission).toHaveBeenCalledWith({ mode: 'readwrite' });
        expect(requestPermission).toHaveBeenCalledWith({ mode: 'readwrite' });
        expect(createWritable).toHaveBeenCalledOnce();
    });

    it('rejects browser structured saves without a revision token', async () => {
        const {
            capability,
            browserDocumentStore,
        } = await loadBrowserDocumentsFileCapability();
        const sourceRef = await browserDocumentStore.createStoredDocument(
            'missing-revision.pdf',
            Uint8Array.of(37, 80, 68, 70),
            {...PDF_SOURCE_OPTIONS},
        );
        const workingRef = await browserDocumentStore.cloneAsWorkingCopy(sourceRef);

        await expect(capability.saveFileStructured(workingRef)).resolves.toMatchObject({
            ok: false,
            reason: 'write-failed',
            message: expect.stringContaining('Document revision token is required'),
        });
    });

    it('rejects browser structured saves with a stale revision token', async () => {
        const {
            capability,
            browserDocumentStore,
        } = await loadBrowserDocumentsFileCapability();
        const sourceRef = await browserDocumentStore.createStoredDocument(
            'stale-revision.pdf',
            Uint8Array.of(37, 80, 68, 70),
            {...PDF_SOURCE_OPTIONS},
        );
        const workingRef = await browserDocumentStore.cloneAsWorkingCopy(sourceRef);
        const staleRevisionOptions = await getRevisionOptions(browserDocumentStore, workingRef);
        await browserDocumentStore.write(workingRef, Uint8Array.of(37, 80, 68, 70, 10), await getRevisionOptions(browserDocumentStore, workingRef));

        await expect(capability.saveFileStructured(workingRef, staleRevisionOptions)).resolves.toMatchObject({
            ok: false,
            reason: 'write-failed',
            message: expect.stringContaining('Document changed while this edit was being prepared'),
        });
    });

    it.each([
        {
            name: 'structured save',
            invoke: (
                capability: IDocumentsFileCapability,
                workingRef: TDocumentRef,
                revisionOptions: Awaited<ReturnType<typeof getRevisionOptions>>,
            ) => capability.saveFileStructured(workingRef, revisionOptions),
            expected: {
                ok: false,
                reason: 'user-canceled',
            },
        },
        {
            name: 'PDF data save',
            invoke: async (
                capability: IDocumentsFileCapability,
                workingRef: TDocumentRef,
                revisionOptions: Awaited<ReturnType<typeof getRevisionOptions>>,
            ) => capability.savePdfData(workingRef, await createPdfBytes(), revisionOptions),
            expected: {
                isValid: false,
                errors: [],
            },
        },
    ])('preserves caches when a browser $name is canceled', async ({
        invoke,
        expected,
    }) => {
        const showSaveFilePicker = vi.fn(async () => {
            throw new DOMException('Canceled', 'AbortError');
        });
        const clearSearchCaches = vi.fn();
        const {
            capability,
            browserDocumentStore,
        } = await loadBrowserDocumentsFileCapability({
            clearSearchCaches,
            windowOverrides: { showSaveFilePicker },
        });
        const sourceRef = await browserDocumentStore.createStoredDocument(
            'cancel-save.pdf',
            await createPdfBytes(),
            PDF_SOURCE_OPTIONS,
        );
        const workingRef = await browserDocumentStore.cloneAsWorkingCopy(sourceRef);

        await expect(invoke(
            capability,
            workingRef,
            await getRevisionOptions(browserDocumentStore, workingRef),
        )).resolves.toMatchObject(expected);
        expect(clearSearchCaches).not.toHaveBeenCalled();
    });

    it('stages browser PDF data in the working copy without publishing the source', async () => {
        const showSaveFilePicker = vi.fn(async () => {
            throw new Error('Working-copy-only staging must not open a save picker');
        });
        const sourceBytes = await createPdfBytes();
        const createWritable = vi.fn(async () => createFileSystemWritableFileStream({write: vi.fn(async (_chunk: FileSystemWriteChunkType) => {})}));
        const sourceHandle = createFileSystemFileHandle({
            name: 'working-copy-only.pdf',
            getFile: vi.fn(async () => new File([sourceBytes], 'working-copy-only.pdf', {
                type: 'application/pdf',
                lastModified: 1,
            })),
            createWritable,
        });
        const clearSearchCaches = vi.fn();
        const {
            capability,
            browserDocumentStore,
        } = await loadBrowserDocumentsFileCapability({
            clearSearchCaches,
            windowOverrides: {showSaveFilePicker},
        });
        const sourceRef = await browserDocumentStore.createStoredDocument(
            'working-copy-only.pdf',
            sourceBytes,
            {
                ...PDF_SOURCE_OPTIONS,
                saveHandle: sourceHandle,
            },
        );
        const workingRef = await browserDocumentStore.cloneAsWorkingCopy(sourceRef);
        const stagedDocument = await PDFDocument.create();
        stagedDocument.addPage();
        stagedDocument.addPage();
        const stagedBytes = new Uint8Array(await stagedDocument.save());
        const revisionOptions = await getRevisionOptions(browserDocumentStore, workingRef);

        const result = await capability.savePdfData(
            workingRef,
            stagedBytes,
            {
                ...revisionOptions,
                workingCopyOnly: true,
            },
        );

        expect(result).toMatchObject({
            isValid: true,
            errors: [],
            warnings: [],
        });
        await expect(browserDocumentStore.read(workingRef)).resolves.toEqual(stagedBytes);
        await expect(browserDocumentStore.read(sourceRef)).resolves.toEqual(sourceBytes);
        expect(showSaveFilePicker).not.toHaveBeenCalled();
        expect(createWritable).not.toHaveBeenCalled();
        expect(clearSearchCaches).toHaveBeenCalledOnce();
    });

    it('uses the user filename at the savePdfData boundary and never opens a writer after refusal', async () => {
        const {
            capability, browserDocumentStore,
        } = await loadBrowserDocumentsFileCapability();
        const bytes = await createPdfBytes();
        const source = await browserDocumentStore.createStoredDocument('User $& name.pdf', bytes, PDF_SOURCE_OPTIONS);
        const working = await browserDocumentStore.cloneAsWorkingCopy(source);
        qpdfRun.mockResolvedValue({
            exitCode: 2,
            stdout: '',
            stderr: '/work/input.pdf: damaged',
            output: null,
        });
        const write = vi.spyOn(browserDocumentStore, 'write');
        const result = await capability.savePdfData(working, bytes, {
            ...await getRevisionOptions(browserDocumentStore, working),
            workingCopyOnly: true,
        });
        expect(result.errors).toEqual(['qpdf(validate-pdf) failed with exit code 2. User $& name.pdf: damaged']);
        expect(write).not.toHaveBeenCalled();
        expect(bytes.byteLength).toBeGreaterThan(0);
    });

    it('fails browser saves without opening the writer when write permission is denied', async () => {
        const {
            capability,
            browserDocumentStore,
        } = await loadBrowserDocumentsFileCapability();
        const queryPermission = vi.fn(async (descriptor?: {mode?: string}) => (
            descriptor?.mode === 'read' ? 'granted' as const : 'prompt' as const
        ));
        const requestPermission = vi.fn(async () => 'denied' as const);
        const createWritable = vi.fn(async () => createFileSystemWritableFileStream({write: vi.fn(async (_chunk: FileSystemWriteChunkType) => {})}));
        const handle = createFileSystemFileHandle({
            name: 'denied.pdf',
            getFile: vi.fn(async () => new File([Uint8Array.of(1)], 'denied.pdf', {
                type: 'application/pdf',
                lastModified: 1,
            })),
            queryPermission,
            requestPermission,
            createWritable,
        });
        const sourceRef = await browserDocumentStore.createStoredDocument(
            'denied.pdf',
            new Uint8Array(),
            {
                ...PDF_SOURCE_OPTIONS,
                saveHandle: handle,
                storageMode: 'handle',
            },
        );
        const workingRef = await browserDocumentStore.cloneAsWorkingCopy(sourceRef);
        await browserDocumentStore.write(workingRef, Uint8Array.of(37, 80, 68, 70), await getRevisionOptions(browserDocumentStore, workingRef));

        await expect(capability.saveFileStructured(
            workingRef,
            await getRevisionOptions(browserDocumentStore, workingRef),
        )).resolves.toMatchObject({
            ok: false,
            reason: 'write-failed',
            message: expect.stringContaining('Browser write permission was not granted for this file.'),
        });

        expect(createWritable).not.toHaveBeenCalled();
    });

    it.each([
        'save',
        'cancel',
        'stale',
        'altered-stage',
    ])('publishes only the admitted Save As bytes when %s', async (outcome) => {
        const originalBytes = Uint8Array.of(37, 80, 68, 70, 1);
        const stagedBytes = Uint8Array.of(37, 80, 68, 70, 2, 3);
        let savedBytes: Uint8Array<ArrayBuffer> | null = null;
        const handle = createFileSystemFileHandle({
            name: 'frontier-save-as.pdf',
            getFile: async () => new File([savedBytes ?? originalBytes], 'frontier-save-as.pdf', {type: 'application/pdf'}),
            createWritable: async () => createFileSystemWritableFileStream({write: async (chunk) => {
                savedBytes = new Uint8Array(requireArrayBufferChunk(chunk));
            }}),
        });
        const {
            capability, browserDocumentStore,
        } = await loadBrowserDocumentsFileCapability({windowOverrides: {showSaveFilePicker: async () => {
            if (outcome === 'cancel') throw new DOMException('Canceled', 'AbortError');
            if (outcome === 'stale') await browserDocumentStore.write(workingRef, Uint8Array.of(9), await getRevisionOptions(browserDocumentStore, workingRef));
            return handle;
        }}});
        const sourceRef = await browserDocumentStore.createStoredDocument('frontier-original.pdf', originalBytes, PDF_SOURCE_OPTIONS);
        await browserDocumentStore.touchRecentFile(sourceRef);
        const workingRef = await browserDocumentStore.cloneAsWorkingCopy(sourceRef);
        const stagedRef = await browserDocumentStore.createStoredDocument('frontier-staged.pdf', stagedBytes, {
            ...PDF_SOURCE_OPTIONS,
            kind: 'output',
            retention: 'transient',
        });
        const stagedOutput = await createBrowserStoreStagedArtifact(browserDocumentStore, stagedRef, {
            leaseId: 'save-as-frontier',
            sha256: createHash('sha256').update(stagedBytes).digest('hex'),
            validations: {
                qpdfCheck: false,
                tailCheck: true,
                semanticCheck: true,
                fsynced: true,
                semanticScopeSha256: 'a'.repeat(64),
            },
        });
        if (outcome === 'altered-stage') await browserDocumentStore.write(stagedRef, Uint8Array.of(7), await getRevisionOptions(browserDocumentStore, stagedRef));
        const revisionOptions = await getRevisionOptions(browserDocumentStore, workingRef);
        const save = capability.savePdfAs(workingRef, {stagedOutput}, revisionOptions);
        if (outcome === 'save') {
            const savedRef = await save;
            expect(savedBytes).toEqual(stagedBytes);
            await expect(browserDocumentStore.read(savedRef!)).resolves.toEqual(stagedBytes);
            const adopted = await capability.createWorkingCopyFromPath(savedRef!);
            await expect(browserDocumentStore.read(adopted)).resolves.toEqual(stagedBytes);
        } else if (outcome === 'cancel') {
            await expect(save).resolves.toBeNull();
            expect(savedBytes).toBeNull();
        } else {
            await expect(save).rejects.toThrow(outcome === 'stale' ? /STALE_REVISION/u : /changed after staging/u);
            expect(savedBytes).toBeNull();
        }
        await expect(browserDocumentStore.read(sourceRef)).resolves.toEqual(originalBytes);
        await expect(browserDocumentStore.read(workingRef)).resolves.toEqual(outcome === 'stale' ? Uint8Array.of(9) : originalBytes);
        await expect(browserDocumentStore.exists(stagedRef)).resolves.toBe(true);
    });

    it.each([
        'smaller-handle',
        'smaller-download',
        'warnings',
        'tagged',
        'acroform',
        'off',
        'automatic',
        'signed',
        'encrypted',
        'pdfa',
        'xfa',
        'preflight-failed',
        'rewrite-failed',
        'rewrite-timeout',
        'output-limit',
        'equal',
        'larger',
        'empty',
        'candidate-invalid',
        'source-invalid',
        'source-unavailable',
        'preflight-abort',
        'rewrite-abort',
        'candidate-abort',
    ])('preserves the Save As frontier and published/adopted bytes: %s', async outcome => {
        const original = Uint8Array.of(37, 80, 68, 70, 1, 2, 3, 4);
        const frontier = outcome === 'pdfa' ? new TextEncoder().encode('<pdfaid:part>2</pdfaid:part>') : Uint8Array.of(37, 80, 68, 70, 5, 6, 7);
        const candidate = Uint8Array.of(37, 80, 68, 70, 9);
        const downloads: Blob[] = [];
        let physical = new Uint8Array();
        const handle = createFileSystemFileHandle({
            name: 'optimized.pdf',
            getFile: async () => new File([physical], 'optimized.pdf', {type: 'application/pdf'}),
            createWritable: async () => createFileSystemWritableFileStream({write: async chunk => {physical = new Uint8Array(requireArrayBufferChunk(chunk));}}),
        });
        const {
            capability, browserDocumentStore: store,
        } = await loadBrowserDocumentsFileCapability({windowOverrides: {showSaveFilePicker: outcome === 'smaller-download' ? undefined : async () => handle}});
        if (outcome === 'smaller-download') {
            class DownloadURL extends URL {}
            Object.defineProperties(DownloadURL, {
                createObjectURL: {value: (blob: Blob) => {downloads.push(blob); return 'blob:optimized';}},
                revokeObjectURL: {value: () => {}},
            });
            vi.stubGlobal('URL', DownloadURL);
        }
        const source = await store.createStoredDocument('original.pdf', original, PDF_SOURCE_OPTIONS);
        const working = await store.cloneAsWorkingCopy(source);
        const staged = await store.createStoredDocument('stage.pdf', frontier, {
            ...PDF_SOURCE_OPTIONS,
            kind: 'output',
        });
        const stagedOutput = await createBrowserStoreStagedArtifact(store, staged, {
            leaseId: 'optimization-frontier',
            sha256: createHash('sha256').update(frontier).digest('hex'),
            validations: {
                qpdfCheck: false,
                tailCheck: true,
                semanticCheck: true,
                fsynced: true,
                semanticScopeSha256: 'a'.repeat(64),
            },
        });
        browserAnnotationParseMock.run.mockImplementation(async () => {
            if (outcome === 'preflight-abort') throw new DOMException('reset', 'AbortError');
            if (outcome === 'preflight-failed') throw new Error('structure unavailable');
            return {
                isSigned: outcome === 'signed',
                isEncrypted: outcome === 'encrypted',
                isTagged: outcome === 'tagged',
                hasAcroForm: outcome === 'acroform',
                hasXfa: outcome === 'xfa',
            };
        });
        let checks = 0;
        qpdfRun.mockImplementation(async command => {
            if (command === 'lossless-rewrite') {
                if (outcome === 'rewrite-abort') throw new DOMException('reset', 'AbortError');
                if (outcome === 'rewrite-timeout' || outcome === 'output-limit') throw new Error(outcome);
                return {
                    exitCode: outcome === 'rewrite-failed' ? 2 : outcome === 'warnings' ? 3 : 0,
                    stdout: '',
                    stderr: '',
                    output: outcome === 'equal' ? frontier.slice() : outcome === 'larger' ? original.slice() : outcome === 'empty' ? new Uint8Array() : candidate.slice(),
                };
            }
            checks += 1;
            if (outcome === 'source-unavailable') {
                const {BrowserQpdfEngineUnavailableError} = await import('@app/platform/browser-api/browserQpdfEngineClient');
                throw new BrowserQpdfEngineUnavailableError('download unavailable');
            }
            if (checks === 2 && outcome === 'candidate-abort') throw new DOMException('reset', 'AbortError');
            return {
                exitCode: (checks === 1 && outcome === 'source-invalid') || (checks === 2 && outcome === 'candidate-invalid') ? 2 : 0,
                stdout: '',
                stderr: '',
                output: null,
            };
        });
        if (outcome === 'automatic') {
            const stat = store.stat.bind(store);
            vi.spyOn(store, 'stat').mockImplementation(async path => ({
                ...await stat(path),
                ...(path === working ? {size: 64 * 1024 ** 2} : {}),
            }));
            // Use an unchanged frontier here; receipt size intentionally pins the real stage.
        }
        const save = capability.savePdfAs(working, {
            optimizeLossless: outcome !== 'off' && outcome !== 'automatic',
            ...(outcome === 'automatic' ? {} : {stagedOutput}),
        }, await getRevisionOptions(store, working));
        if (outcome.endsWith('abort') || outcome === 'source-invalid' || outcome === 'source-unavailable') {
            await expect(save).rejects.toThrow();
            expect(physical).toEqual(new Uint8Array());
        } else {
            const saved = await save;
            const optimized = [
                'smaller-handle',
                'smaller-download',
                'warnings',
                'tagged',
                'acroform',
                'automatic',
            ].includes(outcome);
            const expected = optimized ? candidate : outcome === 'automatic' ? original : frontier;
            if (outcome === 'smaller-download') expect(new Uint8Array(await downloads[0]!.arrayBuffer())).toEqual(expected);
            else expect(physical).toEqual(expected);
            await expect(store.read(saved!)).resolves.toEqual(expected);
            const adopted = await capability.createWorkingCopyFromPath(saved!);
            await expect(store.read(adopted)).resolves.toEqual(expected);
        }
        await expect(store.read(source)).resolves.toEqual(original);
        await expect(store.read(working)).resolves.toEqual(original);
        await expect(store.read(staged)).resolves.toEqual(frontier);
    });

    it.each([
        'handle',
        'download',
        'queued-abort',
        'writing-abort',
        'closing-abort',
    ] as const)('publishes a finalized Optimize frontier to its picked target: %s', async outcome => {
        const original = Uint8Array.of(37, 80, 68, 70, 1, 2, 3, 4);
        const frontier = Uint8Array.of(37, 80, 68, 70, 5);
        const sentinel = Uint8Array.of(83, 69, 78);
        const downloads: Blob[] = [];
        const controller = new AbortController();
        let physical = sentinel;
        const handle = createFileSystemFileHandle({
            name: 'report-optimized.pdf',
            getFile: async () => new File([physical], 'report-optimized.pdf', {type: 'application/pdf'}),
            createWritable: async () => {
                const chunks: Uint8Array[] = [];
                return createFileSystemWritableFileStream({
                    write: async chunk => {
                        chunks.push(new Uint8Array(requireArrayBufferChunk(chunk)));
                        if (outcome === 'writing-abort') controller.abort(new DOMException('Optimize canceled', 'AbortError'));
                    },
                    // A writer publishes only at close; abort discards its chunks.
                    close: async () => {
                        if (outcome === 'closing-abort') controller.abort(new DOMException('Optimize canceled', 'AbortError'));
                        physical = Uint8Array.from(chunks.flatMap(chunk => [...chunk]));
                    },
                });
            },
        });
        const {browserDocumentStore: store} = await loadBrowserDocumentsFileCapability({windowOverrides: {showSaveFilePicker: async () => {
            throw new Error('A finalized publication must not open a picker');
        }}});
        class DownloadURL extends URL {}
        Object.defineProperties(DownloadURL, {
            createObjectURL: {value: (blob: Blob) => {downloads.push(blob); return 'blob:optimized';}},
            revokeObjectURL: {value: () => {}},
        });
        vi.stubGlobal('URL', DownloadURL);
        const locks = new FakeLockManager();
        vi.stubGlobal('navigator', {locks});
        const source = await store.createStoredDocument('original.pdf', original, PDF_SOURCE_OPTIONS);
        const working = await store.cloneAsWorkingCopy(source);
        const staged = await store.createStoredDocument('stage.pdf', frontier, {
            ...PDF_SOURCE_OPTIONS,
            kind: 'output',
        });
        const stagedOutput = await createBrowserStoreStagedArtifact(store, staged, {
            leaseId: 'optimize-frontier',
            sha256: createHash('sha256').update(frontier).digest('hex'),
            validations: {
                qpdfCheck: false,
                tailCheck: true,
                semanticCheck: true,
                fsynced: true,
                semanticScopeSha256: 'a'.repeat(64),
            },
        });
        const revisionOptions = await getRevisionOptions(store, working);
        const {savePdfAsFromWorkingCopy} = await import('@app/platform/browser-api/browserSaveTargets');
        if (outcome === 'queued-abort') locks.holdElsewhere('evb-viewer:browser-physical-save');

        const publishing = savePdfAsFromWorkingCopy(working, {
            stagedOutput,
            optimizeLossless: true,
        }, revisionOptions, {
            kind: 'finalized',
            target: {
                canceled: false,
                fileName: 'report-optimized',
                handle: outcome === 'download' ? null : handle,
            },
            sourceRef: source,
            signal: controller.signal,
        });
        if (outcome === 'queued-abort') {
            await Promise.resolve();
            controller.abort(new DOMException('Optimize canceled', 'AbortError'));
            locks.releaseElsewhere('evb-viewer:browser-physical-save');
        }

        if (outcome === 'queued-abort' || outcome === 'writing-abort') {
            await expect(publishing).rejects.toMatchObject({name: 'AbortError'});
            expect(physical).toEqual(sentinel);
            expect(downloads).toEqual([]);
        } else {
            const saved = await publishing;
            if (outcome === 'download') {
                expect(new Uint8Array(await downloads[0]!.arrayBuffer())).toEqual(frontier);
                expect(physical).toEqual(sentinel);
            } else {
                expect(physical).toEqual(frontier);
            }
            await expect(store.read(saved!)).resolves.toEqual(frontier);
            await expect(store.getSaveTarget(saved!)).resolves.toMatchObject({saveName: 'report-optimized.pdf'});
        }
        // The finalized frontier is published as it is: no check, no second optimization.
        expect(qpdfRun).not.toHaveBeenCalled();
        await expect(store.read(source)).resolves.toEqual(original);
        await expect(store.read(working)).resolves.toEqual(original);
        await expect(store.read(staged)).resolves.toEqual(frontier);
    });

    it.each([
        'saved',
        'not-smaller',
        'invalid',
        'signed',
        'picker-cancel',
    ] as const)('optimizes a browser copy to the target picked in the submit task: %s', async outcome => {
        const original = Uint8Array.of(37, 80, 68, 70, 1, 2, 3, 4);
        const candidate = Uint8Array.of(37, 80, 68, 70, 9);
        let physical = new Uint8Array();
        let pickerCalls = 0;
        const handle = createFileSystemFileHandle({
            name: 'report-optimized.pdf',
            getFile: async () => new File([physical], 'report-optimized.pdf', {type: 'application/pdf'}),
            createWritable: async () => createFileSystemWritableFileStream({write: async chunk => {physical = new Uint8Array(requireArrayBufferChunk(chunk));}}),
        });
        const {
            capability, browserDocumentStore: store,
        } = await loadBrowserDocumentsFileCapability({windowOverrides: {showSaveFilePicker: async () => {
            pickerCalls += 1;
            if (outcome === 'picker-cancel') throw new DOMException('Canceled', 'AbortError');
            return handle;
        }}});
        const {onPdfOptimizeProgress} = (await import('@app/platform/browser-api/documentsMenuCapability')).browserDocumentsMenuCapability;
        const phases: string[] = [];
        onPdfOptimizeProgress(progress => phases.push(`${progress.phase}:${progress.percent}`));
        const source = await store.createStoredDocument('report.pdf', original, PDF_SOURCE_OPTIONS);
        const working = await store.cloneAsWorkingCopy(source);
        browserAnnotationParseMock.run.mockImplementation(async () => ({
            isSigned: outcome === 'signed',
            isEncrypted: false,
            isTagged: false,
            hasAcroForm: false,
            hasXfa: false,
        }));
        let checks = 0;
        qpdfRun.mockImplementation(async command => {
            if (command === 'lossless-rewrite') {
                return {
                    exitCode: 0,
                    stdout: '',
                    stderr: '',
                    output: outcome === 'not-smaller' ? original.slice() : candidate.slice(),
                };
            }
            checks += 1;
            return {
                exitCode: outcome === 'invalid' && checks === 2 ? 2 : 0,
                stdout: '',
                stderr: outcome === 'invalid' && checks === 2 ? 'damaged' : '',
                output: null,
            };
        });

        const selection = capability.prepareOptimizePdfAsCopy!(working);
        // The picker opened in this task, before any await.
        expect(pickerCalls).toBe(1);
        const prepared = await selection;
        if (outcome === 'picker-cancel') {
            expect(prepared).toBeNull();
            expect(qpdfRun).not.toHaveBeenCalled();
        } else if (outcome === 'signed') {
            await expect(prepared!(working, {preset: 'lossless'}, undefined, await getRevisionOptions(store, working)))
                .rejects.toThrow('does not rewrite a signed PDF');
            expect(qpdfRun).not.toHaveBeenCalled();
        } else {
            const result = await prepared!(working, {preset: 'lossless'}, undefined, await getRevisionOptions(store, working));
            expect(result).toMatchObject({
                outcome,
                preset: 'lossless',
                originalBytes: original.byteLength,
                pageCount: null,
                optimizedPages: 0,
            });
            if (outcome === 'saved') {
                expect(result.optimizedBytes).toBe(candidate.byteLength);
                expect(physical).toEqual(candidate);
                await expect(store.read(result.path!)).resolves.toEqual(candidate);
                const adopted = await capability.createWorkingCopyFromPath(result.path!);
                await expect(store.read(adopted)).resolves.toEqual(candidate);
                expect(phases.at(-1)).toBe('complete:100');
            } else {
                expect(result.path).toBeNull();
                expect(physical).toEqual(new Uint8Array());
                expect(phases.at(-1)).toBe(outcome === 'invalid' ? 'validating:90' : 'complete:100');
            }
        }
        if (outcome !== 'saved') expect(physical).toEqual(new Uint8Array());
        await expect(store.read(source)).resolves.toEqual(original);
        await expect(store.read(working)).resolves.toEqual(original);
    });

    it('streams oversized browser save-as to a picked file handle', async () => {
        const writes: Uint8Array[] = [];
        const savedBytes = new Uint8Array(BROWSER_FULL_READ_LIMIT + 1);
        const handle = createFileSystemFileHandle({
            name: 'exported-large.pdf',
            getFile: vi.fn(async () => new File([savedBytes], 'exported-large.pdf', { type: 'application/pdf' })),
            createWritable: vi.fn(async () => createFileSystemWritableFileStream({write: vi.fn(async (chunk: FileSystemWriteChunkType) => {
                const chunkBytes = new Uint8Array(requireArrayBufferChunk(chunk));
                const offset = writes.reduce((sum, current) => sum + current.byteLength, 0);
                savedBytes.set(chunkBytes, offset);
                writes.push(chunkBytes);
            })})),
        });
        const {
            BROWSER_MAX_FULL_READ_BYTES,
            capability,
            browserDocumentStore,
        } = await loadBrowserDocumentsFileCapability({ windowOverrides: { showSaveFilePicker: vi.fn(async () => handle) } });
        expect(BROWSER_MAX_FULL_READ_BYTES).toBe(BROWSER_FULL_READ_LIMIT);
        const workingRef = await browserDocumentStore.createStoredDocument(
            'oversized.pdf',
            new Uint8Array(BROWSER_MAX_FULL_READ_BYTES + 1),
            {
                mimeType: 'application/pdf',
                kind: 'working',
                saveKind: 'pdf',
            },
        );

        const sourceRef = await capability.savePdfAs(
            workingRef,
            undefined,
            await getRevisionOptions(browserDocumentStore, workingRef),
        );

        expect(sourceRef).not.toBeNull();
        const sourceEntry = sourceRef
            ? await browserDocumentStore.requireEntry(sourceRef)
            : null;
        expect(sourceEntry?.saveHandle).not.toBeNull();
        expect(sourceEntry?.saveHandle).toBe(handle);
        await expect(browserDocumentStore.stat(sourceRef!)).resolves.toEqual({
            size: BROWSER_MAX_FULL_READ_BYTES + 1,
            modifiedAt: expect.any(Number),
        });
        expect(writes.length).toBeGreaterThan(1);
    });

    it('preserves externally changed bytes when saving a byte-created snapshot', async () => {
        let physicalBytes = Uint8Array.of(37, 80, 68, 70);
        let modifiedAt = 1_000;
        const handle = createFileSystemFileHandle({
            name: 'snapshot.pdf',
            getFile: async () => new File([physicalBytes], 'snapshot.pdf', {lastModified: modifiedAt}),
            createWritable: async () => createFileSystemWritableFileStream({write: async chunk => {
                physicalBytes = new Uint8Array(requireArrayBufferChunk(chunk));
            }}),
        });
        const {
            capability, browserDocumentStore,
        } = await loadBrowserDocumentsFileCapability();
        const sourceRef = await browserDocumentStore.createStoredDocument('snapshot.pdf', physicalBytes, {
            ...PDF_SOURCE_OPTIONS,
            saveHandle: handle,
        });
        const snapshot = await capability.createWorkingCopyFromData('snapshot.pdf', Uint8Array.of(37, 80, 68, 70, 9), sourceRef);
        physicalBytes = Uint8Array.of(37, 80, 68, 70, 8);
        modifiedAt = 2_000;
        await expect(capability.saveFileStructured(snapshot, await getRevisionOptions(browserDocumentStore, snapshot)))
            .resolves.toMatchObject({
                ok: false,
                reason: 'original-changed',
            });
        expect(physicalBytes).toEqual(Uint8Array.of(37, 80, 68, 70, 8));
        await expect(browserDocumentStore.read(snapshot)).resolves.toEqual(Uint8Array.of(37, 80, 68, 70, 9));
    });

    it('refuses the later of two working copies\' saves to one file', async () => {
        const firstWriteStarted = Promise.withResolvers<undefined>();
        const releaseFirstWrite = Promise.withResolvers<undefined>();
        let writableIndex = 0;
        let sharedBytes = Uint8Array.of(37, 80, 68, 70);
        const createWritable = vi.fn(async () => {
            const index = writableIndex++;
            return createFileSystemWritableFileStream({write: vi.fn(async (chunk: FileSystemWriteChunkType) => {
                const nextBytes = new Uint8Array(requireArrayBufferChunk(chunk));
                if (index === 0) {
                    firstWriteStarted.resolve(undefined);
                    await releaseFirstWrite.promise;
                }
                sharedBytes = nextBytes;
            })});
        });
        const handle = createFileSystemFileHandle({
            name: 'shared.pdf',
            getFile: vi.fn(async () => new File([sharedBytes], 'shared.pdf', {
                type: 'application/pdf',
                lastModified: 1,
            })),
            createWritable,
        });
        const {
            capability,
            browserDocumentStore,
        } = await loadBrowserDocumentsFileCapability();
        const sourceRef = await browserDocumentStore.createStoredDocument(
            'shared.pdf',
            Uint8Array.of(37, 80, 68, 70),
            {
                ...PDF_SOURCE_OPTIONS,
                saveHandle: handle,
            },
        );
        const firstWorkingRef = await browserDocumentStore.cloneAsWorkingCopy(sourceRef);
        const secondWorkingRef = await browserDocumentStore.cloneAsWorkingCopy(sourceRef);
        await browserDocumentStore.write(firstWorkingRef, Uint8Array.of(37, 80, 68, 70, 1), await getRevisionOptions(browserDocumentStore, firstWorkingRef));
        await browserDocumentStore.write(secondWorkingRef, Uint8Array.of(37, 80, 68, 70, 2), await getRevisionOptions(browserDocumentStore, secondWorkingRef));

        const firstSave = capability.saveFileStructured(
            firstWorkingRef,
            await getRevisionOptions(browserDocumentStore, firstWorkingRef),
        );
        const secondSave = capability.saveFileStructured(
            secondWorkingRef,
            await getRevisionOptions(browserDocumentStore, secondWorkingRef),
        );
        await firstWriteStarted.promise;
        await new Promise<undefined>(resolve => setImmediate(() => resolve(undefined)));
        expect(createWritable).toHaveBeenCalledOnce();

        releaseFirstWrite.resolve(undefined);
        // Whichever save publishes first writes the file; the other finds it changed and offers Save As.
        const results = await Promise.all([
            firstSave,
            secondSave,
        ]);
        expect(results.map(result => result.ok).sort()).toEqual([false, true]);
        expect(results.find(result => !result.ok)).toMatchObject({reason: 'original-changed'});
        expect(createWritable).toHaveBeenCalledOnce();
    });

    it('keeps a queued Save on its original source when Save As creates a separate copy', async () => {
        const saveAsWriteStarted = Promise.withResolvers<undefined>();
        const releaseSaveAsWrite = Promise.withResolvers<undefined>();
        let saveAsWrittenBytes: Uint8Array<ArrayBuffer> | null = null;
        const saveAsHandle = createFileSystemFileHandle({
            name: 'save-as.pdf',
            getFile: vi.fn(async () => new File([saveAsWrittenBytes ?? new Uint8Array()], 'save-as.pdf', {type: 'application/pdf'})),
            createWritable: vi.fn(async () => createFileSystemWritableFileStream({write: vi.fn(async (chunk: FileSystemWriteChunkType) => {
                saveAsWriteStarted.resolve(undefined);
                await releaseSaveAsWrite.promise;
                saveAsWrittenBytes = new Uint8Array(requireArrayBufferChunk(chunk));
            })})),
        });
        let originalWrittenBytes: Uint8Array | null = null;
        const originalCreateWritable = vi.fn(async () => createFileSystemWritableFileStream({write: async (chunk: FileSystemWriteChunkType) => {
            originalWrittenBytes = new Uint8Array(requireArrayBufferChunk(chunk));
        }}));
        const originalBytes = Uint8Array.of(37, 80, 68, 70);
        const originalHandle = createFileSystemFileHandle({
            name: 'original.pdf',
            getFile: vi.fn(async () => new File([originalBytes], 'original.pdf', {
                type: 'application/pdf',
                lastModified: 1,
            })),
            createWritable: originalCreateWritable,
        });
        const {
            capability,
            browserDocumentStore,
        } = await loadBrowserDocumentsFileCapability({windowOverrides: {showSaveFilePicker: vi.fn(async () => saveAsHandle)}});
        const sourceRef = await browserDocumentStore.createStoredDocument(
            'original.pdf',
            originalBytes,
            {
                ...PDF_SOURCE_OPTIONS,
                saveHandle: originalHandle,
            },
        );
        const workingRef = await browserDocumentStore.cloneAsWorkingCopy(sourceRef);
        const revisionOptions = await getRevisionOptions(browserDocumentStore, workingRef);

        const saveAsPromise = capability.savePdfAs(workingRef, undefined, revisionOptions);
        await saveAsWriteStarted.promise;
        const regularSavePromise = capability.saveFileStructured(workingRef, revisionOptions);
        await new Promise<undefined>(resolve => setImmediate(() => resolve(undefined)));
        releaseSaveAsWrite.resolve(undefined);

        await expect(saveAsPromise).resolves.not.toBeNull();
        await expect(regularSavePromise).resolves.toMatchObject({ok: true});
        // The working copy still holds the file's bytes, so its Save has nothing to write.
        expect(originalWrittenBytes).toBeNull();
        expect(saveAsWrittenBytes).toEqual(originalBytes);
        expect(originalCreateWritable).not.toHaveBeenCalled();
    });

    it('streams a DOCX above the former 16 MiB browser limit into one download without a file handle', async () => {
        const downloads: Blob[] = [];
        class DownloadURL extends URL {}
        Object.defineProperties(DownloadURL, {
            createObjectURL: {value: (blob: Blob) => {
                downloads.push(blob);
                return 'blob:docx-download';
            }},
            revokeObjectURL: {value: () => {}},
        });
        vi.stubGlobal('URL', DownloadURL);
        const {capability} = await loadBrowserDocumentsFileCapability({windowOverrides: {showSaveFilePicker: undefined}});
        const outputPath = await capability.saveDocxAs(requireDocumentRef('/tmp/work.pdf'));
        if (!outputPath) throw new Error('Expected browser DOCX output path');
        const hash = createHash('sha256');
        const {sessionId} = await capability.beginDocxFileStream(outputPath);
        // Seventeen 1 MiB chunks of distinct bytes, sized like the desktop transport's chunks.
        for (let index = 0; index < 17; index += 1) {
            const chunk = new Uint8Array(1024 * 1024).fill(index + 1);
            hash.update(chunk);
            await expect(capability.writeDocxFileStreamChunk(sessionId, chunk)).resolves.toBe(true);
        }
        await expect(capability.commitDocxFileStream(sessionId)).resolves.toBe(true);

        expect(downloads).toHaveLength(1);
        expect(downloads[0]!.type).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
        expect(createHash('sha256').update(new Uint8Array(await downloads[0]!.arrayBuffer())).digest('hex')).toBe(hash.digest('hex'));
    });

    it.each([
        'finalizeChunkedDocument',
        'readRange',
    ] as const)('cancels a DOCX while commit waits for %s, without publishing a download', async (phase) => {
        const downloads: Blob[] = [];
        class DownloadURL extends URL {}
        Object.defineProperties(DownloadURL, {
            createObjectURL: {value: (blob: Blob) => {
                downloads.push(blob);
                return 'blob:canceled-docx';
            }},
            revokeObjectURL: {value: () => {}},
        });
        vi.stubGlobal('URL', DownloadURL);
        const {
            capability, browserDocumentStore,
        } = await loadBrowserDocumentsFileCapability({windowOverrides: {showSaveFilePicker: undefined}});
        const outputPath = await capability.saveDocxAs(requireDocumentRef('/tmp/work.pdf'));
        if (!outputPath) throw new Error('Expected browser DOCX output path');
        const {sessionId} = await capability.beginDocxFileStream(outputPath);
        await capability.writeDocxFileStreamChunk(sessionId, Uint8Array.of(80, 75, 3, 4));
        const entered = Promise.withResolvers<undefined>();
        const release = Promise.withResolvers<undefined>();
        // Both waits occur after commit starts and before the download is published.
        const finalize = browserDocumentStore.finalizeChunkedDocument.bind(browserDocumentStore);
        const readRange = browserDocumentStore.readRange.bind(browserDocumentStore);
        const pending = phase === 'finalizeChunkedDocument'
            ? vi.spyOn(browserDocumentStore, 'finalizeChunkedDocument').mockImplementationOnce(async (...args) => {
                entered.resolve(undefined);
                await release.promise;
                return finalize(...args);
            })
            : vi.spyOn(browserDocumentStore, 'readRange').mockImplementationOnce(async (...args) => {
                entered.resolve(undefined);
                await release.promise;
                return readRange(...args);
            });
        try {
            const commit = capability.commitDocxFileStream(sessionId);
            const commitResult = commit.then(() => 'published', (error: unknown) => error);
            await entered.promise;
            const canceled = capability.cancelDocxFileStream(sessionId);
            release.resolve(undefined);

            expect.soft(await canceled).toBe(true);
            expect.soft(await commitResult).toMatchObject({name: 'AbortError'});
            expect(downloads).toHaveLength(0);
        } finally {
            release.resolve(undefined);
            pending.mockRestore();
        }
    });

    it.each([
        'pdf',
        'docx',
    ] as const)('refuses an incompatible %s Save As through the real picker without publishing', async kind => {
        const handle = createFileSystemFileHandle({
            name: 'report.txt',
            getFile: async () => new File(['sentinel bytes'], 'report.txt'),
        });
        const writer = vi.spyOn(handle, 'createWritable');
        const {
            capability, browserDocumentStore: store,
        } = await loadBrowserDocumentsFileCapability({windowOverrides: {showSaveFilePicker: async () => handle}});
        const source = await store.createStoredDocument('source.pdf', await createPdfBytes(), PDF_SOURCE_OPTIONS);
        const working = await store.cloneAsWorkingCopy(source);
        const sourceBefore = await store.getSourceRef(working);
        const operation = kind === 'pdf' ? capability.savePdfAs(working, undefined, await getRevisionOptions(store, working)) : capability.saveDocxAs(working);
        await expect(operation).rejects.toThrow(`Choose a file name ending in .${kind}`);
        expect(await (await handle.getFile()).text()).toBe('sentinel bytes');
        expect(writer).not.toHaveBeenCalled();
        expect(await store.getSourceRef(working)).toBe(sourceBefore);
    });

    it('keeps a physical PDF name across Save As and the next ordinary Save', async () => {
        let bytes = await createPdfBytes();
        const name = ' report.PDF';
        const handle = createFileSystemFileHandle({
            name,
            getFile: async () => new File([bytes], name, {lastModified: 1}),
            createWritable: async () => {
                const chunks: Uint8Array[] = [];
                return createFileSystemWritableFileStream({
                    write: async chunk => {chunks.push(new Uint8Array(requireArrayBufferChunk(chunk)));},
                    close: async () => {bytes = new Uint8Array(Buffer.concat(chunks));},
                });
            },
        });
        const {
            capability, browserDocumentStore: store,
        } = await loadBrowserDocumentsFileCapability({windowOverrides: {showSaveFilePicker: async () => handle}});
        const source = await store.createStoredDocument('source.pdf', bytes, PDF_SOURCE_OPTIONS);
        const working = await store.cloneAsWorkingCopy(source);
        const saved = await capability.savePdfAs(working, undefined, await getRevisionOptions(store, working));
        if (!saved) throw new Error('Expected saved PDF');
        expect((await PDFDocument.load(await (await handle.getFile()).arrayBuffer())).getPageCount()).toBe(1);
        expect((await store.requireEntry(saved)).fileName).toBe(name);
        expect(await store.getSaveTarget(saved)).toMatchObject({
            saveName: name,
            saveHandle: handle,
        });
        const updated = await PDFDocument.load(await store.read(working));
        updated.setTitle('Ordinary Save reaches the physical PDF');
        await store.write(working, await updated.save(), await getRevisionOptions(store, working));
        await expect(capability.saveFileStructured(working, await getRevisionOptions(store, working))).resolves.toMatchObject({ok: true});
        expect((await PDFDocument.load(await (await handle.getFile()).arrayBuffer())).getTitle()).toBe('Ordinary Save reaches the physical PDF');
        expect(await store.getSaveTarget(source)).toMatchObject({
            saveName: name,
            saveHandle: handle,
        });
    });

    it('streams a valid DOCX ZIP and records its exact physical name', async () => {
        const name = ' report.DOCX';
        let bytes = new Uint8Array();
        const handle = createFileSystemFileHandle({
            name,
            getFile: async () => new File([bytes], name),
            createWritable: async () => {
                const chunks: Uint8Array[] = [];
                return createFileSystemWritableFileStream({
                    write: async chunk => {chunks.push(new Uint8Array(requireArrayBufferChunk(chunk)));},
                    close: async () => {bytes = new Uint8Array(Buffer.concat(chunks));},
                });
            },
        });
        const {
            capability, browserDocumentStore: store,
        } = await loadBrowserDocumentsFileCapability({windowOverrides: {showSaveFilePicker: async () => handle}});
        const {createDocxFromTextChunks} = await import('@app/utils/docxStreaming');
        const output = await capability.saveDocxAs(requireDocumentRef('/tmp/work.pdf'));
        if (!output) throw new Error('Expected DOCX target');
        const {sessionId} = await capability.beginDocxFileStream(output);
        const expected: Uint8Array[] = [];
        for await (const chunk of createDocxFromTextChunks(['Saved text'])) {
            expected.push(chunk);
            await capability.writeDocxFileStreamChunk(sessionId, chunk);
        }
        await capability.commitDocxFileStream(sessionId);
        expect(Buffer.from(await (await handle.getFile()).arrayBuffer())).toEqual(Buffer.concat(expected));
        expect(Buffer.from(bytes).includes(Buffer.from('word/document.xml'))).toBe(true);
        expect(Buffer.from(bytes).readUInt32LE(bytes.byteLength - 22)).toBe(0x06054b50);
        expect((await store.requireEntry(output)).fileName).toBe(name);
        expect(await store.getSaveTarget(output)).toMatchObject({
            saveName: name,
            saveHandle: handle,
        });
    });

    it('writes a streamed DOCX through its file handle and leaves no download', async () => {
        const createObjectURL = vi.fn(() => 'blob:unexpected');
        class TestURL extends URL {}
        Object.defineProperties(TestURL, {
            createObjectURL: {value: createObjectURL},
            revokeObjectURL: {value: () => {}},
        });
        vi.stubGlobal('URL', TestURL);
        const written: Uint8Array[] = [];
        const handle = createFileSystemFileHandle({
            name: 'export.docx',
            createWritable: async () => createFileSystemWritableFileStream({write: async (chunk) => {
                written.push(new Uint8Array(requireArrayBufferChunk(chunk)));
            }}),
        });
        const {capability} = await loadBrowserDocumentsFileCapability({windowOverrides: {showSaveFilePicker: async () => handle}});
        const outputPath = await capability.saveDocxAs(requireDocumentRef('/tmp/work.pdf'));
        if (!outputPath) throw new Error('Expected browser DOCX output path');
        const {sessionId} = await capability.beginDocxFileStream(outputPath);
        await capability.writeDocxFileStreamChunk(sessionId, Uint8Array.of(80, 75, 3, 4));
        await capability.writeDocxFileStreamChunk(sessionId, Uint8Array.of(5, 6));
        await capability.commitDocxFileStream(sessionId);

        expect(Buffer.concat(written)).toEqual(Buffer.from([
            80,
            75,
            3,
            4,
            5,
            6,
        ]));
        expect(createObjectURL).not.toHaveBeenCalled();
    });

    it.each([
        'save',
        'save-as',
    ] as const)('downloads every byte of a working copy above the former 64 MiB fallback through %s without a handle', async (mode) => {
        const downloads: Blob[] = [];
        class DownloadURL extends URL {}
        Object.defineProperties(DownloadURL, {
            createObjectURL: {value: (blob: Blob) => {
                downloads.push(blob);
                return 'blob:large-download';
            }},
            revokeObjectURL: {value: () => {}},
        });
        vi.stubGlobal('URL', DownloadURL);
        const {
            capability,
            browserDocumentStore,
        } = await loadBrowserDocumentsFileCapability({windowOverrides: {showSaveFilePicker: undefined}});
        const sourceRef = await browserDocumentStore.createStoredDocument(
            'source.pdf',
            Uint8Array.of(1),
            {...PDF_SOURCE_OPTIONS},
        );
        const workingRef = await browserDocumentStore.cloneAsWorkingCopy(sourceRef);
        const edited = new Uint8Array(FORMER_DOWNLOAD_FALLBACK_MAX_BYTES + 3);
        for (let offset = 0; offset < edited.byteLength; offset += 4096) edited[offset] = (offset / 4096) % 251;
        edited[edited.byteLength - 1] = 7;
        await browserDocumentStore.write(workingRef, edited, await getRevisionOptions(browserDocumentStore, workingRef));
        const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
        const readStored = async (ref: string) => {
            const {size} = await browserDocumentStore.stat(ref);
            const hash = createHash('sha256');
            for (let offset = 0; offset < size; offset += 4 * 1024 * 1024) {
                hash.update(await browserDocumentStore.readRange(ref, offset, Math.min(4 * 1024 * 1024, size - offset)));
            }
            return hash.digest('hex');
        };

        const savedRef = mode === 'save'
            ? ((await capability.saveFileStructured(workingRef, await getRevisionOptions(browserDocumentStore, workingRef))).ok ? sourceRef : null)
            : await capability.savePdfAs(workingRef, undefined, await getRevisionOptions(browserDocumentStore, workingRef));

        expect(savedRef).not.toBeNull();
        expect(downloads).toHaveLength(1);
        expect(downloads[0]!.type).toBe('application/pdf');
        expect(digest(new Uint8Array(await downloads[0]!.arrayBuffer()))).toBe(digest(edited));
        await expect(readStored(savedRef!)).resolves.toBe(digest(edited));
    });
});
