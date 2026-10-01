import { existsSync } from 'fs';
import {
    mkdtemp,
    rm,
    writeFile,
} from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { createLogger } from '@electron/utils/createLogger';
import { getErrorMessage } from '@electron/utils/error';
import { createNativeFallbackTestError } from '@electron/native-tools/createNativeFallbackTestError';
import { runNativeCommand } from '@electron/native-tools/runNativeCommand';
import {
    atomicReplace,
    makeSiblingTempPath,
} from '@electron/utils/atomicReplace';
import { resolveNativePdfImageCombinePath } from '@electron/image/tryCreatePdfWithNativeImageCombiner';
import { abortErrorFromSignal } from '@electron/utils/abort';
import { getUnprovenNativeTerminationDetail } from '@electron/utils/nativeTerminationProof';
import {runtimeConfig} from '@electron/runtimeConfig';

const logger = createLogger('nativeTiffCombine');
const NATIVE_TIFF_COMBINE_TIMEOUT_MS = 10 * 60 * 1000;

function isNativeTiffCombineDisabled() {
    return process.env.VITEST === 'true' && !runtimeConfig.test.nativeTiffCombineEnabled;
}

export async function tryCombinePagesWithNativeTiffCombiner(
    pagePaths: string[],
    outputPath: string,
    signal?: AbortSignal,
    dpi?: number,
) {
    if (isNativeTiffCombineDisabled() || pagePaths.length === 0) {
        return false;
    }

    const binaryPath = resolveNativePdfImageCombinePath();
    if (!binaryPath) {
        const testFailure = createNativeFallbackTestError(
            runtimeConfig.test.nativeTiffCombineEnabled,
            'Native TIFF combine',
            'native binary path could not be resolved',
        );
        if (testFailure) {
            throw testFailure;
        }
        return false;
    }

    const tempDir = await mkdtemp(join(tmpdir(), 'tiff-combine-native-'));
    const inputsPath = join(tempDir, 'inputs.txt');
    const tempOutputPath = makeSiblingTempPath(outputPath);
    let replacedOutput = false;
    let terminationProof: Promise<boolean> | undefined;
    let terminationUnproven = false;
    const cleanup = async () => {
        await rm(tempDir, {
            recursive: true,
            force: true,
        }).catch(() => undefined);
        if (!replacedOutput) {
            await rm(tempOutputPath, { force: true }).catch(() => undefined);
        }
    };

    try {
        if (signal?.aborted) throw abortErrorFromSignal(signal);
        await writeFile(inputsPath, createNativeInputsFileContents(pagePaths), 'utf8');
        const ok = await runNativeTiffCombine(binaryPath, tempOutputPath, inputsPath, signal, dpi, (proof) => {
            terminationProof = proof;
        });
        if (!ok || !existsSync(tempOutputPath)) {
            const testFailure = createNativeFallbackTestError(
                runtimeConfig.test.nativeTiffCombineEnabled,
                'Native TIFF combine',
                !ok
                    ? 'native command reported failure'
                    : `native output was not created at "${tempOutputPath}"`,
            );
            if (testFailure) {
                throw testFailure;
            }
            return false;
        }

        if (signal?.aborted) throw abortErrorFromSignal(signal);
        await atomicReplace(tempOutputPath, outputPath);
        replacedOutput = true;
        return true;
    } catch (error) {
        terminationUnproven = getUnprovenNativeTerminationDetail(error) !== undefined;
        throw error;
    } finally {
        if (terminationUnproven) {
            // The child may still read the inputs and write the output; they
            // go once its process tree is proven gone.
            void terminationProof?.then(proven => (proven
                ? cleanup()
                : logger.warn(`Keeping native TIFF combine inputs "${tempDir}" and output "${tempOutputPath}" until the child is proven gone`)));
        } else {
            await cleanup();
        }
    }
}

function canRepresentPathInNativeInputsFile(inputPath: string) {
    return inputPath.length > 0
        && inputPath.trim() === inputPath
        && !/[\r\n]/u.test(inputPath);
}

function createNativeInputsFileContents(pagePaths: string[]) {
    if (!pagePaths.every(canRepresentPathInNativeInputsFile)) {
        throw new Error('Native TIFF combine input paths must not contain leading/trailing whitespace or line breaks');
    }
    return `${pagePaths.join('\n')}\n`;
}

async function runNativeTiffCombine(
    binaryPath: string,
    outputPath: string,
    inputsPath: string,
    signal: AbortSignal | undefined,
    dpi: number | undefined,
    onTerminationProof: (proof: Promise<boolean>) => void,
) {
    try {
        const args = [
            '--output',
            outputPath,
            '--format',
            'tiff',
            '--inputs-file',
            inputsPath,
        ];
        if (typeof dpi === 'number' && Number.isFinite(dpi) && dpi > 0) {
            args.push('--dpi', String(Math.round(dpi)));
        }
        await runNativeCommand(binaryPath, args, {
            timeoutMs: NATIVE_TIFF_COMBINE_TIMEOUT_MS,
            commandLabel: 'evb-pdf-image-combine(tiff)',
            maxStdoutBytes: 1024,
            maxStderrBytes: 8_192,
            defaultCwdToCommandDir: true,
            prependCommandDirToPath: true,
            onTerminationProof,
            ...(signal ? { signal } : {}),
        });
        return true;
    } catch (error) {
        // A child not proven gone may still hold the pages and the output, so
        // no fallback starts beside it and the owner of the pages has to know.
        if (getUnprovenNativeTerminationDetail(error) !== undefined) throw error;
        if (signal?.aborted) throw abortErrorFromSignal(signal);
        const testFailure = createNativeFallbackTestError(
            runtimeConfig.test.nativeTiffCombineEnabled,
            'Native TIFF combine',
            'native command failed',
            error,
        );
        if (testFailure) {
            throw testFailure;
        }
        logger.debug(`Native TIFF combine failed: ${getErrorMessage(error)}`);
        return false;
    }
}
