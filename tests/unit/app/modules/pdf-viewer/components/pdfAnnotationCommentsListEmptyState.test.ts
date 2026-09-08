// @vitest-environment happy-dom

import {
    describe,
    expect,
    it,
    onTestFinished,
    vi,
} from 'vitest';
import {
    createApp,
    defineComponent,
    h,
    nextTick,
    reactive,
    ref,
} from 'vue';
import type {
    IAnnotationCommentSummary,
    IAnnotationInventoryCompleteness,
    TAnnotationCommentsStatus,
} from '@app/types/annotations';
import type {IAnnotationEnrichmentState} from '@app/modules/pdf-viewer/engine/annotations/annotation-rules/annotationEnrichmentPolicy';
import PdfAnnotationCommentsList from '@app/modules/pdf-viewer/components/PdfAnnotationCommentsList.vue';

vi.mock('@app/composables/useTypedI18n', () => ({useTypedI18n: () => ({t: (key: string) => key})}));

async function mountList(options: {
    comments?: IAnnotationCommentSummary[];
    status?: TAnnotationCommentsStatus;
    inventory?: IAnnotationInventoryCompleteness;
    enrichmentState?: IAnnotationEnrichmentState;
} = {}) {
    const state = reactive({
        comments: options.comments ?? [],
        status: options.status ?? 'ready',
    });
    const host = document.createElement('div');
    document.body.append(host);
    const app = createApp({setup: () => () => h(PdfAnnotationCommentsList, {
        ...options,
        ...state,
    })});
    app.component('UButton', defineComponent({setup: (_props, {
        attrs,
        slots,
    }) => () => h('button', attrs, slots.default?.())}));
    app.component('UIcon', {render: () => h('span')});
    app.component('UInput', defineComponent({
        props: {modelValue: {
            type: String,
            default: '',
        }},
        emits: ['update:modelValue'],
        setup(props, {
            attrs,
            emit,
            expose,
        }) {
            const inputRef = ref<HTMLInputElement | null>(null);
            expose({inputRef});
            return () => h('input', {
                ...attrs,
                ref: inputRef,
                value: props.modelValue,
                onInput: (event: Event) => emit('update:modelValue', (event.target as HTMLInputElement).value),
            });
        },
    }));
    app.mount(host);
    onTestFinished(() => {app.unmount(); host.remove();});
    await nextTick();
    async function search(query: string) {
        host.querySelector<HTMLButtonElement>('[aria-label="annotations.searchAnnotations"]')!.click();
        await nextTick();
        const input = host.querySelector<HTMLInputElement>('input')!;
        input.value = query;
        input.dispatchEvent(new Event('input', {bubbles: true}));
        await nextTick();
        return input;
    }
    return {
        host,
        state,
        search,
    };
}

const comment: IAnnotationCommentSummary = {
    id: 'note-1',
    stableKey: 'ann:0:note-1',
    pageIndex: 0,
    pageNumber: 1,
    text: 'Review this passage',
    subtype: 'Text',
    author: 'Alice',
    modifiedAt: null,
    color: null,
    uid: null,
    annotationId: 'note-1',
    source: 'pdf',
    hasNote: true,
    markerRect: null,
};

describe('PdfAnnotationCommentsList empty state', () => {
    it('offers creation guidance only after the empty list is ready', async () => {
        const {
            host,
            state,
        } = await mountList({status: 'loading'});
        expect(host.querySelector('.document-panel-empty-state')).toBeNull();
        expect(host.querySelector('.notes-loading-state')).not.toBeNull();
        state.status = 'ready';
        await nextTick();
        expect(host.querySelector('.document-panel-empty-state__title')?.textContent).toBe('annotations.noAnnotationsFound');
        expect(host.querySelector('.document-panel-empty-state__description')?.textContent).toBe('annotations.noAnnotationsHint');
        expect(host.querySelector('.notes-empty-clear-search')).toBeNull();
    });

    it('explains unmatched search and clears it to restore existing annotations', async () => {
        const {
            host,
            search,
        } = await mountList({comments: [comment]});
        const input = await search('unmatched');
        expect(host.querySelector('.document-panel-empty-state__title')?.textContent).toBe('annotations.noMatchingAnnotations');
        expect(host.querySelector('.document-panel-empty-state__description')).toBeNull();
        const clear = host.querySelector<HTMLButtonElement>('.notes-empty-clear-search')!;
        expect(clear.textContent).toBe('search.clearSearchLabel');
        clear.click();
        await nextTick();
        expect(input.value).toBe('');
        expect(document.activeElement).toBe(input);
        expect(host.querySelector('.document-panel-empty-state')).toBeNull();
        expect(host.querySelector('.note-item')?.textContent).toContain('Review this passage');
    });

    it('treats whitespace as no filter and restores empty-list guidance after clearing a query', async () => {
        const {
            host,
            search,
        } = await mountList();
        await search('   ');
        expect(host.querySelector('.notes-empty-clear-search')).toBeNull();
        await search('missing');
        expect(host.querySelector('.notes-empty-clear-search')).not.toBeNull();
        host.querySelector<HTMLButtonElement>('.notes-empty-clear-search')!.click();
        await nextTick();
        expect(host.querySelector('.document-panel-empty-state__description')?.textContent).toBe('annotations.noAnnotationsHint');
    });

    it('retains the incomplete-inventory notice without suggesting the document needs its first annotation', async () => {
        const {host} = await mountList({inventory: {
            complete: false,
            omissions: ['page-parse-failure'],
            scannedPageCount: 1,
            totalPageCount: 2,
            failedPageCount: 1,
        }});
        expect(host.querySelector('[data-testid="annotation-inventory-incomplete"]')).not.toBeNull();
        expect(host.querySelector('.document-panel-empty-state__description')).toBeNull();
    });

    it.each([
        'failed',
        'skipped',
    ] as const)('preserves the %s enrichment notice and retry action', async status => {
        const {host} = await mountList({enrichmentState: {
            status,
            reason: status === 'skipped' ? 'unreadable-source' : null,
            canRetry: true,
        }});
        expect(host.querySelector('.notes-enrichment-notice')).not.toBeNull();
        expect(host.querySelector('.notes-enrichment-retry')).not.toBeNull();
        expect(host.querySelector('.document-panel-empty-state__description')).toBeNull();
    });
});
