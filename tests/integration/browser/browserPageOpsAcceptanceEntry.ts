// fallow-ignore-file unused-file -- bundled by browserPageOpsAcceptance.test.ts.

import {
    PDFDocument,
    PDFDict,
    PDFHexString,
    PDFName,
    PDFNumber,
    PDFString,
} from 'pdf-lib';
import type {
    PDFArray,
    PDFRef,
} from 'pdf-lib';
import {createBrowserPageOpsCapability} from '@app/platform/browser-api/createBrowserPageOpsCapability';
import {createCombinedPdfFromPaths} from '@app/platform/browser-api/createCombinedPdfFromPaths';
import {readPdfCatalog} from '@app/platform/browser-api/browserPageOpsCore';
import {browserDocumentStore} from '@app/platform/browserDocumentStore';
import {
    isBrowserPageOpsWasmFailure, appendPdfMutationsToBytes,
} from '@app/platform/browser-api/tryRunBrowserPageOpsWithWasm';
import {PDF_BOOKMARK_RECOVERY_ENTRY_SCHEMA} from '@contracts/pdfBookmarkEntry';
import * as v from 'valibot';

interface IBrowserPageOpsAcceptanceResult {
    operation: 'delete' | 'reorder' | 'insert';
    resurrectionRegression: boolean;
    pageCount: number;
    labels: string[];
    outlineDestinationPage: number;
    outlineDestinationWasDeleted: boolean;
}

function lookupDict(document: PDFDocument, value: unknown) {
    return document.context.lookup(value as PDFRef) as PDFDict;
}

function romanNumeral(value: number) {
    const numerals = [[1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']] as const;
    let rest = value;
    return numerals.map(([amount, numeral]) => {
        const count = Math.floor(rest / amount);
        rest -= count * amount;
        return numeral.repeat(count);
    }).join('');
}

/** Each page's displayed label, from the label ranges' style, prefix and first number. */
function readLabels(document: PDFDocument) {
    const pageLabels = lookupDict(document, document.catalog.get(PDFName.of('PageLabels')));
    const nums = pageLabels.get(PDFName.of('Nums')) as PDFArray;
    const ranges: Array<{start: number; style: string; prefix: string; first: number}> = [];
    for (let index = 0; index < nums.size(); index += 2) {
        const label = lookupDict(document, nums.get(index + 1));
        ranges.push({
            start: (nums.get(index) as PDFNumber).asNumber(),
            style: (label.get(PDFName.of('S')) as PDFName | undefined)?.decodeText() ?? '',
            prefix: (label.get(PDFName.of('P')) as PDFString | undefined)?.decodeText() ?? '',
            first: (label.get(PDFName.of('St')) as PDFNumber | undefined)?.asNumber() ?? 1,
        });
    }
    return document.getPages().map((_page, pageIndex) => {
        const range = ranges.findLast(candidate => candidate.start <= pageIndex);
        if (!range) return String(pageIndex + 1);
        const number = range.first + pageIndex - range.start;
        const numerals: Record<string, string> = {D: String(number), R: romanNumeral(number), r: romanNumeral(number).toLowerCase()};
        const numeral = numerals[range.style] ?? '';
        return `${range.prefix}${numeral}`;
    });
}

function readOutlineDestination(document: PDFDocument) {
    const outlines = lookupDict(document, document.catalog.get(PDFName.of('Outlines')));
    const first = lookupDict(document, outlines.get(PDFName.of('First')));
    return (first.get(PDFName.of('Dest')) as PDFArray).get(0) as PDFRef;
}

function pageNumberForRef(document: PDFDocument, pageRef: PDFRef) {
    const pageIndex = document.getPages().findIndex(page => page.ref === pageRef);
    return pageIndex < 0 ? null : pageIndex + 1;
}

async function createFixture(outlinePageIndex = 2) {
    const document = await PDFDocument.create();
    const pages = [
        document.addPage([
            200,
            100,
        ]),
        document.addPage([
            300,
            100,
        ]),
        document.addPage([
            400,
            100,
        ]),
    ];
    const decimalLabels = document.context.register(document.context.obj({
        S: PDFName.of('D'),
        St: PDFNumber.of(1),
        P: PDFString.of(''),
    }));
    const romanLabels = document.context.register(document.context.obj({
        S: PDFName.of('R'),
        St: PDFNumber.of(1),
        P: PDFString.of(''),
    }));
    const pageLabels = document.context.register(document.context.obj({Nums: [
        0,
        decimalLabels,
        1,
        romanLabels,
    ]}));
    const outlineItem = document.context.register(document.context.obj({
        Title: PDFString.of('Page three'),
        Dest: [
            pages[outlinePageIndex]!.ref,
            PDFName.of('Fit'),
        ],
    }));
    const outlines = document.context.register(document.context.obj({
        Type: PDFName.of('Outlines'),
        First: outlineItem,
        Last: outlineItem,
        Count: PDFNumber.of(1),
    }));
    (document.context.lookup(outlineItem) as PDFDict).set(PDFName.of('Parent'), outlines);
    document.catalog.set(PDFName.of('PageLabels'), pageLabels);
    document.catalog.set(PDFName.of('Outlines'), outlines);
    return {bytes: new Uint8Array(await document.save())};
}

async function createInsertionFixture() {
    const document = await PDFDocument.create();
    document.addPage([
        500,
        100,
    ]);
    return new Uint8Array(await document.save());
}

async function runOperation(
    operation: IBrowserPageOpsAcceptanceResult['operation'],
    fixtureBytes: Uint8Array,
    insertionBytes: Uint8Array,
    resurrectionRegression = false,
) {
    const workingPath = await browserDocumentStore.createStoredDocument(
        `${operation}-working.pdf`,
        fixtureBytes,
        {
            mimeType: 'application/pdf',
            kind: 'working',
            retention: 'transient',
            saveKind: 'pdf',
        },
    );
    const insertionPath = await browserDocumentStore.createStoredDocument(
        `${operation}-insertion.pdf`,
        insertionBytes,
        {
            mimeType: 'application/pdf',
            kind: 'source',
            retention: 'transient',
            saveKind: 'pdf',
        },
    );
    try {
        const pageOps = createBrowserPageOpsCapability({
            clearSearchCaches: async () => undefined,
            openInputAccept: 'application/pdf',
            pickFiles: async () => [],
            buildOpenPdfPickerTypes: () => [],
            createCombinedPdfFromPaths,
            pickSaveTarget: async () => ({
                canceled: true,
                fileName: '',
            }),
            saveBytesToPickerOrDownload: async () => ({
                canceled: true,
                fileName: '',
            }),
            writeBytesToHandle: async () => undefined,
        });
        const mutationOptions = {expectedDocumentRevisionToken: (await browserDocumentStore.getDocumentRevision(workingPath)).token};
        await (operation === 'delete'
            ? pageOps.delete(workingPath, [2], 3, mutationOptions)
            : operation === 'reorder'
                ? pageOps.reorder(workingPath, [
                    3,
                    1,
                    2,
                ], mutationOptions)
                : pageOps.insertFile(workingPath, 3, 1, [insertionPath], undefined, mutationOptions));
        const savedBytes = await browserDocumentStore.read(workingPath);
        await browserDocumentStore.write(workingPath, savedBytes, {expectedDocumentRevisionToken: (await browserDocumentStore.getDocumentRevision(workingPath)).token});
        browserDocumentStore.unload(workingPath);
        const reopened = await browserDocumentStore.read(workingPath);
        const document = await PDFDocument.load(reopened);
        const destinationRef = readOutlineDestination(document);
        const destinationPage = pageNumberForRef(document, destinationRef);
        return {
            operation,
            resurrectionRegression,
            pageCount: document.getPageCount(),
            labels: readLabels(document),
            outlineDestinationPage: destinationPage ?? 0,
            outlineDestinationWasDeleted: destinationPage === null,
        } satisfies IBrowserPageOpsAcceptanceResult;
    } finally {
        await Promise.all([
            browserDocumentStore.cleanupDetachedDocument(workingPath),
            browserDocumentStore.cleanupDetachedDocument(insertionPath),
        ]);
    }
}

async function runBrowserPageOpsAcceptance() {
    const fixture = await createFixture();
    const resurrectionFixture = await createFixture(1);
    const insertionBytes = await createInsertionFixture();
    return Promise.all([
        runOperation('delete', fixture.bytes, insertionBytes),
        runOperation('reorder', fixture.bytes, insertionBytes),
        runOperation('insert', fixture.bytes, insertionBytes),
        runOperation('delete', resurrectionFixture.bytes, insertionBytes, true),
    ]);
}

// One catalog part that cannot be read must not hide the other: broken page
// labels keep the outline readable, and a broken outline keeps the labels.
async function createCatalogPartsFixture(broken: 'page labels' | 'outline') {
    const document = await PDFDocument.create();
    const pages = [
        document.addPage([
            200,
            100,
        ]),
        document.addPage([
            200,
            100,
        ]),
    ];
    const outlineItem = document.context.register(document.context.obj({
        Title: PDFString.of('Chapter'),
        Dest: [
            pages[1]!.ref,
            PDFName.of('Fit'),
        ],
    }));
    const outlines = document.context.register(document.context.obj({
        Type: PDFName.of('Outlines'),
        First: outlineItem,
        Last: outlineItem,
        Count: PDFNumber.of(1),
    }));
    (document.context.lookup(outlineItem) as PDFDict).set(PDFName.of('Parent'), outlines);
    document.catalog.set(PDFName.of('Outlines'), broken === 'outline' ? PDFNumber.of(5) : outlines);
    document.catalog.set(PDFName.of('PageLabels'), document.context.obj(broken === 'page labels'
        // An empty number tree is recoverable; a visible scalar label is not.
        ? {Nums: [
            0,
            PDFNumber.of(5),
        ]}
        : {Nums: [
            0,
            {S: PDFName.of('r')},
        ]}));
    return new Uint8Array(await document.save());
}

async function settleCatalogPart<T>(read: () => Promise<T>) {
    try {
        return await read();
    } catch {
        return 'unreadable' as const;
    }
}

async function runBrowserCatalogPartsAcceptance() {
    return Promise.all(([
        'page labels',
        'outline',
    ] as const).map(async (broken) => {
        const bytes = await createCatalogPartsFixture(broken);
        const workingPath = await browserDocumentStore.createStoredDocument(`catalog-${broken}.pdf`, bytes, {
            mimeType: 'application/pdf',
            kind: 'working',
            retention: 'transient',
            saveKind: 'pdf',
        });
        try {
            const pageOps = createBrowserPageOpsCapability({
                clearSearchCaches: async () => undefined,
                openInputAccept: 'application/pdf',
                pickFiles: async () => [],
                buildOpenPdfPickerTypes: () => [],
                createCombinedPdfFromPaths,
                pickSaveTarget: async () => ({
                    canceled: true,
                    fileName: '',
                }),
                saveBytesToPickerOrDownload: async () => ({
                    canceled: true,
                    fileName: '',
                }),
                writeBytesToHandle: async () => undefined,
            });
            return {
                broken,
                bookmarks: await settleCatalogPart(async () => (await pageOps.readOutline(workingPath)).map(entry => entry.title)),
                pageLabels: await settleCatalogPart(async () => {
                    const catalog = await readPdfCatalog(bytes);
                    if (!catalog.pageLabels) throw new Error(catalog.pageLabelsError);
                    return catalog.pageLabels.map(range => range.style ?? null);
                }),
            };
        } finally {
            await browserDocumentStore.cleanupDetachedDocument(workingPath);
        }
    }));
}

Reflect.set(globalThis, '__evbRunBrowserPageOpsAcceptance', runBrowserPageOpsAcceptance);
Reflect.set(globalThis, '__evbRunBrowserCatalogPartsAcceptance', runBrowserCatalogPartsAcceptance);

// Read the writer's saved bytes independently, including every unchanged title.
async function runBrowserBookmarkSaveAcceptance() {
    const results = [];
    for (const count of [
        3,
        10_000,
    ]) {
        const source = await PDFDocument.create();
        const page = source.addPage([
            200,
            100,
        ]);
        const outline = source.context.nextRef();
        const entries = Array.from({length: count}, (_, index) => source.context.obj({
            Title: PDFString.of(`Section${index + 1}`),
            Parent: outline,
            Dest: [
                page.ref,
                PDFName.of('Fit'),
            ],
        }));
        const refs = entries.map(entry => source.context.register(entry));
        entries.forEach((entry, index) => {
            if (index > 0) entry.set(PDFName.of('Prev'), refs[index - 1]!);
            if (index + 1 < count) entry.set(PDFName.of('Next'), refs[index + 1]!);
        });
        source.context.assign(outline, source.context.obj({
            Type: PDFName.of('Outlines'),
            First: refs[0],
            Last: refs.at(-1),
            Count: count,
        }));
        source.catalog.set(PDFName.of('Outlines'), outline);
        const input = new Uint8Array(await source.save());
        const catalog = await readPdfCatalog(input);
        const items = v.parse(v.array(PDF_BOOKMARK_RECOVERY_ENTRY_SCHEMA), catalog.bookmarks);
        items[items.length - 1] = {
            ...items.at(-1)!,
            title: 'Large web saved',
        };
        const saved = await appendPdfMutationsToBytes(input, {
            mutations: {bookmarks: {
                items,
                totalPages: 1,
                untitledLabel: 'Untitled',
            }},
            modifiedAt: 'D:20261013000000Z',
        });
        if (isBrowserPageOpsWasmFailure(saved)) {
            throw new Error(`Bookmark save failed: ${JSON.stringify(saved)}`);
        }
        const reopened = await PDFDocument.load(saved.data);
        let row = reopened.catalog.lookup(PDFName.of('Outlines'), PDFDict).lookupMaybe(PDFName.of('First'), PDFDict);
        const titles: string[] = [];
        while (row) {
            titles.push(row.lookup(PDFName.of('Title'), PDFString, PDFHexString).decodeText());
            row = row.lookupMaybe(PDFName.of('Next'), PDFDict);
        }
        results.push({
            count,
            reopenedCount: titles.length,
            renamedTitle: titles.at(-1),
            unchangedTitles: titles.slice(0, -1).every((title, index) => title === `Section${index + 1}`),
        });
    }
    return results;
}
Reflect.set(globalThis, '__evbRunBrowserBookmarkSaveAcceptance', runBrowserBookmarkSaveAcceptance);

// Large documents ----------------------------------------------------------------------------------------------
// The page tool edits documents larger than its 32-bit memory by reading and writing files. Fixtures are written
// straight into the origin private file system by a worker; page i of a fixture is 100 + i points wide, pages from
// the third are labelled in roman numerals, and one bookmark targets the third page.

function writeLargeFixture() {
    self.onmessage = async (event: MessageEvent<{name: string; pageCount: number; streamBytes: number}>) => {
        const {name, pageCount, streamBytes} = event.data;
        const root = await navigator.storage.getDirectory();
        const handle = await (await root.getFileHandle(name, {create: true})).createSyncAccessHandle();
        handle.truncate(0);
        let offset = 0;
        const offsets: number[] = [];
        const write = (data: string | Uint8Array) => {
            const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
            if (handle.write(bytes, {at: offset}) !== bytes.byteLength) throw new Error('The fixture did not fit');
            offset += bytes.byteLength;
        };
        const object = (id: number, body: string) => {
            offsets[id] = offset;
            write(`${id} 0 obj\n${body}\nendobj\n`);
        };
        const filler = new Uint8Array(8 * 1024 * 1024).fill(0x20);
        const pageId = (index: number) => 7 + 2 * index;
        write('%PDF-1.7\n');
        object(1, '<< /Type /Catalog /Pages 2 0 R /Outlines 3 0 R /PageLabels << /Nums [0 5 0 R 2 6 0 R] >> >>');
        object(2, `<< /Type /Pages /Count ${pageCount} /Kids [${Array.from({length: pageCount}, (_, index) => `${pageId(index)} 0 R`).join(' ')}] >>`);
        object(3, '<< /Type /Outlines /First 4 0 R /Last 4 0 R /Count 1 >>');
        object(4, `<< /Title (Third page) /Parent 3 0 R /Dest [${pageId(2)} 0 R /Fit] >>`);
        object(5, '<< /S /D >>');
        object(6, '<< /S /R >>');
        for (let index = 0; index < pageCount; index += 1) {
            object(pageId(index), `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${100 + index} 200] /Contents ${pageId(index) + 1} 0 R /Resources << >> >>`);
            offsets[pageId(index) + 1] = offset;
            write(`${pageId(index) + 1} 0 obj\n<< /Length ${streamBytes} >>\nstream\n`);
            for (let left = streamBytes; left > 0; left -= filler.byteLength) write(left >= filler.byteLength ? filler : filler.subarray(0, left));
            write('\nendstream\nendobj\n');
        }
        const xref = offset;
        const size = pageId(pageCount);
        write(`xref\n0 ${size}\n0000000000 65535 f \n${Array.from({length: size - 1}, (_, index) => `${String(offsets[index + 1]).padStart(10, '0')} 00000 n \n`).join('')}`);
        write(`trailer\n<< /Size ${size} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
        handle.flush();
        handle.close();
        self.postMessage(offset);
    };
}

async function createLargeFixture(name: string, pageCount: number, streamBytes: number) {
    const worker = new Worker(URL.createObjectURL(new Blob([`(${writeLargeFixture.toString()})()`], {type: 'text/javascript'})));
    try {
        return await new Promise<number>((resolve, reject) => {
            worker.onmessage = event => resolve(event.data as number);
            worker.onerror = event => reject(new Error(event.message));
            worker.postMessage({name, pageCount, streamBytes});
        });
    } finally {
        worker.terminate();
    }
}

async function opfsFile(name: string) {
    return (await navigator.storage.getDirectory()).getFileHandle(name, {create: true});
}

/** What PDF.js reads from `blob` by range: its pages' widths in order, the bookmark's page and the page labels. */
async function readWithPdfjs(blob: Blob) {
    const pdfjs = await import('pdfjs-dist');
    pdfjs.GlobalWorkerOptions.workerSrc = '/pdf.worker.mjs';
    class BlobRangeTransport extends pdfjs.PDFDataRangeTransport {
        public override requestDataRange(begin: number, end: number) {
            void blob.slice(begin, end).arrayBuffer().then(buffer => this.onDataRange(begin, new Uint8Array(buffer)));
        }
    }
    const loading = pdfjs.getDocument({
        range: new BlobRangeTransport(blob.size, new Uint8Array()),
        disableAutoFetch: true,
        disableStream: true,
        rangeChunkSize: 1024 * 1024,
    });
    const document = await loading.promise;
    try {
        const widths: number[] = [];
        for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
            widths.push((await document.getPage(pageNumber)).view[2]!);
        }
        const dest = (await document.getOutline())?.[0]?.dest;
        const target = Array.isArray(dest) ? dest[0] as {num: number; gen: number} : null;
        return {
            size: blob.size,
            pageCount: document.numPages,
            widths,
            outlinePage: target ? await document.getPageIndex(target) + 1 : null,
            labels: await document.getPageLabels(),
        };
    } finally {
        await loading.destroy();
    }
}

function createLargePageOps(extractHandle: () => Promise<FileSystemFileHandle>) {
    return createBrowserPageOpsCapability({
        clearSearchCaches: async () => undefined,
        openInputAccept: 'application/pdf',
        pickFiles: async () => [],
        buildOpenPdfPickerTypes: () => [],
        createCombinedPdfFromPaths,
        pickSaveTarget: async () => ({canceled: false, fileName: 'extract.pdf', handle: await extractHandle()}),
        saveBytesToPickerOrDownload: async () => ({canceled: true, fileName: ''}),
        writeBytesToHandle: async (handle, data) => {
            const writable = await handle.createWritable();
            await writable.write(data as Blob);
            await writable.close();
        },
    });
}

const tokenOf = async (ref: string) => ({expectedDocumentRevisionToken: (await browserDocumentStore.getDocumentRevision(ref)).token});

async function timed<T>(run: () => Promise<T>) {
    const started = performance.now();
    const result = await run();
    return {ms: Math.round(performance.now() - started), result};
}

const largeScenarios = {
    createFixture: createLargeFixture,
    /** A working copy of the OPFS file `name`, opened through its handle as a picked file is: no copy is made. */
    async open(name: string) {
        const handle = await opfsFile(name);
        const source = await browserDocumentStore.registerFile(await handle.getFile(), {saveHandle: handle});
        return browserDocumentStore.cloneAsWorkingCopy(source);
    },
    async storeSmallPdf(name: string) {
        const document = await PDFDocument.create();
        document.addPage([999, 200]);
        return browserDocumentStore.createStoredDocument(name, new Uint8Array(await document.save()), {mimeType: 'application/pdf', kind: 'source', saveKind: 'pdf'});
    },
    async run(operation: 'delete' | 'reorder' | 'insert' | 'extract' | 'merge', ref: string, pageCount: number, other = '') {
        const pageOps = createLargePageOps(() => opfsFile(`${other || 'extract'}.pdf`));
        const pages = Array.from({length: pageCount}, (_, index) => index + 1);
        try {
            const {ms, result} = await timed(async (): Promise<unknown> => {
                switch (operation) {
                    case 'delete': return pageOps.delete(ref, [2], pageCount, await tokenOf(ref));
                    case 'reorder': return pageOps.reorder(ref, pages.toReversed(), await tokenOf(ref));
                    case 'insert': return pageOps.insertFile(ref, pageCount, 1, [other], undefined, await tokenOf(ref));
                    case 'extract': return pageOps.extract(ref, [1, 3, pageCount]);
                    case 'merge': return createCombinedPdfFromPaths([ref, other]);
                }
            });
            return {ms, result: JSON.parse(JSON.stringify(result ?? null)) as unknown};
        } catch (error) {
            return {error: error instanceof Error ? {name: error.name, message: error.message} : String(error)};
        }
    },
    /** The current bytes of the store document `ref`, or of the OPFS file named `ref`, as PDF.js reads them. */
    async inspect(ref: string) {
        return readWithPdfjs(ref.includes('://') ? await browserDocumentStore.readableBlob(ref) : await (await opfsFile(ref)).getFile());
    },
    async revision(ref: string) {
        return (await browserDocumentStore.getDocumentRevision(ref)).token;
    },
    async files(ref: string) {
        const doc = await browserDocumentStore.documentOf(ref);
        if (!doc) return null;
        let dir = await navigator.storage.getDirectory();
        for (const name of ['documents', doc.id]) dir = await dir.getDirectoryHandle(name);
        const files: Array<[string, number]> = [];
        for await (const [name, handle] of dir as unknown as AsyncIterable<[string, FileSystemFileHandle]>) files.push([name, (await handle.getFile()).size]);
        return files.sort();
    },
    /** Saves the working copy to its file through the file's handle. */
    async save(ref: string) {
        return (await timed(async () => (await browserDocumentStore.save(ref, (await tokenOf(ref)).expectedDocumentRevisionToken)).status));
    },
    /** Starts a download of the document's bytes, for checks outside the browser. */
    async download(ref: string, fileName: string) {
        const link = document.createElement('a');
        link.href = URL.createObjectURL(ref.includes('://') ? await browserDocumentStore.readableBlob(ref) : await (await opfsFile(ref)).getFile());
        link.download = fileName;
        link.click();
    },
    async remove(ref: string) {
        await browserDocumentStore.remove(ref);
    },
};
Reflect.set(globalThis, '__evbLargePageOps', largeScenarios);
