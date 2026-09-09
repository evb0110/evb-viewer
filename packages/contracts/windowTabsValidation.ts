import { isRecord } from '@contracts/runtimeGuards';
import {
    parseDocumentRef,
    type TDocumentBackend,
    type TDocumentRef,
} from '@contracts/documentRef';
import { parseDocumentInstanceId } from '@contracts/documentInstanceId';
import { parseDocumentRevisionToken } from '@contracts/documentRevision';
import type {
    ITransferredTabState,
    IWindowTabTargetWindow,
    IWindowTabTransferAck,
    IWindowTabTransferSessionState,
    IWindowTabIncomingTransfer,
    IWindowTabTransferRequest,
    IWindowTabTransferResult,
    TSplitPayload,
    TWindowTabTransferTarget,
    TWindowTabsAction,
} from '@contracts/windowTabs';
import {parseSessionId} from '@contracts/shared';
import {parseTabId} from '@contracts/windowTabs';

function normalizeNonEmptyString(value: unknown) {
    if (typeof value !== 'string') {
        return null;
    }
    const normalized = value.trim();
    return normalized.length > 0 ? normalized : null;
}

function isNullableString(value: unknown): value is string | null {
    return value === null || typeof value === 'string';
}

function decodeNullableDocumentRef(value: unknown): TDocumentRef | null | undefined {
    if (value === undefined) {
        return undefined;
    }
    return value === null ? null : parseDocumentRef(value);
}

function isPositiveWindowId(value: unknown): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isOptionalPositiveInteger(value: unknown): value is number | undefined {
    return value === undefined || (typeof value === 'number' && Number.isSafeInteger(value) && value > 0);
}

function decodeOptionalDocumentBackend(value: unknown): TDocumentBackend | null | undefined {
    if (value === undefined) {
        return undefined;
    }
    return value === 'browser' || value === 'electron'
        ? value
        : null;
}

function isNonNegativeInteger(value: unknown): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

const WINDOW_TAB_ACTION_ID_MAX_LENGTH = 512;

function decodeTransferredTabState(value: unknown): ITransferredTabState | null {
    if (!isRecord(value)) {
        return null;
    }
    const originalBackend = decodeOptionalDocumentBackend(value.originalBackend);
    const documentInstanceId = value.documentInstanceId === undefined || value.documentInstanceId === null
        ? value.documentInstanceId
        : parseDocumentInstanceId(value.documentInstanceId);
    const originalPath = decodeNullableDocumentRef(value.originalPath);
    if (
        !isNullableString(value.fileName)
        || originalPath === undefined
        || originalPath === null && value.originalPath !== null
        || documentInstanceId === null && value.documentInstanceId !== null
        || typeof value.isDirty !== 'boolean'
        || typeof value.isDjvu !== 'boolean'
        || originalBackend === null
    ) {
        return null;
    }

    return {
        fileName: value.fileName,
        originalPath: originalPath ?? null,
        ...(originalBackend === undefined ? {} : {originalBackend}),
        ...(documentInstanceId === undefined ? {} : {documentInstanceId}),
        isDirty: value.isDirty,
        isDjvu: value.isDjvu,
    };
}

function decodeSplitPayload(value: unknown): TSplitPayload | null {
    if (!isRecord(value) || typeof value.kind !== 'string') {
        return null;
    }

    if (value.kind === 'empty') {
        return { kind: 'empty' };
    }

    if (value.kind === 'djvu') {
        const sourceBackend = decodeOptionalDocumentBackend(value.sourceBackend);
        const sourcePath = parseDocumentRef(value.sourcePath);
        if (
            sourcePath === null
            || !isOptionalPositiveInteger(value.currentPage)
            || !isOptionalPositiveInteger(value.totalPages)
            || sourceBackend === null
        ) {
            return null;
        }
        return {
            kind: 'djvu',
            sourcePath,
            ...(sourceBackend === undefined ? {} : {sourceBackend}),
            ...(value.currentPage === undefined ? {} : { currentPage: value.currentPage }),
            ...(value.totalPages === undefined ? {} : { totalPages: value.totalPages }),
        };
    }

    const originalBackend = decodeOptionalDocumentBackend(value.originalBackend);
    const snapshotBackend = decodeOptionalDocumentBackend(value.snapshotBackend);
    const originalPath = decodeNullableDocumentRef(value.originalPath);
    const snapshotPath = parseDocumentRef(value.snapshotPath);
    if (
        value.kind !== 'pdfSnapshot'
        || typeof value.fileName !== 'string'
        || originalPath === undefined
        || originalPath === null && value.originalPath !== null
        || snapshotPath === null
        || typeof value.isDirty !== 'boolean'
        || value.isGenerated !== undefined && typeof value.isGenerated !== 'boolean'
        || !isOptionalPositiveInteger(value.currentPage)
        || !isOptionalPositiveInteger(value.totalPages)
        || originalBackend === null
        || snapshotBackend === null
    ) {
        return null;
    }

    return {
        kind: 'pdfSnapshot',
        fileName: value.fileName,
        originalPath: originalPath ?? null,
        ...(originalBackend === undefined ? {} : {originalBackend}),
        snapshotPath,
        ...(snapshotBackend === undefined ? {} : {snapshotBackend}),
        isDirty: value.isDirty,
        ...(value.isGenerated === undefined ? {} : {isGenerated: value.isGenerated}),
        ...(value.currentPage === undefined ? {} : { currentPage: value.currentPage }),
        ...(value.totalPages === undefined ? {} : { totalPages: value.totalPages }),
    };
}

function decodeTransferTarget(value: unknown): TWindowTabTransferTarget | null {
    if (!isRecord(value)) {
        return null;
    }
    if (value.kind === 'new-window') {
        return { kind: 'new-window' };
    }
    if (value.kind === 'window' && isPositiveWindowId(value.windowId)) {
        return {
            kind: 'window',
            windowId: value.windowId,
        };
    }
    return null;
}

function decodeTransferSession(value: unknown): IWindowTabTransferSessionState | null | undefined {
    if (value === undefined) {
        return undefined;
    }
    if (!isRecord(value)) {
        return null;
    }

    const sessionId = parseSessionId(value.sessionId);
    const documentRevisionToken = value.documentRevisionToken === undefined
        ? undefined
        : parseDocumentRevisionToken(value.documentRevisionToken);
    const documentRef = decodeNullableDocumentRef(value.documentRef);
    const documentInstanceId = value.documentInstanceId === undefined || value.documentInstanceId === null
        ? value.documentInstanceId
        : parseDocumentInstanceId(value.documentInstanceId);
    const documentBackend = decodeOptionalDocumentBackend(value.documentBackend);
    if (
        sessionId === null
        || !isNonNegativeInteger(value.sessionRevision)
        || documentRef === undefined
        || documentRef === null && value.documentRef !== null
        || documentInstanceId === null && value.documentInstanceId !== null
        || documentRevisionToken === null
        || documentBackend === null
    ) {
        return null;
    }

    return {
        sessionId,
        sessionRevision: value.sessionRevision,
        documentRef,
        ...(documentBackend === undefined ? {} : {documentBackend}),
        ...(documentInstanceId === undefined ? {} : {documentInstanceId}),
        ...(documentRevisionToken === undefined ? {} : {documentRevisionToken}),
    };
}

export function decodeWindowTabTransferRequest(value: unknown): IWindowTabTransferRequest | null {
    if (!isRecord(value)) {
        return null;
    }

    const target = decodeTransferTarget(value.target);
    const tab = decodeTransferredTabState(value.tab);
    const payload = decodeSplitPayload(value.payload);
    const session = decodeTransferSession(value.session);
    if (
        target === null
        || tab === null
        || payload === null
        || session === null
        || (value.timeoutMs !== undefined && (
            typeof value.timeoutMs !== 'number'
            || !Number.isFinite(value.timeoutMs)
            || value.timeoutMs <= 0
        ))
    ) {
        return null;
    }

    return {
        target,
        tab,
        payload,
        ...(session === undefined ? {} : {session}),
        ...(value.timeoutMs === undefined ? {} : { timeoutMs: value.timeoutMs }),
    };
}

export function decodeWindowTabIncomingTransfer(value: unknown): IWindowTabIncomingTransfer | null {
    if (!isRecord(value)) {
        return null;
    }

    const transferId = normalizeNonEmptyString(value.transferId);
    const tab = decodeTransferredTabState(value.tab);
    const payload = decodeSplitPayload(value.payload);
    const session = decodeTransferSession(value.session);
    if (
        transferId === null
        || !isPositiveWindowId(value.sourceWindowId)
        || !isPositiveWindowId(value.targetWindowId)
        || tab === null
        || payload === null
        || session === null
    ) {
        return null;
    }

    return {
        transferId,
        sourceWindowId: value.sourceWindowId,
        targetWindowId: value.targetWindowId,
        tab,
        payload,
        ...(session === undefined ? {} : {session}),
    };
}

export function decodeWindowTabsAction(value: unknown): TWindowTabsAction | null {
    if (!isRecord(value)) {
        return null;
    }
    const tabId = value.tabId === undefined
        ? undefined
        : parseTabId(value.tabId);
    if (tabId === null) {
        return null;
    }
    if (tabId !== undefined && tabId.length > WINDOW_TAB_ACTION_ID_MAX_LENGTH) {
        return null;
    }
    if (value.kind === 'close-tab' || value.kind === 'move-tab-to-new-window') {
        return {
            kind: value.kind,
            ...(tabId === undefined ? {} : {tabId}),
        };
    }
    if (
        (value.kind === 'move-tab-to-window' || value.kind === 'merge-window-into')
        && isPositiveWindowId(value.targetWindowId)
    ) {
        return value.kind === 'move-tab-to-window'
            ? {
                kind: value.kind,
                targetWindowId: value.targetWindowId,
                ...(tabId === undefined ? {} : {tabId}),
            }
            : {
                kind: value.kind,
                targetWindowId: value.targetWindowId,
            };
    }
    return null;
}

export function decodeWindowTabTransferAck(value: unknown): IWindowTabTransferAck | null {
    if (
        !isRecord(value)
        || typeof value.transferId !== 'string'
        || value.transferId.trim().length === 0
        || typeof value.success !== 'boolean'
        || (value.error !== undefined && typeof value.error !== 'string')
    ) {
        return null;
    }
    return {
        transferId: value.transferId,
        success: value.success,
        ...(value.error === undefined ? {} : {error: value.error}),
    };
}

export function decodeWindowTabTransferResult(value: unknown): IWindowTabTransferResult | null {
    if (
        !isRecord(value)
        || typeof value.transferId !== 'string'
        || typeof value.success !== 'boolean'
        || typeof value.targetWindowId !== 'number'
        || !Number.isSafeInteger(value.targetWindowId)
        || (value.error !== undefined && typeof value.error !== 'string')
    ) {
        return null;
    }
    return {
        transferId: value.transferId,
        success: value.success,
        targetWindowId: value.targetWindowId,
        ...(value.error === undefined ? {} : {error: value.error}),
    };
}

export function decodeWindowTabTargetWindows(value: unknown): IWindowTabTargetWindow[] | null {
    if (!Array.isArray(value)) {
        return null;
    }
    const targets: IWindowTabTargetWindow[] = [];
    for (const candidate of value) {
        if (
            !isRecord(candidate)
            || typeof candidate.windowId !== 'number'
            || !Number.isSafeInteger(candidate.windowId)
            || candidate.windowId <= 0
            || typeof candidate.label !== 'string'
            || candidate.label.trim().length === 0
        ) {
            return null;
        }
        targets.push({
            windowId: candidate.windowId,
            label: candidate.label,
        });
    }
    return targets;
}
