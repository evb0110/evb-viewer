export type {
    ILocaleDefinition,
    TLocaleFile,
} from '@contracts/i18n';

export type {
    IIpcInvokeSpec,
    IIpcMainRegistrar,
    TIpcMainInvokeHandler,
} from '@contracts/ipcMain';

export type {
    IAppUpdateStatus,
    IAgentCapability,
    IAgentCommandRequest,
    IAgentCommandResponse,
    IAgentDocumentOcrState,
    IAgentDocumentReadiness,
    IAgentDocumentRecommendation,
    IAgentMcpIntegrationStatus,
    IAgentMcpIntegrationUpdateResult,
    IAgentPaneSnapshot,
    IAgentTabSnapshot,
    IAgentWorkspaceSnapshot,
    IAgentWorkspaceSnapshotRequest,
    IAgentWorkspaceSnapshotResponse,
    IDebugLogEntry,
    IDjvuCapability,
    IDocumentsFileCapability,
    IDocumentsFileIoCapability,
    IDocumentsMenuCapability,
    IDocumentsOpenCapability,
    IDocumentsPdfCapability,
    IDocumentsPdfExternalCapability,
    IDocumentsPdfPersistenceCapability,
    IDocumentsPdfValidationCapability,
    IDocumentsPickerCapability,
    IDocumentsReadCapability,
    IDocumentsRecentFilesCapability,
    IDocumentsWindowCapability,
    IDocumentsWorkingCopyCapability,
    IImageExportCapability,
    IPageOpsCapability,
    IOcrCapability,
    IScanCleanupCapability,
    IPlatformApi,
    IPlatformApiDescriptor,
    IPlatformCapabilityDescriptor,
    IPlatformMethodDescriptor,
    IRendererLogEntry,
    ISearchCapability,
    ISettingsCapability,
    IUpdatesCapability,
    IWindowTabsCapability,
    TAgentCommand,
    TAgentCommandName,
    TAgentDocumentKind,
    TAgentDocumentReadinessStatus,
    TAgentMcpCodexRegistrationState,
    TAgentOcrCoverageStatus,
    TAgentRecommendationId,
    TAppUpdateCheckOrigin,
    TAppUpdatePhase,
    TDebugLogLevel,
    TMenuEventCallback,
    TMenuEventUnsubscribe,
    TRendererLogLevel,
    TOpenFileResult,
    TBrowserPlatformLazyMode,
    TPlatformMethodKind,
} from '@contracts/platformApi';
export {
    getPlatformMethodDescriptor,
    PLATFORM_API_DESCRIPTOR,
} from '@contracts/platformApi';
export type { IElectronAPI } from '@contracts/electronApi';
export type { IDiagnosticsRendererCapability } from '@contracts/diagnostics/diagnosticsCapability';
export {
    decodeDiagnosticsSuppressedCount,
    DIAGNOSTICS_MAX_SUPPRESSED_COUNT,
} from '@contracts/diagnostics/diagnosticsCapability';
export {
    PDF_ANNOTATION_INDEX_MAX_CHUNK_BYTES,
    PDF_ANNOTATION_PARSE_MAX_CHUNK_BYTES,
    PDF_ANNOTATION_PARSE_MAX_LINE_BYTES,
    PDF_EMBEDDED_SHAPE_INDEX_MAX_CHUNK_BYTES,
    PDF_EMBEDDED_SHAPE_INDEX_MAX_LINE_BYTES,
} from '@contracts/electronApiDocuments';
export type {
    IPdfAnnotationIndexChunk,
    IPdfAnnotationIndexChunkOptions,
    IPdfAnnotationIndexEntry,
    IPdfAnnotationIndexObjectRef,
    IPdfAnnotationIndexOptions,
    IPdfAnnotationIndexSession,
    IPdfAnnotationForeignEntry,
    IPdfAnnotationHighlightEntry,
    IPdfAnnotationNoteEntry,
    IPdfAnnotationNoteReply,
    IPdfAnnotationParseChunk,
    IPdfAnnotationParseChunkOptions,
    IPdfAnnotationParseEntry,
    IPdfAnnotationParsePoint,
    IPdfAnnotationParseOptions,
    IPdfAnnotationParseResult,
    IPdfAnnotationParseSession,
    IPdfAnnotationShapeEntry,
    IPdfSidecarChunkOptions,
    IPdfAnnotationStampEntry,
    IPdfAnnotationStampImageReference,
    IPdfAnnotationTextBoxEntry,
    TPdfAnnotationParseEntity,
    IPdfEmbeddedShapeIndexChunk,
    IPdfEmbeddedShapeIndexChunkOptions,
    IPdfEmbeddedShapeIndexEntry,
    IPdfEmbeddedShapeIndexOptions,
    IPdfEmbeddedShapeIndexPoint,
    IPdfEmbeddedShapeIndexSession,
} from '@contracts/electronApiDocuments';
export {
    decodePdfAnnotationParseEntry,
    decodePdfAnnotationParseProtocolFixture,
    decodePdfAnnotationParseResult,
} from '@contracts/pdfAnnotationParseSchemas';
export type {IPdfAnnotationParseProtocolFixture} from '@contracts/pdfAnnotationParseSchemas';
export {
    formatPdfJsAnnotationRef,
    normalizePdfJsAnnotationId,
    parsePdfAnnotationRef,
    parsePdfJsAnnotationRef,
    parsePdfNativeAnnotationRef,
} from '@contracts/pdfAnnotationRefs';
export type {IPdfAnnotationRef} from '@contracts/pdfAnnotationRefs';
export type * from '@contracts/pdfOpenFileResults';

export {
    HOST_RESOURCE_PROFILE_ARGUMENT_PREFIX,
    decodeHostResourceProfileSnapshot,
    resolveDocumentSavePerformanceTier,
    resolveDetectedHostResourceTier,
    resolveEffectiveHostResourceTier,
} from '@contracts/hostResourceProfile';
export type {
    TDocumentSavePerformanceTier,
    IHostGpuStatusSnapshot,
    IHostResourceProfileSnapshot,
    IHostResourceTierInputs,
    THostResourceTier,
    TPerformanceMode,
} from '@contracts/hostResourceProfile';

export {
    decodeScanCleanupRuntimePolicy,
    decodeSearchWorkerData,
    decodeSearchWorkerResourcePolicy,
    parseBoundedEnvInt,
} from '@contracts/resourcePolicies';
export type {
    IScanCleanupRuntimePolicy,
    ISearchWorkerData,
    ISearchWorkerResourcePolicy,
} from '@contracts/resourcePolicies';

export type {
    IDesktopMenuCapability,
    IDesktopWindowCapability,
    IViewerAssetResolver,
    IViewerDocumentCapability,
    IViewerDocumentOutputCapability,
    IViewerDocumentPickerCapability,
    IViewerDocumentReadCapability,
    IViewerHostApi,
    IViewerHostEnvironment,
    IViewerSearchCapability,
    IViewerSettingsCapability,
    TViewerHostKind,
} from '@contracts/viewerHost';

export {
    READER_COMMAND_CATEGORIES,
    READER_COMMAND_DESCRIPTORS,
    READER_COMMANDS,
} from '@contracts/readerCommands';
export type {
    IReaderCommandDescriptor,
    IReaderCommandRequest,
    IReaderCommandSurface,
    IReaderCommandState,
    IReaderCommandStateSnapshot,
    TReaderCommandCategory,
    TReaderCommandId,
    TReaderCommandMap,
    TReaderCommandPlacement,
} from '@contracts/readerCommands';

export type { TDocumentRef } from '@contracts/documentRef';
export type * from '@contracts/documentRef';
export type { TDocumentInstanceId } from '@contracts/documentInstanceId';
export {
    parseDocumentInstanceId,
    requireDocumentInstanceId,
} from '@contracts/documentInstanceId';
export type * from '@contracts/platformUnsupported';
export type {
    IDocumentRevisionChangedEvent,
    IDocumentRevisionInfo,
    IDocumentRevisionStamp,
    TDocumentRevisionAuthority,
    TDocumentRevisionChangeReason,
    TDocumentRevisionToken,
} from '@contracts/documentRevision';
export {
    createBrowserStoreFileIdentity,
    decodeTypedStagedArtifact,
    isBrowserStoreFileIdentity,
    isBrowserStoreStagedArtifact,
    isTypedStagedArtifact,
} from '@contracts/stagedArtifacts';
export type {
    IBrowserStoreFileIdentity,
    IStagedArtifactValidations,
    ITypedStagedArtifact,
    TArtifactFileIdentity,
    TBrowserStoreStagedArtifact,
} from '@contracts/stagedArtifacts';
export {
    isDocumentRevisionInfo,
    parseDocumentRevisionToken,
    requireDocumentRevisionToken,
} from '@contracts/documentRevision';
export {
    DOCUMENT_MUTATION_ERROR_PREFIX,
    DocumentMutationError,
    createMissingRevisionError,
    createStaleRevisionError,
    createWorkingCopySyncRequiredError,
    encodeDocumentMutationError,
    getDocumentMutationErrorPayload,
    isDocumentMutationErrorCode,
    isMissingRevisionError,
    isStaleRevisionError,
    isWorkingCopySyncRequiredError,
} from '@contracts/documentMutationErrors';
export type {
    IDocumentMutationErrorPayload,
    TDocumentMutationErrorCode,
} from '@contracts/documentMutationErrors';

export {
    DJVU_PDF_CONVERSION_PRESET_SUBSAMPLES,
    DJVU_PDF_DIRECT_CONVERSION_EFFECTIVE_PIXEL_LIMIT,
    estimateDjvuPdfEffectivePixels,
    evaluateDjvuPdfConversionPolicy,
    normalizeDjvuPdfSubsample,
    resolveDjvuPdfExportStrategy,
    resolveRecommendedDjvuPdfSubsample,
} from '@contracts/djvuConversionPolicy';
export type {
    IDjvuConversionPageMetrics,
    IDjvuPdfConversionMetrics,
    IDjvuPdfConversionPolicyDecision,
    TDjvuPdfExportStrategy,
    TDjvuPdfResolvedExportStrategy,
} from '@contracts/djvuConversionPolicy';

export type {
    IEditorPaneRect,
    IEditorPaneState,
    IEditorLayoutLeafNode,
    IEditorLayoutSplitNode,
    TEditorLayoutNode,
    TPaneDirection,
    TPaneOrientation,
} from '@contracts/editorPanes';

export {
    MAX_IPC_PATH_LENGTH,
    assertAbsolutePath,
    assertNonEmptyString,
    assertOptionalAbsolutePath,
    isLikelyAbsolutePath,
} from '@contracts/ipcAssertions';

export {
    ALLOWED_EXTERNAL_PROTOCOLS,
    inspectAllowedExternalUrl,
    normalizeAllowedExternalUrl,
    parseAllowedExternalUrl,
    sanitizeAllowedExternalUrl,
} from '@contracts/externalUrl';

export type {IPdfBookmarkEntry} from '@contracts/pdfBookmarkEntry';

export type {
    IPdfSearchExcerpt,
    IPdfSearchProgress,
    IPdfSearchRequestOptions,
    IPdfSearchResponse,
    IPdfSearchResult,
    IPdfSearchUtf16Range,
    IResolvedSearchMatchOptions,
    ISearchMatchOptions,
    TPdfSearchUtf16Offset,
} from '@contracts/search';
export { AGENT_PLATFORM_FEATURE } from '@contracts/agentPlatformFeature';
export {
    DJVU_PLATFORM_FEATURE,
    type IDjvuEventMap,
    type IDjvuInvokeMap,
} from '@contracts/djvuPlatformFeature';
export {
    OCR_PLATFORM_FEATURE,
    type IOcrEventMap,
    type IOcrInvokeMap,
} from '@contracts/ocrPlatformFeature';
export { IMAGE_EXPORT_PLATFORM_FEATURE } from '@contracts/imageExportPlatformFeature';
export { PAGE_OPS_PLATFORM_FEATURE } from '@contracts/pageOpsPlatformFeature';
export { SEARCH_PLATFORM_FEATURE } from '@contracts/searchPlatformFeature';
export { SETTINGS_PLATFORM_FEATURE } from '@contracts/settingsPlatformFeature';
export { SHELL_PLATFORM_FEATURE } from '@contracts/shellPlatformFeature';
export { UPDATES_PLATFORM_FEATURE } from '@contracts/updatesPlatformFeature';
export { HOST_PLATFORM_FEATURE } from '@contracts/hostPlatformFeature';
export { SYSTEM_PLATFORM_FEATURE } from '@contracts/systemPlatformFeature';
export { WINDOW_TABS_PLATFORM_FEATURE } from '@contracts/windowTabsPlatformFeature';

export type {
    IMarkerRect,
    IPageGeometry,
    IPdfBox,
    IPoint2D,
} from '@contracts/geometry';

export type {
    IAllPageSelection,
    IComplementPageSelection,
    IEmptyPageSelection,
    IExceptionPageSelection,
    IExplicitPageSelection,
    IMappedPageSelection,
    IPredicatePageSelection,
    IRangePageSelection,
    IPageMoveRange,
    IPageMoveRangeSegment,
    IPageMoveRanges,
    IPageSelectionBatchOptions,
    TPageIndex,
    TPageNumber,
    TPageMoveOperation,
    TPageSelection,
    TPageSelectionPredicate,
} from '@contracts/pageNumbers';
export {
    buildPageMoveOrder,
    buildPageMoveRangesOrder,
    createAllPageSelection,
    createComplementOfPageSelection,
    createComplementPageSelection,
    createEmptyPageSelection,
    createExplicitPageSelection,
    createMappedPageSelection,
    createPageMoveRange,
    createPageMoveRanges,
    createPredicatePageSelection,
    createRangePageSelection,
    invertPageSelection,
    isPageMoveNoOp,
    isPageMoveOperationNoOp,
    isPageMoveRangesNoOp,
    isPageSelected,
    iteratePageSelection,
    iteratePageSelectionBatches,
    iteratePageSelectionRanges,
    mapPageNumberAfterPageMove,
    mapPageNumberBeforePageMove,
    materializePageSelection,
    pageMoveRangeLength,
    pageMoveRangesRestInsertIndex,
    pageMoveRangesSelectedPageCount,
    pageMoveRestInsertIndex,
    pageSelectionCount,
    pageIndexToPageNumber,
    pageNumberToPageIndex,
    parsePageIndex,
    parsePageNumber,
    requirePageIndex,
    requirePageNumber,
    togglePageSelection,
} from '@contracts/pageNumbers';

export { PDF_PAGE_LABEL_STYLE_VALUES } from '@contracts/pdfPageLabels';
export type {
    IPdfPageLabelRange,
    IPdfPageLabelsMutation,
    IPdfPageLabelSegment,
    TPdfPageLabelStyle,
} from '@contracts/pdfPageLabels';

export {
    PDF_ANNOTATION_LINE_END_STYLES,
    PDF_ANNOTATION_MARKUP_SUBTYPES,
    PDF_ANNOTATION_SHAPE_PDF_SUBTYPES,
    PDF_ANNOTATION_SHAPE_TYPES,
} from '@contracts/annotations';
export type {
    TPdfAnnotationLineEndStyle,
    TPdfAnnotationMarkupSubtype,
    TPdfAnnotationShapePdfSubtype,
    TPdfAnnotationShapeType,
} from '@contracts/annotations';

export {
    normalizePdfNativeAnnotationIdentityBindings,
    collectExpectedNativeIdentityIds,
    PDF_NATIVE_DATE_PATTERN,
    PDF_NATIVE_MUTATION_ENUM_VALUES,
    PDF_NATIVE_MUTATION_LIMITS,
    normalizePdfNativeModifiedAt,
    normalizePdfNativeMutationSet,
    normalizePdfNativeNoteChanges,
    normalizePdfNativeNoteTextUpdates,
} from '@contracts/nativePdfMutations';
export type {
    IPdfNativePlacedImageNativeToolPayload,
    IPdfNativeValidationOptions,
    TPdfNativeMutationSetNativeToolPayload,
} from '@contracts/nativePdfMutations';
export {
    NATIVE_ERROR_CODES,
    hasNativeErrorCode,
    isNativeErrorEnvelope,
} from '@contracts/nativeErrors';
export type {
    INativeErrorEnvelope,
    TNativeErrorCode,
} from '@contracts/nativeErrors';

export {
    GENERATED_RUST_NATIVE_TOOL_PROTOCOLS,
    SEARCH_NATIVE_PROTOCOL_VERSION,
} from '@contracts/nativeToolProtocols';
export type { IGeneratedRustNativeToolProtocol } from '@contracts/nativeToolProtocols';

export type {
    ILatestReleaseResponse,
    IReleaseInstaller,
    IReleaseSummary,
    IUserAgentProfile,
    TReleaseArch,
    TReleasePlatform,
} from '@contracts/release';
export {
    RELEASE_ARCHES,
    RELEASE_PLATFORMS,
} from '@contracts/release';

export {
    PDF_PERSISTENCE_DEFAULT_ACK_TIMEOUT_MS,
    PDF_PERSISTENCE_DEFAULT_CHUNK_BYTES,
    PDF_PERSISTENCE_DEFAULT_MAX_IN_FLIGHT_CHUNKS,
    PDF_PERSISTENCE_DEFAULT_RESULT_TIMEOUT_MS,
    PDF_PERSISTENCE_ERROR_CODES,
    PDF_PERSISTENCE_ERROR_PHASES,
    PDF_PERSISTENCE_MESSAGE_UNWRAP_DEPTH,
    SERIALIZED_PDF_PERSISTENCE_PROTOCOL_VERSION,
    createPdfPersistenceAckFrame,
    createPdfPersistenceCancelFrame,
    createPdfPersistenceChunkFrame,
    createPdfPersistenceCompleteFrame,
    createPdfPersistenceErrorFrame,
    createPdfPersistenceReadyFrame,
    createPdfPersistenceResultFrame,
    describePdfPersistenceMessage,
    getPdfPersistenceChunkBytes,
    getPdfPersistenceErrorMessage,
    isPdfPersistencePreloadToMainPayload,
    isSerializedPdfPersistenceLimits,
    normalizePdfPersistencePreloadToMainPayload,
    parsePdfPersistenceMainToPreloadFrame,
} from '@contracts/documentPersistenceFrames';
export type {
    IPdfPersistenceAckFrame,
    IPdfPersistenceCancelFrame,
    IPdfPersistenceChunkFrame,
    IPdfPersistenceCompleteFrame,
    IPdfPersistenceErrorFrame,
    IPdfPersistencePreloadToMainPayload,
    IPdfPersistenceReadyFrame,
    IPdfPersistenceResultFrame,
    ISerializedPdfPersistenceLimits,
    TPdfPersistenceErrorCode,
    TPdfPersistenceErrorPhase,
    TPdfPersistenceMainToPreloadFrame,
    TPdfPersistencePreloadToMainFrame,
} from '@contracts/documentPersistenceFrames';

export {
    AVAILABLE_OCR_LANGUAGES,
    AVAILABLE_OCR_LANGUAGE_CODES,
    BUNDLED_OCR_LANGUAGE_CODES,
    BUNDLED_OCR_LANGUAGE_CODE_SET,
    GREEK_OCR_LANGUAGE_CODES,
    RTL_OCR_LANGUAGE_CODES,
    isGreekOcrLanguage,
    isRtlOcrLanguage,
} from '@contracts/ocrLanguages';

export {
    DEFAULT_SETTINGS,
    SETTINGS_SAVE_KEYS,
    isSettingsSaveKey,
    normalizeLocale,
    normalizeTheme,
    pickSettingsSavePatch,
    sanitizeSettings,
    type TSettingsSaveKey,
    type TSettingsSavePatch,
} from '@contracts/settings';

export {
    isFiniteNumber,
    isFinitePositive,
    isErrnoException,
    isOneOf,
    isRecord,
    isSafeWorkerRequestId,
    isStringArray,
} from '@contracts/runtimeGuards';

export { safeJsonParse } from '@contracts/safeJsonParse';

export { isTimeoutError } from '@contracts/isTimeoutError';

export {
    ANALYTICS_GEO_LIMITS,
    normalizeAnalyticsGeo,
    normalizeAnalyticsScalar,
} from '@contracts/analytics';
export type {
    IAnalyticsGeoData,
    INormalizeAnalyticsScalarOptions,
    TAnalyticsScalarResult,
} from '@contracts/analytics';

export { getErrorMessage } from '@contracts/getErrorMessage';

export type {
    IRecentFile,
    IOcrLanguage,
    IOcrWord,
    ISettingsData,
    TAppLocale,
    TAppTheme,
    TFitMode,
    TZoomMode,
    TPdfViewMode,
} from '@contracts/shared';
export { isOcrWord } from '@contracts/shared';

export { parseClientDiagnosticsPreference } from '@contracts/diagnostics/diagnosticsPreference';
export type { TClientDiagnosticsPreference } from '@contracts/diagnostics/diagnosticsPreference';

export {
    AGENT_OCR_RUN_INPUT_SCHEMA,
    parseAgentOcrRunOptions,
} from '@contracts/agentOcr';
export type {
    IAgentOcrRunOptions,
    TAgentOcrPageRange,
} from '@contracts/agentOcr';

export {
    OCR_TEXT_LAYER_INDEX_SOURCE,
    OCR_TEXT_LAYER_INDEX_VERSION,
    buildOcrWordKey,
    buildOcrTextLayerIndexText,
    buildOcrTextLayerItemText,
    isLastOcrWordInLine,
} from '@contracts/ocrText';

export type {
    IOcrCatalogV4PreparedDescriptor,
    IOcrCatalogRootV4,
    IOcrCatalogSourceV4,
    IOcrGenerationV4,
    IOcrIndexV4PageMapping,
    IOcrIndexV3Manifest,
    IOcrIndexV3Page,
    IOcrPageMappingV4,
    IOcrShardIndex,
    IOcrShardIndexHeader,
    IOcrShardIndexRecord,
    IOcrShardV4,
    TOcrIndexRotation,
    TOcrPageArtifact,
} from '@contracts/ocrIndex';
export {
    OCR_CATALOG_PREPARED_DESCRIPTOR_VERSION,
    OCR_CATALOG_ROOT_MAX_BYTES,
    OCR_CATALOG_VERSION,
    OCR_MAX_GENERATION,
    OCR_MAX_PAGE_NUMBER,
    OCR_MAX_SHARD_NUMBER,
    OCR_MAX_CATALOG_RELATIVE_PATH_LENGTH,
    OCR_MAX_WINDOW_PAGES,
    OCR_SCALAR_PAGE_LIMIT,
    OCR_SHARD_INDEX_HEADER_BYTES,
    OCR_SHARD_INDEX_MAGIC,
    OCR_SHARD_INDEX_RECORD_BYTES,
    OCR_SHARD_SIZE,
    decodeOcrShardIndex,
    encodeOcrShardIndex,
    parseOcrCatalogRootV4,
    parseOcrCatalogV4PreparedDescriptor,
    parseOcrGenerationV4,
    parseOcrShardIndexHeader,
    parseOcrShardV4,
} from '@contracts/ocrIndex';

export type {
    IDjvuSplitPayload,
    IEmptySplitPayload,
    IPdfSnapshotSplitPayload,
    ITransferredTabState,
    IWindowTabIncomingTransfer,
    IWindowTabTargetWindow,
    IWindowTabTransferAck,
    IWindowTabTransferRequest,
    IWindowTabTransferResult,
    TSplitPayload,
    TWindowTabsAction,
    TWindowTabTransferTarget,
} from '@contracts/windowTabs';
export type {
    IWorkspaceCheckpoint,
    IWorkspaceCheckpointPane,
    IWorkspaceCheckpointTab,
} from '@contracts/workspaceCheckpoint';
export {decodeWorkspaceCheckpoint} from '@contracts/workspaceCheckpoint';
