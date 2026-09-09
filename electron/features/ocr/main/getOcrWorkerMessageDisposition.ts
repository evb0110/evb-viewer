type TOcrWorkerMessageRejectionReason =
    | 'mismatched-job-id'
    | 'inactive-worker'
    | 'terminal-result-already-sent';

interface IOcrWorkerMessageDisposition {
    accepted: boolean;
    reason?: TOcrWorkerMessageRejectionReason;
}

interface IOcrWorkerMessageDispositionInput {
    incomingJobId: string;
    expectedRequestId: string;
    isCurrentWorker: boolean;
    terminalResultSent?: boolean;
    rejectAfterTerminalResult?: boolean;
}

export function getOcrWorkerMessageDisposition({
    incomingJobId,
    expectedRequestId,
    isCurrentWorker,
    terminalResultSent = false,
    rejectAfterTerminalResult = false,
}: IOcrWorkerMessageDispositionInput): IOcrWorkerMessageDisposition {
    if (incomingJobId !== expectedRequestId) {
        return {
            accepted: false,
            reason: 'mismatched-job-id',
        };
    }
    if (!isCurrentWorker) {
        return {
            accepted: false,
            reason: 'inactive-worker',
        };
    }
    if (rejectAfterTerminalResult && terminalResultSent) {
        return {
            accepted: false,
            reason: 'terminal-result-already-sent',
        };
    }
    return { accepted: true };
}
