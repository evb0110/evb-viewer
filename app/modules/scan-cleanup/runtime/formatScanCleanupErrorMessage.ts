import { getErrorMessage } from '@app/utils/error';
import type {
    IScanCleanupScratchShortfall,
    TScanCleanupErrorCode,
} from '@contracts/scan-cleanup/electronApiScanCleanup';
import type {
    TTranslateFn,
    TTranslationKey,
} from '@i18n-app';
import {formatBytes} from '@app/utils/formatters';

const SCAN_CLEANUP_ERROR_MESSAGE_KEYS = {
    encrypted: 'scanCleanup.errors.encrypted',
    'needs-password': 'scanCleanup.errors.needsPassword',
    'too-large': 'scanCleanup.errors.tooLarge',
    'corrupt-xref': 'scanCleanup.errors.corruptXref',
    'unsupported-filter': 'scanCleanup.errors.unsupportedFilter',
    'invalid-request': 'scanCleanup.errors.invalidRequest',
    io: 'scanCleanup.errors.io',
    timeout: 'scanCleanup.errors.timeout',
    panic: 'scanCleanup.errors.panic',
    'native-failure': 'scanCleanup.errors.nativeFailure',
    'tools-unavailable': 'scanCleanup.errors.toolsUnavailable',
    'insufficient-scratch': 'scanCleanup.errors.insufficientScratch',
    canceled: 'scanCleanup.errors.canceled',
    'detection-results-unavailable': 'scanCleanup.errors.detectionResultsUnavailable',
    internal: 'scanCleanup.errors.internal',
} as const satisfies Record<TScanCleanupErrorCode, TTranslationKey>;

const MAX_SCAN_CLEANUP_TECHNICAL_DETAIL_LENGTH = 240;

function getScanCleanupTechnicalDetail(error: unknown) {
    const detail = typeof error === 'string'
        ? error
        : error instanceof Error ? getErrorMessage(error) : '';
    const trimmed = detail.trim();
    if (trimmed.length <= MAX_SCAN_CLEANUP_TECHNICAL_DETAIL_LENGTH) {
        return trimmed;
    }
    return `${trimmed.slice(0, MAX_SCAN_CLEANUP_TECHNICAL_DETAIL_LENGTH - 3)}...`;
}

/**
 * Keeps renderer-owned wording localized while retaining a short raw bridge
 * detail for diagnostics when the existing alert/toast has no separate detail
 * channel.
 */
export function formatScanCleanupErrorMessage(message: string, error: unknown) {
    const detail = getScanCleanupTechnicalDetail(error);
    return detail && detail !== message
        ? `${message} (${detail})`
        : message;
}

/**
 * Formats the only detection failure that gives the user an actionable
 * storage remedy. The figures stay typed at the bridge and are localized at
 * the detection session's UI boundary.
 */
export function formatScanCleanupScratchMessage(
    t: TTranslateFn,
    shortfall: IScanCleanupScratchShortfall | undefined,
) {
    const headline = t('scanCleanup.errors.insufficientScratch');
    if (
        shortfall === undefined
        || shortfall.requiredBytes === null
        || shortfall.availableBytes === null
    ) {
        return headline;
    }
    return `${headline} ${t('scanCleanup.errors.insufficientScratchSpace', {
        required: formatBytes(shortfall.requiredBytes),
        available: formatBytes(shortfall.availableBytes),
    })}`;
}

export function formatScanCleanupErrorByCode(
    t: TTranslateFn,
    errorCode: TScanCleanupErrorCode,
    technicalDetail: unknown,
    scratchShortfall?: IScanCleanupScratchShortfall,
) {
    if (errorCode === 'insufficient-scratch') {
        return formatScanCleanupScratchMessage(t, scratchShortfall);
    }
    return formatScanCleanupErrorMessage(t(SCAN_CLEANUP_ERROR_MESSAGE_KEYS[errorCode]), technicalDetail);
}
