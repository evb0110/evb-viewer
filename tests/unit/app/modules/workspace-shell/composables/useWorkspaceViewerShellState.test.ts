import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    computed,
    effectScope,
    nextTick,
    ref,
} from 'vue';
import { DEFAULT_SETTINGS } from '@contracts/settings';
import type { ISettingsData } from '@contracts/shared';
import { DEFAULT_ANNOTATION_SETTINGS } from '@app/constants/annotationDefaults';
import { useWorkspaceViewerDefaults } from '@app/modules/workspace-shell/composables/useWorkspaceViewerDefaults';
import { resolveDocumentPageDisplayLayoutsBounded } from '@app/modules/document-viewer/page-source-renderer/useDocumentPageSourceRuntime';
import { createRangePageSelection } from '@contracts/pageNumbers';
import { useWorkspaceViewerShellState } from '@app/modules/workspace-shell/composables/useWorkspaceViewerShellState';

describe('workspace viewer shell state', () => {
    it('derives compatibility modes from one authoritative discriminated state', () => {
        const state = useWorkspaceViewerShellState({
            surfaceMode: 'reader',
            currentPage: 42,
            zoom: 1.5,
            zoomMode: 'fit-width',
            fitMode: 'height',
            viewMode: 'single',
            showSidebar: false,
            sidebarTab: 'search',
            sidebarWidth: 396,
            continuousScroll: true,
        });

        expect(state.zoomState.value).toEqual({
            kind: 'fit',
            axis: 'width',
        });
        expect(state.fitMode.value).toBe('width');
        expect(state.sidebarTab.value).toBe('search');
        expect(state.currentPage.value).toBe(42);

        state.zoomMode.value = 'custom';
        state.zoom.value = 2;
        expect(state.zoomState.value).toEqual({
            kind: 'custom',
            scale: 2,
        });

        state.fitMode.value = 'height';
        expect(state.zoomMode.value).toBe('custom');
        state.zoomMode.value = 'fit-height';
        expect(state.zoomState.value).toEqual({
            kind: 'fit',
            axis: 'height',
        });
    });

    it('keeps the toolbar at the runtime layout zoom when activation yields after reset', async () => {
        const scope = effectScope();
        try {
            const setup = scope.run(() => {
                const state = useWorkspaceViewerShellState({
                    surfaceMode: 'reader',
                    currentPage: 1,
                    zoom: 1,
                    zoomMode: 'fit-width',
                    fitMode: 'width',
                    viewMode: 'single',
                    showSidebar: false,
                    sidebarTab: 'thumbnails',
                    sidebarWidth: 272,
                    continuousScroll: true,
                });
                const viewportWidth = ref(100);
                const layouts = computed(() => resolveDocumentPageDisplayLayoutsBounded(
                    [{
                        widthPoints: 10,
                        heightPoints: 20,
                        rotation: 0,
                    }],
                    100, viewportWidth.value, state.zoom.value, state.zoomMode.value,
                ));
                const runtime = {
                    getViewerContainer: () => null,
                    scrollToPage: () => {},
                    getEffectiveZoom: () => layouts.value[0]!.scale,
                };
                state.djvuViewerRef.value = runtime;
                const source = ref<unknown>('previous.djvu');
                useWorkspaceViewerDefaults({
                    appSettings: ref<ISettingsData>({
                        ...DEFAULT_SETTINGS,
                        defaultZoomPreset: 'fit-width',
                    }),
                    annotationSettings: ref({...DEFAULT_ANNOTATION_SETTINGS}),
                    viewMode: state.viewMode,
                    continuousScroll: state.continuousScroll,
                    fitMode: state.fitMode,
                    zoom: state.zoom,
                    zoomMode: state.zoomMode,
                    effectiveZoom: state.effectiveZoom,
                    pdfSrc: ref(null),
                    documentSourceKey: source,
                });
                return {
                    state,
                    source,
                    runtime,
                    viewportWidth,
                };
            })!;
            expect(setup.state.effectiveZoom.value).toBe(setup.runtime.getEffectiveZoom());
            setup.source.value = null;
            // The release await that preceded source activation in a13d58214.
            await nextTick();
            setup.source.value = 'next.djvu';
            await nextTick();
            expect(setup.runtime.getEffectiveZoom()).toBe(10);
            expect(setup.state.effectiveZoom.value).toBe(setup.runtime.getEffectiveZoom());
            setup.viewportWidth.value = 75;
            await nextTick();
            expect(setup.runtime.getEffectiveZoom()).toBe(7.5);
            expect(setup.state.effectiveZoom.value).toBe(setup.runtime.getEffectiveZoom());
        } finally {
            scope.stop();
        }
    });

    it('keeps the last bounded legacy mirror for an oversized compact selection', () => {
        const state = useWorkspaceViewerShellState();
        state.totalPages.value = 200_000;
        state.setSelectedThumbnailPages([
            2,
            4,
        ]);
        const selection = createRangePageSelection(200_000, 2, 100_002);

        state.setSelectedPageSelection(selection);

        expect(state.selectedPageSelection.value).toEqual(selection);
        expect(state.selectedThumbnailPages.value).toEqual([
            2,
            4,
        ]);
    });
});
