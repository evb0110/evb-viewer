import type {
    ICreateCombinedPdfFromFilesOptions,
    IDocumentChunkReadResult,
    IWorkingCopyBackingStatus,
    TDocumentChunkSource,
} from '@contracts/electronApiDocuments';
import {decodeWorkingCopyBackingStatus} from '@contracts/electronApiDocuments';
import {
    definePlatformFeature,
    runtimeSchema as s,
    type IRuntimeSchema,
    type TFeatureCapability,
    type TFeatureEventMap,
    type TFeatureInvokeMap,
} from '@contracts/platformFeature';
import {
    applyNativeMutationsArgs,
    booleanResult,
    bytesResult,
    cancelOpenBatchArgs,
    cancellationResult,
    cancelRequestArgs,
    cloneStagedNativeMutationArgs,
    commitNativeMutationsArgs,
    createWorkingCopyFromDataArgs,
    createWorkingCopyFromPathArgs,
    decodeConformanceResult,
    decodePlatformOperationResult,
    decodePrintResult,
    documentRevisionArgs,
    documentRevisionEvent,
    documentSaveResult,
    fileExistsArgs,
    fileStatResult,
    fixtureRevisionOptions,
    folderDialogResult,
    longNativeIpcTimeoutMs,
    managedHandleArgs,
    managedHandleResult,
    menuStateArgs,
    nativeMutationsArgs,
    nativeNoteChangesArgs,
    nativeNoteTextArgs,
    nativeSaveResult,
    noPayload,
    nonNegativeInteger,
    nullableStringResult,
    openBatchProgress,
    openDocumentDirectArgs,
    openDocumentDirectBatchArgs,
    openFileResult,
    openingGeometryArgs,
    openingGeometryResult,
    openPdfPathArgs,
    optimizeAsCopyArgs,
    optimizeInteractionArgs,
    optimizeProgress,
    optimizeResult,
    pagePreviewArgs,
    pagePreviewResult,
    pageSizesArgs,
    pageSizesResult,
    pathArgs,
    pdfDataArgs,
    pdfPathArgs,
    printPdfDataArgs,
    printPdfPathArgs,
    readFileArgs,
    readFileRangeArgs,
    readTextFileArgs,
    recentFilesResult,
    releaseManagedHandleArgs,
    repairPdfArgs,
    replaceWorkingCopyArgs,
    replaceWorkingCopyFromStagedNativeMutationArgs,
    revisionResult,
    saveFileStructuredArgs,
    savePdfAsArgs,
    savePdfDialogArgs,
    showItemResult,
    statFileArgs,
    validationResult,
    writeDocxArgs,
    writeFileArgs,
    type TDocumentMethodArgs,
    type TDocumentMethodResult,
} from '@contracts/documentsPlatformFeatureSchemas';
import {decodePdfNativePrintDialogOpenedEvent} from '@contracts/pdfPathPrintOptions';
import {
    beginPdfAnnotationIndexArgs,
    cancelPdfAnnotationIndexArgs,
    pdfAnnotationIndexCancelResult,
    pdfAnnotationIndexChunkResult,
    pdfAnnotationIndexSessionResult,
    readPdfAnnotationIndexChunkArgs,
    releasePdfAnnotationIndexArgs,
} from '@contracts/pdfAnnotationIndexSchemas';
import {
    beginPdfAnnotationParseArgs,
    cancelPdfAnnotationParseArgs,
    parsePdfAnnotationsArgs,
    pdfAnnotationParseCancelResult,
    pdfAnnotationParseChunkResult,
    pdfAnnotationParseResult,
    pdfAnnotationParseSessionResult,
    readPdfAnnotationParseChunkArgs,
    releasePdfAnnotationParseArgs,
} from '@contracts/pdfAnnotationParseSchemas';
import {
    beginPdfEmbeddedShapeIndexArgs,
    cancelPdfEmbeddedShapeIndexArgs,
    pdfEmbeddedShapeIndexCancelResult,
    pdfEmbeddedShapeIndexChunkResult,
    pdfEmbeddedShapeIndexSessionResult,
    readPdfEmbeddedShapeIndexChunkArgs,
    releasePdfEmbeddedShapeIndexArgs,
} from '@contracts/pdfEmbeddedShapeIndexSchemas';
import {pdfValidationPathArgs} from '@contracts/pdfValidationPathArgs';
export {decodeOpenFileResult} from '@contracts/documentsPlatformFeatureSchemas';

const optionalEverywhere = {
    browser: false,
    electron: false,
} as const;
const requiredEverywhere = {
    browser: true,
    electron: true,
} as const;
const browserImplementedOptional = {
    optionalWhenImplemented: true,
    required: optionalEverywhere,
} as const;
const electronImplementedOptional = {
    ...browserImplementedOptional,
    browser: {
        unsupported: 'omitted',
        reason: 'requires-native-backend',
    },
} as const;
const noArgs = s.tuple([]);
const voidResult = s.undefined();
const stringResult = s.string('/tmp/document.pdf');
const stringArrayResult = s.array(stringResult, ['/tmp/document.pdf']);
const fileArgs = s.trustedDirect<[file: File]>(() => [{} as File]);
const filesArgs = s.trustedDirect<[files: File[]]>(() => [[{} as File]]);
const combinedFilesArgs = s.trustedDirect<[
    files: File[],
    options?: ICreateCombinedPdfFromFilesOptions,
]>(() => [[{} as File]]);
const combinedPdfResult = s.trustedDirect<Uint8Array>(() => new Uint8Array());
const workingCopyBackingStatusArgs = pathArgs('path');
const workingCopyBackingStatus = s.fromParser<IWorkingCopyBackingStatus>(
    value => decodeWorkingCopyBackingStatus(value) ?? fail('invalid working-copy backing status'),
    () => ({
        documentRef: '/tmp/document.pdf',
        failure: null,
        progress: 0.5,
        state: 'materializing',
    }),
);
const nullableWorkingCopyBackingStatus = s.fromParser<IWorkingCopyBackingStatus | null>(
    value => value === null
        ? null
        : decodeWorkingCopyBackingStatus(value) ?? fail('invalid working-copy backing status'),
    () => null,
);

function fail(message: string): never {
    throw new Error(message);
}

function defineIpcMethod<
    const TName extends string,
    const TChannel extends string,
    const TArgs extends IRuntimeSchema<unknown[]>,
    const TResult extends IRuntimeSchema<unknown>,
    const TMain extends string,
    const TContext extends 'none' | 'sender',
>(
    name: TName,
    channel: TChannel,
    args: TArgs,
    result: TResult,
    main: TMain,
    context: TContext,
) {
    return {
        kind: 'async',
        channel,
        ipc: {
            args,
            result,
        },
        main: {
            method: main,
            context,
        },
        browser: {method: name},
        lazy: 'forwarded',
    } as const;
}

function defineLocalMethod<
    const TName extends string,
    const TKind extends 'async' | 'void',
    const TArgs extends IRuntimeSchema<unknown[]>,
    const TResult extends IRuntimeSchema<unknown>,
>(name: TName, kind: TKind, args: TArgs, result: TResult) {
    return {
        kind,
        local: {
            args,
            result,
        },
        browser: {method: name},
        lazy: 'forwarded',
    } as const;
}

function defineEvent<
    const TName extends string,
    const TChannel extends string,
    const TPayload extends IRuntimeSchema<unknown>,
>(name: TName, channel: TChannel, payload: TPayload) {
    return {
        kind: 'event',
        channel,
        payload,
        browser: {method: name},
        lazy: 'forwarded',
    } as const;
}

const openDocumentDialog = defineIpcMethod(
    'openDocumentDialog',
    'dialog:openPdf',
    noArgs,
    openFileResult,
    'openDocumentDialog',
    'sender',
);
const openDocumentBatchProgressEvent = defineEvent(
    'onOpenDocumentDirectBatchProgress',
    'dialog:openPdfDirectBatch:progress',
    openBatchProgress,
);

export const DOCUMENT_PICKER_PLATFORM_FEATURE = definePlatformFeature({
    path: ['documentPicker'],
    required: requiredEverywhere,
    manifestPath: [
        'documents',
        'picker',
    ],
    methods: {
        openDocumentDialog,
        openCombineDialog: defineIpcMethod(
            'openCombineDialog', 'dialog:openCombine', noArgs, openFileResult, 'openCombineDialog', 'sender',
        ),
        openFolderDialog: defineIpcMethod(
            'openFolderDialog', 'dialog:openFolder', noArgs, openFileResult, 'openFolderDialog', 'sender',
        ),
        openFolderDialogStructured: {
            ...defineLocalMethod('openFolderDialogStructured', 'async', noArgs, folderDialogResult),
            ...browserImplementedOptional,
        },
        openImageDialog: defineIpcMethod(
            'openImageDialog', 'dialog:openImage', noArgs, nullableStringResult, 'openImageDialog', 'sender',
        ),
        getPathForFile: {
            kind: 'sync',
            args: fileArgs,
            result: stringResult,
            browser: {method: 'getPathForFile'},
            lazy: 'direct',
        },
        getPathsForFiles: {
            kind: 'sync',
            args: filesArgs,
            result: stringArrayResult,
            browser: {method: 'getPathsForFiles'},
            lazy: 'direct',
        },
        registerFilesForOpen: defineLocalMethod(
            'registerFilesForOpen', 'async', filesArgs, stringArrayResult,
        ),
        createCombinedPdfFromFiles: {
            ...defineLocalMethod('createCombinedPdfFromFiles', 'async', combinedFilesArgs, combinedPdfResult),
            ...browserImplementedOptional,
        },
    },
    events: {},
});

export const DOCUMENT_OPEN_PLATFORM_FEATURE = definePlatformFeature({
    path: ['documentOpen'],
    required: requiredEverywhere,
    methods: {
        openDocumentDirect: defineIpcMethod(
            'openDocumentDirect',
            'dialog:openPdfDirect',
            openDocumentDirectArgs,
            openFileResult,
            'openDocumentDirect',
            'sender',
        ),
        openDocumentDirectBatch: {
            ...defineIpcMethod(
                'openDocumentDirectBatch',
                'dialog:openPdfDirectBatch',
                openDocumentDirectBatchArgs,
                openFileResult,
                'openDocumentDirectBatch',
                'sender',
            ),
            ipc: {
                args: openDocumentDirectBatchArgs,
                result: openFileResult,
                timeoutMs: longNativeIpcTimeoutMs,
            },
        },
        cancelOpenDocumentDirectBatch: {
            ...defineIpcMethod(
                'cancelOpenDocumentDirectBatch',
                'dialog:openPdfDirectBatch:cancel',
                cancelOpenBatchArgs,
                booleanResult,
                'cancelOpenDocumentDirectBatch',
                'sender',
            ),
            ...electronImplementedOptional,
        },
    },
    events: {onOpenDocumentDirectBatchProgress: openDocumentBatchProgressEvent},
});

export const DOCUMENT_WORKING_COPY_PLATFORM_FEATURE = definePlatformFeature({
    path: ['documentWorkingCopy'],
    required: requiredEverywhere,
    methods: {
        createWorkingCopyFromData: defineIpcMethod(
            'createWorkingCopyFromData',
            'working-copy:createFromData',
            createWorkingCopyFromDataArgs,
            stringResult,
            'createWorkingCopyFromData',
            'sender',
        ),
        createWorkingCopyFromPath: defineIpcMethod(
            'createWorkingCopyFromPath',
            'working-copy:createFromPath',
            createWorkingCopyFromPathArgs,
            stringResult,
            'createWorkingCopyFromPath',
            'sender',
        ),
        parsePdfAnnotations: {
            ...defineIpcMethod(
                'parsePdfAnnotations',
                'working-copy:parseAnnotations',
                parsePdfAnnotationsArgs,
                pdfAnnotationParseResult,
                'parsePdfAnnotations',
                'sender',
            ),
            ipc: {
                args: parsePdfAnnotationsArgs,
                result: pdfAnnotationParseResult,
                timeoutMs: longNativeIpcTimeoutMs,
            },
        },
        cleanupFile: defineIpcMethod(
            'cleanupFile',
            'file:cleanup',
            pathArgs('path'),
            voidResult,
            'cleanupFile',
            'sender',
        ),
        cleanupOcrTemp: defineIpcMethod(
            'cleanupOcrTemp',
            'file:cleanupOcrTemp',
            pathArgs('path'),
            s.declared<undefined>()(s.fromParser(
                value => value === undefined || typeof value === 'boolean'
                    ? undefined as never
                    : fail('expected a void IPC result'),
                () => undefined,
            )),
            'cleanupOcrTemp',
            'sender',
        ),
    },
    events: {},
});

const readFileChunksArgs = s.trustedDirect<TDocumentMethodArgs<'readFileChunks'>>(() => [
    '/tmp/document.pdf',
    {},
    () => undefined,
]);
const readFileChunksResult = s.trustedDirect<IDocumentChunkReadResult>(() => ({
    size: 1,
    bytesRead: 1,
    chunks: 1,
}));
const savePdfDataAsLocalArgs = s.trustedDirect<TDocumentMethodArgs<'savePdfDataAs'>>(() => [
    '/tmp/working.pdf',
    Uint8Array.of(1),
    undefined,
    fixtureRevisionOptions,
]);
const savePdfDataAsLocalResult = s.trustedDirect<TDocumentMethodResult<'savePdfDataAs'>>(() => ({
    path: '/tmp/saved.pdf',
    validation: null,
}));
const savePdfDataLocalArgs = s.trustedDirect<TDocumentMethodArgs<'savePdfData'>>(() => [
    '/tmp/working.pdf',
    Uint8Array.of(1),
    fixtureRevisionOptions,
]);
const savePdfDataChunksLocalArgs = s.trustedDirect<TDocumentMethodArgs<'savePdfDataChunks'>>(() => [
    '/tmp/working.pdf',
    1,
    [Uint8Array.of(1)] satisfies TDocumentChunkSource,
    fixtureRevisionOptions,
]);

export const DOCUMENT_FILES_PLATFORM_FEATURE = definePlatformFeature({
    path: ['documentFiles'],
    required: requiredEverywhere,
    methods: {
        readFile: defineIpcMethod(
            'readFile', 'file:read', readFileArgs, bytesResult, 'readFile', 'sender',
        ),
        statFile: defineIpcMethod(
            'statFile', 'file:stat', statFileArgs, fileStatResult, 'statFile', 'sender',
        ),
        readFileRange: defineIpcMethod(
            'readFileRange', 'file:readRange', readFileRangeArgs, bytesResult, 'readFileRange', 'sender',
        ),
        getPdfOpeningGeometry: {
            ...defineIpcMethod(
                'getPdfOpeningGeometry', 'pdf:openingGeometry', openingGeometryArgs,
                openingGeometryResult, 'getPdfOpeningGeometry', 'sender',
            ),
            ipc: {
                args: openingGeometryArgs,
                result: openingGeometryResult,
                timeoutMs: longNativeIpcTimeoutMs,
            },
            ...electronImplementedOptional,
        },
        getPdfNativePageSizes: {
            ...defineIpcMethod(
                'getPdfNativePageSizes', 'pdf:nativePageSizes', pageSizesArgs,
                pageSizesResult, 'getPdfNativePageSizes', 'sender',
            ),
            ipc: {
                args: pageSizesArgs,
                result: pageSizesResult,
                timeoutMs: longNativeIpcTimeoutMs,
            },
            ...electronImplementedOptional,
        },
        cancelPdfNativePagePreview: {
            ...defineIpcMethod(
                'cancelPdfNativePagePreview', 'pdf:nativePagePreview:cancel', cancelRequestArgs,
                cancellationResult, 'cancelPdfNativePagePreview', 'sender',
            ),
            ...electronImplementedOptional,
        },
        renderPdfNativePagePreview: {
            ...defineIpcMethod(
                'renderPdfNativePagePreview', 'pdf:nativePagePreview', pagePreviewArgs,
                pagePreviewResult, 'renderPdfNativePagePreview', 'sender',
            ),
            ipc: {
                args: pagePreviewArgs,
                result: pagePreviewResult,
                timeoutMs: longNativeIpcTimeoutMs,
            },
            ...electronImplementedOptional,
        },
        beginPdfAnnotationIndex: {
            ...defineIpcMethod(
                'beginPdfAnnotationIndex', 'pdf:annotationIndex:begin', beginPdfAnnotationIndexArgs,
                pdfAnnotationIndexSessionResult, 'beginPdfAnnotationIndex', 'sender',
            ),
            ipc: {
                args: beginPdfAnnotationIndexArgs,
                result: pdfAnnotationIndexSessionResult,
                timeoutMs: longNativeIpcTimeoutMs,
            },
            ...electronImplementedOptional,
        },
        readPdfAnnotationIndexChunk: {
            ...defineIpcMethod(
                'readPdfAnnotationIndexChunk', 'pdf:annotationIndex:readChunk', readPdfAnnotationIndexChunkArgs,
                pdfAnnotationIndexChunkResult, 'readPdfAnnotationIndexChunk', 'sender',
            ),
            ...electronImplementedOptional,
        },
        releasePdfAnnotationIndex: {
            ...defineIpcMethod(
                'releasePdfAnnotationIndex', 'pdf:annotationIndex:release', releasePdfAnnotationIndexArgs,
                booleanResult, 'releasePdfAnnotationIndex', 'sender',
            ),
            ...electronImplementedOptional,
        },
        cancelPdfAnnotationIndex: {
            ...defineIpcMethod(
                'cancelPdfAnnotationIndex', 'pdf:annotationIndex:cancel', cancelPdfAnnotationIndexArgs,
                pdfAnnotationIndexCancelResult, 'cancelPdfAnnotationIndex', 'sender',
            ),
            ...electronImplementedOptional,
        },
        beginPdfAnnotationParse: {
            ...defineIpcMethod(
                'beginPdfAnnotationParse', 'pdf:annotationParse:begin', beginPdfAnnotationParseArgs,
                pdfAnnotationParseSessionResult, 'beginPdfAnnotationParse', 'sender',
            ),
            ipc: {
                args: beginPdfAnnotationParseArgs,
                result: pdfAnnotationParseSessionResult,
                timeoutMs: longNativeIpcTimeoutMs,
            },
            ...electronImplementedOptional,
        },
        readPdfAnnotationParseChunk: {
            ...defineIpcMethod(
                'readPdfAnnotationParseChunk', 'pdf:annotationParse:readChunk', readPdfAnnotationParseChunkArgs,
                pdfAnnotationParseChunkResult, 'readPdfAnnotationParseChunk', 'sender',
            ),
            ...electronImplementedOptional,
        },
        releasePdfAnnotationParse: {
            ...defineIpcMethod(
                'releasePdfAnnotationParse', 'pdf:annotationParse:release', releasePdfAnnotationParseArgs,
                booleanResult, 'releasePdfAnnotationParse', 'sender',
            ),
            ...electronImplementedOptional,
        },
        cancelPdfAnnotationParse: {
            ...defineIpcMethod(
                'cancelPdfAnnotationParse', 'pdf:annotationParse:cancel', cancelPdfAnnotationParseArgs,
                pdfAnnotationParseCancelResult, 'cancelPdfAnnotationParse', 'sender',
            ),
            ...electronImplementedOptional,
        },
        beginPdfEmbeddedShapeIndex: {
            ...defineIpcMethod(
                'beginPdfEmbeddedShapeIndex', 'pdf:embeddedShapeIndex:begin', beginPdfEmbeddedShapeIndexArgs,
                pdfEmbeddedShapeIndexSessionResult, 'beginPdfEmbeddedShapeIndex', 'sender',
            ),
            ipc: {
                args: beginPdfEmbeddedShapeIndexArgs,
                result: pdfEmbeddedShapeIndexSessionResult,
                timeoutMs: longNativeIpcTimeoutMs,
            },
            ...electronImplementedOptional,
        },
        readPdfEmbeddedShapeIndexChunk: {
            ...defineIpcMethod(
                'readPdfEmbeddedShapeIndexChunk', 'pdf:embeddedShapeIndex:readChunk', readPdfEmbeddedShapeIndexChunkArgs,
                pdfEmbeddedShapeIndexChunkResult, 'readPdfEmbeddedShapeIndexChunk', 'sender',
            ),
            ...electronImplementedOptional,
        },
        releasePdfEmbeddedShapeIndex: {
            ...defineIpcMethod(
                'releasePdfEmbeddedShapeIndex', 'pdf:embeddedShapeIndex:release', releasePdfEmbeddedShapeIndexArgs,
                booleanResult, 'releasePdfEmbeddedShapeIndex', 'sender',
            ),
            ...electronImplementedOptional,
        },
        cancelPdfEmbeddedShapeIndex: {
            ...defineIpcMethod(
                'cancelPdfEmbeddedShapeIndex', 'pdf:embeddedShapeIndex:cancel', cancelPdfEmbeddedShapeIndexArgs,
                pdfEmbeddedShapeIndexCancelResult, 'cancelPdfEmbeddedShapeIndex', 'sender',
            ),
            ...electronImplementedOptional,
        },
        readFileChunks: defineLocalMethod(
            'readFileChunks', 'async', readFileChunksArgs, readFileChunksResult,
        ),
        readTextFile: defineIpcMethod(
            'readTextFile', 'file:readText', readTextFileArgs, s.string(), 'readTextFile', 'sender',
        ),
        fileExists: defineIpcMethod(
            'fileExists', 'file:exists', fileExistsArgs, booleanResult, 'fileExists', 'sender',
        ),
        getDocumentRevision: defineIpcMethod(
            'getDocumentRevision', 'document:revision:get', documentRevisionArgs,
            revisionResult, 'getDocumentRevision', 'sender',
        ),
        getWorkingCopyBackingStatus: {
            ...defineIpcMethod(
                'getWorkingCopyBackingStatus',
                'working-copy:backing-status:get',
                workingCopyBackingStatusArgs,
                nullableWorkingCopyBackingStatus,
                'getWorkingCopyBackingStatus',
                'sender',
            ),
            ...electronImplementedOptional,
        },
        savePdfAs: defineIpcMethod(
            'savePdfAs', 'dialog:savePdfAs', savePdfAsArgs, nullableStringResult, 'savePdfAs', 'sender',
        ),
        savePdfDataAs: defineLocalMethod(
            'savePdfDataAs', 'async', savePdfDataAsLocalArgs, savePdfDataAsLocalResult,
        ),
        savePdfDialog: defineIpcMethod(
            'savePdfDialog', 'dialog:savePdfDialog', savePdfDialogArgs,
            nullableStringResult, 'savePdfDialog', 'sender',
        ),
        saveDocxAs: defineIpcMethod(
            'saveDocxAs', 'dialog:saveDocxAs', pathArgs('workingPath'),
            nullableStringResult, 'saveDocxAs', 'sender',
        ),
        writeFile: defineIpcMethod(
            'writeFile', 'file:write', writeFileArgs, booleanResult, 'writeFile', 'sender',
        ),
        replaceWorkingCopyFromPath: defineIpcMethod(
            'replaceWorkingCopyFromPath', 'file:replaceWorkingCopyFromPath', replaceWorkingCopyArgs,
            booleanResult, 'replaceWorkingCopyFromPath', 'sender',
        ),
        writeDocxFile: defineIpcMethod(
            'writeDocxFile', 'file:writeDocx', writeDocxArgs, booleanResult, 'writeDocxFile', 'sender',
        ),
        saveFileStructured: defineIpcMethod(
            'saveFileStructured', 'file:saveStructured', saveFileStructuredArgs,
            documentSaveResult, 'saveFileStructured', 'sender',
        ),
        resyncWorkingCopy: {
            ...defineIpcMethod(
                'resyncWorkingCopy', 'file:resyncWorkingCopy', pathArgs('path'),
                documentSaveResult, 'resyncWorkingCopy', 'sender',
            ),
            ...browserImplementedOptional,
        },
        savePdfData: defineLocalMethod(
            'savePdfData', 'async', savePdfDataLocalArgs, validationResult,
        ),
        savePdfDataChunks: defineLocalMethod(
            'savePdfDataChunks', 'async', savePdfDataChunksLocalArgs, validationResult,
        ),
        createManagedTempFileHandle: {
            ...defineIpcMethod(
                'createManagedTempFileHandle', 'file:createManagedHandle', managedHandleArgs,
                managedHandleResult, 'createManagedTempFileHandle', 'sender',
            ),
            ...electronImplementedOptional,
        },
        releaseManagedTempFileHandle: {
            ...defineIpcMethod(
                'releaseManagedTempFileHandle', 'file:releaseManagedHandle', releaseManagedHandleArgs,
                booleanResult, 'releaseManagedTempFileHandle', 'sender',
            ),
            ...electronImplementedOptional,
        },
        repairPdf: {
            ...defineIpcMethod(
                'repairPdf', 'file:repairPdf', repairPdfArgs,
                validationResult, 'repairPdf', 'sender',
            ),
            ipc: {
                args: repairPdfArgs,
                result: validationResult,
                timeoutMs: longNativeIpcTimeoutMs,
            },
            ...electronImplementedOptional,
        },
        optimizePdfForInteraction: {
            ...defineIpcMethod(
                'optimizePdfForInteraction', 'file:optimizePdfForInteraction', optimizeInteractionArgs,
                validationResult, 'optimizePdfForInteraction', 'sender',
            ),
            ipc: {
                args: optimizeInteractionArgs,
                result: validationResult,
                timeoutMs: longNativeIpcTimeoutMs,
            },
            ...electronImplementedOptional,
        },
        optimizePdfAsCopy: {
            ...defineIpcMethod(
                'optimizePdfAsCopy', 'file:optimizePdfAsCopy', optimizeAsCopyArgs,
                optimizeResult, 'optimizePdfAsCopy', 'sender',
            ),
            ipc: {
                args: optimizeAsCopyArgs,
                result: optimizeResult,
                timeoutMs: longNativeIpcTimeoutMs,
            },
            ...electronImplementedOptional,
        },
        savePdfNoteTextUpdates: {
            ...defineIpcMethod(
                'savePdfNoteTextUpdates', 'file:savePdfNoteTextUpdates', nativeNoteTextArgs,
                nativeSaveResult, 'savePdfNoteTextUpdates', 'sender',
            ),
            ipc: {
                args: nativeNoteTextArgs,
                result: nativeSaveResult,
                timeoutMs: longNativeIpcTimeoutMs,
            },
            ...electronImplementedOptional,
        },
        savePdfNoteChanges: {
            ...defineIpcMethod(
                'savePdfNoteChanges', 'file:savePdfNoteChanges', nativeNoteChangesArgs,
                nativeSaveResult, 'savePdfNoteChanges', 'sender',
            ),
            ipc: {
                args: nativeNoteChangesArgs,
                result: nativeSaveResult,
                timeoutMs: longNativeIpcTimeoutMs,
            },
            ...electronImplementedOptional,
        },
        savePdfNativeMutations: {
            ...defineIpcMethod(
                'savePdfNativeMutations', 'file:savePdfNativeMutations', nativeMutationsArgs,
                nativeSaveResult, 'savePdfNativeMutations', 'sender',
            ),
            ipc: {
                args: nativeMutationsArgs,
                result: nativeSaveResult,
                timeoutMs: longNativeIpcTimeoutMs,
            },
            ...electronImplementedOptional,
        },
        applyPdfNativeMutationsToWorkingCopy: {
            ...defineIpcMethod(
                'applyPdfNativeMutationsToWorkingCopy', 'file:applyPdfNativeMutationsToWorkingCopy',
                applyNativeMutationsArgs, nativeSaveResult, 'applyPdfNativeMutationsToWorkingCopy', 'sender',
            ),
            ipc: {
                args: applyNativeMutationsArgs,
                result: nativeSaveResult,
                timeoutMs: longNativeIpcTimeoutMs,
            },
            ...electronImplementedOptional,
            browser: {method: 'applyPdfNativeMutationsToWorkingCopy'},
        },
        commitStagedPdfNativeMutations: {
            ...defineIpcMethod(
                'commitStagedPdfNativeMutations', 'file:commitStagedPdfNativeMutations',
                commitNativeMutationsArgs, nativeSaveResult, 'commitStagedPdfNativeMutations', 'sender',
            ),
            ...electronImplementedOptional,
            browser: {method: 'commitStagedPdfNativeMutations'},
        },
        cloneStagedPdfNativeMutationToWorkingCopy: {
            ...defineIpcMethod(
                'cloneStagedPdfNativeMutationToWorkingCopy',
                'file:cloneStagedPdfNativeMutationToWorkingCopy',
                cloneStagedNativeMutationArgs,
                stringResult,
                'cloneStagedPdfNativeMutationToWorkingCopy',
                'sender',
            ),
            ipc: {
                args: cloneStagedNativeMutationArgs,
                result: stringResult,
                timeoutMs: longNativeIpcTimeoutMs,
            },
            ...electronImplementedOptional,
        },
        replaceWorkingCopyFromStagedPdfNativeMutation: {
            ...defineIpcMethod(
                'replaceWorkingCopyFromStagedPdfNativeMutation',
                'file:replaceWorkingCopyFromStagedPdfNativeMutation',
                replaceWorkingCopyFromStagedNativeMutationArgs,
                booleanResult,
                'replaceWorkingCopyFromStagedPdfNativeMutation',
                'sender',
            ),
            ipc: {
                args: replaceWorkingCopyFromStagedNativeMutationArgs,
                result: booleanResult,
                timeoutMs: longNativeIpcTimeoutMs,
            },
            ...electronImplementedOptional,
        },
    },
    events: {
        onDocumentRevisionChanged: defineEvent(
            'onDocumentRevisionChanged',
            'document:revision:changed',
            documentRevisionEvent,
        ),
        onWorkingCopyBackingStatusChanged: {
            ...defineEvent(
                'onWorkingCopyBackingStatusChanged',
                'working-copy:backing-status:changed',
                workingCopyBackingStatus,
            ),
            ...electronImplementedOptional,
        },
    },
});

export const DOCUMENT_PDF_PLATFORM_FEATURE = definePlatformFeature({
    path: ['documentPdf'],
    required: requiredEverywhere,
    methods: {
        analyzePdfConformance: {
            ...defineIpcMethod(
                'analyzePdfConformance', 'pdf:analyzeConformance', pdfPathArgs,
                s.fromParser(decodeConformanceResult, () => ({
                    isSigned: false,
                    isEncrypted: false,
                    isTagged: false,
                    pdfaLevel: null,
                    hasAcroForm: false,
                    hasXfa: false,
                    canIncrementalSave: true,
                    saveRestrictions: [],
                })), 'analyzePdfConformance', 'sender',
            ),
            ipc: {
                args: pdfPathArgs,
                result: s.fromParser(decodeConformanceResult, () => ({
                    isSigned: false,
                    isEncrypted: false,
                    isTagged: false,
                    pdfaLevel: null,
                    hasAcroForm: false,
                    hasXfa: false,
                    canIncrementalSave: true,
                    saveRestrictions: [],
                })),
                timeoutMs: longNativeIpcTimeoutMs,
            },
        },
        validatePdfData: defineIpcMethod(
            'validatePdfData', 'pdf:validateData', pdfDataArgs,
            validationResult, 'validatePdfData', 'none',
        ),
        validatePdfPath: {
            ...defineIpcMethod(
                'validatePdfPath', 'pdf:validatePath', pdfValidationPathArgs,
                validationResult, 'validatePdfPath', 'sender',
            ),
            ipc: {
                args: pdfValidationPathArgs,
                result: validationResult,
                timeoutMs: longNativeIpcTimeoutMs,
            },
        },
        openPdfInDefaultAppData: defineIpcMethod(
            'openPdfInDefaultAppData', 'pdf:openInDefaultAppData', pdfDataArgs,
            s.fromParser(decodePlatformOperationResult, () => ({success: true})),
            'openPdfInDefaultAppData', 'none',
        ),
        openPdfInDefaultAppPath: defineIpcMethod(
            'openPdfInDefaultAppPath', 'pdf:openInDefaultAppPath', openPdfPathArgs,
            s.fromParser(decodePlatformOperationResult, () => ({success: true})),
            'openPdfInDefaultAppPath', 'sender',
        ),
        printPdfData: defineIpcMethod(
            'printPdfData', 'pdf:printData', printPdfDataArgs,
            s.fromParser(decodePrintResult, () => ({success: true})),
            'printPdfData', 'sender',
        ),
        cancelPdfPrint: {
            ...defineIpcMethod(
                'cancelPdfPrint', 'pdf:print:cancel', cancelRequestArgs,
                cancellationResult, 'cancelPdfPrint', 'sender',
            ),
            ...electronImplementedOptional,
        },
        printPdfPath: defineIpcMethod(
            'printPdfPath', 'pdf:printPath', printPdfPathArgs,
            s.fromParser(decodePrintResult, () => ({success: true})),
            'printPdfPath', 'sender',
        ),
    },
    events: {onNativePrintDialogOpened: {
        ...defineEvent(
            'onNativePrintDialogOpened',
            'pdf:print:native-dialog-opened',
            s.fromParser(
                decodePdfNativePrintDialogOpenedEvent,
                () => ({requestId: 'print-request'}),
            ),
        ),
        ...electronImplementedOptional,
    }},
});

export const DOCUMENT_RECENT_FILES_PLATFORM_FEATURE = definePlatformFeature({
    path: [
        'documentRecentFiles',
        'recentFiles',
    ],
    capabilityPath: ['documentRecentFiles'],
    required: requiredEverywhere,
    manifestPath: [
        'documents',
        'recentFiles',
    ],
    methods: {
        get: defineIpcMethod(
            'get', 'recentFiles:get', noArgs, recentFilesResult, 'getRecentFiles', 'sender',
        ),
        remove: defineIpcMethod(
            'remove', 'recentFiles:remove', s.tuple([stringResult]), voidResult, 'removeRecentFile', 'none',
        ),
        removeIfMissing: defineIpcMethod(
            'removeIfMissing', 'recentFiles:removeIfMissing', s.tuple([stringResult]),
            s.boolean(), 'removeRecentFileIfMissing', 'none',
        ),
        clear: defineIpcMethod(
            'clear', 'recentFiles:clear', noArgs, voidResult, 'clearRecentFiles', 'none',
        ),
    },
    events: {},
});

export const DOCUMENT_WINDOW_PLATFORM_FEATURE = definePlatformFeature({
    path: ['documentWindow'],
    required: requiredEverywhere,
    methods: {
        setWindowTitle: defineIpcMethod(
            'setWindowTitle', 'window:setTitle', s.tuple([s.string('Document')]),
            voidResult, 'setWindowTitle', 'sender',
        ),
        showItemInFolder: defineIpcMethod(
            'showItemInFolder', 'shell:showItemInFolder', s.tuple([stringResult]),
            s.boolean(), 'showItemInFolder', 'sender',
        ),
        showItemInFolderStructured: {
            ...defineLocalMethod(
                'showItemInFolderStructured', 'async', s.tuple([stringResult]), showItemResult,
            ),
            ...browserImplementedOptional,
        },
    },
    events: {},
});

export const DOCUMENT_MENU_PLATFORM_FEATURE = definePlatformFeature({
    path: ['documentMenu'],
    required: {
        browser: false,
        electron: true,
    },
    manifestPath: [
        'documents',
        'menuEvents',
    ],
    methods: {
        setMenuDocumentState: defineIpcMethod(
            'setMenuDocumentState', 'menu:setDocumentState', menuStateArgs,
            voidResult, 'setMenuDocumentState', 'sender',
        ),
        setMenuTabCount: defineIpcMethod(
            'setMenuTabCount', 'menu:setTabCount', s.tuple([nonNegativeInteger]),
            voidResult, 'setMenuTabCount', 'sender',
        ),
    },
    events: {
        onPdfOptimizeProgress: defineEvent('onPdfOptimizeProgress', 'pdf:optimize:progress', optimizeProgress),
        onMenuOpenPdf: defineEvent('onMenuOpenPdf', 'menu:openPdf', noPayload),
        onMenuInsertImageFromFile: defineEvent('onMenuInsertImageFromFile', 'menu:insertImageFromFile', noPayload),
        onMenuPasteImageFromClipboard: defineEvent('onMenuPasteImageFromClipboard', 'menu:pasteImageFromClipboard', noPayload),
        onMenuSave: defineEvent('onMenuSave', 'menu:save', noPayload),
        onMenuRepairSave: defineEvent('onMenuRepairSave', 'menu:repairSave', noPayload),
        onMenuOptimizePdfForInteraction: defineEvent('onMenuOptimizePdfForInteraction', 'menu:optimizePdfForInteraction', noPayload),
        onMenuSaveAs: defineEvent('onMenuSaveAs', 'menu:saveAs', noPayload),
        onMenuPrint: defineEvent('onMenuPrint', 'menu:print', noPayload),
        onMenuPrintCurrentPage: defineEvent('onMenuPrintCurrentPage', 'menu:printCurrentPage', noPayload),
        onMenuExportDocx: defineEvent('onMenuExportDocx', 'menu:exportDocx', noPayload),
        onMenuExportImages: defineEvent('onMenuExportImages', 'menu:exportImages', noPayload),
        onMenuExportMultiPageTiff: defineEvent('onMenuExportMultiPageTiff', 'menu:exportMultiPageTiff', noPayload),
        onMenuZoomIn: defineEvent('onMenuZoomIn', 'menu:zoomIn', noPayload),
        onMenuZoomOut: defineEvent('onMenuZoomOut', 'menu:zoomOut', noPayload),
        onMenuActualSize: defineEvent('onMenuActualSize', 'menu:actualSize', noPayload),
        onMenuFitWidth: defineEvent('onMenuFitWidth', 'menu:fitWidth', noPayload),
        onMenuFitHeight: defineEvent('onMenuFitHeight', 'menu:fitHeight', noPayload),
        onMenuToggleContinuousScroll: defineEvent('onMenuToggleContinuousScroll', 'menu:toggleContinuousScroll', noPayload),
        onMenuViewModeSingle: defineEvent('onMenuViewModeSingle', 'menu:viewModeSingle', noPayload),
        onMenuViewModeFacing: defineEvent('onMenuViewModeFacing', 'menu:viewModeFacing', noPayload),
        onMenuViewModeFacingFirstSingle: defineEvent('onMenuViewModeFacingFirstSingle', 'menu:viewModeFacingFirstSingle', noPayload),
        onMenuViewRotationCw: defineEvent('onMenuViewRotationCw', 'menu:viewRotationCw', noPayload),
        onMenuViewRotationCcw: defineEvent('onMenuViewRotationCcw', 'menu:viewRotationCcw', noPayload),
        onMenuToggleAssistant: defineEvent('onMenuToggleAssistant', 'menu:toggleAssistant', noPayload),
        onMenuUndo: defineEvent('onMenuUndo', 'menu:undo', noPayload),
        onMenuRedo: defineEvent('onMenuRedo', 'menu:redo', noPayload),
        onMenuDeletePages: defineEvent('onMenuDeletePages', 'menu:deletePages', noPayload),
        onMenuExtractPages: defineEvent('onMenuExtractPages', 'menu:extractPages', noPayload),
        onMenuRotateCw: defineEvent('onMenuRotateCw', 'menu:rotateCw', noPayload),
        onMenuRotateCcw: defineEvent('onMenuRotateCcw', 'menu:rotateCcw', noPayload),
        onMenuInsertPages: defineEvent('onMenuInsertPages', 'menu:insertPages', noPayload),
        onMenuOpenRecentFile: defineEvent('onMenuOpenRecentFile', 'menu:openRecentFile', stringResult),
        onMenuOpenExternalPaths: defineEvent('onMenuOpenExternalPaths', 'menu:openExternalPaths', stringArrayResult),
        onMenuClearRecentFiles: defineEvent('onMenuClearRecentFiles', 'menu:clearRecentFiles', noPayload),
    },
});

export const DOCUMENT_PLATFORM_FEATURES = [
    DOCUMENT_PICKER_PLATFORM_FEATURE,
    DOCUMENT_OPEN_PLATFORM_FEATURE,
    DOCUMENT_WORKING_COPY_PLATFORM_FEATURE,
    DOCUMENT_FILES_PLATFORM_FEATURE,
    DOCUMENT_PDF_PLATFORM_FEATURE,
    DOCUMENT_RECENT_FILES_PLATFORM_FEATURE,
    DOCUMENT_WINDOW_PLATFORM_FEATURE,
    DOCUMENT_MENU_PLATFORM_FEATURE,
] as const;

/**
 * These public methods remain direct preload/browser bindings because their
 * callback, AbortSignal, AsyncIterable, or MessagePort transfer semantics
 * cannot be represented by invoke/event specs without changing the protocol.
 */
export const DOCUMENTS_DIRECT_BINDING_METHODS = [
    'documentFiles.readFileChunks',
    'documentFiles.savePdfDataAs',
    'documentFiles.savePdfData',
    'documentFiles.savePdfDataChunks',
] as const;

export type IDocumentPickerPlatformCapability =
    TFeatureCapability<typeof DOCUMENT_PICKER_PLATFORM_FEATURE>;
export type IDocumentOpenPlatformCapability =
    TFeatureCapability<typeof DOCUMENT_OPEN_PLATFORM_FEATURE>;
export type IDocumentWorkingCopyPlatformCapability =
    TFeatureCapability<typeof DOCUMENT_WORKING_COPY_PLATFORM_FEATURE>;
export type IDocumentFilesPlatformCapability =
    TFeatureCapability<typeof DOCUMENT_FILES_PLATFORM_FEATURE>;
export type IDocumentPdfPlatformCapability =
    TFeatureCapability<typeof DOCUMENT_PDF_PLATFORM_FEATURE>;
export type IDocumentRecentFilesPlatformCapability =
    TFeatureCapability<typeof DOCUMENT_RECENT_FILES_PLATFORM_FEATURE>;
export type IDocumentWindowPlatformCapability =
    TFeatureCapability<typeof DOCUMENT_WINDOW_PLATFORM_FEATURE>;
export type IDocumentMenuPlatformCapability =
    TFeatureCapability<typeof DOCUMENT_MENU_PLATFORM_FEATURE>;
export type IDocumentPickerInvokeMap =
    TFeatureInvokeMap<typeof DOCUMENT_PICKER_PLATFORM_FEATURE>;
export type IDocumentOpenInvokeMap =
    TFeatureInvokeMap<typeof DOCUMENT_OPEN_PLATFORM_FEATURE>;
export type IDocumentWorkingCopyInvokeMap =
    TFeatureInvokeMap<typeof DOCUMENT_WORKING_COPY_PLATFORM_FEATURE>;
export type IDocumentFilesInvokeMap =
    TFeatureInvokeMap<typeof DOCUMENT_FILES_PLATFORM_FEATURE>;
export type IDocumentPdfInvokeMap =
    TFeatureInvokeMap<typeof DOCUMENT_PDF_PLATFORM_FEATURE>;
export type IDocumentRecentFilesInvokeMap =
    TFeatureInvokeMap<typeof DOCUMENT_RECENT_FILES_PLATFORM_FEATURE>;
export type IDocumentWindowInvokeMap =
    TFeatureInvokeMap<typeof DOCUMENT_WINDOW_PLATFORM_FEATURE>;
export type IDocumentMenuInvokeMap =
    TFeatureInvokeMap<typeof DOCUMENT_MENU_PLATFORM_FEATURE>;
export type IDocumentMenuEventMap =
    TFeatureEventMap<typeof DOCUMENT_MENU_PLATFORM_FEATURE>;
export type IDocumentOpenEventMap =
    TFeatureEventMap<typeof DOCUMENT_OPEN_PLATFORM_FEATURE>;
export type IDocumentFilesEventMap =
    TFeatureEventMap<typeof DOCUMENT_FILES_PLATFORM_FEATURE>;
