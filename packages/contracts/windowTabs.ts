import {
    createBrandedId,
    isBrandedString,
    parseBranded,
} from '@contracts/brand';
import type {TBrand} from '@contracts/brand';
import type { TaggedUnion } from 'type-fest';
import type {
    TDocumentBackend,
    TDocumentRef,
} from '@contracts/documentRef';
import type { TDocumentRevisionToken } from '@contracts/documentRevision';
import type { TDocumentInstanceId } from '@contracts/documentInstanceId';
import type {TSessionId} from '@contracts/shared';

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

export interface IEmptySplitPayload {readonly kind: 'empty';}

export interface IDjvuSplitPayload {
    readonly kind: 'djvu';
    readonly sourcePath: TDocumentRef;
    readonly sourceBackend?: TDocumentBackend;
    readonly currentPage?: number;
    readonly totalPages?: number;
}

export interface IPdfSnapshotSplitPayload {
    readonly kind: 'pdfSnapshot';
    readonly fileName: string;
    readonly originalPath: TDocumentRef | null;
    readonly originalBackend?: TDocumentBackend;
    readonly snapshotPath: TDocumentRef;
    readonly snapshotBackend?: TDocumentBackend;
    readonly isDirty: boolean;
    readonly isGenerated?: boolean;
    readonly currentPage?: number;
    readonly totalPages?: number;
}

export type TSplitPayload = IEmptySplitPayload | IDjvuSplitPayload | IPdfSnapshotSplitPayload;

export interface ITabMetadataCore {
    readonly fileName: string | null;
    readonly originalPath: TDocumentRef | null;
    readonly originalBackend?: TDocumentBackend;
    readonly documentInstanceId?: TDocumentInstanceId | null;
    readonly isDirty: boolean;
    readonly isDjvu: boolean;
}

export type ITransferredTabState = ITabMetadataCore;

export interface IWindowTabTransferSessionState {
    readonly sessionId: TSessionId;
    readonly sessionRevision: number;
    readonly documentRef: TDocumentRef | null;
    readonly documentBackend?: TDocumentBackend;
    readonly documentInstanceId?: TDocumentInstanceId | null;
    readonly documentRevisionToken?: TDocumentRevisionToken;
}

export type TWindowTabTransferTarget =
    | { kind: 'new-window'; }
    | {
        kind: 'window';
        windowId: number;
    };

export interface IWindowTabTransferRequest {
    target: TWindowTabTransferTarget;
    tab: ITransferredTabState;
    payload: TSplitPayload;
    session?: IWindowTabTransferSessionState;
    timeoutMs?: number;
}

export interface IWindowTabIncomingTransfer {
    readonly transferId: string;
    readonly sourceWindowId: number;
    readonly targetWindowId: number;
    readonly tab: ITransferredTabState;
    readonly payload: TSplitPayload;
    readonly session?: IWindowTabTransferSessionState;
}

export interface IWindowTabTransferAck {
    readonly transferId: string;
    readonly success: boolean;
    readonly error?: string;
}

export interface IWindowTabTransferResult {
    readonly transferId: string;
    readonly success: boolean;
    readonly targetWindowId: number;
    readonly error?: string;
}

export interface IWindowTabTargetWindow {
    readonly windowId: number;
    readonly label: string;
}

export type TWindowTabsAction = TaggedUnion<'kind', {
    'close-tab': {tabId?: TTabId;};
    'move-tab-to-new-window': {tabId?: TTabId;};
    'move-tab-to-window': {
        targetWindowId: number;
        tabId?: TTabId;
    };
    'merge-window-into': {targetWindowId: number;};
}>;
