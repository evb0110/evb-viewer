import type { TDocumentRef } from '@contracts/documentRef';
import { getDocumentKindFromPath } from '@app/utils/supportedDocumentPaths';
import {isWorkspaceDocumentType} from '@app/modules/workspace-shell/viewers/workspaceDocumentDriver';

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
        const documentKind = typeof path === 'string' ? getDocumentKindFromPath(path) : null;
        return pendingDocumentOpen.value
            && documentKind !== null
            && isWorkspaceDocumentType(documentKind, 'djvu');
    });
    return {
        pendingDjvuDocumentOpen,
        pendingDocumentOpen,
        pendingDocumentStatusPath,
    };
};
