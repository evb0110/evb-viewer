import {
    parseNativePdfSaveReport, mergeNativeAnnotationDeleteEffects, type TNativeAnnotationDeleteEffects,
} from '@contracts/nativePdfSaveReport';
import {withContentReadLease} from '@electron/features/documents/main/documentFileReadHandlers';
import {getAppTempDir} from '@electron/utils/appTempDir';
import {usingManagedScratchScope} from '@electron/utils/managedScratchTemp';
import {getUnprovenNativeTerminationDetail} from '@electron/utils/nativeTerminationProof';
import {constants, existsSync} from 'fs';
import {
    copyFile,
    readFile,
    rm,
    stat,
    writeFile,
} from 'fs/promises';
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
} from '@pdf-core/nativePdfMutationPolicy';
import type { IPdfValidationResult } from '@contracts/pdfConformance';
import type { ITypedStagedArtifact } from '@contracts/stagedArtifacts';
import {
    normalizePdfNativeModifiedAt,
    normalizePdfNativeAnnotationIdentityBindings,
} from '@pdf-core';
import {hasNativeErrorCode} from '@contracts/nativeErrors';
import { runNativeToolCommand } from '@electron/native-tools/runNativeToolCommand';
import {getPdfNativeToolPaths} from '@electron/pdf/nativeToolPaths';
import {resolveNativePageOpsPath} from '@electron/features/page-ops/public';
import {makeSiblingTempPath} from '@electron/utils/atomicReplace';
import {
    enqueueWorkingCopyMutation,
    type IWorkingCopyMutationOperation,
} from '@electron/file-access/workingCopyMutationQueue';
import {
    assertQueuedWorkingCopyMutationPreconditions,
    normalizeExpectedDocumentRevisionToken,
    requireDocumentFile,
    requireOpenDocument,
    runWithWorkingCopyReadBacking,
    saveOpenDocument,
} from '@electron/file-access/documentStore';
import {explainWriteRefusal} from '@electron/file-access/explainWriteRefusal';
import { createLogger } from '@electron/utils/createLogger';
import { getErrorMessage } from '@electron/utils/error';
import {toDocumentSaveResult} from '@electron/features/documents/main/workingCopySave';
import {createNativeIncrementalMutationSemanticScopeSha256} from '@electron/features/documents/main/documentSaveUtilityProtocol';
import type { IDocumentsSenderIdContext } from '@electron/features/documents/documentsContexts';
import {
    createOpaqueNativePdfStagedArtifact,
    releaseManagedTempFileHandle,
    resolveManagedTempFileHandle,
    resolveTypedStagedArtifact,
} from '@electron/features/documents/main/managedTempFileHandles';
import {withLargePdfMutationAdmission} from '@electron/features/documents/main/withLargePdfMutationAdmission';

const PDF_NATIVE_MUTATION_TIMEOUT_MS = 2 * 60 * 1000;
const log = createLogger('native-note-text-save');

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
    return {
        phaseTimings,
        operationStart,
        sourcePath: await requireDocumentFile(requireOpenDocument(workingPath, senderId)),
    };
}

async function materializeNativeBinarySidecars(
    context: IDocumentsSenderIdContext,
    {
        originalAppearanceSource: _originalSource, placedImages, ...mutations
    }: IPdfNativeMutationSet,
) {
    if (placedImages === undefined) return mutations;
    return {
        ...mutations,
        placedImages: await Promise.all(placedImages.map(async (image) => {
            if (image.bytesBase64 !== undefined) return image;
            if (!image.source) throw new Error('Placed image source is missing');
            const source = await resolveManagedTempFileHandle(context, image.source);
            const {
                source: _source, ...metadata
            } = image;
            return {
                ...metadata,
                bytesPath: source.path,
                byteLength: source.size,
                sha256: source.sha256,
            };
        })),
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

function needsNativeSaveReport(mutations: IPdfNativeMutationSet) {
    return collectExpectedNativeIdentityIds(mutations).length > 0 || [
        mutations.deletes?.length,
        mutations.shapes,
        mutations.markup,
        mutations.textBoxes?.length,
    ].some(Boolean);
}

async function assertNativeOutputReady(outputPath: string): Promise<void> {
    const outputStat = await stat(outputPath);
    if (outputStat.size === 0) {
        throw new Error('Native note text update produced an empty PDF');
    }
}

async function cleanupTempPath(path: string): Promise<void> {
    await rm(path, {force: true}).catch((error: unknown) => {
        log.debug('Failed to cleanup native note text temp file', {
            path,
            error: getErrorMessage(error),
        });
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
    mutations: IPdfNativeMutationSet;
    context: IDocumentsSenderIdContext;
    modifiedAt: ReturnType<typeof normalizePdfNativeModifiedAt>;
    mutationOperation: IWorkingCopyMutationOperation;
    payloadFilePath: string;
    phaseTimings: INativeNotePhaseTiming[];
    sourcePath: string;
    tempPath: string;
}) {
    const mutationChunks = splitPdfNativeMutationSetIntoBoundedChunks(options.mutations);
    const needsBindings = needsNativeSaveReport(options.mutations);
    await measureNativeNotePhase(
        options.phaseTimings,
        'clone-working-to-temp',
        () => copyFile(options.sourcePath, options.tempPath, constants.COPYFILE_FICLONE),
    );
    const sourceBytes = (await stat(options.tempPath)).size;
    const deleteEffects: TNativeAnnotationDeleteEffects[] = [];
    let completeDeleteEffects = true;
    const identityBindings: Array<NonNullable<IPdfNativeNoteTextSaveResult['identityBindings']>[number]> = [];
    await measureNativeNotePhase(options.phaseTimings, 'native-command', () =>
        withLargePdfMutationAdmission(sourceBytes, options.mutationOperation.signal, async signal => {
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
                    await writeFile(payloadFilePath, JSON.stringify(nativePayload));
                });
                const identityBindingsFileName = needsBindings
                    ? chunkIndex === 0 ? 'identity-bindings.json' : `identity-bindings-${chunkIndex}.json`
                    : undefined;
                const run = (source?: string) => runNativeToolCommand(options.binaryPath, [
                    'save-mutations',
                    '--input',
                    options.tempPath,
                    '--output',
                    options.tempPath,
                    '--mutations-file',
                    payloadFilePath,
                    ...(source === undefined ? [] : [
                        '--source',
                        source,
                    ]),
                    ...(identityBindingsFileName
                        ? [
                            '--identity-bindings-file',
                            join(dirname(payloadFilePath), identityBindingsFileName),
                        ]
                        : []),
                    '--qpdf',
                    getPdfNativeToolPaths().qpdf,
                    '--annotation-ownership-cache',
                    join(getAppTempDir(), 'annotation-ownership'),
                    '--modified-at',
                    options.modifiedAt,
                    '--append',
                    '--append-in-place',
                ], {
                    timeoutMs: PDF_NATIVE_MUTATION_TIMEOUT_MS,
                    commandLabel: 'evb-pdf-page-ops(save-mutations-working-copy)',
                    signal,
                    cancelGroup: options.mutationOperation.cancelGroup,
                });
                const sourceRef = chunk.originalAppearanceSource;
                await (sourceRef === undefined ? run() : withContentReadLease(sourceRef, () => runWithWorkingCopyReadBacking(
                    sourceRef,
                    physicalPath => run(physicalPath),
                    {ownerWebContentsId: requireSenderId(options.context)},
                )));
                await measureNativeNotePhase(options.phaseTimings, 'assert-output', () =>
                    assertNativeOutputReady(options.tempPath));
                if (identityBindingsFileName) {
                    const report = await measureNativeNotePhase(
                        options.phaseTimings,
                        'read-identity-bindings',
                        async () => parseNativePdfSaveReport(
                            JSON.parse(await readFile(join(dirname(payloadFilePath), identityBindingsFileName), 'utf8')),
                        ),
                    );
                    identityBindings.push(...report.identityBindings);
                    if (report.annotationDeleteEffects) deleteEffects.push(report.annotationDeleteEffects);
                    else completeDeleteEffects = false;
                }
            }
        }));
    const normalizedIdentityBindings = needsBindings
        ? normalizePdfNativeAnnotationIdentityBindings(identityBindings, 'native identity bindings', {errorKind: 'error'})
        : undefined;
    return {
        validation: createNativeValidationResult(),
        annotationDeleteEffects: completeDeleteEffects ? mergeNativeAnnotationDeleteEffects(deleteEffects) : undefined,
        ...(normalizedIdentityBindings === undefined ? {} : {identityBindings: normalizedIdentityBindings}),
    };
}

async function runNativeWorkingCopyCommand(
    context: IDocumentsSenderIdContext,
    workingPath: unknown,
    rawModifiedAt: unknown,
    revisionOptions: IDocumentMutationRevisionOptions,
    mutations: IPdfNativeMutationSet,
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
            sourcePath,
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
        let staged = false;
        try {
            return await usingManagedScratchScope('pdf-page-ops-', getAppTempDir(), async tempDir => {
                const payloadFilePath = join(tempDir, 'mutations.json');
                const prepared = await prepareNativeNoteMutation({
                    binaryPath,
                    mutations,
                    context,
                    modifiedAt,
                    mutationOperation,
                    payloadFilePath,
                    phaseTimings,
                    sourcePath,
                    tempPath,
                });
                const {
                    validation,
                    identityBindings,
                    annotationDeleteEffects,
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
                const logTimings = totalMs >= 1_000 ? log.info.bind(log) : log.debug.bind(log);
                logTimings('Native working-copy mutation phase timings', {
                    command: 'save-mutations',
                    endedAtEpochMs: Date.now(),
                    startedAtEpochMs: operationStartedAtEpochMs,
                    totalMs,
                    phases: phaseTimings,
                });
                return {
                    applied: true,
                    validation,
                    nativeMutationPostconditionsVerified: true,
                    stagedOutput,
                    ...(identityBindings === undefined ? {} : {identityBindings}),
                    ...(annotationDeleteEffects === undefined ? {} : {annotationDeleteEffects}),
                };
            });
        } catch (error) {
            if (!staged && getUnprovenNativeTerminationDetail(error) === undefined) {
                await cleanupTempPath(tempPath);
            }
            log.warn('Native working-copy mutation failed', {
                command: 'save-mutations',
                endedAtEpochMs: Date.now(),
                startedAtEpochMs: operationStartedAtEpochMs,
                totalMs: Math.round((performance.now() - operationStart) * 10) / 10,
                phases: phaseTimings,
                error: getErrorMessage(error),
            });
            return createNotAppliedResult(error);
        }
    }, {
        kind: 'native-pdf-mutation-working-copy:save-mutations',
        ownerWebContentsId: senderId,
    });
}

/**
 * Save with pending annotations: the verified native artifact becomes the working copy's revision, then the
 * document is checked against the PDF on disk and published to it.
 */
export async function handleCommitStagedPdfNativeMutations(
    context: IDocumentsSenderIdContext,
    workingPath: unknown,
    stagedArtifact: ITypedStagedArtifact,
    revisionOptions?: IPdfNativeStagedCommitOptions,
): Promise<IPdfNativeNoteTextSaveResult> {
    const senderId = requireSenderId(context);
    const entry = requireOpenDocument(normalizeWorkingPath(workingPath), senderId);
    const expectedDocumentRevisionToken = normalizeExpectedDocumentRevisionToken(revisionOptions);
    const stagedOutput = await resolveTypedStagedArtifact(context, stagedArtifact);
    const operationStart = performance.now();
    try {
        return await enqueueWorkingCopyMutation(entry.ref, async () => {
            await assertQueuedWorkingCopyMutationPreconditions(entry.ref, expectedDocumentRevisionToken);
            const currentArtifact = await resolveTypedStagedArtifact(context, stagedOutput);
            const saved = toDocumentSaveResult(entry, await saveOpenDocument(entry, expectedDocumentRevisionToken, {
                commit: {kind: 'move', file: currentArtifact.path},
            }), createNativeValidationResult());
            if (saved.ok) {
                return {
                    applied: true,
                    validation: createNativeValidationResult(),
                    ...(saved.documentRevision ? {documentRevision: saved.documentRevision} : {}),
                    ...(revisionOptions?.identityBindings === undefined
                        ? {}
                        : {identityBindings: revisionOptions.identityBindings}),
                };
            }
            return {
                ...createNotAppliedResult(),
                reason: 'original-changed',
                ...(saved.keptFilePath === undefined ? {} : {keptFilePath: saved.keptFilePath}),
            };
        }, {
            kind: 'native-pdf-mutation-staged-commit',
            ownerWebContentsId: senderId,
        });
    } catch (error) {
        throw await explainWriteRefusal(error, entry.originalPath ?? '');
    } finally {
        releaseManagedTempFileHandle(context, stagedOutput.leaseId);
        if (existsSync(stagedOutput.path)) await cleanupTempPath(stagedOutput.path);
        log.debug('Native staged mutation commit timings', {totalMs: Math.round((performance.now() - operationStart) * 10) / 10});
    }
}

export async function handleNativePdfMutationsApplyToWorkingCopy(
    context: IDocumentsSenderIdContext,
    workingPath: unknown,
    mutations: IPdfNativeMutationSet,
    rawModifiedAt: unknown,
    revisionOptions: IDocumentMutationRevisionOptions,
): Promise<IPdfNativeNoteTextSaveResult> {
    return runNativeWorkingCopyCommand(context, workingPath, rawModifiedAt, revisionOptions, mutations);
}
