import {
    spawn, type ChildProcess,
} from 'node:child_process';
import {once} from 'node:events';
import {
    afterEach,
    describe,
    expect,
    it,
} from 'vitest';
import {
    createOcrNativeChildTerminationController,
    readOcrNativeChildProcessIdentity,
} from '@electron/features/ocr/main/ocrNativeChildProcessIdentity';
import {createDetachedChildProcessSpawnOptions} from '@electron/utils/nativeChildProcess';
import type {IOcrNativeChildRecord} from '@electron/features/ocr/main/jobManager.types';

const liveChildren = new Set<ChildProcess>();

function createChildRecord(child: ChildProcess, processIdentity: NonNullable<Awaited<ReturnType<typeof readOcrNativeChildProcessIdentity>>>): IOcrNativeChildRecord {
    return {
        childId: 'ocr-child:platform-proof',
        commandLabel: 'project8-platform-proof',
        state: 'registered',
        pid: child.pid ?? null,
        processIdentity,
        cleanupAttemptInFlight: false,
    };
}

async function spawnTaskOwnedChild() {
    const child = spawn(process.execPath, [
        '-e',
        'setInterval(() => {}, 1_000);',
    ], createDetachedChildProcessSpawnOptions({
        stdio: 'ignore',
        windowsHide: true,
    }));
    liveChildren.add(child);
    await once(child, 'spawn');
    return child;
}

describe('Project 8 platform process proof', () => {
    afterEach(() => {
        for (const child of liveChildren) {
            if (child.exitCode === null && child.signalCode === null) {
                child.kill();
            }
        }
        liveChildren.clear();
    });

    it('proves normal cancellation, late exit, recovery, and reusable admission on the host OS', async () => {
        const termination = createOcrNativeChildTerminationController();

        const cancelledChild = await spawnTaskOwnedChild();
        const cancelledIdentity = await readOcrNativeChildProcessIdentity(cancelledChild.pid!);
        expect(cancelledIdentity).not.toBeNull();
        expect(cancelledIdentity?.kind).not.toBe('opaque');
        await expect(termination.terminate(
            createChildRecord(cancelledChild, cancelledIdentity!),
            'platform fixture cancellation',
        )).resolves.toBe(true);
        await expect(readOcrNativeChildProcessIdentity(cancelledChild.pid!)).resolves.toBeNull();

        const lateExitChild = await spawnTaskOwnedChild();
        const lateExitIdentity = await readOcrNativeChildProcessIdentity(lateExitChild.pid!);
        expect(lateExitIdentity).not.toBeNull();
        lateExitChild.kill();
        await once(lateExitChild, 'close');
        await expect(readOcrNativeChildProcessIdentity(lateExitChild.pid!)).resolves.toBeNull();
        await expect(termination.terminate(
            createChildRecord(lateExitChild, lateExitIdentity!),
            'platform fixture late exit',
        )).resolves.toBe(false);

        const recoveredChild = await spawnTaskOwnedChild();
        const recoveredIdentity = await readOcrNativeChildProcessIdentity(recoveredChild.pid!);
        expect(recoveredIdentity).not.toBeNull();
        // macOS ps(1) reports lstart at one-second resolution. The late-exit
        // proof above still rejects the dead PID before any cleanup occurs.
        await expect(termination.terminate(
            createChildRecord(recoveredChild, recoveredIdentity!),
            'platform fixture reusable admission',
        )).resolves.toBe(true);
    }, 20_000);
});
