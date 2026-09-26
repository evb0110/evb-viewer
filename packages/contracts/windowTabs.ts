import {
    createBrandedId,
    isBrandedString,
    parseBranded,
} from '@contracts/brand';
import type {TBrand} from '@contracts/brand';

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
    IWindowTabTransferSessionState,
    ITabMetadataCore,
    TSplitPayload,
    TWindowTabTransferTarget,
    TWindowTabsAction,
} from '@contracts/windowTabsValidation';

export type TTabId = TBrand<string, 'TabId'>;

export function isTabId(value: unknown): value is TTabId {
    return isBrandedString<'TabId'>(value);
}

export function parseTabId(value: unknown): TTabId | null {
    const normalized = typeof value === 'string' ? value.trim() : value;
    return parseBranded(normalized, isTabId);
}

export function requireTabId(value: unknown): TTabId {
    const parsed = parseTabId(value);
    if (parsed === null) {
        throw new TypeError('Tab ID must be a non-empty string');
    }
    return parsed;
}

export function createTabId(prefix = 'tab'): TTabId {
    return createBrandedId(prefix, isTabId);
}
