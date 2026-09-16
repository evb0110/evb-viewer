// @vitest-environment happy-dom

import type * as TViMockOriginalModule from '@app/composables/useTypedI18n';

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
} from 'vue';
import DjvuConversionOverlay from '@app/modules/djvu-viewer/components/DjvuConversionOverlay.vue';

vi.mock('@app/composables/useTypedI18n', async (importOriginal) => ({
    ...(await importOriginal<typeof TViMockOriginalModule>()),
    useTypedI18n: () => ({t: (key: string) => key}),
}));

const ButtonStub = defineComponent({
    inheritAttrs: false,
    props: ['label'],
    emits: ['click'],
    setup: (props, context) => () => h('button', {
        ...context.attrs,
        type: 'button',
        onClick: () => context.emit('click'),
    }, props.label),
});

const ProgressStub = defineComponent({
    inheritAttrs: false,
    setup: (_props, {attrs}) => () => h('progress', attrs),
});

const IconStub = defineComponent({
    inheritAttrs: false,
    setup: (_props, {attrs}) => () => h('span', attrs),
});

const activeUnmounts = new Set<() => void>();

afterEach(() => {
    for (const unmount of [...activeUnmounts]) {
        unmount();
    }
});

function mountOverlay() {
    const host = document.createElement('div');
    document.body.append(host);
    const open = ref(false);
    let cancelCount = 0;
    const renderRoot = () => h('div', [
        h('button', {
            id: 'workspace-action',
            type: 'button',
        }, 'Workspace action'),
        h(DjvuConversionOverlay, {
            isConverting: open.value,
            phase: 'converting',
            percent: 25,
            onCancel: () => {
                cancelCount += 1;
            },
        }),
    ]);
    const Root = defineComponent({setup: () => renderRoot});
    const app = createApp(Root);
    app.component('UButton', ButtonStub);
    app.component('UProgress', ProgressStub);
    app.component('UIcon', IconStub);
    app.mount(host);

    const unmount = () => {
        app.unmount();
        host.remove();
        activeUnmounts.delete(unmount);
    };
    activeUnmounts.add(unmount);
    return {
        cancelCount: () => cancelCount,
        host,
        open,
        unmount,
    };
}

describe('DjvuConversionOverlay', () => {
    it.each([
        'cancel',
        'completion',
        'failure',
    ])('presents conversion progress as a modal and restores focus after %s', async (terminalState) => {
        const mounted = mountOverlay();
        const workspaceAction = mounted.host.querySelector<HTMLButtonElement>('#workspace-action')!;
        workspaceAction.focus();

        mounted.open.value = true;
        await nextTick();
        await nextTick();

        const overlay = mounted.host.querySelector<HTMLElement>('.app-progress-overlay')!;
        expect(overlay.getAttribute('role')).toBe('dialog');
        expect(mounted.host.querySelector('.app-progress-overlay-percent')?.textContent).toContain('25%');
        expect(workspaceAction.hasAttribute('inert')).toBe(true);

        if (terminalState === 'cancel') {
            overlay.dispatchEvent(new KeyboardEvent('keydown', {
                bubbles: true,
                cancelable: true,
                key: 'Escape',
            }));
            expect(mounted.cancelCount()).toBe(1);
        }

        mounted.open.value = false;
        await nextTick();
        await nextTick();
        expect(mounted.host.querySelector('.app-progress-overlay')).toBeNull();
        expect(workspaceAction.hasAttribute('inert')).toBe(false);
        expect(document.activeElement).toBe(workspaceAction);
    });

    it('focuses a visible fallback when the initiating control was replaced', async () => {
        const mounted = mountOverlay();
        const workspaceAction = mounted.host.querySelector<HTMLButtonElement>('#workspace-action')!;
        workspaceAction.focus();
        mounted.open.value = true;
        await nextTick();
        await nextTick();

        workspaceAction.remove();
        const fallback = document.createElement('button');
        fallback.type = 'button';
        fallback.id = 'replacement-action';
        document.body.append(fallback);
        mounted.open.value = false;
        await nextTick();
        await nextTick();

        expect(document.activeElement).toBe(fallback);
        fallback.remove();
    });
});
