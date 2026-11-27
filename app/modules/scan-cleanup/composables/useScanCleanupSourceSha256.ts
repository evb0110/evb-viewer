import type {TDocumentRef} from '@contracts/documentRef';
import {requireLeaseId} from '@contracts/shared';
import {isScanCleanupSourceSha256} from '@contracts/scan-cleanup/scanCleanupSettings';
import {BrowserLogger} from '@app/utils/browserLogger';
import {getDocumentFilesCapability} from '@app/utils/platformDocuments';
import {isDesktopPlatformActive} from '@app/utils/platform';
import type {InjectionKey, Ref} from 'vue';

/**
 * Where the authoritative hash stands. Desktop document settings are keyed by
 * it, so they wait while it is `pending` and report `failed` with a retry.
 */
export type TScanCleanupSourceIdentityState = 'unavailable' | 'pending' | 'ready' | 'failed';

export interface IScanCleanupSourceIdentity {
    state: Readonly<Ref<TScanCleanupSourceIdentityState>>;
    retry: () => void;
}

export const scanCleanupSourceIdentityKey: InjectionKey<IScanCleanupSourceIdentity> = Symbol('scan-cleanup-source-identity');

interface IUseScanCleanupSourceSha256Options {
    enabled: Readonly<Ref<boolean>>;
    sourcePath: Readonly<Ref<TDocumentRef | null>>;
    documentRevision: Readonly<Ref<string | null>>;
    /** Where the document keeps the hash; the document clears it when its bytes change. */
    sha256: Ref<string | null>;
}

/**
 * Reads the source hash owned by the desktop document pipeline. The renderer
 * never reads or hashes the document bytes; it only retains the hash returned
 * by the main-process managed-file handle for the current document revision.
 * The document keeps the hash, so it outlives its views and this reader;
 * each view provides the acquisition state to its Scan cleanup workspace.
 */
export const useScanCleanupSourceSha256 = (options: IUseScanCleanupSourceSha256Options) => {
    const state = ref<TScanCleanupSourceIdentityState>('unavailable');
    let generation = 0;

    async function refresh() {
        const currentGeneration = ++generation;
        const sourcePath = options.sourcePath.value;
        const documentRevision = options.documentRevision.value;
        if (!sourcePath || !isDesktopPlatformActive()) {
            state.value = 'unavailable';
            return;
        }
        // The hash is a property of the document identity, not of surface
        // visibility: hiding the tab must not demote an acquired identity to
        // the legacy key and reset settings and detection lifecycles. An
        // acquired hash is kept until the path or revision changes.
        if (options.sha256.value !== null) {
            state.value = 'ready';
            return;
        }
        if (state.value === 'ready') {
            state.value = 'unavailable';
        }
        if (!options.enabled.value) {
            return;
        }

        let documentFiles: ReturnType<typeof getDocumentFilesCapability>;
        try {
            documentFiles = getDocumentFilesCapability();
        } catch (error) {
            state.value = 'failed';
            BrowserLogger.warn('scan-cleanup', 'Failed to resolve the authoritative source SHA-256 capability', error);
            return;
        }
        const createHandle = documentFiles.createManagedTempFileHandle;
        const releaseHandle = documentFiles.releaseManagedTempFileHandle;
        if (!createHandle || !releaseHandle) {
            state.value = 'failed';
            BrowserLogger.warn('scan-cleanup', 'Authoritative source SHA-256 capability is unavailable', () => ({
                reason: 'missing-managed-file-hash-capability',
            }));
            return;
        }
        state.value = 'pending';

        let leaseId: ReturnType<typeof requireLeaseId> | null = null;
        try {
            const handle = await createHandle(sourcePath);
            leaseId = requireLeaseId(handle.leaseId);
            if (
                currentGeneration === generation &&
                Boolean(options.enabled.value) &&
                options.sourcePath.value === sourcePath &&
                options.documentRevision.value === documentRevision
            ) {
                if (isScanCleanupSourceSha256(handle.sha256)) {
                    options.sha256.value = handle.sha256.toLowerCase();
                    state.value = 'ready';
                } else {
                    state.value = 'failed';
                    BrowserLogger.warn('scan-cleanup', 'Authoritative source SHA-256 was unavailable for document preferences', () => ({
                        reason: 'invalid-managed-file-hash',
                    }));
                }
            }
        } catch (error) {
            if (currentGeneration === generation) {
                state.value = 'failed';
                BrowserLogger.warn('scan-cleanup', 'Failed to resolve the authoritative source SHA-256', error);
            }
        } finally {
            if (leaseId !== null) {
                await releaseHandle(leaseId).catch((error) => {
                    BrowserLogger.warn('scan-cleanup', 'Failed to release the source-hash file handle', error);
                });
            }
        }
    }

    watch(
        [options.enabled, options.sourcePath, options.documentRevision],
        () => {
            void refresh();
        },
        {immediate: true},
    );
    onScopeDispose(() => {
        generation += 1;
    });

    return {
        sha256: computed(() => options.sha256.value),
        identity: {
            state,
            retry: () => {
                void refresh();
            },
        } satisfies IScanCleanupSourceIdentity,
    };
};
