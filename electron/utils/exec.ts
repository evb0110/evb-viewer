import { spawn } from 'child_process';
import { describeProcessExitCode } from '@electron/utils/process-exit';

type TRunCommandResult = {
    stdout: string;
    stderr: string;
    exitCode: number;
};

export async function runCommand(
    command: string,
    args: string[],
    options: {
        cwd?: string;
        env?: NodeJS.ProcessEnv;
        timeoutMs?: number;
        allowedExitCodes?: number[];
    } = {},
): Promise<TRunCommandResult> {
    const {
        cwd,
        env,
        timeoutMs,
        allowedExitCodes = [0],
    } = options;

    return new Promise((resolve, reject) => {
        const proc = spawn(command, args, {
            cwd,
            env,
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

        let timeoutId: NodeJS.Timeout | null = null;
        if (typeof timeoutMs === 'number' && timeoutMs > 0) {
            timeoutId = setTimeout(() => {
                proc.kill('SIGKILL');
                reject(new Error(`${command} timed out after ${timeoutMs}ms`));
            }, timeoutMs);
        }

        proc.on('error', (err) => {
            if (timeoutId) {
                clearTimeout(timeoutId);
                timeoutId = null;
            }
            reject(err);
        });

        proc.on('close', (code) => {
            if (timeoutId) {
                clearTimeout(timeoutId);
                timeoutId = null;
            }

            const exitCode = typeof code === 'number' ? code : -1;
            if (!allowedExitCodes.includes(exitCode)) {
                reject(new Error(`${command} failed with exit code ${
                    describeProcessExitCode(exitCode)
                }: ${stderr || stdout}`));
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
