import {mainJobBroker, type IJobBrokerRunContext} from '@electron/resources/jobBroker';
import {resolvePdfImageCombineResidentBytes} from '@electron/native-tools/pdfImageCombineBudget';

/**
 * Runs one compact DjVu stage under a main broker lease. The task passes the
 * broker run context to each native stage, which then runs under this lease;
 * a stage whose child is not proven gone keeps the lease charged until it is.
 */
export function withCompactDjvuResourceLease<T>(options: {
    jobId: string;
    kind: 'page' | 'combine';
    signal?: AbortSignal;
    task: (brokerRun: IJobBrokerRunContext) => Promise<T>;
}) {
    const isPage = options.kind === 'page';
    return mainJobBroker.run(
        {
            ownerId: options.jobId,
            kind: `djvu-compact-${options.kind}`,
            priority: 'user',
            resources: {
                cpuTokens: 1,
                estimatedResidentBytes: isPage
                    ? 192 * 1024 * 1024
                    : resolvePdfImageCombineResidentBytes(mainJobBroker.getSnapshot().capacity),
                nativeProcesses: 1,
                ioWeight: 2,
            },
            ...(isPage ? {perOwnerLimit: 2} : {}),
            ...(options.signal ? {signal: options.signal} : {}),
        },
        (brokerRun) => options.task(brokerRun),
    );
}
