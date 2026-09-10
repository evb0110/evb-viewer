import {
    basename,
    extname,
    join,
    resolve,
} from 'path';
import {
    createHash,
    randomUUID,
} from 'node:crypto';
import {createReadStream} from 'node:fs';
import { pipeline } from 'node:stream/promises';
import {
    cp,
    lstat,
    readFile,
    readdir,
    rename,
    rm,
    unlink,
} from 'node:fs/promises';
import {isErrnoException} from '@contracts/runtimeGuards';
import {requireDocumentRef} from '@contracts/documentRef';
import type {TDocumentRevisionToken} from '@contracts/documentRevision';
import type {TRequestId} from '@contracts/shared';
import {
    resolveAllowedReadPath,
    resolveAllowedWritePath,
} from '@electron/utils/pathValidator';
import {
    clearWorkingCopySearchArtifacts,
    enqueueWorkingCopyMutation,
} from '@electron/file-access/workingCopyMutationQueue';
import {ensureWorkingCopyMaterialized} from '@electron/file-access/workingCopyMaterialization';
import type { IDocumentMutationRevisionOptions } from '@contracts/electronApiDocuments';
import {transitionWorkingCopyContentRevision} from '@electron/file-access/documentRevisionStore';
import {
    assertQueuedWorkingCopyMutationPreconditions,
    normalizeExpectedDocumentRevisionToken,
} from '@electron/file-access/documentMutationGuards';
import { consumeAllowedDocxWritePath } from '@electron/file-access/docxExportPaths';
import {
    copyFileAtomic,
    normalizeIpcWritePayload,
    writeFileAtomic,
} from '@electron/file-access/documentFileWriteAtomic';
import {
    atomicReplace,
    makeSiblingTempPath,
} from '@electron/utils/atomicReplace';
import {validatePdfFile} from '@electron/features/documents/main/pdfConformance';
import { normalizeNonEmptyPath } from '@electron/features/documents/main/documentFilePathResolution';
import {
    getWorkingCopyOriginalPath,
    normalizePathForLookup,
    refreshWorkingCopyOriginalFileExpectation,
} from '@electron/file-access/workingCopyStore';
import { originalPathSaveBaseMatches } from '@electron/file-access/originalPathSaveWitness';
import {
    claimPendingOcrResultForDocument,
    releasePendingOcrResultClaim,
    rebindDocumentTextCatalogRevision,
    getOcrCatalogV4PreparedDescriptorPath,
    publishPreparedOcrCatalogV4,
    rollbackPreparedOcrCatalogV4,
} from '@electron/features/ocr/public/index';
import {parseOcrCatalogV4PreparedDescriptor} from '@contracts/ocrIndex';
import {
    MAX_LEGACY_OCR_CATALOG_BACKUP_BYTES,
    MAX_LEGACY_OCR_CATALOG_FILES,
} from '@electron/file-access/workingCopyContentTransitionJournal';
import type { IDocumentsSenderIdContext } from '@electron/features/documents/documentsService';

interface IPreparedOcrCatalogDescriptor {
    catalogRoot: string;
    resultPath: string;
    resultIdentity: string;
}

type TLegacyOcrCatalogTransferMode = 'copy' | 'rename' | 'missing';

async function getLegacyOcrCatalogTransferMode(catalogPath: string): Promise<TLegacyOcrCatalogTransferMode> {
    let totalBytes = 0;
    let fileCount = 0;
    const pending = [catalogPath];
    while (pending.length > 0) {
        const currentPath = pending.pop()!;
        const currentStat = await lstat(currentPath).catch(error => {
            if (isErrnoException(error) && error.code === 'ENOENT') {
                return null;
            }
            throw error;
        });
        if (currentStat === null) {
            return currentPath === catalogPath ? 'missing' : 'copy';
        }
        if (currentStat.isSymbolicLink()) {
            throw new Error(`OCR legacy catalog contains a symbolic link: ${currentPath}`);
        }
        if (typeof currentStat.isDirectory === 'function' && currentStat.isDirectory()) {
            const entries = await readdir(currentPath);
            if (entries.length > MAX_LEGACY_OCR_CATALOG_FILES) {
                return 'rename';
            }
            for (const entry of entries) {
                fileCount += 1;
                if (fileCount > MAX_LEGACY_OCR_CATALOG_FILES) {
                    return 'rename';
                }
                pending.push(join(currentPath, entry));
            }
            continue;
        }
        if (typeof currentStat.isFile === 'function' && !currentStat.isFile()) {
            throw new Error(`OCR legacy catalog contains a non-file entry: ${currentPath}`);
        }
        totalBytes += typeof currentStat.size === 'number' ? currentStat.size : 0;
        if (totalBytes > MAX_LEGACY_OCR_CATALOG_BACKUP_BYTES) {
            return 'rename';
        }
    }
    return 'copy';
}

async function readPreparedOcrCatalogDescriptor(
    descriptorPath: string,
    resultPath: string,
    resultIdentity: string,
    catalogRoot: string,
): Promise<IPreparedOcrCatalogDescriptor | null> {
    const descriptorStat = await lstat(descriptorPath).catch(error => {
        if (isErrnoException(error) && (error.code === 'ENOENT' || error.code === 'EISDIR')) {
            return null;
        }
        throw error;
    });
    if (descriptorStat?.isSymbolicLink()) {
        throw new Error('Invalid staged OCR catalog descriptor path');
    }
    if (
        descriptorStat
        && typeof descriptorStat.isFile === 'function'
        && !descriptorStat.isFile()
    ) {
        return null;
    }
    const raw = await readFile(descriptorPath, 'utf8').catch(() => null);
    // A directory at this path is the legacy v3 sidecar. The real fs API
    // returns a string for the descriptor; keeping the type guard also makes
    // this transition tolerant of old preload/test doubles.
    if (typeof raw !== 'string') {
        return null;
    }
    let value: unknown;
    try {
        value = JSON.parse(raw) as unknown;
    } catch {
        throw new Error('Invalid staged OCR catalog descriptor');
    }
    const descriptor = parseOcrCatalogV4PreparedDescriptor(value);
    if (!descriptor) {
        throw new Error('Invalid staged OCR catalog descriptor');
    }
    if (
        resolve(descriptor.catalogRoot) !== resolve(catalogRoot)
        || resolve(descriptor.resultPath) !== resolve(resultPath)
        || descriptor.resultIdentity !== resultIdentity
    ) {
        throw new Error('Invalid staged OCR catalog descriptor binding');
    }
    return descriptor;
}

async function readExistingOcrCatalogManifest(catalogPath: string) {
    const manifestPath = `${catalogPath}/manifest.json`;
    const manifestStat = await lstat(manifestPath).catch(error => {
        if (isErrnoException(error) && error.code === 'ENOENT') {
            return null;
        }
        throw error;
    });
    if (manifestStat?.isSymbolicLink()) {
        throw new Error('Invalid OCR catalog root manifest path');
    }
    if (
        manifestStat
        && typeof manifestStat.isFile === 'function'
        && !manifestStat.isFile()
    ) {
        return null;
    }
    const raw = await readFile(manifestPath, 'utf8').catch(() => null);
    if (raw === null) {
        return null;
    }
    if (typeof raw !== 'string' && !Buffer.isBuffer(raw)) {
        return null;
    }
    return Buffer.isBuffer(raw) ? raw : Buffer.from(raw, 'utf8');
}

async function publishPreparedOcrCatalog(options: {
    descriptorPath: string;
    catalogRoot: string;
    workingCopyPath: string;
    nextRevisionToken: TDocumentRevisionToken;
    resultPath: string;
    resultIdentity: string;
}) {
    return publishPreparedOcrCatalogV4({
        descriptor: options.descriptorPath,
        catalogRoot: options.catalogRoot,
        resultPath: options.resultPath,
        resultIdentity: options.resultIdentity,
        sourcePdfPath: options.workingCopyPath,
        nextRevision: options.nextRevisionToken,
        descriptorPath: options.descriptorPath,
    });
}

async function rollbackPreparedOcrCatalog(descriptorPath: string, catalogRoot: string) {
    await rollbackPreparedOcrCatalogV4(descriptorPath, {catalogRoot});
}

async function restorePreparedRootManifest(
    catalogRoot: string,
    backupPath: string,
    backupExisted: boolean,
) {
    const manifestPath = `${catalogRoot}/manifest.json`;
    if (!backupExisted) {
        await rm(manifestPath, {force: true});
        return;
    }
    await copyFileAtomic(backupPath, manifestPath);
}

function requireSenderId(context: IDocumentsSenderIdContext) {
    if (typeof context.senderId !== 'number') {
        throw new Error('Missing sender identity');
    }
    return context.senderId;
}

async function sha256File(path: string) {
    const hash = createHash('sha256');
    await pipeline(createReadStream(path), hash);
    return hash.digest('hex');
}

function assertOcrPdfResultSourcePath(resolvedPath: string) {
    const fileName = basename(resolvedPath).toLowerCase();
    if (extname(fileName) !== '.pdf') {
        throw new Error('Invalid source path: OCR result must be a PDF');
    }
    if (!fileName.startsWith('ocr-') && !fileName.startsWith('searchable-')) {
        throw new Error('Invalid source path: only OCR result files can replace a working copy');
    }
}

async function shouldRefreshOriginalSaveBaseAfterWorkingCopyReplacement(
    workingCopyPath: string,
    senderWebContentsId: number,
) {
    const mapping = getWorkingCopyOriginalPath(workingCopyPath, senderWebContentsId);
    if (!mapping) {
        return false;
    }

    return originalPathSaveBaseMatches(workingCopyPath, mapping.originalPath, senderWebContentsId);
}

export async function handleFileWrite(
    context: IDocumentsSenderIdContext,
    filePath: unknown,
    data: unknown,
    options?: IDocumentMutationRevisionOptions,
) {
    const senderId = requireSenderId(context);
    const normalizedPath = normalizeNonEmptyPath(filePath);
    const payload = normalizeIpcWritePayload(data);
    const expectedDocumentRevisionToken = normalizeExpectedDocumentRevisionToken(options);

    const resolvedPath = await resolveAllowedWritePath(normalizedPath);
    if (!resolvedPath) {
        throw new Error('Invalid file path: writes only allowed within temp directory');
    }

    return enqueueWorkingCopyMutation(resolvedPath, async () => {
        await assertQueuedWorkingCopyMutationPreconditions(resolvedPath, expectedDocumentRevisionToken);
        await ensureWorkingCopyMaterialized(resolvedPath, {
            ownerWebContentsId: senderId,
            reason: 'first-mutation',
        });
        const tempPath = makeSiblingTempPath(resolvedPath);
        let committed = false as boolean;
        try {
            await writeFileAtomic(tempPath, payload);
            const validation = await validatePdfFile(tempPath);
            if (!validation.isValid) {
                throw new Error(`PDF write verification failed: ${validation.errors.join('; ')}`);
            }
            await transitionWorkingCopyContentRevision(
                resolvedPath,
                'write',
                async () => {
                    await atomicReplace(tempPath, resolvedPath);
                    committed = true;
                },
                senderId,
            );
        } finally {
            if (!committed) await unlink(tempPath).catch(() => undefined);
        }
        return true;
    });
}

export async function handleReplaceWorkingCopyFromPath(
    context: IDocumentsSenderIdContext,
    workingCopyPath: unknown,
    sourcePath: unknown,
    options?: IDocumentMutationRevisionOptions,
) {
    const senderId = requireSenderId(context);
    const normalizedWorkingCopyPath = normalizeNonEmptyPath(workingCopyPath);
    const normalizedSourcePath = normalizeNonEmptyPath(sourcePath);
    const expectedDocumentRevisionToken = normalizeExpectedDocumentRevisionToken(options);

    const allowedWorkingCopyPath = await resolveAllowedWritePath(normalizedWorkingCopyPath);
    if (!allowedWorkingCopyPath) {
        throw new Error('Invalid file path: writes only allowed within temp directory');
    }
    const allowedSourcePath = await resolveAllowedReadPath(normalizedSourcePath);
    if (!allowedSourcePath) {
        throw new Error('Invalid source path: OCR result must be within temp directory');
    }
    const canonicalWorkingCopyPath = normalizePathForLookup(allowedWorkingCopyPath);
    const resolvedWorkingCopyPath = await resolveAllowedWritePath(canonicalWorkingCopyPath);
    if (resolvedWorkingCopyPath !== canonicalWorkingCopyPath) {
        throw new Error('Invalid file path: writes only allowed within temp directory');
    }
    // Read validation already returns a canonical real path. Reuse that form
    // for the prepared descriptor binding and every later source operation.
    const resolvedSourcePath = allowedSourcePath;
    assertOcrPdfResultSourcePath(resolvedSourcePath);
    let claimedRequestId: TRequestId | null = null;

    try {
        return await enqueueWorkingCopyMutation(resolvedWorkingCopyPath, async () => {
            await assertQueuedWorkingCopyMutationPreconditions(
                resolvedWorkingCopyPath,
                expectedDocumentRevisionToken,
            );
            await ensureWorkingCopyMaterialized(resolvedWorkingCopyPath, {
                ownerWebContentsId: senderId,
                reason: 'ocr-persist',
            });
            if (!expectedDocumentRevisionToken) {
                throw new Error('OCR apply requires the source document revision');
            }
            const claim = claimPendingOcrResultForDocument(
                senderId,
                resolvedSourcePath,
                requireDocumentRef(resolvedWorkingCopyPath),
                expectedDocumentRevisionToken,
            );
            if (claim.status === 'already-claimed') {
                throw new Error('OCR result is already claimed by another document owner');
            }
            if (claim.status !== 'claimed' || !claim.entry) {
                throw new Error('Invalid source path: OCR result is not authorized for this document revision');
            }
            const pendingResult = claim.entry;
            claimedRequestId = pendingResult.requestId;
            const journalPath = `${resolvedWorkingCopyPath}.ocr-transition.json`;
            const priorTransition = await readFile(journalPath, 'utf8')
                .then(raw => JSON.parse(raw) as {
                    transitionId?: unknown;
                    state?: unknown
                })
                .catch(() => null);
            if (priorTransition?.transitionId === pendingResult.requestId && priorTransition.state === 'committed') {
                return true;
            }
            if (await sha256File(resolvedSourcePath) !== pendingResult.resultSha256) {
                throw new Error('OCR result content hash does not match the verified worker result');
            }
            const shouldRefreshOriginalSaveBase = await shouldRefreshOriginalSaveBaseAfterWorkingCopyReplacement(
                resolvedWorkingCopyPath,
                senderId,
            );
            const transitionId = pendingResult.requestId;
            const transitionSuffix = `${process.pid}-${randomUUID()}`;
            const pdfBackupPath = `${resolvedWorkingCopyPath}.ocr-transition-${transitionSuffix}.bak`;
            const catalogPath = `${resolvedWorkingCopyPath}.ocr`;
            const stagedCatalogPath = `${resolvedSourcePath}.ocr`;
            const stagedDescriptorPath = getOcrCatalogV4PreparedDescriptorPath(resolvedSourcePath);
            const catalogBackupPath = `${catalogPath}.transition-${transitionSuffix}.bak`;
            const preparedDescriptor = await readPreparedOcrCatalogDescriptor(
                stagedDescriptorPath,
                resolvedSourcePath,
                pendingResult.resultSha256,
                catalogPath,
            );

            await copyFileAtomic(resolvedWorkingCopyPath, pdfBackupPath);
            let catalogBackupExisted = false;
            let legacyCatalogBackupMode: TLegacyOcrCatalogTransferMode = 'missing';
            let legacyCatalogApplyMode: Exclude<TLegacyOcrCatalogTransferMode, 'missing'> = 'copy';
            let legacyCatalogBackupMoved = false;
            try {
                if (preparedDescriptor) {
                    const previousManifest = await readExistingOcrCatalogManifest(catalogPath);
                    if (previousManifest !== null) {
                        await writeFileAtomic(catalogBackupPath, previousManifest);
                        catalogBackupExisted = true;
                    }
                } else {
                    legacyCatalogBackupMode = await getLegacyOcrCatalogTransferMode(catalogPath);
                    catalogBackupExisted = legacyCatalogBackupMode !== 'missing';
                    legacyCatalogApplyMode = (await getLegacyOcrCatalogTransferMode(stagedCatalogPath)) === 'rename'
                        ? 'rename'
                        : 'copy';
                    if (legacyCatalogBackupMode === 'copy') {
                        try {
                            await cp(catalogPath, catalogBackupPath, {recursive: true});
                        } catch (error) {
                            if (!isErrnoException(error) || error.code !== 'ENOENT') {
                                throw error;
                            }
                            catalogBackupExisted = false;
                            legacyCatalogBackupMode = 'missing';
                        }
                    }
                }
            } catch (error) {
                await Promise.all([
                    unlink(pdfBackupPath).catch(() => undefined),
                    Promise.resolve(rm(catalogBackupPath, {
                        recursive: true,
                        force: true,
                    })).catch(() => undefined),
                ]);
                throw error;
            }
            await writeFileAtomic(journalPath, Buffer.from(JSON.stringify({
                version: 1,
                transitionId,
                state: 'prepared',
                workingCopyPath: resolvedWorkingCopyPath,
                resultPath: resolvedSourcePath,
                expectedDocumentRevisionToken,
                pdfBackupPath,
                catalogBackupPath,
                catalogBackupExisted,
                ...(!preparedDescriptor ? {
                    catalogBackupMode: legacyCatalogBackupMode,
                    catalogApplyMode: legacyCatalogApplyMode,
                } : {}),
                ...(preparedDescriptor ? {
                    catalogKind: 'v4-root',
                    descriptorPath: stagedDescriptorPath,
                } : {}),
                createdAt: Date.now(),
            }), 'utf8'));
            let transitionPublished = false;
            try {
                const transitionEvent = await transitionWorkingCopyContentRevision(
                    resolvedWorkingCopyPath,
                    'ocr-apply',
                    async nextRevision => {
                        try {
                            await writeFileAtomic(journalPath, Buffer.from(JSON.stringify({
                                version: 1,
                                transitionId,
                                state: 'prepared',
                                workingCopyPath: resolvedWorkingCopyPath,
                                resultPath: resolvedSourcePath,
                                expectedDocumentRevisionToken,
                                targetDocumentRevisionToken: nextRevision.token,
                                pdfBackupPath,
                                catalogBackupPath,
                                catalogBackupExisted,
                                ...(!preparedDescriptor ? {
                                    catalogBackupMode: legacyCatalogBackupMode,
                                    catalogApplyMode: legacyCatalogApplyMode,
                                } : {}),
                                ...(preparedDescriptor ? {
                                    catalogKind: 'v4-root',
                                    descriptorPath: stagedDescriptorPath,
                                } : {}),
                                createdAt: Date.now(),
                            }), 'utf8'));
                            await copyFileAtomic(resolvedSourcePath, resolvedWorkingCopyPath);
                            if (preparedDescriptor) {
                                await publishPreparedOcrCatalog({
                                    descriptorPath: stagedDescriptorPath,
                                    catalogRoot: catalogPath,
                                    workingCopyPath: resolvedWorkingCopyPath,
                                    nextRevisionToken: nextRevision.token,
                                    resultPath: resolvedSourcePath,
                                    resultIdentity: pendingResult.resultSha256,
                                });
                            } else {
                                if (legacyCatalogBackupMode === 'rename') {
                                    await rename(catalogPath, catalogBackupPath);
                                    legacyCatalogBackupMoved = true;
                                }
                                await rm(catalogPath, {
                                    recursive: true,
                                    force: true,
                                });
                                if (legacyCatalogApplyMode === 'rename') {
                                    await rename(stagedCatalogPath, catalogPath);
                                } else {
                                    await cp(stagedCatalogPath, catalogPath, {recursive: true});
                                }
                                await rebindDocumentTextCatalogRevision(
                                    resolvedWorkingCopyPath,
                                    expectedDocumentRevisionToken,
                                    nextRevision.token,
                                );
                            }
                            await clearWorkingCopySearchArtifacts(resolvedWorkingCopyPath);
                        } catch (error) {
                            await copyFileAtomic(pdfBackupPath, resolvedWorkingCopyPath).catch(() => undefined);
                            if (preparedDescriptor) {
                                await restorePreparedRootManifest(
                                    catalogPath,
                                    catalogBackupPath,
                                    catalogBackupExisted,
                                ).catch(() => undefined);
                                await rollbackPreparedOcrCatalog(stagedDescriptorPath, catalogPath).catch(() => undefined);
                            } else {
                                if (legacyCatalogBackupMode !== 'rename' || legacyCatalogBackupMoved) {
                                    await rm(catalogPath, {
                                        recursive: true,
                                        force: true,
                                    }).catch(() => undefined);
                                }
                                if (catalogBackupExisted && (legacyCatalogBackupMode !== 'rename' || legacyCatalogBackupMoved)) {
                                    if (legacyCatalogBackupMode === 'rename') {
                                        await rename(catalogBackupPath, catalogPath).catch(() => undefined);
                                    } else {
                                        await cp(catalogBackupPath, catalogPath, {recursive: true}).catch(() => undefined);
                                    }
                                }
                            }
                            throw error;
                        }
                    },
                    senderId,
                );
                transitionPublished = true;
                await writeFileAtomic(journalPath, Buffer.from(JSON.stringify({
                    version: 1,
                    transitionId,
                    state: 'committed',
                    workingCopyPath: resolvedWorkingCopyPath,
                    targetDocumentRevisionToken: transitionEvent.token,
                    undoPdfPath: pdfBackupPath,
                    undoCatalogPath: catalogBackupPath,
                    undoCatalogExisted: catalogBackupExisted,
                    ...(!preparedDescriptor ? {
                        catalogBackupMode: legacyCatalogBackupMode,
                        catalogApplyMode: legacyCatalogApplyMode,
                    } : {}),
                    ...(preparedDescriptor ? {
                        catalogKind: 'v4-root',
                        descriptorPath: stagedDescriptorPath,
                    } : {}),
                    committedAt: Date.now(),
                }), 'utf8'));
            } finally {
                await Promise.all([
                    ...(transitionPublished ? [] : [unlink(pdfBackupPath).catch(() => undefined)]),
                    ...(transitionPublished ? [] : [rm(catalogBackupPath, {
                        recursive: true,
                        force: true,
                    }).catch(() => undefined)]),
                    ...(transitionPublished ? [] : [unlink(journalPath).catch(() => undefined)]),
                ]);
            }
            if (shouldRefreshOriginalSaveBase) {
                if (!await refreshWorkingCopyOriginalFileExpectation(resolvedWorkingCopyPath, senderId)) {
                    throw new Error('Working copy registration changed before original expectation refresh completed');
                }
            }
            return true;
        });
    } catch (error) {
        if (claimedRequestId !== null) {
            releasePendingOcrResultClaim(senderId, claimedRequestId);
        }
        throw error;
    }
}

export async function handleFileWriteDocx(
    context: IDocumentsSenderIdContext,
    filePath: unknown,
    data: unknown,
) {
    const senderId = requireSenderId(context);
    const normalizedPath = normalizeNonEmptyPath(filePath);
    const payload = normalizeIpcWritePayload(data);
    if (!consumeAllowedDocxWritePath(normalizedPath, senderId)) {
        throw new Error('Invalid file path: DOCX writes must use a path from Save dialog');
    }

    await writeFileAtomic(resolve(normalizedPath), payload);
    return true;
}
