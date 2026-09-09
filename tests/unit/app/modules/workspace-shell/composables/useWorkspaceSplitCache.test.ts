import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { ref } from 'vue';
import { requireDocumentRef } from '@contracts/documentRef';
import { requireSessionId } from '@contracts/shared';

const stateStore = new Map<string, ReturnType<typeof ref>>();

function installUseStateStub() {
    vi.stubGlobal('useState', <T>(key: string, init: () => T) => {
        const existing = stateStore.get(key);
        if (existing) {
            return existing;
        }
        const state = ref(init());
        stateStore.set(key, state);
        return state;
    });
}

async function createSplitCache() {
    const { useWorkspaceSplitCache } = await import('@app/modules/workspace-shell/composables/useWorkspaceSplitCache');
    return useWorkspaceSplitCache();
}

describe('useWorkspaceSplitCache', {timeout: 20_000}, () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
        vi.resetModules();
        stateStore.clear();
        installUseStateStub();
    });

    it('returns true for a fresh entry and consumes it once', async () => {
        const splitCache = await createSplitCache();

        splitCache.set('tab-1', {
            kind: 'pdfSnapshot',
            fileName: 'sample.pdf',
            originalPath: requireDocumentRef('/tmp/sample.pdf'),
            snapshotPath: requireDocumentRef('/tmp/pdf-work-test/sample.pdf'),
            isDirty: false,
            currentPage: 7,
        });

        expect(splitCache.has('tab-1')).toBe(true);
        expect(splitCache.consume('tab-1')).toEqual(expect.objectContaining({
            kind: 'pdfSnapshot',
            fileName: 'sample.pdf',
            currentPage: 7,
        }));
        expect(splitCache.has('tab-1')).toBe(false);
    });

    it('preserves generated and ordinary dirty PDF markers across a cache remount', async () => {
        const splitCache = await createSplitCache();
        const generatedPayload = {
            kind: 'pdfSnapshot' as const,
            fileName: 'generated.pdf',
            originalPath: requireDocumentRef('/tmp/source.pdf'),
            snapshotPath: requireDocumentRef('/tmp/generated-working.pdf'),
            isDirty: true,
            isGenerated: true,
        };
        const ordinaryDirtyPayload = {
            kind: 'pdfSnapshot' as const,
            fileName: 'ordinary.pdf',
            originalPath: requireDocumentRef('/tmp/source-ordinary.pdf'),
            snapshotPath: requireDocumentRef('/tmp/ordinary-working.pdf'),
            isDirty: true,
        };

        splitCache.set('tab-generated', generatedPayload);
        splitCache.set('tab-ordinary', ordinaryDirtyPayload);

        expect(splitCache.peek('tab-generated')?.payload).toEqual(generatedPayload);
        expect(splitCache.peek('tab-ordinary')?.payload).toEqual(ordinaryDirtyPayload);
        expect(splitCache.consume('tab-generated')).toEqual(generatedPayload);
        expect(splitCache.consume('tab-ordinary')).toEqual(ordinaryDirtyPayload);
    });

    it('treats expired entries as missing from has()', async () => {
        const splitCache = await createSplitCache();

        splitCache.set('tab-expired', {
            kind: 'djvu',
            sourcePath: requireDocumentRef('/tmp/doc.djvu'),
        });

        vi.advanceTimersByTime(2 * 60 * 1000 + 1);

        expect(splitCache.has('tab-expired')).toBe(false);
        expect(splitCache.consume('tab-expired')).toBeNull();
    });

    it('preserves DjVu paging state in cached split payloads', async () => {
        const splitCache = await createSplitCache();

        splitCache.set('tab-djvu', {
            kind: 'djvu',
            sourcePath: requireDocumentRef('/tmp/doc.djvu'),
            currentPage: 12,
            totalPages: 40,
        });

        expect(splitCache.consume('tab-djvu')).toEqual({
            kind: 'djvu',
            sourcePath: requireDocumentRef('/tmp/doc.djvu'),
            currentPage: 12,
            totalPages: 40,
        });
    });

    it('refuses entries when an expected session revision does not match', async () => {
        const splitCache = await createSplitCache();
        const session = {
            sessionId: requireSessionId('session-1'),
            sessionRevision: 2,
            documentRef: requireDocumentRef('/tmp/sample.pdf'),
        };

        splitCache.set('tab-session', {
            kind: 'pdfSnapshot',
            fileName: 'sample.pdf',
            originalPath: requireDocumentRef('/tmp/sample.pdf'),
            snapshotPath: requireDocumentRef('/tmp/pdf-work-test/sample.pdf'),
            isDirty: false,
        }, {session});

        expect(splitCache.has('tab-session', {session})).toBe(true);
        expect(splitCache.peek('tab-session', {session: {
            ...session,
            sessionRevision: 3,
        }})).toBeNull();
        expect(splitCache.consume('tab-session', undefined, {session: {
            ...session,
            sessionRevision: 3,
        }})).toBeNull();
        expect(splitCache.consume('tab-session', undefined, {session})).toEqual(expect.objectContaining({
            kind: 'pdfSnapshot',
            fileName: 'sample.pdf',
        }));
    });
});
