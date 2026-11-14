import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
    PDFArray,
    PDFDict,
    PDFDocument,
    PDFHexString,
    degrees,
    decodePDFRawStream,
    drawObject,
    PDFName,
    PDFNumber,
    PDFRef,
    PDFRawStream,
    PDFString,
    rgb,
    StandardFonts,
} from 'pdf-lib';

import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import * as v from 'valibot';
import type { IPageGeometry } from '@contracts/shared';
import {PDF_BOOKMARK_RECOVERY_ENTRY_SCHEMA} from '@contracts/pdfBookmarkEntry';
import {
    isBrowserPageOpsWasmFailure,
    type IPageMutationWorkerResult,
} from '@contracts/browserPageOpsWorker';
import type {IBrowserPageOpsWasmFailure} from '@app/platform/browser-api/tryRunBrowserPageOpsWithWasm';
import type {TPageStructureEdit} from '@app/platform/browser/pdfPageEngine';
import {
    SPLIT_PAGES_INSTRUCTIONS_SCHEMA,
    OVERLAY_TEXT_INSTRUCTIONS_SCHEMA,
    RECOMPRESS_IMAGES_INSTRUCTIONS_SCHEMA,
    REPLACE_PAGE_IMAGES_INSTRUCTIONS_SCHEMA,
} from '@contracts/browserPageOpsWriters';
import {decodeBrowserPdfAnnotationsOutput} from '@app/platform/browser-api/decodeBrowserPdfAnnotationsOutput';
import {
    PDF_ANNOTATION_PARSE_MAX_ENTRIES,
    PDF_ANNOTATION_PARSE_MAX_LINE_BYTES,
} from '@contracts/pdfAnnotationParseTypes';
import {normalizePdfNativeMutationSet} from '@contracts/nativePdfMutations';
import {requirePageIndex} from '@contracts/pageNumbers';
import {readPdfCatalogWithPdfjs} from '@tests/e2e/electron/helpers/fixtures';
import {decodePdfPageSizeRecord} from '@evb/scan-cleanup/core/policy/scanCleanupRasterPolicy';

const NativeWebAssembly = WebAssembly;

interface IPdfPageSummary {
    mediaBox: IPageGeometry['mediaBox'];
    cropBox: IPageGeometry['cropBox'];
    rotation: number;
}

function toArrayBuffer(data: Uint8Array): ArrayBuffer {
    const copy = new ArrayBuffer(data.byteLength);
    new Uint8Array(copy).set(data);
    return copy;
}

function assertSuccessfulWasmMutation(
    result: IPageMutationWorkerResult | IBrowserPageOpsWasmFailure | null,
): asserts result is IPageMutationWorkerResult {
    if (result === null || 'status' in result) {
        throw new Error('Expected successful browser page-ops WASM mutation');
    }
}

async function createPdf(options: {
    pageWidths: number[];
    cropSecondPage?: boolean;
    rotateSecondPage?: boolean;
}) {
    const pdfDocument = await PDFDocument.create();
    for (const [
        index,
        width,
    ] of options.pageWidths.entries()) {
        const page = pdfDocument.addPage([
            width,
            100 + (index * 20),
        ]);
        if (index === 1 && options.cropSecondPage) {
            page.setCropBox(10, 12, width - 30, 80);
        }
        if (index === 1 && options.rotateSecondPage) {
            page.setRotation(degrees(90));
        }
    }

    return new Uint8Array(await pdfDocument.save());
}

async function createMetadataPdf() {
    const pdfDocument = await PDFDocument.create();
    const pages = [
        pdfDocument.addPage([
            200,
            100,
        ]),
        pdfDocument.addPage([
            300,
            100,
        ]),
        pdfDocument.addPage([
            400,
            100,
        ]),
    ];
    const {context} = pdfDocument;
    const decimalLabels = context.register(context.obj({
        S: PDFName.of('D'),
        St: PDFNumber.of(1),
    }));
    const romanLabels = context.register(context.obj({
        S: PDFName.of('R'),
        St: PDFNumber.of(1),
    }));
    const pageLabels = context.register(context.obj({Nums: [
        0,
        decimalLabels,
        1,
        romanLabels,
    ]}));
    const outlineItem = context.register(context.obj({
        Title: PDFString.of('Page three'),
        Dest: [
            pages[2]!.ref,
            PDFName.of('Fit'),
        ],
    }));
    const outlines = context.register(context.obj({
        Type: PDFName.of('Outlines'),
        First: outlineItem,
        Last: outlineItem,
        Count: PDFNumber.of(1),
    }));
    (context.lookup(outlineItem) as PDFDict).set(PDFName.of('Parent'), outlines);
    pdfDocument.catalog.set(PDFName.of('PageLabels'), pageLabels);
    pdfDocument.catalog.set(PDFName.of('Outlines'), outlines);
    return new Uint8Array(await pdfDocument.save());
}

async function readPasswordProtectedPdf() {
    const encoded = await readFile(
        join(process.cwd(), 'tests/fixtures/electron/password-protected.pdf.b64'),
        'utf8',
    );
    return Uint8Array.from(Buffer.from(encoded.trim(), 'base64'));
}

function readOutlineDestination(pdfDocument: PDFDocument) {
    const outlines = pdfDocument.context.lookup(
        pdfDocument.catalog.get(PDFName.of('Outlines')) as PDFRef,
    ) as PDFDict;
    const first = pdfDocument.context.lookup(outlines.get(PDFName.of('First'))) as PDFDict;
    return (first.get(PDFName.of('Dest')) as PDFArray).get(0) as PDFRef;
}

/** A three-page PDF whose top-level outline items are the given dictionaries. */
async function createOutlinePdf(describeItems: (pdfDocument: PDFDocument, pages: PDFRef[]) => Array<Record<string, unknown>>) {
    const pdfDocument = await PDFDocument.create();
    const pages = [
        0,
        1,
        2,
    ].map(() => pdfDocument.addPage([
        200,
        200,
    ]).ref);
    const definitions = describeItems(pdfDocument, pages);
    const outlines = pdfDocument.context.nextRef();
    const items = definitions.map(() => pdfDocument.context.nextRef());
    definitions.forEach((definition, index) => pdfDocument.context.assign(items[index]!, pdfDocument.context.obj({
        ...definition,
        Parent: outlines,
        ...(index > 0 ? {Prev: items[index - 1]} : {}),
        ...(index + 1 < items.length ? {Next: items[index + 1]} : {}),
    })));
    pdfDocument.context.assign(outlines, pdfDocument.context.obj({
        Type: PDFName.of('Outlines'),
        First: items[0],
        Last: items.at(-1),
        Count: items.length,
    }));
    pdfDocument.catalog.set(PDFName.of('Outlines'), outlines);
    return pdfDocument.save();
}

/** Each top-level outline item's title, /Dest and /A as written, with the action's file specification resolved. */
async function readOutlineTargets(data: Uint8Array) {
    const pdfDocument = await PDFDocument.load(data);
    let item = pdfDocument.catalog.lookup(PDFName.of('Outlines'), PDFDict).lookupMaybe(PDFName.of('First'), PDFDict);
    const targets = [];
    while (item) {
        const action = item.lookupMaybe(PDFName.of('A'), PDFDict);
        targets.push({
            title: item.lookup(PDFName.of('Title'), PDFString, PDFHexString).decodeText(),
            dest: item.get(PDFName.of('Dest'))?.toString() ?? null,
            action: action && {
                kind: action.get(PDFName.of('S'))?.toString(),
                file: action.lookup(PDFName.of('F'))?.toString(),
                destination: action.get(PDFName.of('D'))?.toString(),
            },
        });
        item = item.lookupMaybe(PDFName.of('Next'), PDFDict);
    }
    return targets;
}

/** Reads the outline as the browser does, renames its first item and saves it. */
async function renameFirstBookmarkAndSave(data: Uint8Array) {
    const wasm = await loadWasmRunner();
    const catalog = await wasm.run('readCatalog', {source: new Blob([data.slice()])});
    if (catalog === null || 'status' in catalog || !catalog.bookmarks) {
        throw new Error('Expected the browser page-ops catalog to read the outline');
    }
    const [
        first,
        ...rest
    ] = v.parse(v.array(PDF_BOOKMARK_RECOVERY_ENTRY_SCHEMA), catalog.bookmarks);
    const saved = await wasm.append(data, {
        mutations: {bookmarks: {
            totalPages: 3,
            untitledLabel: 'Untitled',
            items: [
                {
                    ...first!,
                    title: `${first!.title} renamed`,
                },
                ...rest,
            ],
        }},
        modifiedAt: 'D:20261012000000Z',
    });
    if ('status' in saved) throw new Error(`Expected the bookmarks to save: ${saved.error.message}`);
    return saved.data;
}

async function summarizePdf(data: Uint8Array): Promise<IPdfPageSummary[]> {
    const pdfDocument = await PDFDocument.load(data);
    return pdfDocument.getPages().map((page) => {
        const mediaBox = page.getMediaBox();
        const cropBox = page.getCropBox();
        const sameAsMedia = ([
            'x',
            'y',
            'width',
            'height',
        ] as const)
            .every(key => cropBox[key] === mediaBox[key]);
        return {
            mediaBox,
            cropBox: sameAsMedia ? null : cropBox,
            rotation: page.getRotation().angle,
        };
    });
}

async function stubSuccessfulWasmFetch() {
    vi.stubGlobal('location', {href: 'https://viewer.test/workspace'});
    vi.stubGlobal('WebAssembly', NativeWebAssembly);
    const wasmBytes = await readFile(join(process.cwd(), 'public/wasm/evb-pdf-page-ops.wasm'));
    const fetchMock = vi.fn(async () => new Response(toArrayBuffer(wasmBytes)));
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
}

function createFailingPageOpsWasmExports(errorText: string) {
    const memory = new NativeWebAssembly.Memory({initial: 1});
    const error = new TextEncoder().encode(errorText);
    const errorPointer = 2048;
    let liveAllocation: {
        pointer: number;
        byteLength: number;
    } | null = null;
    let nextAllocationPointer = 1024;
    const alloc = vi.fn((byteLength: number) => {
        if (liveAllocation !== null) {
            return 0;
        }
        const pointer = nextAllocationPointer;
        nextAllocationPointer = 1024;
        liveAllocation = {
            pointer,
            byteLength,
        };
        return pointer;
    });
    const free = vi.fn((pointer: number, byteLength: number) => {
        if (liveAllocation?.pointer === pointer && liveAllocation.byteLength === byteLength) {
            liveAllocation = null;
        }
    });
    const run = vi.fn((_pointer: number, _length: number) => {
        new Uint8Array(memory.buffer, errorPointer, error.byteLength).set(error);
        return -7;
    });

    return {
        exports: {
            memory,
            evb_wasm_request_allocation_abi_version: vi.fn(() => 1),
            evb_pdf_page_ops_alloc: alloc,
            evb_pdf_page_ops_free: free,
            evb_pdf_page_ops_run: run,
            evb_pdf_page_ops_output_ptr: vi.fn(() => 0),
            evb_pdf_page_ops_output_len: vi.fn(() => 0),
            evb_pdf_page_ops_error_ptr: vi.fn(() => errorPointer),
            evb_pdf_page_ops_error_len: vi.fn(() => error.byteLength),
        },
        alloc,
        free,
        run,
        setNextAllocationPointer(pointer: number) {
            nextAllocationPointer = pointer;
        },
    };
}

/** The engine's file imports over PDFs held in memory: each document is a source, the output a growing buffer. */
async function runPageStructureInMemory(
    module: typeof import('@app/platform/browser/pdfPageEngine'),
    edit: TPageStructureEdit,
    documents: Uint8Array[],
) {
    let output = new Uint8Array(1024);
    const slice = (bytes: Uint8Array, at: number, length: number) => {
        if (at + length > bytes.byteLength) throw new Error('Read past the end');
        return bytes.subarray(at, at + length);
    };
    const sink = {
        write(bytes: Uint8Array, at: number) {
            if (at + bytes.byteLength > output.byteLength) {
                const grown = new Uint8Array(Math.max(at + bytes.byteLength, output.byteLength * 2));
                grown.set(output);
                output = grown;
            }
            output.set(bytes, at);
        },
        read: (into: Uint8Array, at: number) => into.set(slice(output, at, into.byteLength)),
    };
    const result = await module.runPageStructureEdit(edit, {
        sources: documents.map(document => ({
            size: document.byteLength,
            read: (into, at) => into.set(slice(document, at, into.byteLength)),
        })),
        sink,
        async copy(copies) {
            for (const {source, from, length, at} of copies) sink.write(slice(documents[source]!, from, length), at);
        },
    });
    return isBrowserPageOpsWasmFailure(result) ? result : {
        data: output.slice(0, result.length),
        pageCount: result.pageCount,
    };
}

async function loadWasmRunner() {
    vi.resetModules();
    vi.unstubAllGlobals();
    const fetchMock = await stubSuccessfulWasmFetch();
    const module = await import('@app/platform/browser-api/tryRunBrowserPageOpsWithWasm');
    const engine = await import('@app/platform/browser/pdfPageEngine');
    return {
        fetchMock,
        run: module.tryRunBrowserPageOpsWithWasm,
        append: engine.appendPdfMutationsToBytes,
        structure: (edit: TPageStructureEdit, documents: Uint8Array[]) => runPageStructureInMemory(engine, edit, documents),
    };
}

async function loadCoreWithWasm() {
    vi.resetModules();
    vi.unstubAllGlobals();
    const fetchMock = await stubSuccessfulWasmFetch();
    const core = await import('@app/platform/browser-api/browserPageOpsCore');
    return {
        ...core,
        fetchMock,
    };
}

describe('browser page-ops WASM fast path', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    it.each([
        'rotate',
        'crop',
        'removeCrop',
    ] as const)('preserves the signed historical revision for browser %s', async operation => {
        const data = new Uint8Array(await readFile(join(process.cwd(), 'tests/fixtures/electron/pdf-preservation/signed.pdf')));
        const wasm = await loadWasmRunner();
        const result = operation === 'rotate'
            ? await wasm.run('rotate', {
                data,
                pages: [1],
                angle: 90,
            })
            : operation === 'crop'
                ? await wasm.run('crop', {
                    data,
                    pages: [1],
                    margins: {
                        top: 4,
                        bottom: 6,
                        left: 8,
                        right: 10,
                    },
                })
                : await wasm.run('removeCrop', {
                    data,
                    pages: [1],
                });
        assertSuccessfulWasmMutation(result);
        expect(result.data.subarray(0, data.length)).toEqual(data);
        const original = await PDFDocument.load(data);
        const saved = await PDFDocument.load(result.data);
        const signatures = (pdf: PDFDocument) => pdf.context.enumerateIndirectObjects().flatMap(([
            , object,
        ]) => {
            if (!(object instanceof PDFDict) || !object.has(PDFName.of('ByteRange'))) return [];
            return [[
                String(object.get(PDFName.of('ByteRange'))),
                String(object.get(PDFName.of('Contents'))),
            ]];
        });
        expect(signatures(saved)).toEqual(signatures(original));
        expect(signatures(saved)).toHaveLength(1);
        if (operation === 'rotate') expect(saved.getPage(0).getRotation().angle).toBe(90);
        if (operation === 'crop') expect(saved.getPage(0).getCropBox()).toEqual({
            x: 8,
            y: 6,
            width: 102,
            height: 110,
        });
    });

    it.each([
        'deletePages',
        'extractPages',
    ] as const)('removes discarded form values from saved %s bytes', async operation => {
        const data = new Uint8Array(await readFile(join(process.cwd(), 'tests/fixtures/electron/pdf-preservation/forms.pdf')));
        const wasm = await loadWasmRunner();
        const result = operation === 'deletePages'
            ? await wasm.structure({kind: 'delete', pages: [2]}, [data])
            : await wasm.structure({kind: 'extract', pages: [1]}, [data]);
        assertSuccessfulWasmMutation(result);
        const output = await PDFDocument.load(result.data);
        expect(output.getPageCount()).toBe(1);
        expect(output.getForm().getFields().map(field => field.getName())).toEqual(['retained']);
        expect(output.getForm().getTextField('retained').getText()).toBe('VISIBLE');
        const strings: string[] = [];
        const visit = (object: unknown): void => {
            if (object instanceof PDFString || object instanceof PDFHexString) strings.push(object.decodeText());
            else if (object instanceof PDFDict) object.values().forEach(visit);
            else if (object instanceof PDFArray) object.asArray().forEach(visit);
            else if (object instanceof PDFRawStream) visit(object.dict);
        };
        output.context.enumerateIndirectObjects().forEach(([
            , object,
        ]) => visit(object));
        expect(strings).not.toContain('REMOVED-SECRET');
        expect(strings).not.toContain('removed');
    });

    it('keeps shared field values and reciprocal widget membership after subset and reorder saves', async () => {
        const data = new Uint8Array(await readFile(join(process.cwd(), 'tests/fixtures/electron/pdf-preservation/shared-field.pdf')));
        const original = await PDFDocument.load(data);
        const [originalField] = original.getForm().getFields();
        if (!originalField) throw new Error('Shared field fixture is empty');
        const name = originalField.getName();
        const value = original.getForm().getTextField(name).getText();
        const wasm = await loadWasmRunner();
        for (const operation of [
            'extractPages',
            'deletePages',
            'reorderPages',
        ] as const) {
            const result = operation === 'reorderPages'
                ? await wasm.structure({kind: 'reorder', pages: [2, 1]}, [data])
                : await wasm.structure({kind: operation === 'extractPages' ? 'extract' : 'delete', pages: [operation === 'extractPages' ? 1 : 2]}, [data]);
            assertSuccessfulWasmMutation(result);
            const saved = await PDFDocument.load(result.data);
            const fields = saved.getForm().getFields();
            expect(fields.map(field => field.getName())).toEqual([name]);
            expect(saved.getForm().getTextField(name).getText()).toBe(value);
            const field = fields[0]!;
            const kids = field.acroField.dict.lookup(PDFName.of('Kids'), PDFArray).asArray();
            expect(kids).toHaveLength(operation === 'reorderPages' ? 2 : 1);
            kids.forEach((kid, index) => {
                const widget = saved.context.lookup(kid, PDFDict);
                const page = saved.getPage(operation === 'reorderPages' ? 1 - index : 0);
                expect(String(widget.get(PDFName.of('Parent')))).toBe(String(field.ref));
                expect(String(widget.get(PDFName.of('P')))).toBe(String(page.ref));
                expect(page.node.Annots()?.asArray().map(String)).toContain(String(kid));
            });
        }
    });

    it.each([
        'StructTreeRoot',
        'OCProperties',
    ])('combines PDFs with %s in either source position', async key => {
        const source = await PDFDocument.load(await readFile(join(process.cwd(), 'tests/fixtures/electron/pdf-preservation/layers-and-tags.pdf')));
        source.catalog.delete(PDFName.of(key === 'StructTreeRoot' ? 'OCProperties' : 'StructTreeRoot'));
        const feature = new Uint8Array(await source.save());
        const ordinary = await createPdf({pageWidths: [200]});
        const wasm = await loadWasmRunner();
        for (const documents of [
            [
                feature,
                ordinary,
            ],
            [
                ordinary,
                feature,
            ],
        ]) {
            const result = await wasm.structure({kind: 'merge'}, documents);
            expect(result).toMatchObject({pageCount: 2});
            assertSuccessfulWasmMutation(result);
            expect((await PDFDocument.load(result.data)).getPageCount()).toBe(2);
        }
    });

    it('preserves tagged page subsets and accepts insertion from either source', async () => {
        const data = new Uint8Array(await readFile(join(process.cwd(), 'tests/fixtures/electron/pdf-preservation/tagged.pdf')));
        const ordinary = await createPdf({pageWidths: [200]});
        const wasm = await loadWasmRunner();
        const results = [
            await wasm.structure({kind: 'delete', pages: [2]}, [data]),
            await wasm.structure({kind: 'extract', pages: [1]}, [data]),
            await wasm.structure({kind: 'reorder', pages: [
                    2,
                    1,
                ]}, [data]),
            await wasm.structure({kind: 'insert', afterPage: 1}, [data, ordinary]),
            await wasm.structure({kind: 'insert', afterPage: 1}, [ordinary, data]),
            await wasm.structure({kind: 'insert', afterPage: 1}, [data, data]),
        ];
        for (const [
            index,
            result,
        ] of results.entries()) {
            const count = [
                1,
                1,
                2,
                3,
                3,
                4,
            ][index];
            expect(result).toMatchObject({pageCount: count});
            assertSuccessfulWasmMutation(result);
            expect((await PDFDocument.load(result.data)).getPageCount()).toBe(count);
        }
    });

    it('judges only the live append-admission allocation with its matching pointer and length', async () => {
        const bytes = await createPdf({pageWidths: [200]});
        const module = await NativeWebAssembly.compile(await readFile(join(process.cwd(), 'public/wasm/evb-pdf-page-ops.wasm')));
        const {exports} = await NativeWebAssembly.instantiate(module, {evb_host: Object.fromEntries(NativeWebAssembly.Module.imports(module).map(({name}) => [name, () => -1]))});
        const memory = exports.memory;
        const alloc = exports.evb_pdf_page_ops_alloc;
        const free = exports.evb_pdf_page_ops_free;
        const admit = exports.evb_pdf_page_ops_append_admission;
        if (!(memory instanceof NativeWebAssembly.Memory) || typeof alloc !== 'function'
            || typeof free !== 'function' || typeof admit !== 'function') {
            throw new Error('Missing append-admission WASM exports');
        }
        const pointer = Number(alloc(bytes.byteLength));
        try {
            new Uint8Array(memory.buffer, pointer, bytes.byteLength).set(bytes);
            expect(admit(pointer, bytes.byteLength - 1)).toBe(-1);
            expect(admit(pointer + 1, bytes.byteLength)).toBe(-1);
            expect(admit(pointer, bytes.byteLength)).toBe(0);
        } finally {
            free(pointer, bytes.byteLength);
        }
    });

    it('returns a reopenable source-free text appearance and its native fit', async () => {
        const {run} = await loadWasmRunner();
        const result = await run('textBoxAppearance', {
            page: {
                view: [
                    0,
                    0,
                    200,
                    100,
                ],
                rotation: 0,
                userUnit: 1,
            },
            textBoxes: [{
                textBox: {
                    pageIndex: requirePageIndex(0),
                    stableKey: 'browser-appearance',
                    text: 'Browser café',
                    rect: [
                        10,
                        10,
                        90,
                        40,
                    ],
                    rotation: 0,
                    fontSize: 18,
                    color: [
                        17,
                        24,
                        39,
                    ],
                },
                source: {
                    version: 1,
                    rawRD: [
                        1,
                        2,
                        7,
                        12,
                    ],
                    borderWidth: 0,
                    staleFill: false,
                },
            }],
        });
        if (!result || 'status' in result) throw new Error(`Expected source-free appearance: ${JSON.stringify(result)}`);
        expect(result.textBoxes).toHaveLength(1);
        expect(result.textBoxes[0]).toMatchObject({stableKey: 'browser-appearance'});
        expect(result.textBoxes[0]!.fittedFontSize).toBeGreaterThan(0);
        const pdf = await PDFDocument.load(result.data);
        const annotation = pdf.getPage(0).node.Annots()!.lookup(0, PDFDict);
        expect(annotation.lookup(PDFName.of('Contents'), PDFString, PDFHexString).decodeText()).toBe('Browser café');
        expect(annotation.lookup(PDFName.of('AP'), PDFDict).lookup(PDFName.of('N'))).toBeInstanceOf(PDFRawStream);
    });

    it('restores the original appearance from separate source bytes after an intervening save', async () => {
        const original = await PDFDocument.create();
        const page = original.addPage([
            200,
            100,
        ]);
        const font = original.context.register(original.context.obj({
            Type: 'Font',
            Subtype: 'Type1',
            BaseFont: 'Times-Italic',
        }));
        const appearance = original.context.register(original.context.flateStream('BT /F1 12 Tf 0 0 0 rg 2 10 Td (Original) Tj ET', {
            Type: 'XObject',
            Subtype: 'Form',
            BBox: [
                0,
                0,
                120,
                30,
            ],
            Resources: {Font: {F1: font}},
        }));
        const annotation = original.context.register(original.context.obj({
            Type: 'Annot',
            Subtype: 'FreeText',
            Rect: [
                10,
                40,
                130,
                70,
            ],
            NM: PDFString.of('original-box'),
            Contents: PDFString.of('Original'),
            DA: PDFString.of('/F1 12 Tf 0 0 0 rg'),
            AP: {N: appearance},
            F: 4,
        }));
        page.node.set(PDFName.of('Annots'), original.context.obj([annotation]));
        const source = new Uint8Array(await original.save());
        const mutation = {
            stableKey: 'original-box',
            annotationId: annotation.toString(),
            pageIndex: 0,
            text: 'Changed',
            rect: [
                10,
                40,
                130,
                70,
            ],
            rotation: 0,
            fontSize: 12,
            color: [
                0,
                0,
                0,
            ],
        };
        const wasm = await loadWasmRunner();
        const edited = await wasm.append(source, {
            mutations: normalizePdfNativeMutationSet({textBoxes: [mutation]}, 'Browser appearance edit'),
            modifiedAt: 'D:20261016000000Z',
        });
        if ('status' in edited) throw new Error('Expected the text edit to save');
        const restore = normalizePdfNativeMutationSet({
            originalAppearanceSource: 'browser://documents/original-appearance',
            textBoxes: [{
                ...mutation,
                text: 'Original',
                originalAppearance: {sourceAnnotationId: annotation.toString()},
            }],
        }, 'Browser original appearance restore');
        // The original appearance is read by range from its own document.
        const restored = await wasm.append(edited.data, {
            mutations: restore,
            modifiedAt: 'D:20261016000001Z',
            appearanceSource: new Blob([source]),
        });
        if ('status' in restored) throw new Error(`Expected the original appearance to restore: ${JSON.stringify(restored)}`);
        const restoredDocument = await PDFDocument.load(restored.data);
        const restoredAnnotation = restoredDocument.getPage(0).node.lookup(PDFName.of('Annots'), PDFArray).lookup(0, PDFDict);
        const restoredAppearance = restoredDocument.context.lookup(restoredAnnotation.lookup(PDFName.of('AP'), PDFDict).get(PDFName.of('N')));
        const originalAppearance = original.context.lookup(appearance);
        if (!(restoredAppearance instanceof PDFRawStream) || !(originalAppearance instanceof PDFRawStream)) throw new Error('Expected saved appearance streams');
        expect(restoredAppearance.contents).toEqual(originalAppearance.contents);
        expect(restoredAnnotation.lookup(PDFName.of('Contents'), PDFString, PDFHexString).decodeText()).toBe('Original');
        const restoredFont = restoredAppearance.dict.lookup(PDFName.of('Resources'), PDFDict).lookup(PDFName.of('Font'), PDFDict).lookup(PDFName.of('F1'), PDFDict);
        expect(restoredFont.get(PDFName.of('BaseFont'))).toBe(PDFName.of('Times-Italic'));
    });

    it.each([
        false,
        true,
    ])('publishes a complete bounded note save, or no bytes when a continuation fails: %s', async (failContinuation) => {
        const input = await createPdf({pageWidths: [200]});
        const original = input.slice();
        const mutations = normalizePdfNativeMutationSet({freeTextNotes: Array.from({length: 257}, (_, index) => ({
            stableKey: `new-browser-note-${index}`,
            pageIndex: failContinuation && index === 256 ? 1 : 0,
            text: `Note ${index}`,
            markerRect: {
                left: 0.1,
                top: 0.1,
                width: 0.1,
                height: 0.1,
            },
        }))}, 'Browser continuation notes');
        const wasm = await loadWasmRunner();
        const result = await wasm.append(input, {
            mutations,
            modifiedAt: 'D:20261013000000Z',
        });
        expect(input).toEqual(original);
        if (failContinuation) {
            expect(result).toMatchObject({status: 'failed'});
            expect(result).not.toHaveProperty('data');
            return;
        }
        if ('status' in result) throw new Error('Expected all note continuations to save');
        expect(result.identityBindings.map(binding => binding.annotationId).sort())
            .toEqual(mutations.freeTextNotes!.map(note => note.stableKey).sort());
        const reopened = await PDFDocument.load(result.data);
        const annotations = reopened.getPage(0).node.lookup(PDFName.of('Annots'), PDFArray);
        const texts = Array.from({length: annotations.size()}, (_, index) => annotations.lookup(index, PDFDict))
            .filter(annotation => annotation.get(PDFName.of('Subtype')) === PDFName.of('Text'))
            .map(annotation => annotation.lookup(PDFName.of('Contents'), PDFString, PDFHexString).decodeText());
        expect(texts.sort()).toEqual(mutations.freeTextNotes!.map(note => note.text).sort());
    });

    it('keeps one exact live request allocation across repeated awkward lengths', async () => {
        const wasmBytes = await readFile(join(process.cwd(), 'public/wasm/evb-pdf-page-ops.wasm'));
        const module = new NativeWebAssembly.Module(toArrayBuffer(wasmBytes));
        const instance = await NativeWebAssembly.instantiate(module, {evb_host: Object.fromEntries(NativeWebAssembly.Module.imports(module).map(({name}) => [name, () => -1]))});
        const memory = instance.exports.memory;
        const allocationAbiVersion = instance.exports.evb_wasm_request_allocation_abi_version;
        const alloc = instance.exports.evb_pdf_page_ops_alloc;
        const free = instance.exports.evb_pdf_page_ops_free;
        if (
            !(memory instanceof NativeWebAssembly.Memory)
            || typeof allocationAbiVersion !== 'function'
            || typeof alloc !== 'function'
            || typeof free !== 'function'
        ) {
            throw new Error('Page operation WASM allocation exports are missing');
        }
        expect(allocationAbiVersion()).toBe(1);

        for (const length of [
            1,
            3,
            17,
            257,
            1021,
            4093,
        ]) {
            const pointer = alloc(length);
            expect(pointer).not.toBe(0);
            expect(alloc(1)).toBe(0);
            new Uint8Array(memory.buffer, pointer >>> 0, length).fill(0xa5);
            free(pointer, length);
        }
    });

    it('inspects every page, or the requested ones, as desktop scan cleanup reads its page geometry', async () => {
        const wasm = await loadWasmRunner();
        const data = await createPdf({
            pageWidths: [
                200,
                300,
            ],
            cropSecondPage: true,
            rotateSecondPage: true,
        });

        const inspected = await wasm.run('inspectScanCleanupPdf', {
            data,
            pages: [],
        });
        if (inspected === null || 'status' in inspected) throw new Error('inspection failed');
        expect(inspected.pageCount).toBe(2);
        const pages = inspected.pages.map(page => decodePdfPageSizeRecord(page, inspected.pageCount, 'page'));
        expect(pages[0]).toMatchObject({
            pageNumber: 1,
            widthPoints: 200,
            heightPoints: 100,
            rotation: 0,
        });
        // The second page's view is its CropBox inside the MediaBox it keeps.
        expect(pages[1]).toMatchObject({
            pageNumber: 2,
            xPoints: 10,
            yPoints: 12,
            widthPoints: 270,
            heightPoints: 80,
            rotation: 90,
            mediaWidthPoints: 300,
            mediaHeightPoints: 120,
        });

        const selected = await wasm.run('inspectScanCleanupPdf', {
            data,
            pages: [2],
        });
        if (selected === null || 'status' in selected) throw new Error('inspection failed');
        expect(selected.pages.map(page => decodePdfPageSizeRecord(page, selected.pageCount, 'page'))).toEqual([pages[1]]);
    });

    it('inspects past a form it cannot read, marking only that page\'s raster inventory incomplete', async () => {
        const wasm = await loadWasmRunner();
        const pdfDocument = await PDFDocument.create();
        const unreadable = pdfDocument.addPage([
            100,
            100,
        ]);
        pdfDocument.addPage([
            100,
            100,
        ]);
        // A form whose content declares an inline image of zero width, which
        // the content reader refuses to parse; pdfimages skips such a form.
        const form = pdfDocument.context.register(pdfDocument.context.stream('BI /W 0 /H 2 /BPC 8 /CS /G ID \x00\x00 EI', {
            Type: 'XObject',
            Subtype: 'Form',
            BBox: [
                0,
                0,
                1,
                1,
            ],
        }));
        unreadable.pushOperators(drawObject(unreadable.node.newXObject('F', form)));
        const data = await pdfDocument.save({useObjectStreams: false});

        const inspected = await wasm.run('inspectScanCleanupPdf', {
            data,
            pages: [],
        });
        if (inspected === null || 'status' in inspected) throw new Error('inspection failed');
        expect(inspected.pages.map(page => Reflect.get(page, 'rasterInventoryComplete'))).toEqual([
            false,
            true,
        ]);
    });

    it.each([
        [
            'rotation-90',
            {
                dpi: 72,
                renderBox: 'cropBox',
            },
        ],
        [
            'crop-region',
            {
                dpi: 72,
                renderBox: 'cropBox',
                slice: {
                    x: 2,
                    y: 1,
                    width: 3,
                    height: 2,
                },
            },
        ],
        [
            'softmask-over-background',
            {
                dpi: 72,
                renderBox: 'cropBox',
            },
        ],
        // JPEG samples come from the libjpeg-turbo the engine links, as Poppler's.
        [
            'jpeg-gray',
            {
                dpi: 72,
                renderBox: 'cropBox',
            },
        ],
        [
            'jpeg-rgb',
            {
                dpi: 72,
                renderBox: 'cropBox',
            },
        ],
    ] as const)('rasterizes the %s scan page with the RGB bytes pdftoppm wrote for it', async (vector, request) => {
        const fixture = join(process.cwd(), 'native/scan-cleanup/tests/fixtures/source-raster', vector);
        const expected = new Uint8Array(await readFile(join(fixture, 'expected.ppm')));
        const header = /^P6\s+(\d+)\s+(\d+)\s+255\s/u.exec(new TextDecoder().decode(expected.subarray(0, 32)))!;
        const wasm = await loadWasmRunner();

        const rendered = await wasm.run('renderScanCleanupRaster', {
            data: new Uint8Array(await readFile(join(fixture, 'input.pdf'))),
            request: {
                pageNumber: 1,
                maxPixels: 1_000_000,
                ...request,
            },
        });

        if (rendered === null || 'status' in rendered) throw new Error('raster failed');
        expect(rendered.report).toEqual({
            width: Number(header[1]),
            height: Number(header[2]),
            compatibility: 'exact',
        });
        expect(rendered.data).toEqual(expected.subarray(header[0].length));
    });

    // JPEG 2000 pages and the RGB bytes bundled Poppler 26.02.0 `pdftoppm
    // -cropbox -hide-annotations -r 96` wrote for them: lossy 9/7 gray and RGB
    // (with the color transform), 16-bit, 1-bit, signed, alpha and sYCC
    // components. The engine decodes JPX with OpenJPEG, as Poppler does.
    it.each([
        'gray',
        'rgb',
        'gray16',
        'rgb16',
        'gray1',
        'gray-signed',
        'gray-alpha',
        'rgb-alpha',
        'sycc444',
    ] as const)('rasterizes a %s JPEG 2000 scan page with the RGB bytes pdftoppm wrote for it', async (name) => {
        const fixture = join(process.cwd(), 'native/pdf-page-ops/tests/fixtures/scan-raster-jpx');
        const expected = new Uint8Array(await readFile(join(fixture, `${name}-expected.ppm`)));
        const header = /^P6\s+(\d+)\s+(\d+)\s+255\s/u.exec(new TextDecoder().decode(expected.subarray(0, 32)))!;
        const wasm = await loadWasmRunner();

        const rendered = await wasm.run('renderScanCleanupRaster', {
            data: new Uint8Array(await readFile(join(fixture, `${name}.pdf`))),
            request: {
                pageNumber: 1,
                dpi: 96,
                renderBox: 'cropBox',
                maxPixels: 1_000_000,
            },
        });

        if (rendered === null || 'status' in rendered) throw new Error('raster failed');
        expect(rendered.report).toEqual({
            width: Number(header[1]),
            height: Number(header[2]),
            compatibility: 'exact',
        });
        expect(rendered.data).toEqual(expected.subarray(header[0].length));
    });

    it('keeps an RGB JPEG near when its PDF overrides the stream\'s color transform', async () => {
        const fixture = join(process.cwd(), 'native/scan-cleanup/tests/fixtures/source-raster/jpeg-rgb');
        const pdfDocument = await PDFDocument.load(await readFile(join(fixture, 'input.pdf')));
        for (const [
            ,
            object,
        ] of pdfDocument.context.enumerateIndirectObjects()) {
            if (object instanceof PDFRawStream && object.dict.get(PDFName.of('Subtype')) === PDFName.of('Image')) {
                object.dict.set(PDFName.of('DecodeParms'), pdfDocument.context.obj({ColorTransform: 1}));
            }
        }
        const wasm = await loadWasmRunner();

        const rendered = await wasm.run('renderScanCleanupRaster', {
            data: new Uint8Array(await pdfDocument.save()),
            request: {
                pageNumber: 1,
                dpi: 72,
                renderBox: 'cropBox',
                maxPixels: 1_000_000,
            },
        });

        if (rendered === null || 'status' in rendered) throw new Error('raster failed');
        expect(rendered.report).toMatchObject({compatibility: 'near'});
    });

    it('fails a scan raster whose JPEG libjpeg rejects, and paints the next page with a fresh engine', async () => {
        const fixture = join(process.cwd(), 'native/scan-cleanup/tests/fixtures/source-raster/jpeg-gray');
        const valid = new Uint8Array(await readFile(join(fixture, 'input.pdf')));
        // The same page with its JPEG's start-of-image marker broken.
        const broken = valid.slice();
        const start = Buffer.from(broken).indexOf(Buffer.from([
            0xff,
            0xd8,
            0xff,
        ]));
        expect(start).toBeGreaterThan(0);
        broken[start + 1] = 0x00;
        const wasm = await loadWasmRunner();
        const request = {
            pageNumber: 1,
            dpi: 72,
            renderBox: 'cropBox',
            maxPixels: 1_000_000,
        } as const;

        const failed = await wasm.run('renderScanCleanupRaster', {
            data: broken,
            request,
        });
        const rendered = await wasm.run('renderScanCleanupRaster', {
            data: valid,
            request,
        });

        // libjpeg's fatal error traps; the bridge reports a trap as the engine
        // running out and loads a fresh one.
        expect(failed).toMatchObject({
            status: 'failed',
            error: {code: 'too-large'},
        });
        if (rendered === null || 'status' in rendered) throw new Error('raster failed');
        expect(rendered.report).toMatchObject({compatibility: 'exact'});
    });

    it('reports a page with vector content unsupported, for PDF.js to paint', async () => {
        const pdfDocument = await PDFDocument.create();
        pdfDocument.addPage([
            200,
            100,
        ]).drawRectangle({
            x: 10,
            y: 10,
            width: 50,
            height: 20,
        });
        const wasm = await loadWasmRunner();
        const rendered = await wasm.run('renderScanCleanupRaster', {
            data: new Uint8Array(await pdfDocument.save()),
            request: {
                pageNumber: 1,
                dpi: 72,
                renderBox: 'cropBox',
                maxPixels: 1_000_000,
            },
        });

        if (rendered === null || 'status' in rendered) throw new Error('raster failed');
        expect(rendered.report).toHaveProperty('unsupported');
        expect(rendered.data.byteLength).toBe(0);
    });

    it('decrypts an encrypted PDF through WASM operation 9 with the correct password', async () => {
        const encryptedPdf = await readPasswordProtectedPdf();
        const wasm = await loadWasmRunner();

        const result = await wasm.run('decrypt', {
            data: encryptedPdf,
            password: 'frame-secret',
        });

        assertSuccessfulWasmMutation(result);
        expect(result.data).not.toEqual(encryptedPdf);
        expect(result.pageCount).toBe(1);
        const opened = await PDFDocument.load(result.data);
        expect(opened.getPageCount()).toBe(1);
        expect(wasm.fetchMock).toHaveBeenCalledOnce();
    });

    it('reports a typed password failure through WASM operation 9', async () => {
        const encryptedPdf = await readPasswordProtectedPdf();
        const wasm = await loadWasmRunner();

        const result = await wasm.run('decrypt', {
            data: encryptedPdf,
            password: 'wrong-password',
        });

        expect(result).toMatchObject({
            status: 'failed',
            error: {code: 'needs-password'},
        });
    });

    it('parses reachable FreeText and Popup entries through the writer WASM operation', async () => {
        const data = new Uint8Array(await readFile(join(
            process.cwd(),
            'tests/fixtures/electron/freetext-lifecycle-test.pdf',
        )));
        const wasm = await loadWasmRunner();
        const result = await wasm.run('parseAnnotations', {source: new Blob([data])});
        expect(result).not.toBeNull();
        if (result === null || 'status' in result) {
            throw new Error('Expected annotation parse WASM output');
        }

        const parsed = decodeBrowserPdfAnnotationsOutput(result.data);
        expect(parsed.pageCount).toBe(1);
        expect(parsed.entities.map(entity => entity.kind)).toEqual([
            'note',
            'text-box',
            'text-box',
        ]);
        expect(parsed.entities.map(entity => entity.name)).toEqual([
            'lifecycle-note',
            'lifecycle-text-box-one',
            'lifecycle-text-box-two',
        ]);
        expect(parsed.foreign).toEqual([]);
    });

    it('decodes annotation parse output of any total size and keeps the desktop entry limit', async () => {
        const data = new Uint8Array(await readFile(join(
            process.cwd(),
            'tests/fixtures/electron/freetext-lifecycle-test.pdf',
        )));
        const wasm = await loadWasmRunner();
        const result = await wasm.run('parseAnnotations', {source: new Blob([data])});
        if (result === null || 'status' in result) {
            throw new Error('Expected annotation parse WASM output');
        }
        const [
            header,
            firstChunk,
        ] = new TextDecoder().decode(result.data).split('\n');
        const note = (JSON.parse(firstChunk!) as {entries: Array<Record<string, unknown>>}).entries[0]!;
        const output = (entryCount: number, entriesPerLine: number, entry: unknown = note) => {
            const lines = [header!];
            for (let offset = 0; offset < entryCount; offset += entriesPerLine) {
                lines.push(JSON.stringify({
                    chunkIndex: lines.length - 1,
                    entries: new Array(Math.min(entriesPerLine, entryCount - offset)).fill(entry),
                }));
            }
            return new TextEncoder().encode(`${lines.join('\r\n')}\n`);
        };

        // Desktop reads its parse session without a total byte limit.
        const longNote = {
            ...note,
            contents: 'Long note text. '.repeat(500),
        };
        const large = output(2_500, 400, longNote);
        expect(large.byteLength).toBeGreaterThan(16 * 1024 * 1024);
        const parsed = decodeBrowserPdfAnnotationsOutput(large);
        expect(parsed.entities).toHaveLength(2_500);
        expect(parsed.entities.at(-1)).toEqual(longNote);

        expect(() => decodeBrowserPdfAnnotationsOutput(output(PDF_ANNOTATION_PARSE_MAX_ENTRIES + 1, 2_000)))
            .toThrow(`contains more than ${PDF_ANNOTATION_PARSE_MAX_ENTRIES} entries`);
        const longLine = new TextEncoder().encode(`${header}\n${JSON.stringify({
            chunkIndex: 0,
            entries: [],
            padding: 'x'.repeat(PDF_ANNOTATION_PARSE_MAX_LINE_BYTES),
        })}\n`);
        expect(decodeBrowserPdfAnnotationsOutput(output(1, 1)).entities).toEqual([note]);
        expect(() => decodeBrowserPdfAnnotationsOutput(longLine)).toThrow('line 2 exceeds');
        expect(() => decodeBrowserPdfAnnotationsOutput(Uint8Array.of(...new TextEncoder().encode(`${header}\n`), 0xff, 0x0a)))
            .toThrow('not valid UTF-8');
    });

    it('matches pdf-lib page summaries for representative operations', async () => {
        const basePdf = await createPdf({
            pageWidths: [
                200,
                300,
                400,
            ],
            cropSecondPage: true,
            rotateSecondPage: true,
        });
        const insertionPdf = await createPdf({pageWidths: [500]});

        const wasm = await loadWasmRunner();
        const wasmDelete = await wasm.structure({kind: 'delete', pages: [2]}, [basePdf]);
        const wasmExtract = await wasm.structure({kind: 'extract', pages: [
                3,
                1,
            ]}, [basePdf]);
        const wasmReorder = await wasm.structure({kind: 'reorder', pages: [
                3,
                1,
                2,
            ]}, [basePdf]);
        const wasmInsert = await wasm.structure({kind: 'insert', afterPage: 1}, [basePdf, insertionPdf]);
        const wasmRotate = await wasm.run('rotate', {
            data: basePdf,
            pages: [
                1,
                3,
            ],
            angle: 90,
        });
        const wasmCrop = await wasm.run('crop', {
            data: basePdf,
            pages: [1],
            margins: {
                top: 4,
                bottom: 6,
                left: 8,
                right: 10,
            },
        });
        const wasmRemoveCrop = await wasm.run('removeCrop', {
            data: basePdf,
            pages: [2],
        });
        const wasmGeometry = await wasm.run('getPageGeometry', {
            data: basePdf,
            pageNumber: 2,
        });

        expect(wasmDelete).not.toBeNull();
        expect(wasmExtract).not.toBeNull();
        expect(wasmReorder).not.toBeNull();
        expect(wasmInsert).not.toBeNull();
        expect(wasmRotate).not.toBeNull();
        expect(wasmCrop).not.toBeNull();
        expect(wasmRemoveCrop).not.toBeNull();
        expect(wasmGeometry).not.toBeNull();
        assertSuccessfulWasmMutation(wasmDelete);
        assertSuccessfulWasmMutation(wasmExtract);
        assertSuccessfulWasmMutation(wasmReorder);
        assertSuccessfulWasmMutation(wasmInsert);
        assertSuccessfulWasmMutation(wasmRotate);
        assertSuccessfulWasmMutation(wasmCrop);
        assertSuccessfulWasmMutation(wasmRemoveCrop);
        expect(wasm.fetchMock).toHaveBeenCalledWith(
            'https://viewer.test/wasm/evb-pdf-page-ops.wasm',
            {signal: expect.any(AbortSignal)},
        );

        expect((await summarizePdf(wasmDelete.data)).map(page => page.mediaBox.width))
            .toEqual([
                200,
                400,
            ]);
        expect((await summarizePdf(wasmExtract.data)).map(page => page.mediaBox.width))
            .toEqual([
                400,
                200,
            ]);
        expect((await summarizePdf(wasmReorder.data)).map(page => page.mediaBox.width))
            .toEqual([
                400,
                200,
                300,
            ]);
        expect((await summarizePdf(wasmInsert.data)).map(page => page.mediaBox.width))
            .toEqual([
                200,
                500,
                300,
                400,
            ]);
        expect((await summarizePdf(wasmRotate.data)).map(page => page.rotation))
            .toEqual([
                90,
                90,
                90,
            ]);
        expect((await summarizePdf(wasmCrop.data))[0]?.cropBox).toEqual({
            x: 8,
            y: 6,
            width: 182,
            height: 90,
        });
        expect((await summarizePdf(wasmRemoveCrop.data))[1]?.cropBox).toBeNull();
        expect(wasmGeometry).toEqual({
            userUnit: 1,
            mediaBox: {
                x: 0,
                y: 0,
                width: 300,
                height: 120,
            },
            cropBox: {
                x: 10,
                y: 12,
                width: 270,
                height: 80,
            },
            rotation: 90,
        });
    });

    it('saves one physical inch on mixed UserUnit pages and retains their scale', async () => {
        const pdf = await PDFDocument.create();
        for (const userUnit of [
            1,
            2,
        ]) {
            const page = pdf.addPage([
                300,
                200,
            ]);
            page.node.set(PDFName.of('UserUnit'), PDFNumber.of(userUnit));
        }
        const data = new Uint8Array(await pdf.save());
        const wasm = await loadWasmRunner();
        const result = await wasm.run('crop', {
            data,
            pages: [
                1,
                2,
            ],
            margins: {
                top: 0,
                bottom: 0,
                left: 72,
                right: 0,
                physical: true,
            },
        });
        assertSuccessfulWasmMutation(result);
        const reopened = await PDFDocument.load(result.data);
        for (const [
            index,
            page,
        ] of reopened.getPages().entries()) {
            const userUnit = page.node.lookup(PDFName.of('UserUnit'), PDFNumber).asNumber();
            expect(userUnit).toBe(index + 1);
            expect(page.getCropBox().x).toBe(72 / userUnit);
            expect(page.getCropBox().x * userUnit / 72).toBe(1);
        }
        expect(await wasm.run('getPageGeometry', {
            data: result.data,
            pageNumber: 2,
        }))
            .toMatchObject({
                userUnit: 2,
                cropBox: reopened.getPage(1).getCropBox(),
            });
        const raw = await wasm.run('crop', {
            data,
            pages: [2],
            margins: {
                top: 0,
                bottom: 0,
                left: 72,
                right: 0,
            },
        });
        assertSuccessfulWasmMutation(raw);
        expect((await PDFDocument.load(raw.data)).getPage(1).getCropBox().x).toBe(72);
    });

    it('preserves outlines and remaps page labels across browser page operations', async () => {
        const basePdf = await createMetadataPdf();
        const insertionPdf = await createPdf({pageWidths: [500]});
        const wasm = await loadWasmRunner();
        const operations = [
            {
                result: await wasm.structure({kind: 'delete', pages: [2]}, [basePdf]),
                labels: [
                    '1',
                    'II',
                ],
                destinationPage: 2,
            },
            {
                result: await wasm.structure({kind: 'reorder', pages: [
                        3,
                        1,
                        2,
                    ]}, [basePdf]),
                labels: [
                    'II',
                    '1',
                    'I',
                ],
                destinationPage: 1,
            },
            {
                result: await wasm.structure({kind: 'insert', afterPage: 1}, [basePdf, insertionPdf]),
                // The unlabelled inserted page continues the range it lands in.
                labels: [
                    '1',
                    '2',
                    'I',
                    'II',
                ],
                destinationPage: 4,
            },
        ];

        for (const operation of operations) {
            assertSuccessfulWasmMutation(operation.result);
            const output = await PDFDocument.load(operation.result.data);
            expect(output.catalog.get(PDFName.of('Outlines'))).toBeDefined();
            expect((await readPdfCatalogWithPdfjs(operation.result.data)).pageLabels).toEqual(operation.labels);
            expect(readOutlineDestination(output).objectNumber)
                .toBe(output.getPage(operation.destinationPage - 1).ref.objectNumber);
        }
    });

    it('reads catalog and conformance and merges N documents through EPPO v3', async () => {
        const sourcePdf = await createMetadataPdf();
        const sourceSnapshot = sourcePdf.slice();
        const secondPdf = await createPdf({pageWidths: [500]});
        const wasm = await loadWasmRunner();

        const catalogResult = await wasm.run('readCatalog', {source: new Blob([sourcePdf])});
        expect(catalogResult).toEqual({
            bookmarks: [{
                title: 'Page three',
                pageIndex: 2,
                pageYRatio: 0,
                originalDestination: {
                    kind: 'Fit',
                    coordinates: [],
                    sourceTarget: 2,
                },
                namedDest: null,
                bold: false,
                italic: false,
                color: null,
                items: [],
            }],
            pageLabels: [
                {
                    pageIndex: 0,
                    style: 'D',
                    start: 1,
                },
                {
                    pageIndex: 1,
                    style: 'R',
                    start: 1,
                },
            ],
        });

        const conformanceResult = await wasm.run('conformance', {data: sourcePdf});
        expect(conformanceResult).toEqual({
            isSigned: false,
            isEncrypted: false,
            isTagged: false,
            hasAcroForm: false,
            hasXfa: false,
        });

        const mergedResult = await wasm.structure({kind: 'merge'}, [
            sourcePdf,
            secondPdf,
        ]);
        assertSuccessfulWasmMutation(mergedResult);
        expect(mergedResult.pageCount).toBe(4);
        const merged = await PDFDocument.load(mergedResult.data);
        const mergedCatalog = await wasm.run('readCatalog', {source: new Blob([mergedResult.data])});
        expect(mergedCatalog).toMatchObject({
            bookmarks: [{
                title: 'Page three',
                pageIndex: 2,
                originalDestination: {
                    kind: 'Fit',
                    coordinates: [],
                    sourceTarget: 2,
                },
            }],
            pageLabels: [
                {
                    pageIndex: 0,
                    style: 'D',
                },
                {
                    pageIndex: 1,
                    style: 'R',
                },
                {pageIndex: 3},
            ],
        });
        expect(readOutlineDestination(merged).objectNumber)
            .toBe(merged.getPage(2).ref.objectNumber);
        expect(sourcePdf).toEqual(sourceSnapshot);
    });

    it('merges more than 500 documents and reads catalogs of more than 500 pages, as desktop does', async () => {
        const wasm = await loadWasmRunner();
        const onePage = await createPdf({pageWidths: [200]});
        const mergedResult = await wasm.structure({kind: 'merge'}, Array.from({length: 600}, () => onePage.slice()));
        assertSuccessfulWasmMutation(mergedResult);
        expect(mergedResult.pageCount).toBe(600);
        expect((await PDFDocument.load(mergedResult.data)).getPageCount()).toBe(600);
        await expect(wasm.run('readCatalog', {source: new Blob([mergedResult.data])})).resolves.toMatchObject({bookmarks: []});
        await expect(wasm.run('conformance', {data: mergedResult.data})).resolves.toMatchObject({isEncrypted: false});
    });

    it('reads more than 2,048 page-label ranges, as desktop does', async () => {
        const wasm = await loadWasmRunner();
        const pdfDocument = await PDFDocument.create();
        const nums = [];
        for (let pageIndex = 0; pageIndex < 3_000; pageIndex += 1) {
            pdfDocument.addPage([
                100,
                100,
            ]);
            nums.push(PDFNumber.of(pageIndex), pdfDocument.context.obj({
                S: PDFName.of(pageIndex % 2 === 0 ? 'D' : 'r'),
                P: PDFString.of(`part-${pageIndex}-`),
            }));
        }
        pdfDocument.catalog.set(PDFName.of('PageLabels'), pdfDocument.context.obj({Nums: pdfDocument.context.obj(nums)}));
        const catalog = await wasm.run('readCatalog', {source: new Blob([(await pdfDocument.save()).slice()])});
        if (catalog === null || 'status' in catalog || !catalog.pageLabels) {
            throw new Error('Expected the browser page-ops catalog to read the page labels');
        }
        expect(catalog.pageLabels).toHaveLength(3_000);
        expect(catalog.pageLabels[2_999]).toMatchObject({
            pageIndex: 2_999,
            style: 'r',
            prefix: 'part-2999-',
        });
    });

    it('preserves and offsets catalogs from every document in mergePages', async () => {
        const sourcePdf = await createMetadataPdf();
        const wasm = await loadWasmRunner();

        const mergedResult = await wasm.structure({kind: 'merge'}, [
            sourcePdf,
            sourcePdf,
        ]);
        assertSuccessfulWasmMutation(mergedResult);

        const mergedCatalog = await wasm.run('readCatalog', {source: new Blob([mergedResult.data])});
        if (mergedCatalog === null || 'status' in mergedCatalog) {
            throw new Error('Expected a successful browser page-ops catalog read');
        }
        expect(mergedCatalog.bookmarks).toHaveLength(2);
        expect(mergedCatalog.bookmarks?.map(bookmark => bookmark.pageIndex)).toEqual([
            2,
            5,
        ]);
        expect(mergedCatalog.pageLabels?.map(range => range.pageIndex)).toEqual([
            0,
            1,
            3,
            4,
        ]);
    });

    it('review-b6yr reads valid sibling bookmarks when one destination is dangling', async () => {
        const data = await createOutlinePdf((_pdfDocument, pages) => [
            {
                Title: PDFString.of('Valid first'),
                Dest: [
                    pages[0],
                    PDFName.of('Fit'),
                ],
            },
            {
                Title: PDFString.of('Target under review'),
                Dest: PDFRef.of(9999),
            },
            {
                Title: PDFString.of('Valid last'),
                Dest: [
                    pages[2],
                    PDFName.of('FitH'),
                    null,
                ],
            },
        ]);
        const wasm = await loadWasmRunner();
        const catalog = await wasm.run('readCatalog', {source: new Blob([data.slice()])});
        if (catalog === null || 'status' in catalog) {
            throw new Error('Expected a successful browser page-ops catalog read');
        }

        expect(catalog.bookmarksError).toBeUndefined();
        expect(catalog.bookmarks?.map(bookmark => [
            bookmark.title,
            bookmark.pageIndex,
        ])).toEqual([
            [
                'Valid first',
                0,
            ],
            [
                'Target under review',
                null,
            ],
            [
                'Valid last',
                2,
            ],
        ]);
    });

    it('review-b6yr keeps an untouched Unicode named destination when another bookmark is renamed', async () => {
        const data = await createOutlinePdf((pdfDocument, pages) => {
            pdfDocument.catalog.set(PDFName.of('Names'), pdfDocument.context.obj({Dests: {Names: [
                PDFHexString.fromText('caf\u00e9'),
                [
                    pages[2],
                    PDFName.of('FitH'),
                    null,
                ],
            ]}}));
            return [
                {
                    Title: PDFString.of('Chapter'),
                    Dest: [
                        pages[1],
                        PDFName.of('Fit'),
                    ],
                },
                {
                    Title: PDFString.of('Named'),
                    Dest: PDFHexString.fromText('caf\u00e9'),
                },
            ];
        });
        const source = await readOutlineTargets(data);

        const saved = await readOutlineTargets(await renameFirstBookmarkAndSave(data));

        expect(saved.map(target => target.title)).toEqual([
            'Chapter renamed',
            'Named',
        ]);
        expect(saved[1]).toEqual(source[1]);
    });

    it.each([
        [
            'a PDFDocEncoding name',
            'caf\u00e9',
            PDFHexString.of('636166E9'),
        ],
        [
            'an ASCII name stored as UTF-16',
            'chapter',
            PDFHexString.fromText('chapter'),
        ],
        [
            'a name with surrounding spaces',
            ' intro ',
            PDFString.of(' intro '),
        ],
    ])('keeps the name tree bytes of an untouched named destination in %s when another bookmark is renamed', async (_case, name, key) => {
        const data = await createOutlinePdf((pdfDocument, pages) => {
            pdfDocument.catalog.set(PDFName.of('Names'), pdfDocument.context.obj({Dests: {Names: [
                key,
                [
                    pages[2],
                    PDFName.of('FitH'),
                    null,
                ],
            ]}}));
            return [
                {
                    Title: PDFString.of('Chapter'),
                    Dest: [
                        pages[1],
                        PDFName.of('Fit'),
                    ],
                },
                {
                    Title: PDFString.of('Named'),
                    Dest: key,
                },
            ];
        });

        const saved = await renameFirstBookmarkAndSave(data);

        const savedDocument = await PDFDocument.load(saved);
        const treeKey = savedDocument.catalog.lookup(PDFName.of('Names'), PDFDict).lookup(PDFName.of('Dests'), PDFDict)
            .lookup(PDFName.of('Names'), PDFArray).get(0).toString();
        expect(treeKey).toBe(key.toString());
        expect((await readOutlineTargets(saved))[1]!.dest).toBe(treeKey);
        const reread = await (await loadWasmRunner()).run('readCatalog', {source: new Blob([saved])});
        if (reread === null || 'status' in reread) {
            throw new Error('Expected a successful browser page-ops catalog read');
        }
        expect(reread.bookmarks?.[1]).toMatchObject({
            namedDest: name,
            pageIndex: 2,
        });
    });

    it('review-b6yr keeps an untouched GoToR with an indirect file specification when another bookmark is renamed', async () => {
        const data = await createOutlinePdf((pdfDocument, pages) => [
            {
                Title: PDFString.of('Chapter'),
                Dest: [
                    pages[1],
                    PDFName.of('Fit'),
                ],
            },
            {
                Title: PDFString.of('Remote'),
                A: {
                    S: PDFName.of('GoToR'),
                    F: pdfDocument.context.register(pdfDocument.context.obj({
                        Type: PDFName.of('Filespec'),
                        F: PDFString.of('chapter-two.pdf'),
                        UF: PDFHexString.fromText('chapter-two.pdf'),
                    })),
                    D: [
                        0,
                        PDFName.of('Fit'),
                    ],
                },
            },
        ]);
        const source = await readOutlineTargets(data);

        const saved = await readOutlineTargets(await renameFirstBookmarkAndSave(data));

        expect(source[1]!.action?.file).toContain('/Filespec');
        expect(saved[1]).toEqual(source[1]);
    });

    it('fails closed when core receives non-integer runtime page fields', async () => {
        const basePdf = await createPdf({pageWidths: [200]});
        const core = await loadCoreWithWasm();

        await expect(core.rotatePdfBytes(basePdf, [1.5], 90))
            .rejects.toThrow('Invalid page-op WASM integer field');
        await expect(core.getPageGeometryFromPdfBytes(basePdf, 1.5))
            .rejects.toThrow('Invalid page-op WASM integer field');
        expect(core.fetchMock).toHaveBeenCalledWith(
            'https://viewer.test/wasm/evb-pdf-page-ops.wasm',
            {signal: expect.any(AbortSignal)},
        );
    });

    it('lays out the selected pages on A4 print sheets through WASM operation 15', async () => {
        const basePdf = await createPdf({
            pageWidths: [
                200,
                300,
                400,
            ],
            rotateSecondPage: true,
        });
        const core = await loadCoreWithWasm();

        const single = await core.layoutPdfForPrint(basePdf, {
            pageNumbers: [
                3,
                2,
            ],
            viewMode: 'single',
            orientation: 'auto',
        });
        // Sheets follow page order: page 2 (300x120 turned a quarter) prints
        // portrait and page 3 (400x140) landscape.
        expect((await summarizePdf(single.data)).map(page => [
            Math.round(page.mediaBox.width),
            Math.round(page.mediaBox.height),
        ])).toEqual([
            [
                595,
                842,
            ],
            [
                842,
                595,
            ],
        ]);

        const facing = await core.layoutPdfForPrint(basePdf, {
            viewMode: 'facing-first-single',
            orientation: 'auto',
        });
        expect(facing.pageCount).toBe(2);
    });

    it('rejects unknown writer instruction fields instead of silently stripping them', () => {
        const cropRect = {
            x: 0,
            y: 0,
            width: 100,
            height: 120,
        };
        const output = {cropRect};
        const page = {
            sourcePageIndex: 0,
            rotationQuarterTurns: 0,
            outputs: [output],
        };
        const split = {pages: [page]};
        expect(v.parse(SPLIT_PAGES_INSTRUCTIONS_SCHEMA, split)).toEqual(split);
        for (const instructions of [
            {
                ...split,
                unexpected: true,
            },
            {pages: [{
                ...page,
                unexpected: true,
            }]},
            {pages: [{
                ...page,
                outputs: [{
                    ...output,
                    unexpected: true,
                }],
            }]},
            {pages: [{
                ...page,
                outputs: [{cropRect: {
                    ...cropRect,
                    unexpected: true,
                }}],
            }]},
            {pages: [{
                ...page,
                outputs: [{
                    ...output,
                    contentTransform: {
                        scale: 1,
                        translateX: 0,
                        translateY: 0,
                        unexpected: true,
                    },
                }],
            }]},
        ]) expect(v.safeParse(SPLIT_PAGES_INSTRUCTIONS_SCHEMA, instructions).success).toBe(false);
        const overlayPage = {
            sourcePageIndex: 0,
            outputPageIndex: 0,
            matrix: [
                1,
                0,
                0,
                1,
                0,
                0,
            ],
        };
        for (const instructions of [
            {
                pages: [overlayPage],
                unexpected: true,
            },
            {pages: [{
                ...overlayPage,
                unexpected: true,
            }]},
            {pages: [{
                ...overlayPage,
                sourceRegion: {
                    rect: cropRect,
                    matrix: overlayPage.matrix,
                    unexpected: true,
                },
            }]},
            {pages: [{
                ...overlayPage,
                sourceRegion: {
                    rect: {
                        ...cropRect,
                        unexpected: true,
                    },
                    matrix: overlayPage.matrix,
                },
            }]},
        ]) expect(v.safeParse(OVERLAY_TEXT_INSTRUCTIONS_SCHEMA, instructions).success).toBe(false);
        expect(v.safeParse(RECOMPRESS_IMAGES_INSTRUCTIONS_SCHEMA, {
            targetDpi: 150,
            quality: 80,
            maxByteRatio: 0.9,
            unexpected: true,
        }).success).toBe(false);
        for (const instructions of [
            {
                maxByteRatio: 0.9,
                pages: [],
                unexpected: true,
            },
            {
                maxByteRatio: 0.9,
                pages: [{
                    pageNumber: 1,
                    replacement: 0,
                    replacementPageNumber: 1,
                    unexpected: true,
                }],
            },
        ]) expect(v.safeParse(REPLACE_PAGE_IMAGES_INSTRUCTIONS_SCHEMA, instructions).success).toBe(false);
    });

    it('splits a scan and overlays its source text through the scan-cleanup writers', async () => {
        const source = await PDFDocument.create();
        const font = await source.embedFont(StandardFonts.Helvetica);
        for (const label of [
            'Left',
            'Whole',
        ]) {
            source.addPage([
                200,
                120,
            ]).drawText(`${label} source text`, {
                x: 10,
                y: 60,
                size: 10,
                font,
            });
        }
        const sourceData = new Uint8Array(await source.save());
        const core = await loadCoreWithWasm();

        const split = await core.splitPdfPages(sourceData, {
            catalog: 'assembly',
            pages: [
                {
                    sourcePageIndex: 0,
                    rotationQuarterTurns: 0,
                    outputs: [
                        {cropRect: {
                            x: 0,
                            y: 0,
                            width: 100,
                            height: 120,
                        }},
                        {cropRect: {
                            x: 100,
                            y: 0,
                            width: 100,
                            height: 120,
                        }},
                    ],
                },
                {
                    sourcePageIndex: 1,
                    rotationQuarterTurns: 0,
                    outputs: [{cropRect: {
                        x: 0,
                        y: 0,
                        width: 200,
                        height: 120,
                    }}],
                },
            ],
        });
        expect(split.pageCount).toBe(3);
        expect(split.report).toEqual({textOmittedSourcePages: []});
        expect((await summarizePdf(split.data)).map(page => Math.round((page.cropBox ?? page.mediaBox).width)))
            .toEqual([
                100,
                100,
                200,
            ]);

        // Cleaned output pages carry no text until the overlay copies it.
        const staged = await PDFDocument.create();
        for (const width of [
            100,
            100,
            200,
        ]) {
            staged.addPage([
                width,
                120,
            ]);
        }
        const identity: [number, number, number, number, number, number] = [
            1,
            0,
            0,
            1,
            0,
            0,
        ];
        const overlaid = await core.overlayPdfTextLayers(new Uint8Array(await staged.save()), sourceData, {
            provenanceStampHex: '54455354',
            pages: [
                {
                    sourcePageIndex: 0,
                    outputPageIndex: 0,
                    matrix: identity,
                },
                {
                    sourcePageIndex: 1,
                    outputPageIndex: 2,
                    matrix: identity,
                },
            ],
        });
        expect(overlaid.pageCount).toBe(3);
        expect(overlaid.report).toEqual({textOmittedSourcePages: []});
        const output = await PDFDocument.load(overlaid.data);
        const info = output.context.lookup(output.context.trailerInfo.Info, PDFDict);
        expect(info.lookup(PDFName.of('EVBScanCleanup'), PDFString).decodeText()).toBe('54455354');
        const pageText = (index: number) => {
            const contents = output.getPage(index).node.Contents();
            if (contents === undefined) return '';
            const streams = contents instanceof PDFArray
                ? contents.asArray().map(ref => output.context.lookup(ref))
                : [contents];
            return streams.map((stream) => {
                if (!(stream instanceof PDFRawStream)) throw new Error('Expected an encoded content stream');
                return new TextDecoder().decode(decodePDFRawStream(stream).decode());
            }).join('\n');
        };
        expect(pageText(0)).toMatch(/T[jJ]/);
        expect(pageText(1)).not.toMatch(/T[jJ]/);
        expect(pageText(2)).toMatch(/T[jJ]/);
    });

    it('recompresses page images and returns only the revision to append', async () => {
        const jpeg = await readFile(join(process.cwd(), 'tests/fixtures/electron/early-print/breviary-1677-rubrics.jpg'));
        const document = await PDFDocument.create();
        const image = await document.embedJpg(jpeg);
        document.addPage([
            200,
            218,
        ]).drawImage(image, {
            x: 0,
            y: 0,
            width: 200,
            height: 218,
        });
        const data = new Uint8Array(await document.save());
        const core = await loadCoreWithWasm();

        const kept = await core.recompressPdfImages(data, {
            targetDpi: 72,
            quality: 60,
            maxByteRatio: 0.0001,
        });
        expect(kept.data.byteLength).toBe(0);
        expect(kept.report.pages).toEqual([]);
        expect(kept.report.images.map(entry => entry.outcome)).toEqual(['not-smaller']);

        const recompressed = await core.recompressPdfImages(data, {
            targetDpi: 72,
            quality: 60,
            maxByteRatio: 0.9,
        });
        expect(recompressed.pageCount).toBe(1);
        expect(recompressed.report.pages).toEqual([1]);
        const [entry] = recompressed.report.images;
        expect(entry?.outcome).toBe('recompressed');
        expect(entry!.recompressedBytes).toBeLessThan(entry!.sourceBytes);
        const saved = new Uint8Array(data.byteLength + recompressed.data.byteLength);
        saved.set(data);
        saved.set(recompressed.data, data.byteLength);
        const reopened = await PDFDocument.load(saved);
        const stored = reopened.context.lookup(PDFRef.of(entry!.objectNumber));
        if (!(stored instanceof PDFRawStream)) throw new Error('Expected the recompressed image stream');
        expect(stored.getContentsSize()).toBe(entry!.recompressedBytes);
    });

    it.each([
        [
            'tagged-content',
            '/Figure <</MCID 0>> BDC',
        ],
        [
            'optional-content',
            '/OC /Hidden BDC',
        ],
    ])('decodes a %s image-replacement refusal with an empty browser revision', async (outcome, prefix) => {
        const source = await PDFDocument.create();
        const jpeg = await readFile(join(process.cwd(), 'tests/fixtures/electron/early-print/breviary-1677-rubrics.jpg'));
        const page = source.addPage([
            200,
            218,
        ]);
        const image = await source.embedJpg(jpeg);
        page.node.set(PDFName.of('Contents'), source.context.register(source.context.stream(
            `${prefix}\nq 200 0 0 218 0 0 cm /Scan Do Q\nEMC\n`,
        )));
        const layer = source.context.register(source.context.obj({
            Type: 'OCG',
            Name: PDFString.of('Hidden'),
        }));
        page.node.set(PDFName.of('Resources'), source.context.obj({
            XObject: {Scan: image.ref},
            Properties: {Hidden: layer},
        }));
        source.catalog.set(PDFName.of('OCProperties'), source.context.obj({
            OCGs: [layer],
            D: {OFF: [layer]},
        }));
        const data = new Uint8Array(await source.save());
        const replacement = await PDFDocument.create();
        replacement.addPage([
            200,
            218,
        ]);
        const core = await loadCoreWithWasm();
        const result = await core.replacePdfPageImages(data, [new Uint8Array(await replacement.save())], {
            maxByteRatio: 0.9,
            pages: [{
                pageNumber: 1,
                replacement: 0,
                replacementPageNumber: 1,
            }],
        });
        expect(result.report.pages[0]?.outcome).toBe(outcome);
        expect(result.data.byteLength).toBe(0);
    });

    it('replaces a scanned page image from an attached replacement PDF', async () => {
        const jpeg = await readFile(join(process.cwd(), 'tests/fixtures/electron/early-print/breviary-1677-rubrics.jpg'));
        const scan = await PDFDocument.create();
        scan.addPage([
            200,
            218,
        ]).drawImage(await scan.embedJpg(jpeg), {
            x: 0,
            y: 0,
            width: 200,
            height: 218,
        });
        const data = new Uint8Array(await scan.save());
        // A compact re-encoding of the page; a filled page view stands in for it.
        const replacement = await PDFDocument.create();
        replacement.addPage([
            200,
            218,
        ]).drawRectangle({
            x: 0,
            y: 0,
            width: 200,
            height: 218,
            color: rgb(0.9, 0.9, 0.9),
        });
        const replacementData = new Uint8Array(await replacement.save());
        const core = await loadCoreWithWasm();

        const replaced = await core.replacePdfPageImages(data, [replacementData], {
            maxByteRatio: 0.9,
            pages: [{
                pageNumber: 1,
                replacement: 0,
                replacementPageNumber: 1,
            }],
        });
        expect(replaced.report.pages.map(page => page.outcome)).toEqual(['replaced']);
        expect(replaced.data.byteLength).toBeGreaterThan(0);
        const saved = new Uint8Array(data.byteLength + replaced.data.byteLength);
        saved.set(data);
        saved.set(replaced.data, data.byteLength);
        expect((await PDFDocument.load(saved)).getPageCount()).toBe(1);

        await expect(core.replacePdfPageImages(data, [], {
            maxByteRatio: 0.9,
            pages: [{
                pageNumber: 1,
                replacement: 0,
                replacementPageNumber: 1,
            }],
        })).rejects.toThrow('does not carry');
        await expect(core.overlayPdfTextLayers(data, data, {pages: [{
            sourcePageIndex: 0,
            outputPageIndex: 0,
            matrix: [
                0,
                0,
                0,
                0,
                0,
                0,
            ],
        }]})).rejects.toThrow('invertible');
    });

    it('rejects delete-all through native page-ops WASM before saving a zero-page PDF', async () => {
        const basePdf = await createPdf({pageWidths: [200]});
        const wasm = await loadWasmRunner();

        expect(await wasm.structure({kind: 'delete', pages: [1]}, [basePdf])).toMatchObject({
            status: 'failed',
            error: {message: 'deletePages: cannot delete every page'},
        });
    });

    it('reports why the WASM asset could not be loaded', async () => {
        vi.resetModules();
        vi.stubGlobal('location', {href: 'https://viewer.test/workspace'});
        vi.stubGlobal('WebAssembly', NativeWebAssembly);
        vi.stubGlobal('fetch', vi.fn(async () => new Response(null, {status: 404})));
        const { tryRunBrowserPageOpsWithWasm } = await import('@app/platform/browser-api/tryRunBrowserPageOpsWithWasm');
        const basePdf = await createPdf({pageWidths: [200]});

        await expect(tryRunBrowserPageOpsWithWasm('rotate', {
            data: basePdf,
            pages: [1],
            angle: 90,
        })).resolves.toEqual({
            status: 'failed',
            error: {
                code: 'io',
                message: 'The browser page tool could not be loaded: WASM module request failed with status 404',
            },
        });
    });

    it('reports a module with an incompatible allocation ABI', async () => {
        vi.resetModules();
        vi.stubGlobal('location', {href: 'https://viewer.test/workspace'});
        vi.stubGlobal('fetch', vi.fn(async () => new Response(new ArrayBuffer(8))));
        const wasmMock = createFailingPageOpsWasmExports('unused');
        wasmMock.exports.evb_wasm_request_allocation_abi_version.mockReturnValue(0);
        vi.stubGlobal('WebAssembly', {
            Memory: NativeWebAssembly.Memory,
            instantiate: vi.fn(async () => ({instance: {exports: wasmMock.exports}})),
        });
        const {tryRunBrowserPageOpsWithWasm} = await import('@app/platform/browser-api/tryRunBrowserPageOpsWithWasm');
        const basePdf = await createPdf({pageWidths: [200]});

        await expect(tryRunBrowserPageOpsWithWasm('rotate', {
            data: basePdf,
            pages: [1],
            angle: 90,
        })).resolves.toEqual({
            status: 'failed',
            error: {
                code: 'io',
                message: 'The browser page tool could not be loaded: The page tool does not match this version of the app',
            },
        });
        expect(wasmMock.exports.evb_pdf_page_ops_alloc).not.toHaveBeenCalled();
    });

    it('preserves native WASM error envelopes when a page operation falls back', async () => {
        vi.resetModules();
        vi.stubGlobal('location', {href: 'https://viewer.test/workspace'});
        vi.stubGlobal('fetch', vi.fn(async () => new Response(new ArrayBuffer(8))));
        const wasmMock = createFailingPageOpsWasmExports(JSON.stringify({
            code: 'corrupt-xref',
            message: 'page wasm failed',
        }));
        vi.stubGlobal('WebAssembly', {
            Memory: NativeWebAssembly.Memory,
            instantiate: vi.fn(async () => ({instance: {exports: wasmMock.exports}})),
        });
        const { tryRunBrowserPageOpsWithWasm } = await import('@app/platform/browser-api/tryRunBrowserPageOpsWithWasm');
        const basePdf = await createPdf({pageWidths: [200]});

        await expect(tryRunBrowserPageOpsWithWasm('rotate', {
            data: basePdf,
            pages: [1],
            angle: 90,
        })).resolves.toEqual({
            status: 'failed',
            error: {
                code: 'corrupt-xref',
                message: 'page wasm failed',
            },
        });

        expect(wasmMock.run).toHaveBeenCalledTimes(1);
        expect(wasmMock.free).toHaveBeenCalledTimes(1);
    });

    it('classifies allocation failure without touching linear memory', async () => {
        vi.resetModules();
        vi.stubGlobal('location', {href: 'https://viewer.test/workspace'});
        vi.stubGlobal('fetch', vi.fn(async () => new Response(new ArrayBuffer(8))));
        const wasmMock = createFailingPageOpsWasmExports('unused');
        wasmMock.exports.evb_pdf_page_ops_alloc.mockReturnValue(0);
        vi.stubGlobal('WebAssembly', {
            Memory: NativeWebAssembly.Memory,
            instantiate: vi.fn(async () => ({instance: {exports: wasmMock.exports}})),
        });
        const {tryRunBrowserPageOpsWithWasm} = await import('@app/platform/browser-api/tryRunBrowserPageOpsWithWasm');
        const basePdf = await createPdf({pageWidths: [200]});

        await expect(tryRunBrowserPageOpsWithWasm('rotate', {
            data: basePdf,
            pages: [1],
            angle: 90,
        })).resolves.toMatchObject({
            status: 'failed',
            error: {code: 'too-large'},
        });
        expect(wasmMock.run).not.toHaveBeenCalled();
        expect(wasmMock.free).not.toHaveBeenCalled();
    });

    it('rejects an out-of-bounds allocation pointer and releases ABI ownership', async () => {
        vi.resetModules();
        vi.stubGlobal('location', {href: 'https://viewer.test/workspace'});
        vi.stubGlobal('fetch', vi.fn(async () => new Response(new ArrayBuffer(8))));
        const wasmMock = createFailingPageOpsWasmExports('unused');
        const probePointer = wasmMock.alloc(7);
        wasmMock.free(probePointer, 6);
        expect(wasmMock.alloc(1)).toBe(0);
        wasmMock.free(probePointer, 7);
        const reusedPointer = wasmMock.alloc(1);
        expect(reusedPointer).not.toBe(0);
        wasmMock.free(reusedPointer, 1);
        wasmMock.alloc.mockClear();
        wasmMock.free.mockClear();
        wasmMock.setNextAllocationPointer(65_520);
        vi.stubGlobal('WebAssembly', {
            Memory: NativeWebAssembly.Memory,
            instantiate: vi.fn(async () => ({instance: {exports: wasmMock.exports}})),
        });
        const {tryRunBrowserPageOpsWithWasm} = await import('@app/platform/browser-api/tryRunBrowserPageOpsWithWasm');
        const basePdf = await createPdf({pageWidths: [200]});

        await expect(tryRunBrowserPageOpsWithWasm('rotate', {
            data: basePdf,
            pages: [1],
            angle: 90,
        })).resolves.toMatchObject({
            status: 'failed',
            error: {code: 'invalid-request'},
        });
        expect(wasmMock.run).not.toHaveBeenCalled();
        expect(wasmMock.free).toHaveBeenCalledOnce();

        await expect(tryRunBrowserPageOpsWithWasm('rotate', {
            data: basePdf,
            pages: [1],
            angle: 90,
        })).resolves.toMatchObject({status: 'failed'});
        expect(wasmMock.run).toHaveBeenCalledOnce();
        expect(wasmMock.free).toHaveBeenCalledTimes(2);
    });

    it('rejects an out-of-bounds output span and frees the valid request allocation', async () => {
        vi.resetModules();
        vi.stubGlobal('location', {href: 'https://viewer.test/workspace'});
        vi.stubGlobal('fetch', vi.fn(async () => new Response(new ArrayBuffer(8))));
        const wasmMock = createFailingPageOpsWasmExports('unused');
        const probePointer = wasmMock.alloc(7);
        wasmMock.free(probePointer, 6);
        expect(wasmMock.alloc(1)).toBe(0);
        wasmMock.free(probePointer, 7);
        const reusedPointer = wasmMock.alloc(1);
        expect(reusedPointer).not.toBe(0);
        wasmMock.free(reusedPointer, 1);
        wasmMock.alloc.mockClear();
        wasmMock.free.mockClear();
        wasmMock.run.mockReturnValue(0);
        wasmMock.exports.evb_pdf_page_ops_output_ptr.mockReturnValue(65_520);
        wasmMock.exports.evb_pdf_page_ops_output_len.mockReturnValue(32);
        vi.stubGlobal('WebAssembly', {
            Memory: NativeWebAssembly.Memory,
            instantiate: vi.fn(async () => ({instance: {exports: wasmMock.exports}})),
        });
        const {tryRunBrowserPageOpsWithWasm} = await import('@app/platform/browser-api/tryRunBrowserPageOpsWithWasm');
        const basePdf = await createPdf({pageWidths: [200]});

        await expect(tryRunBrowserPageOpsWithWasm('rotate', {
            data: basePdf,
            pages: [1],
            angle: 90,
        })).resolves.toMatchObject({
            status: 'failed',
            error: {code: 'invalid-request'},
        });
        expect(wasmMock.run).toHaveBeenCalledOnce();
        expect(wasmMock.free).toHaveBeenCalledOnce();

        await expect(tryRunBrowserPageOpsWithWasm('rotate', {
            data: basePdf,
            pages: [1],
            angle: 90,
        })).resolves.toMatchObject({
            status: 'failed',
            error: {code: 'invalid-request'},
        });
        expect(wasmMock.run).toHaveBeenCalledTimes(2);
        expect(wasmMock.free).toHaveBeenCalledTimes(2);
    });

    it.each([
        'not-json',
        JSON.stringify({
            code: 'future-native-code',
            message: 'future failure',
        }),
    ])('falls back to native-failure for malformed or unknown WASM errors', async (encodedError) => {
        vi.resetModules();
        vi.stubGlobal('location', {href: 'https://viewer.test/workspace'});
        vi.stubGlobal('fetch', vi.fn(async () => new Response(new ArrayBuffer(8))));
        const wasmMock = createFailingPageOpsWasmExports(encodedError);
        vi.stubGlobal('WebAssembly', {
            Memory: NativeWebAssembly.Memory,
            instantiate: vi.fn(async () => ({instance: {exports: wasmMock.exports}})),
        });
        const {tryRunBrowserPageOpsWithWasm} = await import(
            '@app/platform/browser-api/tryRunBrowserPageOpsWithWasm'
        );
        const basePdf = await createPdf({pageWidths: [200]});

        await expect(tryRunBrowserPageOpsWithWasm('rotate', {
            data: basePdf,
            pages: [1],
            angle: 90,
        })).resolves.toMatchObject({
            status: 'failed',
            error: {code: 'native-failure'},
        });
    });
    it.each([
        'success',
        'native-error',
        'throw',
        'malformed-success',
    ] as const)(
        'clears encoded password bytes before releasing WASM memory on %s', async (outcome) => {
            vi.resetModules();
            vi.stubGlobal('location', {href: 'https://viewer.test/workspace'});
            vi.stubGlobal('fetch', vi.fn(async () => new Response(new ArrayBuffer(8))));
            const wasm = createFailingPageOpsWasmExports(JSON.stringify({
                code: 'needs-password',
                message: 'Password required',
            }));
            const password = '秘密-transient-password';
            const passwordBytes = new TextEncoder().encode(password);
            let encodedJs: Uint8Array | undefined;
            const nativeEncode = TextEncoder.prototype.encode;
            vi.spyOn(TextEncoder.prototype, 'encode').mockImplementation(function (this: TextEncoder, value) {
                const encoded = nativeEncode.call(this, value);
                if (value === password) encodedJs = encoded;
                return encoded;
            });
            let encodedBefore: Uint8Array | undefined;
            let encodedAtRelease: Uint8Array | undefined;
            wasm.exports.evb_pdf_page_ops_run.mockImplementation((pointer: number, length: number) => {
                encodedBefore = new Uint8Array(wasm.exports.memory.buffer, pointer + length - passwordBytes.byteLength, passwordBytes.byteLength).slice();
                if (outcome === 'throw') throw new Error('Writer failed');
                if (outcome === 'success') {
                    const output = new Uint8Array(13);
                    const view = new DataView(output.buffer);
                    view.setUint32(0, 1, true);
                    view.setUint32(4, 1, true);
                    view.setUint32(8, 1, true);
                    output[12] = 2;
                    new Uint8Array(wasm.exports.memory.buffer, 4096, output.length).set(output);
                    wasm.exports.evb_pdf_page_ops_output_ptr.mockReturnValue(4096);
                    wasm.exports.evb_pdf_page_ops_output_len.mockReturnValue(output.length);
                    return 0;
                }
                return outcome === 'malformed-success' ? 0 : -7;
            });
            wasm.exports.evb_pdf_page_ops_free.mockImplementation((pointer: number, length: number) => {
                encodedAtRelease = new Uint8Array(wasm.exports.memory.buffer, pointer + length - passwordBytes.byteLength, passwordBytes.byteLength).slice();
            });
            vi.stubGlobal('WebAssembly', {
                Memory: NativeWebAssembly.Memory,
                instantiate: vi.fn(async () => ({instance: {exports: wasm.exports}})),
            });
            const {tryRunBrowserPageOpsWithWasm} = await import('@app/platform/browser-api/tryRunBrowserPageOpsWithWasm');
            const result = await tryRunBrowserPageOpsWithWasm('decrypt', {
                data: new Uint8Array([1]),
                password,
            });
            expect(result).toMatchObject(outcome === 'success' ? {
                data: new Uint8Array([2]),
                pageCount: 1,
            } : {status: 'failed'});
            expect(encodedBefore).toEqual(passwordBytes);
            expect(encodedAtRelease).toEqual(new Uint8Array(passwordBytes.byteLength));
            expect(encodedJs).toEqual(new Uint8Array(passwordBytes.byteLength));
        },
    );

});
