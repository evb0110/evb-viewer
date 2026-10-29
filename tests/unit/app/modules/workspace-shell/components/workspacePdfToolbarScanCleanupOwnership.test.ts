// @vitest-environment happy-dom

import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    createApp,
    defineComponent,
    h,
    nextTick,
    ref,
    type App,
} from 'vue';
import {requireDocumentRef} from '@contracts/documentRef';
import {requireJobId} from '@contracts/shared';
import {requireEpochMs} from '@contracts/timestamps';
import {createDefaultWorkspaceToolbarSnapshot} from '@app/types/workspaceExpose';
import {scanCleanupRun} from '@app/modules/scan-cleanup/public/runtime';
import WorkspacePdfToolbarView from '@app/modules/workspace-shell/components/WorkspacePdfToolbarView.vue';

// Exercise the real reader toolbar's scan-cleanup slot, including its real
// progress formatter and coordinator state, without mounting unrelated menus.
vi.mock('@app/modules/pdf-viewer/public/component-exports/pdfToolbar', () => ({PdfToolbar: defineComponent({
    inheritAttrs: false,
    setup: (_props, {slots}) => () => h('nav', slots['scan-cleanup']?.()),
})}));

const sourceA = requireDocumentRef('/docs/a-working-copy.pdf');
const sourceB = requireDocumentRef('/docs/b-working-copy.pdf');
const apps: App[] = [];
const hosts: HTMLElement[] = [];

afterEach(() => {
    apps.splice(0).forEach(app => app.unmount());
    hosts.splice(0).forEach(host => host.remove());
    scanCleanupRun.activeJobId = null;
    scanCleanupRun.inFlight = false;
    scanCleanupRun.jobState = null;
    scanCleanupRun.ownerDocumentRef = null;
    scanCleanupRun.ownerDocumentRevision = null;
    scanCleanupRun.ownerId = null;
    vi.unstubAllGlobals();
});

function mountToolbar(documentRef: typeof sourceA) {
    const host = document.createElement('div');
    document.body.append(host);
    hosts.push(host);
    const snapshot = {
        ...createDefaultWorkspaceToolbarSnapshot(),
        hasPdf: true,
        totalPages: documentRef === sourceA ? 8 : 3,
    };
    const app = createApp({render: () => h(WorkspacePdfToolbarView, {
        snapshot,
        canUseOcr: true,
        isDesktopRuntime: true,
        isFullscreen: false,
        fullscreenSupported: true,
        isOpeningDocument: false,
        ocrWorkingCopyPath: documentRef,
        ocrPopupOpen: false,
        zoomDropdownOpen: false,
        pageDropdownOpen: false,
        overflowMenuOpen: false,
        appMenuOpen: false,
    })});
    app.component('AppTooltip', defineComponent({
        inheritAttrs: false,
        setup: (_props, {slots}) => () => slots.default?.(),
    }));
    app.component('UButton', defineComponent({setup: (_props, {slots}) => () => h('button', slots.default?.())}));
    apps.push(app);
    app.mount(host);
    return host;
}

describe('reader toolbar scan cleanup ownership', () => {
    it('does not show document A run progress in document B toolbar', async () => {
        vi.stubGlobal('useState', (_key: string, initial: () => unknown) => ref(initial()));
        const toolbarA = mountToolbar(sourceA);
        const toolbarB = mountToolbar(sourceB);
        const buttonB = toolbarB.querySelector('button')!;
        expect(buttonB.getAttribute('aria-label')).toBe('scanCleanup.button');

        scanCleanupRun.ownerDocumentRef = sourceA;
        scanCleanupRun.ownerId = 'workspace-a';
        scanCleanupRun.ownerDocumentRevision = 'revision-a';
        scanCleanupRun.activeJobId = requireJobId('cleanup-a');
        scanCleanupRun.inFlight = true;
        scanCleanupRun.jobState = {
            jobId: requireJobId('cleanup-a'),
            status: 'running',
            updatedAtMs: requireEpochMs(1),
            progress: {
                stage: 'rendering',
                completedUnits: 2,
                totalUnits: 8,
                percent: 25,
            },
        };
        await nextTick();

        // Positive control: suppressing every toolbar's progress is not a fix.
        expect(toolbarA.querySelector('button')?.getAttribute('aria-label')).toContain('scanCleanup.runStatus');
        expect(toolbarA.querySelector('.scan-cleanup-running-dot')).not.toBeNull();
        expect.soft(buttonB.getAttribute('aria-label')).toBe('scanCleanup.button');
        expect.soft(buttonB.getAttribute('aria-pressed')).toBe('false');
        expect.soft(toolbarB.querySelector('.scan-cleanup-running-dot')).toBeNull();
    });
});
