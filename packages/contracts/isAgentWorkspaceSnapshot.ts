import type {
    IAgentDocumentReadiness,
    IAgentDocumentReference,
    IAgentDocumentRecommendation,
    IAgentDocumentOcrState,
    IAgentPaneSnapshot,
    IAgentRecentFileSnapshot,
    IAgentTabSnapshot,
    IAgentWorkspaceSnapshot,
    IAgentWorkspaceSummary,
    TAgentDocumentKind,
    TAgentDocumentReadinessStatus,
    TAgentOcrCoverageStatus,
    TAgentRecommendationId,
    TAgentWorkspaceCommandTarget,
    TAgentWorkspaceMode,
} from '@contracts/agent';
import type {TEditorLayoutNode} from '@contracts/editorPanes';
import {parsePaneId} from '@contracts/editorPanes';
import {parseDocumentInstanceId} from '@contracts/documentInstanceId';
import {parseDocumentRef} from '@contracts/documentRef';
import {parseIsoTimestamp} from '@contracts/timestamps';
import {parseSessionId} from '@contracts/shared';
import {parseTabId} from '@contracts/windowTabs';
import {isRecord, isStringArray} from '@contracts/runtimeGuards';

const MAX_COLLECTION_ITEMS = 10_000;

function isNullableString(value: unknown): value is string | null {
    return value === null || typeof value === 'string';
}

function isNonNegativeInteger(value: unknown): value is number {
    return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isNullableFiniteNumber(value: unknown): value is number | null {
    return value === null || (typeof value === 'number' && Number.isFinite(value));
}

function isOptionalFiniteNumber(value: unknown): value is number | undefined {
    return value === undefined || (typeof value === 'number' && Number.isFinite(value));
}

function isOptionalDocumentBackend(value: unknown) {
    return value === undefined || value === 'browser' || value === 'electron';
}

function isAgentDocumentKind(value: unknown): value is TAgentDocumentKind {
    return value === 'empty' || value === 'pdf' || value === 'djvu' || value === 'image' || value === 'unknown';
}

function isDocumentReadinessStatus(value: unknown): value is TAgentDocumentReadinessStatus {
    return value === 'ready' || value === 'needs-preparation' || value === 'unknown' || value === 'empty';
}

function isOcrCoverageStatus(value: unknown): value is TAgentOcrCoverageStatus {
    return value === 'complete' || value === 'partial' || value === 'none' || value === 'unknown';
}

function isAgentRecommendationId(value: unknown): value is TAgentRecommendationId {
    return value === 'convert_to_pdf' || value === 'ocr_all_pages';
}

function isWorkspaceMode(value: unknown): value is TAgentWorkspaceMode {
    return value === 'empty-workspace' || value === 'open-document' || value === 'documents-open-no-active-document';
}

function isAgentWorkspaceCommandTarget(value: unknown): value is TAgentWorkspaceCommandTarget {
    if (!isRecord(value)) {
        return false;
    }
    if (
        parseTabId(value.tabId) === null ||
        parseSessionId(value.sessionId) === null ||
        (value.documentRef !== null && parseDocumentRef(value.documentRef) === null) ||
        !isOptionalDocumentBackend(value.documentBackend) ||
        (value.documentInstanceId !== undefined &&
            value.documentInstanceId !== null &&
            parseDocumentInstanceId(value.documentInstanceId) === null) ||
        (value.documentRevisionToken !== undefined && typeof value.documentRevisionToken !== 'string')
    ) {
        return false;
    }
    if (value.kind === 'transaction') {
        return typeof value.transactionId === 'string' && value.transactionId.trim().length > 0;
    }
    return (
        value.kind === 'revision' &&
        typeof value.sessionRevision === 'number' &&
        Number.isInteger(value.sessionRevision) &&
        value.sessionRevision >= 0
    );
}

function hasAgentDocumentSnapshotFields(value: unknown): value is Record<string, unknown> {
    return (
        isRecord(value) &&
        parseTabId(value.tabId) !== null &&
        (value.paneId === null || parsePaneId(value.paneId) !== null) &&
        isNullableString(value.fileName) &&
        (value.originalPath === null || parseDocumentRef(value.originalPath) !== null) &&
        isOptionalDocumentBackend(value.originalBackend) &&
        (value.documentSessionKey === undefined || value.documentSessionKey === null || typeof value.documentSessionKey === 'string') &&
        (value.documentInstanceId === undefined ||
            value.documentInstanceId === null ||
            parseDocumentInstanceId(value.documentInstanceId) !== null) &&
        (value.commandTarget === undefined || isAgentWorkspaceCommandTarget(value.commandTarget))
    );
}

function isDocumentReference(value: unknown): value is IAgentDocumentReference {
    return hasAgentDocumentSnapshotFields(value) && isAgentDocumentKind(value.kind);
}

function isWorkspaceSummary(value: unknown): value is IAgentWorkspaceSummary {
    return (
        isRecord(value) &&
        isWorkspaceMode(value.mode) &&
        (value.activeDocument === null || isDocumentReference(value.activeDocument)) &&
        isNonNegativeInteger(value.documentCount) &&
        isNonNegativeInteger(value.recentFileCount) &&
        typeof value.recentFilesResolved === 'boolean'
    );
}

function isAgentPaneSnapshot(value: unknown): value is IAgentPaneSnapshot {
    return (
        isRecord(value) &&
        parsePaneId(value.paneId) !== null &&
        Array.isArray(value.tabIds) &&
        value.tabIds.every((tabId) => parseTabId(tabId) !== null) &&
        (value.activeTabId === null || parseTabId(value.activeTabId) !== null)
    );
}

function isAgentDocumentOcrState(value: unknown): value is IAgentDocumentOcrState {
    return (
        isRecord(value) &&
        isOcrCoverageStatus(value.status) &&
        isNonNegativeInteger(value.pageCount) &&
        (value.textPageCount === undefined || isNonNegativeInteger(value.textPageCount)) &&
        (value.missingTextPages === undefined ||
            (Array.isArray(value.missingTextPages) && value.missingTextPages.every(isNonNegativeInteger))) &&
        isOptionalFiniteNumber(value.coverage)
    );
}

function isAgentDocumentRecommendation(value: unknown): value is IAgentDocumentRecommendation {
    return (
        isRecord(value) &&
        isAgentRecommendationId(value.id) &&
        typeof value.title === 'string' &&
        typeof value.reason === 'string' &&
        (value.toolName === undefined || typeof value.toolName === 'string')
    );
}

function isAgentDocumentReadiness(value: unknown): value is IAgentDocumentReadiness {
    return (
        isRecord(value) &&
        isDocumentReadinessStatus(value.status) &&
        isStringArray(value.reasons) &&
        (value.ocr === undefined || isAgentDocumentOcrState(value.ocr)) &&
        Array.isArray(value.recommendations) &&
        value.recommendations.every(isAgentDocumentRecommendation)
    );
}

function isAgentTabSnapshot(value: unknown): value is IAgentTabSnapshot {
    return (
        hasAgentDocumentSnapshotFields(value) &&
        typeof value.isDirty === 'boolean' &&
        isAgentDocumentKind(value.kind) &&
        typeof value.workspaceAttached === 'boolean' &&
        typeof value.hasPdf === 'boolean' &&
        typeof value.isDjvu === 'boolean' &&
        typeof value.isOpeningDocument === 'boolean' &&
        typeof value.hasOpenError === 'boolean' &&
        isNullableFiniteNumber(value.currentPage) &&
        isNullableFiniteNumber(value.totalPages) &&
        isAgentDocumentReadiness(value.readiness)
    );
}

function isAgentRecentFileSnapshot(value: unknown): value is IAgentRecentFileSnapshot {
    return (
        isRecord(value) &&
        typeof value.fileName === 'string' &&
        parseDocumentRef(value.originalPath) !== null &&
        isOptionalDocumentBackend(value.backend) &&
        isAgentDocumentKind(value.kind) &&
        parseIsoTimestamp(value.openedAt) !== null &&
        (value.fileSize === undefined || isNonNegativeInteger(value.fileSize))
    );
}

function isEditorLayoutNode(value: unknown, depth = 0): value is TEditorLayoutNode | null {
    if (value === null) {
        return true;
    }
    if (depth > 64 || !isRecord(value)) {
        return false;
    }
    if (value.type === 'leaf') {
        return parsePaneId(value.paneId) !== null;
    }
    return (
        value.type === 'split' &&
        typeof value.id === 'string' &&
        (value.orientation === 'horizontal' || value.orientation === 'vertical') &&
        typeof value.ratio === 'number' &&
        Number.isFinite(value.ratio) &&
        isEditorLayoutNode(value.first, depth + 1) &&
        isEditorLayoutNode(value.second, depth + 1)
    );
}

export function isAgentWorkspaceSnapshot(value: unknown): value is IAgentWorkspaceSnapshot {
    return (
        isRecord(value) &&
        parseIsoTimestamp(value.capturedAt) !== null &&
        (value.activePaneId === null || parsePaneId(value.activePaneId) !== null) &&
        (value.activeTabId === null || parseTabId(value.activeTabId) !== null) &&
        isWorkspaceSummary(value.summary) &&
        Array.isArray(value.panes) &&
        value.panes.length <= MAX_COLLECTION_ITEMS &&
        value.panes.every(isAgentPaneSnapshot) &&
        Array.isArray(value.tabs) &&
        value.tabs.length <= MAX_COLLECTION_ITEMS &&
        value.tabs.every(isAgentTabSnapshot) &&
        Array.isArray(value.recentFiles) &&
        value.recentFiles.length <= MAX_COLLECTION_ITEMS &&
        value.recentFiles.every(isAgentRecentFileSnapshot) &&
        isEditorLayoutNode(value.layout)
    );
}
