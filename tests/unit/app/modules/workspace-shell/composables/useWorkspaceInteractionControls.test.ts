// @vitest-environment happy-dom

import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    computed,
    effectScope,
    ref,
} from 'vue';
import { DEFAULT_ANNOTATION_SETTINGS } from '@app/constants/annotationDefaults';
import { ZOOM } from '@app/constants/pdfLayout';
import { useWorkspaceInteractionControls } from '@app/modules/workspace-shell/composables/useWorkspaceInteractionControls';
import type { TAnnotationTool } from '@app/types/annotations';
import type { TPdfSource } from '@app/types/pdfUi';
import type {
    ISettingsData,
    TFitMode,
    TPdfViewMode,
    TZoomMode,
} from '@contracts/shared';
import type { TDocumentRef } from '@contracts/documentRef';
import {
    DEFAULT_SETTINGS,
    sanitizeSettings,
} from '@contracts/settings';
import { cast } from '@tests/helpers/cast';

const activeScopes: Array<() => void> = [];

afterEach(() => {
    // A live scope keeps its window key listener, and a stale listener that
    // calls preventDefault would silence the next test's shortcut.
    activeScopes.splice(0).forEach(stop => stop());
});

function createInteractionControls(overrides: {
    navigationPage?: number;
    totalPages?: number;
    viewMode?: TPdfViewMode;
} = {}) {
    const scope = effectScope();
    const handleGoToPage = vi.fn();
    const handleFitMode = vi.fn();
    const zoom = ref(1);
    const effectiveZoom = ref(1);
    const zoomMode = ref<TZoomMode>('custom');
    const pdfSrc = ref<TPdfSource | null>(new Blob([], {type: 'application/pdf'}));
    const options = {
        isActive: ref(true),
        appSettings: ref<ISettingsData>(sanitizeSettings({...DEFAULT_SETTINGS})),
        annotationSettings: ref({...DEFAULT_ANNOTATION_SETTINGS}),
        viewMode: ref<TPdfViewMode>(overrides.viewMode ?? 'single'),
        continuousScroll: ref(false),
        fitMode: ref<TFitMode>('width'),
        zoom,
        effectiveZoom,
        zoomMode,
        pdfSrc,
        canPrint: ref(true),
        canSave: ref(true),
        showSettings: ref(false),
        annotationTool: ref<TAnnotationTool>('none'),
        pdfViewerRef: ref(null),
        documentViewerRef: ref(null),
        shapePropertiesPopoverVisible: computed(() => false),
        annotationContextMenuVisible: computed(() => false),
        pageContextMenuVisible: computed(() => false),
        closeAnnotationContextMenu: vi.fn(),
        closePageContextMenu: vi.fn(),
        closeShapeProperties: vi.fn(),
        openSearch: vi.fn(),
        openAnnotations: vi.fn(),
        handleAnnotationToolChange: vi.fn(),
        handleFitMode,
        handleGoToPage,
        handleSave: vi.fn(async () => {}),
        handlePrint: vi.fn(),
        handleToggleSidebar: vi.fn(),
        handleDropdownOpenChange: vi.fn(),
        clearDocxExportError: vi.fn(),
        workingCopyPath: ref<TDocumentRef | null>(null),
        isDjvuMode: ref(false),
        djvuSourcePath: ref<TDocumentRef | null>(null),
        currentPage: ref(1),
        navigationPage: ref(overrides.navigationPage ?? 1),
        totalPages: ref(overrides.totalPages ?? 10),
        fileName: ref<string | null>('document.pdf'),
        originalPath: ref<TDocumentRef | null>(null),
        hasPendingTabChanges: computed(() => false),
        pdfData: ref<Uint8Array | null>(null),
        openFileWithViewerLifecycle: vi.fn(),
        waitForPdfReload: vi.fn(async () => {}),
        loadPdfFromPath: vi.fn(async () => {}),
    };
    activeScopes.push(() => scope.stop());
    const controls = scope.run(() => useWorkspaceInteractionControls(cast(options)));
    if (!controls) {
        throw new Error('The workspace interaction controls did not construct.');
    }

    return {
        controls,
        effectiveZoom,
        handleFitMode,
        handleGoToPage,
        options,
        zoom,
        zoomMode,
        pressKey: (key: string, init: KeyboardEventInit = {}) => {
            window.dispatchEvent(new KeyboardEvent('keydown', {
                key,
                bubbles: true,
                cancelable: true,
                ...init,
            }));
        },
        stop: () => scope.stop(),
    };
}

describe('useWorkspaceInteractionControls keyboard wiring', () => {
    it('steps paging shortcuts from the pending navigation page, not the lagging current page', () => {
        const harness = createInteractionControls({
            navigationPage: 4,
            totalPages: 10,
        });

        harness.pressKey('PageDown');

        expect(harness.handleGoToPage).toHaveBeenCalledWith(5, {navigationSource: 'toolbar'});
        harness.stop();
    });

    it('pages by spread when the workspace view mode shows two pages', () => {
        const harness = createInteractionControls({
            navigationPage: 2,
            totalPages: 10,
            viewMode: 'facing',
        });

        harness.pressKey('PageDown');

        expect(harness.handleGoToPage).toHaveBeenCalledWith(3, {navigationSource: 'toolbar'});
        harness.stop();
    });

    it('sends Home and End to the document bounds', () => {
        const harness = createInteractionControls({
            navigationPage: 5,
            totalPages: 12,
        });

        harness.pressKey('End');
        harness.pressKey('Home');

        expect(harness.handleGoToPage).toHaveBeenNthCalledWith(1, 12, {navigationSource: 'toolbar'});
        expect(harness.handleGoToPage).toHaveBeenNthCalledWith(2, 1, {navigationSource: 'toolbar'});
        harness.stop();
    });

    it('routes the fit-mode accelerators to the workspace fit-mode command', () => {
        const harness = createInteractionControls();

        harness.pressKey('1', {ctrlKey: true});
        harness.pressKey('2', {ctrlKey: true});

        expect(harness.handleFitMode).toHaveBeenNthCalledWith(1, 'width');
        expect(harness.handleFitMode).toHaveBeenNthCalledWith(2, 'height');
        harness.stop();
    });

    it('keeps zoom commands local to the interaction controls', () => {
        const harness = createInteractionControls();

        harness.pressKey('=', {ctrlKey: true});

        expect(harness.zoom.value).toBeCloseTo(1 + ZOOM.STEP);
        expect(harness.effectiveZoom.value).toBeCloseTo(1 + ZOOM.STEP);
        expect(harness.zoomMode.value).toBe('custom');
        harness.stop();
    });
});
