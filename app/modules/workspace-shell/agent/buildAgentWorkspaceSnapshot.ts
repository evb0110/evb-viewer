import type { Ref } from 'vue';
import type {
    IAgentDocumentReadiness,
    IAgentDocumentReference,
    IAgentRecentFileSnapshot,
    IAgentTabSnapshot,
    IAgentWorkspaceSnapshot,
    TAgentWorkspaceCommandTarget,
    TAgentDocumentKind,
} from '@contracts/agent';
import type { IDocumentRevisionInfo } from '@contracts/documentRevision';
import type {
    IEditorPaneState,
    TEditorLayoutNode,
} from '@contracts/editorPanes';
import type { ITab } from '@app/types/tabs';
import type { ITabMetadataCore } from '@contracts/windowTabs';
import type { IRecentFile } from '@contracts/shared';
import { parseDocumentRef } from '@contracts/documentRef';
import { requireIsoTimestamp } from '@contracts/timestamps';
import { requirePaneId } from '@contracts/editorPanes';
import { requireTabId } from '@contracts/windowTabs';
import type { IWorkspaceToolbarSnapshot } from '@app/types/workspaceExpose';
import {
    describeTabDocument,
    type IWorkspaceDocumentController,
} from '@app/modules/workspace-shell/document-sessions/workspaceDocumentController';
import { resolveDocumentRefBackend } from '@app/utils/documentRef';

interface IBuildAgentWorkspaceSnapshotOptions {
    panes: Ref<IEditorPaneState[]>;
    tabs: Ref<ITab[]>;
    layout: Ref<TEditorLayoutNode | null>;
    activePaneId: Ref<string | null>;
    activeTabId: Ref<string | null>;
    recentFiles?: Ref<IRecentFile[]>;
    recentFilesResolved?: Ref<boolean>;
    documentSessionsByTabId: Ref<Record<string, IWorkspaceDocumentController>>;
    getPaneByTabId(tabId: string): IEditorPaneState | null;
}

const IMAGE_EXTENSION_PATTERN = /\.(?:avif|bmp|gif|heic|heif|jpe?g|png|tiff?|webp)$/i;

function cloneEditorLayoutNode(node: TEditorLayoutNode | null): TEditorLayoutNode | null {
    if (!node) {
        return null;
    }

    if (node.type === 'leaf') {
        return {
            type: 'leaf',
            paneId: node.paneId,
        };
    }

    return {
        type: 'split',
        id: node.id,
        orientation: node.orientation,
        ratio: node.ratio,
        first: cloneEditorLayoutNode(node.first) ?? node.first,
        second: cloneEditorLayoutNode(node.second) ?? node.second,
    };
}

function getTabPath(tab: ITabMetadataCore) {
    return parseDocumentRef(tab.originalPath);
}

function inferDocumentKindFromName(name: string): TAgentDocumentKind {
    if (/\.djvu?$/i.test(name)) {
        return 'djvu';
    }

    if (/\.pdf$/i.test(name)) {
        return 'pdf';
    }

    if (IMAGE_EXTENSION_PATTERN.test(name)) {
        return 'image';
    }

    return name ? 'unknown' : 'empty';
}

function cloneDocumentIdentity(identity: IDocumentRevisionInfo | null): IDocumentRevisionInfo | null {
    return identity === null
        ? null
        : {...identity};
}

function cloneCommandTarget(target: TAgentWorkspaceCommandTarget | undefined) {
    return target === undefined
        ? undefined
        : {...target};
}

function inferDocumentKind(
    tab: ITabMetadataCore,
    toolbarSnapshot: IWorkspaceToolbarSnapshot | null,
): TAgentDocumentKind {
    const path = getTabPath(tab);
    const name = tab.fileName ?? path ?? '';

    if (!name && !toolbarSnapshot?.hasPdf && !toolbarSnapshot?.isDjvuMode) {
        return 'empty';
    }

    if (tab.isDjvu || toolbarSnapshot?.isDjvuMode) {
        return 'djvu';
    }

    if (toolbarSnapshot?.hasPdf) {
        return 'pdf';
    }

    return inferDocumentKindFromName(name);
}

function buildDocumentReadiness(
    kind: TAgentDocumentKind,
    toolbarSnapshot: IWorkspaceToolbarSnapshot | null,
): IAgentDocumentReadiness {
    if (kind === 'empty') {
        return {
            status: 'empty',
            reasons: ['No document is open in this tab.'],
            recommendations: [],
        };
    }

    if (kind === 'djvu' || kind === 'image') {
        return {
            status: 'needs-preparation',
            reasons: ['Agents work best against a PDF document model with stable pages and text extraction.'],
            recommendations: [{
                id: 'convert_to_pdf',
                title: 'Convert to PDF',
                reason: kind === 'djvu'
                    ? 'DjVu documents should be converted to PDF before deeper agent analysis.'
                    : 'Image documents should be converted to PDF before deeper agent analysis.',
                toolName: 'page_ops.convert_to_pdf',
            }],
        };
    }

    if (kind === 'pdf') {
        const pageCount = Math.max(0, Math.floor(toolbarSnapshot?.totalPages ?? 0));
        return {
            status: 'unknown',
            reasons: ['Searchable text coverage has not been inspected yet.'],
            ocr: {
                status: 'unknown',
                pageCount,
            },
            recommendations: [],
        };
    }

    return {
        status: 'unknown',
        reasons: ['The document type is not known to the agent bridge.'],
        recommendations: [],
    };
}

function buildAgentTabSnapshot(
    tabId: string,
    pane: IEditorPaneState | null,
    session: IWorkspaceDocumentController,
): IAgentTabSnapshot {
    const snapshot = session.snapshot.value;
    const tab = describeTabDocument(snapshot);
    const toolbarSnapshot = session.toolbarSnapshot.value;
    const kind = inferDocumentKind(tab, toolbarSnapshot);
    const commandTarget = cloneCommandTarget(session.createCommandTarget());
    const documentIdentity = cloneDocumentIdentity(snapshot.identity.revisionInfo);
    const documentSessionKey = snapshot.identity.documentSessionKey;
    const documentInstanceId = snapshot.identity.documentInstanceId;
    const originalPath = getTabPath(tab);
    const originalBackend = resolveDocumentRefBackend(originalPath);
    return {
        tabId: requireTabId(tabId),
        paneId: pane ? requirePaneId(pane.paneId) : null,
        fileName: tab.fileName,
        originalPath,
        ...(originalBackend === undefined ? {} : {originalBackend}),
        ...(documentSessionKey === null ? {} : {documentSessionKey}),
        ...(documentInstanceId === null ? {} : {documentInstanceId}),
        documentIdentity,
        ...(commandTarget === undefined ? {} : { commandTarget }),
        isDirty: tab.isDirty,
        kind,
        workspaceAttached: session.mountedWorkspace.value !== null,
        hasPdf: toolbarSnapshot.hasPdf,
        isDjvu: tab.isDjvu || toolbarSnapshot.isDjvuMode,
        isOpeningDocument: snapshot.phase === 'opening' || toolbarSnapshot.isOpeningDocument,
        hasOpenError: snapshot.phase === 'failed' || toolbarSnapshot.hasOpenError,
        currentPage: toolbarSnapshot.currentPage,
        totalPages: toolbarSnapshot.totalPages,
        readiness: buildDocumentReadiness(kind, toolbarSnapshot),
    };
}

function isAgentDocumentTab(tab: IAgentTabSnapshot) {
    return tab.kind !== 'empty'
        && (
            Boolean(tab.fileName)
            || Boolean(tab.originalPath)
            || tab.hasPdf === true
            || tab.isDjvu === true
        );
}

function createDocumentReference(tab: IAgentTabSnapshot): IAgentDocumentReference {
    return {
        tabId: tab.tabId,
        paneId: tab.paneId,
        fileName: tab.fileName,
        originalPath: tab.originalPath,
        ...(tab.originalBackend === undefined ? {} : {originalBackend: tab.originalBackend}),
        ...(tab.documentSessionKey === undefined ? {} : {documentSessionKey: tab.documentSessionKey}),
        ...(tab.documentInstanceId === undefined ? {} : {documentInstanceId: tab.documentInstanceId}),
        ...(tab.documentIdentity === undefined ? {} : { documentIdentity: tab.documentIdentity }),
        ...(tab.commandTarget === undefined ? {} : { commandTarget: tab.commandTarget }),
        kind: tab.kind,
    };
}

function createRecentFileSnapshot(file: IRecentFile): IAgentRecentFileSnapshot {
    const name = file.fileName || file.originalPath;
    const openedAt = Number.isFinite(file.timestamp)
        ? new Date(file.timestamp).toISOString()
        : '';
    return {
        fileName: file.fileName,
        originalPath: file.originalPath,
        ...(file.backend === undefined ? {} : {backend: file.backend}),
        kind: inferDocumentKindFromName(name),
        openedAt: openedAt ? requireIsoTimestamp(openedAt) : requireIsoTimestamp(new Date(0).toISOString()),
        ...(file.fileSize === undefined ? {} : { fileSize: file.fileSize }),
    };
}

export function buildAgentWorkspaceSnapshot(
    options: IBuildAgentWorkspaceSnapshotOptions,
): IAgentWorkspaceSnapshot {
    const tabSnapshots = options.tabs.value.flatMap((tab) => {
        const session = options.documentSessionsByTabId.value[tab.id];
        return session ? [buildAgentTabSnapshot(tab.id, options.getPaneByTabId(tab.id), session)] : [];
    });
    const documentTabs = tabSnapshots.filter(isAgentDocumentTab);
    const activeDocumentTab = documentTabs.find(tab => tab.tabId === options.activeTabId.value) ?? null;
    const recentFiles = (options.recentFiles?.value ?? []).map(createRecentFileSnapshot);

    return {
        capturedAt: requireIsoTimestamp(new Date().toISOString()),
        activePaneId: options.activePaneId.value === null
            ? null
            : requirePaneId(options.activePaneId.value),
        activeTabId: options.activeTabId.value === null
            ? null
            : requireTabId(options.activeTabId.value),
        summary: {
            mode: activeDocumentTab
                ? 'open-document'
                : documentTabs.length > 0
                    ? 'documents-open-no-active-document'
                    : 'empty-workspace',
            activeDocument: activeDocumentTab ? createDocumentReference(activeDocumentTab) : null,
            documentCount: documentTabs.length,
            recentFileCount: recentFiles.length,
            recentFilesResolved: options.recentFilesResolved?.value === true,
        },
        panes: options.panes.value.map(pane => ({
            paneId: requirePaneId(pane.paneId),
            tabIds: pane.tabIds.map(tabId => requireTabId(tabId)),
            activeTabId: pane.activeTabId === null ? null : requireTabId(pane.activeTabId),
        })),
        tabs: tabSnapshots,
        recentFiles,
        layout: cloneEditorLayoutNode(options.layout.value),
    };
}
