import {discardScanCleanupDetectionStateForAliases} from '@app/modules/scan-cleanup/runtime/scanCleanupDetectionSessionCache';
import {resetScanCleanupDocumentOverrides} from '@app/modules/scan-cleanup/persistence/preferencesRepository';
import {
    invalidateScanCleanupDocumentPersistence,
    saveScanCleanupDocumentPreferencesInStore,
} from '@app/modules/scan-cleanup/runtime/scanCleanupPreferencesStore';

/**
 * Closing the source document discards the split session for a document:
 * in-memory detection restore state and persisted page overrides are dropped,
 * so re-entering starts a fresh detection pass. Document margins and global
 * preferences survive as editing defaults. Desktop preferences live in the
 * main-process settings file keyed by source hash, so the same reset must
 * reach that store too — the browser repository alone only covers the legacy
 * localStorage entry.
 */
export async function discardScanCleanupDocumentState(
    documentKey: string | null | undefined,
    sourceSha256?: string | null,
) {
    if (!documentKey && !sourceSha256) {
        return;
    }
    // Invalidate any debounced component-owned patch before resetting the
    // durable entry. Otherwise scope disposal can flush the old overrides
    // after the close and silently recreate the state that was just discarded.
    invalidateScanCleanupDocumentPersistence(sourceSha256, documentKey);
    discardScanCleanupDetectionStateForAliases([
        documentKey,
        sourceSha256,
    ]);
    if (documentKey) {
        resetScanCleanupDocumentOverrides(documentKey);
    }
    if (sourceSha256) {
        await saveScanCleanupDocumentPreferencesInStore(
            sourceSha256,
            documentKey ?? null,
            {resetOverrides: true},
        );
    }
}
