// fallow-ignore-file unused-file -- bundled by browserPageOpsAcceptance.test.ts for Chromium.

import {
    PDFDocument,
    PDFName,
    PDFNumber,
    PDFString,
} from 'pdf-lib';
import type {
    PDFArray,
    PDFDict,
    PDFRef,
} from 'pdf-lib';
import {createBrowserPageOpsCapability} from '@app/platform/browser-api/createBrowserPageOpsCapability';
import {readPdfCatalog} from '@app/platform/browser-api/browserPageOpsCore';
import {browserDocumentStore} from '@app/platform/browserDocumentStore';

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

function readLabels(document: PDFDocument) {
    const pageLabels = lookupDict(document, document.catalog.get(PDFName.of('PageLabels')));
    const nums = pageLabels.get(PDFName.of('Nums')) as PDFArray;
    const labels: string[] = [];
    for (let index = 0; index < nums.size(); index += 2) {
        const label = lookupDict(document, nums.get(index + 1));
        labels.push((label.get(PDFName.of('P')) as PDFString).decodeText());
    }
    return labels;
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
            createCombinedPdfFromPaths: async () => new Uint8Array(),
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
        ? {Nums: []}
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
                createCombinedPdfFromPaths: async () => new Uint8Array(),
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
