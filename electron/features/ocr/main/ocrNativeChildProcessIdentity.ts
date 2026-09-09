import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import {readFile} from 'node:fs/promises';
import { promisify } from 'node:util';
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

const execFileAsync = promisify(execFile);

function parseLinuxProcStartTime(statText: string) {
    const commandEnd = statText.lastIndexOf(')');
    if (commandEnd < 0) {
        return null;
    }
    const fieldsAfterCommand = statText.slice(commandEnd + 1).trim().split(/\s+/u);
    const startTime = fieldsAfterCommand[19];
    return startTime && /^\d+$/u.test(startTime) ? startTime : null;
}

function normalizeProcessStartTime(value: string) {
    const normalized = value.trim().replace(/\s+/gu, ' ');
    return normalized.length > 0 ? normalized : null;
}

async function readPortableProcessIdentity(pid: number): Promise<IOcrNativeChildProcessIdentity | null> {
    try {
        if (process.platform === 'darwin') {
            const {stdout} = await execFileAsync('/bin/ps', [
                '-o',
                'lstart=',
                '-p',
                String(pid),
            ], {
                timeout: 1_000,
                maxBuffer: 16 * 1024,
            });
            const value = normalizeProcessStartTime(stdout);
            return value === null ? null : {
                kind: 'posix-start-time',
                value,
            };
        }
        if (process.platform === 'win32') {
            const {stdout} = await execFileAsync('pwsh.exe', [
                '-NoProfile',
                '-NonInteractive',
                '-Command',
                `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`,
            ], {
                timeout: 2_000,
                windowsHide: true,
                maxBuffer: 16 * 1024,
            });
            const value = normalizeProcessStartTime(stdout);
            return value === null ? null : {
                kind: 'windows-creation-time',
                value,
            };
        }
    } catch {
        return null;
    }
    return null;
}

/**
 * Each supported platform gets a stable process-start identity. An opaque
 * token is reserved for worker-local registration only and cannot prove
 * termination in the parent process.
 */
export async function readOcrNativeChildProcessIdentity(
    pid: number,
): Promise<IOcrNativeChildProcessIdentity | null> {
    if (!Number.isSafeInteger(pid) || pid <= 0) {
        return null;
    }
    if (process.platform === 'linux') {
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
    if (process.platform === 'darwin' || process.platform === 'win32') {
        return readPortableProcessIdentity(pid);
    }
    return {
        kind: 'opaque',
        value: `${process.platform}:${pid}:${randomUUID()}`,
    };
}

export interface IOcrNativeChildTerminationController {terminate(record: IOcrNativeChildRecord, reason: string): Promise<boolean>;}

export function createOcrNativeChildTerminationController(): IOcrNativeChildTerminationController {
    return {async terminate(record) {
        const processIdentity = record.processIdentity;
        if (
            (record.state !== 'registered' && record.state !== 'unproven')
                || record.pid === null
                || processIdentity === null
                || processIdentity.kind === 'opaque'
        ) {
            return false;
        }

        const before = await readOcrNativeChildProcessIdentity(record.pid);
        if (
            before === null
                || before.kind !== processIdentity.kind
                || before.value !== processIdentity.value
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
