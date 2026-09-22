import { getErrorMessage } from '@app/utils/error';
import type { Ref } from 'vue';
import type { IDocumentPageSource } from '@app/modules/document-viewer/source/documentPageSource';
import {
    createDocumentBookmarkTree,
    findDocumentBookmark,
    getDocumentBookmarkActivePath,
    isDocumentBookmarkExpanded,
    type IDocumentBookmarkTreeItem,
    type TDocumentBookmarkDisplayMode,
    type TDocumentBookmarkStatus,
} from '@app/modules/document-viewer/bookmarks/documentBookmarks';

interface IUseDocumentBookmarkSessionOptions {
    source: Readonly<Ref<IDocumentPageSource | null>>;
    currentPage: Readonly<Ref<number>>;
    isActive: Readonly<Ref<boolean>>;
}

export const useDocumentBookmarkSession = (options: IUseDocumentBookmarkSessionOptions) => {
    const items = ref<IDocumentBookmarkTreeItem[]>([]);
    const isLoading = ref(false);
    const error = ref<string | null>(null);
    const displayMode = ref<TDocumentBookmarkDisplayMode>('current-expanded');
    const expandedIds = ref<Set<string>>(new Set());
    let controller: AbortController | null = null;
    let sourceGeneration = 0;

    const status = computed<TDocumentBookmarkStatus>(() => {
        if (isLoading.value) {
            return 'loading';
        }
        if (error.value !== null) {
            return 'error';
        }
        return items.value.length === 0 ? 'empty' : 'ready';
    });
    const activePath = computed(() => getDocumentBookmarkActivePath(items.value, options.currentPage.value));
    const activeId = computed(() => activePath.value.at(-1) ?? null);
    const activePathIds = computed(() => new Set(activePath.value));

    function cancel() {
        controller?.abort();
        controller = null;
        isLoading.value = false;
    }

    async function load() {
        const source = options.source.value;
        const provider = source?.outlineProvider;
        if (!source || !provider || !options.isActive.value) {
            return;
        }

        cancel();
        const runController = new AbortController();
        const generation = sourceGeneration;
        controller = runController;
        isLoading.value = true;
        error.value = null;
        try {
            const outline = await provider.getOutline(runController.signal);
            if (options.source.value === source && generation === sourceGeneration) {
                items.value = createDocumentBookmarkTree(outline);
            }
        } catch (reason) {
            if (!runController.signal.aborted) {
                error.value = getErrorMessage(reason);
            }
        } finally {
            if (controller === runController) {
                controller = null;
                isLoading.value = false;
            }
        }
    }

    function setDisplayMode(mode: TDocumentBookmarkDisplayMode) {
        displayMode.value = mode;
        if (mode === 'top-level') expandedIds.value = new Set();
    }

    function toggleExpanded(id: string) {
        const wasExpanded = isDocumentBookmarkExpanded(id, {
            displayMode: displayMode.value,
            expandedIds: expandedIds.value,
            activePathIds: activePathIds.value,
        });
        if (displayMode.value !== 'top-level') displayMode.value = 'top-level';
        const next = new Set(expandedIds.value);
        if (wasExpanded) next.delete(id);
        else next.add(id);
        expandedIds.value = next;
    }

    function getPageNumber(id: string) {
        return findDocumentBookmark(items.value, id)?.pageNumber ?? null;
    }

    watch(options.source, () => {
        sourceGeneration += 1;
        cancel();
        items.value = [];
        error.value = null;
        expandedIds.value = new Set();
        if (options.isActive.value) void nextTick(load);
    }, {flush: 'post'});
    watch(options.isActive, (active) => {
        if (active) void load();
        else cancel();
    }, {immediate: true});
    onScopeDispose(cancel);

    return {
        activeId,
        activePathIds,
        displayMode,
        error,
        expandedIds,
        getPageNumber,
        isLoading,
        items,
        load,
        setDisplayMode,
        status,
        toggleExpanded,
    };
};
