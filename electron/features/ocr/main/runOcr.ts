import { spawn } from 'child_process';
import { ensureTessdataLanguages } from '@electron/features/ocr/languageModels';
import { getOcrPaths } from '@electron/features/ocr/main/paths';
import { resolveTesseractLanguageConfig } from '@electron/features/ocr/main/resolveTesseractLanguageConfig';
import { createTextChunkAccumulator } from '@electron/native-tools/createTextChunkAccumulator';
import { parseIntegerEnv } from '@electron/utils/parseIntegerEnv';
import { buildTesseractEnv } from '@electron/features/ocr/main/buildTesseractEnv';
import { createTesseractFinalize } from '@electron/features/ocr/main/createTesseractFinalize';
import type { IOcrRecognizeResult } from '@contracts/electronApiOcr';

interface ITesseractSpawnOptions {
    threads?: number;
    signal?: AbortSignal;
}

type TOcrResult = Pick<IOcrRecognizeResult, 'success' | 'text' | 'error'>;

const TESSERACT_TIMEOUT_MS = parseIntegerEnv('EVB_TESSERACT_TIMEOUT_MS', 2 * 60 * 1000, 5_000);
const TESSERACT_KILL_GRACE_MS = parseIntegerEnv('EVB_TESSERACT_KILL_GRACE_MS', 2_000, 250);
const TESSERACT_MAX_STDOUT_BYTES = parseIntegerEnv('EVB_TESSERACT_MAX_STDOUT_BYTES', 262_144, 1_024);
const TESSERACT_MAX_STDERR_BYTES = parseIntegerEnv('EVB_TESSERACT_MAX_STDERR_BYTES', 262_144, 1_024);

export async function runOcr(
    imageBuffer: Buffer,
    languages: string[],
    options?: ITesseractSpawnOptions,
): Promise<TOcrResult> {
    if (options?.signal?.aborted) {
        return {
            success: false,
            text: '',
            error: 'Tesseract aborted',
        };
    }

    const languageConfig = resolveTesseractLanguageConfig(languages);
    await ensureTessdataLanguages(
        languageConfig.orderedLanguages,
        options?.signal ? {signal: options.signal} : {},
    );

    if (options?.signal?.aborted) {
        return {
            success: false,
            text: '',
            error: 'Tesseract aborted',
        };
    }

    const {
        binary,
        tessdata,
    } = await getOcrPaths();

    const args = [
        'stdin',
        'stdout',
        '-l',
        languageConfig.orderedLanguages.join('+'),
        '--tessdata-dir',
        tessdata,
        ...languageConfig.extraConfigArgs,
    ];

    return new Promise((resolve) => {
        const proc = spawn(binary, args, {
            env: buildTesseractEnv(tessdata, options?.threads),
            stdio: [
                'pipe',
                'pipe',
                'pipe',
            ],
        });

        const stdout = createTextChunkAccumulator(TESSERACT_MAX_STDOUT_BYTES);
        const stderr = createTextChunkAccumulator(TESSERACT_MAX_STDERR_BYTES);
        let timedOut = false;
        let aborted = false;
        let abortHandler: (() => void) | null = null;
        const handles = {
            timeoutHandle: null as NodeJS.Timeout | null,
            killHandle: null as NodeJS.Timeout | null,
            forceFinalizeHandle: null as NodeJS.Timeout | null,
        };

        const finalizeBase = createTesseractFinalize<TOcrResult>(handles, resolve);
        const finalize = (result: TOcrResult) => {
            if (options?.signal && abortHandler) {
                options.signal.removeEventListener('abort', abortHandler);
                abortHandler = null;
            }
            finalizeBase(result);
        };

        const killProcessImmediately = () => {
            try {
                proc.kill('SIGKILL');
                return;
            } catch {
                // Fall through to SIGTERM if SIGKILL is unavailable.
            }

            try {
                proc.kill('SIGTERM');
            } catch {
                // Process may already be gone.
            }
        };

        handles.timeoutHandle = setTimeout(() => {
            timedOut = true;
            try {
                proc.kill('SIGTERM');
            } catch {
                // Process may already be gone.
            }

            handles.killHandle = setTimeout(() => {
                try {
                    proc.kill('SIGKILL');
                } catch {
                    // Process may already be gone.
                }
            }, TESSERACT_KILL_GRACE_MS);
            handles.killHandle.unref();

            handles.forceFinalizeHandle = setTimeout(() => {
                finalize({
                    success: false,
                    text: '',
                    error: `Tesseract timed out after ${TESSERACT_TIMEOUT_MS}ms`,
                });
            }, TESSERACT_KILL_GRACE_MS + 1_000);
            handles.forceFinalizeHandle.unref();
        }, TESSERACT_TIMEOUT_MS);
        handles.timeoutHandle.unref();

        if (options?.signal) {
            abortHandler = () => {
                aborted = true;
                killProcessImmediately();
                finalize({
                    success: false,
                    text: '',
                    error: 'Tesseract aborted',
                });
            };
            options.signal.addEventListener('abort', abortHandler, { once: true });
        }

        proc.stdout.on('data', (data: Buffer) => {
            stdout.append(data);
        });

        proc.stderr.on('data', (data: Buffer) => {
            stderr.append(data);
        });

        proc.on('close', (code) => {
            if (aborted) {
                finalize({
                    success: false,
                    text: '',
                    error: 'Tesseract aborted',
                });
                return;
            }

            if (timedOut) {
                finalize({
                    success: false,
                    text: '',
                    error: `Tesseract timed out after ${TESSERACT_TIMEOUT_MS}ms`,
                });
                return;
            }

            if (code === 0 && stdout.truncated) {
                finalize({
                    success: false,
                    text: '',
                    error: `Tesseract output exceeded maximum size (${TESSERACT_MAX_STDOUT_BYTES} bytes)`,
                });
            } else if (code === 0) {
                finalize({
                    success: true,
                    text: stdout.text().trim(),
                });
            } else {
                const stderrText = stderr.text();
                const stderrSummary = stderr.truncated
                    ? `[stderr truncated to ${TESSERACT_MAX_STDERR_BYTES} bytes]\n${stderrText}`
                    : stderrText;
                finalize({
                    success: false,
                    text: '',
                    error: stderrSummary || `Tesseract exited with code ${code ?? '<unknown>'}`,
                });
            }
        });

        proc.on('error', (err) => {
            finalize({
                success: false,
                text: '',
                error: err.message,
            });
        });

        proc.stdin.on('error', (stdinError) => {
            killProcessImmediately();
            finalize({
                success: false,
                text: '',
                error: stdinError.message,
            });
        });

        proc.stdin.end(imageBuffer, (stdinError?: Error | null) => {
            if (stdinError) {
                killProcessImmediately();
                finalize({
                    success: false,
                    text: '',
                    error: stdinError.message,
                });
            }
        });

        if (options?.signal?.aborted && abortHandler) {
            abortHandler();
        }
    });
}
