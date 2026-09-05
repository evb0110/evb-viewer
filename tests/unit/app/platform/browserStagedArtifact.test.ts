import {createHash} from 'node:crypto';
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {BrowserDocumentStore} from '@app/platform/browserDocumentStore';
import {
    commitBrowserStoreStagedArtifact,
    createBrowserStoreStagedArtifact,
} from '@app/platform/browser/browserStagedArtifact';
import {
    FakeIndexedDbFactory,
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

describe('browser staged artifact commit', () => {
    beforeEach(() => {
        vi.unstubAllGlobals();
        vi.stubGlobal('indexedDB', new FakeIndexedDbFactory());
        vi.stubGlobal('window', {localStorage: new MemoryStorage()});
        vi.stubGlobal('document', {cookie: ''});
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('commits a browser-store receipt and removes the consumed staged record', async () => {
        const store = new BrowserDocumentStore();
        const sourceBytes = Uint8Array.of(37, 80, 68, 70, 1);
        const stagedBytes = Uint8Array.of(37, 80, 68, 70, 2, 3);
        const sourceRef = await store.createStoredDocument(
            'source.pdf',
            sourceBytes,
            PDF_OPTIONS,
        );
        const workingRef = await store.cloneAsWorkingCopy(sourceRef);
        const stagedRef = await store.createStoredDocument(
            'staged.pdf',
            stagedBytes,
            {
                ...PDF_OPTIONS,
                kind: 'output',
                retention: 'durable',
            },
        );
        await store.touchRecentFile(sourceRef);
        await store.touchRecentFile(stagedRef);
        expect(store.getRecentFiles().map(file => file.originalPath)).toEqual(
            expect.arrayContaining([
                sourceRef,
                stagedRef,
            ]),
        );
        const workingRevision = await store.getDocumentRevision(workingRef);
        const stagedArtifact = await createBrowserStoreStagedArtifact(store, stagedRef, {
            leaseId: 'browser-staged-lease',
            sha256: sha256(stagedBytes),
            validations: stagedValidations(),
        });
        const revisionEvents: Array<{
            documentRef: string;
            previousToken?: string;
            reason: string;
            token: string;
        }> = [];
        const unsubscribe = store.onDocumentRevisionChanged(event => {
            revisionEvents.push({
                documentRef: event.documentRef,
                ...(event.previousToken ? {previousToken: event.previousToken} : {}),
                reason: event.reason,
                token: event.token,
            });
        });

        try {
            await expect(commitBrowserStoreStagedArtifact(
                store,
                stagedArtifact,
                workingRef,
                workingRevision.token,
            )).resolves.toBe(true);
        } finally {
            unsubscribe();
        }

        await expect(store.read(workingRef)).resolves.toEqual(stagedBytes);
        await expect(store.read(sourceRef)).resolves.toEqual(sourceBytes);
        await expect(store.exists(stagedRef)).resolves.toBe(false);
        expect(store.getRecentFiles().map(file => file.originalPath)).toContain(sourceRef);
        expect(store.getRecentFiles().map(file => file.originalPath)).not.toContain(stagedRef);
        const committedRevision = await store.getDocumentRevision(workingRef);
        expect(revisionEvents).toContainEqual({
            documentRef: workingRef,
            previousToken: workingRevision.token,
            reason: 'write',
            token: committedRevision.token,
        });
    });

    it('rejects a browser staged self-commit without consuming the staged record', async () => {
        const store = new BrowserDocumentStore();
        const stagedBytes = Uint8Array.of(37, 80, 68, 70, 4);
        const stagedRef = await store.createStoredDocument(
            'self-commit-output.pdf',
            stagedBytes,
            {
                ...PDF_OPTIONS,
                kind: 'output',
                retention: 'transient',
            },
        );
        const stagedRevision = await store.getDocumentRevision(stagedRef);
        const stagedArtifact = await createBrowserStoreStagedArtifact(store, stagedRef, {
            leaseId: 'browser-self-commit-lease',
            sha256: sha256(stagedBytes),
            validations: stagedValidations(),
        });

        await expect(commitBrowserStoreStagedArtifact(
            store,
            stagedArtifact,
            stagedRef,
            stagedRevision.token,
        )).rejects.toThrow('different browser target ref');
        await expect(store.exists(stagedRef)).resolves.toBe(true);
    });

    it('rejects a semantic receipt without its scope proof before consuming it', async () => {
        const store = new BrowserDocumentStore();
        const sourceRef = await store.createStoredDocument('semantic-source.pdf', Uint8Array.of(1), PDF_OPTIONS);
        const workingRef = await store.cloneAsWorkingCopy(sourceRef);
        const stagedBytes = Uint8Array.of(2);
        const stagedRef = await store.createStoredDocument('semantic-output.pdf', stagedBytes, {
            ...PDF_OPTIONS,
            kind: 'output',
            retention: 'transient',
        });
        const targetRevision = await store.getDocumentRevision(workingRef);
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

        await expect(commitBrowserStoreStagedArtifact(
            store,
            missingScopeArtifact,
            workingRef,
            targetRevision.token,
        )).rejects.toThrow('Expected a browser-store staged artifact');
        await expect(store.exists(stagedRef)).resolves.toBe(true);
        await expect(store.read(workingRef)).resolves.toEqual(Uint8Array.of(1));
    });

    it('leaves the staged record available when the target revision is stale', async () => {
        const store = new BrowserDocumentStore();
        const sourceRef = await store.createStoredDocument(
            'stale-target.pdf',
            Uint8Array.of(37, 80, 68, 70, 1),
            PDF_OPTIONS,
        );
        const workingRef = await store.cloneAsWorkingCopy(sourceRef);
        const stagedBytes = Uint8Array.of(37, 80, 68, 70, 9);
        const stagedRef = await store.createStoredDocument(
            'stale-target.staged.pdf',
            stagedBytes,
            {
                ...PDF_OPTIONS,
                kind: 'output',
                retention: 'transient',
            },
        );
        const staleTargetRevision = await store.getDocumentRevision(workingRef);
        await store.writeForBootstrap(
            workingRef,
            Uint8Array.of(37, 80, 68, 70, 8),
            'advance-before-staged-commit',
        );
        const stagedArtifact = await createBrowserStoreStagedArtifact(store, stagedRef, {
            leaseId: 'browser-stale-target-lease',
            sha256: sha256(stagedBytes),
            validations: stagedValidations(),
        });

        await expect(commitBrowserStoreStagedArtifact(
            store,
            stagedArtifact,
            workingRef,
            staleTargetRevision.token,
        )).rejects.toThrow('Browser staged artifact content or revision changed during commit');

        await expect(store.read(workingRef)).resolves.toEqual(Uint8Array.of(37, 80, 68, 70, 8));
        await expect(store.exists(stagedRef)).resolves.toBe(true);
    });

    it('rejects staged bytes after their browser-store revision changes', async () => {
        const store = new BrowserDocumentStore();
        const sourceRef = await store.createStoredDocument(
            'stale-staged.pdf',
            Uint8Array.of(37, 80, 68, 70, 1),
            PDF_OPTIONS,
        );
        const workingRef = await store.cloneAsWorkingCopy(sourceRef);
        const stagedBytes = Uint8Array.of(37, 80, 68, 70, 9);
        const stagedRef = await store.createStoredDocument(
            'stale-staged-output.pdf',
            stagedBytes,
            {
                ...PDF_OPTIONS,
                kind: 'output',
                retention: 'transient',
            },
        );
        const workingRevision = await store.getDocumentRevision(workingRef);
        const stagedArtifact = await createBrowserStoreStagedArtifact(store, stagedRef, {
            leaseId: 'browser-stale-staged-lease',
            sha256: sha256(stagedBytes),
            validations: stagedValidations(),
        });
        await store.writeForBootstrap(
            stagedRef,
            Uint8Array.of(37, 80, 68, 70, 7),
            'advance-staged-artifact-revision',
        );

        await expect(commitBrowserStoreStagedArtifact(
            store,
            stagedArtifact,
            workingRef,
            workingRevision.token,
        )).rejects.toThrow('changed after staging');
        await expect(store.read(workingRef)).resolves.toEqual(Uint8Array.of(37, 80, 68, 70, 1));
        await expect(store.exists(stagedRef)).resolves.toBe(true);
    });

    it('does not delete a staged revision replaced by another browser store', async () => {
        const store = new BrowserDocumentStore();
        const sourceRef = await store.createStoredDocument(
            'concurrent-stage.pdf',
            Uint8Array.of(37, 80, 68, 70, 1),
            PDF_OPTIONS,
        );
        const workingRef = await store.createStoredDocument(
            'concurrent-stage-working.pdf',
            new Uint8Array(),
            {
                mimeType: 'application/pdf',
                kind: 'working',
                retention: 'durable',
                saveKind: 'pdf',
                sourceRef,
                storageMode: 'source-proxy',
            },
        );
        const stagedBytes = Uint8Array.of(37, 80, 68, 70, 9);
        const replacementBytes = Uint8Array.of(37, 80, 68, 70, 7);
        const stagedRef = await store.createStoredDocument(
            'concurrent-stage-output.pdf',
            stagedBytes,
            {
                ...PDF_OPTIONS,
                kind: 'output',
                retention: 'durable',
            },
        );
        const workingRevision = await store.getDocumentRevision(workingRef);
        const stagedArtifact = await createBrowserStoreStagedArtifact(store, stagedRef, {
            leaseId: 'browser-concurrent-stage-lease',
            sha256: sha256(stagedBytes),
            validations: stagedValidations(),
        });
        await store.touchRecentFile(sourceRef);
        await store.touchRecentFile(workingRef);
        await store.touchRecentFile(stagedRef);

        const concurrentStore = new BrowserDocumentStore();
        await concurrentStore.writeForBootstrap(
            stagedRef,
            replacementBytes,
            'replace-staged-artifact-before-commit',
        );

        await expect(commitBrowserStoreStagedArtifact(
            store,
            stagedArtifact,
            workingRef,
            workingRevision.token,
        )).rejects.toThrow('Browser staged artifact content or revision changed during commit');

        await expect(concurrentStore.read(stagedRef)).resolves.toEqual(replacementBytes);
        await expect(concurrentStore.read(workingRef)).resolves.toEqual(Uint8Array.of(37, 80, 68, 70, 1));
        await expect(concurrentStore.exists(stagedRef)).resolves.toBe(true);
    });
});
