import {
    rm,
    unlink,
} from 'node:fs/promises';
import {join} from 'node:path';
import {copyFileAtomic} from '@electron/features/documents/public/index';
import {isRecord} from '@contracts/runtimeGuards';
import {readWorkingCopyRevisionSidecar} from '@electron/file-access/documentRevisionSidecar';
import {
    getOcrCatalogV4PreparedDescriptorPath,
    rollbackPreparedOcrCatalogV4,
} from '@electron/features/ocr/pipeline/indexWriterV4';
import {
    invalidDocumentRecoveryJournal,
    readDocumentRecoveryJournal,
} from '@electron/file-access/documentRecoveryJournal';
import {writeFileAtomic} from '@electron/file-access/documentFileWriteAtomic';
import {normalizePathForLookup} from '@electron/file-access/workingCopyStore';

const OCR_ROOT_MANIFEST_FILENAME = 'manifest.json';

function hasWorkingCopyIdentity(journalPath: unknown, workingCopyPath: string) {
    if (typeof journalPath !== 'string') {
        return false;
    }
    const normalizedJournalPath = normalizePathForLookup(journalPath);
    const normalizedWorkingCopyPath = normalizePathForLookup(workingCopyPath);
    return normalizedJournalPath.length > 0
        && normalizedJournalPath === normalizedWorkingCopyPath;
}

async function rollbackPreparedCatalog(descriptorPath: string, catalogRoot: string) {
    await rollbackPreparedOcrCatalogV4(descriptorPath, {catalogRoot});
}

async function restorePreparedRootManifest(
    workingCopyPath: string,
    backupPath: string | undefined,
    backupExisted: boolean,
) {
    const manifestPath = join(`${workingCopyPath}.ocr`, OCR_ROOT_MANIFEST_FILENAME);
    if (!backupExisted || !backupPath) {
        await rm(manifestPath, {force: true});
        return;
    }
    await copyFileAtomic(backupPath, manifestPath);
}

/** Recovers a crash-interrupted OCR apply to the pre-transition bytes/catalog. */
export async function recoverPreparedOcrRevisionTransition(workingCopyPath: string) {
    const journalPath = `${workingCopyPath}.ocr-transition.json`;
    const journal = await readDocumentRecoveryJournal(journalPath);
    if (journal === undefined) {
        return false;
    }
    if (
        isRecord(journal)
        && journal.version === 1
        && journal.state === 'committed'
        && hasWorkingCopyIdentity(journal.workingCopyPath, workingCopyPath)
        && typeof journal.transitionId === 'string'
        && typeof journal.targetDocumentRevisionToken === 'string'
        && typeof journal.undoPdfPath === 'string'
        && typeof journal.undoCatalogExisted === 'boolean'
        && (journal.undoCatalogPath === undefined || typeof journal.undoCatalogPath === 'string')
        && (!journal.undoCatalogExisted || typeof journal.undoCatalogPath === 'string')
        && (journal.catalogBackupMode === undefined
            || journal.catalogBackupMode === 'copy'
            || journal.catalogBackupMode === 'rename')
        && (journal.catalogApplyMode === undefined
            || journal.catalogApplyMode === 'copy'
            || journal.catalogApplyMode === 'rename')
        && (journal.catalogKind === undefined || journal.catalogKind === 'v4-root')
        && (journal.descriptorPath === undefined || typeof journal.descriptorPath === 'string')
        && ((journal.catalogKind === 'v4-root') === (typeof journal.descriptorPath === 'string'))
        && typeof journal.committedAt === 'number'
        && Number.isFinite(journal.committedAt)
    ) {
        return false;
    }
    if (!isRecord(journal) || journal.version !== 1 || journal.state !== 'prepared') {
        throw invalidDocumentRecoveryJournal(
            journalPath,
            undefined,
            'Invalid OCR revision transition recovery journal',
        );
    }
    if (
        typeof journal.workingCopyPath !== 'string'
        || !hasWorkingCopyIdentity(journal.workingCopyPath, workingCopyPath)
        || typeof journal.transitionId !== 'string'
        || typeof journal.pdfBackupPath !== 'string'
        || (journal.catalogBackupPath !== undefined && typeof journal.catalogBackupPath !== 'string')
        || (
            journal.catalogBackupMode !== undefined
            && journal.catalogBackupMode !== 'copy'
            && journal.catalogBackupMode !== 'rename'
            && journal.catalogBackupMode !== 'missing'
        )
        || (
            journal.catalogApplyMode !== undefined
            && journal.catalogApplyMode !== 'copy'
            && journal.catalogApplyMode !== 'rename'
        )
    ) {
        throw invalidDocumentRecoveryJournal(
            journalPath,
            undefined,
            'Invalid OCR revision transition recovery journal',
        );
    }
    const catalogBackupExisted = journal.catalogBackupExisted !== false;
    const isV4Prepared = journal.catalogKind === 'v4-root'
        || typeof journal.descriptorPath === 'string';
    if (isV4Prepared && typeof journal.descriptorPath !== 'string') {
        throw invalidDocumentRecoveryJournal(
            journalPath,
            undefined,
            'Invalid OCR v4 revision transition recovery journal',
        );
    }
    if (
        isV4Prepared
        && (
            typeof journal.resultPath !== 'string'
            || getOcrCatalogV4PreparedDescriptorPath(journal.resultPath) !== journal.descriptorPath
        )
    ) {
        throw invalidDocumentRecoveryJournal(
            journalPath,
            undefined,
            'Invalid OCR v4 revision transition recovery journal',
        );
    }
    if (!isV4Prepared && typeof journal.catalogBackupPath !== 'string') {
        throw invalidDocumentRecoveryJournal(
            journalPath,
            undefined,
            'Invalid OCR revision transition recovery journal',
        );
    }

    const currentRevision = await readWorkingCopyRevisionSidecar(workingCopyPath);
    if (
        typeof journal.targetDocumentRevisionToken === 'string'
        && currentRevision?.token === journal.targetDocumentRevisionToken
    ) {
        await writeFileAtomic(journalPath, Buffer.from(JSON.stringify({
            version: 1,
            transitionId: journal.transitionId,
            state: 'committed',
            workingCopyPath,
            targetDocumentRevisionToken: journal.targetDocumentRevisionToken,
            undoPdfPath: journal.pdfBackupPath,
            ...(typeof journal.catalogBackupPath === 'string'
                ? {undoCatalogPath: journal.catalogBackupPath}
                : {}),
            undoCatalogExisted: catalogBackupExisted,
            ...(journal.catalogBackupMode === 'copy' || journal.catalogBackupMode === 'rename'
                ? {catalogBackupMode: journal.catalogBackupMode}
                : {}),
            ...(journal.catalogApplyMode === 'copy' || journal.catalogApplyMode === 'rename'
                ? {catalogApplyMode: journal.catalogApplyMode}
                : {}),
            // The committed shape pairs the kind with the descriptor path;
            // dropping the path here made every later revision read of this
            // document fail closed.
            ...(isV4Prepared
                ? {
                    catalogKind: 'v4-root',
                    descriptorPath: journal.descriptorPath,
                }
                : {}),
            committedAt: Date.now(),
        }), 'utf8'));
        return true;
    }

    await copyFileAtomic(journal.pdfBackupPath, workingCopyPath);
    if (isV4Prepared) {
        await restorePreparedRootManifest(
            workingCopyPath,
            typeof journal.catalogBackupPath === 'string' ? journal.catalogBackupPath : undefined,
            catalogBackupExisted,
        );
        await rollbackPreparedCatalog(
            journal.descriptorPath as string,
            `${workingCopyPath}.ocr`,
        ).catch(() => undefined);
    } else {
        // A journal from before v4 staged a v3 catalog tree. v3 catalogs are
        // no longer read, so the rolled-back document keeps no catalog; its
        // OCR text is in the restored PDF.
        await rm(`${workingCopyPath}.ocr`, {
            recursive: true,
            force: true,
        });
    }
    await Promise.all([
        unlink(journal.pdfBackupPath).catch(() => undefined),
        ...(typeof journal.catalogBackupPath === 'string'
            ? [rm(journal.catalogBackupPath, {
                recursive: true,
                force: true,
            }).catch(() => undefined)]
            : []),
        unlink(journalPath).catch(() => undefined),
    ]);
    return true;
}
