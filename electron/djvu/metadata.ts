import { spawn } from 'child_process';
import {
    buildDjvuRuntimeEnv,
    getDjvuToolPaths,
} from '@electron/djvu/paths';
import { createLogger } from '@electron/utils/logger';

const logger = createLogger('djvu-metadata');

interface IRunResult {
    stdout: string;
    stderr: string;
    exitCode: number;
}

function runDjvused(args: string[]): Promise<IRunResult> {
    const { djvused } = getDjvuToolPaths();

    return new Promise((resolve, reject) => {
        const proc = spawn(djvused, args, {
            shell: false,
            stdio: [
                'ignore',
                'pipe',
                'pipe',
            ],
            env: buildDjvuRuntimeEnv(),
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
            if (exitCode !== 0) {
                reject(new Error(`djvused failed with exit code ${exitCode}: ${stderr || stdout}`));
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

export async function getDjvuPageCount(filePath: string): Promise<number> {
    const result = await runDjvused([
        filePath,
        '-e',
        'n',
    ]);
    const count = parseInt(result.stdout.trim(), 10);
    if (!Number.isFinite(count) || count <= 0) {
        throw new Error(`Invalid page count from djvused: ${result.stdout.trim()}`);
    }
    return count;
}

export async function getDjvuOutline(filePath: string): Promise<string> {
    try {
        const result = await runDjvused([
            filePath,
            '-e',
            'print-outline',
        ]);
        return result.stdout.trim();
    } catch (error) {
        logger.debug(`Failed to read DjVu outline for ${filePath}: ${String(error)}`);
        return '';
    }
}

export async function getDjvuMetadata(filePath: string): Promise<Record<string, string>> {
    try {
        const result = await runDjvused([
            filePath,
            '-e',
            'print-meta',
        ]);
        const metadata: Record<string, string> = {};
        const lines = result.stdout.trim().split('\n');
        for (const line of lines) {
            const match = line.match(/^(\w+)\s+"((?:[^"\\]|\\.)*)"/);
            if (match && match[1] && match[2]) {
                metadata[match[1]] = match[2].replace(/\\"/g, '"').replace(/\\\\/g, '\\');
            }
        }
        return metadata;
    } catch (error) {
        logger.debug(`Failed to read DjVu metadata for ${filePath}: ${String(error)}`);
        return {};
    }
}

export async function getDjvuResolution(filePath: string): Promise<number> {
    try {
        const result = await runDjvused([
            filePath,
            '-e',
            'select 1; print-dpi',
        ]);
        const dpi = parseInt(result.stdout.trim(), 10);
        return Number.isFinite(dpi) && dpi > 0 ? dpi : 300;
    } catch (error) {
        logger.debug(`Failed to read DjVu resolution for ${filePath}: ${String(error)}`);
        return 300;
    }
}

export async function getDjvuHasText(filePath: string): Promise<boolean> {
    try {
        const result = await runDjvused([
            filePath,
            '-e',
            'select 1; print-txt',
        ]);
        return result.stdout.trim().length > 0;
    } catch (error) {
        logger.debug(`Failed to detect DjVu text layer for ${filePath}: ${String(error)}`);
        return false;
    }
}
