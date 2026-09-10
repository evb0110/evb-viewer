import {
    cp,
    lstat,
    readdir,
    rename,
    rm,
    unlink,
} from 'node:fs/promises';
import {join} from 'node:path';
import {copyFileAtomic} from '@electron/features/documents/public/index';
import {isRecord} from '@contracts/runtimeGuards';
import {readWorkingCopyRevisionSidecar} from '@electron/file-access/documentRevisionSidecar';
import {
    MAX_LEGACY_OCR_CATALOG_BACKUP_BYTES,
    MAX_LEGACY_OCR_CATALOG_FILES,
} from '@electron/file-access/workingCopyContentTransitionJournal';
import {
    getOcrCatalogV4PreparedDescriptorPath,
    rollbackPreparedOcrCatalogV4,
} from '@electron/features/ocr/worker/indexWriterV4';
import {
    invalidDocumentRecoveryJournal,
    readDocumentRecoveryJournal,
} from '@electron/file-access/documentRecoveryJournal';
import {writeFileAtomic} from '@electron/file-access/documentFileWriteAtomic';

const OCR_ROOT_MANIFEST_FILENAME = 'manifest.json';

async function isLegacyCatalogWithinBudget(path: string) {
    let totalBytes = 0;
    let fileCount = 0;
    const pending = [path];
    while (pending.length > 0) {
        const currentPath = pending.pop()!;
        const currentStat = await lstat(currentPath);
        if (currentStat.isSymbolicLink()) {
            throw new Error(`OCR legacy catalog contains a symbolic link: ${currentPath}`);
        }
        if (currentStat.isDirectory()) {
            const entries = await readdir(currentPath);
            if (entries.length > MAX_LEGACY_OCR_CATALOG_FILES) {
                return false;
            }
            for (const entry of entries) {
                fileCount += 1;
                if (fileCount > MAX_LEGACY_OCR_CATALOG_FILES) {
                    return false;
                }
                pending.push(join(currentPath, entry));
            }
            continue;
        }
        if (!currentStat.isFile()) {
            throw new Error(`OCR legacy catalog contains a non-file entry: ${currentPath}`);
        }
        totalBytes += currentStat.size;
        if (totalBytes > MAX_LEGACY_OCR_CATALOG_BACKUP_BYTES) {
            return false;
        }
    }
    return true;
}

type TLegacyCatalogTransferMode = 'copy' | 'rename' | 'missing';

async function legacyCatalogPathExists(path: string) {
    return lstat(path)
        .then(() => true)
        .catch(error => {
            if (isRecord(error) && error.code === 'ENOENT') {
                return false;
            }
            throw error;
        });
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
        && journal.workingCopyPath === workingCopyPath
        && typeof journal.transitionId === 'string'
        && typeof journal.targetDocumentRevisionToken === 'string'
        && typeof journal.undoPdfPath === 'string'
        && typeof journal.undoCatalogExisted === 'boolean'
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
        || journal.workingCopyPath !== workingCopyPath
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
            ...(isV4Prepared ? {catalogKind: 'v4-root'} : {}),
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
        if (!catalogBackupExisted) {
            await rm(`${workingCopyPath}.ocr`, {
                recursive: true,
                force: true,
            });
        } else {
            const legacyBackupPath = journal.catalogBackupPath as string;
            const backupMode: TLegacyCatalogTransferMode = journal.catalogBackupMode === 'rename'
                ? 'rename'
                : journal.catalogBackupMode === 'copy'
                    ? 'copy'
                    : await isLegacyCatalogWithinBudget(legacyBackupPath)
                        ? 'copy'
                        : 'rename';
            if (backupMode === 'rename') {
                // A large v3 backup sits beside the working root. Promote it
                // by rename so rollback stays O(1) in catalog bytes.
                if (await legacyCatalogPathExists(legacyBackupPath)) {
                    await rm(`${workingCopyPath}.ocr`, {
                        recursive: true,
                        force: true,
                    });
                    await rename(legacyBackupPath, `${workingCopyPath}.ocr`);
                }
            } else {
                await rm(`${workingCopyPath}.ocr`, {
                    recursive: true,
                    force: true,
                });
                await cp(legacyBackupPath, `${workingCopyPath}.ocr`, {recursive: true});
            }
        }
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
