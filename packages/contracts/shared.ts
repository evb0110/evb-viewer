import {
    createBrandedId,
    isBrandedString,
    parseBranded,
} from '@contracts/brand';
import type {TBrand} from '@contracts/brand';
import type { TLocale } from '@i18n-core';
import type { TClientDiagnosticsPreference } from '@contracts/diagnostics/diagnosticsPreference';
import type {
    TDocumentBackend,
    TDocumentRef,
} from '@contracts/documentRef';
import type { IPdfBox as IPdfGeometryBox } from '@contracts/geometry';
import type { TPerformanceMode } from '@contracts/hostResourceProfile';
import { isRecord } from '@contracts/runtimeGuards';
import type {TEpochMs} from '@contracts/timestamps';

export type TRequestId = TBrand<string, 'RequestId'>;
export type TSessionId = TBrand<string, 'SessionId'>;
export type TJobId = TBrand<string, 'JobId'>;
export type TLeaseId = TBrand<string, 'LeaseId'>;

export function isRequestId(value: unknown): value is TRequestId {
    return isBrandedString<'RequestId'>(value);
}

export function isSessionId(value: unknown): value is TSessionId {
    return isBrandedString<'SessionId'>(value);
}

export function isJobId(value: unknown): value is TJobId {
    return isBrandedString<'JobId'>(value);
}

export function isLeaseId(value: unknown): value is TLeaseId {
    return isBrandedString<'LeaseId'>(value);
}

function parseIdentifier<TIdentifier>(
    value: unknown,
    guard: (candidate: unknown) => candidate is TIdentifier,
): TIdentifier | null {
    const normalized = typeof value === 'string' ? value.trim() : value;
    return parseBranded(normalized, guard);
}

export function parseRequestId(value: unknown): TRequestId | null {
    return parseIdentifier(value, isRequestId);
}

export function parseSessionId(value: unknown): TSessionId | null {
    return parseIdentifier(value, isSessionId);
}

export function parseJobId(value: unknown): TJobId | null {
    return parseIdentifier(value, isJobId);
}

export function parseLeaseId(value: unknown): TLeaseId | null {
    return parseIdentifier(value, isLeaseId);
}

export function requireRequestId(value: unknown): TRequestId {
    const parsed = parseRequestId(value);
    if (parsed === null) {
        throw new TypeError('Request ID must be a non-empty string');
    }
    return parsed;
}

export function requireSessionId(value: unknown): TSessionId {
    const parsed = parseSessionId(value);
    if (parsed === null) {
        throw new TypeError('Session ID must be a non-empty string');
    }
    return parsed;
}

export function requireJobId(value: unknown): TJobId {
    const parsed = parseJobId(value);
    if (parsed === null) {
        throw new TypeError('Job ID must be a non-empty string');
    }
    return parsed;
}

export function requireLeaseId(value: unknown): TLeaseId {
    const parsed = parseLeaseId(value);
    if (parsed === null) {
        throw new TypeError('Lease ID must be a non-empty string');
    }
    return parsed;
}

export function createRequestId(prefix = 'request'): TRequestId {
    return createBrandedId(prefix, isRequestId);
}

export function createSessionId(prefix = 'session'): TSessionId {
    return createBrandedId(prefix, isSessionId);
}

export function createJobId(prefix = 'job'): TJobId {
    return createBrandedId(prefix, isJobId);
}

export function createLeaseId(prefix = 'lease'): TLeaseId {
    return createBrandedId(prefix, isLeaseId);
}

export type {
    IPageGeometry,
    IPdfBox,
} from '@contracts/geometry';

export function normalizeNonEmptyStringPaths(paths: readonly unknown[]): string[] {
    const normalizedPaths: string[] = [];
    for (const path of paths) {
        if (typeof path !== 'string') {
            continue;
        }

        const trimmedPath = path.trim();
        if (trimmedPath.length > 0) {
            normalizedPaths.push(trimmedPath);
        }
    }

    return normalizedPaths;
}

export interface IRecentFile {
    originalPath: TDocumentRef;
    backend?: TDocumentBackend;
    fileName: string;
    timestamp: TEpochMs;
    fileSize?: number;
    modifiedAt?: TEpochMs;
}

export type { IOcrLanguage } from '@contracts/ocrLanguages';

export interface IOcrWord extends IPdfGeometryBox {text: string;}

export function isOcrWord(value: unknown): value is IOcrWord {
    return isRecord(value)
        && typeof value.text === 'string'
        && typeof value.x === 'number'
        && typeof value.y === 'number'
        && typeof value.width === 'number'
        && typeof value.height === 'number'
        && Number.isFinite(value.x)
        && Number.isFinite(value.y)
        && Number.isFinite(value.width)
        && Number.isFinite(value.height);
}

export type TFitMode = 'width' | 'height';
export type TZoomMode = 'custom' | 'fit-width' | 'fit-height';
export type TPdfZoomState =
    | {
        kind: 'custom';
        scale: number
    }
    | {
        kind: 'fit';
        axis: TFitMode
    };
export const FIT_WIDTH_ZOOM_STATE: TPdfZoomState = Object.freeze({
    kind: 'fit',
    axis: 'width',
});
export function createZoomState(mode: TZoomMode, scale: number): TPdfZoomState {
    return mode === 'custom'
        ? {
            kind: 'custom',
            scale,
        }
        : {
            kind: 'fit',
            axis: mode === 'fit-height' ? 'height' : 'width',
        };
}
export function getZoomMode(state: TPdfZoomState): TZoomMode {
    if (state.kind === 'custom') {
        return 'custom';
    }
    return state.axis === 'height' ? 'fit-height' : 'fit-width';
}
export type TDocumentViewMode = 'single' | 'facing' | 'facing-first-single';
export type TPdfViewMode = TDocumentViewMode;
/** Quarter-turn projection applied to the whole PDF viewer, without editing the PDF. */
export type TPdfViewRotation = 0 | 90 | 180 | 270;
export type TPrintOrientation = 'auto' | 'portrait' | 'landscape';
// Keeps pdf-lib path composition below the measured release-fixture ceiling.
export const PDF_PATH_PRINT_LAYOUT_MAX_SOURCE_BYTES = 768 * 1024 * 1024;
export type TDefaultZoomPreset = 'fit-width' | 'fit-height' | '100' | '125' | '150';

export type TAppTheme = 'light' | 'dark';
export type TAppLocale = TLocale;
export type TUiScalePreference = 'auto' | 'compact' | 'default' | 'comfortable' | 'large';
export type TTabMemoryPolicy = 'conservative' | 'aggressive';

export interface ISettingsData {
    version: number;
    authorName: string;
    theme: TAppTheme;
    locale: TAppLocale;
    defaultZoomPreset: TDefaultZoomPreset;
    defaultViewMode: TPdfViewMode;
    defaultContinuousScroll: boolean;
    defaultAnnotationColor: string;
    uiScale: TUiScalePreference;
    tabMemoryPolicy: TTabMemoryPolicy;
    performanceMode: TPerformanceMode;
    optimizePdfOnSaveAs: boolean;
    assistantPanelEnabled: boolean;
    agentMcpEnabled: boolean;
    clientDiagnosticsPreference: TClientDiagnosticsPreference;
    suppressDefaultViewerPrompt?: boolean;
    suppressUnencryptedSaveNotice?: boolean;
    skippedUpdateVersion?: string;
}

export interface ICropMargins {
    top: number;
    bottom: number;
    left: number;
    right: number;
}

export function normalizeCropMargins(value: unknown): ICropMargins {
    if (
        !isRecord(value)
        || typeof value.top !== 'number'
        || typeof value.bottom !== 'number'
        || typeof value.left !== 'number'
        || typeof value.right !== 'number'
        || !Number.isFinite(value.top)
        || !Number.isFinite(value.bottom)
        || !Number.isFinite(value.left)
        || !Number.isFinite(value.right)
        || value.top < 0
        || value.bottom < 0
        || value.left < 0
        || value.right < 0
    ) {
        throw new Error('Invalid crop margins');
    }

    return {
        top: value.top,
        bottom: value.bottom,
        left: value.left,
        right: value.right,
    };
}
