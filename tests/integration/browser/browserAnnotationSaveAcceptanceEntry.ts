// fallow-ignore-file unused-file -- bundled by browserAnnotationSaveAcceptance.test.ts for Chromium.

import {
    PDFDocument,
    PDFHexString,
    PDFName,
    PDFNumber,
    PDFString,
} from 'pdf-lib';
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

async function createAnnotatedFixture() {
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
    return new Uint8Array(await document.save());
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

        const reopenedRevision = await browserDocumentStore.getDocumentRevision(workingPath);
        const parsedAfter = await capability.parsePdfAnnotations(workingPath, {expectedDocumentRevisionToken: reopenedRevision.token});
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
    }
}

async function runOverCapFlow() {
    const oversized = new Uint8Array(BROWSER_MAX_FULL_READ_BYTES + 1);
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
    let openMessage = '';
    let saveMessage = '';
    try {
        await capability.openDocumentDirect(sourcePath);
    } catch (error) {
        openMessage = error instanceof Error ? error.message : String(error);
    }
    const workingPath: TLegacyDocumentRef = requireDocumentRef(await browserDocumentStore.createStoredDocument(
        'browser-annotation-over-cap-working.pdf',
        oversized,
        {
            mimeType: 'application/pdf',
            kind: 'working',
            retention: 'transient',
            saveKind: 'pdf',
        },
    ));
    try {
        const revision = await browserDocumentStore.getDocumentRevision(workingPath);
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
    } finally {
        await browserDocumentStore.remove(workingPath).catch(() => undefined);
        await browserDocumentStore.remove(sourcePath).catch(() => undefined);
    }
    return {
        openMessage,
        saveMessage,
        openRejectedWithLocalizedCap: openMessage.includes(FULL_READ_CAP_MESSAGE),
        saveRejectedWithLocalizedCap: saveMessage.includes(FULL_READ_CAP_MESSAGE),
    };
}

async function runAcceptance() {
    return {
        underCap: await runUnderCapFlow(),
        overCap: await runOverCapFlow(),
    };
}

Reflect.set(globalThis, '__evbRunBrowserAnnotationSaveAcceptance', runAcceptance);
