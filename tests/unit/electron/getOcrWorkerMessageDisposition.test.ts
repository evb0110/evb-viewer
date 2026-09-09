import {
    describe,
    expect,
    it,
} from 'vitest';
import { getOcrWorkerMessageDisposition } from '@electron/features/ocr/main/getOcrWorkerMessageDisposition';

describe('getOcrWorkerMessageDisposition', () => {
    it('classifies stale worker messages before the manager mutates job state', () => {
        expect(getOcrWorkerMessageDisposition({
            incomingJobId: 'job-1',
            expectedRequestId: 'job-1',
            isCurrentWorker: true,
        })).toEqual({ accepted: true });

        expect(getOcrWorkerMessageDisposition({
            incomingJobId: 'job-other',
            expectedRequestId: 'job-1',
            isCurrentWorker: true,
        })).toEqual({
            accepted: false,
            reason: 'mismatched-job-id',
        });

        expect(getOcrWorkerMessageDisposition({
            incomingJobId: 'job-1',
            expectedRequestId: 'job-1',
            isCurrentWorker: false,
        })).toEqual({
            accepted: false,
            reason: 'inactive-worker',
        });

        expect(getOcrWorkerMessageDisposition({
            incomingJobId: 'job-1',
            expectedRequestId: 'job-1',
            isCurrentWorker: true,
            terminalResultSent: true,
            rejectAfterTerminalResult: true,
        })).toEqual({
            accepted: false,
            reason: 'terminal-result-already-sent',
        });
    });
});
