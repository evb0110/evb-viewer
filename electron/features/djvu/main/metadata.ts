import { buildDjvuRuntimeEnv } from '@electron/features/djvu/main/buildDjvuRuntimeEnv';
import {
    getDjvuNativeToolPaths,
    runDjvuSourceCommand,
} from '@electron/features/djvu/main/nativeToolPaths';
import { createLogger } from '@electron/utils/createLogger';
import { isAbortError } from '@electron/utils/abort';
import {getCachedDjvuHasText} from '@electron/features/djvu/main/getCachedDjvuHasText';
const logger = createLogger('djvu-metadata');

interface IRunResult {
    stdout: string;
    stderr: string;
    exitCode: number;
}

const DJVU_METADATA_TIMEOUT_MS = 20_000;
const DJVU_METADATA_MAX_STDOUT_BYTES = 262_144;
const DJVU_METADATA_MAX_STDERR_BYTES = 131_072;
interface IDjvuMetadataOptions {signal?: AbortSignal;}

async function runDjvused(args: string[], options: IDjvuMetadataOptions = {}): Promise<IRunResult> {
    const { djvused } = getDjvuNativeToolPaths();
    const commandOptions = {
        env: buildDjvuRuntimeEnv(),
        timeoutMs: DJVU_METADATA_TIMEOUT_MS,
        maxStdoutBytes: DJVU_METADATA_MAX_STDOUT_BYTES,
        maxStderrBytes: DJVU_METADATA_MAX_STDERR_BYTES,
        commandLabel: 'djvused',
        defaultCwdToCommandDir: true,
        prependCommandDirToPath: true,
        includeProcessEnv: true,
        windowsHide: true,
        ...(options.signal ? { signal: options.signal } : {}),
    };
    const result = await runDjvuSourceCommand(djvused, args, 0, commandOptions);

    return {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
    };
}

export async function getDjvuPageCount(filePath: string, options: IDjvuMetadataOptions = {}) {
    const result = await runDjvused([
        filePath,
        '-e',
        'n',
    ], options);
    const count = Number.parseInt(result.stdout.trim(), 10);
    if (!Number.isSafeInteger(count) || count <= 0) {
        throw new Error(`Invalid page count from djvused: ${result.stdout.trim()}`);
    }
    return count;
}

export async function getDjvuOutline(filePath: string, options: IDjvuMetadataOptions = {}) {
    const result = await runDjvused([
        filePath,
        '-e',
        'print-outline',
    ], options);
    return result.stdout.trim();
}

export async function getDjvuPageComponentMap(filePath: string, options: IDjvuMetadataOptions = {}) {
    const result = await runDjvused([
        filePath,
        '-e',
        'ls',
    ], options);
    const components = new Map<string, number>();
    for (const line of result.stdout.split(/\r?\n/u)) {
        const match = line.match(/^\s*(\d+)\s+P\s+\d+\s+(\S+)/u);
        if (match?.[1] && match[2]) {
            components.set(match[2], Number(match[1]) - 1);
        }
    }
    return components;
}

export async function getDjvuMetadata(
    filePath: string,
    options: IDjvuMetadataOptions = {},
): Promise<Record<string, string>> {
    try {
        const result = await runDjvused([
            filePath,
            '-e',
            'print-meta',
        ], options);
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
        if (isAbortError(error)) {
            throw error;
        }
        logger.debug(`Failed to read DjVu metadata for ${filePath}: ${String(error)}`);
        return {};
    }
}

const DJVU_INFO_REGEX = /\bINFO\b.*?(\d+)x(\d+).*?(\d+)\s*dpi/u;

/** Reads a page's pixel size and DPI from a djvudump INFO line, if all three are positive safe integers. */
export function parseDjvuInfoLine(line: string) {
    const match = line.match(DJVU_INFO_REGEX);
    const info = {
        width: Number(match?.[1]),
        height: Number(match?.[2]),
        dpi: Number(match?.[3]),
    };
    return Object.values(info).every(value => Number.isSafeInteger(value) && value > 0) ? info : null;
}

export async function getDjvuResolution(filePath: string, options: IDjvuMetadataOptions = {}) {
    try {
        const result = await runDjvused([
            filePath,
            '-e',
            'select 1; dump',
        ], options);
        return result.stdout.split(/\r?\n/u)
            .map(parseDjvuInfoLine)
            .find(info => info !== null)?.dpi ?? 300;
    } catch (error) {
        if (isAbortError(error)) {
            throw error;
        }
        logger.debug(`Failed to read DjVu resolution for ${filePath}: ${String(error)}`);
        return 300;
    }
}

export async function getDjvuHasText(filePath: string, options: IDjvuMetadataOptions = {}) {
    try {
        return await getCachedDjvuHasText(filePath, options.signal);
    } catch (error) {
        if (isAbortError(error)) {
            throw error;
        }
        logger.debug(`Failed to detect DjVu text layer for ${filePath}: ${String(error)}`);
        return false;
    }
}
