import {describe, expect, it} from 'vitest';
import {isAgentWorkspaceSnapshot} from '@contracts/isAgentWorkspaceSnapshot';

function documentFields() {
    return {
        documentInstanceId: 'instance-1',
        documentSessionKey: 'session-1',
        fileName: 'source.pdf',
        originalBackend: 'electron',
        originalPath: '/tmp/source.pdf',
        paneId: null,
        tabId: 'tab-1',
    };
}

function workspaceSnapshot() {
    const fields = documentFields();
    return {
        activePaneId: null,
        activeTabId: 'tab-1',
        capturedAt: '2026-08-16T00:00:00.000Z',
        layout: null,
        panes: [],
        recentFiles: [],
        summary: {
            activeDocument: {
                ...fields,
                kind: 'pdf',
            },
            documentCount: 1,
            mode: 'open-document',
            recentFileCount: 0,
            recentFilesResolved: true,
        },
        tabs: [
            {
                ...fields,
                currentPage: 1,
                hasOpenError: false,
                hasPdf: true,
                isDjvu: false,
                isDirty: false,
                isOpeningDocument: false,
                kind: 'pdf',
                readiness: {
                    recommendations: [],
                    reasons: [],
                    status: 'ready',
                },
                totalPages: 1,
                workspaceAttached: true,
            },
        ],
    };
}

describe('agent workspace snapshot validator', () => {
    it('shares document identity validation between the active reference and tab snapshot', () => {
        const snapshot = workspaceSnapshot();

        expect(isAgentWorkspaceSnapshot(snapshot)).toBe(true);
        expect(
            isAgentWorkspaceSnapshot({
                ...snapshot,
                summary: {
                    ...snapshot.summary,
                    activeDocument: {
                        ...snapshot.summary.activeDocument,
                        originalPath: 42,
                    },
                },
            }),
        ).toBe(false);
        expect(
            isAgentWorkspaceSnapshot({
                ...snapshot,
                tabs: [
                    {
                        ...snapshot.tabs[0],
                        documentSessionKey: 42,
                    },
                ],
            }),
        ).toBe(false);
    });
});
