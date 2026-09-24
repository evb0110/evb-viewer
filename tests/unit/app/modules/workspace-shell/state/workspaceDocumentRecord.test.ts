import {
    describe,
    expect,
    it,
} from 'vitest';
import { requireDocumentRef } from '@contracts/documentRef';
import {
    createPendingWorkspaceDocumentRecord,
    createWorkspaceDocumentRecord,
} from '@app/modules/workspace-shell/state/workspaceDocumentRecord';

describe('workspace document record opening view state', () => {
    it('uses continuous scrolling for a new empty tab open', () => {
        const record = createPendingWorkspaceDocumentRecord({
            fileName: 'scan.pdf',
            originalPath: requireDocumentRef('/docs/scan.pdf'),
        });

        expect(record.toolbarSnapshot.continuousScroll).toBe(true);
        expect(record.viewState.continuousScroll).toBe(true);
        expect(record.toolbarSnapshot).toMatchObject({
            effectiveZoom: 1,
            zoomMode: 'custom',
        });
        expect(record.viewState).toMatchObject({
            effectiveZoom: 1,
            zoomMode: 'custom',
        });
    });

    it('preserves an existing tab view state while replacing its document', () => {
        const previous = createWorkspaceDocumentRecord({toolbarSnapshot: {
            hasPdf: true,
            continuousScroll: false,
            currentPage: 73,
            effectiveZoom: 0.72,
            totalPages: 700,
            zoomMode: 'fit-width',
        }});
        const pending = createPendingWorkspaceDocumentRecord({
            fileName: 'replacement.pdf',
            originalPath: requireDocumentRef('/docs/replacement.pdf'),
        }, {
            previousToolbarSnapshot: previous.toolbarSnapshot,
            previousViewState: previous.viewState,
        });

        expect(pending.toolbarSnapshot.continuousScroll).toBe(false);
        expect(pending.toolbarSnapshot).toMatchObject({
            effectiveZoom: 0.72,
            zoomMode: 'fit-width',
        });
        expect(pending.viewState.continuousScroll).toBe(false);
        expect(pending.viewState.currentPage).toBe(1);
        expect(pending.toolbarSnapshot).toMatchObject({
            currentPage: 1,
            totalPages: 0,
        });
    });

});
