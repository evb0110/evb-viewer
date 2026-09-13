import {
    describe,
    expect,
    it,
} from 'vitest';
import type {Ref} from 'vue';
import type {
    IDocumentSidebarCapabilities,
    TDocumentSidebarTab,
} from '@app/modules/document-viewer/sidebar/documentSidebarTabs';
import {
    DOCUMENT_SIDEBAR_TAB_ORDER,
    reconcileDocumentSidebarTab,
    resolveDocumentSidebarTabs,
} from '@app/modules/document-viewer/sidebar/documentSidebarTabs';
import {useDocumentSidebarCapabilitySession} from '@app/modules/document-viewer/sidebar/useDocumentSidebarCapabilitySession';
import {
    computed,
    ref,
} from 'vue';

function createSession(options: {
    capabilities?: Ref<IDocumentSidebarCapabilities>;
    preferredTab: Ref<TDocumentSidebarTab>;
    ready?: Ref<boolean>;
}) {
    const capabilities = options.capabilities ?? ref({
        annotations: true,
        bookmarks: true,
        pages: true,
        search: true,
    });
    const ready = options.ready ?? ref(true);
    return useDocumentSidebarCapabilitySession({
        capabilities: computed(() => capabilities.value),
        capabilitiesReady: computed(() => ready.value),
        preferredTab: options.preferredTab,
    });
}

describe('document sidebar tabs', () => {
    it('keeps one canonical format-independent order', () => {
        expect(DOCUMENT_SIDEBAR_TAB_ORDER).toEqual([
            'annotations',
            'thumbnails',
            'bookmarks',
            'search',
        ]);
        expect(resolveDocumentSidebarTabs({
            annotations: true,
            bookmarks: true,
            pages: true,
            search: true,
        })).toEqual(DOCUMENT_SIDEBAR_TAB_ORDER);
    });

    it('filters only unavailable domain augmentations without reordering tabs', () => {
        const available = resolveDocumentSidebarTabs({
            annotations: false,
            bookmarks: true,
            pages: true,
            search: true,
        });
        expect(available).toEqual([
            'thumbnails',
            'bookmarks',
            'search',
        ]);
        expect(reconcileDocumentSidebarTab('annotations', available)).toBe('thumbnails');
    });

    it('preserves a preferred PDF augmentation while DjVu exposes a common effective tab', () => {
        const preferredTab = ref<TDocumentSidebarTab>('annotations');
        const ready = ref(false);
        const supportsAnnotations = ref(false);
        const session = useDocumentSidebarCapabilitySession({
            capabilities: computed(() => ({
                annotations: supportsAnnotations.value,
                bookmarks: true,
                pages: true,
                search: true,
            })),
            capabilitiesReady: computed(() => ready.value),
            preferredTab,
        });

        expect(session.effectiveTab.value).toBeNull();
        ready.value = true;
        expect(session.effectiveTab.value).toBe('thumbnails');
        expect(preferredTab.value).toBe('annotations');
        supportsAnnotations.value = true;
        expect(session.effectiveTab.value).toBe('annotations');
    });

    it('names no tab while capability readiness is still pending', () => {
        const preferredTab = ref<TDocumentSidebarTab>('search');
        const session = createSession({
            preferredTab,
            ready: ref(false),
        });

        expect(session.availableTabs.value).toEqual([]);
        expect(session.effectiveTab.value).toBeNull();
        expect(preferredTab.value).toBe('search');
    });

    it('names no tab once readiness settles on a format with no sidebar capability', () => {
        const preferredTab = ref<TDocumentSidebarTab>('bookmarks');
        const capabilities = ref({
            annotations: false,
            bookmarks: false,
            pages: false,
            search: false,
        });
        const session = createSession({
            capabilities,
            preferredTab,
        });

        expect(session.availableTabs.value).toEqual([]);
        expect(session.effectiveTab.value).toBeNull();
        expect(preferredTab.value).toBe('bookmarks');
    });

    it('re-adopts the preference the moment its capability arrives, without a write', () => {
        const preferredTab = ref<TDocumentSidebarTab>('bookmarks');
        const capabilities = ref({
            annotations: false,
            bookmarks: false,
            pages: false,
            search: false,
        });
        const session = createSession({
            capabilities,
            preferredTab,
        });

        expect(session.effectiveTab.value).toBeNull();
        capabilities.value = {
            annotations: false,
            bookmarks: true,
            pages: true,
            search: false,
        };
        expect(session.effectiveTab.value).toBe('bookmarks');
        expect(preferredTab.value).toBe('bookmarks');
    });

    it('leaves a still-available selection alone when an unrelated capability changes', () => {
        const preferredTab = ref<TDocumentSidebarTab>('search');
        const capabilities = ref({
            annotations: true,
            bookmarks: true,
            pages: true,
            search: true,
        });
        const session = createSession({
            capabilities,
            preferredTab,
        });

        expect(session.effectiveTab.value).toBe('search');
        capabilities.value = {
            annotations: false,
            bookmarks: false,
            pages: true,
            search: true,
        };
        expect(session.effectiveTab.value).toBe('search');
        expect(preferredTab.value).toBe('search');
    });

    it('accepts a selection only while its tab is available and never writes an unavailable one', () => {
        const preferredTab = ref<TDocumentSidebarTab>('thumbnails');
        const session = createSession({
            capabilities: ref({
                annotations: false,
                bookmarks: true,
                pages: true,
                search: true,
            }),
            preferredTab,
        });

        session.select('annotations');
        expect(preferredTab.value).toBe('thumbnails');
        expect(session.effectiveTab.value).toBe('thumbnails');
        session.select('bookmarks');
        expect(preferredTab.value).toBe('bookmarks');
        expect(session.effectiveTab.value).toBe('bookmarks');
    });
});
