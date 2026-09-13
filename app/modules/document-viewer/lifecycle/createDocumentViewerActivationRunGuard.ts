export function createDocumentViewerActivationRunGuard(
    isOperational: () => boolean,
) {
    let activeRunId = 0;

    function begin() {
        return ++activeRunId;
    }

    function isCurrent(runId: number) {
        return runId === activeRunId && isOperational();
    }

    return {
        begin,
        invalidate: begin,
        isCurrent,
    };
}
