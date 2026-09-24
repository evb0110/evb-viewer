// @vitest-environment happy-dom

import type * as TViMockOriginalModule from '@app/composables/useTypedI18n';

import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    createApp,
    defineComponent,
    h,
} from 'vue';
import PdfInitialSurfacePlaceholder from '@app/modules/pdf-viewer/components/PdfInitialSurfacePlaceholder.vue';
import { WORKSPACE_VIEWER_ADAPTERS } from '@app/modules/workspace-shell/viewers/workspaceViewerAdapters';

vi.mock('@app/composables/useTypedI18n', async (importOriginal) => ({
    ...(await importOriginal<typeof TViMockOriginalModule>()),
    useTypedI18n: () => ({t: (key: string) => key}),
}));

const SkeletonStub = defineComponent({setup: () => () => h('span', {'data-ui-skeleton': ''})});
const ButtonStub = defineComponent({
    inheritAttrs: true,
    props: {label: {
        type: String,
        default: '',
    }},
    setup: props => () => h('button', props.label),
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
        for (const unmount of activeUnmounts) unmount();
        vi.unstubAllGlobals();
        vi.useRealTimers();
    });

    it('routes every document renderer through the shared chassis adapter', () => {
        expect(new Set(WORKSPACE_VIEWER_ADAPTERS.map(adapter => adapter.component))).toHaveLength(1);
    });

    it('renders a measured PDF opening shell with the real page skeleton', () => {
        const harness = mount(defineComponent({setup: () => () => h(PdfInitialSurfacePlaceholder, {pageStyle: {
            width: '612px',
            height: '792px',
        }})}));

        const placeholder = harness.host.querySelector('[data-evb-initial-visual-placeholder="true"]');
        const shell = harness.host.querySelector<HTMLElement>('.pdf-initial-surface-placeholder__page-shell');
        expect(placeholder).not.toBeNull();
        expect(shell?.classList.contains('pdf-initial-surface-placeholder__page-shell--measured')).toBe(true);
        expect(shell?.style.width).toBe('612px');
        expect(shell?.style.height).toBe('792px');
        expect(shell?.querySelector('.document-page-skeleton')).not.toBeNull();
        expect(shell?.querySelector<HTMLElement>('.document-page-skeleton')?.style.padding).toBe('56px');
        expect(shell?.querySelectorAll('.document-page-skeleton .line').length).toBeGreaterThan(0);

        harness.unmount();
    });
});
