import {createHash} from 'node:crypto';
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {BROWSER_PAGE_OPS_MAX_OUTPUT_BYTES} from '@contracts/browserPageOpsLimits';
import {BrowserDocumentStore} from '@app/platform/browserDocumentStore';
import {
    createBrowserStoreStagedArtifact,
    readBrowserStoreStagedArtifact,
} from '@app/platform/browser/browserStagedArtifact';
import {
    MemoryStorage,
} from '@tests/unit/app/platform/browserPlatformTestDoubles';

const PDF_OPTIONS = {
    mimeType: 'application/pdf',
    kind: 'source',
    saveKind: 'pdf',
} as const;

function sha256(bytes: Uint8Array) {
    return createHash('sha256').update(bytes).digest('hex');
}

function stagedValidations() {
    return {
        qpdfCheck: false,
        tailCheck: true,
        semanticCheck: true,
        fsynced: true,
        semanticScopeSha256: 'a'.repeat(64),
    };
}

describe('browser staged artifact receipt', () => {
    beforeEach(() => {
        vi.unstubAllGlobals();
        vi.stubGlobal('window', {localStorage: new MemoryStorage()});
        vi.stubGlobal('document', {cookie: ''});
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('reads the staged bytes its receipt names', async () => {
        const store = new BrowserDocumentStore();
        const stagedBytes = Uint8Array.of(37, 80, 68, 70, 2, 3);
        const stagedRef = await store.createStoredDocument('staged.pdf', stagedBytes, {...PDF_OPTIONS, kind: 'output', retention: 'transient'});
        const artifact = await createBrowserStoreStagedArtifact(store, stagedRef, {
            leaseId: 'browser-read-lease',
            sha256: sha256(stagedBytes),
            validations: stagedValidations(),
        });

        await expect(readBrowserStoreStagedArtifact(store, artifact, {maxBytes: BROWSER_PAGE_OPS_MAX_OUTPUT_BYTES}))
            .resolves.toMatchObject({bytes: stagedBytes});
    });

    it('rejects a semantic receipt without its scope proof', async () => {
        const store = new BrowserDocumentStore();
        const stagedBytes = Uint8Array.of(2);
        const stagedRef = await store.createStoredDocument('semantic-output.pdf', stagedBytes, {...PDF_OPTIONS, kind: 'output', retention: 'transient'});
        const validArtifact = await createBrowserStoreStagedArtifact(store, stagedRef, {
            leaseId: 'browser-semantic-lease',
            sha256: sha256(stagedBytes),
            validations: stagedValidations(),
        });
        const missingScopeArtifact = {
            ...validArtifact,
            validations: {
                ...validArtifact.validations,
                semanticScopeSha256: undefined,
            },
        };

        await expect(readBrowserStoreStagedArtifact(store, missingScopeArtifact)).rejects.toThrow('Expected a browser-store staged artifact');
    });

    it('rejects staged bytes after their browser-store revision changes', async () => {
        const store = new BrowserDocumentStore();
        const stagedBytes = Uint8Array.of(37, 80, 68, 70, 9);
        const stagedRef = await store.createStoredDocument('stale-staged-output.pdf', stagedBytes, {...PDF_OPTIONS, kind: 'output', retention: 'transient'});
        const stagedArtifact = await createBrowserStoreStagedArtifact(store, stagedRef, {
            leaseId: 'browser-stale-staged-lease',
            sha256: sha256(stagedBytes),
            validations: stagedValidations(),
        });
        await store.write(stagedRef, Uint8Array.of(37, 80, 68, 70, 7), {expectedDocumentRevisionToken: (await store.getDocumentRevision(stagedRef)).token});

        await expect(readBrowserStoreStagedArtifact(store, stagedArtifact)).rejects.toThrow('changed after staging');
    });
});
