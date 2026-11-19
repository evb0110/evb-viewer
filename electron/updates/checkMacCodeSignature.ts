import path from 'node:path';
import { runNativeCommand } from '@electron/native-tools/runNativeCommand';
import { NativeProcessError } from '@electron/native-tools/processResult';

const CODESIGN_CHECK_TIMEOUT_MS = 30_000;

// Resolves codesign's stderr when it exits 0, false when it exits with a
// failure code, and null when the check could not finish.
async function runCodesign(args: string[]) {
    try {
        return (await runNativeCommand('codesign', args, {timeoutMs: CODESIGN_CHECK_TIMEOUT_MS})).stderr;
    } catch (error) {
        return error instanceof NativeProcessError && error.kind === 'exit-code' ? false : null;
    }
}

export async function checkMacCodeSignature() {
    const appBundle = path.resolve(process.execPath, '..', '..', '..');
    const verification = await runCodesign([
        '--verify',
        '--deep',
        '--strict',
        '--verbose=2',
        appBundle,
    ]);
    if (typeof verification !== 'string') {
        return verification;
    }

    const details = await runCodesign([
        '-d',
        '--verbose=4',
        appBundle,
    ]);
    if (typeof details !== 'string') {
        return details;
    }

    return /^Authority=Developer ID Application:/mu.test(details)
        && /^TeamIdentifier=\S+/mu.test(details);
}
