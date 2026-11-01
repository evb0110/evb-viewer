import {resolveObjectURL} from 'node:buffer';
import {runInNewContext} from 'node:vm';
import {
    DJVU_COMPACT_FOREGROUND_SUBSAMPLE, hasDjvuCompactForegroundColor,
} from '@contracts/djvuConversionPolicy';
import {readFileSync} from 'node:fs';
import {requireDocumentRef} from '@contracts/documentRef';
import {requirePageNumber} from '@contracts/pageNumbers';
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
        expect(parseDjvuPageHead(await layout.readComponentHead({
            index: 1,
            name: 'high-dpi.djvu',
        }), 2)).toEqual(sizes[1]);
    });

    it('reads every page of a document above the former browser page limits', async () => {
        const manyPages = new Uint8Array(readFileSync('tests/fixtures/djvu/sources/browser-boundary-501-pages.djvu'));
        const layout = await readBrowserDjvuSourceLayout({
            fileSize: manyPages.byteLength,
            readRange: async (offset, length) => manyPages.slice(offset, offset + length),
        });
        const heads = await Promise.all(Array.from({length: 501}, (_, index) => layout.readComponentHead({
            index,
            name: '',
        })));
        expect(heads.map((head, index) => parseDjvuPageHead(head, index + 1))).toEqual(Array.from({length: 501}, () => ({
            width: 512,
            height: 512,
            dpi: 300,
        })));
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
