import {readFileSync} from 'node:fs';
import {requireDocumentRef} from '@contracts/documentRef';
import {requirePageNumber} from '@contracts/pageNumbers';
import {MemoryStorage} from '@tests/unit/app/platform/browserPlatformTestDoubles';
import {browserDocumentStore} from '@app/platform/browserDocumentStore';
import {createElectronPlatformApiFixture} from '@tests/helpers/createElectronPlatformApiFixture';
import {
    createDjvuPagePreviewSourceFromPath,
    createDjvuWorkerFromPath,
    getDjvuWorkerPageSizes,
} from '@app/platform/browser-api/createDjvuWorkerFromPath';
import {parseDjvuPageHead, readBrowserDjvuSourceLayout} from '@app/platform/browser-api/browserDjvuSource';
import {
    findIndirectDjvuSelection,
    getBrowserDjvuComponentFiles,
    setBrowserDjvuComponentFiles,
} from '@app/platform/browser-api/browserDjvuComponents';
import {afterEach, describe, expect, it, vi} from 'vitest';

const workerMocks = vi.hoisted(() => ({createBrowserDjvuWorker: vi.fn()}));

vi.mock('@app/platform/browser-api/browserDjvuWorkerClient', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@app/platform/browser-api/browserDjvuWorkerClient')>()),
    createBrowserDjvuWorker: workerMocks.createBrowserDjvuWorker,
}));

describe('DjVu document components (DjVuLibre WASM worker source)', () => {
    afterEach(() => {
        vi.clearAllMocks();
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

    const bundledDirectory = {
        names: ['low-dpi.djvu', 'high-dpi.djvu'],
        flags: [1, 1],
    };

    function installWorkerMock(directory = bundledDirectory) {
        const opened: Array<{
            documentBytes: Uint8Array;
            hasComponents: boolean;
        }> = [];
        const worker = {
            open: vi.fn(async (documentBytes: ArrayBuffer, hasComponents: boolean) => {
                opened.push({
                    documentBytes: new Uint8Array(documentBytes),
                    hasComponents,
                });
            }),
            getComponentDirectory: vi.fn(async () => directory),
            getDocInfo: vi.fn(async () => ({
                pageCount: directory.flags.filter((flag) => (flag & 0x3f) === 1).length,
                isIndirect: true,
                files: [],
            })),
            getPageInfo: vi.fn(async () => ({
                width: 640,
                height: 480,
                dpi: 72,
                rotation: 0,
            })),
            getOutline: vi.fn(async () => []),
            getMetadata: vi.fn(async () => ({})),
            hasText: vi.fn(async () => false),
            getPageText: vi.fn(async () => ({
                text: '',
                pageWidth: 640,
                pageHeight: 480,
                zones: [],
            })),
            renderPageRgba: vi.fn(),
            renderPagePpm: vi.fn(),
            renderPageCompactLayer: vi.fn(),
            terminate: vi.fn(),
        };
        workerMocks.createBrowserDjvuWorker.mockReturnValue(worker);
        return {
            opened,
            worker,
        };
    }

    function stubBrowserSource(bytes: Uint8Array) {
        vi.spyOn(browserDocumentStore, 'stat').mockResolvedValue({
            size: bytes.length,
            modifiedAt: 1,
        });
        return vi
            .spyOn(browserDocumentStore, 'readRange')
            .mockImplementation(async (_ref, offset, length) => bytes.slice(offset, offset + length));
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
        installWorkerMock();
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
        vi.stubGlobal('window', {electronAPI});
        const source = await createDjvuPagePreviewSourceFromPath(requireDocumentRef('/books/Гиргас.djvu'));
        try {
            for (const pageNumber of [1, 2]) {
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

    it('exposes native outline and page text for an indirect desktop DjVu source', async () => {
        const path = requireDocumentRef('/books/indirect/index.djvu');
        const outline = [
            {
                title: 'Глава café',
                pageNumber: requirePageNumber(2),
                children: [],
            },
        ];
        const electronAPI = createElectronPlatformApiFixture({
            documentFiles: {
                statFile: async () => ({size: index.byteLength}),
                readFileRange: async (_path, start, length) => index.slice(start, start + length),
            },
            djvu: {
                getOutline: async (documentRef) => (documentRef === path ? outline : []),
                getPageText: async (documentRef, pageNumber) => (documentRef === path && pageNumber === 2 ? 'Native page text: 続き' : ''),
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
        installWorkerMock();
        stubBrowserSource(index);
        await expect(createDjvuWorkerFromPath(requireDocumentRef('browser://documents/index.djvu'))).rejects.toMatchObject({
            errorEnvelope: {code: 'djvu-components-required'},
        });
    });

    it('opens a browser index with the sibling files selected beside it', async () => {
        const {opened} = installWorkerMock();
        stubBrowserSource(index);
        const indexRef = requireDocumentRef('browser://documents/index-with-components.djvu');
        const siblings = ['low-dpi.djvu', 'high-dpi.djvu'].map(
            (name) => new File([readFileSync(`tests/fixtures/djvu/sources/indirect/${name}`)], name),
        );
        setBrowserDjvuComponentFiles(indexRef, siblings);
        const worker = await createDjvuWorkerFromPath(indexRef);
        try {
            await expect(getDjvuWorkerPageSizes(worker)).resolves.toEqual(sizes);
            expect(opened[0]!.documentBytes).toEqual(index);
            expect(opened[0]!.hasComponents).toBe(true);
        } finally {
            worker.terminate();
        }
        await expect(
            findIndirectDjvuSelection([{file: new File([index], 'index.djvu')}, ...siblings.map((file) => ({file}))]),
        ).resolves.toMatchObject({components: siblings});
        await expect(findIndirectDjvuSelection(siblings.map((file) => ({file})))).resolves.toBeNull();
    });

    it.each(['report.pdf', 'photo.png'])('keeps %s out of an indirect DjVu component selection', async (name) => {
        await expect(
            findIndirectDjvuSelection([
                {file: new File([index], 'index.djvu')},
                {file: new File([bundled], 'low-dpi.djvu')},
                {file: new File([Uint8Array.of(1)], name)},
            ]),
        ).resolves.toBeNull();
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
        const {opened} = installWorkerMock();
        stubBrowserSource(bundled);
        const worker = await createDjvuWorkerFromPath(requireDocumentRef('browser://documents/bundled-components.djvu'));
        try {
            await expect(getDjvuWorkerPageSizes(worker)).resolves.toEqual(sizes);
            const openCall = opened[0]!;
            expect(openCall.hasComponents).toBe(true);
            const ascii = new TextDecoder('ascii');
            expect(ascii.decode(openCall.documentBytes.subarray(0, 8))).toBe('AT&TFORM');
            expect(ascii.decode(openCall.documentBytes.subarray(12, 20))).toBe('DJVMDIRM');
            expect(openCall.documentBytes[24]! & 0x80).toBe(0);
            expect(openCall.documentBytes.byteLength).toBeLessThan(bundled.byteLength / 10);
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
        expect(second.byteLength).toBe(4 + 8 + 188);
        const ascii = new TextDecoder('ascii');
        expect(ascii.decode(second.subarray(0, 8))).toBe('AT&TFORM');
        expect(ascii.decode(second.subarray(12, 16))).toBe('DJVU');
        const [secondHead] = await layout.readComponentHeads([
            {
                index: 1,
                name: 'high-dpi.djvu',
            },
        ]);
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
        const heads = await layout.readComponentHeads(
            Array.from({length: 501}, (_, index) => ({
                index,
                name: '',
            })),
        );
        expect(readRange.mock.calls.length).toBe(readsAfterLayout);
        expect(heads.map((head, index) => parseDjvuPageHead(head, index + 1))).toEqual(
            Array.from({length: 501}, () => ({
                width: 512,
                height: 512,
                dpi: 300,
            })),
        );
    });

    function buildDjvuPageComponentBytes(
        size: {
            width: number;
            height: number;
            dpi: number;
        },
        includeMagic = false,
    ) {
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

    function buildSyntheticBundledDjvu(
        components: Array<{
            offset: number;
            size?: {
                width: number;
                height: number;
                dpi: number;
            };
        }>,
        totalSize: number,
    ) {
        const dirmDataLength = 3 + components.length * 4 + 1;
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
        headerBytes[24] = 0x81;
        view.setUint16(25, components.length);
        for (const [index, component] of components.entries()) {
            view.setUint32(27 + index * 4, component.offset);
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
                for (const [headOffset, headBytes] of componentHeads) {
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
        const synthetic = buildSyntheticBundledDjvu(
            [
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
            ],
            fileSize,
        );
        installWorkerMock({
            names: ['shared.djbz', 'page-1.djvu', 'thumb.djvu', 'page-2.djvu', 'page-3.djvu'],
            flags: [0, 1, 2, 0x81, 1],
        });
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

        const callsBeforeCachedOpen = readRangeSpy.mock.calls.length;
        const cachedWorker = await createDjvuWorkerFromPath(docRef);
        try {
            await expect(getDjvuWorkerPageSizes(cachedWorker)).resolves.toEqual(expectedSizes);
            expect(readRangeSpy.mock.calls.length - callsBeforeCachedOpen).toBe(1);
        } finally {
            cachedWorker.terminate();
        }
    });
});
