import type * as TViMockOriginalModule from '@app/modules/workspace-shell/automation/automationReadinessEvents';

import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    nextTick,
    ref,
} from 'vue';
import type { IDocumentViewerExpose } from '@app/modules/pdf-viewer/public';
import type { IAnalyticsDocumentScope } from '@app/composables/useAnalytics';
import type { TPdfSource } from '@app/types/pdfUi';

const mocks = vi.hoisted(() => ({ emitAutomationEvent: vi.fn() }));

vi.mock('@app/modules/workspace-shell/automation/automationReadinessEvents', async (importOriginal) => ({
    ...(await importOriginal<typeof TViMockOriginalModule>()),
    emitAutomationEvent: mocks.emitAutomationEvent,
}));

function createOptions(overrides: {
    accepted?: boolean;
    navigationSource?: 'toolbar' | 'thumbnail' | null;
} = {}) {
    const currentPage = ref(1);
    const accepted = overrides.accepted ?? true;
    const analytics = {
        key: 'workspace-test',
        activate: vi.fn(),
        clear: vi.fn(),
        deactivate: vi.fn(),
        dispose: vi.fn(),
        merge: vi.fn(),
        set: vi.fn(),
    } satisfies IAnalyticsDocumentScope;
    return {
        analytics,
        tabId: 'tab-1',
        pdfSrc: ref<TPdfSource | null>(null),
        currentPage,
        totalPages: ref(12),
        showSidebar: ref(false),
        sidebarTab: ref('thumbnails'),
        isLoading: ref(false),
        continuousScroll: ref(true),
        fitMode: ref('width'),
        viewMode: ref('single' as const),
        zoom: ref(1),
        viewerRef: ref<IDocumentViewerExpose | null>(null),
        // Stands in for the fence: the real one commits the accepted page and
        // reports the arming source in this single call.
        consumePageUpdate: vi.fn((page: number) => {
            if (accepted) {
                currentPage.value = page;
            }
            return {
                accepted,
                navigationSource: accepted ? overrides.navigationSource ?? null : null,
            };
        }),
    };
}

describe('createWorkspaceViewerUpdateHandlers', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('records the navigation source that produced an accepted page update', async () => {
        const { createWorkspaceViewerUpdateHandlers } = await import(
            '@app/modules/workspace-shell/viewers/createWorkspaceViewerUpdateHandlers'
        );
        const options = createOptions({ navigationSource: 'thumbnail' });
        const { handleCurrentPage } = createWorkspaceViewerUpdateHandlers(options);

        handleCurrentPage(4);
        await nextTick();

        expect(options.currentPage.value).toBe(4);
        expect(mocks.emitAutomationEvent).toHaveBeenCalledWith('navigation-idle', {
            navigationSource: 'thumbnail',
            page: 4,
            previousPage: 1,
            tabId: 'tab-1',
            totalPages: 12,
        });
    });

    it('reports a null navigation source for page updates the user produced by scrolling', async () => {
        const { createWorkspaceViewerUpdateHandlers } = await import(
            '@app/modules/workspace-shell/viewers/createWorkspaceViewerUpdateHandlers'
        );
        const options = createOptions();
        const { handleCurrentPage } = createWorkspaceViewerUpdateHandlers(options);

        handleCurrentPage(2);
        await nextTick();

        expect(mocks.emitAutomationEvent).toHaveBeenCalledWith(
            'navigation-idle',
            expect.objectContaining({ navigationSource: null }),
        );
    });

    it('emits nothing for a rejected stale page update', async () => {
        const { createWorkspaceViewerUpdateHandlers } = await import(
            '@app/modules/workspace-shell/viewers/createWorkspaceViewerUpdateHandlers'
        );
        const options = createOptions({ accepted: false });
        const { handleCurrentPage } = createWorkspaceViewerUpdateHandlers(options);

        handleCurrentPage(7);
        await nextTick();

        expect(options.currentPage.value).toBe(1);
        expect(mocks.emitAutomationEvent).not.toHaveBeenCalled();
    });
});
