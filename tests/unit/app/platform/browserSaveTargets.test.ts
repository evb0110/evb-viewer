import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {SavePublicationError} from '@document-store/saveDocument';
import {requireDocumentRef} from '@contracts/documentRef';
import {requireDocumentRevisionToken} from '@contracts/documentRevision';
import {requireEpochMs} from '@contracts/timestamps';
import {browserDocumentStore} from '@app/platform/browserDocumentStore';
import {
    createBrowserStoreStagedArtifact,
    sha256Hex,
} from '@app/platform/browser/browserStagedArtifact';
import {BrowserFileWriteOutcomeError} from '@app/platform/browser-api/browserFilePickerAdapter';
import type * as BrowserQpdfEngineClient from '@app/platform/browser-api/browserQpdfEngineClient';
import {cast} from '@tests/helpers/cast';

const qpdfMock = vi.hoisted(() => ({runBrowserQpdfCommand: vi.fn()}));

vi.mock('@app/platform/browser-api/browserQpdfEngineClient', async importOriginal => ({
    ...await importOriginal<typeof BrowserQpdfEngineClient>(),
    runBrowserQpdfCommand: (...args: unknown[]) => qpdfMock.runBrowserQpdfCommand(...args),
}));

describe('finishBrowserPdfCandidate', () => {
    const source = Uint8Array.from({length: 10}, (_, index) => index + 1);
    const rewriteResult = (output: Uint8Array | null, exitCode = 0) => ({
        exitCode,
        stdout: '',
        stderr: '',
        output,
    });
    const checkResult = (exitCode: number) => ({
        exitCode,
        stdout: exitCode === 2 ? '' : 'checking document.pdf\nNo syntax or stream encoding errors found',
        stderr: exitCode === 2 ? 'damaged' : '',
        output: null,
    });

    function answerQpdf(rewrite: unknown, checkExitCode = 0) {
        qpdfMock.runBrowserQpdfCommand.mockImplementation(async (command: string) => {
            if (command === 'lossless-rewrite') {
                if (rewrite instanceof Error) {throw rewrite;}
                return rewrite;
            }
            return checkResult(checkExitCode);
        });
    }

    beforeEach(() => {
        qpdfMock.runBrowserQpdfCommand.mockReset();
    });

    it('keeps a smaller rewrite that passes its own full check and leaves the input intact', async () => {
        const candidate = Uint8Array.of(9, 9, 9);
        answerQpdf(rewriteResult(candidate, 3));
        const {finishBrowserPdfCandidate} = await import('@app/platform/browser-api/browserSaveTargets');

        await expect(finishBrowserPdfCandidate(source, {fileName: 'kept.pdf'})).resolves.toBe(candidate);

        const rewriteInput = qpdfMock.runBrowserQpdfCommand.mock.calls[0]?.[1] as Uint8Array;
        expect(rewriteInput).not.toBe(source);
        expect(rewriteInput.buffer).not.toBe(source.buffer);
        expect([...source]).toEqual([
            1,
            2,
            3,
            4,
            5,
            6,
            7,
            8,
            9,
            10,
        ]);
        expect(qpdfMock.runBrowserQpdfCommand.mock.calls.map(([command]) => command))
            .toEqual([
                'lossless-rewrite',
                'check',
            ]);
    });

    it.each([
        [
            'an equal-size rewrite',
            rewriteResult(new Uint8Array(10)),
            0,
        ],
        [
            'a larger rewrite',
            rewriteResult(new Uint8Array(11)),
            0,
        ],
        [
            'an empty rewrite',
            rewriteResult(new Uint8Array()),
            0,
        ],
        [
            'no rewrite output',
            rewriteResult(null),
            0,
        ],
        [
            'a failed rewrite exit',
            rewriteResult(Uint8Array.of(1), 2),
            0,
        ],
        [
            'a rewrite that throws',
            new Error('engine ran out of memory'),
            0,
        ],
        [
            'a candidate that fails its full check',
            rewriteResult(Uint8Array.of(1)),
            2,
        ],
    ])('retains the input after %s', async (_label, rewrite, checkExitCode) => {
        answerQpdf(rewrite, checkExitCode);
        const {finishBrowserPdfCandidate} = await import('@app/platform/browser-api/browserSaveTargets');

        await expect(finishBrowserPdfCandidate(source, {fileName: 'kept.pdf'})).resolves.toBeNull();
    });

    it('throws an abort instead of retaining the input', async () => {
        const controller = new AbortController();
        qpdfMock.runBrowserQpdfCommand.mockImplementation(async () => {
            controller.abort(new DOMException('Optimize was canceled', 'AbortError'));
            throw new Error('engine stopped');
        });
        const {finishBrowserPdfCandidate} = await import('@app/platform/browser-api/browserSaveTargets');

        await expect(finishBrowserPdfCandidate(source, {
            fileName: 'kept.pdf',
            signal: controller.signal,
        }))
            .rejects.toMatchObject({name: 'AbortError'});
    });

    it('does not start qpdf after an abort', async () => {
        const {finishBrowserPdfCandidate} = await import('@app/platform/browser-api/browserSaveTargets');

        await expect(finishBrowserPdfCandidate(source, {
            fileName: 'kept.pdf',
            signal: AbortSignal.abort(),
        }))
            .rejects.toMatchObject({name: 'AbortError'});
        expect(qpdfMock.runBrowserQpdfCommand).not.toHaveBeenCalled();
    });
});

describe('browser save target publication facts', () => {
    const workingRef = requireDocumentRef('browser://documents/work-doc/document.pdf');
    const sourceRef = requireDocumentRef('browser://documents/source-doc/document.pdf');
    const revision = {
        version: 1 as const,
        token: requireDocumentRevisionToken('drt1:browser:work-doc:2'),
        documentRef: workingRef,
        authority: 'browser-document-store' as const,
        contentRevision: 2,
        mintedAt: requireEpochMs(1),
    };

    function stubDownloadBackedWorkingEntry() {
        vi.spyOn(browserDocumentStore, 'requireEntry').mockResolvedValue(cast({
            ref: workingRef,
            sourceRef,
            saveName: 'paper.pdf',
            doc: {
                state: () => ({
                    destination: 'download:paper.pdf',
                    baseline: 'content-v2:baseline',
                }),
            },
        }));
        vi.spyOn(browserDocumentStore, 'ensureEntry').mockResolvedValue(null);
        vi.spyOn(browserDocumentStore, 'touchRecentFile').mockResolvedValue(undefined);
        vi.spyOn(browserDocumentStore, 'getDocumentRevision').mockResolvedValue(revision);
    }

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('returns ok=true with externalWriteCommitted=true and refresh-failed warning when manifest acknowledgement fails after publish', async () => {
        stubDownloadBackedWorkingEntry();
        vi.spyOn(browserDocumentStore, 'save').mockResolvedValue({
            status: 'saved',
            revision: {id: 2, file: 'r2.pdf', length: 12, witness: 'content-v2:published'},
            externalWriteCommitted: true,
            acknowledgmentError: new Error('OPFS manifest ack failed'),
            pendingPublish: {destination: 'download:paper.pdf', witness: 'content-v2:published'},
        });
        const {saveWorkingBytesToSourceStructured} = await import('@app/platform/browser-api/browserSaveTargets');

        const result = await saveWorkingBytesToSourceStructured(workingRef, {expectedDocumentRevisionToken: revision.token});

        expect(result).toEqual({
            ok: true,
            externalWriteCommitted: true,
            workingCopyRefreshed: false,
            documentRevision: revision,
            validation: null,
            warning: {
                reason: 'refresh-failed',
                message: 'OPFS manifest ack failed',
            },
        });
    });

    it('returns ok=true with externalWriteCommitted=true and refresh-failed warning when post-publish source copy refresh fails', async () => {
        stubDownloadBackedWorkingEntry();
        vi.spyOn(browserDocumentStore, 'ensureEntry').mockResolvedValue(cast({
            ref: sourceRef,
            doc: {},
            saveHandle: null,
        }));
        vi.spyOn(browserDocumentStore, 'replaceContent').mockRejectedValue(new Error('Recent copy quota full'));
        vi.spyOn(browserDocumentStore, 'unload').mockImplementation(() => undefined);
        vi.spyOn(browserDocumentStore, 'save').mockResolvedValue({
            status: 'saved',
            revision: {id: 2, file: 'r2.pdf', length: 12, witness: 'content-v2:published'},
        });
        const {saveWorkingBytesToSourceStructured} = await import('@app/platform/browser-api/browserSaveTargets');

        const result = await saveWorkingBytesToSourceStructured(workingRef, {expectedDocumentRevisionToken: revision.token});

        expect(result).toEqual({
            ok: true,
            externalWriteCommitted: true,
            workingCopyRefreshed: false,
            documentRevision: revision,
            validation: null,
            warning: {
                reason: 'refresh-failed',
                message: 'Recent copy quota full',
            },
        });
    });

    it.each([
        ['SavePublicationError(null)', new SavePublicationError(new Error('handle close outcome unknown'), {externalWriteCommitted: null, pendingPublish: {destination: 'handle:doc', witness: 'content-v2:staged'}})],
        ['BrowserFileWriteOutcomeError(null)', new BrowserFileWriteOutcomeError(new Error('close failed without abort'), null)],
    ])('preserves externalWriteCommitted=null on unverified write (%s)', async (_label, thrown) => {
        stubDownloadBackedWorkingEntry();
        vi.spyOn(browserDocumentStore, 'save').mockRejectedValue(thrown);
        const {saveWorkingBytesToSourceStructured} = await import('@app/platform/browser-api/browserSaveTargets');

        const result = await saveWorkingBytesToSourceStructured(workingRef, {expectedDocumentRevisionToken: revision.token});

        expect(result).toEqual({
            ok: false,
            reason: 'write-failed',
            message: thrown.message,
            externalWriteCommitted: null,
            validation: null,
        });
    });

    it('preserves externalWriteCommitted=false when publish fails before staging', async () => {
        stubDownloadBackedWorkingEntry();
        vi.spyOn(browserDocumentStore, 'save').mockRejectedValue(
            new SavePublicationError(new Error('permission denied before write'), {externalWriteCommitted: false}),
        );
        const {saveWorkingBytesToSourceStructured} = await import('@app/platform/browser-api/browserSaveTargets');

        const result = await saveWorkingBytesToSourceStructured(workingRef, {expectedDocumentRevisionToken: revision.token});

        expect(result).toEqual({
            ok: false,
            reason: 'write-failed',
            message: 'permission denied before write',
            externalWriteCommitted: false,
            validation: null,
        });
    });

    it('tags post-publication Save As adoption failure with externalWriteCommitted=true', async () => {
        const writable = {
            write: vi.fn(async () => undefined),
            close: vi.fn(async () => undefined),
            abort: vi.fn(async () => undefined),
        };
        const handle = cast<FileSystemFileHandle>({
            name: 'saved-copy.pdf',
            queryPermission: vi.fn(async () => 'granted'),
            createWritable: vi.fn(async () => writable),
        });
        const stagedBytes = Uint8Array.of(37, 80, 68, 70);
        const stagedRef = requireDocumentRef('browser://documents/staged-out/document.pdf');
        const stagedRevision = {
            version: 1 as const,
            token: requireDocumentRevisionToken('drt1:browser:staged-out:1'),
            documentRef: stagedRef,
            authority: 'browser-document-store' as const,
            contentRevision: 1,
            mintedAt: requireEpochMs(1),
        };
        vi.spyOn(browserDocumentStore, 'assertDocumentRevisionCurrent').mockResolvedValue(undefined);
        vi.spyOn(browserDocumentStore, 'getSaveTarget').mockResolvedValue({saveName: 'paper.pdf', saveKind: 'pdf', saveHandle: null});
        vi.spyOn(browserDocumentStore, 'getDocumentRevision').mockResolvedValue(stagedRevision);
        vi.spyOn(browserDocumentStore, 'read').mockResolvedValue(stagedBytes);
        vi.spyOn(browserDocumentStore, 'stat').mockResolvedValue({size: stagedBytes.byteLength, modifiedAt: 1});
        vi.spyOn(browserDocumentStore, 'createStoredDocument').mockRejectedValue(new Error('OPFS adoption failed'));
        const stagedOutput = await createBrowserStoreStagedArtifact(browserDocumentStore, stagedRef, {
            leaseId: 'lease-1',
            sha256: await sha256Hex(stagedBytes),
            validations: {
                qpdfCheck: true,
                qpdfResult: {isValid: true, tool: 'qpdf', errors: [], warnings: []},
                tailCheck: false,
                semanticCheck: false,
                fsynced: false,
            },
        });
        const {savePdfAsFromWorkingCopy} = await import('@app/platform/browser-api/browserSaveTargets');

        let caught: unknown;
        try {
            await savePdfAsFromWorkingCopy(
                workingRef,
                {stagedOutput},
                {expectedDocumentRevisionToken: revision.token},
                {
                    kind: 'finalized',
                    sourceRef,
                    signal: new AbortController().signal,
                    target: {canceled: false, fileName: 'saved-copy.pdf', handle},
                },
            );
        } catch (error) {
            caught = error;
        }
        expect(writable.close).toHaveBeenCalledOnce();
        expect(caught).toBeInstanceOf(BrowserFileWriteOutcomeError);
        expect(caught).toMatchObject({
            externalWriteCommitted: true,
            message: expect.stringContaining('Saved copy "saved-copy.pdf" was written, but browser document adoption failed: OPFS adoption failed'),
        });
    });
});
