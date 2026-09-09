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
        app.component('UIcon', defineComponent({setup: () => () => h('span')}));
        app.component('UButton', defineComponent({
            props: {label: String},
            setup: props => () => h('button', props.label),
        }));
        app.component('UInput', defineComponent({setup: () => () => h('input')}));
        app.component('AppTooltip', defineComponent({setup: (_, {slots}) => () => h('span', slots.default?.())}));
        app.component('UModal', defineComponent({setup: () => () => null}));

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
});
