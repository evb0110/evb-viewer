import {
    mkdtemp,
    mkdir,
    readFile,
    rm,
    writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
    afterEach,
    describe,
    expect,
    it,
} from 'vitest';
import {recoverPreparedOcrRevisionTransition} from '@electron/features/ocr/main/recoverPreparedOcrRevisionTransition';

let root: string | null = null;

afterEach(async () => {
    if (root) await rm(root, {
        recursive: true,
        force: true,
    });
    root = null;
});

async function createInterruptedTransition() {
    root = await mkdtemp(join(tmpdir(), 'evb-ocr-transition-recovery-'));
    const workingCopyPath = join(root, 'working.pdf');
    const catalogPath = `${workingCopyPath}.ocr`;
    const pdfBackupPath = join(root, 'before.pdf');
    const catalogBackupPath = join(root, 'before-catalog');
    await writeFile(workingCopyPath, 'partially-applied-pdf');
    await writeFile(pdfBackupPath, 'exact-before-pdf');
    await mkdir(catalogPath, {recursive: true});
    await writeFile(join(catalogPath, 'manifest.json'), 'partially-applied-catalog');
    await mkdir(catalogBackupPath, {recursive: true});
    await writeFile(join(catalogBackupPath, 'manifest.json'), 'exact-before-catalog');
    await writeFile(`${workingCopyPath}.ocr-transition.json`, JSON.stringify({
        version: 1,
        transitionId: 'transition-1',
        state: 'prepared',
        workingCopyPath,
        pdfBackupPath,
        catalogBackupPath,
    }));
    return {
        workingCopyPath,
        pdfBackupPath,
        catalogBackupPath,
    };
}

describe('OCR revision transition crash recovery', () => {
    it('restores PDF and catalog together, then becomes idempotent', async () => {
        const {workingCopyPath} = await createInterruptedTransition();

        await expect(recoverPreparedOcrRevisionTransition(workingCopyPath)).resolves.toBe(true);
        await expect(readFile(workingCopyPath, 'utf8')).resolves.toBe('exact-before-pdf');
        await expect(readFile(join(`${workingCopyPath}.ocr`, 'manifest.json'), 'utf8'))
            .resolves.toBe('exact-before-catalog');
        await expect(recoverPreparedOcrRevisionTransition(workingCopyPath)).resolves.toBe(false);
    });

    it('keeps applied bytes and converts the journal to undo state when its revision is already public', async () => {
        const {
            workingCopyPath,
            pdfBackupPath,
            catalogBackupPath,
        } = await createInterruptedTransition();
        const targetDocumentRevisionToken = 'next-revision';
        await writeFile(`${workingCopyPath}.ocr-transition.json`, JSON.stringify({
            version: 1,
            transitionId: 'transition-1',
            state: 'prepared',
            workingCopyPath,
            targetDocumentRevisionToken,
            pdfBackupPath,
            catalogBackupPath,
        }));
        await writeFile(`${workingCopyPath}.evb-revision.json`, JSON.stringify({
            sidecarVersion: 1,
            version: 1,
            documentRef: workingCopyPath,
            authority: 'electron-working-copy',
            token: targetDocumentRevisionToken,
            contentRevision: 2,
            mintedAt: 1,
            updatedAt: 1,
        }));

        await expect(recoverPreparedOcrRevisionTransition(workingCopyPath)).resolves.toBe(true);
        await expect(readFile(workingCopyPath, 'utf8')).resolves.toBe('partially-applied-pdf');
        await expect(readFile(join(`${workingCopyPath}.ocr`, 'manifest.json'), 'utf8'))
            .resolves.toBe('partially-applied-catalog');
        await expect(readFile(`${workingCopyPath}.ocr-transition.json`, 'utf8'))
            .resolves.toContain('"state":"committed"');
        await expect(recoverPreparedOcrRevisionTransition(workingCopyPath)).resolves.toBe(false);
        await expect(readFile(pdfBackupPath, 'utf8')).resolves.toBe('exact-before-pdf');
        await expect(readFile(join(catalogBackupPath, 'manifest.json'), 'utf8'))
            .resolves.toBe('exact-before-catalog');
    });

    it('restores the absence of a catalog when OCR was first applied to the document', async () => {
        const {
            workingCopyPath,
            catalogBackupPath,
        } = await createInterruptedTransition();
        await rm(catalogBackupPath, {
            recursive: true,
            force: true,
        });
        const journalPath = `${workingCopyPath}.ocr-transition.json`;
        const journal = JSON.parse(await readFile(journalPath, 'utf8')) as Record<string, unknown>;
        await writeFile(journalPath, JSON.stringify({
            ...journal,
            catalogBackupExisted: false,
        }));

        await expect(recoverPreparedOcrRevisionTransition(workingCopyPath)).resolves.toBe(true);
        await expect(readFile(join(`${workingCopyPath}.ocr`, 'manifest.json'), 'utf8'))
            .rejects.toMatchObject({code: 'ENOENT'});
    }, 15_000);

    it('refuses a prepared journal scoped to another working copy', async () => {
        root = await mkdtemp(join(tmpdir(), 'evb-ocr-transition-invalid-'));
        const workingCopyPath = join(root, 'working.pdf');
        await writeFile(`${workingCopyPath}.ocr-transition.json`, JSON.stringify({
            version: 1,
            state: 'prepared',
            workingCopyPath: join(root, 'other.pdf'),
            pdfBackupPath: join(root, 'before.pdf'),
            catalogBackupPath: join(root, 'before-catalog'),
        }));

        await expect(recoverPreparedOcrRevisionTransition(workingCopyPath))
            .rejects.toThrow('Invalid OCR revision transition recovery journal');
    });

    it('fails closed when the OCR transition journal cannot be read', async () => {
        root = await mkdtemp(join(tmpdir(), 'evb-ocr-transition-unreadable-'));
        const workingCopyPath = join(root, 'working.pdf');
        const journalPath = `${workingCopyPath}.ocr-transition.json`;
        await mkdir(journalPath);

        await expect(recoverPreparedOcrRevisionTransition(workingCopyPath)).rejects.toMatchObject({
            name: 'DocumentRecoveryJournalError',
            code: 'DOCUMENT_RECOVERY_JOURNAL_UNREADABLE',
            journalPath,
        });
    });

    it('fails closed on a truncated OCR transition journal', async () => {
        root = await mkdtemp(join(tmpdir(), 'evb-ocr-transition-truncated-'));
        const workingCopyPath = join(root, 'working.pdf');
        const journalPath = `${workingCopyPath}.ocr-transition.json`;
        await writeFile(journalPath, '{"version":1');

        await expect(recoverPreparedOcrRevisionTransition(workingCopyPath)).rejects.toMatchObject({
            name: 'DocumentRecoveryJournalError',
            code: 'DOCUMENT_RECOVERY_JOURNAL_INVALID',
            journalPath,
        });
        await expect(readFile(journalPath, 'utf8')).resolves.toBe('{"version":1');
    });

    it.each([
        {catalogBackupMode: 'missing'},
        {
            catalogApplyMode: 'rename',
            descriptorPath: '/tmp/unpaired-descriptor',
        },
        {catalogKind: 'v4-root'},
        {
            undoCatalogExisted: true,
            undoCatalogPath: undefined,
        },
        {committedAt: 'not-a-timestamp'},
    ])('fails closed for malformed committed journal fields %#', async (overrides) => {
        root = await mkdtemp(join(tmpdir(), 'evb-ocr-committed-invalid-'));
        const workingCopyPath = join(root, 'working.pdf');
        await writeFile(`${workingCopyPath}.ocr-transition.json`, JSON.stringify({
            version: 1,
            transitionId: 'transition-1',
            state: 'committed',
            workingCopyPath,
            targetDocumentRevisionToken: 'revision-1',
            undoPdfPath: join(root, 'before.pdf'),
            undoCatalogPath: join(root, 'before-catalog'),
            undoCatalogExisted: false,
            committedAt: 1,
            ...overrides,
        }));

        await expect(recoverPreparedOcrRevisionTransition(workingCopyPath))
            .rejects.toThrow('Invalid OCR revision transition recovery journal');
    });
});
