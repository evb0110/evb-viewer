import {
    describe,
    expect,
    it,
} from 'vitest';
import {runProject8ProcessProof} from '@scripts/diagnostics/project8-process-proof/project8ProcessProofHarness';

describe('Project 8 real process proof fixture', () => {
    it.runIf(process.platform === 'linux')('proves detached descendant survival, identity checks, and tree termination', async () => {
        const evidence = await runProject8ProcessProof();

        expect(evidence.workerExited).toBe(true);
        expect(evidence.nativeParentExited).toBe(true);
        expect(evidence.descendantSurvivedWorkerExit).toBe(true);
        expect(evidence.descendantSurvivedNativeParentExit).toBe(true);
        expect(evidence.descendantWasReparented).toBe(true);
        expect(evidence.processGroupIdentityProven).toBe(true);
        expect(evidence.identityMismatchRejected).toBe(true);
        expect(evidence.terminationProven).toBe(true);
        expect(evidence.descendantExitedAfterProof).toBe(true);
        expect(evidence.descendantProcessGroupGoneAfterProof).toBe(true);
    });
});
