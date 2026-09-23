// @vitest-environment happy-dom

import type * as TViMockOriginalModule from '@app/composables/useTypedI18n';

import { requireDocumentRef } from '@contracts/documentRef';
import { requireEpochMs } from '@contracts/timestamps';
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
import type { App } from 'vue';
import type { IRecentFile } from '@contracts/shared';
import PdfEmptyState from '@app/modules/pdf-viewer/components/PdfEmptyState.vue';

vi.mock('@app/composables/useTypedI18n', async (importOriginal) => ({
    ...(await importOriginal<typeof TViMockOriginalModule>()),
    useTypedI18n: () => ({t: (key: string, values?: {count?: number}) => (
        values?.count === undefined ? key : `${key}:${values.count}`
    )}),
}));

afterEach(() => {
    document.body.innerHTML = '';
});

function createRecentFile(originalPath: string, timestamp: number): IRecentFile {
    return {
        originalPath: requireDocumentRef(originalPath),
        backend: 'browser',
        fileName: originalPath.split('/').at(-1) ?? originalPath,
        timestamp: requireEpochMs(timestamp),
    };
}

function registerUiStubs(app: App) {
    app.component('UIcon', defineComponent({setup: () => () => h('span')}));
    app.component('UButton', defineComponent({
        props: {label: String},
        setup: props => () => h('button', props.label),
    }));
    app.component('UInput', defineComponent({setup: () => () => h('input')}));
    app.component('UAlert', defineComponent({setup: () => () => h('div')}));
    app.component('AppTooltip', defineComponent({
        props: {text: String},
        setup: (props, {slots}) => () => h('span', {'data-tooltip-text': props.text}, slots.default?.()),
    }));
    app.component('UModal', defineComponent({setup: () => () => null}));
}

function getRecentOrder(host: HTMLElement) {
    return Array.from(host.querySelectorAll<HTMLElement>('.recent-row--data'))
        .map(row => row.dataset.recentSource);
}

describe('PdfEmptyState recent-file order', () => {
    it('keeps the visible order stable while the selected document is opening', async () => {
        const first = createRecentFile('browser://documents/first.pdf', 2);
        const second = createRecentFile('browser://documents/second.djvu', 1);
        const recentFiles = ref([
            first,
            second,
        ]);
        const openInProgress = ref(false);
        const host = document.createElement('div');
        document.body.append(host);
        const app = createApp(defineComponent({setup: () => () => h(PdfEmptyState, {
            recentFiles: recentFiles.value,
            recentFilesResolved: true,
            openInProgress: openInProgress.value,
            onOpenRecent: (file: IRecentFile) => {
                openInProgress.value = true;
                recentFiles.value = [
                    {
                        ...file,
                        timestamp: requireEpochMs(3),
                    },
                    first,
                ];
            },
        })}));
        registerUiStubs(app);

        app.mount(host);
        await nextTick();
        const secondRowButton = host.querySelectorAll<HTMLButtonElement>('button.recent-open')[1];
        expect(secondRowButton).toBeDefined();
        secondRowButton!.click();
        await nextTick();

        expect(getRecentOrder(host)).toEqual([
            first.originalPath,
            second.originalPath,
        ]);

        openInProgress.value = false;
        await nextTick();
        expect(getRecentOrder(host)).toEqual([
            second.originalPath,
            first.originalPath,
        ]);

        app.unmount();
    });

    it('keeps distinguishing filename tails visible and exposes each full name in its tooltip', async () => {
        const standard = createRecentFile(
            'browser://documents/W4 archive of documents 2026 final edition 1980.pdf',
            2,
        );
        const optimized = createRecentFile(
            'browser://documents/W4 archive of documents 2026 final edition 1980-optimized.pdf',
            1,
        );
        const host = document.createElement('div');
        document.body.append(host);
        const app = createApp(defineComponent({setup: () => () => h(PdfEmptyState, {
            recentFiles: [
                standard,
                optimized,
            ],
            recentFilesResolved: true,
            openInProgress: false,
        })}));
        registerUiStubs(app);

        app.mount(host);
        await nextTick();

        const names = Array.from(host.querySelectorAll<HTMLElement>('.recent-file-name'));
        expect(names).toHaveLength(2);
        expect(names.map(name => name.closest('[data-tooltip-text]')?.getAttribute('data-tooltip-text'))).toEqual([
            standard.fileName,
            optimized.fileName,
        ]);
        expect(names.map(name => name.querySelector('.recent-file-name-suffix')?.textContent)).toEqual([
            expect.stringContaining('1980.pdf'),
            expect.stringContaining('1980-optimized.pdf'),
        ]);

        app.unmount();
    });
});
