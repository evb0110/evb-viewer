import type { TLocale } from '@i18n-core';
import type { TClientDiagnosticsPreference } from '@contracts/diagnostics/diagnosticsPreference';
import type {
    TDocumentBackend,
    TDocumentRef,
} from '@contracts/documentRef';
import type { IPdfBox as IPdfGeometryBox } from '@contracts/geometry';
import type { TPerformanceMode } from '@contracts/hostResourceProfile';
import { isRecord } from '@contracts/runtimeGuards';

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
    timestamp: number;
    fileSize?: number;
    modifiedAt?: number;
}

export interface IOcrLanguage {
    code: string;
    script: 'latin' | 'cyrillic' | 'greek' | 'rtl';
    modelState?: 'installed' | 'downloading' | 'missing';
}

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
export type TDocumentViewMode = 'single' | 'facing' | 'facing-first-single';
/** @deprecated Use TDocumentViewMode in format-neutral code. */
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
