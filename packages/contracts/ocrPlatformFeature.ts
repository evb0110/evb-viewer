import type {
    IOcrCancelResult,
    IOcrCompleteResult,
    IOcrDiagnostic,
    IOcrErrorEnvelope,
    IOcrJobStartResult,
    IOcrProgress,
    IOcrResultFileAckResult,
    IOcrSearchablePdfOptions,
    IOcrSearchablePdfPage,
    IOcrSearchablePdfPageRange,
    TOcrSearchablePdfPages,
} from '@contracts/electronApiOcr';
import {
    OCR_COMPLETE_EVENT_CHANNEL,
    OCR_DIAGNOSTIC_CODES,
    OCR_ERROR_CODES,
    OCR_PROGRESS_EVENT_CHANNEL,
    OCR_PROGRESS_PHASES,
} from '@contracts/electronApiOcr';
import {
    decodeDocumentOcrAvailability,
    decodeDocumentOcrPageSnapshot,
    decodeDocumentTextCatalogWindow,
    decodeDocumentTextSnapshot,
    MAX_DOCUMENT_TEXT_CATALOG_WINDOW_PAGES,
    type IDocumentOcrAvailability,
    type IDocumentOcrPageSnapshot,
    type IDocumentTextCatalogWindow,
    type IDocumentTextSnapshot,
} from '@contracts/documentTextCatalog';
import {
    parseDocumentRef,
    type TDocumentRef,
} from '@contracts/documentRef';
import { requirePageNumber } from '@contracts/pageNumbers';
import {
    parseDocumentRevisionToken,
    requireDocumentRevisionToken,
    type TDocumentRevisionToken,
} from '@contracts/documentRevision';
import {
    assertAbsolutePath,
    assertNonEmptyString,
    assertOptionalAbsolutePath,
} from '@contracts/ipcAssertions';
import { decodeOcrLanguages } from '@contracts/ocrLanguages';
import {
    argsSchema,
    definePlatformFeature,
    resultSchema,
    runtimeSchema as s,
    type IRuntimeSchema,
    type TFeatureCapability,
    type TFeatureEventMap,
    type TFeatureInvokeMap,
} from '@contracts/platformFeature';
import {
    isFiniteNumber,
    isOneOf,
    isRecord,
} from '@contracts/runtimeGuards';
import {
    parseJobId,
    parseRequestId,
    type IOcrLanguage,
    type TRequestId,
} from '@contracts/shared';
import {
    createEpochMs,
    isEpochMs,
    requireEpochMs,
} from '@contracts/timestamps';

const MAX_COLLECTION_ITEMS = 100_000;
const OCR_NATIVE_IPC_TIMEOUT_MS = 30 * 60 * 1_000;
const OCR_REQUEST_ID_MAX_LENGTH = 128;
const OMITTED_BROWSER_METHOD = {
    unsupported: 'omitted',
    reason: 'not-implemented',
} as const;

function requireArgs(args: readonly unknown[], count: number | {
    min: number;
    max: number
}) {
    const min = typeof count === 'number' ? count : count.min;
    const max = typeof count === 'number' ? count : count.max;
    if (args.length < min || args.length > max) {
        const expected = min === max ? String(min) : `${min}-${max}`;
        throw new Error(`expected ${expected} arguments, received ${args.length}`);
    }
    return args;
}

function decodeSafeIntegerArg(
    args: readonly unknown[],
    index: number,
    fieldName: string,
    min = 0,
) {
    const value = args[index];
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) {
        throw new Error(`${fieldName} must be a safe integer >= ${min}`);
    }
    return value;
}

function decodeStringArrayArg(args: readonly unknown[], index: number, fieldName: string) {
    const value = args[index];
    if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
        throw new Error(`${fieldName} must be an array of strings`);
    }
    return value.filter((item): item is string => typeof item === 'string');
}

function decodeBoundedArray(value: unknown, fieldName: string) {
    if (!Array.isArray(value)) {
        throw new Error(`${fieldName} must be an array`);
    }
    if (value.length > MAX_COLLECTION_ITEMS) {
        throw new Error(`${fieldName} exceeds maximum item count (${MAX_COLLECTION_ITEMS})`);
    }
    return value.map((item: unknown) => item);
}

function requireDecoded<T>(
    value: unknown,
    decode: (candidate: unknown) => T | null,
    label: string,
) {
    const decoded = decode(value);
    if (decoded === null) {
        throw new Error(`invalid ${label} IPC result`);
    }
    return decoded;
}

function decodeOcrErrorEnvelope(value: unknown): IOcrErrorEnvelope | undefined {
    if (value === undefined) {
        return undefined;
    }
    if (
        !isRecord(value)
        || !isOneOf(OCR_ERROR_CODES, value.code)
        || typeof value.message !== 'string'
        || typeof value.retryable !== 'boolean'
        || !isEpochMs(value.timestamp)
        || (value.details !== undefined && typeof value.details !== 'string')
    ) {
        throw new Error('invalid OCR error envelope');
    }
    return {
        code: value.code,
        message: value.message,
        retryable: value.retryable,
        timestamp: value.timestamp,
        ...(value.details === undefined ? {} : {details: value.details}),
    };
}

const optionalOcrErrorEnvelope = s.declared<IOcrErrorEnvelope | undefined>()(
    s.fromParser(decodeOcrErrorEnvelope, () => undefined),
);

function decodeOptionalErrorFields(value: Record<PropertyKey, unknown>) {
    if (value.error !== undefined && typeof value.error !== 'string') {
        throw new Error('error must be a string');
    }
    const errorEnvelope = optionalOcrErrorEnvelope.decode(value.errorEnvelope);
    return {
        ...(value.error === undefined ? {} : {error: value.error}),
        ...(errorEnvelope === undefined ? {} : {errorEnvelope}),
    };
}

function decodeSearchablePdfPages(value: unknown) {
    if (Array.isArray(value)) {
        return decodeBoundedArray(value, 'OCR searchable PDF pages').map((page) => {
            if (!isRecord(page)) {
                throw new Error('OCR searchable PDF page must be an object');
            }
            return {
                pageNumber: requirePageNumber(
                    decodeSafeIntegerArg([page.pageNumber], 0, 'pageNumber', 1),
                ),
                languages: decodeStringArrayArg([page.languages], 0, 'languages'),
            } satisfies IOcrSearchablePdfPage;
        }) satisfies IOcrSearchablePdfPage[];
    }
    if (!isRecord(value)) {
        throw new Error('OCR searchable PDF pages must be an array or scalar selection');
    }

    const selection = value.selection;
    if (selection !== undefined) {
        return decodeSearchablePdfPages(selection);
    }
    const kind = value.kind ?? value.mode ?? value.type;
    if (kind === 'pages') {
        return decodeSearchablePdfPages(value.pages);
    }
    if (kind !== 'all' && kind !== 'range' && kind !== 'ranges') {
        throw new Error('OCR searchable PDF selection kind must be all, range, ranges, or pages');
    }
    const languages = decodeStringArrayArg([value.languages], 0, 'languages');
    const decodePageNumber = (candidate: unknown, fieldName: string, min = 1) =>
        decodeSafeIntegerArg([candidate], 0, fieldName, min);
    if (kind === 'all') {
        return {
            kind: 'all',
            pageCount: decodePageNumber(value.pageCount, 'pageCount'),
            languages,
        } as const;
    }
    if (kind === 'range') {
        const firstPage = decodePageNumber(value.firstPage, 'firstPage');
        const lastPage = decodePageNumber(value.lastPage, 'lastPage', firstPage);
        if (lastPage < firstPage) {
            throw new Error('lastPage must be greater than or equal to firstPage');
        }
        return {
            kind: 'range',
            firstPage,
            lastPage,
            languages,
        } as const;
    }

    const rangesValue = value.ranges;
    const ranges = decodeBoundedArray(rangesValue, 'OCR searchable PDF ranges').map((range, index) => {
        if (!isRecord(range)) {
            throw new Error(`OCR searchable PDF range ${index} must be an object`);
        }
        const firstPage = decodePageNumber(range.firstPage, `ranges[${index}].firstPage`);
        const lastPage = decodePageNumber(range.lastPage, `ranges[${index}].lastPage`, firstPage);
        if (lastPage < firstPage) {
            throw new Error(`ranges[${index}].lastPage must be greater than or equal to firstPage`);
        }
        return {
            firstPage,
            lastPage,
        } satisfies IOcrSearchablePdfPageRange;
    });
    if (ranges.length === 0) {
        throw new Error('OCR searchable PDF ranges must be non-empty');
    }
    return {
        kind: 'ranges',
        ranges,
        languages,
    } as const;
}

function decodeSearchablePdfOptions(value: unknown): number | IOcrSearchablePdfOptions | undefined {
    if (value === undefined) {
        return undefined;
    }
    if (typeof value === 'number') {
        return decodeSafeIntegerArg([value], 0, 'renderDpi', 1);
    }
    if (!isRecord(value)) {
        throw new Error('OCR searchable PDF options must be an object');
    }
    const renderDpi = value.renderDpi === undefined
        ? undefined
        : decodeSafeIntegerArg([value.renderDpi], 0, 'renderDpi', 1);
    const pageSegmentationMode = value.pageSegmentationMode === undefined
        ? undefined
        : decodeSafeIntegerArg([value.pageSegmentationMode], 0, 'pageSegmentationMode', 0);
    if (
        value.qualityProfile !== undefined
        && value.qualityProfile !== 'balanced'
        && value.qualityProfile !== 'accurate'
        && value.qualityProfile !== 'poor-scan'
    ) {
        throw new Error('invalid OCR quality profile');
    }
    if (
        value.preprocessingMode !== undefined
        && value.preprocessingMode !== 'off'
        && value.preprocessingMode !== 'clean'
    ) {
        throw new Error('invalid OCR preprocessing mode');
    }
    if (
        value.supersessionPolicy !== undefined
        && value.supersessionPolicy !== 'missing-only'
        && value.supersessionPolicy !== 'replace-evb'
        && value.supersessionPolicy !== 'replace-all'
    ) {
        throw new Error('invalid OCR supersession policy');
    }
    if (value.replaceAllAcknowledged !== undefined && typeof value.replaceAllAcknowledged !== 'boolean') {
        throw new Error('invalid OCR replace-all acknowledgement');
    }
    if (value.supersessionPolicy === 'replace-all' && value.replaceAllAcknowledged !== true) {
        throw new Error('replace-all OCR requires acknowledgement');
    }
    return {
        ...(renderDpi === undefined ? {} : {renderDpi}),
        ...(value.qualityProfile === undefined ? {} : {qualityProfile: value.qualityProfile}),
        ...(value.preprocessingMode === undefined ? {} : {preprocessingMode: value.preprocessingMode}),
        ...(pageSegmentationMode === undefined ? {} : {pageSegmentationMode}),
        ...(value.supersessionPolicy === undefined ? {} : {supersessionPolicy: value.supersessionPolicy}),
        ...(value.replaceAllAcknowledged === undefined ? {} : {replaceAllAcknowledged: value.replaceAllAcknowledged}),
    };
}

function decodeJobStartResult(value: unknown) {
    const jobId = isRecord(value) ? parseJobId(value.jobId) : null;
    if (
        !isRecord(value)
        || typeof value.started !== 'boolean'
        || jobId === null
        || (value.installed !== undefined && (!Array.isArray(value.installed) || value.installed.some(item => typeof item !== 'string')))
        || (value.errors !== undefined && (!Array.isArray(value.errors) || value.errors.some(item => typeof item !== 'string')))
    ) {
        throw new Error('invalid OCR job result');
    }
    return {
        started: value.started,
        jobId,
        ...(value.installed === undefined ? {} : {installed: value.installed.map(String)}),
        ...(value.errors === undefined ? {} : {errors: value.errors.map(String)}),
        ...decodeOptionalErrorFields(value),
    };
}

function decodeCancelResult(value: unknown): IOcrCancelResult {
    if (
        !isRecord(value)
        || typeof value.canceled !== 'boolean'
        || (
            value.reason !== undefined
            && value.reason !== 'invalid-request'
            && value.reason !== 'not-found'
            && value.reason !== 'failed'
        )
    ) {
        throw new Error('invalid OCR cancellation result');
    }
    const reason: IOcrCancelResult['reason'] = value.reason;
    return {
        canceled: value.canceled,
        ...(reason === undefined ? {} : {reason}),
        ...decodeOptionalErrorFields(value),
    };
}

function decodeAckResult(value: unknown) {
    if (!isRecord(value) || typeof value.cleaned !== 'boolean') {
        throw new Error('invalid OCR result file acknowledgement');
    }
    return {
        cleaned: value.cleaned,
        ...decodeOptionalErrorFields(value),
    };
}

function buildMalformedCompleteResult(
    requestId: TRequestId,
    message = 'Malformed OCR completion payload',
): IOcrCompleteResult {
    return {
        requestId,
        success: false,
        errors: [message],
        errorEnvelope: {
            code: 'OCR_INVALID_PAYLOAD',
            message,
            retryable: false,
            timestamp: createEpochMs(),
        },
    };
}

function decodeOcrProgress(payload: unknown): IOcrProgress | null {
    const requestId = isRecord(payload) ? parseRequestId(payload.requestId) : null;
    if (
        !isRecord(payload)
        || requestId === null
        || !isFiniteNumber(payload.currentPage)
        || !isFiniteNumber(payload.processedCount)
        || !isFiniteNumber(payload.totalPages)
    ) {
        return null;
    }
    if (
        payload.phase !== undefined
        && (
            typeof payload.phase !== 'string'
            || !isOneOf(OCR_PROGRESS_PHASES, payload.phase)
        )
    ) {
        return null;
    }
    if (payload.phaseProgress !== undefined && !isFiniteNumber(payload.phaseProgress)) {
        return null;
    }
    if (payload.activePages !== undefined && (
        !Array.isArray(payload.activePages)
        || payload.activePages.some(page => !isFiniteNumber(page))
    )) {
        return null;
    }
    if (payload.languageCode !== undefined && typeof payload.languageCode !== 'string') {
        return null;
    }
    if (
        payload.status !== undefined
        && payload.status !== 'running'
        && payload.status !== 'success'
        && payload.status !== 'canceled'
        && payload.status !== 'failed'
    ) {
        return null;
    }
    if (payload.error !== undefined && typeof payload.error !== 'string') {
        return null;
    }

    return {
        requestId,
        currentPage: payload.currentPage,
        processedCount: payload.processedCount,
        totalPages: payload.totalPages,
        ...(payload.phase === undefined ? {} : {phase: payload.phase}),
        ...(payload.phaseProgress === undefined ? {} : {phaseProgress: payload.phaseProgress}),
        ...(payload.activePages === undefined ? {} : {activePages: payload.activePages.filter((page): page is number => isFiniteNumber(page))}),
        ...(payload.languageCode === undefined ? {} : {languageCode: payload.languageCode}),
        ...(payload.status === undefined ? {} : {status: payload.status}),
        ...(payload.error === undefined ? {} : {error: payload.error}),
    };
}

function decodeOcrDiagnostics(value: unknown): IOcrDiagnostic[] | null | undefined {
    if (value === undefined) {
        return undefined;
    }
    if (!Array.isArray(value)) {
        return null;
    }
    const diagnostics: IOcrDiagnostic[] = [];
    for (const diagnostic of value) {
        if (
            !isRecord(diagnostic)
            || !isOneOf(OCR_DIAGNOSTIC_CODES, diagnostic.code)
            || (diagnostic.severity !== 'info' && diagnostic.severity !== 'warning')
            || typeof diagnostic.message !== 'string'
            || (diagnostic.pageNumber !== undefined && (
                typeof diagnostic.pageNumber !== 'number'
                || !Number.isSafeInteger(diagnostic.pageNumber)
                || diagnostic.pageNumber < 1
            ))
        ) {
            return null;
        }
        diagnostics.push({
            code: diagnostic.code,
            severity: diagnostic.severity,
            message: diagnostic.message,
            ...(diagnostic.pageNumber === undefined
                ? {}
                : {pageNumber: requirePageNumber(diagnostic.pageNumber)}),
        });
    }
    return diagnostics;
}

function decodeOcrEventErrorEnvelope(payload: unknown): IOcrErrorEnvelope | null {
    if (
        !isRecord(payload)
        || !isOneOf(OCR_ERROR_CODES, payload.code)
        || typeof payload.message !== 'string'
        || typeof payload.retryable !== 'boolean'
        || !isEpochMs(payload.timestamp)
    ) {
        return null;
    }
    if (payload.details !== undefined && typeof payload.details !== 'string') {
        return null;
    }

    return {
        code: payload.code,
        message: payload.message,
        retryable: payload.retryable,
        timestamp: payload.timestamp,
        ...(payload.details === undefined ? {} : {details: payload.details}),
    };
}

const ocrEventErrorEnvelope = s.declared<IOcrErrorEnvelope>()(
    s.fromNullableDecoder(
        decodeOcrEventErrorEnvelope,
        'OCR error envelope',
        () => ({
            code: 'OCR_INTERNAL_ERROR',
            message: 'OCR failed',
            retryable: false,
            timestamp: requireEpochMs(0),
        }),
    ),
);

function decodeOcrCompleteResult(payload: unknown): IOcrCompleteResult | null {
    if (!isRecord(payload)) {
        return null;
    }
    const requestId = parseRequestId(payload.requestId);
    if (requestId === null) {
        return null;
    }
    const pdfPath = payload.pdfPath === undefined ? undefined : parseDocumentRef(payload.pdfPath);

    if (
        typeof payload.success !== 'boolean'
        || !Array.isArray(payload.errors)
        || payload.errors.some(error => typeof error !== 'string')
    ) {
        return buildMalformedCompleteResult(requestId);
    }
    if (pdfPath === null) {
        return buildMalformedCompleteResult(requestId);
    }
    const sourceDocumentRevisionToken = payload.sourceDocumentRevisionToken === undefined
        ? undefined
        : parseDocumentRevisionToken(payload.sourceDocumentRevisionToken);
    if (sourceDocumentRevisionToken === null) {
        return buildMalformedCompleteResult(requestId);
    }
    if (payload.requiresCleanupAck !== undefined && typeof payload.requiresCleanupAck !== 'boolean') {
        return buildMalformedCompleteResult(requestId);
    }
    const resultSha256 = payload.resultSha256 === undefined
        ? undefined
        : typeof payload.resultSha256 === 'string' && /^[a-f0-9]{64}$/u.test(payload.resultSha256)
            ? payload.resultSha256
            : null;
    if (resultSha256 === null) {
        return buildMalformedCompleteResult(requestId);
    }
    if (
        payload.success
        && (
            pdfPath === undefined
            || sourceDocumentRevisionToken === undefined
            || resultSha256 === undefined
            || typeof payload.requiresCleanupAck !== 'boolean'
        )
    ) {
        return buildMalformedCompleteResult(requestId);
    }
    let errorEnvelope: IOcrErrorEnvelope | null = null;
    if (payload.errorEnvelope !== undefined) {
        try {
            errorEnvelope = ocrEventErrorEnvelope.decode(payload.errorEnvelope);
        } catch {
            return buildMalformedCompleteResult(
                requestId,
                'Malformed OCR completion error envelope',
            );
        }
    }
    const errors = payload.errors.filter((error): error is string => typeof error === 'string');
    const diagnostics = decodeOcrDiagnostics(payload.diagnostics);
    if (diagnostics === null) {
        return buildMalformedCompleteResult(
            requestId,
            'Malformed OCR completion diagnostics',
        );
    }

    return {
        requestId,
        success: payload.success,
        errors,
        ...(diagnostics === undefined ? {} : {diagnostics}),
        ...(pdfPath === undefined ? {} : {pdfPath}),
        ...(sourceDocumentRevisionToken === undefined ? {} : {sourceDocumentRevisionToken}),
        ...(resultSha256 === undefined ? {} : {resultSha256}),
        ...(payload.requiresCleanupAck === undefined ? {} : {requiresCleanupAck: payload.requiresCleanupAck}),
        ...(errorEnvelope === null ? {} : {errorEnvelope}),
    };
}

type TOcrCreateSearchablePdfArgs = [
    sourcePdfPath: TDocumentRef,
    pages: TOcrSearchablePdfPages,
    requestId: TRequestId,
    renderDpiOrOptions?: number | IOcrSearchablePdfOptions,
];
type TOcrAcknowledgeResultFileArgs = [
    requestId: TRequestId,
    pdfPath?: TDocumentRef,
    documentRef?: TDocumentRef,
    sourceDocumentRevisionToken?: TDocumentRevisionToken,
];
type TResolveDocumentTextCatalogArgs =
    | [workingCopyPath: TDocumentRef, documentRevision: TDocumentRevisionToken]
    | [workingCopyPath: TDocumentRef, documentRevision: TDocumentRevisionToken, pageCount: number]
    | [
        workingCopyPath: TDocumentRef,
        documentRevision: TDocumentRevisionToken,
        pageCount: undefined,
        requestId: TRequestId,
    ]
    | [
        workingCopyPath: TDocumentRef,
        documentRevision: TDocumentRevisionToken,
        pageCount: number,
        requestId: TRequestId,
    ];
type TResolveDocumentTextCatalogWindowArgs =
    | [
        workingCopyPath: TDocumentRef,
        documentRevision: TDocumentRevisionToken,
        firstPage: number,
        lastPage: number,
    ]
    | [
        workingCopyPath: TDocumentRef,
        documentRevision: TDocumentRevisionToken,
        firstPage: number,
        lastPage: number,
        pageCount: number,
    ]
    | [
        workingCopyPath: TDocumentRef,
        documentRevision: TDocumentRevisionToken,
        firstPage: number,
        lastPage: number,
        pageCount: undefined,
        requestId: TRequestId,
    ]
    | [
        workingCopyPath: TDocumentRef,
        documentRevision: TDocumentRevisionToken,
        firstPage: number,
        lastPage: number,
        pageCount: number,
        requestId: TRequestId,
    ];

function decodeDocumentRevisionArg(
    args: readonly unknown[],
    index: number,
    fieldName = 'documentRevision',
) {
    const documentRevision = parseDocumentRevisionToken(args[index]);
    if (documentRevision === null) {
        throw new Error(`${fieldName} must be a valid revision token`);
    }
    return documentRevision;
}

const createSearchablePdfArgs = argsSchema<TOcrCreateSearchablePdfArgs>(
    (args) => {
        requireArgs(args, {
            min: 3,
            max: 4,
        });
        const requiredArgs: [
            TDocumentRef,
            TOcrSearchablePdfPages,
            TRequestId,
        ] = [
            assertAbsolutePath(
                args[0],
                'ocrCreateSearchablePdf.sourcePdfPath',
            ),
            decodeSearchablePdfPages(args[1]),
            assertRequestId(
                args[2],
                'ocrCreateSearchablePdf.requestId',
            ),
        ];
        const options = decodeSearchablePdfOptions(args[3]);
        return options === undefined
            ? requiredArgs
            : [
                ...requiredArgs,
                options,
            ];
    },
    () => [
        assertAbsolutePath('/tmp/ocr-fixture.pdf', 'fixture sourcePdfPath'),
        [{
            pageNumber: requirePageNumber(1),
            languages: ['eng'],
        }],
        assertRequestId('ocr-searchable-pdf-fixture', 'fixture requestId'),
        {renderDpi: 300},
    ],
);
const requestIdArgs = argsSchema<[TRequestId]>(
    args => [assertRequestId(requireArgs(args, 1)[0], 'requestId')],
    () => [parseRequestId('ocr-request-fixture') ?? (() => { throw new TypeError('invalid request ID fixture'); })()],
);
const acknowledgeResultFileArgs = argsSchema<TOcrAcknowledgeResultFileArgs>(
    (args) => {
        requireArgs(args, {
            min: 1,
            max: 4,
        });
        const requestId = assertRequestId(
            args[0],
            'ocrAcknowledgeResultFile.requestId',
        );
        const pdfPath = assertOptionalAbsolutePath(
            args[1],
            'ocrAcknowledgeResultFile.pdfPath',
        );
        const documentRef = assertOptionalAbsolutePath(
            args[2],
            'ocrAcknowledgeResultFile.documentRef',
        );
        const sourceDocumentRevisionToken = args[3] === undefined
            ? undefined
            : parseDocumentRevisionToken(args[3]);
        if (args[3] !== undefined && sourceDocumentRevisionToken === null) {
            throw new TypeError('ocrAcknowledgeResultFile.sourceDocumentRevisionToken must be a non-empty string');
        }
        if (documentRef === undefined && sourceDocumentRevisionToken !== undefined) {
            throw new TypeError('ocrAcknowledgeResultFile.documentRef is required with sourceDocumentRevisionToken');
        }
        if (documentRef !== undefined && pdfPath === undefined) {
            throw new TypeError('ocrAcknowledgeResultFile.pdfPath is required with documentRef');
        }
        if (documentRef !== undefined && sourceDocumentRevisionToken === undefined) {
            throw new TypeError('ocrAcknowledgeResultFile.sourceDocumentRevisionToken is required with documentRef');
        }
        if (pdfPath === undefined && documentRef === undefined && sourceDocumentRevisionToken === undefined) {
            return [requestId];
        }
        if (pdfPath !== undefined && documentRef === undefined) {
            return [
                requestId,
                pdfPath,
            ];
        }
        if (pdfPath === undefined || documentRef === undefined || !sourceDocumentRevisionToken) {
            throw new TypeError('ocrAcknowledgeResultFile document scope is incomplete');
        }
        return [
            requestId,
            pdfPath,
            documentRef,
            sourceDocumentRevisionToken,
        ];
    },
    () => [
        assertRequestId('ocr-request-fixture', 'fixture requestId'),
        assertAbsolutePath('/tmp/ocr-result-fixture.pdf', 'fixture pdfPath'),
    ],
);
const resolveDocumentTextCatalogArgs = argsSchema<TResolveDocumentTextCatalogArgs>(
    (args) => {
        requireArgs(args, {
            min: 2,
            max: 4,
        });
        const requiredArgs: [
            TDocumentRef,
            TDocumentRevisionToken,
        ] = [
            assertAbsolutePath(
                args[0],
                'resolveDocumentTextCatalog.workingCopyPath',
            ),
            decodeDocumentRevisionArg(
                args,
                1,
                'resolveDocumentTextCatalog.documentRevision',
            ),
        ];
        const pageCount = args[2] === undefined
            ? undefined
            : decodeSafeIntegerArg(args, 2, 'pageCount', 0);
        const requestId = args[3] === undefined
            ? undefined
            : assertRequestId(args[3], 'resolveDocumentTextCatalog.requestId');
        if (requestId === undefined) {
            if (pageCount === undefined) {
                return requiredArgs;
            }
            const pageCountArgs: [
                TDocumentRef,
                TDocumentRevisionToken,
                number,
            ] = [
                requiredArgs[0],
                requiredArgs[1],
                pageCount,
            ];
            return pageCountArgs;
        }
        if (pageCount === undefined) {
            const requestIdArgs: [
                TDocumentRef,
                TDocumentRevisionToken,
                undefined,
                TRequestId,
            ] = [
                requiredArgs[0],
                requiredArgs[1],
                undefined,
                requestId,
            ];
            return requestIdArgs;
        }
        const requestIdArgs: [
            TDocumentRef,
            TDocumentRevisionToken,
            number,
            TRequestId,
        ] = [
            requiredArgs[0],
            requiredArgs[1],
            pageCount,
            requestId,
        ];
        return requestIdArgs;
    },
    () => [
        assertAbsolutePath('/tmp/ocr-fixture.pdf', 'fixture workingCopyPath'),
        requireDocumentRevisionToken('drt1:ocr-fixture'),
        1,
    ],
);
const resolveDocumentTextCatalogWindowArgs = argsSchema<TResolveDocumentTextCatalogWindowArgs>(
    (args) => {
        requireArgs(args, {
            min: 4,
            max: 6,
        });
        const firstPage = decodeSafeIntegerArg(args, 2, 'firstPage', 1);
        const lastPage = decodeSafeIntegerArg(args, 3, 'lastPage', firstPage);
        if (lastPage < firstPage) {
            throw new Error('lastPage must be greater than or equal to firstPage');
        }
        if (lastPage - firstPage + 1 > MAX_DOCUMENT_TEXT_CATALOG_WINDOW_PAGES) {
            throw new Error(`document text catalog windows may contain at most ${MAX_DOCUMENT_TEXT_CATALOG_WINDOW_PAGES} pages`);
        }
        const pageCount = args[4] === undefined
            ? undefined
            : decodeSafeIntegerArg(args, 4, 'pageCount', lastPage);
        const requestId = args[5] === undefined
            ? undefined
            : assertRequestId(args[5], 'resolveDocumentTextCatalogWindow.requestId');
        const requiredArgs: [
            TDocumentRef,
            TDocumentRevisionToken,
            number,
            number,
        ] = [
            assertAbsolutePath(
                args[0],
                'resolveDocumentTextCatalogWindow.workingCopyPath',
            ),
            decodeDocumentRevisionArg(
                args,
                1,
                'resolveDocumentTextCatalogWindow.documentRevision',
            ),
            firstPage,
            lastPage,
        ];
        if (requestId === undefined) {
            if (pageCount === undefined) {
                return requiredArgs;
            }
            const pageCountArgs: [
                TDocumentRef,
                TDocumentRevisionToken,
                number,
                number,
                number,
            ] = [
                requiredArgs[0],
                requiredArgs[1],
                requiredArgs[2],
                requiredArgs[3],
                pageCount,
            ];
            return pageCountArgs;
        }
        if (pageCount === undefined) {
            const requestIdArgs: [
                TDocumentRef,
                TDocumentRevisionToken,
                number,
                number,
                undefined,
                TRequestId,
            ] = [
                requiredArgs[0],
                requiredArgs[1],
                requiredArgs[2],
                requiredArgs[3],
                undefined,
                requestId,
            ];
            return requestIdArgs;
        }
        const requestIdArgs: [
            TDocumentRef,
            TDocumentRevisionToken,
            number,
            number,
            number,
            TRequestId,
        ] = [
            requiredArgs[0],
            requiredArgs[1],
            requiredArgs[2],
            requiredArgs[3],
            pageCount,
            requestId,
        ];
        return requestIdArgs;
    },
    () => [
        assertAbsolutePath('/tmp/ocr-fixture.pdf', 'fixture workingCopyPath'),
        requireDocumentRevisionToken('drt1:ocr-fixture'),
        1,
        64,
        64,
    ],
);
const resolveDocumentOcrAvailabilityArgs = argsSchema<[
    TDocumentRef,
    TDocumentRevisionToken,
]>(
    (args) => {
        requireArgs(args, 2);
        return [
            assertAbsolutePath(
                args[0],
                'resolveDocumentOcrAvailability.workingCopyPath',
            ),
            decodeDocumentRevisionArg(
                args,
                1,
                'resolveDocumentOcrAvailability.documentRevision',
            ),
        ];
    },
    () => [
        assertAbsolutePath('/tmp/ocr-fixture.pdf', 'fixture workingCopyPath'),
        requireDocumentRevisionToken('drt1:ocr-fixture'),
    ],
);
const resolveDocumentOcrPageArgs = argsSchema<[
    TDocumentRef,
    TDocumentRevisionToken,
    number,
]>(
    (args) => {
        requireArgs(args, 3);
        return [
            assertAbsolutePath(
                args[0],
                'resolveDocumentOcrPage.workingCopyPath',
            ),
            decodeDocumentRevisionArg(
                args,
                1,
                'resolveDocumentOcrPage.documentRevision',
            ),
            decodeSafeIntegerArg(args, 2, 'pageNumber', 1),
        ];
    },
    () => [
        assertAbsolutePath('/tmp/ocr-fixture.pdf', 'fixture workingCopyPath'),
        requireDocumentRevisionToken('drt1:ocr-fixture'),
        1,
    ],
);
const jobStartResult = resultSchema<IOcrJobStartResult>(decodeJobStartResult, () => ({
    started: true,
    jobId: parseJobId('ocr-job-fixture') ?? (() => { throw new TypeError('invalid job ID fixture'); })(),
}));
const cancelResult = resultSchema(decodeCancelResult, () => ({canceled: false}));
const acknowledgeResult =
    resultSchema<IOcrResultFileAckResult>(decodeAckResult, () => ({cleaned: true}));
const languagesResult = resultSchema<IOcrLanguage[]>(
    value => requireDecoded(value, decodeOcrLanguages, 'OCR languages'),
    () => [{
        code: 'eng',
        script: 'latin',
    }],
);
const documentTextCatalogResult = resultSchema<IDocumentTextSnapshot>(
    value => requireDecoded(
        value,
        decodeDocumentTextSnapshot,
        'DocumentTextCatalog snapshot',
    ),
    () => ({
        documentRevision: requireDocumentRevisionToken('drt1:ocr-fixture'),
        pageCount: 0,
        pages: [],
        contentDigest: '',
    }),
);
const documentTextCatalogWindowResult = resultSchema<IDocumentTextCatalogWindow>(
    value => requireDecoded(
        value,
        decodeDocumentTextCatalogWindow,
        'DocumentTextCatalog window',
    ),
    () => ({
        documentRevision: requireDocumentRevisionToken('drt1:ocr-fixture'),
        pageCount: 64,
        firstPage: 1,
        lastPage: 64,
        pages: [],
        contentDigest: '',
    }),
);
const documentOcrAvailabilityResult = resultSchema<IDocumentOcrAvailability>(
    value => requireDecoded(
        value,
        decodeDocumentOcrAvailability,
        'document OCR availability',
    ),
    () => ({
        documentRevision: requireDocumentRevisionToken('drt1:ocr-fixture'),
        pageCount: 0,
        mappedPageCount: 0,
        pageRanges: [],
        rangesComplete: true,
    }),
);
const documentOcrPageResult = resultSchema<IDocumentOcrPageSnapshot>(
    value => requireDecoded(
        value,
        decodeDocumentOcrPageSnapshot,
        'document OCR page',
    ),
    () => ({
        documentRevision: requireDocumentRevisionToken('drt1:ocr-fixture'),
        pageCount: 0,
        page: null,
    }),
);
const progress = s.declared<IOcrProgress>()(
    s.fromNullableDecoder(decodeOcrProgress, 'OCR progress', () => ({
        requestId: parseRequestId('ocr-request-fixture') ?? (() => { throw new TypeError('invalid request ID fixture'); })(),
        currentPage: 1,
        processedCount: 0,
        totalPages: 1,
        status: 'running',
    })),
);
const completeResult = s.declared<IOcrCompleteResult>()(
    s.fromNullableDecoder(decodeOcrCompleteResult, 'OCR completion', () => ({
        requestId: parseRequestId('ocr-request-fixture') ?? (() => { throw new TypeError('invalid request ID fixture'); })(),
        success: false,
        errors: [],
    })),
);
const progressReplay = {
    owner: 'ipc-progress-pump',
    mode: 'latest-per-key',
    key: (payload: IOcrProgress) => payload.requestId,
    terminal: (payload: IOcrProgress) =>
        payload.status === 'success'
        || payload.status === 'canceled'
        || payload.status === 'failed',
    intervalMs: 50,
    terminalRetentionMs: 30_000,
} as const;

function assertRequestId(value: unknown, fieldName: string): TRequestId {
    const normalized = assertNonEmptyString(value, fieldName, OCR_REQUEST_ID_MAX_LENGTH);
    const parsed = parseRequestId(normalized);
    if (parsed === null) {
        throw new Error(`${fieldName} must be a valid request ID`);
    }
    return parsed;
}

function defineOcrMethod<
    const TName extends string,
    const TChannel extends string,
    const TArgs extends IRuntimeSchema<unknown[]>,
    const TResult extends IRuntimeSchema<unknown>,
>(definition: {
    name: TName;
    channel: TChannel;
    args: TArgs;
    result: TResult;
    timeout?: boolean;
    optionalWhenImplemented?: boolean;
}) {
    return {
        kind: 'async',
        channel: definition.channel,
        ipc: {
            args: definition.args,
            result: definition.result,
            ...(definition.timeout ? {timeoutMs: OCR_NATIVE_IPC_TIMEOUT_MS} : {}),
        },
        main: {
            method: definition.name,
            context: 'sender',
        },
        browser: definition.optionalWhenImplemented
            ? OMITTED_BROWSER_METHOD
            : {method: definition.name},
        ...(definition.optionalWhenImplemented
            ? {
                optionalWhenImplemented: true,
                required: {
                    browser: false,
                    electron: false,
                },
            }
            : {}),
        lazy: 'forwarded',
    } as const;
}

export const OCR_PLATFORM_FEATURE = definePlatformFeature({
    path: ['ocr'],
    required: {
        browser: true,
        electron: true,
    },
    methods: {
        cancel: defineOcrMethod({
            name: 'cancel',
            channel: 'ocr:cancel',
            args: requestIdArgs,
            result: cancelResult,
        }),
        getLanguages: defineOcrMethod({
            name: 'getLanguages',
            channel: 'ocr:getLanguages',
            args: s.tuple([]),
            result: languagesResult,
        }),
        resolveDocumentTextCatalog: defineOcrMethod({
            name: 'resolveDocumentTextCatalog',
            channel: 'ocr:resolveDocumentTextCatalog',
            args: resolveDocumentTextCatalogArgs,
            result: documentTextCatalogResult,
            timeout: true,
        }),
        resolveDocumentTextCatalogWindow: defineOcrMethod({
            name: 'resolveDocumentTextCatalogWindow',
            channel: 'ocr:resolveDocumentTextCatalogWindow',
            args: resolveDocumentTextCatalogWindowArgs,
            result: documentTextCatalogWindowResult,
            timeout: true,
        }),
        resolveDocumentOcrAvailability: defineOcrMethod({
            name: 'resolveDocumentOcrAvailability',
            channel: 'ocr:resolveDocumentOcrAvailability',
            args: resolveDocumentOcrAvailabilityArgs,
            result: documentOcrAvailabilityResult,
            timeout: true,
            optionalWhenImplemented: true,
        }),
        resolveDocumentOcrPage: defineOcrMethod({
            name: 'resolveDocumentOcrPage',
            channel: 'ocr:resolveDocumentOcrPage',
            args: resolveDocumentOcrPageArgs,
            result: documentOcrPageResult,
            timeout: true,
            optionalWhenImplemented: true,
        }),
        acknowledgeResultFile: defineOcrMethod({
            name: 'acknowledgeResultFile',
            channel: 'ocr:ackResultFile',
            args: acknowledgeResultFileArgs,
            result: acknowledgeResult,
        }),
        createSearchablePdf: defineOcrMethod({
            name: 'createSearchablePdf',
            channel: 'ocr:createSearchablePdf',
            args: createSearchablePdfArgs,
            result: jobStartResult,
            timeout: true,
        }),
    },
    events: {
        onProgress: {
            kind: 'event',
            channel: OCR_PROGRESS_EVENT_CHANNEL,
            payload: progress,
            subscription: {
                channel: 'ocr:progress:subscribe',
                request: 'once-per-preload-event-channel',
                main: {
                    method: 'subscribeProgress',
                    context: 'sender',
                },
                replay: progressReplay,
            },
            browser: {method: 'onProgress'},
            lazy: 'forwarded',
        },
        onComplete: {
            kind: 'event',
            channel: OCR_COMPLETE_EVENT_CHANNEL,
            payload: completeResult,
            browser: {method: 'onComplete'},
            lazy: 'forwarded',
        },
    },
});

type TOcrFeatureCapability = TFeatureCapability<typeof OCR_PLATFORM_FEATURE>;
type TOcrHotReloadMethod = 'resolveDocumentOcrAvailability' | 'resolveDocumentOcrPage';

export type IOcrCapability =
    Omit<TOcrFeatureCapability, TOcrHotReloadMethod>
    & Partial<Pick<TOcrFeatureCapability, TOcrHotReloadMethod>>;
export type IOcrInvokeMap = TFeatureInvokeMap<typeof OCR_PLATFORM_FEATURE>;
export type IOcrEventMap = TFeatureEventMap<typeof OCR_PLATFORM_FEATURE>;
