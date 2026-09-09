import { randomUUID } from 'node:crypto';
import {readFile} from 'node:fs/promises';
import { terminateProcessTree } from '@electron/utils/processTree';
import { shouldUseDetachedProcessGroup } from '@electron/utils/nativeChildProcess';
import { parseIntegerEnv } from '@electron/utils/parseIntegerEnv';
import type {IOcrNativeChildProcessIdentity} from '@electron/ocr/worker/types';
import type { IOcrNativeChildRecord } from '@electron/features/ocr/main/jobManager.types';

const OCR_NATIVE_CHILD_KILL_GRACE_MS = parseIntegerEnv(
    'EVB_OCR_NATIVE_CHILD_KILL_GRACE_MS',
    2_000,
    250,
);

function parseLinuxProcStartTime(statText: string) {
    const commandEnd = statText.lastIndexOf(')');
    if (commandEnd < 0) {
        return null;
    }
    const fieldsAfterCommand = statText.slice(commandEnd + 1).trim().split(/\s+/u);
    const startTime = fieldsAfterCommand[19];
    return startTime && /^\d+$/u.test(startTime) ? startTime : null;
}

/**
 * Linux gives us a PID reuse guard. Other supported platforms get an opaque
 * worker-generated token, which the main process deliberately cannot validate
 * after a worker crash.
 */
export async function readOcrNativeChildProcessIdentity(
    pid: number,
): Promise<IOcrNativeChildProcessIdentity | null> {
    if (!Number.isSafeInteger(pid) || pid <= 0) {
        return null;
    }
    if (process.platform !== 'linux') {
        return {
            kind: 'opaque',
            value: `${process.platform}:${pid}:${randomUUID()}`,
        };
    }

    try {
        const statText = await readFile(`/proc/${pid}/stat`, 'utf8');
        const startTime = parseLinuxProcStartTime(statText);
        return startTime === null
            ? null
            : {
                kind: 'linux-proc-start-time',
                value: startTime,
            };
    } catch {
        return null;
    }
}

export interface IOcrNativeChildTerminationController {terminate(record: IOcrNativeChildRecord, reason: string): Promise<boolean>;}

export function createOcrNativeChildTerminationController(): IOcrNativeChildTerminationController {
    return {async terminate(record) {
        if (
            (record.state !== 'registered' && record.state !== 'unproven')
                || record.pid === null
                || record.processIdentity?.kind !== 'linux-proc-start-time'
        ) {
            return false;
        }

        const before = await readOcrNativeChildProcessIdentity(record.pid);
        if (
            before === null
                || before.kind !== record.processIdentity.kind
                || before.value !== record.processIdentity.value
        ) {
            return false;
        }

        const terminated = await terminateProcessTree(record.pid, {
            graceMs: OCR_NATIVE_CHILD_KILL_GRACE_MS,
            platform: process.platform,
            preferProcessGroup: shouldUseDetachedProcessGroup(),
        });
        if (!terminated) {
            return false;
        }

        // A successful signal request is not enough. Re-read the identity
        // so a reused PID, or a still-running child, fails closed.
        const after = await readOcrNativeChildProcessIdentity(record.pid);
        return after === null;
    }};
}
