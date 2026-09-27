import {
    readdir,
    rm,
    stat,
} from 'fs/promises';
import {join} from 'path';
import {isErrnoException} from '@contracts/runtimeGuards';

export async function pruneAssistantChatArchives(
    archiveDir: string,
    maxArchives: number,
    onError?: (message: string, error: unknown) => void,
) {
    let entries: Array<{
        filePath: string;
        modifiedAtMs: number;
    }> = [];
    try {
        for (const entry of await readdir(archiveDir, {withFileTypes: true})) {
            if (!entry.isFile() || !entry.name.endsWith('.jsonl')) {
                continue;
            }
            const filePath = join(archiveDir, entry.name);
            try {
                entries.push({
                    filePath,
                    modifiedAtMs: (await stat(filePath)).mtimeMs,
                });
            } catch (error) {
                if (isErrnoException(error) && error.code === 'ENOENT') {
                    continue;
                }
                throw error;
            }
        }
    } catch (error) {
        if (isErrnoException(error) && error.code === 'ENOENT') {
            return;
        }
        throw error;
    }
    if (entries.length <= maxArchives) {
        return;
    }
    entries = entries.sort((left, right) => left.modifiedAtMs - right.modifiedAtMs);
    for (const entry of entries.slice(0, entries.length - maxArchives)) {
        try {
            await rm(entry.filePath, {force: true});
        } catch (error) {
            if (isErrnoException(error) && error.code === 'ENOENT') {
                continue;
            }
            try {
                onError?.(`Failed to prune archived assistant chat session "${entry.filePath}"`, error);
            } catch {
                // Error reporting cannot stop the remaining housekeeping work.
            }
        }
    }
}
