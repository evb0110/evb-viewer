import type { TDocumentRef } from '@contracts/documentRef';
import { getDocumentKindFromPath } from '@app/utils/supportedDocumentPaths';

export const usePendingWorkspaceDocumentOpen = (options: {
    isPending: () => boolean;
    path: () => TDocumentRef | null;
}) => {
    const pendingDocumentOpen = computed(options.isPending);
    const pendingDocumentStatusPath = computed<TDocumentRef | null>(() => (
        pendingDocumentOpen.value ? options.path() : null
    ));
    const pendingDjvuDocumentOpen = computed(() => {
        const path = options.path();
        return pendingDocumentOpen.value
            && typeof path === 'string'
            && getDocumentKindFromPath(path) === 'djvu';
    });
    return {
        pendingDjvuDocumentOpen,
        pendingDocumentOpen,
        pendingDocumentStatusPath,
    };
};
