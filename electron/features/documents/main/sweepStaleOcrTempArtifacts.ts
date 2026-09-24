import {
    lstat,
    readdir,
    rm,
} from 'fs/promises';
import { join } from 'path';
import { createLogger } from '@electron/utils/createLogger';
import { getAppTempDir } from '@electron/utils/appTempDir';
import { getErrorMessage } from '@electron/utils/error';

const logger = createLogger('ocr-temp-cleanup');
const OCR_TEMP_ARTIFACT_PREFIXES = [
    'ocr-',
    'searchable-',
] as const;
const OCR_TEMP_STALE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function isManagedOcrTempArtifactName(entryName: string) {
    return OCR_TEMP_ARTIFACT_PREFIXES.some(prefix => entryName.startsWith(prefix));
}

export async function sweepStaleOcrTempArtifacts(maxAgeMs = OCR_TEMP_STALE_MAX_AGE_MS) {
    const tempDir = getAppTempDir();
    const now = Date.now();
    let deletedCount = 0;

    let entries: string[] = [];
    try {
        entries = await readdir(tempDir);
    } catch {
        return 0;
    }

    await Promise.all(entries.map(async (entry) => {
        if (!isManagedOcrTempArtifactName(entry)) {
            return;
        }

        const artifactPath = join(tempDir, entry);
        let shouldRemoveDirectory = false;
        try {
            const artifactStat = await lstat(artifactPath);
            shouldRemoveDirectory = artifactStat.isDirectory();
            if (!artifactStat.isFile() && !shouldRemoveDirectory) {
                return;
            }

            const lastTouchedAt = Math.max(artifactStat.mtimeMs, artifactStat.ctimeMs);
            if (!Number.isFinite(lastTouchedAt) || now - lastTouchedAt < maxAgeMs) {
                return;
            }
        } catch {
            return;
        }

        try {
            await rm(artifactPath, {
                force: true,
                recursive: shouldRemoveDirectory,
            });
            deletedCount += 1;
        } catch (error) {
            logger.warn(`Failed to remove stale OCR temp artifact "${artifactPath}": ${getErrorMessage(error)}`);
        }
    }));

    if (deletedCount > 0) {
        logger.info(`Cleaned up ${deletedCount} stale OCR temp artifact(s)`);
    }

    return deletedCount;
}
