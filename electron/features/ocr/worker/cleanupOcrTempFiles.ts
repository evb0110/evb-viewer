import {
    readdir,
    rm,
} from 'node:fs/promises';
import {join} from 'node:path';

export async function cleanupOcrTempFiles(
    tempFiles: Set<string>,
    keepFiles: Set<string>,
    overflow: boolean,
    tempDir: string,
    sessionId: string | null,
) {
    for (const filePath of tempFiles) {
        if (keepFiles.has(filePath)) {
            continue;
        }
        await rm(filePath, {
            recursive: true,
            force: true,
        }).catch(() => undefined);
    }
    if (!overflow || sessionId === null) {
        return;
    }
    const keptPaths = new Set<string>();
    for (const keptFile of keepFiles) {
        keptPaths.add(keptFile);
        keptPaths.add(`${keptFile}.ocr`);
    }
    const sessionPrefix = `${sessionId}-`;
    const entries = await readdir(tempDir, {withFileTypes: true}).catch(() => []);
    await Promise.all(entries
        .filter(entry => entry.name.startsWith(sessionPrefix))
        .map(entry => {
            const path = join(tempDir, entry.name);
            return keptPaths.has(path)
                ? Promise.resolve()
                : rm(path, {
                    recursive: true,
                    force: true,
                }).catch(() => undefined);
        }));
}
