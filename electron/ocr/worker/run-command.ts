import { spawn } from 'child_process';
import type { IRunCommandResult } from '@electron/ocr/worker/types';

export async function runCommand(
    command: string,
    args: string[],
    options: { allowedExitCodes?: number[] } = {},
): Promise<IRunCommandResult> {
    const { allowedExitCodes = [0] } = options;

    return new Promise((resolve, reject) => {
        const proc = spawn(command, args, {
            shell: false,
            stdio: [
                'ignore',
                'pipe',
                'pipe',
            ],
        });

        let stdout = '';
        let stderr = '';

        proc.stdout?.on('data', (data: Buffer) => {
            stdout += data.toString();
        });

        proc.stderr?.on('data', (data: Buffer) => {
            stderr += data.toString();
        });

        proc.on('error', (err) => {
            reject(err);
        });

        proc.on('close', (code) => {
            const exitCode = typeof code === 'number' ? code : -1;
            if (!allowedExitCodes.includes(exitCode)) {
                reject(new Error(`${command} failed with exit code ${exitCode}: ${stderr || stdout}`));
                return;
            }
            resolve({
                stdout,
                stderr,
                exitCode,
            });
        });
    });
}
