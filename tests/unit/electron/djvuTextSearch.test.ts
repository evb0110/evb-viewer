import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { requirePageNumber } from '@contracts/pageNumbers';
import {
    createDjvuLibreEngine,
    type TDjvuLibreModuleFactory,
} from '@djvu-core/djvuLibreEngine';
import { mainJobBroker } from '@electron/resources/jobBroker';

const mocks = vi.hoisted(() => ({ runDjvuEngine: vi.fn() }));

vi.mock('@electron/features/djvu/main/djvuEnginePool', () => ({ runDjvuEngine: mocks.runDjvuEngine }));

const {
    addDjvuMatchGeometry,
    detectDjvuHasText,
    djvuSearchDocument,
    readDjvuPageText,
} = await import('@electron/features/djvu/main/textSearch');

describe('DjVu text search (DjVuLibre WASM)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('attaches word boxes mapped into top-left page coordinates', async () => {
        mocks.runDjvuEngine.mockResolvedValueOnce({
            text: 'Late Needle',
            pageWidth: 1000,
            pageHeight: 2000,
            zones: [
                {
                    type: 'word',
                    lineId: 1,
                    xmin: 10,
                    ymin: 1500,
                    xmax: 130,
                    ymax: 1600,
                    text: 'Late',
                },
                {
                    type: 'word',
                    lineId: 1,
                    xmin: 150,
                    ymin: 1500,
                    xmax: 350,
                    ymax: 1600,
                    text: 'Needle',
                },
            ],
        });

        const results = await addDjvuMatchGeometry('/library/book.djvu', [{
            pageNumber: requirePageNumber(2),
            pageMatchIndex: 0,
            matchIndex: 0,
            startOffset: 5,
            endOffset: 11,
            excerpt: {
                prefix: false,
                suffix: false,
                before: 'Late ',
                match: 'Needle',
                after: '',
            },
        }]);

        expect(mocks.runDjvuEngine).toHaveBeenCalledWith({
            type: 'getPageText',
            djvuPath: '/library/book.djvu',
            pageNumber: 2,
            includeZones: true,
        }, expect.anything());
        expect(results).toMatchObject([{
            pageNumber: 2,
            pageWidth: 1000,
            pageHeight: 2000,
            words: [{
                text: 'Needle',
                x: 150,
                y: 400,
                width: 200,
                height: 100,
            }],
        }]);
    });

    it('detects source text and propagates errors instead of treating unreadable text as empty', async () => {
        mocks.runDjvuEngine.mockResolvedValueOnce(true);
        await expect(detectDjvuHasText('/library/book.djvu')).resolves.toBe(true);

        mocks.runDjvuEngine.mockResolvedValueOnce(false);
        await expect(detectDjvuHasText('/library/empty.djvu')).resolves.toBe(false);

        mocks.runDjvuEngine.mockRejectedValueOnce(new Error('DjVuText.corrupt_chunk'));
        await expect(detectDjvuHasText('/library/corrupt.djvu')).rejects.toThrow('DjVuText.corrupt_chunk');
    });

    it('reads single-page text under mainJobBroker and preserves line breaks and Unicode', async () => {
        let activeDuringCall = -1;
        mocks.runDjvuEngine.mockImplementationOnce(async () => {
            activeDuringCall = mainJobBroker.getSnapshot().active;
            return {
                text: 'Third Привет\nNextLine',
                pageWidth: 1000,
                pageHeight: 2000,
                zones: [
                    {
                        type: 'word',
                        lineId: 1,
                        xmin: 0,
                        ymin: 1800,
                        xmax: 200,
                        ymax: 1900,
                        text: 'Third',
                    },
                    {
                        type: 'word',
                        lineId: 1,
                        xmin: 220,
                        ymin: 1800,
                        xmax: 500,
                        ymax: 1900,
                        text: 'Привет',
                    },
                    {
                        type: 'word',
                        lineId: 2,
                        xmin: 0,
                        ymin: 1600,
                        xmax: 300,
                        ymax: 1700,
                        text: 'NextLine',
                    },
                ],
            };
        });

        const text = await readDjvuPageText('/library/book.djvu', 3);
        expect(text).toBe('Third Привет\nNextLine');
        expect(activeDuringCall).toBe(1);
        expect(mainJobBroker.getSnapshot().active).toBe(0);
    });

    it('handles invalid, empty, out-of-range, corrupt, and aborted single-page reads', async () => {
        await expect(readDjvuPageText('/library/book.djvu', 0)).resolves.toBe('');
        await expect(readDjvuPageText('/library/book.djvu', -2)).resolves.toBe('');
        await expect(readDjvuPageText('/library/book.djvu', 1.5)).resolves.toBe('');
        await expect(readDjvuPageText('/library/book.djvu', Number.NaN)).resolves.toBe('');
        await expect(readDjvuPageText('/library/book.djvu', 2_147_483_648)).resolves.toBe('');
        await expect(readDjvuPageText('/library/book.djvu', Number.MAX_SAFE_INTEGER)).resolves.toBe('');
        expect(mocks.runDjvuEngine).not.toHaveBeenCalled();

        mocks.runDjvuEngine.mockResolvedValueOnce({
            text: '',
            pageWidth: 0,
            pageHeight: 0,
            zones: [],
        });
        await expect(readDjvuPageText('/library/book.djvu', 2)).resolves.toBe('');

        mocks.runDjvuEngine.mockRejectedValueOnce(new Error('Page 99 is out of bounds'));
        await expect(readDjvuPageText('/library/book.djvu', 99)).resolves.toBe('');

        mocks.runDjvuEngine.mockRejectedValueOnce(new Error('Failed to open document'));
        await expect(readDjvuPageText('/library/corrupt.djvu', 1)).rejects.toThrow('Failed to open document');

        const controller = new AbortController();
        controller.abort();
        await expect(readDjvuPageText('/library/book.djvu', 1, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    });

    it('matches full-stream djvuSearchDocument output on a real multi-page DjVu fixture via WASM', async () => {
        const engine = createDjvuLibreEngine({
            loadEngine: async () => {
                const [
                    imported,
                    wasmBytes,
                ] = await Promise.all([
                    import(pathToFileURL(resolve(process.cwd(), 'public/wasm/evb-djvulibre.mjs')).href) as Promise<{ default: TDjvuLibreModuleFactory }>,
                    readFile(resolve(process.cwd(), 'public/wasm/evb-djvulibre.wasm')),
                ]);
                return {
                    factory: imported.default,
                    module: await WebAssembly.compile(wasmBytes),
                };
            },
        });
        const fixturePath = resolve('tests/fixtures/djvu/sources/searchable-mixed-dpi.djvu');
        const fixtureBytes = new Uint8Array(await readFile(fixturePath));
        const docHandle = await engine.openDocument({ initBytes: fixtureBytes });

        try {
            mocks.runDjvuEngine.mockImplementation(async (request: {
                type: string;
                pageNumber?: number;
                includeZones?: boolean;
            }) => {
                if (request.type === 'getDocInfo') {
                    return {
                        ...await docHandle.getDocInfo(),
                        sourceDpi: 72,
                    };
                }
                if (request.type === 'getPageText') {
                    return docHandle.getPageText(request.pageNumber!, { includeZones: Boolean(request.includeZones) });
                }
                if (request.type === 'hasText') {
                    return docHandle.hasText();
                }
                throw new Error(`Unexpected request: ${request.type}`);
            });

            const searchDoc = await djvuSearchDocument(fixturePath);
            const streamedPages = new Map<number, string>();
            for await (const page of searchDoc.readPages(new AbortController().signal, undefined, () => {})) {
                streamedPages.set(page.pageNumber, page.text);
            }

            const page1 = await readDjvuPageText(fixturePath, 1);
            const page2 = await readDjvuPageText(fixturePath, 2);
            const page3OutOfRange = await readDjvuPageText(fixturePath, 3);

            expect(page1).toBe(streamedPages.get(1));
            expect(page1).toBe('djvuwin');
            expect(page2).toBe(streamedPages.get(2));
            expect(page2).toBe('');
            expect(page3OutOfRange).toBe('');
            expect(await detectDjvuHasText(fixturePath)).toBe(true);
        } finally {
            docHandle.close();
        }
    });
});
