import {
    basename,
    extname,
    resolve,
} from 'path';
import {
    createHash,
    randomUUID,
} from 'node:crypto';
import {createReadStream} from 'node:fs';
import { pipeline } from 'node:stream/promises';
import {
    lstat,
    readFile,
    rm,
    unlink,
} from 'node:fs/promises';
import {isErrnoException} from '@contracts/runtimeGuards';
import {requireDocumentRef} from '@contracts/documentRef';
import type {TDocumentRevisionToken} from '@contracts/documentRevision';
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
    findOcrResultForDocument,
    getOcrCatalogV4PreparedDescriptorPath,
    publishPreparedOcrCatalogV4,
    rollbackPreparedOcrCatalogV4,
} from '@electron/features/ocr/public/index';
import {parseOcrCatalogV4PreparedDescriptor} from '@contracts/ocrIndex';
import type { IDocumentsSenderIdContext } from '@electron/features/documents/documentsService';

interface IPreparedOcrCatalogDescriptor {
    catalogRoot: string;
    resultPath: string;
    resultIdentity: string;
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
    // Keep the type guard: test doubles of fs return other values.
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
    // The renderer registered this working copy under the spelling it holds,
    // and the revision event it receives echoes the ref the transition ran
    // under. On macOS the renderer holds `/var/...` while the realpath is
    // `/private/var/...`, so the mutation and the revision transition keep the
    // renderer's spelling like every other mutation handler. Only the catalog
    // root and the source PDF path handed to the catalog publish are canonical,
    // because the OCR job staged the generation under the realpath and the
    // publish fences on that spelling.
    const canonicalWorkingCopyPath = normalizePathForLookup(allowedWorkingCopyPath);
    if (await resolveAllowedWritePath(canonicalWorkingCopyPath) !== canonicalWorkingCopyPath) {
        throw new Error('Invalid file path: writes only allowed within temp directory');
    }
    const resolvedWorkingCopyPath = allowedWorkingCopyPath;
    // Read validation already returns a canonical real path. Reuse that form
    // for the prepared descriptor binding and every later source operation.
    const resolvedSourcePath = allowedSourcePath;
    assertOcrPdfResultSourcePath(resolvedSourcePath);

    return enqueueWorkingCopyMutation(resolvedWorkingCopyPath, async () => {
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
        const pendingResult = findOcrResultForDocument(
            resolvedSourcePath,
            requireDocumentRef(resolvedWorkingCopyPath),
            expectedDocumentRevisionToken,
        );
        if (!pendingResult) {
            throw new Error('Invalid source path: OCR result is not authorized for this document revision');
        }
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
        const catalogPath = `${canonicalWorkingCopyPath}.ocr`;
        const stagedDescriptorPath = getOcrCatalogV4PreparedDescriptorPath(resolvedSourcePath);
        const catalogBackupPath = `${catalogPath}.transition-${transitionSuffix}.bak`;
        if (!await readPreparedOcrCatalogDescriptor(
            stagedDescriptorPath,
            resolvedSourcePath,
            pendingResult.resultSha256,
            catalogPath,
        )) {
            throw new Error('OCR result has no prepared text catalog');
        }

        await copyFileAtomic(resolvedWorkingCopyPath, pdfBackupPath);
        let catalogBackupExisted = false;
        try {
            const previousManifest = await readExistingOcrCatalogManifest(catalogPath);
            if (previousManifest !== null) {
                await writeFileAtomic(catalogBackupPath, previousManifest);
                catalogBackupExisted = true;
            }
        } catch (error) {
            await Promise.all([
                unlink(pdfBackupPath).catch(() => undefined),
                rm(catalogBackupPath, {force: true}).catch(() => undefined),
            ]);
            throw error;
        }
        const preparedJournal = (targetDocumentRevisionToken?: TDocumentRevisionToken) => Buffer.from(JSON.stringify({
            version: 1,
            transitionId,
            state: 'prepared',
            workingCopyPath: resolvedWorkingCopyPath,
            resultPath: resolvedSourcePath,
            expectedDocumentRevisionToken,
            ...(targetDocumentRevisionToken === undefined ? {} : {targetDocumentRevisionToken}),
            pdfBackupPath,
            catalogBackupPath,
            catalogBackupExisted,
            catalogKind: 'v4-root',
            descriptorPath: stagedDescriptorPath,
            createdAt: Date.now(),
        }), 'utf8');
        await writeFileAtomic(journalPath, preparedJournal());
        let transitionPublished = false;
        try {
            const transitionEvent = await transitionWorkingCopyContentRevision(
                resolvedWorkingCopyPath,
                'ocr-apply',
                async nextRevision => {
                    try {
                        await writeFileAtomic(journalPath, preparedJournal(nextRevision.token));
                        await copyFileAtomic(resolvedSourcePath, resolvedWorkingCopyPath);
                        await publishPreparedOcrCatalog({
                            descriptorPath: stagedDescriptorPath,
                            catalogRoot: catalogPath,
                            workingCopyPath: canonicalWorkingCopyPath,
                            nextRevisionToken: nextRevision.token,
                            resultPath: resolvedSourcePath,
                            resultIdentity: pendingResult.resultSha256,
                        });
                        await clearWorkingCopySearchArtifacts(resolvedWorkingCopyPath);
                    } catch (error) {
                        await copyFileAtomic(pdfBackupPath, resolvedWorkingCopyPath).catch(() => undefined);
                        await restorePreparedRootManifest(
                            catalogPath,
                            catalogBackupPath,
                            catalogBackupExisted,
                        ).catch(() => undefined);
                        await rollbackPreparedOcrCatalog(stagedDescriptorPath, catalogPath).catch(() => undefined);
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
                catalogKind: 'v4-root',
                descriptorPath: stagedDescriptorPath,
                committedAt: Date.now(),
            }), 'utf8'));
        } finally {
            if (!transitionPublished) {
                await Promise.all([
                    unlink(pdfBackupPath).catch(() => undefined),
                    rm(catalogBackupPath, {force: true}).catch(() => undefined),
                    unlink(journalPath).catch(() => undefined),
                ]);
            }
        }
        if (shouldRefreshOriginalSaveBase) {
            if (!await refreshWorkingCopyOriginalFileExpectation(resolvedWorkingCopyPath, senderId)) {
                throw new Error('Working copy registration changed before original expectation refresh completed');
            }
        }
        return true;
    });
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
