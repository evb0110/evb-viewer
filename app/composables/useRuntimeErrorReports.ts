import type {FailurePresentation} from '@app/composables/useFailureToast';
import type {ILiveDiagnosticLease} from '@app/utils/failureReporter';
import type {FailureReceipt} from '@contracts/diagnostics/failureReceipt';

export interface IRuntimeErrorReport {
    id: string;
    title: string;
    detail: string;
    /** Kept for Copy details, not shown. */
    technicalDetails?: string | undefined;
    source: string;
    count: number;
    occurredAt: number;
    failure: FailureReceipt | null;
    pendingDiagnostic?: ILiveDiagnosticLease | undefined;
}

export const useRuntimeErrorReports = () => {
    const reports = useState<IRuntimeErrorReport[]>('runtime-error-reports', () => []);

    function discardLease(lease: ILiveDiagnosticLease | undefined) {
        lease?.discard();
    }

    function createRetainedReport(
        report: IRuntimeErrorReport,
        existing: IRuntimeErrorReport | undefined,
    ) {
        let pendingDiagnostic = report.pendingDiagnostic;
        if (existing?.pendingDiagnostic?.isLive) {
            if (pendingDiagnostic && pendingDiagnostic !== existing.pendingDiagnostic) {
                discardLease(pendingDiagnostic);
            }
            pendingDiagnostic = existing.pendingDiagnostic;
        } else if (existing?.pendingDiagnostic) {
            discardLease(existing.pendingDiagnostic);
        }

        if (
            pendingDiagnostic
            && reports.value.some(candidate => (
                candidate.id !== existing?.id
                && candidate.pendingDiagnostic?.isLive
            ))
        ) {
            discardLease(pendingDiagnostic);
            pendingDiagnostic = undefined;
        }

        return {
            ...report,
            pendingDiagnostic,
        };
    }

    function addReport(report: IRuntimeErrorReport) {
        const existing = reports.value.find(candidate => candidate.id === report.id);
        if (existing) {
            const retainedReport = createRetainedReport(report, existing);
            const nextReports = [
                {
                    ...existing,
                    ...retainedReport,
                    count: existing.count + 1,
                    occurredAt: Date.now(),
                },
                ...reports.value.filter(candidate => candidate.id !== report.id),
            ].slice(0, 6);
            const retainedEventIds = new Set(
                nextReports
                    .map(candidate => candidate.pendingDiagnostic?.failure.eventId)
                    .filter(Boolean),
            );
            for (const candidate of reports.value) {
                const lease = candidate.pendingDiagnostic;
                if (lease && !retainedEventIds.has(lease.failure.eventId)) {
                    discardLease(lease);
                }
            }
            reports.value = nextReports;
            return;
        }

        const retainedReport = createRetainedReport(report, undefined);
        const nextReports = [
            retainedReport,
            ...reports.value,
        ].slice(0, 6);
        const retainedEventIds = new Set(
            nextReports
                .map(candidate => candidate.pendingDiagnostic?.failure.eventId)
                .filter(Boolean),
        );
        for (const candidate of reports.value) {
            const lease = candidate.pendingDiagnostic;
            if (lease && !retainedEventIds.has(lease.failure.eventId)) {
                discardLease(lease);
            }
        }
        reports.value = nextReports;
    }

    function clearPendingDiagnostic(id: string, expectedLease?: ILiveDiagnosticLease) {
        reports.value = reports.value.map(report => {
            if (
                report.id !== id
                || !report.pendingDiagnostic
                || expectedLease && report.pendingDiagnostic.failure.eventId !== expectedLease.failure.eventId
            ) {
                return report;
            }
            discardLease(report.pendingDiagnostic);
            return {
                ...report,
                pendingDiagnostic: undefined,
            };
        });
    }

    function discardPendingDiagnostics() {
        reports.value = reports.value.map(report => {
            if (!report.pendingDiagnostic) {
                return report;
            }
            discardLease(report.pendingDiagnostic);
            return {
                ...report,
                pendingDiagnostic: undefined,
            };
        });
    }

    function resendPendingDiagnosticOnce() {
        for (const report of reports.value) {
            const lease = report.pendingDiagnostic;
            if (!lease?.isLive) {
                continue;
            }
            if (!lease.resendOnceAfterGrant()) {
                return false;
            }
            clearPendingDiagnostic(report.id, lease);
            return true;
        }
        return false;
    }

    function reportRuntimeError(presentation: FailurePresentation) {
        addReport({
            id: presentation.failure.eventId,
            title: presentation.title,
            detail: presentation.description ?? '',
            technicalDetails: presentation.technicalDetails,
            source: presentation.failure.code,
            count: 1,
            occurredAt: Date.now(),
            failure: presentation.failure,
            pendingDiagnostic: presentation.pendingDiagnostic,
        });
    }

    function dismissRuntimeErrorReport(id: string) {
        const report = reports.value.find(candidate => candidate.id === id);
        discardLease(report?.pendingDiagnostic);
        reports.value = reports.value.filter(report => report.id !== id);
    }

    function clearRuntimeErrorReports() {
        for (const report of reports.value) {
            discardLease(report.pendingDiagnostic);
        }
        reports.value = [];
    }

    return {
        reports,
        reportRuntimeError,
        dismissRuntimeErrorReport,
        clearRuntimeErrorReports,
        discardPendingDiagnostics,
        resendPendingDiagnosticOnce,
    };
};
