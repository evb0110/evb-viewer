import type * as TViMockOriginalModule from '@electron/utils/syncFileHandleForDurability';

import { EventEmitter } from 'node:events';
import {
    mkdtemp,
    readFile,
    readdir,
    rename,
    rm,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { WebContents } from 'electron';
import type * as AtomicReplaceModule from '@electron/utils/atomicReplace';
import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { allowDocxWritePath } from '@electron/file-access/docxExportPaths';
import type { IDocumentsSenderIdContext } from '@electron/features/documents/documentsService';

const mocks = vi.hoisted(() => ({
    atomicReplace: vi.fn(async (
        _sourcePath: string,
        _destinationPath: string,
        _options?: {
            durable?: boolean;
            markMutationCommitStarted?: boolean
        },
    ) => undefined),
    syncFileHandleForDurability: vi.fn(async (..._args: unknown[]) => undefined),
}));

vi.mock('@electron/utils/atomicReplace', async () => {
    const actual = await vi.importActual<typeof AtomicReplaceModule>('@electron/utils/atomicReplace');
    return {
        ...actual,
        atomicReplace: (...args: Parameters<typeof actual.atomicReplace>) => mocks.atomicReplace(...args),
    };
});
vi.mock('@electron/utils/syncFileHandleForDurability', async (importOriginal) => ({
    ...(await importOriginal<typeof TViMockOriginalModule>()),
    syncFileHandleForDurability: (...args: unknown[]) => mocks.syncFileHandleForDurability(...args),
}));

const {
    beginDocxExportStream,
    cancelDocxExportStream,
    commitDocxExportStream,
    writeDocxExportStreamChunk,
} = await import('@electron/features/documents/main/docxExportStream');

class FakeWebContents extends EventEmitter {
    readonly id = 84;

    isDestroyed() {
        return false;
    }
}

describe('DOCX export stream commit cancellation race', () => {
    it('lets cancellation win before replacement and leaves no target or temp file', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'evb-docx-commit-race-'));
        try {
            const sender = new FakeWebContents();
            // The export path only reads the lifecycle methods provided by this test double.
            const senderWebContents = sender as WebContents;
            const targetPath = join(directory, 'export.docx');
            allowDocxWritePath(targetPath, senderWebContents);
            const context = {
                sender: senderWebContents,
                senderId: sender.id,
            } satisfies IDocumentsSenderIdContext;
            const {sessionId} = await beginDocxExportStream(context, targetPath);
            await writeDocxExportStreamChunk(context, sessionId, Uint8Array.of(1, 2, 3));

            const syncStarted = Promise.withResolvers<undefined>();
            const releaseSync = Promise.withResolvers<undefined>();
            mocks.syncFileHandleForDurability.mockImplementationOnce(async () => {
                syncStarted.resolve(undefined);
                await releaseSync.promise;
            });

            const commitPromise = commitDocxExportStream(context, sessionId);
            await syncStarted.promise;
            await expect(cancelDocxExportStream(context, sessionId)).resolves.toBe(true);

            releaseSync.resolve(undefined);
            await expect(commitPromise).resolves.toBe(false);
            expect(mocks.atomicReplace).not.toHaveBeenCalled();
            await expect(readFile(targetPath)).rejects.toMatchObject({code: 'ENOENT'});
            await expect(readdir(directory)).resolves.toEqual([]);
        } finally {
            await rm(directory, {
                recursive: true,
                force: true,
            });
        }
    });

    it('reports a committed export when cancellation arrives after replacement starts', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'evb-docx-commit-race-'));
        try {
            const sender = new FakeWebContents();
            // The export path only reads the lifecycle methods provided by this test double.
            const senderWebContents = sender as WebContents;
            const targetPath = join(directory, 'export.docx');
            allowDocxWritePath(targetPath, senderWebContents);
            const context = {
                sender: senderWebContents,
                senderId: sender.id,
            } satisfies IDocumentsSenderIdContext;
            const {sessionId} = await beginDocxExportStream(context, targetPath);
            await writeDocxExportStreamChunk(context, sessionId, Uint8Array.of(4, 5, 6));

            const replacementStarted = Promise.withResolvers<undefined>();
            const releaseReplacement = Promise.withResolvers<undefined>();
            mocks.atomicReplace.mockImplementationOnce(async (sourcePath, destinationPath) => {
                replacementStarted.resolve(undefined);
                await releaseReplacement.promise;
                await rename(sourcePath, destinationPath);
            });

            const commitPromise = commitDocxExportStream(context, sessionId);
            await replacementStarted.promise;
            await expect(cancelDocxExportStream(context, sessionId)).resolves.toBe(false);

            releaseReplacement.resolve(undefined);
            await expect(commitPromise).resolves.toBe(true);
            await expect(readFile(targetPath)).resolves.toEqual(Buffer.from([
                4,
                5,
                6,
            ]));
            await expect(readdir(directory)).resolves.toEqual(['export.docx']);
        } finally {
            await rm(directory, {
                recursive: true,
                force: true,
            });
        }
    });
});
