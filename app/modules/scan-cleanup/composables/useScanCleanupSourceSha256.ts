import type {TDocumentRef} from '@contracts/documentRef';
import {requireLeaseId} from '@contracts/shared';
import {isScanCleanupSourceSha256} from '@contracts/scan-cleanup/scanCleanupSettings';
import {BrowserLogger} from '@app/utils/browserLogger';
import {getDocumentFilesCapability} from '@app/utils/platformDocuments';
import {isDesktopPlatformActive} from '@app/utils/platform';
import type {Ref} from 'vue';

interface IUseScanCleanupSourceSha256Options {
    enabled: Readonly<Ref<boolean>>;
    sourcePath: Readonly<Ref<TDocumentRef | null>>;
    documentRevision: Readonly<Ref<string | null>>;
}

/**
 * Reads the source hash owned by the desktop document pipeline. The renderer
 * never reads or hashes the document bytes; it only retains the hash returned
 * by the main-process managed-file handle for the current document revision.
 */
export const useScanCleanupSourceSha256 = (options: IUseScanCleanupSourceSha256Options) => {
    const sourceSha256 = ref<string | null>(null);
    let generation = 0;
    let acquiredFor: {
        path: TDocumentRef;
        revision: string | null
    } | null = null;

    async function refresh() {
        const currentGeneration = ++generation;
        const sourcePath = options.sourcePath.value;
        const documentRevision = options.documentRevision.value;
        if (!sourcePath || !isDesktopPlatformActive()) {
            acquiredFor = null;
            sourceSha256.value = null;
            return;
        }
        if (acquiredFor && (acquiredFor.path !== sourcePath || acquiredFor.revision !== documentRevision)) {
            acquiredFor = null;
            sourceSha256.value = null;
        }
        // The hash is a property of the document identity, not of surface
        // visibility: hiding the tab must not demote an acquired identity to
        // the legacy key and reset settings and detection lifecycles. An
        // acquired hash is kept until the path or revision changes.
        if (!options.enabled.value || acquiredFor !== null) {
            return;
        }

        let documentFiles: ReturnType<typeof getDocumentFilesCapability>;
        try {
            documentFiles = getDocumentFilesCapability();
        } catch (error) {
            sourceSha256.value = null;
            BrowserLogger.warn('scan-cleanup', 'Failed to resolve the authoritative source SHA-256 capability', error);
            return;
        }
        const createHandle = documentFiles.createManagedTempFileHandle;
        const releaseHandle = documentFiles.releaseManagedTempFileHandle;
        if (!createHandle || !releaseHandle) {
            sourceSha256.value = null;
            BrowserLogger.warn('scan-cleanup', 'Authoritative source SHA-256 capability is unavailable', () => ({reason: 'missing-managed-file-hash-capability'}));
            return;
        }

        let leaseId: ReturnType<typeof requireLeaseId> | null = null;
        try {
            const handle = await createHandle(sourcePath);
            leaseId = requireLeaseId(handle.leaseId);
            if (
                currentGeneration === generation
                && Boolean(options.enabled.value)
                && options.sourcePath.value === sourcePath
                && options.documentRevision.value === documentRevision
            ) {
                if (isScanCleanupSourceSha256(handle.sha256)) {
                    acquiredFor = {
                        path: sourcePath,
                        revision: documentRevision,
                    };
                    sourceSha256.value = handle.sha256.toLowerCase();
                } else {
                    sourceSha256.value = null;
                    BrowserLogger.warn('scan-cleanup', 'Authoritative source SHA-256 was unavailable for document preferences', () => ({reason: 'invalid-managed-file-hash'}));
                }
            }
        } catch (error) {
            if (currentGeneration === generation) {
                sourceSha256.value = null;
                BrowserLogger.warn('scan-cleanup', 'Failed to resolve the authoritative source SHA-256', error);
            }
        } finally {
            if (leaseId !== null) {
                await releaseHandle(leaseId).catch(error => {
                    BrowserLogger.warn('scan-cleanup', 'Failed to release the source-hash file handle', error);
                });
            }
        }
    }

    watch(
        [
            options.enabled,
            options.sourcePath,
            options.documentRevision,
        ],
        () => { void refresh(); },
        {immediate: true},
    );
    onBeforeUnmount(() => { generation += 1; });

    return computed(() => sourceSha256.value);
};
