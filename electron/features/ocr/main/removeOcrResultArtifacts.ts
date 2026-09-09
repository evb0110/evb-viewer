import * as fsPromises from 'node:fs/promises';
import { isErrnoException } from '@contracts/runtimeGuards';
import type { ILogger } from '@electron/utils/createLogger';
import { getErrorMessage } from '@electron/utils/error';

export async function removeOcrResultArtifacts(path: string, logger: ILogger) {
    const stagedArtifactPaths = [
        `${path}.ocr-v4-prepared.json`,
        `${path}.ocr`,
    ];
    for (const stagedCatalogPath of stagedArtifactPaths) {
        try {
            const catalogStat = await fsPromises.lstat(stagedCatalogPath);
            if (catalogStat.isDirectory()) {
                // Legacy v3 results used a directory tree. Keep this
                // compatibility cleanup, but never ask rm to recurse when v4
                // leaves a descriptor file beside the result PDF.
                await fsPromises.rm(stagedCatalogPath, {
                    recursive: true,
                    force: true,
                });
            } else {
                await fsPromises.unlink(stagedCatalogPath);
            }
        } catch (error) {
            if (!isErrnoException(error) || error.code !== 'ENOENT') {
                logger.warn(
                    `Failed to cleanup staged OCR catalog "${stagedCatalogPath}": ${getErrorMessage(error)}`,
                );
            }
        }
    }
    try {
        await fsPromises.unlink(path);
        return true;
    } catch (error) {
        if (isErrnoException(error) && error.code === 'ENOENT') {
            return true;
        }
        logger.warn(`Failed to cleanup OCR temp result file "${path}": ${getErrorMessage(error)}`);
        return false;
    }
}
