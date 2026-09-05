import {
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
        path: '/tmp/output.tmp',
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
        leaseId: 'lease-1',
        revision: null,
    } as const;
}

describe('document save utility protocol', () => {
    it('accepts a bounded changed-object xref validation set', () => {
        expect(decodeDocumentSaveUtilityRequest({
            type: 'commit',
            sourcePath: '/tmp/output.tmp',
            targetPath: '/tmp/output.pdf',
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

    it('accepts a sibling absolute staging and target path', () => {
        expect(decodeDocumentSaveUtilityRequest({
            type: 'commit',
            sourcePath: '/tmp/.document.tmp',
            targetPath: '/tmp/document.pdf',
            expectedBytes: 123,
        })).toEqual({
            type: 'commit',
            sourcePath: '/tmp/.document.tmp',
            targetPath: '/tmp/document.pdf',
            expectedBytes: 123,
        });
    });

    it('preserves a validation-only commit request for main-process publication', () => {
        expect(decodeDocumentSaveUtilityRequest({
            type: 'commit',
            sourcePath: '/tmp/.document.tmp',
            targetPath: '/tmp/document.pdf',
            expectedBytes: 123,
            validateOnly: true,
        })).toEqual({
            type: 'commit',
            sourcePath: '/tmp/.document.tmp',
            targetPath: '/tmp/document.pdf',
            expectedBytes: 123,
            validateOnly: true,
        });
        expect(decodeDocumentSaveUtilityRequest({
            type: 'commit',
            sourcePath: '/tmp/.document.tmp',
            targetPath: '/tmp/document.pdf',
            expectedBytes: 123,
            validateOnly: false,
        })).toBeNull();
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

    it.each([
        {
            sourcePath: 'relative.tmp',
            targetPath: '/tmp/document.pdf',
        },
        {
            sourcePath: '/tmp/document.tmp',
            targetPath: '/other/document.pdf',
        },
        {
            sourcePath: '/tmp/document.pdf',
            targetPath: '/tmp/document.pdf',
        },
    ])('rejects unsafe path pairing: $sourcePath', paths => {
        expect(decodeDocumentSaveUtilityRequest({
            type: 'commit',
            ...paths,
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
            type: 'commit',
            sourcePath: '/tmp/output.tmp',
            targetPath: '/tmp/output.pdf',
            expectedBytes: 100,
            stagedArtifact,
        })).toMatchObject({stagedArtifact: {validations: {qpdfResult: {warnings: ['recoverable qpdf warning']}}}});
    });

    it('rejects staged receipts for another source path or byte size', () => {
        const stagedArtifact = createStagedArtifact();

        expect(decodeDocumentSaveUtilityRequest({
            type: 'commit',
            sourcePath: '/tmp/other.tmp',
            targetPath: '/tmp/output.pdf',
            expectedBytes: 100,
            stagedArtifact,
        })).toBeNull();
        expect(decodeDocumentSaveUtilityRequest({
            type: 'commit',
            sourcePath: '/tmp/output.tmp',
            targetPath: '/tmp/output.pdf',
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
            type: 'commit',
            sourcePath: '/tmp/output.tmp',
            targetPath: '/tmp/output.pdf',
            expectedBytes: 100,
            changedObjectRefs,
            stagedArtifact: createStagedArtifact({changedObjectRefsSha256: createChangedObjectRefsSha256(changedObjectRefs)}),
        });

        expect(request?.type).toBe('commit');
        if (!request || request.type !== 'commit') {
            throw new Error('Expected a decoded commit request');
        }
        expect(getDocumentSaveUtilityReusePlan(request)).toEqual(
            process.platform === 'win32'
                ? {
                    fingerprint: false,
                    tailCheck: false,
                    qpdfCheck: false,
                    nativeIncrementalCheck: false,
                    changedObjectRefsCheck: false,
                    fileSync: false,
                }
                : {
                    fingerprint: true,
                    tailCheck: true,
                    qpdfCheck: true,
                    nativeIncrementalCheck: false,
                    changedObjectRefsCheck: true,
                    fileSync: true,
                },
        );
    });

    it('reuses native incremental postconditions instead of rescanning unchanged PDF streams', () => {
        const request = decodeDocumentSaveUtilityRequest({
            type: 'commit',
            sourcePath: '/tmp/output.tmp',
            targetPath: '/tmp/output.pdf',
            expectedBytes: 100,
            stagedArtifact: createStagedArtifact({
                qpdfCheck: false,
                semanticCheck: true,
                semanticScopeSha256: createNativeIncrementalMutationSemanticScopeSha256(),
            }),
        });

        if (!request || request.type !== 'commit') {
            throw new Error('Expected a decoded commit request');
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
                    fileSync: true,
                },
        );
    });

    it('reruns targeted validation when the changed-object scope differs', () => {
        const request = decodeDocumentSaveUtilityRequest({
            type: 'commit',
            sourcePath: '/tmp/output.tmp',
            targetPath: '/tmp/output.pdf',
            expectedBytes: 100,
            changedObjectRefs: ['12 0 R'],
            stagedArtifact: createStagedArtifact({changedObjectRefsSha256: createChangedObjectRefsSha256(['44 2 R'])}),
        });

        if (!request || request.type !== 'commit') {
            throw new Error('Expected a decoded commit request');
        }
        expect(getDocumentSaveUtilityReusePlan(request).changedObjectRefsCheck).toBe(false);
    });

    it('does not inherit file durability across an unsynced byte-preserving copy', () => {
        const request = decodeDocumentSaveUtilityRequest({
            type: 'commit',
            sourcePath: '/tmp/output.tmp',
            targetPath: '/tmp/output.pdf',
            expectedBytes: 100,
            stagedArtifact: createStagedArtifact({fsynced: false}),
        });

        if (!request || request.type !== 'commit') {
            throw new Error('Expected a decoded commit request');
        }
        expect(getDocumentSaveUtilityReusePlan(request).fileSync).toBe(false);
    });

    it('does not route a browser-store receipt through native utility reuse', () => {
        const browserRef = 'browser://documents/staged/browser-output.pdf';
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
            type: 'commit',
            sourcePath: '/tmp/output.tmp',
            targetPath: '/tmp/output.pdf',
            expectedBytes: 100,
            changedObjectRefs,
            stagedArtifact: browserArtifact,
        })).toEqual({
            fingerprint: false,
            tailCheck: false,
            qpdfCheck: false,
            nativeIncrementalCheck: false,
            changedObjectRefsCheck: false,
            fileSync: false,
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
