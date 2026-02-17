import type { IpcMainInvokeEvent } from 'electron';
import { app } from 'electron';
import { randomUUID } from 'crypto';
import {
    readFile,
    unlink,
    writeFile,
} from 'fs/promises';
import { join } from 'path';
import {
    preprocessPageForOcr,
    validatePreprocessingSetup,
} from '@electron/ocr/preprocessing';
import { createLogger } from '@electron/utils/logger';

const log = createLogger('ocr-ipc');

export function handlePreprocessingValidate() {
    const validation = validatePreprocessingSetup();
    return {
        valid: validation.valid,
        available: validation.available,
        missing: validation.missing,
    };
}

export async function handlePreprocessPage(
    _event: IpcMainInvokeEvent,
    imageData: Uint8Array,
    usePreprocessing: boolean,
) {
    try {
        if (!usePreprocessing) {
            return {
                success: true,
                imageData,
                message: 'Preprocessing disabled',
            };
        }

        const validation = validatePreprocessingSetup();
        if (!validation.valid) {
            return {
                success: true,
                imageData,
                message: 'Preprocessing unavailable on this platform/architecture; using original image.',
            };
        }

        const tempDir = app.getPath('temp');
        const uuid = randomUUID();
        const inputPath = join(tempDir, `preprocess-input-${uuid}.png`);
        const outputPath = join(tempDir, `preprocess-output-${uuid}.png`);

        try {
            const imageBuffer = Buffer.from(imageData);
            await writeFile(inputPath, imageBuffer);

            log.debug(`Preprocessing image: ${inputPath}`);
            const result = await preprocessPageForOcr(inputPath, outputPath);

            if (!result.success) {
                log.debug(`Preprocessing failed: ${result.error}`);
                return {
                    success: true,
                    imageData,
                    message: 'Preprocessing failed; using original image.',
                };
            }

            const preprocessedBuffer = await readFile(outputPath);
            const preprocessedData = new Uint8Array(preprocessedBuffer);

            log.debug(`Preprocessing successful: ${inputPath} -> ${outputPath}`);

            return {
                success: true,
                imageData: preprocessedData,
                message: 'Preprocessing complete',
            };
        } finally {
            try {
                await unlink(inputPath);
            } catch (cleanupErr) {
                log.warn(`Cleanup warning (inputPath): ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`);
            }
            try {
                await unlink(outputPath);
            } catch (cleanupErr) {
                log.warn(`Cleanup warning (outputPath): ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`);
            }
        }
    } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        log.debug(`Preprocessing error: ${errMsg}`);
        return {
            success: false,
            imageData,
            error: errMsg,
        };
    }
}
