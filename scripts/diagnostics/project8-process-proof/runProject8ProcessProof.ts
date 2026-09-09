import {runProject8ProcessProof} from '@scripts/diagnostics/project8-process-proof/project8ProcessProofHarness';

try {
    const evidence = await runProject8ProcessProof();
    console.log(JSON.stringify({
        descendant: {
            exitedAfterProof: evidence.descendantExitedAfterProof,
            pid: evidence.descendant.pid,
            processGroupGoneAfterProof: evidence.descendantProcessGroupGoneAfterProof,
            survivedNativeParentExit: evidence.descendantSurvivedNativeParentExit,
            survivedWorkerExit: evidence.descendantSurvivedWorkerExit,
            wasReparented: evidence.descendantWasReparented,
        },
        fixture: 'project8-process-proof',
        identityMismatchRejected: evidence.identityMismatchRejected,
        nativeParent: {
            exited: evidence.nativeParentExited,
            pgid: evidence.nativeParent.pgid,
            pid: evidence.nativeParent.pid,
        },
        processGroupIdentityProven: evidence.processGroupIdentityProven,
        rootName: evidence.rootName,
        terminationProven: evidence.terminationProven,
        token: evidence.token,
        worker: {
            exited: evidence.workerExited,
            pid: evidence.worker.pid,
        },
    }, null, 2));
} catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
}
