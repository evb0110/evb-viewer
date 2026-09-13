import {vi} from 'vitest';
import {
    createApp,
    defineComponent,
    nextTick,
    ref,
} from 'vue';
import type {
    App,
    VNode,
} from 'vue';
import type {IDocumentSearchSession} from '@app/modules/document-viewer/search/documentSearch';

/**
 * Shared mounting machinery for the source sidebar: an inert search session,
 * a host element the sidebar can render into, and the settle steps a sidebar
 * whose capabilities resolve asynchronously needs before its DOM is worth
 * reading.
 *
 * Scenarios keep their own component stubs and assertions; this file only puts
 * the sidebar on screen and takes it back off again.
 */

export interface IMountedDocumentSidebarHost {
    host: HTMLElement;
    unmount: () => void;
}

const mounted = new Set<() => void>();

/**
 * A search session that answers every question with an empty result and
 * records nothing but the calls themselves. The sidebar only forwards this
 * object to its search panel, so no scenario here needs it to search.
 */
export function createDocumentSearchSessionDouble(): IDocumentSearchSession {
    return {
        query: ref(''),
        submittedQuery: ref(''),
        options: ref({
            matchCase: false,
            wholeWord: false,
            useRegex: false,
        }),
        results: ref([]),
        currentResultIndex: ref(-1),
        currentResultNavigationId: ref(0),
        isSearching: ref(false),
        error: ref(null),
        progress: ref(undefined),
        isTruncated: ref(false),
        minQueryLength: ref(2),
        setQuery: vi.fn(),
        setOptions: vi.fn(),
        run: vi.fn(async () => false),
        clear: vi.fn(),
        cancel: vi.fn(),
        select: vi.fn(() => false),
        navigate: vi.fn(() => false),
    };
}

/**
 * Mounts `render` into a fresh host attached to the document and lets Vue's
 * queue drain, so what a scenario reads is the sidebar's settled DOM rather
 * than the first synchronous render. Capability resolution is promise-based,
 * so one render turn is a deterministic wait for it; a clock-based wait would
 * settle the same state only by accident of scheduler ordering. The returned
 * `unmount` is also registered with the harness, so a scenario that never
 * calls it is still cleaned up by `unmountDocumentSidebarHosts`.
 */
export async function mountDocumentSidebarHost(
    render: () => VNode,
    configureApp?: (app: App) => void,
): Promise<IMountedDocumentSidebarHost> {
    const host = document.createElement('div');
    document.body.append(host);
    const app = createApp(defineComponent({setup: () => render}));
    configureApp?.(app);
    app.mount(host);
    await nextTick();
    const unmount = () => {
        app.unmount();
        host.remove();
        mounted.delete(unmount);
    };
    mounted.add(unmount);
    return {
        host,
        unmount,
    };
}

/** Unmounts every sidebar this harness mounted. */
export function unmountDocumentSidebarHosts() {
    for (const unmount of [...mounted]) unmount();
}
