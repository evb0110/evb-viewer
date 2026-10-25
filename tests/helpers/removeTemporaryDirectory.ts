import {
    mkdtempSync,
    rmSync,
    type RmOptions,
} from 'node:fs';
import {
    mkdtemp,
    rm,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {onTestFinished} from 'vitest';

const TEMP_DIRECTORY_REMOVE_OPTIONS = {
    force: true,
    maxRetries: 10,
    recursive: true,
    retryDelay: 50,
} as const satisfies RmOptions;

export async function removeTemporaryDirectory(directory: string) {
    await rm(directory, TEMP_DIRECTORY_REMOVE_OPTIONS);
}

export function removeTemporaryDirectorySync(directory: string) {
    rmSync(directory, TEMP_DIRECTORY_REMOVE_OPTIONS);
}

/** A temporary directory that is removed when the running test finishes. */
export function createTestTemporaryDirectorySync(prefix: string) {
    const directory = mkdtempSync(join(tmpdir(), prefix));
    onTestFinished(() => removeTemporaryDirectory(directory));
    return directory;
}

/** A temporary directory that is removed when the running test finishes. */
export async function createTestTemporaryDirectory(prefix: string) {
    const directory = await mkdtemp(join(tmpdir(), prefix));
    onTestFinished(() => removeTemporaryDirectory(directory));
    return directory;
}
