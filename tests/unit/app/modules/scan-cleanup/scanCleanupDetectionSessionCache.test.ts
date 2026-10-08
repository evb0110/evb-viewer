import {
    afterEach,
    describe,
    expect,
    it,
} from 'vitest';
import {requireEpochMs} from '@contracts/timestamps';
import {requireJobId} from '@contracts/shared';
import {
    createScanCleanupDetectionSessionCache,
    discardScanCleanupDetectionStateForAliases,
    isScanCleanupLifecycleIdentityPromotion,
    promoteScanCleanupDetectionState,
    retireSupersededScanCleanupDetectionState,
    scanCleanupAutoDetectionCanceledDocuments,
    scanCleanupDetectionSessionCache,
} from '@app/modules/scan-cleanup/runtime/scanCleanupDetectionSessionCache';

function entry(ownerId = 'owner') {
    return {
        ownerId,
        signatures: new Map<number, string>(),
        state: {
            jobId: requireJobId('detect-1'),
            status: 'completed' as const,
            progress: {
                stage: 'detecting' as const,
                completedUnits: 1,
                totalUnits: 1,
                percent: 100,
                completedPageNumbers: [1],
            },
            results: [],
            updatedAtMs: requireEpochMs(0),
        },
        totalPages: 1,
    };
}

afterEach(() => {
    scanCleanupDetectionSessionCache.clear();
    scanCleanupAutoDetectionCanceledDocuments.clear();
});

describe('scan cleanup detection session cache', () => {
    it('uses reads as LRU touches before enforcing the entry count budget', () => {
        const cache = createScanCleanupDetectionSessionCache({
            maxEntries: 2,
            maxBytes: 10_000,
        });
        cache.set('/one.pdf\u0000rev', entry());
        cache.set('/two.pdf\u0000rev', entry());
        expect(cache.get('/one.pdf\u0000rev')).toBeDefined();

        cache.set('/three.pdf\u0000rev', entry());

        expect([...cache.keys()]).toEqual([
            '/one.pdf\u0000rev',
            '/three.pdf\u0000rev',
        ]);
        expect(cache.bytes).toBeGreaterThan(0);
    });

    it('does not retain an entry that exceeds the byte budget', () => {
        const cache = createScanCleanupDetectionSessionCache({
            maxEntries: 2,
            maxBytes: 128,
        });
        cache.set('/large.pdf\u0000rev', entry('x'.repeat(1_024)));

        expect(cache.size).toBe(0);
        expect(cache.bytes).toBe(0);
    });

    it('keeps only the current revision for a document', () => {
        const cache = createScanCleanupDetectionSessionCache({
            maxEntries: 2,
            maxBytes: 10_000,
        });
        cache.set('/revision.pdf\u0000old', entry());
        cache.set('/revision.pdf\u0000new', entry());

        expect([...cache.keys()]).toEqual(['/revision.pdf\u0000new']);
    });

    it('retires prior revisions and their canceled-auto-detection state', () => {
        scanCleanupDetectionSessionCache.set('/revision.pdf\u0000old', entry());
        scanCleanupDetectionSessionCache.set('/other.pdf\u0000old', entry());
        scanCleanupAutoDetectionCanceledDocuments.add('/revision.pdf\u0000old');
        scanCleanupAutoDetectionCanceledDocuments.add('/other.pdf\u0000old');

        retireSupersededScanCleanupDetectionState('/revision.pdf\u0000new');

        expect(scanCleanupDetectionSessionCache.has('/revision.pdf\u0000old')).toBe(false);
        expect(scanCleanupDetectionSessionCache.has('/other.pdf\u0000old')).toBe(true);
        expect(scanCleanupAutoDetectionCanceledDocuments).toEqual(new Set(['/other.pdf\u0000old']));
    });

    it('promotes a same-path, same-revision cache entry and canceled marker to SHA identity', () => {
        const sourcePath = '/docs/book.pdf';
        const sourceSha256 = 'a'.repeat(64);
        const provisionalLifecycleKey = `${sourcePath}\u0000revision-1`;
        const authoritativeLifecycleKey = `${sourceSha256}\u0000revision-1`;
        const cached = entry('owner-1');
        scanCleanupDetectionSessionCache.set(provisionalLifecycleKey, cached);
        scanCleanupAutoDetectionCanceledDocuments.add(provisionalLifecycleKey);

        expect(promoteScanCleanupDetectionState({
            provisionalLifecycleKey,
            authoritativeLifecycleKey,
            sourcePath,
            sourceSha256,
            documentRevision: 'revision-1',
        })).toBe(true);

        expect(scanCleanupDetectionSessionCache.get(provisionalLifecycleKey)).toBeUndefined();
        expect(scanCleanupDetectionSessionCache.get(authoritativeLifecycleKey)).toBe(cached);
        expect(scanCleanupAutoDetectionCanceledDocuments).toEqual(new Set([authoritativeLifecycleKey]));
    });

    it('does not promote across a changed path or revision', () => {
        const sourcePath = '/docs/book.pdf';
        const sourceSha256 = 'b'.repeat(64);
        const provisionalLifecycleKey = `${sourcePath}\u0000revision-1`;
        const pathChangedAuthoritativeLifecycleKey = `${sourceSha256}\u0000revision-1`;
        const revisionChangedAuthoritativeLifecycleKey = `${sourceSha256}\u0000revision-2`;
        scanCleanupDetectionSessionCache.set(provisionalLifecycleKey, entry());
        scanCleanupAutoDetectionCanceledDocuments.add(provisionalLifecycleKey);

        expect(isScanCleanupLifecycleIdentityPromotion(
            provisionalLifecycleKey,
            pathChangedAuthoritativeLifecycleKey,
            '/docs/other.pdf',
            sourceSha256,
            'revision-1',
        )).toBe(false);
        expect(isScanCleanupLifecycleIdentityPromotion(
            provisionalLifecycleKey,
            revisionChangedAuthoritativeLifecycleKey,
            sourcePath,
            sourceSha256,
            'revision-2',
        )).toBe(false);
        expect(promoteScanCleanupDetectionState({
            provisionalLifecycleKey,
            authoritativeLifecycleKey: revisionChangedAuthoritativeLifecycleKey,
            sourcePath,
            sourceSha256,
            documentRevision: 'revision-2',
        })).toBe(false);

        expect(scanCleanupDetectionSessionCache.has(provisionalLifecycleKey)).toBe(true);
        expect(scanCleanupDetectionSessionCache.has(revisionChangedAuthoritativeLifecycleKey)).toBe(false);
        expect(scanCleanupAutoDetectionCanceledDocuments).toEqual(new Set([provisionalLifecycleKey]));
    });

    it('discards both provisional and authoritative aliases together', () => {
        const sourcePath = '/docs/close.pdf';
        const sourceSha256 = 'c'.repeat(64);
        const provisionalLifecycleKey = `${sourcePath}\u0000revision-1`;
        const authoritativeLifecycleKey = `${sourceSha256}\u0000revision-1`;
        scanCleanupDetectionSessionCache.set(provisionalLifecycleKey, entry());
        scanCleanupDetectionSessionCache.set(authoritativeLifecycleKey, entry());
        scanCleanupAutoDetectionCanceledDocuments.add(provisionalLifecycleKey);
        scanCleanupAutoDetectionCanceledDocuments.add(authoritativeLifecycleKey);

        discardScanCleanupDetectionStateForAliases([
            sourcePath,
            authoritativeLifecycleKey,
        ]);

        expect(scanCleanupDetectionSessionCache.size).toBe(0);
        expect(scanCleanupAutoDetectionCanceledDocuments.size).toBe(0);
    });
});
