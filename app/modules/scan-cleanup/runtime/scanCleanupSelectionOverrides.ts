import type {
    IScanCleanupMarginsMm,
    IScanCleanupPageOverride,
    TScanCleanupPageOverrides,
} from '@contracts/electronApiScanCleanup';
import {
    createScanCleanupPageOverride,
    getScanCleanupPageOverride,
    setScanCleanupPageOverride,
} from '@contracts/scanCleanupPageOverrides';
import {requirePageNumber} from '@contracts/pageNumbers';

export type TScanCleanupPageOverrideUpdate = (
    value: IScanCleanupPageOverride,
    page: number,
) => IScanCleanupPageOverride;

export interface IScanCleanupMixedValue<T> {
    empty: boolean;
    mixed: boolean;
    value: T | undefined;
}

function areScanCleanupSelectionValuesEqual(left: unknown, right: unknown): boolean {
    if (Object.is(left, right)) {
        return true;
    }
    if (Array.isArray(left) && Array.isArray(right)) {
        return left.length === right.length
            && left.every((value, index) => areScanCleanupSelectionValuesEqual(value, right[index]));
    }
    if (
        left !== null
        && right !== null
        && typeof left === 'object'
        && typeof right === 'object'
    ) {
        const leftRecord = left as Record<string, unknown>;
        const rightRecord = right as Record<string, unknown>;
        const leftKeys = Object.keys(leftRecord).sort();
        const rightKeys = Object.keys(rightRecord).sort();
        return areScanCleanupSelectionValuesEqual(leftKeys, rightKeys)
            && leftKeys.every(key => areScanCleanupSelectionValuesEqual(leftRecord[key], rightRecord[key]));
    }
    return false;
}

export function resolveScanCleanupMixedValue<T>(
    values: readonly T[],
    equals: (left: T, right: T) => boolean = areScanCleanupSelectionValuesEqual,
): IScanCleanupMixedValue<T> {
    const first = values[0];
    if (first === undefined) {
        return {
            empty: true,
            mixed: false,
            value: undefined,
        };
    }
    return {
        empty: false,
        mixed: values.slice(1).some(value => !equals(first, value)),
        value: first,
    };
}

export function updateScanCleanupPageOverrides(
    overrides: TScanCleanupPageOverrides,
    pages: Iterable<number>,
    update: TScanCleanupPageOverrideUpdate,
    documentMargins?: IScanCleanupMarginsMm,
): void;
export function updateScanCleanupPageOverrides(
    overrides: TScanCleanupPageOverrides,
    pages: Iterable<number>,
    update: (value: IScanCleanupPageOverride, page: number) => IScanCleanupPageOverride,
    pageOverrideDefaults: IScanCleanupPageOverride | undefined,
    documentMargins?: IScanCleanupMarginsMm,
): void;
export function updateScanCleanupPageOverrides(
    overrides: TScanCleanupPageOverrides,
    pages: Iterable<number>,
    update: (value: IScanCleanupPageOverride, page: number) => IScanCleanupPageOverride,
    pageOverrideDefaultsOrMargins?: IScanCleanupPageOverride | IScanCleanupMarginsMm,
    documentMargins?: IScanCleanupMarginsMm,
) {
    const effectiveDocumentMargins = documentMargins
        ?? (pageOverrideDefaultsOrMargins !== undefined
            && 'leftMm' in pageOverrideDefaultsOrMargins
            ? pageOverrideDefaultsOrMargins
            : undefined);
    for (const page of pages) {
        if (!Number.isInteger(page) || page < 1) {
            continue;
        }
        const pageNumber = requirePageNumber(page);
        const current = getScanCleanupPageOverride(overrides, pageNumber);
        setScanCleanupPageOverride(
            overrides,
            pageNumber,
            createScanCleanupPageOverride(update(current, page)),
            effectiveDocumentMargins,
        );
    }
}

export function updateScanCleanupPageOverrideRotation(
    current: IScanCleanupPageOverride,
    rotationDegrees: IScanCleanupPageOverride['rotationDegrees'],
): IScanCleanupPageOverride {
    const rotationChanged = current.rotationDegrees !== rotationDegrees;
    return {
        ...current,
        rotationDegrees,
        manualSplit: rotationChanged ? null : current.manualSplit,
        manualSkewDegrees: rotationChanged ? undefined : current.manualSkewDegrees,
        manualContentBoxes: rotationChanged ? {} : current.manualContentBoxes ?? {},
        manualZones: rotationChanged ? {
            picture: [],
            fill: [],
        } : current.manualZones ?? {
            picture: [],
            fill: [],
        },
    };
}
