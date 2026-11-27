// @vitest-environment happy-dom

import type * as TViMockOriginalModule from '@app/composables/useTypedI18n';

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {createApp, defineComponent, h} from 'vue';
import DocumentPageSkeleton from '@app/components/document-viewer/DocumentPageSkeleton.vue';
import PdfInitialSurfacePlaceholder from '@app/modules/pdf-viewer/components/PdfInitialSurfacePlaceholder.vue';
import {WORKSPACE_VIEWER_ADAPTERS} from '@app/modules/workspace-shell/viewers/workspaceViewerAdapters';

vi.mock('@app/composables/useTypedI18n', async (importOriginal) => ({
    ...(await importOriginal<typeof TViMockOriginalModule>()),
    useTypedI18n: () => ({t: (key: string) => key}),
}));

const SkeletonStub = defineComponent({setup: () => () => h('span', {'data-ui-skeleton': ''})});
const ButtonStub = defineComponent({
    inheritAttrs: true,
    props: {
        label: {
            type: String,
            default: '',
        },
    },
    setup: (props) => () => h('button', props.label),
});
const activeUnmounts = new Set<() => void>();

function mount(component: Parameters<typeof createApp>[0]) {
    const host = document.createElement('div');
    document.body.append(host);
    const app = createApp(component);
    app.component('USkeleton', SkeletonStub);
    app.component('UIcon', SkeletonStub);
    app.component('UButton', ButtonStub);
    app.mount(host);
    const unmount = () => {
        app.unmount();
        host.remove();
        activeUnmounts.delete(unmount);
    };
    activeUnmounts.add(unmount);
    return {
        host,
        unmount,
    };
}

describe('viewer initial-surface behavior', () => {
    beforeEach(() => {
        document.body.innerHTML = '';
    });

    afterEach(() => {
        for (const unmount of activeUnmounts) {
            unmount();
        }
        vi.unstubAllGlobals();
        vi.useRealTimers();
    });

    it('routes every document renderer through the shared chassis adapter', () => {
        expect(new Set(WORKSPACE_VIEWER_ADAPTERS.map((adapter) => adapter.component))).toHaveLength(1);
    });

    it('renders a measured PDF opening shell with the real page skeleton', () => {
        const harness = mount(
            defineComponent({
                setup: () => () =>
                    h(PdfInitialSurfacePlaceholder, {
                        pageStyle: {
                            width: '612px',
                            height: '792px',
                        },
                    }),
            }),
        );

        const placeholder = harness.host.querySelector('[data-evb-initial-visual-placeholder="true"]');
        const shell = harness.host.querySelector<HTMLElement>('.pdf-initial-surface-placeholder__page-shell');
        expect(placeholder).not.toBeNull();
        expect(shell?.classList.contains('pdf-initial-surface-placeholder__page-shell--measured')).toBe(true);
        expect(shell?.style.width).toBe('612px');
        expect(shell?.style.height).toBe('792px');
        const skeleton = shell?.querySelector<HTMLElement>('.document-page-skeleton');
        expect(skeleton).not.toBeNull();
        expect(skeleton?.style.padding).toBe('');
        expect(shell?.querySelectorAll('.document-page-skeleton .line').length).toBeGreaterThan(0);

        harness.unmount();
    });

    it('omits inline padding by default and applies explicit padding and paragraph budgets', () => {
        const defaultHarness = mount(
            defineComponent({
                setup: () => () => h(DocumentPageSkeleton, {contentHeight: 760}),
            }),
        );
        const defaultSkeleton = defaultHarness.host.querySelector<HTMLElement>('.document-page-skeleton');
        expect(defaultSkeleton?.getAttribute('style')).toBeNull();
        // Fixed 2 paragraphs + repeatParagraphs for 760px with 0 explicit paddingY:
        // floor((760 - 17.4 * 16) / (5.05 * 16)) = floor(481.6 / 80.8) = 5 -> 7 total paragraphs.
        expect(defaultHarness.host.querySelectorAll('.document-page-skeleton .paragraph')).toHaveLength(7);
        defaultHarness.unmount();

        const paddedHarness = mount(
            defineComponent({
                setup: () => () =>
                    h(DocumentPageSkeleton, {
                        contentHeight: 760,
                        padding: {
                            top: 56,
                            right: 40,
                            bottom: 56,
                            left: 40,
                        },
                    }),
            }),
        );
        const paddedSkeleton = paddedHarness.host.querySelector<HTMLElement>('.document-page-skeleton');
        expect(paddedSkeleton?.style.padding).toBe('56px 40px');
        // floor((760 - 112 - 278.4) / 80.8) = floor(369.6 / 80.8) = 4 -> 6 total paragraphs.
        expect(paddedHarness.host.querySelectorAll('.document-page-skeleton .paragraph')).toHaveLength(6);
        paddedHarness.unmount();
    });
});
