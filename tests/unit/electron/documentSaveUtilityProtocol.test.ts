import {EventEmitter} from 'node:events';
import {existsSync} from 'node:fs';
import {mkdtemp, rename, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import type {IpcMainEvent, MessagePortMain, WebContents} from 'electron';
import type {IPdfValidationResult} from '@contracts/pdfConformance';
import {
    afterEach,
    beforeEach,
    vi,
    describe,
    expect,
    it,
} from 'vitest';
import {
    createChangedObjectRefsSha256,
    createNativeIncrementalMutationSemanticScopeSha256,
    decodeDocumentSaveUtilityRequest,
    decodeDocumentSaveUtilityResult,
    getDocumentSaveUtilityReusePlan,
} from '@electron/features/documents/main/documentSaveUtilityProtocol';
import {requireDocumentRevisionToken} from '@contracts/documentRevision';
import {createBrowserStoreFileIdentity} from '@contracts/stagedArtifacts';
import {requireDocumentRef} from '@contracts/documentRef';
import {requireLeaseId} from '@contracts/shared';

function createStagedArtifact(overrides: {
    changedObjectRefsSha256?: string;
    fsynced?: boolean;
    qpdfCheck?: boolean;
    semanticCheck?: boolean;
    semanticScopeSha256?: string;
    tailCheck?: boolean;
} = {}) {
    return {
        receiptVersion: 1,
        artifactKind: 'pdf',
        path: requireDocumentRef('/tmp/output.tmp'),
        size: 100,
        sha256: 'a'.repeat(64),
        fileIdentity: process.platform === 'win32'
            ? {
                platform: 'win32',
                volumeId: '1',
                fileId: '2',
            }
            : {
                platform: 'posix',
                deviceId: '1',
                inode: '2',
            },
        validations: {
            qpdfCheck: overrides.qpdfCheck ?? true,
            tailCheck: overrides.tailCheck ?? true,
            semanticCheck: overrides.semanticCheck ?? false,
            fsynced: overrides.fsynced ?? true,
            qpdfResult: {
                isValid: true,
                tool: 'qpdf',
                errors: [] as string[],
                warnings: ['recoverable qpdf warning'] as string[],
            },
            ...(overrides.changedObjectRefsSha256 === undefined
                ? {}
                : {changedObjectRefsSha256: overrides.changedObjectRefsSha256}),
            ...(overrides.semanticScopeSha256 === undefined
                ? {}
                : {semanticScopeSha256: overrides.semanticScopeSha256}),
        },
        leaseId: requireLeaseId('lease-1'),
        revision: null,
    } as const;
}

describe('document save utility protocol', () => {
    it('accepts a bounded changed-object xref validation set', () => {
        expect(decodeDocumentSaveUtilityRequest({
            type: 'validate',
            sourcePath: '/tmp/output.tmp',
            expectedBytes: 100,
            changedObjectRefs: [
                '12 0 R',
                '44 2 R',
            ],
        })).toMatchObject({changedObjectRefs: [
            '12 0 R',
            '44 2 R',
        ]});
    });

    it('accepts an absolute staging path', () => {
        expect(decodeDocumentSaveUtilityRequest({
            type: 'validate',
            sourcePath: '/tmp/.document.tmp',
            expectedBytes: 123,
        })).toEqual({
            type: 'validate',
            sourcePath: '/tmp/.document.tmp',
            expectedBytes: 123,
        });
    });

    it('accepts a bounded inspection request without a target path', () => {
        expect(decodeDocumentSaveUtilityRequest({
            type: 'inspect',
            sourcePath: '/tmp/document.pdf',
            expectedBytes: 123,
        })).toEqual({
            type: 'inspect',
            sourcePath: '/tmp/document.pdf',
            expectedBytes: 123,
        });
        expect(decodeDocumentSaveUtilityRequest({
            type: 'inspect',
            sourcePath: 'document.pdf',
            expectedBytes: 123,
        })).toBeNull();
    });

    it('rejects a relative staging path', () => {
        expect(decodeDocumentSaveUtilityRequest({
            type: 'validate',
            sourcePath: 'relative.tmp',
            expectedBytes: 123,
        })).toBeNull();
    });

    it('validates the streamed digest result shape', () => {
        expect(decodeDocumentSaveUtilityResult({
            type: 'result',
            ok: true,
            bytes: 123,
            sha256: 'a'.repeat(64),
        })).toEqual({
            type: 'result',
            ok: true,
            bytes: 123,
            sha256: 'a'.repeat(64),
        });
        expect(decodeDocumentSaveUtilityResult({
            type: 'result',
            ok: true,
            bytes: 123,
            sha256: 'not-a-digest',
        })).toBeNull();
    });

    it('preserves authoritative qpdf warnings in a matching staged receipt', () => {
        const stagedArtifact = createStagedArtifact();

        expect(decodeDocumentSaveUtilityRequest({
            type: 'validate',
            sourcePath: '/tmp/output.tmp',
            expectedBytes: 100,
            stagedArtifact,
        })).toMatchObject({stagedArtifact: {validations: {qpdfResult: {warnings: ['recoverable qpdf warning']}}}});
    });

    it('rejects staged receipts for another source path or byte size', () => {
        const stagedArtifact = createStagedArtifact();

        expect(decodeDocumentSaveUtilityRequest({
            type: 'validate',
            sourcePath: '/tmp/other.tmp',
            expectedBytes: 100,
            stagedArtifact,
        })).toBeNull();
        expect(decodeDocumentSaveUtilityRequest({
            type: 'validate',
            sourcePath: '/tmp/output.tmp',
            expectedBytes: 101,
            stagedArtifact,
        })).toBeNull();
    });

    it('reuses each utility gate only for its exact receipt evidence', () => {
        const changedObjectRefs = [
            '44 2 R',
            '12 0 R',
        ];
        const request = decodeDocumentSaveUtilityRequest({
            type: 'validate',
            sourcePath: '/tmp/output.tmp',
            expectedBytes: 100,
            changedObjectRefs,
            stagedArtifact: createStagedArtifact({changedObjectRefsSha256: createChangedObjectRefsSha256(changedObjectRefs)}),
        });

        expect(request?.type).toBe('validate');
        if (!request || request.type !== 'validate') {
            throw new Error('Expected a decoded validate request');
        }
        expect(getDocumentSaveUtilityReusePlan(request)).toEqual(
            process.platform === 'win32'
                ? {
                    fingerprint: false,
                    tailCheck: false,
                    qpdfCheck: false,
                    nativeIncrementalCheck: false,
                    changedObjectRefsCheck: false,
                }
                : {
                    fingerprint: true,
                    tailCheck: true,
                    qpdfCheck: true,
                    nativeIncrementalCheck: false,
                    changedObjectRefsCheck: true,
                },
        );
    });

    it('reuses native incremental postconditions instead of rescanning unchanged PDF streams', () => {
        const request = decodeDocumentSaveUtilityRequest({
            type: 'validate',
            sourcePath: '/tmp/output.tmp',
            expectedBytes: 100,
            stagedArtifact: createStagedArtifact({
                qpdfCheck: false,
                semanticCheck: true,
                semanticScopeSha256: createNativeIncrementalMutationSemanticScopeSha256(),
            }),
        });

        if (!request || request.type !== 'validate') {
            throw new Error('Expected a decoded validate request');
        }
        expect(getDocumentSaveUtilityReusePlan(request)).toMatchObject(
            process.platform === 'win32'
                ? {
                    fingerprint: false,
                    nativeIncrementalCheck: false,
                }
                : {
                    fingerprint: true,
                    nativeIncrementalCheck: true,
                    qpdfCheck: false,
                    tailCheck: true,
                },
        );
    });

    it('reruns targeted validation when the changed-object scope differs', () => {
        const request = decodeDocumentSaveUtilityRequest({
            type: 'validate',
            sourcePath: '/tmp/output.tmp',
            expectedBytes: 100,
            changedObjectRefs: ['12 0 R'],
            stagedArtifact: createStagedArtifact({changedObjectRefsSha256: createChangedObjectRefsSha256(['44 2 R'])}),
        });

        if (!request || request.type !== 'validate') {
            throw new Error('Expected a decoded validate request');
        }
        expect(getDocumentSaveUtilityReusePlan(request).changedObjectRefsCheck).toBe(false);
    });

    it('does not route a browser-store receipt through native utility reuse', () => {
        const browserRef = requireDocumentRef('browser://documents/staged/browser-output.pdf');
        const browserRevision = requireDocumentRevisionToken('drt1:browser:staged-output');
        const changedObjectRefs = [
            '12 0 R',
            '44 2 R',
        ];
        const browserArtifactBase = createStagedArtifact();
        const browserArtifact = {
            ...browserArtifactBase,
            path: browserRef,
            fileIdentity: createBrowserStoreFileIdentity(browserRef, browserRevision),
            revision: browserRevision,
            validations: {
                ...browserArtifactBase.validations,
                changedObjectRefsSha256: createChangedObjectRefsSha256(changedObjectRefs),
            },
        } as const;

        expect(getDocumentSaveUtilityReusePlan({
            type: 'validate',
            sourcePath: requireDocumentRef('/tmp/output.tmp'),
            expectedBytes: 100,
            changedObjectRefs,
            stagedArtifact: browserArtifact,
        })).toEqual({
            fingerprint: false,
            tailCheck: false,
            qpdfCheck: false,
            nativeIncrementalCheck: false,
            changedObjectRefsCheck: false,
        });
    });

    it('normalizes changed-object scope before hashing', () => {
        expect(createChangedObjectRefsSha256([
            '44 2 R',
            '12 0 R',
            '44 2 R',
        ])).toBe(createChangedObjectRefsSha256([
            '12 0 R',
            '44 2 R',
        ]));
    });
});

let tempRoot = '';
const mocks = vi.hoisted(() => ({validate: vi.fn()}));
vi.mock('electron', () => ({
    app: {getPath: () => tempRoot},
    webContents: {fromId: () => undefined},
}));
vi.mock('@electron/features/scan-cleanup/public/generatedOutputs', () => ({touchScanCleanupGeneratedOutput: async () => undefined}));
// The injected native validator remains alive until its supplied signal aborts.
vi.mock('@electron/features/documents/main/pdfConformance', () => ({validatePdfFile: mocks.validate}));

const store = await import('@electron/file-access/documentStore');
const persistence = await import('@electron/features/documents/main/serializedPdfPersistence');
const {resetMainOperationLifecycleForTests} = await import('@electron/operation-lifecycle/mainOperationLifecycle');

class TestPort extends EventEmitter {
    start() {}
    postMessage(message: unknown) { this.emit('posted', message); }
    close() { this.emit('close'); }
}

describe('serialized PDF persistence', () => {
    beforeEach(async () => {
        tempRoot = await mkdtemp(join(tmpdir(), 'evb-serialized-pdf-'));
        await store.setDocumentStoreRootForTests(join(tempRoot, 'store'));
    });

    afterEach(async () => {
        await persistence.shutdownSerializedPdfPersistence();
        resetMainOperationLifecycleForTests();
        vi.useRealTimers();
        await store.setDocumentStoreRootForTests(null);
        await rm(tempRoot, {recursive: true, force: true});
    });

    it('stops the validator when staging exceeds its result deadline', async () => {
        const bytes = new TextEncoder().encode('%PDF-1.7\noriginal bytes\n%%EOF\n');
        const source = join(tempRoot, 'source.pdf');
        await writeFile(source, bytes);
        const entry = await store.openDocumentFromFile(source, {ownerWebContentsId: 7});
        const sender = Object.assign(new EventEmitter(), {id: 7, isDestroyed: () => false}) as WebContents;
        const port = new TestPort();
        let started!: () => void;
        const validatorStarted = new Promise<void>(resolve => { started = resolve; });
        let finishValidator!: () => void;
        let validatorRunning = false;
        let observedAbort = false;
        let validationPath = '';
        const refused: IPdfValidationResult = {isValid: false, tool: 'qpdf', errors: ['stopped'], warnings: []};
        mocks.validate.mockImplementation((path: string, options: {signal?: AbortSignal} = {}) => {
            validationPath = path;
            validatorRunning = true;
            return new Promise<IPdfValidationResult>((resolve) => {
                const signal = options.signal;
                const abort = () => {
                    observedAbort = true;
                    finishValidator();
                };
                finishValidator = () => {
                    signal?.removeEventListener('abort', abort);
                    validatorRunning = false;
                    resolve(refused);
                };
                if (signal?.aborted) abort();
                else signal?.addEventListener('abort', abort, {once: true});
                started();
            });
        });
        vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout']});
        const session = await persistence.beginSerializedPdfSaveToWorkingCopy(
            {sender, senderId: sender.id}, entry.ref, bytes.byteLength,
            {workingCopyOnly: true, expectedDocumentRevisionToken: store.documentRevisionToken(entry)},
        );
        const closed = persistence.attachSerializedPdfPersistencePort(
            {sender, ports: [port as unknown as MessagePortMain]} as IpcMainEvent,
            session.sessionId,
        );
        try {
            port.emit('message', {data: {type: 'chunk', seq: 0, bytes}});
            port.emit('message', {data: {type: 'complete'}});
            await validatorStarted;
            expect(validatorRunning).toBe(true);
            await vi.advanceTimersByTimeAsync(session.resultTimeoutMs);
            expect({observedAbort, validatorRunning}).toEqual({observedAbort: true, validatorRunning: false});
            await closed;
            expect(existsSync(validationPath)).toBe(false);
        } finally {
            finishValidator();
            await closed;
        }
    });

    it('refuses to mint a receipt when a same-length file replaces the staged file after the writer closes it', async () => {
        const bytes = new TextEncoder().encode('%PDF-1.7\noriginal bytes\n%%EOF\n');
        const replacement = new TextEncoder().encode('%PDF-1.7\nREPLACED bytes\n%%EOF\n');
        expect(replacement.byteLength).toBe(bytes.byteLength);
        const source = join(tempRoot, 'source.pdf');
        await writeFile(source, bytes);
        const entry = await store.openDocumentFromFile(source, {ownerWebContentsId: 7});
        const sender = Object.assign(new EventEmitter(), {id: 7, isDestroyed: () => false}) as WebContents;
        const port = new TestPort();
        const posted: Array<{type?: string; phase?: string; error?: string}> = [];
        port.on('posted', (frame: {type?: string; phase?: string; error?: string}) => {
            posted.push(frame);
        });
        let stagedPath = '';
        mocks.validate.mockImplementationOnce(async (validationPath: string): Promise<IPdfValidationResult> => {
            stagedPath = validationPath;
            const replacementPath = join(dirname(validationPath), 'same-length-replacement.pdf');
            await writeFile(replacementPath, replacement);
            await rename(replacementPath, validationPath);
            return {isValid: true, tool: 'qpdf', errors: [], warnings: []};
        });

        const session = await persistence.beginSerializedPdfSaveToWorkingCopy(
            {sender, senderId: sender.id},
            entry.ref,
            bytes.byteLength,
            {workingCopyOnly: true, expectedDocumentRevisionToken: store.documentRevisionToken(entry)},
        );
        const closed = persistence.attachSerializedPdfPersistencePort(
            {sender, ports: [port as unknown as MessagePortMain]} as IpcMainEvent,
            session.sessionId,
        );
        port.emit('message', {data: {type: 'chunk', seq: 0, bytes}});
        port.emit('message', {data: {type: 'complete'}});
        await closed;

        expect(stagedPath).not.toBe('');
        expect(existsSync(stagedPath)).toBe(false);
        expect(posted.some(frame => frame.type === 'staged')).toBe(false);
        expect(posted.some(frame =>
            frame.type === 'error'
            && frame.phase === 'complete'
            && typeof frame.error === 'string'
            && /changed while its receipt was being created/u.test(frame.error))).toBe(true);
    });
});
