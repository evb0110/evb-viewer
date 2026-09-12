import { spawn } from 'node:child_process';
import path from 'node:path';

const CODESIGN_CHECK_TIMEOUT_MS = 30_000;

function runCodesign(args: string[]) {
    return new Promise<{
        code: number | null;
        stderr: string;
    }>((resolve) => {
        const child = spawn('codesign', args, {
            shell: false,
            windowsHide: true,
            stdio: [
                'ignore',
                'ignore',
                'pipe',
            ],
        });

        let stderr = '';
        let finished = false;
        let timeoutHandle: NodeJS.Timeout | null = setTimeout(() => {
            timeoutHandle = null;
            if (finished) {
                return;
            }
            finished = true;
            try {
                child.kill('SIGKILL');
            } catch {
                // Ignore kill failures after timeout.
            }
            resolve({
                code: null,
                stderr,
            });
        }, CODESIGN_CHECK_TIMEOUT_MS);
        timeoutHandle.unref();

        child.stderr.on('data', (chunk: Buffer) => {
            stderr += chunk.toString();
        });

        child.once('error', () => {
            if (finished) {
                return;
            }
            finished = true;
            if (timeoutHandle) {
                clearTimeout(timeoutHandle);
            }
            resolve({
                code: null,
                stderr,
            });
        });

        child.once('close', (code) => {
            if (finished) {
                return;
            }
            finished = true;
            if (timeoutHandle) {
                clearTimeout(timeoutHandle);
            }
            resolve({
                code,
                stderr,
            });
        });
    });
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
    if (verification.code === null) {
        return null;
    }
    if (verification.code !== 0) {
        return false;
    }

    const details = await runCodesign([
        '-d',
        '--verbose=4',
        appBundle,
    ]);
    if (details.code === null) {
        return null;
    }
    if (details.code !== 0) {
        return false;
    }

    return /^Authority=Developer ID Application:/mu.test(details.stderr)
        && /^TeamIdentifier=\S+/mu.test(details.stderr);
}
