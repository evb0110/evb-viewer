import {readFileSync} from 'node:fs';
import {requireDocumentRef} from '@contracts/documentRef';
import {requirePageNumber} from '@contracts/pageNumbers';
import {browserDocumentStore} from '@app/platform/browserDocumentStore';
import {createElectronPlatformApiFixture} from '@tests/helpers/createElectronPlatformApiFixture';
import {
    createDjvuPagePreviewSourceFromPath, createDjvuWorkerFromPath,
} from '@app/platform/browser-api/createDjvuWorkerFromPath';
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
        const { loadDjvuJs } = await import('@app/platform/browser-api/djvujsLoader');

        const firstLoad = loadDjvuJs();
        const secondLoad = loadDjvuJs();
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
        const { loadDjvuJs } = await import('@app/platform/browser-api/djvujsLoader');

        const firstLoad = loadDjvuJs();
        scripts[0]?.dispatchEvent(new Event('error'));

        await expect(firstLoad).rejects.toThrow('Failed to load DjVu.js');
        expect(scripts).toHaveLength(0);

        const retry = loadDjvuJs();
        expect(scripts).toHaveLength(1);
        const djvuGlobal = {Worker: vi.fn()};
        Reflect.set(window, 'DjVu', djvuGlobal);
        scripts[0]?.dispatchEvent(new Event('load'));
        await expect(retry).resolves.toBe(djvuGlobal);
    });

    it('times out a hung load, removes it, and permits retry', async () => {
        const scripts = installDocumentDouble();
        const {
            DJVU_SCRIPT_LOAD_TIMEOUT_MS,
            loadDjvuJs,
        } = await import('@app/platform/browser-api/djvujsLoader');

        const firstLoad = loadDjvuJs();
        const rejection = expect(firstLoad).rejects.toThrow('Timed out loading DjVu.js');
        await vi.advanceTimersByTimeAsync(DJVU_SCRIPT_LOAD_TIMEOUT_MS);
        await rejection;
        expect(scripts).toHaveLength(0);

        const retry = loadDjvuJs();
        expect(scripts).toHaveLength(1);
        const djvuGlobal = {Worker: vi.fn()};
        Reflect.set(window, 'DjVu', djvuGlobal);
        scripts[0]?.dispatchEvent(new Event('load'));
        await expect(retry).resolves.toBe(djvuGlobal);
    });

    it('rejects and removes a script that loads without exposing the API', async () => {
        const scripts = installDocumentDouble();
        const { loadDjvuJs } = await import('@app/platform/browser-api/djvujsLoader');

        const load = loadDjvuJs();
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

    function installWorker(pageSizes: typeof sizes) {
        class TestWorker {
            doc = {
                getPagesQuantity: () => ({run: async () => 2}),
                getPagesSizes: () => ({run: async () => pageSizes}),
            };
            async createDocument() {}
            terminate() {}
        }
        return {Worker: TestWorker};
    }

    it.each([
        {
            name: 'indirect',
            bytes: index,
            workerSizes: new Array<(typeof sizes)[number]>(2),
        },
        {
            name: 'bundled',
            bytes: bundled,
            workerSizes: sizes,
        },
    ])('supplies both $name desktop page geometries', async ({
        bytes, workerSizes,
    }) => {
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
            DjVu: installWorker(workerSizes),
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

    it('refuses a browser index without a sibling-file grant before missing page geometry escapes', async () => {
        vi.stubGlobal('window', {DjVu: installWorker(new Array<(typeof sizes)[number]>(2))});
        vi.spyOn(browserDocumentStore, 'stat').mockResolvedValue({
            size: index.length,
            modifiedAt: 1,
        });
        vi.spyOn(browserDocumentStore, 'readRange').mockResolvedValue(index);
        vi.spyOn(browserDocumentStore, 'unload').mockImplementation(() => {});
        await expect(createDjvuWorkerFromPath(requireDocumentRef('browser://documents/index.djvu')))
            .rejects.toMatchObject({errorEnvelope: {code: 'djvu-components-required'}});
    });
});
