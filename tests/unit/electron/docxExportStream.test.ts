import { EventEmitter } from 'node:events';
import {
    mkdtemp,
    readFile,
    readdir,
    rm,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { WebContents } from 'electron';
import {
    afterEach,
    describe,
    expect,
    it,
} from 'vitest';
import {allowDocxWritePath} from '@electron/file-access/docxExportPaths';
import {
    beginDocxExportStream,
    cancelDocxExportStream,
    commitDocxExportStream,
    nextDocxExportStreamByteCount,
    writeDocxExportStreamChunk,
} from '@electron/features/documents/main/docxExportStream';
import type { IDocumentsSenderIdContext } from '@electron/features/documents/documentsContexts';
import { DOCX_EXPORT_STREAM_MAX_CHUNK_BYTES } from '@contracts/docxExport';

class FakeWebContents extends EventEmitter {
    readonly id = 42;

    isDestroyed() {
        return false;
    }
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, {
        recursive: true,
        force: true,
    })));
});

async function createFixture() {
    const directory = await mkdtemp(join(tmpdir(), 'evb-docx-stream-'));
    temporaryDirectories.push(directory);
    const sender = new FakeWebContents();
    // The export path only reads the lifecycle methods provided by this test double.
    const senderWebContents = sender as WebContents;
    const targetPath = join(directory, 'export.docx');
    allowDocxWritePath(targetPath, senderWebContents);
    const context = {
        sender: senderWebContents,
        senderId: sender.id,
    } satisfies IDocumentsSenderIdContext;
    return {
        context,
        targetPath,
        directory,
    };
}

describe('docxExportStream', () => {
    it('rejects byte-count accumulation past the safe integer limit', () => {
        expect(nextDocxExportStreamByteCount(Number.MAX_SAFE_INTEGER - 1, 1))
            .toBe(Number.MAX_SAFE_INTEGER);
        expect(() => nextDocxExportStreamByteCount(Number.MAX_SAFE_INTEGER, 1))
            .toThrow('DOCX stream byte count exceeds the safe integer limit');
    });

    it('writes bounded chunks to a temporary file and atomically commits the DOCX path', async () => {
        const {
            context,
            targetPath,
        } = await createFixture();
        const {sessionId} = await beginDocxExportStream(context, targetPath);

        await writeDocxExportStreamChunk(context, sessionId, Uint8Array.of(1, 2, 3));
        await writeDocxExportStreamChunk(context, sessionId, Uint8Array.of(4, 5));
        await expect(commitDocxExportStream(context, sessionId)).resolves.toBe(true);

        await expect(readFile(targetPath)).resolves.toEqual(Buffer.from([
            1,
            2,
            3,
            4,
            5,
        ]));
        await expect(cancelDocxExportStream(context, sessionId)).resolves.toBe(false);
    });

    it('rejects chunks above the bounded IPC size and removes canceled temporary output', async () => {
        const {
            context,
            targetPath,
            directory,
        } = await createFixture();
        const {sessionId} = await beginDocxExportStream(context, targetPath);

        await expect(writeDocxExportStreamChunk(
            context,
            sessionId,
            new Uint8Array(DOCX_EXPORT_STREAM_MAX_CHUNK_BYTES + 1),
        )).rejects.toThrow('DOCX stream chunks exceed the maximum size');
        await expect(cancelDocxExportStream(context, sessionId)).resolves.toBe(true);
        await expect(commitDocxExportStream(context, sessionId)).rejects.toThrow('Invalid DOCX stream session');
        await expect(readFile(targetPath)).rejects.toMatchObject({code: 'ENOENT'});
        await expect(readdir(directory)).resolves.toEqual([]);
    });

    it('removes partial temporary output when a renderer cancels after a valid chunk', async () => {
        const {
            context,
            targetPath,
            directory,
        } = await createFixture();
        const {sessionId} = await beginDocxExportStream(context, targetPath);

        await writeDocxExportStreamChunk(context, sessionId, Uint8Array.of(1, 2, 3));
        await expect(cancelDocxExportStream(context, sessionId)).resolves.toBe(true);
        await expect(commitDocxExportStream(context, sessionId)).rejects.toThrow('Invalid DOCX stream session');
        await expect(readFile(targetPath)).rejects.toMatchObject({code: 'ENOENT'});
        await expect(readdir(directory)).resolves.toEqual([]);
    });
});
