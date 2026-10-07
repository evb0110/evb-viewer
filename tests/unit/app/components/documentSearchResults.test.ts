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
    reactive,
} from 'vue';
import type {ISearchIndexCoverage} from '@contracts/search';
import type { IDocumentSearchMatch } from '@app/modules/document-viewer/search/documentSearch';
import DocumentSearchResults from '@app/components/document-viewer/DocumentSearchResults.vue';

vi.mock('@app/composables/useTypedI18n', async (importOriginal) => ({
    ...(await importOriginal<typeof TViMockOriginalModule>()),
    useTypedI18n: () => ({t: (key: string, values?: Record<string, unknown>) => `${key}:${JSON.stringify(values ?? {})}`}),
}));

const Stub = defineComponent({setup: () => () => h('i')});

interface ISearchResultsHarnessState {
    results: IDocumentSearchMatch[];
    coverage?: ISearchIndexCoverage;
    currentResultIndex: number;
    currentResultNavigationId: number;
}

function match(pageIndex: number, matchIndex: number): IDocumentSearchMatch {
    return {
        pageIndex,
        pageMatchIndex: 0,
        matchIndex,
        startOffset: 0,
        endOffset: 7,
        excerpt: {
            before: 'before ',
            match: 'lezgian',
            after: ' after',
            prefix: false,
            suffix: false,
        },
    };
}

const activeUnmounts = new Set<() => void>();

afterEach(() => {
    for (const unmount of [...activeUnmounts]) {
        unmount();
    }
});

async function mountResults(state: ISearchResultsHarnessState, clientHeight: number) {
    const host = document.createElement('div');
    document.body.append(host);
    const app = createApp(defineComponent({setup: () => () => h(DocumentSearchResults, {
        results: state.results,
        currentResultIndex: state.currentResultIndex,
        currentResultNavigationId: state.currentResultNavigationId,
        searchQuery: 'lezgian',
        searchProgress: state.coverage ? {
            processed: state.coverage.pagesScanned,
            total: state.coverage.pageCount,
            coverage: state.coverage,
        } : undefined,
    })}));
    app.component('UIcon', Stub);
    app.component('UProgress', Stub);
    app.mount(host);
    await nextTick();
    const list = host.querySelector<HTMLElement>('.document-search-results-list');
    if (list) {
        Object.defineProperty(list, 'clientHeight', {
            configurable: true,
            value: clientHeight,
        });
        list.dispatchEvent(new Event('scroll'));
        await nextTick();
    }
    const unmount = () => {
        app.unmount();
        host.remove();
        activeUnmounts.delete(unmount);
    };
    activeUnmounts.add(unmount);
    return {
        host,
        get list() {
            const currentList = host.querySelector<HTMLElement>('.document-search-results-list');
            expect(currentList).not.toBeNull();
            return currentList!;
        },
    };
}

function groupButton(host: HTMLElement, pageNumber: number) {
    const button = host.querySelector<HTMLButtonElement>(
        `.document-search-results-group-toggle[data-page-number="${String(pageNumber)}"]`,
    );
    expect(button).not.toBeNull();
    return button!;
}

describe('DocumentSearchResults', () => {
    it('distinguishes incomplete zero matches and keeps a coverage notice beside matches', async () => {
        const coverage = {
            pageCount: 3,
            pagesScanned: 2,
            pagesWritten: 1,
            truncated: true,
            missingTextPageSample: [],
        };
        const state = reactive<ISearchResultsHarnessState>({
            results: [],
            coverage,
            currentResultIndex: -1,
            currentResultNavigationId: 0,
        });
        const {host} = await mountResults(state, 120);
        await nextTick();
        expect(host.textContent).toContain('searchResults.noResultsInCoverage');
        expect(host.textContent).toContain('searchResults.incompleteCoverageHint');
        state.results = [match(0, 0)];
        await nextTick();
        expect(host.textContent).toContain('searchResults.incompleteCoverage');
        state.coverage = {
            ...coverage,
            pagesScanned: 3,
            pagesWritten: 3,
            truncated: false,
        };
        state.results = [];
        await nextTick();
        expect(host.textContent).toContain('searchResults.noResults:');
        expect(host.textContent).not.toContain('searchResults.incompleteCoverage');
    });

    it('reveals rows inserted below a final group header without another wheel gesture', async () => {
        const state = reactive<ISearchResultsHarnessState>({
            results: [
                match(0, 0),
                match(1, 1),
            ],
            currentResultIndex: -1,
            currentResultNavigationId: 0,
        });
        const {
            host,
            list,
        } = await mountResults(state, 120);
        list.scrollTop = 36;
        list.dispatchEvent(new Event('scroll'));
        await nextTick();

        groupButton(host, 2).click();
        await nextTick();
        await nextTick();

        expect(list.scrollTop).toBe(120);
        expect(host.querySelector(
            '.document-search-result[data-page-number="2"][data-page-match-number="1"]',
        )).not.toBeNull();
    });

    it('does not move the list when an expanded group span already fits', async () => {
        const state = reactive<ISearchResultsHarnessState>({
            results: [
                match(0, 0),
                match(1, 1),
            ],
            currentResultIndex: -1,
            currentResultNavigationId: 0,
        });
        const {
            host,
            list,
        } = await mountResults(state, 240);

        groupButton(host, 2).click();
        await nextTick();
        await nextTick();

        expect(list.scrollTop).toBe(0);
    });

    it('keeps an already visible selected result at its current list position', async () => {
        const state = reactive<ISearchResultsHarnessState>({
            results: [match(0, 0)],
            currentResultIndex: -1,
            currentResultNavigationId: 0,
        });
        const {list} = await mountResults(state, 120);
        list.scrollTop = 12;
        list.dispatchEvent(new Event('scroll'));
        await nextTick();

        state.currentResultIndex = 0;
        state.currentResultNavigationId = 1;
        await nextTick();
        await nextTick();

        expect(list.scrollTop).toBe(12);
    });
});
