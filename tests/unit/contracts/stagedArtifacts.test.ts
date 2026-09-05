import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    createBrowserStoreFileIdentity,
    decodeTypedStagedArtifact,
    isBrowserStoreFileIdentity,
    isBrowserStoreStagedArtifact,
    isTypedStagedArtifact,
} from '@contracts/stagedArtifacts';
import {requireDocumentRevisionToken} from '@contracts/documentRevision';

const SHA256 = 'a'.repeat(64);
const BROWSER_DOCUMENT_REF = 'browser://documents/browser-id/staged.pdf';
const BROWSER_REVISION = requireDocumentRevisionToken('drt1:browser:revision-1');

function createArtifact() {
    return {
        receiptVersion: 1 as const,
        artifactKind: 'pdf' as const,
        path: '/tmp/staged.pdf',
        size: 512,
        sha256: SHA256,
        fileIdentity: {
            platform: 'posix' as const,
            deviceId: '16777234',
            inode: '918273645',
        },
        validations: {
            qpdfCheck: true,
            tailCheck: true,
            semanticCheck: true,
            fsynced: false,
            qpdfResult: {
                isValid: true,
                tool: 'qpdf' as const,
                errors: [],
                warnings: ['object stream warning'],
            },
            semanticScopeSha256: 'b'.repeat(64),
            changedObjectRefsSha256: 'c'.repeat(64),
        },
        leaseId: 'lease-1',
        revision: null,
    };
}

describe('typed staged artifact contracts', () => {
    it('decodes POSIX identity and preserves validation evidence', () => {
        const artifact = createArtifact();

        expect(isTypedStagedArtifact(artifact)).toBe(true);
        expect(decodeTypedStagedArtifact(artifact)).toEqual(artifact);
        expect(decodeTypedStagedArtifact(artifact)?.validations.qpdfResult?.warnings)
            .toEqual(['object stream warning']);
    });

    it('accepts Windows identity with conservative validations', () => {
        const artifact = {
            ...createArtifact(),
            fileIdentity: {
                platform: 'win32',
                volumeId: 'volume-1',
                fileId: 'file-1',
            },
            validations: {
                qpdfCheck: false,
                tailCheck: false,
                semanticCheck: false,
                fsynced: false,
            },
        };

        expect(decodeTypedStagedArtifact(artifact)).toEqual(artifact);
    });

    it('accepts an opaque POSIX native receipt without a reusable content hash', () => {
        const {
            sha256: _sha256,
            ...artifact
        } = createArtifact();
        const opaqueArtifact = {
            ...artifact,
            receiptVersion: 2,
        } as const;

        expect(decodeTypedStagedArtifact(opaqueArtifact)).toEqual(opaqueArtifact);
    });

    it('decodes browser-store identity without manufacturing an OS identity', () => {
        const artifact = {
            ...createArtifact(),
            path: BROWSER_DOCUMENT_REF,
            fileIdentity: createBrowserStoreFileIdentity(
                BROWSER_DOCUMENT_REF,
                BROWSER_REVISION,
            ),
            revision: BROWSER_REVISION,
        };

        expect(isBrowserStoreFileIdentity(artifact.fileIdentity)).toBe(true);
        expect(isBrowserStoreStagedArtifact(artifact)).toBe(true);
        expect(decodeTypedStagedArtifact(artifact)).toEqual(artifact);
        expect(artifact.fileIdentity).toEqual({
            platform: 'browser',
            documentRef: BROWSER_DOCUMENT_REF,
            revisionToken: BROWSER_REVISION,
        });
        expect('deviceId' in artifact.fileIdentity).toBe(false);
        expect('inode' in artifact.fileIdentity).toBe(false);
    });

    it.each([
        {
            name: 'a native path in the browser identity',
            fileIdentity: {
                platform: 'browser',
                documentRef: '/tmp/staged.pdf',
                revisionToken: BROWSER_REVISION,
            },
        },
        {
            name: 'a browser identity whose ref differs from the artifact path',
            fileIdentity: {
                platform: 'browser',
                documentRef: 'browser://documents/other/staged.pdf',
                revisionToken: BROWSER_REVISION,
            },
        },
        {
            name: 'a browser identity whose revision differs from the artifact revision',
            fileIdentity: {
                platform: 'browser',
                documentRef: BROWSER_DOCUMENT_REF,
                revisionToken: 'drt1:browser:other-revision',
            },
        },
        {
            name: 'the bare browser document ref prefix',
            fileIdentity: {
                platform: 'browser',
                documentRef: 'browser://documents/',
                revisionToken: BROWSER_REVISION,
            },
        },
        {
            name: 'an overlong browser document ref',
            fileIdentity: {
                platform: 'browser',
                documentRef: `browser://documents/${'a'.repeat(32_768)}`,
                revisionToken: BROWSER_REVISION,
            },
        },
        {
            name: 'an overlong browser revision token',
            fileIdentity: {
                platform: 'browser',
                documentRef: BROWSER_DOCUMENT_REF,
                revisionToken: 'r'.repeat(513),
            },
        },
    ])('rejects browser identity with $name', ({fileIdentity}) => {
        const artifact = {
            ...createArtifact(),
            path: BROWSER_DOCUMENT_REF,
            fileIdentity,
            revision: BROWSER_REVISION,
        };

        expect(decodeTypedStagedArtifact(artifact)).toBeNull();
        expect(isBrowserStoreStagedArtifact(artifact)).toBe(false);
    });

    it('requires a current browser revision for browser-store staged artifacts', () => {
        const artifact = {
            ...createArtifact(),
            path: BROWSER_DOCUMENT_REF,
            fileIdentity: createBrowserStoreFileIdentity(
                BROWSER_DOCUMENT_REF,
                BROWSER_REVISION,
            ),
            revision: null,
        };

        expect(decodeTypedStagedArtifact(artifact)).toBeNull();
        expect(isBrowserStoreStagedArtifact(artifact)).toBe(false);
    });

    it('does not permit a browser-store identity on an opaque native receipt', () => {
        const {
            sha256: _sha256,
            ...artifact
        } = {
            ...createArtifact(),
            path: BROWSER_DOCUMENT_REF,
            fileIdentity: createBrowserStoreFileIdentity(
                BROWSER_DOCUMENT_REF,
                BROWSER_REVISION,
            ),
            revision: BROWSER_REVISION,
        };

        expect(decodeTypedStagedArtifact({
            ...artifact,
            receiptVersion: 2,
        })).toBeNull();
    });

    it('rejects browser identity construction for non-browser refs', () => {
        expect(() => createBrowserStoreFileIdentity('/tmp/staged.pdf', BROWSER_REVISION))
            .toThrow(TypeError);
        expect(() => createBrowserStoreFileIdentity(BROWSER_DOCUMENT_REF, ' ' as typeof BROWSER_REVISION))
            .toThrow(TypeError);
    });

    it.each([
        {receiptVersion: 3},
        {artifactKind: 'binary'},
        {size: -1},
        {sha256: 'not-a-digest'},
        {leaseId: ''},
        {revision: ' '},
        {fileIdentity: {
            platform: 'posix',
            deviceId: '-1',
            inode: '2',
        }},
        {fileIdentity: {
            platform: 'win32',
            volumeId: '',
            fileId: '2',
        }},
        {validations: {
            qpdfCheck: true,
            tailCheck: false,
            semanticCheck: false,
            fsynced: false,
        }},
        {validations: {
            qpdfCheck: false,
            tailCheck: false,
            semanticCheck: true,
            fsynced: false,
        }},
        {validations: {
            qpdfCheck: false,
            tailCheck: false,
            semanticCheck: false,
            fsynced: false,
            changedObjectRefsSha256: 'invalid',
        }},
        {validations: {
            qpdfCheck: true,
            tailCheck: false,
            semanticCheck: false,
            fsynced: false,
            qpdfResult: {
                isValid: true,
                tool: 'native',
                errors: [],
                warnings: [],
            },
        }},
        {validations: {
            qpdfCheck: true,
            tailCheck: false,
            semanticCheck: false,
            fsynced: false,
            qpdfResult: {
                isValid: false,
                tool: 'qpdf',
                errors: ['damaged'],
                warnings: [],
            },
        }},
    ])('rejects malformed receipt input %#', (override) => {
        expect(decodeTypedStagedArtifact({
            ...createArtifact(),
            ...override,
        })).toBeNull();
        expect(isTypedStagedArtifact({
            ...createArtifact(),
            ...override,
        })).toBe(false);
    });
});
