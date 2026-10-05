import { buildDjvuRuntimeEnv } from '@electron/features/djvu/main/buildDjvuRuntimeEnv';
import { getDjvuNativeToolPaths } from '@electron/features/djvu/main/nativeToolPaths';
import { runNativeCommand } from '@electron/native-tools/runNativeCommand';
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
    const result = await runNativeCommand(djvused, args, commandOptions);

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
    try {
        const result = await runDjvused([
            filePath,
            '-e',
            'print-outline',
        ], options);
        return result.stdout.trim();
    } catch (error) {
        if (isAbortError(error)) {
            throw error;
        }
        logger.debug(`Failed to read DjVu outline for ${filePath}: ${String(error)}`);
        return '';
    }
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

/** Reads a page's pixel size and DPI from a djvudump INFO line. */
export function parseDjvuInfoLine(line: string) {
    const match = line.match(DJVU_INFO_REGEX);
    if (!match?.[1] || !match[2] || !match[3]) {
        return null;
    }
    return {
        width: Number.parseInt(match[1], 10),
        height: Number.parseInt(match[2], 10),
        dpi: Number.parseInt(match[3], 10),
    };
}

export async function getDjvuResolution(filePath: string, options: IDjvuMetadataOptions = {}) {
    try {
        const result = await runDjvused([
            filePath,
            '-e',
            'select 1; dump',
        ], options);
        const dpi = result.stdout.split(/\r?\n/u)
            .map(parseDjvuInfoLine)
            .find(info => info !== null)?.dpi;
        return dpi !== undefined && dpi > 0 ? dpi : 300;
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
