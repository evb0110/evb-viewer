import {
    FILE_STAT_RESULT_SCHEMA,
    MANAGED_TEMP_FILE_HANDLE_SCHEMA,
    OPEN_BATCH_PROGRESS_SCHEMA,
    PDF_OPTIMIZE_PRESET_SCHEMA,
    PDF_OPTIMIZE_PROGRESS_SCHEMA,
} from '@contracts/electronApiDocuments';
import {
    parseDocumentRef, type TDocumentRef,
} from '@contracts/documentRef';
import {parseDocumentRevisionToken} from '@contracts/documentRevision';
import {
    isPdfDecryptPassword, PDF_DECRYPT_PASSWORD_MAX_BYTES,
} from '@contracts/pdfDecryptSchemas';
import {
    PDF_OPENING_GEOMETRY_SCHEMA,
    PDF_NATIVE_PAGE_GEOMETRY_SCHEMA,
    PDF_NATIVE_PAGE_SIZES_EXACT_OPTIONS_SCHEMA,
} from '@contracts/documentsPlatformFeatureNativePageSchemas';
import {
    normalizePdfNativeAnnotationIdentityBindings,
    normalizePdfNativeModifiedAt,
    normalizePdfNativeMutationSet,
    normalizePdfNativeNoteChanges,
    normalizePdfNativeNoteTextUpdates,
} from '@contracts/nativePdfMutations';
import {PDF_PAGE_LABEL_STYLE_VALUES} from '@contracts/pdfPageLabels';
import {OPEN_FILE_RESULT_SCHEMA} from '@contracts/pdfOpenFileSchemas';
import {PDF_VALIDATION_RESULT_SCHEMA} from '@contracts/pdfConformance';
import {
    PDF_DATA_PRINT_OPTIONS_SCHEMA, PDF_PATH_PRINT_OPTIONS_SCHEMA,
} from '@contracts/pdfPathPrintOptions';
import {PDF_VALIDATION_PATH_ARGS_SCHEMA} from '@contracts/pdfValidationPathArgs';
import {
    PDF_REVISION_OPTIONS_SCHEMA,
    PDF_SAVE_AS_OPTIONS_SCHEMA,
    PDF_NATIVE_STAGED_COMMIT_OPTIONS_SCHEMA,
} from '@contracts/documentsPersistenceSchemas';
import {TYPED_STAGED_ARTIFACT_SCHEMA} from '@contracts/stagedArtifacts';
import {isNativeErrorEnvelope} from '@contracts/nativeErrors';
import type {INativeErrorEnvelope} from '@contracts/nativeErrors';
import {
    parseLeaseId, parseRequestId, type TRequestId,
} from '@contracts/shared';
import {parseEpochMs} from '@contracts/timestamps';
import * as v from 'valibot';

function fail(message: string): never {
    throw new Error(message);
}

const documentRefSchema = v.pipe(
    v.string('path must be an absolute document reference'),
    v.check(value => parseDocumentRef(value) !== null, 'path must be an absolute document reference'),
    v.transform(value => parseDocumentRef(value) ?? fail('path must be an absolute document reference')),
);
const requestIdSchema = v.pipe(
    v.string('requestId must be a non-empty request ID'),
    v.check(value => parseRequestId(value) !== null, 'requestId must be a non-empty request ID'),
    v.transform(value => parseRequestId(value) ?? fail('requestId must be a non-empty request ID')),
);
const leaseIdSchema = v.pipe(
    v.string('leaseId must be a non-empty lease ID'),
    v.check(value => parseLeaseId(value) !== null, 'leaseId must be a non-empty lease ID'),
    v.transform(value => parseLeaseId(value) ?? fail('leaseId must be a non-empty lease ID')),
);
const documentRevisionTokenSchema = v.pipe(
    v.string('expectedDocumentRevisionToken must be valid'),
    v.check(value => parseDocumentRevisionToken(value) !== null, 'expectedDocumentRevisionToken must be valid'),
    v.transform(value => parseDocumentRevisionToken(value) ?? fail('expectedDocumentRevisionToken must be valid')),
);
const epochMsSchema = v.pipe(
    v.number(),
    v.safeInteger(),
    v.minValue(0),
    v.transform(value => parseEpochMs(value) ?? fail('invalid timestamp')),
);
const positiveEpochMsSchema = v.pipe(
    v.number(),
    v.safeInteger(),
    v.minValue(1),
    v.transform(value => parseEpochMs(value) ?? fail('invalid timestamp')),
);
const nonNegativeSafeInteger = v.pipe(v.number(), v.safeInteger(), v.minValue(0));
const positiveSafeInteger = v.pipe(v.number(), v.safeInteger(), v.minValue(1));
const finiteNumber = v.pipe(v.number(), v.finite());
const uint8ArraySchema = v.custom<Uint8Array>(
    (value): value is Uint8Array => value instanceof Uint8Array,
);
const recentFileSchema = v.message(v.object({
    originalPath: documentRefSchema,
    backend: v.exactOptional(v.picklist([
        'electron',
        'browser',
    ])),
    fileName: v.string(),
    timestamp: epochMsSchema,
    fileSize: v.exactOptional(v.pipe(finiteNumber, v.minValue(0))),
    modifiedAt: v.exactOptional(epochMsSchema),
}), 'invalid recent file');

const pdfPathSchema = v.strictTuple([documentRefSchema]);
const requestIdArgs = v.strictTuple([requestIdSchema]);
const leaseIdArgs = v.strictTuple([leaseIdSchema]);
const optionalDocumentRefSchema = v.optional(v.pipe(
    v.nullish(documentRefSchema),
    v.transform(value => value ?? undefined),
));
const optionalRequestIdSchema = v.optional(v.pipe(
    v.nullish(requestIdSchema),
    v.transform(value => value ?? undefined),
));
const optionalRevisionOptionsSchema = v.optional(v.pipe(
    v.nullish(PDF_REVISION_OPTIONS_SCHEMA),
    v.transform(value => value ?? undefined),
));
const pdfDecryptPasswordSchema = v.pipe(
    v.string(),
    v.check(
        (value: string) => isPdfDecryptPassword(value),
        `password exceeds the ${PDF_DECRYPT_PASSWORD_MAX_BYTES}-byte limit`,
    ),
);
const optionalPasswordSchema = v.optional(v.pipe(
    v.nullish(pdfDecryptPasswordSchema),
    v.transform(value => value ?? undefined),
));
const optionalFileNameSchema = v.optional(v.pipe(
    v.nullish(v.string()),
    v.transform(value => value ?? undefined),
));
const saveAsOptionsOrUndefinedSchema = v.pipe(
    v.nullish(PDF_SAVE_AS_OPTIONS_SCHEMA),
    v.transform(value => value ?? undefined),
);
const optionalNativeStagedCommitOptionsSchema = v.optional(v.pipe(
    v.nullish(PDF_NATIVE_STAGED_COMMIT_OPTIONS_SCHEMA),
    v.transform(value => value ?? undefined),
));
const optionalDataPrintOptionsSchema = v.optional(v.pipe(
    v.nullish(PDF_DATA_PRINT_OPTIONS_SCHEMA),
    v.transform(value => value ?? undefined),
));
const optionalPathPrintOptionsSchema = v.optional(v.pipe(
    v.nullish(PDF_PATH_PRINT_OPTIONS_SCHEMA),
    v.transform(value => value ?? undefined),
));
const optionsForceCombineSchema = v.object({forceCombine: v.exactOptional(v.boolean())});

const openDocumentDirectArgs = v.pipe(
    v.strictTuple([
        documentRefSchema,
        v.optional(pdfDecryptPasswordSchema),
    ]),
    v.transform(args => args[1] === undefined
        ? [args[0]] as [TDocumentRef]
        : args as [TDocumentRef, string]),
);
const openDocumentDirectBatchArgs = v.pipe(
    v.strictTuple([
        v.array(documentRefSchema),
        optionalRequestIdSchema,
        v.optional(optionsForceCombineSchema),
    ]),
    v.transform(args => args as [
        TDocumentRef[],
        (TRequestId | undefined)?,
        ({forceCombine?: boolean} | undefined)?,
    ]),
);
const createWorkingCopyFromDataArgs = v.strictTuple([
    v.string(),
    uint8ArraySchema,
    optionalDocumentRefSchema,
    optionalPasswordSchema,
]);
const createWorkingCopyFromPathArgs = v.strictTuple([
    documentRefSchema,
    optionalDocumentRefSchema,
    optionalPasswordSchema,
]);
const cancelOpenBatchArgs = requestIdArgs;
const cancelRequestArgs = requestIdArgs;

const savePdfAsArgs = v.strictTuple([
    documentRefSchema,
    saveAsOptionsOrUndefinedSchema,
    optionalRevisionOptionsSchema,
]);
const savePdfDialogArgs = v.strictTuple([v.string()]);
const pathArgs = (_fieldName: string) => pdfPathSchema;
const readFileArgs = pdfPathSchema;
const statFileArgs = pdfPathSchema;
const readFileRangeArgs = v.strictTuple([
    documentRefSchema,
    nonNegativeSafeInteger,
    nonNegativeSafeInteger,
]);
const managedHandleArgs = pdfPathSchema;
const releaseManagedHandleArgs = leaseIdArgs;
const openingGeometryArgs = pdfPathSchema;
const pageSizesArgs = v.strictTuple([
    documentRefSchema,
    PDF_NATIVE_PAGE_SIZES_EXACT_OPTIONS_SCHEMA,
]);
const readTextFileArgs = pdfPathSchema;
const fileExistsArgs = pdfPathSchema;
const writeFileArgs = v.strictTuple([
    documentRefSchema,
    uint8ArraySchema,
    optionalRevisionOptionsSchema,
]);
const replaceWorkingCopyArgs = v.strictTuple([
    documentRefSchema,
    documentRefSchema,
    optionalRevisionOptionsSchema,
]);
const writeDocxArgs = v.strictTuple([
    documentRefSchema,
    uint8ArraySchema,
]);
const saveFileStructuredArgs = v.strictTuple([
    documentRefSchema,
    optionalRevisionOptionsSchema,
]);
const repairPdfArgs = saveFileStructuredArgs;
const optimizeInteractionArgs = saveFileStructuredArgs;
const optimizeOptionsSchema = v.object({preset: PDF_OPTIMIZE_PRESET_SCHEMA});
const optimizeAsCopyArgs = v.strictTuple([
    documentRefSchema,
    optimizeOptionsSchema,
    optionalRequestIdSchema,
    optionalRevisionOptionsSchema,
]);

// Native mutation normalizers canonicalize PDF dates, identities, and cross-field mutation semantics.
const nativeNoteTextArgs = v.strictTuple([
    documentRefSchema,
    v.pipe(v.unknown(), v.transform(value => normalizePdfNativeNoteTextUpdates(value, 'updates', {allowEmpty: true}))),
    v.pipe(v.string(), v.transform(value => normalizePdfNativeModifiedAt(value, 'modifiedAt'))),
    optionalRevisionOptionsSchema,
]);
const nativeNoteChangesArgs = v.strictTuple([
    documentRefSchema,
    v.pipe(v.unknown(), v.transform(value => normalizePdfNativeNoteChanges(value, 'changes'))),
    v.pipe(v.string(), v.transform(value => normalizePdfNativeModifiedAt(value, 'modifiedAt'))),
    optionalRevisionOptionsSchema,
]);
const applyNativeMutationsArgs = v.strictTuple([
    documentRefSchema,
    v.pipe(v.unknown(), v.transform(value => normalizePdfNativeMutationSet(value, 'mutations'))),
    v.pipe(v.string(), v.transform(value => normalizePdfNativeModifiedAt(value, 'modifiedAt'))),
    v.pipe(
        v.nullish(PDF_REVISION_OPTIONS_SCHEMA),
        v.transform(value => value ?? fail('applyPdfNativeMutationsToWorkingCopy requires revisionOptions')),
    ),
]);
const stagedArtifactSchema = v.message(TYPED_STAGED_ARTIFACT_SCHEMA, 'stagedOutput must be a typed staged artifact');
const commitNativeMutationsArgs = v.pipe(
    v.strictTuple([
        documentRefSchema,
        stagedArtifactSchema,
        optionalNativeStagedCommitOptionsSchema,
    ]),
    v.transform(args => (args[2] === undefined ? [
        args[0],
        args[1],
    ] : args) as [
        TDocumentRef,
        v.InferOutput<typeof stagedArtifactSchema>,
            (v.InferOutput<typeof PDF_NATIVE_STAGED_COMMIT_OPTIONS_SCHEMA> | undefined)?,
    ]),
);
const cloneStagedNativeMutationArgs = v.strictTuple([
    stagedArtifactSchema,
    optionalDocumentRefSchema,
]);
const replaceWorkingCopyFromStagedNativeMutationArgs = v.strictTuple([
    documentRefSchema,
    stagedArtifactSchema,
    v.pipe(
        v.nullish(PDF_REVISION_OPTIONS_SCHEMA),
        v.transform(value => value ?? fail('replaceWorkingCopyFromStagedPdfNativeMutation requires revisionOptions')),
    ),
]);

const printPdfDataArgs = v.strictTuple([
    uint8ArraySchema,
    optionalFileNameSchema,
    optionalDataPrintOptionsSchema,
]);
const pdfConformanceOptionsSchema = v.object({purpose: v.exactOptional(v.picklist([
    'full',
    'save-restrictions',
]))});
const optionalPdfConformanceOptionsSchema = v.optional(v.pipe(
    v.nullish(pdfConformanceOptionsSchema),
    v.transform(value => value ?? undefined),
));
const pdfPathArgs = v.strictTuple([
    documentRefSchema,
    optionalPdfConformanceOptionsSchema,
]);
const printPdfPathArgs = v.strictTuple([
    documentRefSchema,
    optionalFileNameSchema,
    optionalPathPrintOptionsSchema,
]);

const revisionInfoSchema = v.object({
    version: v.literal(1),
    token: documentRevisionTokenSchema,
    documentRef: documentRefSchema,
    authority: v.picklist([
        'electron-working-copy',
        'browser-document-store',
    ]),
    contentRevision: nonNegativeSafeInteger,
    mintedAt: positiveEpochMsSchema,
});
const documentRevisionEventSchema = v.object({
    version: v.literal(1),
    token: documentRevisionTokenSchema,
    previousToken: v.exactOptional(documentRevisionTokenSchema),
    documentRef: documentRefSchema,
    authority: v.picklist([
        'electron-working-copy',
        'browser-document-store',
    ]),
    contentRevision: nonNegativeSafeInteger,
    mintedAt: positiveEpochMsSchema,
    reason: v.picklist([
        'open',
        'write',
        'replace-working-copy',
        'page-ops',
        'ocr-apply',
        'save-sync',
        'native-mutation',
        'browser-handle-refresh',
        'unknown',
    ]),
});
const menuDocumentStateSchema = v.union([
    v.boolean(),
    v.looseObject({
        hasDocument: v.boolean('state must include boolean hasDocument and canSave fields'),
        interactive: v.exactOptional(v.boolean()),
        canSave: v.boolean('state must include boolean hasDocument and canSave fields'),
        supportsSaveAs: v.exactOptional(v.boolean()),
        canSaveAs: v.exactOptional(v.boolean()),
        supportsRepairSave: v.exactOptional(v.boolean()),
        canRepairSave: v.exactOptional(v.boolean()),
        supportsOptimizePdf: v.exactOptional(v.boolean()),
        canOptimizePdf: v.exactOptional(v.boolean()),
        supportsPrint: v.exactOptional(v.boolean()),
        canPrint: v.exactOptional(v.boolean()),
        supportsExportDocx: v.exactOptional(v.boolean()),
        canExportDocx: v.exactOptional(v.boolean()),
        isExportingDocx: v.exactOptional(v.boolean()),
        supportsRasterExport: v.exactOptional(v.boolean()),
        canExportRaster: v.exactOptional(v.boolean()),
        canUndo: v.exactOptional(v.boolean()),
        canRedo: v.exactOptional(v.boolean()),
        supportsPdfMutation: v.exactOptional(v.boolean()),
        canMutatePages: v.exactOptional(v.boolean()),
        selectedPageCount: v.exactOptional(nonNegativeSafeInteger),
        totalPages: v.exactOptional(nonNegativeSafeInteger),
        supportsContinuousScroll: v.exactOptional(v.boolean()),
        canContinuousScroll: v.exactOptional(v.boolean()),
        continuousScroll: v.exactOptional(v.boolean()),
        supportsViewMode: v.exactOptional(v.boolean()),
        viewMode: v.exactOptional(v.picklist([
            'single',
            'facing',
            'facing-first-single',
        ])),
        supportsViewRotation: v.exactOptional(v.boolean()),
        viewRotation: v.exactOptional(v.picklist([
            0,
            90,
            180,
            270,
        ])),
        isActualSizeActive: v.exactOptional(v.boolean()),
        isFitWidthActive: v.exactOptional(v.boolean()),
        isFitHeightActive: v.exactOptional(v.boolean()),
        canToggleAssistant: v.exactOptional(v.boolean()),
        canCreatePane: v.exactOptional(v.boolean()),
        canCloseTab: v.exactOptional(v.boolean()),
        canTransferActiveTab: v.exactOptional(v.boolean()),
    }),
]);
const nonNegativeInteger = v.pipe(v.number(), v.safeInteger(), v.minValue(0));

const documentSaveFailureReasons = [
    'user-canceled',
    'validation-failed',
    'working-copy-missing',
    'write-failed',
    'refresh-failed',
    'working-copy-sync-required',
    'unsupported',
    'stale',
    'unknown',
] as const;
const unsupportedReasons = [
    'unsupported-backend',
    'missing-browser-permission',
    'user-canceled',
    'not-implemented',
    'requires-native-backend',
] as const;
const documentSaveWarningSchema = v.object({
    reason: v.literal('refresh-failed'),
    message: v.string(),
});
const documentSaveResultSchema = v.variant('ok', [
    v.object({
        ok: v.literal(true),
        externalWriteCommitted: v.boolean(),
        workingCopyRefreshed: v.boolean(),
        validation: v.exactOptional(v.nullable(PDF_VALIDATION_RESULT_SCHEMA)),
        warning: v.exactOptional(documentSaveWarningSchema),
    }),
    v.object({
        ok: v.literal(false),
        reason: v.picklist(documentSaveFailureReasons),
        message: v.exactOptional(v.string()),
        externalWriteCommitted: v.exactOptional(v.nullable(v.boolean())),
        workingCopySyncRequired: v.exactOptional(v.boolean()),
        validation: v.exactOptional(v.nullable(PDF_VALIDATION_RESULT_SCHEMA)),
    }),
]);
const printResultSchema = v.object({
    success: v.boolean(),
    canceled: v.exactOptional(v.boolean()),
    error: v.exactOptional(v.string()),
    unsupportedReason: v.exactOptional(v.picklist(unsupportedReasons)),
});
const nullableCountSchema = v.nullable(nonNegativeSafeInteger);
const optimizeResultSchema = v.object({
    path: v.nullable(documentRefSchema),
    validation: v.nullable(PDF_VALIDATION_RESULT_SCHEMA),
    preset: PDF_OPTIMIZE_PRESET_SCHEMA,
    originalBytes: nullableCountSchema,
    optimizedBytes: nullableCountSchema,
    pageCount: nullableCountSchema,
});
const stagedOutputSchema = v.message(TYPED_STAGED_ARTIFACT_SCHEMA, 'invalid staged native PDF output');
const nativeErrorEnvelopeSchema: v.GenericSchema<unknown, INativeErrorEnvelope> = v.custom<INativeErrorEnvelope>(
    isNativeErrorEnvelope,
    'invalid native PDF save result',
);
const nativeSaveResultSchema = v.object({
    applied: v.boolean(),
    validation: v.nullable(PDF_VALIDATION_RESULT_SCHEMA),
    nativeMutationPostconditionsVerified: v.exactOptional(v.literal(true, 'invalid native PDF save result')),
    identityBindings: v.exactOptional(v.pipe(
        v.unknown(),
        v.transform(value => normalizePdfNativeAnnotationIdentityBindings(value, 'identityBindings', {errorKind: 'error'})),
    )),
    error: v.exactOptional(nativeErrorEnvelopeSchema),
    syncError: v.exactOptional(v.string()),
    stagedOutput: v.exactOptional(stagedOutputSchema),
});
const conformanceResultSchema = v.object({
    isSigned: v.boolean(),
    isEncrypted: v.boolean(),
    isTagged: v.boolean(),
    pdfaLevel: v.nullable(v.string()),
    hasAcroForm: v.boolean(),
    hasXfa: v.boolean(),
    canIncrementalSave: v.boolean(),
    saveRestrictions: v.array(v.string()),
});
const pdfPageLabelRangesResult = v.array(v.object({
    startPage: positiveSafeInteger,
    style: v.nullable(v.picklist(PDF_PAGE_LABEL_STYLE_VALUES)),
    prefix: v.string(),
    startNumber: positiveSafeInteger,
}));

const cancellationResult = v.object({canceled: v.boolean()});
const revisionResult = revisionInfoSchema;
const nullableDocumentRefResult = v.nullable(documentRefSchema);
const nullableStringResult = v.nullable(v.string());
const recentFilesResult = v.array(recentFileSchema);
const validationResult = PDF_VALIDATION_RESULT_SCHEMA;
const documentSaveResult = documentSaveResultSchema;
const optimizeResult = optimizeResultSchema;
const nativeSaveResult = nativeSaveResultSchema;
const openingGeometryResult = v.nullable(PDF_OPENING_GEOMETRY_SCHEMA);
const pageSizesResult = PDF_NATIVE_PAGE_GEOMETRY_SCHEMA;
const managedHandleResult = MANAGED_TEMP_FILE_HANDLE_SCHEMA;
const fileStatResult = FILE_STAT_RESULT_SCHEMA;
const booleanResult = v.boolean();
const bytesResult = uint8ArraySchema;
const noPayload = v.undefined();
const menuStateArgs = v.strictTuple([menuDocumentStateSchema]);
const documentRevisionArgs = pdfPathSchema;
const documentRevisionEvent = documentRevisionEventSchema;
const optimizeProgress = PDF_OPTIMIZE_PROGRESS_SCHEMA;
const openBatchProgress = OPEN_BATCH_PROGRESS_SCHEMA;
const nonNegativeIntegerSchema = nonNegativeInteger;
const longNativeIpcTimeoutMs = 30 * 60 * 1_000;

const readPdfPageLabelRangesArgs = pdfPathSchema;

export {
    applyNativeMutationsArgs,
    booleanResult,
    bytesResult,
    cancelOpenBatchArgs,
    cancellationResult,
    cancelRequestArgs,
    cloneStagedNativeMutationArgs,
    commitNativeMutationsArgs,
    conformanceResultSchema as conformanceResult,
    createWorkingCopyFromDataArgs,
    createWorkingCopyFromPathArgs,
    documentRevisionArgs,
    documentRevisionEvent,
    documentSaveResult,
    fileExistsArgs,
    fileStatResult,
    managedHandleArgs,
    managedHandleResult,
    menuStateArgs,
    nativeNoteChangesArgs,
    nativeNoteTextArgs,
    nativeSaveResult,
    noPayload,
    nonNegativeIntegerSchema as nonNegativeInteger,
    longNativeIpcTimeoutMs,
    nullableDocumentRefResult,
    nullableStringResult,
    openBatchProgress,
    openDocumentDirectArgs,
    openDocumentDirectBatchArgs,
    OPEN_FILE_RESULT_SCHEMA as openFileResult,
    optimizeAsCopyArgs,
    optimizeInteractionArgs,
    optimizeProgress,
    optimizeResult,
    openingGeometryArgs,
    openingGeometryResult,
    pageSizesArgs,
    pageSizesResult,
    pathArgs,
    pdfPageLabelRangesResult,
    pdfPathArgs,
    PDF_VALIDATION_PATH_ARGS_SCHEMA as pdfValidationPathArgs,
    printResultSchema as printResult,
    printPdfDataArgs,
    printPdfPathArgs,
    readFileArgs,
    readFileRangeArgs,
    readPdfPageLabelRangesArgs,
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
};

export type IPdfOptimizeResult = v.InferOutput<typeof optimizeResultSchema>;
export type IPdfOptimizeOptions = v.InferOutput<typeof optimizeOptionsSchema>;
export type IPdfNativeNoteTextSaveResult = v.InferOutput<typeof nativeSaveResultSchema>;
export type IPdfNativeSaveResult = IPdfNativeNoteTextSaveResult;
export type TDocumentSaveResult = v.InferOutput<typeof documentSaveResultSchema>;
export type TDocumentSaveFailureReason = v.InferOutput<typeof documentSaveResultSchema> extends infer TOutput
    ? TOutput extends {
        ok: false;
        reason: infer TReason
    } ? TReason : never
    : never;
export type IDocumentSaveSuccessResult = Extract<TDocumentSaveResult, {ok: true}>;
export type IDocumentSaveFailureResult = Extract<TDocumentSaveResult, {ok: false}>;
export type IApplicationMenuDocumentState = Extract<v.InferOutput<typeof menuDocumentStateSchema>, Record<string, unknown>>;
