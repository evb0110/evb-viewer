import {resolveObjectURL} from 'node:buffer';
import {runInNewContext} from 'node:vm';
import {
    DJVU_COMPACT_FOREGROUND_SUBSAMPLE, hasDjvuCompactForegroundColor,
} from '@contracts/djvuConversionPolicy';
import {readFileSync} from 'node:fs';
import {requireDocumentRef} from '@contracts/documentRef';
import {requirePageNumber} from '@contracts/pageNumbers';
import {
    MemoryStorage,
} from '@tests/unit/app/platform/browserPlatformTestDoubles';
import {browserDocumentStore} from '@app/platform/browserDocumentStore';
import {createElectronPlatformApiFixture} from '@tests/helpers/createElectronPlatformApiFixture';
import {
    createDjvuPagePreviewSourceFromPath, createDjvuWorkerFromPath, getDjvuWorkerPageSizes,
} from '@app/platform/browser-api/createDjvuWorkerFromPath';
import {
    parseDjvuPageHead,
    readBrowserDjvuSourceLayout,
} from '@app/platform/browser-api/browserDjvuSource';
import { DJVU_COMPONENT_BASE_URL } from '@app/platform/browser-api/djvujsLoader';
import {
    findIndirectDjvuSelection,
    getBrowserDjvuComponentFiles,
    setBrowserDjvuComponentFiles,
} from '@app/platform/browser-api/browserDjvuComponents';
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

class FakeScriptElement extends EventTarget {
    public readonly dataset: Record<string, string> = {};
    public src = '';
    public async = false;
    public isConnected = false;

    public constructor(private readonly removeSelf: (script: FakeScriptElement) => void) {
        super();
    }

    public remove() {
        this.isConnected = false;
        this.removeSelf(this);
    }
}

function installDocumentDouble() {
    const scripts: FakeScriptElement[] = [];
    const remove = (script: FakeScriptElement) => {
        const index = scripts.indexOf(script);
        if (index >= 0) {
            scripts.splice(index, 1);
        }
    };
    vi.stubGlobal('document', {
        querySelector: () => scripts[0] ?? null,
        createElement: () => new FakeScriptElement(remove),
        head: {append(script: FakeScriptElement) {
            script.isConnected = true;
            scripts.push(script);
        }},
    });
    vi.stubGlobal('window', {});
    return scripts;
}

interface IScriptDownload {
    /** Delivers one more chunk of the script body. */
    push(): void;
    /** Ends the script body. */
    close(): void;
}

function installScriptDownload(): IScriptDownload[] {
    const downloads: IScriptDownload[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
        let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;
        const body = new ReadableStream<Uint8Array>({start(controller) {
            streamController = controller;
            init?.signal?.addEventListener('abort', () => controller.error(init.signal?.reason));
        }});
        downloads.push({
            push: () => streamController?.enqueue(new Uint8Array([0x20])),
            close: () => streamController?.close(),
        });
        return new Response(body);
    }));
    return downloads;
}

async function finishDownload(downloads: IScriptDownload[], index = downloads.length - 1) {
    await vi.waitFor(() => expect(downloads[index]).toBeDefined());
    downloads[index]!.close();
    await vi.advanceTimersByTimeAsync(0);
}

describe('loadDjvuJs', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it('shares one script load across concurrent callers', async () => {
        const scripts = installDocumentDouble();
        const downloads = installScriptDownload();
        const { loadDjvuJs } = await import('@app/platform/browser-api/djvujsLoader');

        const firstLoad = loadDjvuJs();
        const secondLoad = loadDjvuJs();
        await finishDownload(downloads);
        expect(downloads).toHaveLength(1);
        expect(scripts).toHaveLength(1);

        const djvuGlobal = {Worker: vi.fn()};
        Reflect.set(window, 'DjVu', djvuGlobal);
        scripts[0]?.dispatchEvent(new Event('load'));

        await expect(Promise.all([
            firstLoad,
            secondLoad,
        ])).resolves.toEqual([
            djvuGlobal,
            djvuGlobal,
        ]);
        expect(scripts).toHaveLength(1);
        expect(scripts[0]?.dataset.djvujsState).toBe('ready');
    });

    it('removes a failed script and allows a clean retry', async () => {
        const scripts = installDocumentDouble();
        const downloads = installScriptDownload();
        const { loadDjvuJs } = await import('@app/platform/browser-api/djvujsLoader');

        const firstLoad = loadDjvuJs();
        await finishDownload(downloads);
        scripts[0]?.dispatchEvent(new Event('error'));

        await expect(firstLoad).rejects.toThrow('Failed to load DjVu.js');
        expect(scripts).toHaveLength(0);

        const retry = loadDjvuJs();
        await finishDownload(downloads);
        expect(scripts).toHaveLength(1);
        const djvuGlobal = {Worker: vi.fn()};
        Reflect.set(window, 'DjVu', djvuGlobal);
        scripts[0]?.dispatchEvent(new Event('load'));
        await expect(retry).resolves.toBe(djvuGlobal);
    });

    it('abandons a download that stops sending data, then permits retry', async () => {
        const scripts = installDocumentDouble();
        const downloads = installScriptDownload();
        const {
            DJVU_SCRIPT_STALL_TIMEOUT_MS,
            loadDjvuJs,
        } = await import('@app/platform/browser-api/djvujsLoader');

        const firstLoad = loadDjvuJs();
        const rejection = expect(firstLoad).rejects.toMatchObject({name: 'TimeoutError'});
        await vi.waitFor(() => expect(downloads).toHaveLength(1));
        downloads[0]!.push();
        await vi.advanceTimersByTimeAsync(DJVU_SCRIPT_STALL_TIMEOUT_MS);
        await rejection;
        expect(scripts).toHaveLength(0);

        const retry = loadDjvuJs();
        await finishDownload(downloads);
        expect(scripts).toHaveLength(1);
        const djvuGlobal = {Worker: vi.fn()};
        Reflect.set(window, 'DjVu', djvuGlobal);
        scripts[0]?.dispatchEvent(new Event('load'));
        await expect(retry).resolves.toBe(djvuGlobal);
    });

    it('keeps a slow download that keeps delivering data', async () => {
        const scripts = installDocumentDouble();
        const downloads = installScriptDownload();
        const {
            DJVU_SCRIPT_STALL_TIMEOUT_MS,
            loadDjvuJs,
        } = await import('@app/platform/browser-api/djvujsLoader');

        const load = loadDjvuJs();
        await vi.waitFor(() => expect(downloads).toHaveLength(1));
        // Four chunks, each just inside the stall window: two minutes in all.
        for (let chunk = 0; chunk < 4; chunk += 1) {
            await vi.advanceTimersByTimeAsync(DJVU_SCRIPT_STALL_TIMEOUT_MS - 1_000);
            downloads[0]!.push();
        }
        await finishDownload(downloads, 0);
        expect(scripts).toHaveLength(1);
        const djvuGlobal = {Worker: vi.fn()};
        Reflect.set(window, 'DjVu', djvuGlobal);
        scripts[0]?.dispatchEvent(new Event('load'));
        await expect(load).resolves.toBe(djvuGlobal);
    });

    it('rejects and removes a script that loads without exposing the API', async () => {
        const scripts = installDocumentDouble();
        const downloads = installScriptDownload();
        const { loadDjvuJs } = await import('@app/platform/browser-api/djvujsLoader');

        const load = loadDjvuJs();
        await finishDownload(downloads);
        scripts[0]?.dispatchEvent(new Event('load'));

        await expect(load).rejects.toThrow('without exposing window.DjVu');
        expect(scripts).toHaveLength(0);
    });
});


describe('DjVu document components', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    const sizes = [
        {
            width: 640,
            height: 480,
            dpi: 72,
        },
        {
            width: 512,
            height: 512,
            dpi: 300,
        },
    ];
    const index = new Uint8Array(readFileSync('tests/fixtures/djvu/sources/indirect/index.djvu'));
    const bundled = new Uint8Array(readFileSync('tests/fixtures/djvu/sources/searchable-mixed-dpi.djvu'));

    // The bundled fixture's DIRM: two page components in this order.
    const bundledDirectory = {
        names: [
            'low-dpi.djvu',
            'high-dpi.djvu',
        ],
        flags: [
            1,
            1,
        ],
    };

    function installWorker() {
        const created: Array<{
            documentBytes: Uint8Array;
            options: unknown
        }> = [];
        class TestWorker {
            worker = {postMessage() {}};
            doc = {evbGetComponentDirectory: () => ({run: async () => bundledDirectory})};
            async createDocument(buffer: ArrayBuffer, options: unknown) {
                created.push({
                    documentBytes: new Uint8Array(buffer),
                    options,
                });
            }
            terminate() {}
        }
        return {
            created,
            djvuGlobal: {
                Worker: TestWorker,
                DjVuScript: () => undefined,
            },
        };
    }

    it.each([
        {
            name: 'indirect',
            bytes: index,
        },
        {
            name: 'bundled',
            bytes: bundled,
        },
    ])('supplies both $name desktop page geometries', async ({bytes}) => {
        const electronAPI = createElectronPlatformApiFixture({
            documentFiles: {
                statFile: async () => ({size: bytes.byteLength}),
                readFile: async () => bytes,
                readFileRange: async (_path, start, length) => bytes.slice(start, start + length),
            },
            djvu: {
                getInfo: async () => ({
                    pageCount: 2,
                    sourceDpi: 72,
                    hasBookmarks: false,
                    hasText: true,
                    metadata: {},
                }),
                getPageSourceInfo: async (_path, pageNumber) => ({
                    pageCount: 2,
                    pageNumber: requirePageNumber(pageNumber),
                    pageSize: sizes[pageNumber - 1]!,
                }),
            },
        });
        vi.stubGlobal('window', {
            electronAPI,
            DjVu: installWorker().djvuGlobal,
        });
        const source = await createDjvuPagePreviewSourceFromPath(requireDocumentRef('/books/Гиргас.djvu'));
        try {
            for (const pageNumber of [
                1,
                2,
            ]) {
                await expect(source.getPageSourceInfo(pageNumber)).resolves.toEqual({
                    pageCount: 2,
                    pageNumber: requirePageNumber(pageNumber),
                    pageSize: sizes[pageNumber - 1],
                });
            }
        } finally {
            source.terminate();
        }
    });

    function stubBrowserSource(bytes: Uint8Array) {
        vi.spyOn(browserDocumentStore, 'stat').mockResolvedValue({
            size: bytes.length,
            modifiedAt: 1,
        });
        return vi.spyOn(browserDocumentStore, 'readRange').mockImplementation(async (_ref, offset, length) => bytes.slice(offset, offset + length));
    }

    it('exposes native outline and page text for an indirect desktop DjVu source', async () => {
        const path = requireDocumentRef('/books/indirect/index.djvu');
        const outline = [{
            title: 'Глава café',
            pageNumber: requirePageNumber(2),
            children: [],
        }];
        const electronAPI = createElectronPlatformApiFixture({
            documentFiles: {
                statFile: async () => ({size: index.byteLength}),
                readFileRange: async (_path, start, length) => index.slice(start, start + length),
            },
            djvu: {
                getOutline: async documentRef => documentRef === path ? outline : [],
                getPageText: async (documentRef, pageNumber) => (
                    documentRef === path && pageNumber === 2 ? 'Native page text: 続き' : ''
                ),
            },
        });
        vi.stubGlobal('window', {electronAPI});

        const source = await createDjvuPagePreviewSourceFromPath(path);
        try {
            expect(source.getOutline).toBeTypeOf('function');
            expect(source.getPageText).toBeTypeOf('function');
            await expect(source.getOutline!()).resolves.toEqual(outline);
            await expect(source.getPageText!(2)).resolves.toBe('Native page text: 続き');
            expect(() => source.getPageText!(0)).toThrow();
        } finally {
            source.terminate();
        }
    });

    it('refuses a browser index without a sibling-file grant before missing page geometry escapes', async () => {
        vi.stubGlobal('window', {DjVu: installWorker().djvuGlobal});
        stubBrowserSource(index);
        await expect(createDjvuWorkerFromPath(requireDocumentRef('browser://documents/index.djvu')))
            .rejects.toMatchObject({errorEnvelope: {code: 'djvu-components-required'}});
    });

    it('opens a browser index with the sibling files selected beside it', async () => {
        const {
            created,
            djvuGlobal,
        } = installWorker();
        vi.stubGlobal('window', {DjVu: djvuGlobal});
        stubBrowserSource(index);
        const indexRef = requireDocumentRef('browser://documents/index-with-components.djvu');
        const siblings = [
            'low-dpi.djvu',
            'high-dpi.djvu',
        ].map(name => new File([readFileSync(`tests/fixtures/djvu/sources/indirect/${name}`)], name));
        setBrowserDjvuComponentFiles(indexRef, siblings);
        const worker = await createDjvuWorkerFromPath(indexRef);
        try {
            await expect(getDjvuWorkerPageSizes(worker)).resolves.toEqual(sizes);
            expect(created[0]!.documentBytes).toEqual(index);
            expect(created[0]!.options).toEqual({baseUrl: DJVU_COMPONENT_BASE_URL});
        } finally {
            worker.terminate();
        }
        await expect(findIndirectDjvuSelection([
            {file: new File([index], 'index.djvu')},
            ...siblings.map(file => ({file})),
        ])).resolves.toMatchObject({components: siblings});
        await expect(findIndirectDjvuSelection(siblings.map(file => ({file})))).resolves.toBeNull();
    });

    it.each([
        'report.pdf',
        'photo.png',
    ])('keeps %s out of an indirect DjVu component selection', async name => {
        await expect(findIndirectDjvuSelection([
            {file: new File([index], 'index.djvu')},
            {file: new File([bundled], 'low-dpi.djvu')},
            {file: new File([Uint8Array.of(1)], name)},
        ])).resolves.toBeNull();
    });

    it('releases selected component files when their index record is removed', async () => {
        const storage = new MemoryStorage();
        vi.stubGlobal('localStorage', storage);
        vi.stubGlobal('window', {localStorage: storage});
        const ref = await browserDocumentStore.createStoredDocument('index.djvu', index, {
            kind: 'source',
            mimeType: 'image/vnd.djvu',
            saveKind: 'generic',
        });
        const component = new File([bundled], 'low-dpi.djvu');
        setBrowserDjvuComponentFiles(ref, [component]);
        await expect(getBrowserDjvuComponentFiles(ref)?.readComponent(component.name)).resolves.toEqual(bundled);

        await browserDocumentStore.remove(ref);

        await expect(browserDocumentStore.stat(ref)).rejects.toThrow();
        expect(getBrowserDjvuComponentFiles(ref)).toBeNull();
    });

    it('opens a bundled browser DjVu as an index whose pages load by component', async () => {
        const {
            created,
            djvuGlobal,
        } = installWorker();
        vi.stubGlobal('window', {DjVu: djvuGlobal});
        stubBrowserSource(bundled);
        const worker = await createDjvuWorkerFromPath(requireDocumentRef('browser://documents/bundled-components.djvu'));
        try {
            await expect(getDjvuWorkerPageSizes(worker)).resolves.toEqual(sizes);
            const opened = created[0]!;
            expect(opened.options).toEqual({baseUrl: DJVU_COMPONENT_BASE_URL});
            // The decoder receives the DIRM without its bundled flag and offset table.
            const ascii = new TextDecoder('ascii');
            expect(ascii.decode(opened.documentBytes.subarray(0, 8))).toBe('AT&TFORM');
            expect(ascii.decode(opened.documentBytes.subarray(12, 20))).toBe('DJVMDIRM');
            expect(opened.documentBytes[24]! & 0x80).toBe(0);
            expect(opened.documentBytes.byteLength).toBeLessThan(bundled.byteLength / 10);
        } finally {
            worker.terminate();
        }
    });

    it('does not send DjVu outline page lookups after terminating during a traversal yield', async () => {
        const {djvuGlobal} = installWorker();
        const lookupsAfterTermination: string[] = [];
        let workerTerminated = false;
        class OutlineWorker extends djvuGlobal.Worker {
            public constructor() {
                super();
                Object.assign(this.doc, {
                    getContents: () => ({run: async () => Array.from({length: 65}, (_, index) => ({
                        description: `Bookmark ${index + 1}`,
                        url: `#${index + 1}`,
                    }))}),
                    getPageNumberByUrl: (url: string) => ({run: async () => {
                        if (workerTerminated) {
                            lookupsAfterTermination.push(url);
                        }
                        return 1;
                    }}),
                });
            }

            override terminate() {
                workerTerminated = true;
            }
        }
        vi.stubGlobal('window', {DjVu: {
            ...djvuGlobal,
            Worker: OutlineWorker,
        }});
        stubBrowserSource(bundled);
        const source = await createDjvuPagePreviewSourceFromPath(requireDocumentRef('browser://documents/outline-yield.djvu'));
        // Keep the task queue on the fake clock when the shared yield helper is used.
        vi.stubGlobal('MessageChannel', undefined);
        vi.useFakeTimers();
        try {
            const outline = source.getOutline!().catch(() => undefined);
            // A close queued for the next task runs while the first batch is yielded.
            setTimeout(() => source.terminate(), 0);
            await vi.runAllTimersAsync();
            await outline;

            expect(lookupsAfterTermination).toEqual([]);
        } finally {
            if (!workerTerminated) {
                source.terminate();
            }
            vi.useRealTimers();
        }
    });

    it('reads each bundled component as a standalone DjVu file', async () => {
        const layout = await readBrowserDjvuSourceLayout({
            fileSize: bundled.byteLength,
            readRange: async (offset, length) => bundled.slice(offset, offset + length),
        });
        const second = await layout.readComponent({
            index: 1,
            name: 'high-dpi.djvu',
        });
        // djvudump: FORM:DJVU [188] {high-dpi.djvu}, so 4 magic + 8 header + 188 bytes.
        expect(second.byteLength).toBe(4 + 8 + 188);
        const ascii = new TextDecoder('ascii');
        expect(ascii.decode(second.subarray(0, 8))).toBe('AT&TFORM');
        expect(ascii.decode(second.subarray(12, 16))).toBe('DJVU');
        const [secondHead] = await layout.readComponentHeads([{
            index: 1,
            name: 'high-dpi.djvu',
        }]);
        expect(parseDjvuPageHead(secondHead!, 2)).toEqual(sizes[1]);
    });

    it('reads every page of a document above the former browser page limits', async () => {
        const manyPages = new Uint8Array(readFileSync('tests/fixtures/djvu/sources/browser-boundary-501-pages.djvu'));
        const readRange = vi.fn(async (offset: number, length: number) => manyPages.slice(offset, offset + length));
        const layout = await readBrowserDjvuSourceLayout({
            fileSize: manyPages.byteLength,
            readRange,
        });
        const readsAfterLayout = readRange.mock.calls.length;
        const heads = await layout.readComponentHeads(Array.from({length: 501}, (_, index) => ({
            index,
            name: '',
        })));
        expect(readRange.mock.calls.length).toBe(readsAfterLayout);
        expect(heads.map((head, index) => parseDjvuPageHead(head, index + 1))).toEqual(Array.from({length: 501}, () => ({
            width: 512,
            height: 512,
            dpi: 300,
        })));
    });

    function buildDjvuPageComponentBytes(size: {
        width: number;
        height: number;
        dpi: number;
    }, includeMagic = false) {
        const prefix = includeMagic ? 4 : 0;
        const bytes = new Uint8Array(prefix + 30);
        const view = new DataView(bytes.buffer);
        const writeAscii = (offset: number, text: string) => {
            for (let index = 0; index < text.length; index += 1) {
                bytes[offset + index] = text.charCodeAt(index);
            }
        };
        if (includeMagic) {
            writeAscii(0, 'AT&T');
        }
        writeAscii(prefix, 'FORM');
        view.setUint32(prefix + 4, 22);
        writeAscii(prefix + 8, 'DJVUINFO');
        view.setUint32(prefix + 16, 10);
        view.setUint16(prefix + 20, size.width);
        view.setUint16(prefix + 22, size.height);
        bytes[prefix + 24] = 24;
        bytes[prefix + 25] = 0;
        view.setUint16(prefix + 26, size.dpi, true);
        bytes[prefix + 28] = 22;
        bytes[prefix + 29] = 1;
        return bytes;
    }

    function buildSyntheticBundledDjvu(components: Array<{
        offset: number;
        size?: {
            width: number;
            height: number;
            dpi: number;
        };
    }>, totalSize: number) {
        const dirmDataLength = 3 + (components.length * 4) + 1;
        const dirmPadded = 8 + dirmDataLength + (dirmDataLength & 1);
        const headerBytes = new Uint8Array(16 + dirmPadded);
        const view = new DataView(headerBytes.buffer);
        const writeAscii = (offset: number, text: string) => {
            for (let index = 0; index < text.length; index += 1) {
                headerBytes[offset + index] = text.charCodeAt(index);
            }
        };
        writeAscii(0, 'AT&TFORM');
        view.setUint32(8, totalSize - 12);
        writeAscii(12, 'DJVMDIRM');
        view.setUint32(20, dirmDataLength);
        headerBytes[24] = 0x80;
        view.setUint16(25, components.length);
        for (const [
            index,
            component,
        ] of components.entries()) {
            view.setUint32(27 + (index * 4), component.offset);
        }
        const componentHeads = new Map<number, Uint8Array>();
        for (const component of components) {
            if (component.size) {
                componentHeads.set(component.offset, buildDjvuPageComponentBytes(component.size));
            }
        }
        return {
            fileSize: totalSize,
            readRange(offset: number, length: number) {
                const output = new Uint8Array(length);
                if (offset < headerBytes.byteLength) {
                    const end = Math.min(headerBytes.byteLength, offset + length);
                    output.set(headerBytes.subarray(offset, end), 0);
                }
                for (const [
                    headOffset,
                    headBytes,
                ] of componentHeads) {
                    const start = Math.max(offset, headOffset);
                    const end = Math.min(offset + length, headOffset + headBytes.byteLength);
                    if (start < end) {
                        output.set(headBytes.subarray(start - headOffset, end - headOffset), start - offset);
                    }
                }
                return output;
            },
        };
    }

    it('batches multi-page bundled page-table reads, filters DIRM flags, preserves order, and caches results', async () => {
        const expectedSizes = [
            {
                width: 640,
                height: 480,
                dpi: 72,
            },
            {
                width: 800,
                height: 600,
                dpi: 150,
            },
            {
                width: 1024,
                height: 768,
                dpi: 300,
            },
        ];
        const fileSize = 12 * 1024 * 1024;
        // Place page components past the initial 4 MiB header window and out of file order,
        // interleaved with a shared dictionary (flag 0) and a thumbnail (flag 2).
        const synthetic = buildSyntheticBundledDjvu([
            {offset: 4_500_000},
            {
                offset: 5_200_000,
                size: expectedSizes[0]!,
            },
            {offset: 5_210_000},
            {
                offset: 5_100_000,
                size: expectedSizes[1]!,
            },
            {
                offset: 9_800_000,
                size: expectedSizes[2]!,
            },
        ], fileSize);
        const directory = {
            names: [
                'shared.djbz',
                'page-1.djvu',
                'thumb.djvu',
                'page-2.djvu',
                'page-3.djvu',
            ],
            flags: [
                0,
                1,
                2,
                0x81,
                1,
            ],
        };
        class CustomDirectoryWorker {
            worker = {postMessage() {}};
            doc = {evbGetComponentDirectory: () => ({run: async () => directory})};
            async createDocument() {}
            terminate() {}
        }
        vi.stubGlobal('window', {DjVu: {
            Worker: CustomDirectoryWorker,
            DjVuScript: () => undefined,
        }});
        vi.spyOn(browserDocumentStore, 'stat').mockResolvedValue({
            size: fileSize,
            modifiedAt: 42,
        });
        let inFlight = 0;
        let maxInFlight = 0;
        const rangeCalls: Array<{
            offset: number;
            length: number;
        }> = [];
        const readRangeSpy = vi.spyOn(browserDocumentStore, 'readRange').mockImplementation(async (_ref, offset, length) => {
            rangeCalls.push({
                offset,
                length,
            });
            inFlight += 1;
            maxInFlight = Math.max(maxInFlight, inFlight);
            await Promise.resolve();
            inFlight -= 1;
            return synthetic.readRange(offset, length);
        });

        const docRef = requireDocumentRef('browser://documents/batched-page-table.djvu');
        const worker = await createDjvuWorkerFromPath(docRef);
        try {
            await expect(getDjvuWorkerPageSizes(worker)).resolves.toEqual(expectedSizes);
            // Layout read once (0..4 MiB), then page-2 (5_100_000) & page-1 (5_200_000)
            // coalesce into one 100 KB+30 B span while sparse page-3 (9_800_000) reads its
            // 30-byte head concurrently in the same batch.
            expect(rangeCalls).toHaveLength(3);
            expect(rangeCalls.slice(1)).toEqual([
                {
                    offset: 5_100_000,
                    length: 100_030,
                },
                {
                    offset: 9_800_000,
                    length: 30,
                },
            ]);
            expect(maxInFlight).toBe(2);
        } finally {
            worker.terminate();
        }

        // Opening the same file version again reuses the cached page table without re-reading heads.
        const callsBeforeCachedOpen = readRangeSpy.mock.calls.length;
        const cachedWorker = await createDjvuWorkerFromPath(docRef);
        try {
            await expect(getDjvuWorkerPageSizes(cachedWorker)).resolves.toEqual(expectedSizes);
            // Only the initial header/DIRM window read runs; zero head reads.
            expect(readRangeSpy.mock.calls.length - callsBeforeCachedOpen).toBe(1);
        } finally {
            cachedWorker.terminate();
        }
    });

    it('batches indirect component head reads concurrently while preserving page order and skipping non-pages', async () => {
        const expectedSizes = [
            {
                width: 600,
                height: 800,
                dpi: 150,
            },
            {
                width: 700,
                height: 900,
                dpi: 200,
            },
            {
                width: 800,
                height: 1000,
                dpi: 300,
            },
        ];
        const directory = {
            names: [
                'shared.djbz',
                'p1.djvu',
                'p2.djvu',
                'p3.djvu',
            ],
            flags: [
                0,
                1,
                1,
                1,
            ],
        };
        const resolvers = new Map<string, () => void>();
        const started: string[] = [];
        const pageBytesByName = new Map([
            [
                'p1.djvu',
                buildDjvuPageComponentBytes(expectedSizes[0]!, true),
            ],
            [
                'p2.djvu',
                buildDjvuPageComponentBytes(expectedSizes[1]!, true),
            ],
            [
                'p3.djvu',
                buildDjvuPageComponentBytes(expectedSizes[2]!, true),
            ],
        ]);
        const layout = await readBrowserDjvuSourceLayout({
            fileSize: index.byteLength,
            readRange: async (offset, length) => index.slice(offset, offset + length),
            componentFiles: {async readComponent(name) {
                started.push(name);
                await new Promise<void>((resolve) => {
                    resolvers.set(name, resolve);
                });
                return pageBytesByName.get(name)!;
            }},
        });

        const pageRequests = directory.flags.flatMap((flags, idx) => (
            (flags & 0x3f) === 1
                ? [{
                    index: idx,
                    name: directory.names[idx]!,
                }]
                : []
        ));
        const headsPromise = layout.readComponentHeads(pageRequests);
        await vi.waitFor(() => expect(started).toEqual([
            'p1.djvu',
            'p2.djvu',
            'p3.djvu',
        ]));
        // Resolve out of order to confirm result ordering follows request order.
        resolvers.get('p3.djvu')!();
        resolvers.get('p1.djvu')!();
        resolvers.get('p2.djvu')!();

        const heads = await headsPromise;
        expect(heads.map((head, idx) => parseDjvuPageHead(head, idx + 1))).toEqual(expectedSizes);
    });

    it('cancels batched page-table reads cleanly and does not poison the page-table cache', async () => {
        const expectedSize = {
            width: 640,
            height: 480,
            dpi: 100,
        };
        const fileSize = 6 * 1024 * 1024;
        const synthetic = buildSyntheticBundledDjvu([
            {
                offset: 5_000_000,
                size: expectedSize,
            },
        ], fileSize);
        const directory = {
            names: ['page-1.djvu'],
            flags: [1],
        };
        let terminatedCount = 0;
        class CancelWorker {
            worker = {postMessage() {}};
            doc = {evbGetComponentDirectory: () => ({run: async () => directory})};
            async createDocument() {}
            terminate() {
                terminatedCount += 1;
            }
        }
        vi.stubGlobal('window', {DjVu: {
            Worker: CancelWorker,
            DjVuScript: () => undefined,
        }});
        vi.spyOn(browserDocumentStore, 'stat').mockResolvedValue({
            size: fileSize,
            modifiedAt: 77,
        });
        let blockHeadRead = true;
        let releaseBlockedHeadRead: (() => void) | null = null;
        vi.spyOn(browserDocumentStore, 'readRange').mockImplementation(async (_ref, offset, length) => {
            if (blockHeadRead && offset >= 4 * 1024 * 1024) {
                await new Promise<void>((resolve) => {
                    releaseBlockedHeadRead = resolve;
                });
            }
            return synthetic.readRange(offset, length);
        });

        const docRef = requireDocumentRef('browser://documents/canceled-page-table.djvu');
        const controller = new AbortController();
        const canceledOpen = createDjvuWorkerFromPath(docRef, {signal: controller.signal});
        await vi.waitFor(() => expect(releaseBlockedHeadRead).not.toBeNull());
        controller.abort();
        await expect(canceledOpen).rejects.toThrow('DjVu conversion canceled');
        expect(terminatedCount).toBeGreaterThanOrEqual(1);
        releaseBlockedHeadRead!();

        // Subsequent non-canceled open must succeed rather than reusing the rejected cache entry.
        blockHeadRead = false;
        const retryWorker = await createDjvuWorkerFromPath(docRef);
        try {
            await expect(getDjvuWorkerPageSizes(retryWorker)).resolves.toEqual([expectedSize]);
        } finally {
            retryWorker.terminate();
        }
    });

    it('lets a concurrent browser open succeed when the first caller cancels while sharing a cached page-table scan', async () => {
        const expectedSize = {
            width: 800,
            height: 600,
            dpi: 150,
        };
        const fileSize = 6 * 1024 * 1024;
        const synthetic = buildSyntheticBundledDjvu([
            {
                offset: 5_000_000,
                size: expectedSize,
            },
        ], fileSize);
        const directory = {
            names: ['page-1.djvu'],
            flags: [1],
        };
        const terminatedWorkers = new Set<unknown>();
        let directoryReads = 0;
        class ConcurrentWorker {
            worker = {postMessage() {}};
            doc = {evbGetComponentDirectory: () => ({run: async () => {
                directoryReads += 1;
                return directory;
            }})};
            async createDocument() {}
            terminate() {
                terminatedWorkers.add(this);
            }
        }
        vi.stubGlobal('window', {DjVu: {
            Worker: ConcurrentWorker,
            DjVuScript: () => undefined,
        }});
        vi.spyOn(browserDocumentStore, 'stat').mockResolvedValue({
            size: fileSize,
            modifiedAt: 88,
        });
        let headReadCount = 0;
        let releaseHeadRead: (() => void) | null = null;
        vi.spyOn(browserDocumentStore, 'readRange').mockImplementation(async (_ref, offset, length) => {
            if (offset >= 4 * 1024 * 1024) {
                headReadCount += 1;
                await new Promise<void>((resolve) => {
                    releaseHeadRead = resolve;
                });
            }
            return synthetic.readRange(offset, length);
        });

        const docRef = requireDocumentRef('browser://documents/concurrent-cancel-page-table.djvu');
        const firstController = new AbortController();
        const firstOpen = createDjvuWorkerFromPath(docRef, {signal: firstController.signal});
        await vi.waitFor(() => expect(releaseHeadRead).not.toBeNull());

        const secondOpen = createDjvuWorkerFromPath(docRef);
        // Wait until the second caller has read the directory and attached to the shared pageTableCache entry.
        await vi.waitFor(() => expect(directoryReads).toBe(2));
        await Promise.resolve();
        await Promise.resolve();
        expect(headReadCount).toBe(1);

        firstController.abort();
        await expect(firstOpen).rejects.toThrow('DjVu conversion canceled');
        expect(terminatedWorkers.size).toBe(1);

        releaseHeadRead!();
        const secondWorker = await secondOpen;
        try {
            expect(terminatedWorkers.has(secondWorker)).toBe(false);
            await expect(getDjvuWorkerPageSizes(secondWorker)).resolves.toEqual([expectedSize]);
            expect(headReadCount).toBe(1);
        } finally {
            secondWorker.terminate();
        }
    });
});


describe('DjVu foreground overlap routing', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    it('routes two coincident colored blits like the one visible blit', async () => {
        const urls: string[] = [];
        const {createDjvuWorker} = await import('@app/platform/browser-api/djvujsLoader');
        // Run the serialized bootstrap produced for a worker through its public
        // factory. The library double supplies decoded page data at that seam.
        const library = {
            Worker: function (url: string) {
                urls.push(url);
                return {terminate() {}};
            },
            DjVuScript: function () {
                class Page {
                    info = {
                        width: 24,
                        height: 24,
                        dpi: 300,
                        flags: 0,
                    };
                    sjbz = null;
                    fgbz = null;
                    fg44 = null;
                    fgimage = null;
                    bgimage = null;
                    init() {}
                    decode() {}
                }
                return {Document: class {async getPage() { return new Page(); }}};
            },
        };
        createDjvuWorker(library as never);
        const blob = resolveObjectURL(urls[0]!);
        expect(blob).toBeDefined();
        const scope = {
            self: {onmessage: null},
            TextEncoder,
        };
        const decoded = runInNewContext(await blob!.text() + '\nDjVu;', scope);
        URL.revokeObjectURL(urls[0]!);
        const page = await new decoded.Document().getPage(1);
        const bitmap = {
            width: 24,
            height: 24,
            get: () => 1,
        };
        let colors = [{
            r: 120,
            g: 0,
            b: 0,
        }];
        page.fgbz = {
            getDataSize: () => colors.length,
            getPixelByBlitIndex: (index: number) => colors[index],
        };
        page.sjbz = {
            width: 24,
            height: 24,
            length: 10000,
            blitList: [{
                bitmap,
                x: 0,
                y: 0,
            }],
        };
        const one = page.evbGetLayerInfo(DJVU_COMPACT_FOREGROUND_SUBSAMPLE);
        colors = [
            colors[0]!,
            colors[0]!,
        ];
        page.sjbz.blitList.push({
            bitmap,
            x: 0,
            y: 0,
        });
        const coincident = page.evbGetLayerInfo(DJVU_COMPACT_FOREGROUND_SUBSAMPLE);
        expect(coincident.foreground).toEqual(one.foreground);
        expect(hasDjvuCompactForegroundColor(coincident.foreground)).toBe(true);
        expect(hasDjvuCompactForegroundColor(coincident.foreground))
            .toBe(hasDjvuCompactForegroundColor(one.foreground));

        // Different colors also use the last blit's color, as DjVu.js renders.
        colors = [
            {
                r: 120,
                g: 0,
                b: 0,
            },
            {
                r: 0,
                g: 80,
                b: 0,
            },
        ];
        expect(page.evbGetLayerInfo(DJVU_COMPACT_FOREGROUND_SUBSAMPLE).foreground)
            .toEqual({
                dominantColor: [
                    0,
                    80,
                    0,
                ],
                colorRatio: 1,
            });
    });
});

describe('DjVu worker shutdown', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('ends the calls a stopped worker was running or had queued', async () => {
        const {createDjvuWorker} = await import('@app/platform/browser-api/djvujsLoader');
        // The vendored library, driving a worker thread that never answers.
        const posted: unknown[] = [];
        let threadTerminated = false;
        const library = runInNewContext(`${readFileSync('public/vendor/djvujs/djvu.js', 'utf8')}\nDjVu;`, {
            Worker: class {
                public onmessage: unknown = null;
                public onerror: unknown = null;
                public postMessage(message: unknown) {
                    posted.push(message);
                }
                public terminate() {
                    threadTerminated = true;
                }
            },
            // A page, not a worker scope: the library starts its worker side without a document.
            self: {
                document: {},
                TextDecoder,
            },
            URL,
            Blob,
            console,
            setTimeout,
            clearTimeout,
        });
        const worker = createDjvuWorker(library);
        const running = worker.doc.getPage(1).getText().run();
        const queued = worker.doc.getPage(2).getText().run();
        expect(posted).toHaveLength(1);

        worker.terminate();

        await expect(running).rejects.toMatchObject({name: 'AbortError'});
        await expect(queued).rejects.toMatchObject({name: 'AbortError'});
        expect(threadTerminated).toBe(true);
    });
});
