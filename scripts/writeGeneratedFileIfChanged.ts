import {mkdir, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';

/**
 * Single write path for every committed build artifact: rewrite only on a content
 * change so `pnpm run generate:build-artifacts` is idempotent and the CI drift gate
 * sees a diff exactly when a generator's input changed. Returns whether it wrote.
 */
export async function writeGeneratedFileIfChanged(filePath: string, content: string) {
    const existing = await readFile(filePath, 'utf8').catch(() => null);
    if (existing === content) {
        return false;
    }
    await mkdir(path.dirname(filePath), {recursive: true});
    await writeFile(filePath, content, 'utf8');
    return true;
}
