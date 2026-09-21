import {
    describe, expect, it, vi,
} from 'vitest';
import {
    effectScope, ref,
} from 'vue';
import {createPageNavigationRequest} from '@app/modules/document-viewer/public';
import {createDocumentOpenSurfaceSession} from '@app/modules/document-viewer/runtime/documentOpenSurfaceSession';
import {useWorkspaceToolbarPageModel} from '@app/modules/workspace-shell/composables/useWorkspaceToolbarPageModel';

describe('useWorkspaceToolbarPageModel', () => {
    it('keeps the physical indicator separate from the pending command cursor', () => {
        const scope = effectScope();
        const sourcePage = ref(1);
        const session = createDocumentOpenSurfaceSession();
        session.begin({
            documentId: 'scan.pdf',
            documentRevision: 'revision-1',
        });
        const model = scope.run(() => useWorkspaceToolbarPageModel({
            sourcePage,
            navigationTicket: session.navigationTicket,
            goToPage: vi.fn(),
        }));
        if (!model) throw new Error('Failed to create workspace toolbar page model');

        session.navigate(createPageNavigationRequest(8, 'toolbar'));
        expect(model.currentPage.value).toBe(1);
        expect(model.navigationPage.value).toBe(8);
        sourcePage.value = 4;
        expect(model.currentPage.value).toBe(4);
        expect(model.navigationPage.value).toBe(8);
        scope.stop();
    });

    it('forwards explicit toolbar edits without making them the physical page', () => {
        const scope = effectScope();
        const sourcePage = ref(5);
        const goToPage = vi.fn();
        const model = scope.run(() => useWorkspaceToolbarPageModel({
            sourcePage,
            navigationTicket: ref(null),
            goToPage,
        }));
        if (!model) throw new Error('Failed to create workspace toolbar page model');

        model.handleGoToPage(9);
        expect(goToPage).toHaveBeenCalledWith(9);
        expect(model.currentPage.value).toBe(5);
        expect(model.navigationPage.value).toBe(5);
        scope.stop();
    });

    it('prefers the shared physical page projection when one is available', () => {
        const scope = effectScope();
        const sourcePage = ref(2);
        const physicalPage = ref(6);
        const model = scope.run(() => useWorkspaceToolbarPageModel({
            sourcePage,
            physicalPage,
            navigationTicket: ref(null),
            goToPage: vi.fn(),
        }));
        if (!model) throw new Error('Failed to create workspace toolbar page model');

        expect(model.currentPage.value).toBe(6);
        sourcePage.value = 9;
        expect(model.currentPage.value).toBe(6);
        physicalPage.value = 7;
        expect(model.currentPage.value).toBe(7);
        scope.stop();
    });
});
