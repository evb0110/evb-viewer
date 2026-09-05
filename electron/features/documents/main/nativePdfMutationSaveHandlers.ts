import {
    mkdtemp,
    readFile,
    rm,
    stat,
    writeFile,
} from 'fs/promises';
import { tmpdir } from 'os';
import { performance } from 'perf_hooks';
import {
    basename,
    dirname,
    join,
} from 'path';
import type {
    IDocumentMutationRevisionOptions,
    IPdfNativeMutationSet,
    IPdfNativeStagedCommitOptions,
    IPdfNativeNoteTextSaveResult,
} from '@contracts/electronApiDocuments';
import {
    collectExpectedNativeIdentityIds,
    splitPdfNativeMutationSetIntoBoundedChunks,
} from '@contracts/nativePdfMutations';
import type { IPdfValidationResult } from '@contracts/pdfConformance';
import type { ITypedStagedArtifact } from '@contracts/stagedArtifacts';
import {
    normalizePdfNativeModifiedAt,
    normalizePdfNativeAnnotationIdentityBindings,
    normalizePdfNativeMutationSet,
    normalizePdfNativeNoteChanges,
    normalizePdfNativeNoteTextUpdates,
    type TPdfNativeMutationSetNativeToolPayload,
} from '@pdf-core';
import { isErrnoException } from '@contracts/runtimeGuards';
import {hasNativeErrorCode} from '@contracts/nativeErrors';
import { runNativeToolCommand } from '@electron/native-tools/runNativeToolCommand';
import {getPdfNativeToolPaths} from '@electron/pdf/nativeToolPaths';
import {
    isNativePageOpsDisabled,
    resolveNativePageOpsPath,
} from '@electron/features/page-ops/public';
import {
    getWorkingCopyOriginalPath,
    refreshWorkingCopyOriginalFileExpectation,
} from '@electron/file-access/workingCopyStore';
import {publishImmutableFileAtomic} from '@electron/file-access/documentFileWriteAtomic';
import { isAllowedOriginalSavePath } from '@electron/file-access/isAllowedOriginalSavePath';
import { ensureWorkingCopyDirectory } from '@electron/file-access/workingCopyCreation';
import {ensureWorkingCopyMaterialized} from '@electron/file-access/workingCopyMaterialization';
import {
    atomicReplace,
    makeSiblingTempPath,
} from '@electron/utils/atomicReplace';
import {
    enqueueWorkingCopyMutation,
    type IWorkingCopyMutationOperation,
} from '@electron/file-access/workingCopyMutationQueue';
import {
    assertQueuedWorkingCopyMutationPreconditions,
    normalizeExpectedDocumentRevisionToken,
} from '@electron/file-access/documentMutationGuards';
import { copyFileCopyOnWrite } from '@electron/file-access/workingCopyDirectory';
import { createLogger } from '@electron/utils/createLogger';
import { getErrorMessage } from '@electron/utils/error';
import {captureOriginalPathSaveWitness} from '@electron/file-access/originalPathSaveWitness';
import {transitionOriginalAndWorkingCopyRevision} from '@electron/features/documents/main/transitionOriginalAndWorkingCopyRevision';
import {createNativeIncrementalMutationSemanticScopeSha256} from '@electron/features/documents/main/documentSaveUtilityProtocol';
import type { IDocumentsSenderIdContext } from '@electron/features/documents/documentsService';
import {
    createOpaqueNativePdfStagedArtifact,
    releaseManagedTempFileHandle,
    resolveManagedTempFileHandle,
    resolveTypedStagedArtifact,
} from '@electron/features/documents/main/managedTempFileHandles';
import {withLargePdfMutationAdmission} from '@electron/features/documents/main/withLargePdfMutationAdmission';

const PDF_NATIVE_MUTATION_TIMEOUT_MS = 2 * 60 * 1000;
const log = createLogger('native-note-text-save');

interface INativeNoteCommandOptions {
    command: 'update-note-text' | 'save-note-changes' | 'save-mutations';
    payloadFileName: string;
    payloadFlag: '--updates-file' | '--changes-file' | '--mutations-file';
    payload: unknown;
    commandLabel: string;
    identityBindingsFileName?: string;
}

interface INativeNotePhaseTiming {
    phase: string;
    durationMs: number;
    startedAtEpochMs?: number;
    endedAtEpochMs?: number;
}

function resolveNativeNoteCommandExecution(
    context: IDocumentsSenderIdContext,
    workingPath: unknown,
    rawModifiedAt: unknown,
    revisionOptions: IDocumentMutationRevisionOptions | undefined,
) {
    const senderId = requireSenderId(context);
    const normalizedWorkingPath = normalizeWorkingPath(workingPath);
    const modifiedAt = normalizeModifiedAt(rawModifiedAt);
    const expectedDocumentRevisionToken = normalizeExpectedDocumentRevisionToken(revisionOptions);
    if (isNativePageOpsDisabled()) {
        return null;
    }
    const binaryPath = resolveNativePageOpsPath();
    if (!binaryPath) {
        return null;
    }
    return {
        senderId,
        normalizedWorkingPath,
        modifiedAt,
        expectedDocumentRevisionToken,
        binaryPath,
    };
}

async function enterQueuedNativeNoteCommand(
    workingPath: string,
    senderId: number,
    expectedDocumentRevisionToken: ReturnType<typeof normalizeExpectedDocumentRevisionToken>,
) {
    const phaseTimings: INativeNotePhaseTiming[] = [];
    const operationStart = performance.now();
    await assertQueuedWorkingCopyMutationPreconditions(
        workingPath,
        expectedDocumentRevisionToken,
    );
    await ensureWorkingCopyMaterialized(workingPath, {
        ownerWebContentsId: senderId,
        reason: 'native-mutation',
    });
    return {
        phaseTimings,
        operationStart,
    };
}

async function materializeNativeBinarySidecars(
    context: IDocumentsSenderIdContext,
    payload: IPdfNativeMutationSet | unknown,
): Promise<TPdfNativeMutationSetNativeToolPayload | unknown> {
    if (!payload || typeof payload !== 'object' || !Array.isArray((payload as IPdfNativeMutationSet).placedImages)) {
        return payload;
    }
    const mutationPayload = payload as IPdfNativeMutationSet & {placedImages: NonNullable<IPdfNativeMutationSet['placedImages']>};
    const placedImages = await Promise.all(mutationPayload.placedImages.map(async (image) => {
        const source = await resolveManagedTempFileHandle(context, image.source);
        const {
            source: _source,
            ...metadata
        } = image;
        return {
            ...metadata,
            bytesPath: source.path,
            byteLength: source.size,
            sha256: source.sha256,
        };
    }));
    return {
        ...payload,
        placedImages,
    };
}

function createNotAppliedResult(error?: unknown): IPdfNativeNoteTextSaveResult {
    const errorEnvelope = error === undefined
        ? undefined
        : {
            code: hasNativeErrorCode(error) ? error.code : 'native-failure' as const,
            message: getErrorMessage(error) || 'Native PDF mutation failed',
        };
    return {
        applied: false,
        validation: null,
        ...(errorEnvelope === undefined ? {} : {error: errorEnvelope}),
    };
}

function createNativeValidationResult(): IPdfValidationResult {
    return {
        isValid: true,
        tool: 'native',
        errors: [],
        warnings: [],
    };
}

function requireSenderId(context: IDocumentsSenderIdContext): number {
    if (typeof context.senderId !== 'number') {
        throw new Error('Missing sender identity');
    }
    return context.senderId;
}

function normalizeWorkingPath(workingPath: unknown): string {
    const normalizedWorkingPath = typeof workingPath === 'string' ? workingPath.trim() : '';
    if (!normalizedWorkingPath) {
        throw new Error('Invalid file path');
    }

    return normalizedWorkingPath;
}

function normalizeModifiedAt(modifiedAt: unknown): ReturnType<typeof normalizePdfNativeModifiedAt> {
    try {
        return normalizePdfNativeModifiedAt(modifiedAt, 'modifiedAt', {errorKind: 'error'});
    } catch {
        throw new Error('Invalid PDF modification timestamp');
    }
}

function normalizeNativeMutationSet(rawMutations: unknown): IPdfNativeMutationSet {
    return normalizePdfNativeMutationSet(rawMutations, 'native PDF mutations', {errorKind: 'error'});
}

function needsNativeIdentityBindingsReport(mutations: IPdfNativeMutationSet) {
    return collectExpectedNativeIdentityIds(mutations).length > 0;
}

function getValidatedOriginalPath(workingPath: string, senderWebContentsId: number): string {
    const originalPath = getWorkingCopyOriginalPath(workingPath, senderWebContentsId)?.originalPath;
    if (!originalPath) {
        throw new Error('No original path found for this working copy');
    }
    if (!isAllowedOriginalSavePath(originalPath)) {
        throw new Error('Invalid original path for this working copy');
    }

    return originalPath;
}

async function assertNativeOutputReady(outputPath: string): Promise<void> {
    const outputStat = await stat(outputPath);
    if (outputStat.size === 0) {
        throw new Error('Native note text update produced an empty PDF');
    }
}

async function cleanupTempPath(path: string): Promise<void> {
    await rm(path, {force: true}).catch((error: unknown) => {
        if (isErrnoException(error) && error.code === 'ENOENT') {
            return;
        }
        log.debug(`Failed to cleanup native note text temp file "${path}": ${getErrorMessage(error)}`);
    });
}

async function measureNativeNotePhase<T>(
    phaseTimings: INativeNotePhaseTiming[],
    phase: string,
    operation: () => Promise<T>,
) {
    const start = performance.now();
    const startedAtEpochMs = Date.now();
    try {
        return await operation();
    } finally {
        const endedAtEpochMs = Date.now();
        phaseTimings.push({
            phase,
            durationMs: Math.round((performance.now() - start) * 10) / 10,
            startedAtEpochMs,
            endedAtEpochMs,
        });
    }
}

async function prepareNativeNoteMutation(options: {
    binaryPath: string;
    command: INativeNoteCommandOptions;
    context: IDocumentsSenderIdContext;
    modifiedAt: ReturnType<typeof normalizePdfNativeModifiedAt>;
    mutationOperation: IWorkingCopyMutationOperation;
    payloadFilePath: string;
    phaseTimings: INativeNotePhaseTiming[];
    sourcePath: string;
    tempPath: string;
}) {
    const mutationChunks = splitPdfNativeMutationSetIntoBoundedChunks(
        options.command.payload as IPdfNativeMutationSet,
    );
    await measureNativeNotePhase(
        options.phaseTimings,
        'clone-working-to-temp',
        () => copyFileCopyOnWrite(options.sourcePath, options.tempPath),
    );
    const sourceBytes = (await stat(options.tempPath)).size;
    const identityBindings: NonNullable<IPdfNativeNoteTextSaveResult['identityBindings']> = [];
    await measureNativeNotePhase(options.phaseTimings, 'native-command', () =>
        withLargePdfMutationAdmission(sourceBytes, options.mutationOperation.signal, async () => {
            for (const [
                chunkIndex,
                chunk,
            ] of mutationChunks.entries()) {
                const payloadFilePath = join(
                    dirname(options.payloadFilePath),
                    chunkIndex === 0
                        ? basename(options.payloadFilePath)
                        : `${basename(options.payloadFilePath, '.json')}-${chunkIndex}.json`,
                );
                await measureNativeNotePhase(options.phaseTimings, 'write-payload', async () => {
                    const nativePayload = await materializeNativeBinarySidecars(options.context, chunk);
                    const commandPayload = options.command.command === 'update-note-text'
                        ? {updates: (chunk as IPdfNativeMutationSet).updates ?? []}
                        : options.command.command === 'save-note-changes'
                            ? {
                                ...(chunk.updates ? {updates: chunk.updates} : {}),
                                ...(chunk.geometryUpdates ? {geometryUpdates: chunk.geometryUpdates} : {}),
                                ...(chunk.freeTextNotes ? {freeTextNotes: chunk.freeTextNotes} : {}),
                                ...(chunk.deletes ? {deletes: chunk.deletes} : {}),
                            }
                            : nativePayload;
                    await writeFile(payloadFilePath, JSON.stringify(commandPayload));
                });
                const identityBindingsFileName = options.command.identityBindingsFileName
                    ? chunkIndex === 0
                        ? basename(options.command.identityBindingsFileName)
                        : `${basename(options.command.identityBindingsFileName, '.json')}-${chunkIndex}.json`
                    : undefined;
                await runNativeToolCommand(options.binaryPath, [
                    options.command.command,
                    '--input',
                    options.tempPath,
                    '--output',
                    options.tempPath,
                    options.command.payloadFlag,
                    payloadFilePath,
                    ...(identityBindingsFileName
                        ? [
                            '--identity-bindings-file',
                            join(dirname(payloadFilePath), identityBindingsFileName),
                        ]
                        : []),
                    '--qpdf',
                    getPdfNativeToolPaths().qpdf,
                    '--modified-at',
                    options.modifiedAt,
                    '--append',
                    '--append-in-place',
                ], {
                    timeoutMs: PDF_NATIVE_MUTATION_TIMEOUT_MS,
                    commandLabel: options.command.commandLabel,
                    signal: options.mutationOperation.signal,
                    cancelGroup: options.mutationOperation.cancelGroup,
                });
                await measureNativeNotePhase(options.phaseTimings, 'assert-output', () =>
                    assertNativeOutputReady(options.tempPath));
                if (identityBindingsFileName) {
                    const chunkBindings = await measureNativeNotePhase(
                        options.phaseTimings,
                        'read-identity-bindings',
                        async () => normalizePdfNativeAnnotationIdentityBindings(
                            JSON.parse(await readFile(join(dirname(payloadFilePath), identityBindingsFileName), 'utf8')),
                            `native identity bindings chunk ${chunkIndex}`,
                            {errorKind: 'error'},
                        ),
                    );
                    identityBindings.push(...chunkBindings);
                }
            }
        }));
    const normalizedIdentityBindings = options.command.identityBindingsFileName
        ? normalizePdfNativeAnnotationIdentityBindings(identityBindings, 'native identity bindings', {errorKind: 'error'})
        : undefined;
    return {
        validation: createNativeValidationResult(),
        ...(normalizedIdentityBindings === undefined ? {} : {identityBindings: normalizedIdentityBindings}),
    };
}

async function syncNativeOutputToRequestingWorkingCopy(
    requestedWorkingPath: string,
    senderWebContentsId: number,
): Promise<void> {
    await ensureWorkingCopyDirectory(requestedWorkingPath, senderWebContentsId);
    if (!await refreshWorkingCopyOriginalFileExpectation(requestedWorkingPath, senderWebContentsId)) {
        throw new Error('Working copy registration changed before original expectation refresh completed');
    }
}

async function runNativeNoteCommand(
    context: IDocumentsSenderIdContext,
    workingPath: unknown,
    rawModifiedAt: unknown,
    revisionOptions: IDocumentMutationRevisionOptions | undefined,
    options: INativeNoteCommandOptions,
): Promise<IPdfNativeNoteTextSaveResult> {
    const execution = resolveNativeNoteCommandExecution(context, workingPath, rawModifiedAt, revisionOptions);
    if (!execution) {
        return createNotAppliedResult();
    }
    const {
        senderId,
        normalizedWorkingPath,
        modifiedAt,
        expectedDocumentRevisionToken,
        binaryPath,
    } = execution;
    return enqueueWorkingCopyMutation(normalizedWorkingPath, async (mutationOperation) => {
        const {
            phaseTimings,
            operationStart,
        } = await enterQueuedNativeNoteCommand(
            normalizedWorkingPath,
            senderId,
            expectedDocumentRevisionToken,
        );
        const originalPath = getValidatedOriginalPath(normalizedWorkingPath, senderId);

        const tempPath = makeSiblingTempPath(originalPath);
        const tempDir = await mkdtemp(join(tmpdir(), 'pdf-note-text-'));
        const payloadFilePath = join(tempDir, options.payloadFileName);
        let committedValidation: IPdfNativeNoteTextSaveResult['validation'] = null;
        let committedIdentityBindings: IPdfNativeNoteTextSaveResult['identityBindings'];
        let committed = false;
        try {
            const prepared = await prepareNativeNoteMutation({
                binaryPath,
                command: options,
                context,
                modifiedAt,
                mutationOperation,
                payloadFilePath,
                phaseTimings,
                sourcePath: normalizedWorkingPath,
                tempPath,
            });
            const {
                validation,
                identityBindings,
            } = prepared;
            committedIdentityBindings = identityBindings;
            const transition = await transitionOriginalAndWorkingCopyRevision({
                workingCopyPath: normalizedWorkingPath,
                originalPath,
                reason: 'native-mutation',
                senderId,
                captureOriginalWitness: () => measureNativeNotePhase(phaseTimings, 'assert-original-base', () =>
                    captureOriginalPathSaveWitness(normalizedWorkingPath, originalPath, senderId)),
                publishOriginal: assertDestinationCurrent => measureNativeNotePhase(
                    phaseTimings,
                    'atomic-replace-original',
                    () => atomicReplace(tempPath, originalPath, {...(assertDestinationCurrent === undefined ? {} : {assertDestinationCurrent})}),
                ),
                afterWorkingCopySync: () => syncNativeOutputToRequestingWorkingCopy(
                    normalizedWorkingPath,
                    senderId,
                ),
                afterOriginalRestore: () => syncNativeOutputToRequestingWorkingCopy(
                    normalizedWorkingPath,
                    senderId,
                ),
                onPhase: (phase, durationMs) => phaseTimings.push({
                    phase,
                    durationMs,
                }),
            });
            const originalCommitted = transition !== null;
            if (!originalCommitted) {
                return createNotAppliedResult();
            }
            committed = true;
            committedValidation = validation;
            log.debug(`Native note save phase timings: ${JSON.stringify({
                command: options.command,
                totalMs: Math.round((performance.now() - operationStart) * 10) / 10,
                phases: phaseTimings,
            })}`);
            return {
                applied: true,
                validation,
                ...(identityBindings === undefined ? {} : {identityBindings}),
            };
        } catch (error) {
            log.debug(`Native note text update failed, falling back to pdf-lib: ${JSON.stringify({
                command: options.command,
                totalMs: Math.round((performance.now() - operationStart) * 10) / 10,
                phases: phaseTimings,
                error: getErrorMessage(error),
            })}`);
            if (committed) {
                return {
                    applied: true,
                    validation: committedValidation,
                    syncError: getErrorMessage(error),
                    ...(committedIdentityBindings === undefined ? {} : {identityBindings: committedIdentityBindings}),
                };
            }
            return createNotAppliedResult(error);
        } finally {
            await cleanupTempPath(tempPath);
            await rm(tempDir, {
                recursive: true,
                force: true,
            }).catch(() => undefined);
        }
    }, {
        kind: `native-pdf-mutation-original:${options.command}`,
        ownerWebContentsId: senderId,
    });
}

async function runNativeWorkingCopyCommand(
    context: IDocumentsSenderIdContext,
    workingPath: unknown,
    rawModifiedAt: unknown,
    revisionOptions: IDocumentMutationRevisionOptions,
    options: INativeNoteCommandOptions,
): Promise<IPdfNativeNoteTextSaveResult> {
    const execution = resolveNativeNoteCommandExecution(context, workingPath, rawModifiedAt, revisionOptions);
    if (!execution) {
        return createNotAppliedResult();
    }
    const {
        senderId,
        normalizedWorkingPath,
        modifiedAt,
        expectedDocumentRevisionToken,
        binaryPath,
    } = execution;

    return enqueueWorkingCopyMutation(normalizedWorkingPath, async (mutationOperation) => {
        const {
            phaseTimings,
            operationStart,
        } = await enterQueuedNativeNoteCommand(
            normalizedWorkingPath,
            senderId,
            expectedDocumentRevisionToken,
        );
        const operationStartedAtEpochMs: number = Date.now();

        // Managed binary handles validate the artifact type from its extension.
        // Keep this staging path recognizable as a PDF even though it is also a
        // sibling temporary file used for atomic promotion.
        const tempPath = `${makeSiblingTempPath(normalizedWorkingPath)}.pdf`;
        const tempDir = await mkdtemp(join(tmpdir(), 'pdf-working-copy-mutation-'));
        const payloadFilePath = join(tempDir, options.payloadFileName);
        let staged = false;
        try {
            const prepared = await prepareNativeNoteMutation({
                binaryPath,
                command: options,
                context,
                modifiedAt,
                mutationOperation,
                payloadFilePath,
                phaseTimings,
                sourcePath: normalizedWorkingPath,
                tempPath,
            });
            const {
                validation,
                identityBindings,
            } = prepared;

            const stagedOutput = await createOpaqueNativePdfStagedArtifact(context, tempPath, {
                qpdfCheck: false,
                tailCheck: true,
                semanticCheck: true,
                semanticScopeSha256: createNativeIncrementalMutationSemanticScopeSha256(),
                fsynced: true,
            }, {cleanupOnRelease: true});
            staged = true;
            const totalMs = Math.round((performance.now() - operationStart) * 10) / 10;
            const logTimings = totalMs >= 1_000 ? log.warn.bind(log) : log.debug.bind(log);
            logTimings(`Native working-copy mutation phase timings: ${JSON.stringify({
                command: options.command,
                endedAtEpochMs: Date.now(),
                startedAtEpochMs: operationStartedAtEpochMs,
                totalMs,
                phases: phaseTimings,
            })}`);
            return {
                applied: true,
                validation,
                nativeMutationPostconditionsVerified: true,
                stagedOutput,
                ...(identityBindings === undefined ? {} : {identityBindings}),
            };
        } catch (error) {
            log.warn(`Native working-copy mutation failed: ${JSON.stringify({
                command: options.command,
                endedAtEpochMs: Date.now(),
                startedAtEpochMs: operationStartedAtEpochMs,
                totalMs: Math.round((performance.now() - operationStart) * 10) / 10,
                phases: phaseTimings,
                error: getErrorMessage(error),
            })}`);
            return createNotAppliedResult(error);
        } finally {
            if (!staged) await cleanupTempPath(tempPath);
            await rm(tempDir, {
                recursive: true,
                force: true,
            }).catch(() => undefined);
        }
    }, {
        kind: `native-pdf-mutation-working-copy:${options.command}`,
        ownerWebContentsId: senderId,
    });
}

/** Promotes a verified immutable native artifact to original and WC exactly once. */
export async function handleCommitStagedPdfNativeMutations(
    context: IDocumentsSenderIdContext,
    workingPath: unknown,
    stagedArtifact: ITypedStagedArtifact,
    revisionOptions?: IPdfNativeStagedCommitOptions,
): Promise<IPdfNativeNoteTextSaveResult> {
    const senderId = requireSenderId(context);
    const normalizedWorkingPath = normalizeWorkingPath(workingPath);
    const expectedDocumentRevisionToken = normalizeExpectedDocumentRevisionToken(revisionOptions);
    const stagedOutput = await resolveTypedStagedArtifact(context, stagedArtifact);
    const phaseTimings: INativeNotePhaseTiming[] = [];
    const operationStart = performance.now();
    const operationStartedAtEpochMs = Date.now();
    let result: IPdfNativeNoteTextSaveResult | null = null;
    let stagedArtifactCleaned = false;
    try {
        result = await enqueueWorkingCopyMutation(normalizedWorkingPath, async () => {
            await assertQueuedWorkingCopyMutationPreconditions(
                normalizedWorkingPath,
                expectedDocumentRevisionToken,
            );
            await ensureWorkingCopyMaterialized(normalizedWorkingPath, {
                ownerWebContentsId: senderId,
                reason: 'native-mutation',
            });
            const originalPath = getValidatedOriginalPath(normalizedWorkingPath, senderId);
            // Typed PDF receipts validate the artifact extension as part of the
            // main-process trust boundary.
            const transition = await transitionOriginalAndWorkingCopyRevision({
                workingCopyPath: normalizedWorkingPath,
                originalPath,
                reason: 'native-mutation',
                senderId,
                captureOriginalWitness: () => captureOriginalPathSaveWitness(
                    normalizedWorkingPath,
                    originalPath,
                    senderId,
                ),
                publishOriginal: async assertDestinationCurrent => {
                    const currentArtifact = await resolveTypedStagedArtifact(context, stagedOutput);
                    await publishImmutableFileAtomic(currentArtifact.path, originalPath, {...(assertDestinationCurrent === undefined ? {} : {assertDestinationCurrent})});
                },
                afterWorkingCopySync: () => syncNativeOutputToRequestingWorkingCopy(
                    normalizedWorkingPath,
                    senderId,
                ),
                afterOriginalRestore: () => syncNativeOutputToRequestingWorkingCopy(
                    normalizedWorkingPath,
                    senderId,
                ),
                onPhase: (phase, durationMs) => phaseTimings.push({
                    phase,
                    durationMs,
                }),
            });
            let queuedResult: IPdfNativeNoteTextSaveResult = transition
                ? {
                    applied: true,
                    validation: createNativeValidationResult(),
                    ...(revisionOptions?.identityBindings === undefined
                        ? {}
                        : {identityBindings: revisionOptions.identityBindings}),
                }
                : createNotAppliedResult();

            releaseManagedTempFileHandle(context, stagedOutput.leaseId);
            await measureNativeNotePhase(phaseTimings, 'release-staged-artifact', () =>
                cleanupTempPath(stagedOutput.path));
            stagedArtifactCleaned = true;

            if (queuedResult.applied) {
                try {
                    const refreshed = await measureNativeNotePhase(
                        phaseTimings,
                        'refresh-original-expectation-after-release',
                        () => refreshWorkingCopyOriginalFileExpectation(normalizedWorkingPath, senderId),
                    );
                    if (!refreshed) {
                        throw new Error('Working copy registration changed after native mutation commit');
                    }
                } catch (error) {
                    queuedResult = {
                        ...queuedResult,
                        syncError: getErrorMessage(error),
                    };
                }
            }
            return queuedResult;
        }, {
            kind: 'native-pdf-mutation-staged-commit',
            ownerWebContentsId: senderId,
        });
    } finally {
        if (!stagedArtifactCleaned) {
            releaseManagedTempFileHandle(context, stagedOutput.leaseId);
            await measureNativeNotePhase(phaseTimings, 'release-staged-artifact', () =>
                cleanupTempPath(stagedOutput.path));
        }
    }
    const totalMs = Math.round((performance.now() - operationStart) * 10) / 10;
    const logTimings = totalMs >= 1_000 ? log.warn.bind(log) : log.debug.bind(log);
    logTimings(`Native staged mutation commit phase timings: ${JSON.stringify({
        endedAtEpochMs: Date.now(),
        startedAtEpochMs: operationStartedAtEpochMs,
        totalMs,
        phases: phaseTimings,
    })}`);
    return result;
}

export async function handleNativeNoteTextSave(
    context: IDocumentsSenderIdContext,
    workingPath: unknown,
    rawUpdates: unknown,
    rawModifiedAt: unknown,
    revisionOptions?: IDocumentMutationRevisionOptions,
): Promise<IPdfNativeNoteTextSaveResult> {
    const updates = normalizePdfNativeNoteTextUpdates(rawUpdates, 'note text update list', {errorKind: 'error'});
    return runNativeNoteCommand(context, workingPath, rawModifiedAt, revisionOptions, {
        command: 'update-note-text',
        payloadFileName: 'updates.json',
        payloadFlag: '--updates-file',
        payload: {updates},
        commandLabel: 'evb-pdf-page-ops(update-note-text)',
    });
}

export async function handleNativeNoteChangesSave(
    context: IDocumentsSenderIdContext,
    workingPath: unknown,
    rawChanges: unknown,
    rawModifiedAt: unknown,
    revisionOptions?: IDocumentMutationRevisionOptions,
): Promise<IPdfNativeNoteTextSaveResult> {
    const changes = normalizePdfNativeNoteChanges(rawChanges, 'native note changes', {errorKind: 'error'});
    return runNativeNoteCommand(context, workingPath, rawModifiedAt, revisionOptions, {
        command: 'save-note-changes',
        payloadFileName: 'changes.json',
        payloadFlag: '--changes-file',
        payload: changes,
        commandLabel: 'evb-pdf-page-ops(save-note-changes)',
    });
}

export async function handleNativePdfMutationsSave(
    context: IDocumentsSenderIdContext,
    workingPath: unknown,
    rawMutations: unknown,
    rawModifiedAt: unknown,
    revisionOptions?: IDocumentMutationRevisionOptions,
): Promise<IPdfNativeNoteTextSaveResult> {
    const mutations = normalizeNativeMutationSet(rawMutations);
    return runNativeNoteCommand(context, workingPath, rawModifiedAt, revisionOptions, {
        command: 'save-mutations',
        payloadFileName: 'mutations.json',
        payloadFlag: '--mutations-file',
        payload: mutations,
        commandLabel: 'evb-pdf-page-ops(save-mutations)',
        ...(needsNativeIdentityBindingsReport(mutations)
            ? {identityBindingsFileName: 'identity-bindings.json'}
            : {}),
    });
}

export async function handleNativePdfMutationsApplyToWorkingCopy(
    context: IDocumentsSenderIdContext,
    workingPath: unknown,
    rawMutations: unknown,
    rawModifiedAt: unknown,
    revisionOptions: IDocumentMutationRevisionOptions,
): Promise<IPdfNativeNoteTextSaveResult> {
    const mutations = normalizeNativeMutationSet(rawMutations);
    return runNativeWorkingCopyCommand(context, workingPath, rawModifiedAt, revisionOptions, {
        command: 'save-mutations',
        payloadFileName: 'mutations.json',
        payloadFlag: '--mutations-file',
        payload: mutations,
        commandLabel: 'evb-pdf-page-ops(save-mutations-working-copy)',
        ...(needsNativeIdentityBindingsReport(mutations)
            ? {identityBindingsFileName: 'identity-bindings.json'}
            : {}),
    });
}
