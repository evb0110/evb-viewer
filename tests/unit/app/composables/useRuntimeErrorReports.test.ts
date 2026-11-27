import {beforeEach, describe, expect, it, vi} from 'vitest';
import {ref} from 'vue';
import type {FailureReceipt} from '@contracts/diagnostics/failureReceipt';
import {requireEpochMs} from '@contracts/timestamps';

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

async function createReports() {
    const {useRuntimeErrorReports} = await import('@app/composables/useRuntimeErrorReports');
    return useRuntimeErrorReports();
}

function createFailure(eventId: string): FailureReceipt {
    return {
        eventId: eventId as FailureReceipt['eventId'],
        code: 'UNCLASSIFIED_RENDERER_ERROR',
        occurredAt: requireEpochMs(Date.now()),
        severity: 'error',
    };
}

function createLease(eventId: string) {
    let live = true;
    let resendCount = 0;
    let discardCount = 0;
    const lease = {
        failure: createFailure(eventId),
        get isLive() {
            return live;
        },
        resendOnceAfterGrant() {
            if (!live) {
                return false;
            }
            live = false;
            resendCount += 1;
            return true;
        },
        discard() {
            live = false;
            discardCount += 1;
        },
    };
    return {
        lease,
        get discardCount() {
            return discardCount;
        },
        get resendCount() {
            return resendCount;
        },
    };
}

describe('useRuntimeErrorReports', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
        vi.resetModules();
        stateStore.clear();
        installUseStateStub();
    });

    it('deduplicates by receipt and keeps the latest detail', async () => {
        const reports = await createReports();
        const failure = createFailure('77777777777777777777777777777777');

        reports.reportRuntimeError({
            failure,
            title: 'Application warning',
            description: '2026-01-01T00:00:00.000Z\n[WARN] rejected path',
        });
        reports.reportRuntimeError({
            failure,
            title: 'Application warning',
            description: '2026-01-01T00:00:01.000Z\n[WARN] rejected path',
        });

        expect(reports.reports.value).toHaveLength(1);
        expect(reports.reports.value[0]).toMatchObject({
            count: 2,
            detail: '2026-01-01T00:00:01.000Z\n[WARN] rejected path',
        });
    });

    it('deduplicates receipt-aware presentations by their event ID', async () => {
        const reports = await createReports();
        const failure = createFailure('0123456789abcdef0123456789abcdef');

        reports.reportRuntimeError({
            failure,
            title: 'Renderer failure',
            description: 'The document could not be opened.',
        });
        reports.reportRuntimeError({
            failure,
            title: 'Renderer failure',
            description: 'The document could not be opened again.',
        });

        expect(reports.reports.value).toHaveLength(1);
        expect(reports.reports.value[0]).toMatchObject({
            id: failure.eventId,
            count: 2,
            detail: 'The document could not be opened again.',
            failure,
            source: failure.code,
        });
    });

    it('retains one live lease across receipt deduplication and resends it once', async () => {
        const reports = await createReports();
        const firstLease = createLease('11111111111111111111111111111111');
        const replacementLease = createLease('11111111111111111111111111111111');
        const failure = firstLease.lease.failure;

        reports.reportRuntimeError({
            failure,
            pendingDiagnostic: firstLease.lease,
            title: 'Renderer failure',
            description: 'First detail',
        });
        reports.reportRuntimeError({
            failure,
            pendingDiagnostic: replacementLease.lease,
            title: 'Renderer failure',
            description: 'Latest detail',
        });

        expect(firstLease.discardCount).toBe(0);
        expect(replacementLease.discardCount).toBe(1);
        expect(reports.reports.value[0]?.pendingDiagnostic).toBeDefined();
        expect(reports.resendPendingDiagnosticOnce()).toBe(true);
        expect(firstLease.resendCount).toBe(1);
        expect(firstLease.discardCount).toBe(1);
        expect(reports.reports.value[0]?.pendingDiagnostic).toBeUndefined();
        expect(reports.resendPendingDiagnosticOnce()).toBe(false);
    });

    it('disposes a live lease on dismissal, clear, and capacity eviction', async () => {
        const reports = await createReports();
        const dismissedLease = createLease('22222222222222222222222222222222');
        reports.reportRuntimeError({
            failure: dismissedLease.lease.failure,
            pendingDiagnostic: dismissedLease.lease,
            title: 'Dismissed',
            description: 'dismiss me',
        });
        reports.dismissRuntimeErrorReport(dismissedLease.lease.failure.eventId);
        expect(dismissedLease.discardCount).toBe(1);

        const clearedLease = createLease('33333333333333333333333333333333');
        reports.reportRuntimeError({
            failure: clearedLease.lease.failure,
            pendingDiagnostic: clearedLease.lease,
            title: 'Cleared',
            description: 'clear me',
        });
        reports.clearRuntimeErrorReports();
        expect(clearedLease.discardCount).toBe(1);

        const evictedLease = createLease('44444444444444444444444444444444');
        reports.reportRuntimeError({
            failure: evictedLease.lease.failure,
            pendingDiagnostic: evictedLease.lease,
            title: 'Evicted',
            description: 'evict me',
        });
        for (let index = 0; index < 6; index += 1) {
            reports.reportRuntimeError({
                failure: createFailure(index.toString(16).padStart(32, '0')),
                title: `Report ${index}`,
                description: `detail ${index}`,
            });
        }
        expect(evictedLease.discardCount).toBe(1);
    });

    it('keeps main-owned receipt projections lease-free', async () => {
        const reports = await createReports();
        const failure = createFailure('55555555555555555555555555555555');

        reports.reportRuntimeError({
            failure,
            title: 'Main failure',
            description: 'Already captured by the main process',
        });

        expect(reports.reports.value[0]?.pendingDiagnostic).toBeUndefined();
    });

    it('does not resend after dismissal while grant persistence is pending', async () => {
        const reports = await createReports();
        const pending = createLease('66666666666666666666666666666666');
        let resolveSave!: (saved: boolean) => void;
        const savePromise = new Promise<boolean>((resolve) => {
            resolveSave = resolve;
        });

        reports.reportRuntimeError({
            failure: pending.lease.failure,
            pendingDiagnostic: pending.lease,
            title: 'Renderer failure',
            description: 'Dismiss before save settles',
        });
        const grant = (async () => {
            if (await savePromise) {
                reports.resendPendingDiagnosticOnce();
            }
        })();
        reports.dismissRuntimeErrorReport(pending.lease.failure.eventId);
        resolveSave(true);
        await grant;

        expect(pending.resendCount).toBe(0);
        expect(pending.discardCount).toBe(1);
    });

    it('dismisses one report without clearing the rest', async () => {
        const reports = await createReports();
        const first = createFailure('88888888888888888888888888888888');
        const second = createFailure('99999999999999999999999999999999');

        reports.reportRuntimeError({
            failure: first,
            title: 'First',
            description: 'one',
        });
        reports.reportRuntimeError({
            failure: second,
            title: 'Second',
            description: 'two',
        });
        reports.dismissRuntimeErrorReport(second.eventId);

        expect(reports.reports.value.map((report) => report.title)).toEqual(['First']);
    });
});
