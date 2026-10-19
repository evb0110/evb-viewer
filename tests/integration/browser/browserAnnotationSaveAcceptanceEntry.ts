// fallow-ignore-file unused-file -- bundled by browserAnnotationSaveAcceptance.test.ts for Chromium.

import {
    PDFDocument,
    PDFHexString,
    PDFName,
    PDFNumber,
    PDFString,
} from 'pdf-lib';
import {layoutPdfForPrint} from '@app/platform/browser-api/browserPageOpsCore';
import {createBrowserDocumentsFileCapability} from '@app/platform/browser-api/createBrowserDocumentsFileCapability';
import {
    BROWSER_MAX_FULL_READ_BYTES,
    browserDocumentStore,
} from '@app/platform/browserDocumentStore';
import {
    requireDocumentRef,
    type TLegacyDocumentRef,
} from '@contracts/documentRef';
import {requirePdfDateString} from '@contracts/pdfDateString';

const FULL_READ_CAP_MESSAGE = 'Use the native app for files this large.';

async function createAnnotatedFixture(paddingBytes = 0) {
    const document = await PDFDocument.create();
    const page = document.addPage([
        200,
        100,
    ]);
    const annotation = document.context.register(document.context.obj({
        Type: PDFName.of('Annot'),
        Subtype: PDFName.of('Text'),
        Rect: [
            PDFNumber.of(20),
            PDFNumber.of(20),
            PDFNumber.of(40),
            PDFNumber.of(40),
        ],
        Contents: PDFHexString.fromText('до Привет café'),
        T: PDFString.of('Browser acceptance'),
        NM: PDFString.of('browser-acceptance-note'),
        M: PDFString.of('D:20260101000000Z'),
        CreationDate: PDFString.of('D:20260101000000Z'),
        Open: false,
    }));
    page.node.set(PDFName.of('Annots'), document.context.obj([annotation]));
    if (paddingBytes > 0) {
        document.catalog.set(PDFName.of('LargeFixture'), document.context.register(document.context.stream(new Uint8Array(paddingBytes))));
    }
    return new Uint8Array(await document.save({useObjectStreams: false}));
}

function createCapability() {
    return createBrowserDocumentsFileCapability({
        clearSearchCaches: async () => undefined,
        errorMessageProvider: {
            largeSaveHandleHint: () => 'Use the native app to save this file.',
            useNativeApp: () => FULL_READ_CAP_MESSAGE,
        },
    });
}

async function runUnderCapFlow() {
    const previousPicker = Reflect.get(window, 'showSaveFilePicker');
    Reflect.set(window, 'showSaveFilePicker', undefined);
    const sourcePath: TLegacyDocumentRef = requireDocumentRef(await browserDocumentStore.createStoredDocument(
        'browser-annotation-acceptance.pdf',
        await createAnnotatedFixture(),
        {
            mimeType: 'application/pdf',
            kind: 'source',
            retention: 'transient',
            saveKind: 'pdf',
        },
    ));
    const capability = createCapability();
    let workingPath: TLegacyDocumentRef | undefined;
    try {
        const opened = await capability.openDocumentDirect(sourcePath);
        if (!opened || opened.kind !== 'pdf') {
            throw new Error('Browser annotation acceptance fixture did not open as a PDF');
        }
        workingPath = opened.workingPath;
        const openedRevision = await browserDocumentStore.getDocumentRevision(workingPath);
        const parsedBefore = await capability.parsePdfAnnotations(workingPath, {expectedDocumentRevisionToken: openedRevision.token});
        const note = parsedBefore.entities.find(entity => entity.kind === 'note');
        if (!note) {
            throw new Error('Browser annotation acceptance fixture did not open with a note');
        }

        const applied = await capability.applyPdfNativeMutationsToWorkingCopy!(
            workingPath,
            {
                updates: [{
                    objectNumber: note.objectNumber,
                    generationNumber: note.generationNumber,
                    text: 'после Привет café',
                }],
                geometryUpdates: [{
                    objectNumber: note.objectNumber,
                    generationNumber: note.generationNumber,
                    pageIndex: note.pageIndex,
                    markerRect: note.position,
                    color: '#00aaff',
                    open: true,
                }],
            },
            requirePdfDateString('D:20260102000000Z'),
            {expectedDocumentRevisionToken: openedRevision.token},
        );
        if (!applied.applied || !applied.stagedOutput || !applied.nativeMutationPostconditionsVerified) {
            throw new Error('Browser annotation acceptance save did not produce a verified staged result');
        }

        const committed = await capability.commitStagedPdfNativeMutations!(
            workingPath,
            applied.stagedOutput,
            {
                expectedDocumentRevisionToken: openedRevision.token,
                ...(applied.identityBindings ? {identityBindings: [...applied.identityBindings]} : {}),
            },
        );
        if (!committed.applied || !committed.nativeMutationPostconditionsVerified) {
            throw new Error('Browser annotation acceptance save did not commit the canonical writer result');
        }

        browserDocumentStore.unload(sourcePath);
        const reopenedRevision = await browserDocumentStore.getDocumentRevision(sourcePath);
        const parsedAfter = await capability.parsePdfAnnotations(sourcePath, {expectedDocumentRevisionToken: reopenedRevision.token});
        const reopenedNote = parsedAfter.entities.find(entity => entity.kind === 'note');
        return {
            openedWithAnnotations: note.contents === 'до Привет café',
            canonicalWriterVerified: committed.nativeMutationPostconditionsVerified,
            savedAndReopened: reopenedNote?.contents === 'после Привет café'
                && reopenedNote.color === '#00aaff'
                && reopenedNote.open === true,
        };
    } finally {
        if (workingPath) {
            await browserDocumentStore.remove(workingPath).catch(() => undefined);
        }
        await browserDocumentStore.remove(sourcePath).catch(() => undefined);
        Reflect.set(window, 'showSaveFilePicker', previousPicker);
    }
}

async function runOverCapFlow() {
    const oversized = await createAnnotatedFixture(BROWSER_MAX_FULL_READ_BYTES);
    const sourcePath: TLegacyDocumentRef = requireDocumentRef(await browserDocumentStore.createStoredDocument(
        'browser-annotation-over-cap.pdf',
        oversized,
        {
            mimeType: 'application/pdf',
            kind: 'source',
            retention: 'transient',
            saveKind: 'pdf',
        },
    ));
    const capability = createCapability();
    let saveMessage = '';
    let workingPath: TLegacyDocumentRef | undefined;
    try {
        const opened = await capability.openDocumentDirect(sourcePath);
        if (!opened || opened.kind !== 'pdf') {
            throw new Error('Large annotation acceptance fixture did not open as a PDF');
        }
        workingPath = opened.workingPath;
        const rangeOffset = BROWSER_MAX_FULL_READ_BYTES - 8;
        const range = await capability.readFileRange(workingPath, rangeOffset, 32);
        const revision = await browserDocumentStore.getDocumentRevision(workingPath);
        const parsed = await capability.parsePdfAnnotations(workingPath, {expectedDocumentRevisionToken: revision.token});
        try {
            await capability.applyPdfNativeMutationsToWorkingCopy!(
                workingPath,
                {updates: [{
                    objectNumber: 1,
                    generationNumber: 0,
                    text: 'after',
                }]},
                requirePdfDateString('D:20260102000000Z'),
                {expectedDocumentRevisionToken: revision.token},
            );
        } catch (error) {
            saveMessage = error instanceof Error ? error.message : String(error);
        }
        return {
            openedWithAnnotations: parsed.entities.some(entity => entity.kind === 'note' && entity.contents === 'до Привет café'),
            rangeReadsPreserved: range.byteLength === 32 && range.every((byte, index) => byte === oversized[rangeOffset + index]),
            saveMessage,
            saveRejectedWithLocalizedCap: saveMessage.includes(FULL_READ_CAP_MESSAGE),
        };
    } finally {
        if (workingPath) {
            await browserDocumentStore.remove(workingPath).catch(() => undefined);
        }
        await browserDocumentStore.remove(sourcePath).catch(() => undefined);
    }
}

async function runAcceptance() {
    return {
        underCap: await runUnderCapFlow(),
        overCap: await runOverCapFlow(),
    };
}

Reflect.set(globalThis, '__evbRunBrowserAnnotationSaveAcceptance', runAcceptance);

// The existing browser lane drives this button with trusted input and observes
// long tasks, rather than asserting worker messages or private call sequences.
async function preparePrintResponsivenessAcceptance(input: Uint8Array) {
    const button = document.createElement('button');
    button.textContent = 'Prepare facing print';
    document.body.append(button);
    const response = new Promise<{
        pageCount: number;
        inputPreserved: boolean;
        longTasks: number[]
    }>((resolveResult, rejectResult) => {
        button.addEventListener('click', () => {
            const longTasks: number[] = [];
            const observer = new PerformanceObserver(entries => {
                longTasks.push(...entries.getEntries().map(entry => entry.duration));
            });
            observer.observe({type: 'longtask'});
            void layoutPdfForPrint(input, {
                viewMode: 'facing',
                orientation: 'landscape',
            })
                .then(async (result) => {
                    // Let the performance observer deliver its final entries
                    // before inspecting the written PDF.
                    await new Promise<void>(resolveFrame => requestAnimationFrame(() => resolveFrame()));
                    observer.disconnect();
                    const output = await PDFDocument.load(result.data);
                    resolveResult({
                        pageCount: output.getPageCount(),
                        inputPreserved: input.byteLength > 0 && (await PDFDocument.load(input)).getPageCount() === 4_000,
                        longTasks,
                    });
                }).catch(rejectResult);
        }, {once: true});
    });
    Reflect.set(globalThis, '__evbPrintResponsivenessResult', response);
}

Reflect.set(globalThis, '__evbPreparePrintResponsivenessAcceptance', preparePrintResponsivenessAcceptance);
