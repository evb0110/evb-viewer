import type {
    ICreateCombinedPdfFromFilesOptions,IPdfSerializedSaveOptions,
} from '@contracts/electronApiDocuments';
import {
    PDF_SERIALIZED_COMMIT_CALLBACKS_SCHEMA,
    WORKING_COPY_BACKING_STATUS_SCHEMA,
} from '@contracts/electronApiDocuments';
import {
    definePlatformFeature,
    type TPlatformFeatureSchema,
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
    conformanceResult,
    documentRevisionArgs,
    documentRevisionEvent,
    documentSaveResult,
    fileExistsArgs,
    fileStatResult,
    longNativeIpcTimeoutMs,
    managedHandleArgs,
    managedHandleResult,
    menuStateArgs,
    nativeSaveResult,
    noPayload,
    nonNegativeInteger,
    nullableDocumentRefResult,
    nullableStringResult,
    openBatchProgress,
    openDocumentDirectArgs,
    openDocumentDirectBatchArgs,
    openFileResult,
    openingGeometryArgs,
    openingGeometryResult,
    optimizeAsCopyArgs,
    optimizeInteractionArgs,
    optimizeProgress,
    optimizeResult,
    pageSizesArgs,
    pageSizesResult,
    pathArgs,
    pdfPathArgs,
    printPdfDataArgs,
    printPdfPathArgs,
    printResult,
    readFileArgs,
    pdfPageLabelRangesResult,
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
    statFileArgs,
    validationResult,
    writeDocxArgs,
    writeFileArgs,
} from '@contracts/documentsPlatformFeatureSchemas';
import {PDF_NATIVE_PRINT_DIALOG_OPENED_EVENT_SCHEMA} from '@contracts/pdfPathPrintOptions';
import {
    parsePdfAnnotationsArgs,
    pdfAnnotationParseResult,
} from '@contracts/pdfAnnotationParseSchemas';
import {
    beginPdfEmbeddedShapeIndexArgs,
    pdfEmbeddedShapeIndexChunkResult,
    pdfEmbeddedShapeIndexSessionResult,
    readPdfEmbeddedShapeIndexChunkArgs,
    releasePdfEmbeddedShapeIndexArgs,
} from '@contracts/pdfEmbeddedShapeIndexSchemas';
import {pdfValidationPathArgs} from '@contracts/pdfValidationPathArgs';
import {
    parseDocumentRef,
    type TDocumentRef,
} from '@contracts/documentRef';
import {isRecord} from '@contracts/runtimeGuards';
import {PDF_REVISION_OPTIONS_SCHEMA} from '@contracts/documentsPersistenceSchemas';
import * as v from 'valibot';
import {RECENT_READING_VIEW_SCHEMA} from '@contracts/recentReadingView';

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
const noArgs = v.strictTuple([]);
const voidResult = v.undefined();
const documentRefResult = v.pipe(
    v.string('invalid document reference'),
    v.check(value => parseDocumentRef(value) !== null, 'invalid document reference'),
    v.transform(value => parseDocumentRef(value) as TDocumentRef),
);
const documentRefArrayResult = v.array(documentRefResult);
const fileSchema = v.custom<File>(value => typeof File !== 'undefined' && value instanceof File);
const fileArgs = v.strictTuple([fileSchema]);
const filesArgs = v.strictTuple([v.array(fileSchema)]);
const combinedFilesOptionsSchema = v.custom<ICreateCombinedPdfFromFilesOptions>(value => isRecord(value)
    && (value.onProgress === undefined || typeof value.onProgress === 'function')
    && (value.signal === undefined || typeof AbortSignal !== 'undefined' && value.signal instanceof AbortSignal));
const combinedFilesArgs = v.strictTuple([
    v.array(fileSchema),
    v.optional(combinedFilesOptionsSchema),
]);
const combinedPdfResult = v.custom<Uint8Array>((value): value is Uint8Array => value instanceof Uint8Array);
const workingCopyBackingStatusArgs = pathArgs('path');
const workingCopyBackingStatus = WORKING_COPY_BACKING_STATUS_SCHEMA;
const nullableWorkingCopyBackingStatus = v.nullable(WORKING_COPY_BACKING_STATUS_SCHEMA);

function defineIpcMethod<
    const TName extends string,
    const TChannel extends string,
    const TArgs extends TPlatformFeatureSchema<unknown[]>,
    const TResult extends TPlatformFeatureSchema,
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
    const TArgs extends TPlatformFeatureSchema<unknown[]>,
    const TResult extends TPlatformFeatureSchema,
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
    const TPayload extends TPlatformFeatureSchema,
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
        openImageDialog: defineIpcMethod(
            'openImageDialog', 'dialog:openImage', noArgs, nullableStringResult, 'openImageDialog', 'sender',
        ),
        getPathForFile: {
            kind: 'sync',
            args: fileArgs,
            result: documentRefResult,
            browser: {method: 'getPathForFile'},
            lazy: 'direct',
        },
        getPathsForFiles: {
            kind: 'sync',
            args: filesArgs,
            result: documentRefArrayResult,
            browser: {method: 'getPathsForFiles'},
            lazy: 'direct',
        },
        registerFilesForOpen: defineLocalMethod(
            'registerFilesForOpen', 'async', filesArgs, documentRefArrayResult,
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
            documentRefResult,
            'createWorkingCopyFromData',
            'sender',
        ),
        createWorkingCopyFromPath: defineIpcMethod(
            'createWorkingCopyFromPath',
            'working-copy:createFromPath',
            createWorkingCopyFromPathArgs,
            documentRefResult,
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
    },
    events: {},
});

const savePdfDataLocalArgs = v.pipe(
    v.strictTuple([
        documentRefResult,
        v.custom<Uint8Array>(value => value instanceof Uint8Array),
        v.optional(PDF_REVISION_OPTIONS_SCHEMA),
        v.optional(PDF_SERIALIZED_COMMIT_CALLBACKS_SCHEMA),
    ]),
    v.transform(args => args as [
        TDocumentRef,
        Uint8Array,
        (IPdfSerializedSaveOptions | undefined)?,
        (v.InferOutput<typeof PDF_SERIALIZED_COMMIT_CALLBACKS_SCHEMA> | undefined)?,
    ]),
);

export const DOCUMENT_FILES_PLATFORM_FEATURE = definePlatformFeature({
    path: ['documentFiles'],
    required: requiredEverywhere,
    methods: {
        readFile: defineIpcMethod(
            'readFile', 'file:read', readFileArgs, bytesResult, 'readFile', 'sender',
        ),
        readPdfPageLabelRanges: defineIpcMethod(
            'readPdfPageLabelRanges', 'pdf:pageLabels:read', pathArgs('path'),
            pdfPageLabelRangesResult, 'readPdfPageLabelRanges', 'sender',
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
        readTextFile: defineIpcMethod(
            'readTextFile', 'file:readText', readTextFileArgs, v.string(), 'readTextFile', 'sender',
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
            'savePdfAs', 'dialog:savePdfAs', savePdfAsArgs, nullableDocumentRefResult, 'savePdfAs', 'sender',
        ),
        savePdfDialog: defineIpcMethod(
            'savePdfDialog', 'dialog:savePdfDialog', savePdfDialogArgs,
            nullableStringResult, 'savePdfDialog', 'sender',
        ),
        saveDocxAs: defineIpcMethod(
            'saveDocxAs', 'dialog:saveDocxAs', pathArgs('workingPath'),
            nullableDocumentRefResult, 'saveDocxAs', 'sender',
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
        savePdfData: defineLocalMethod(
            'savePdfData', 'async', savePdfDataLocalArgs, validationResult,
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
            browser: {method: 'releaseManagedTempFileHandle'},
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
                documentRefResult,
                'cloneStagedPdfNativeMutationToWorkingCopy',
                'sender',
            ),
            ipc: {
                args: cloneStagedNativeMutationArgs,
                result: documentRefResult,
                timeoutMs: longNativeIpcTimeoutMs,
            },
            ...electronImplementedOptional,
            browser: {method: 'cloneStagedPdfNativeMutationToWorkingCopy'},
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
                conformanceResult, 'analyzePdfConformance', 'sender',
            ),
            ipc: {
                args: pdfPathArgs,
                result: conformanceResult,
                timeoutMs: longNativeIpcTimeoutMs,
            },
        },
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
        printPdfData: defineIpcMethod(
            'printPdfData', 'pdf:printData', printPdfDataArgs,
            printResult,
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
            printResult,
            'printPdfPath', 'sender',
        ),
    },
    events: {onNativePrintDialogOpened: {
        ...defineEvent(
            'onNativePrintDialogOpened',
            'pdf:print:native-dialog-opened',
            PDF_NATIVE_PRINT_DIALOG_OPENED_EVENT_SCHEMA,
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
            'remove', 'recentFiles:remove', v.strictTuple([documentRefResult]), voidResult, 'removeRecentFile', 'none',
        ),
        removeIfMissing: defineIpcMethod(
            'removeIfMissing', 'recentFiles:removeIfMissing', v.strictTuple([documentRefResult]),
            booleanResult, 'removeRecentFileIfMissing', 'none',
        ),
        clear: defineIpcMethod(
            'clear', 'recentFiles:clear', noArgs, voidResult, 'clearRecentFiles', 'none',
        ),
        // The reference is the open document's working copy: main reads the
        // source identity it was admitted with, never a renderer-supplied stat.
        readingView: defineIpcMethod(
            'readingView', 'recentFiles:readingView', v.strictTuple([documentRefResult]),
            v.nullable(RECENT_READING_VIEW_SCHEMA), 'getRecentReadingView', 'sender',
        ),
        rememberReadingView: defineIpcMethod(
            'rememberReadingView', 'recentFiles:rememberReadingView',
            v.strictTuple([
                documentRefResult,
                RECENT_READING_VIEW_SCHEMA,
            ]), voidResult, 'rememberRecentReadingView', 'sender',
        ),
    },
    events: {},
});

export const DOCUMENT_WINDOW_PLATFORM_FEATURE = definePlatformFeature({
    path: ['documentWindow'],
    required: requiredEverywhere,
    methods: {
        setWindowTitle: defineIpcMethod(
            'setWindowTitle', 'window:setTitle', v.strictTuple([v.string()]),
            voidResult, 'setWindowTitle', 'sender',
        ),
        showItemInFolder: defineIpcMethod(
            'showItemInFolder', 'shell:showItemInFolder', v.strictTuple([documentRefResult]),
            v.boolean(), 'showItemInFolder', 'sender',
        ),
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
            'setMenuTabCount', 'menu:setTabCount', v.strictTuple([nonNegativeInteger]),
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
        onMenuSelectAll: defineEvent('onMenuSelectAll', 'menu:select-all', noPayload),
        onMenuDeletePages: defineEvent('onMenuDeletePages', 'menu:deletePages', noPayload),
        onMenuExtractPages: defineEvent('onMenuExtractPages', 'menu:extractPages', noPayload),
        onMenuRotateCw: defineEvent('onMenuRotateCw', 'menu:rotateCw', noPayload),
        onMenuRotateCcw: defineEvent('onMenuRotateCcw', 'menu:rotateCcw', noPayload),
        onMenuInsertPages: defineEvent('onMenuInsertPages', 'menu:insertPages', noPayload),
        onMenuOpenRecentFile: defineEvent('onMenuOpenRecentFile', 'menu:openRecentFile', documentRefResult),
        onMenuOpenExternalPaths: defineEvent('onMenuOpenExternalPaths', 'menu:openExternalPaths', documentRefArrayResult),
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
export const DOCUMENTS_DIRECT_BINDING_METHODS = ['documentFiles.savePdfData'] as const;

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
