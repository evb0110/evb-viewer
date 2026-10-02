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
} from 'vue';
import type { IRecentFile } from '@contracts/shared';
import { requireDocumentRef } from '@contracts/documentRef';
import { requireEpochMs } from '@contracts/timestamps';
import PdfEmptyState from '@app/modules/pdf-viewer/components/PdfEmptyState.vue';

vi.mock('@app/composables/useTypedI18n', async (importOriginal) => ({
    ...(await importOriginal<typeof TViMockOriginalModule>()),
    useTypedI18n: () => ({t: (key: string) => key}),
}));

afterEach(() => {
    document.body.innerHTML = '';
});

function recentFile(path: string): IRecentFile {
    return {
        originalPath: requireDocumentRef(path),
        backend: 'electron',
        fileName: path.split('/').at(-1) ?? path,
        timestamp: requireEpochMs(1_790_000_000_000),
        fileSize: 4,
    };
}

async function mountStart(props: {
    recentFiles: IRecentFile[];
    recentFilesError: string | null;
}) {
    const host = document.createElement('div');
    document.body.append(host);
    const onRetryRecent = vi.fn();
    const app = createApp(defineComponent({setup: () => () => h(PdfEmptyState, {
        ...props,
        recentFilesResolved: true,
        onRetryRecent,
    })}));
    app.component('UIcon', defineComponent({setup: () => () => h('span')}));
    app.component('UButton', defineComponent({
        props: {label: String},
        emits: ['click'],
        setup: (props, {emit}) => () => h('button', {onClick: () => emit('click')}, props.label),
    }));
    app.component('UInput', defineComponent({setup: () => () => h('input')}));
    app.component('AppTooltip', defineComponent({setup: (_, {slots}) => () => h('span', slots.default?.())}));
    app.component('UModal', defineComponent({setup: () => () => null}));
    app.mount(host);
    await nextTick();
    return {
        host,
        onRetryRecent,
        unmount: () => app.unmount(),
    };
}

describe('PdfEmptyState Recent list load failure', () => {
    it('says so in the list box, where its rows would be, and retries from there', async () => {
        const {
            host,
            onRetryRecent,
            unmount,
        } = await mountStart({
            recentFiles: [],
            recentFilesError: 'storage unavailable',
        });

        const box = host.querySelector<HTMLElement>('[data-testid="recent-load-error"]');
        expect(box?.textContent).toContain('errors.recent.load');
        expect(host.querySelector('[role="alert"]')).toBeNull();
        expect(host.querySelector('.recent-empty:not([data-testid])')).toBeNull();
        [...(box?.querySelectorAll('button') ?? [])].find(button => button.textContent === 'common.retry')?.click();
        expect(onRetryRecent).toHaveBeenCalledOnce();
        unmount();
    });

    it('keeps the rows it has when a later load fails and says so in the footer', async () => {
        const {
            host,
            onRetryRecent,
            unmount,
        } = await mountStart({
            recentFiles: [recentFile('/docs/kept.pdf')],
            recentFilesError: 'storage unavailable',
        });

        expect(host.querySelector('[data-testid="recent-load-error"]')).toBeNull();
        expect(host.querySelector('[data-recent-source="/docs/kept.pdf"]')).not.toBeNull();
        const footerNote = host.querySelector<HTMLElement>('.recent-footer [data-testid="recent-refresh-error"]');
        expect(footerNote?.textContent).toContain('errors.recent.load');
        footerNote?.querySelector('button')?.click();
        expect(onRetryRecent).toHaveBeenCalledOnce();
        unmount();
    });
});
