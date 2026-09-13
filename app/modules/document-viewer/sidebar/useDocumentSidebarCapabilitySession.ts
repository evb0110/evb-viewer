import type {
    ComputedRef,
    Ref,
} from 'vue';
import {
    reconcileDocumentSidebarTab,
    resolveDocumentSidebarTabs,
    type IDocumentSidebarCapabilities,
    type TDocumentSidebarTab,
} from '@app/modules/document-viewer/sidebar/documentSidebarTabs';

interface IUseDocumentSidebarCapabilitySessionOptions {
    capabilities: ComputedRef<IDocumentSidebarCapabilities>;
    capabilitiesReady: ComputedRef<boolean>;
    preferredTab: Ref<TDocumentSidebarTab>;
}

/**
 * Keeps user preference separate from the effective tab allowed by a format.
 * A temporary capability loss (for example PDF annotations while viewing DjVu)
 * must not destructively rewrite the shared workspace preference.
 */
export const useDocumentSidebarCapabilitySession = (
    options: IUseDocumentSidebarCapabilitySessionOptions,
) => {
    const availableTabs = computed(() => (
        options.capabilitiesReady.value
            ? resolveDocumentSidebarTabs(options.capabilities.value)
            : []
    ));
    /**
     * Clamped to what the format actually offers, so no panel is ever opened
     * for a capability the source does not have. `null` is the honest answer
     * while readiness is pending and for a settled source with no sidebar
     * capability at all: falling back to the raw preference there would show a
     * tab as active over an empty content area. The preference is only read,
     * never rewritten, so it is re-adopted as soon as its capability returns.
     */
    const effectiveTab = computed<TDocumentSidebarTab | null>(() => (
        reconcileDocumentSidebarTab(options.preferredTab.value, availableTabs.value)
    ));

    function select(tab: TDocumentSidebarTab) {
        if (availableTabs.value.includes(tab)) options.preferredTab.value = tab;
    }

    return {
        availableTabs,
        effectiveTab,
        select,
    };
};
