import {
    ref,
    computed,
} from 'vue';
import type {
    ITab,
    TTabUpdate,
} from '@app/types/tabs';

const tabs = ref<ITab[]>([]);
const activeTabId = ref<string | null>(null);

function createEmptyTab(): ITab {
    return {
        id: crypto.randomUUID(),
        fileName: null,
        originalPath: null,
        isDirty: false,
        isDjvu: false,
    };
}

export const useTabManager = () => {
    const activeTab = computed(() =>
        tabs.value.find(t => t.id === activeTabId.value) ?? null,
    );

    function createTab() {
        const tab = createEmptyTab();
        tabs.value.push(tab);
        activeTabId.value = tab.id;
        return tab;
    }

    function ensureAtLeastOneTab() {
        if (tabs.value.length === 0) {
            createTab();
        }
    }

    function activateTab(id: string) {
        if (tabs.value.some(t => t.id === id)) {
            activeTabId.value = id;
        }
    }

    function closeTab(id: string) {
        const index = tabs.value.findIndex(t => t.id === id);
        if (index === -1) {
            return;
        }

        tabs.value.splice(index, 1);

        if (activeTabId.value === id) {
            const next = tabs.value[index] ?? tabs.value[index - 1] ?? null;
            activeTabId.value = next?.id ?? null;
        }

        ensureAtLeastOneTab();
    }

    function updateTab(id: string, updates: TTabUpdate) {
        const tab = tabs.value.find(t => t.id === id);
        if (tab) {
            Object.assign(tab, updates);
        }
    }

    function moveTab(fromIndex: number, toIndex: number) {
        if (
            fromIndex < 0
            || fromIndex >= tabs.value.length
            || toIndex < 0
            || toIndex >= tabs.value.length
            || fromIndex === toIndex
        ) {
            return;
        }
        const removed = tabs.value.splice(fromIndex, 1);
        if (removed[0]) {
            tabs.value.splice(toIndex, 0, removed[0]);
        }
    }

    function getTabById(id: string) {
        return tabs.value.find(t => t.id === id) ?? null;
    }

    return {
        tabs,
        activeTabId,
        activeTab,
        createTab,
        closeTab,
        activateTab,
        updateTab,
        moveTab,
        ensureAtLeastOneTab,
        getTabById,
    };
};
