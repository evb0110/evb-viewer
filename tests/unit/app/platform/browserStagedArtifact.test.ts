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
    commitBrowserStoreStagedArtifact,
    createBrowserStoreStagedArtifact,
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

describe('browser staged artifact commit', () => {
    beforeEach(() => {
        vi.unstubAllGlobals();
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

    it.each([
        2047,
        64,
    ])('rejects a staged output above the configured %iMB read budget before replacing the target', async (limitMiB) => {
        // The default is the engine's output ceiling, 2 GiB - 1 (2047 whole MiB).
        const maxBytes = limitMiB === 2047 ? BROWSER_PAGE_OPS_MAX_OUTPUT_BYTES : limitMiB * 1024 * 1024;
        const store = new BrowserDocumentStore();
        const sourceRef = await store.createStoredDocument('oversized-source.pdf', Uint8Array.of(1), PDF_OPTIONS);
        const workingRef = await store.cloneAsWorkingCopy(sourceRef);
        const stagedBytes = Uint8Array.of(2);
        const stagedRef = await store.createStoredDocument('oversized-output.pdf', stagedBytes, {
            ...PDF_OPTIONS,
            kind: 'output',
            retention: 'transient',
        });
        const workingRevision = await store.getDocumentRevision(workingRef);
        const stagedArtifact = await createBrowserStoreStagedArtifact(store, stagedRef, {
            leaseId: 'browser-oversized-output-lease',
            sha256: sha256(stagedBytes),
            validations: stagedValidations(),
        });

        await expect(commitBrowserStoreStagedArtifact(
            store,
            {
                ...stagedArtifact,
                size: maxBytes + 1,
            },
            workingRef,
            workingRevision.token,
            limitMiB === 2047 ? undefined : {maxBytes},
        )).rejects.toMatchObject({
            message: `Browser staged PDF output exceeds the ${limitMiB}MB browser read limit`,
            errorEnvelope: {
                code: 'browser-byte-limit',
                maxBytes,
            },
        });
        await expect(store.read(workingRef)).resolves.toEqual(Uint8Array.of(1));
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
        await store.write(workingRef, Uint8Array.of(37, 80, 68, 70, 8), {expectedDocumentRevisionToken: (await store.getDocumentRevision(workingRef)).token});
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
        )).rejects.toThrow('STALE_REVISION');

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
        await store.write(stagedRef, Uint8Array.of(37, 80, 68, 70, 7), {expectedDocumentRevisionToken: (await store.getDocumentRevision(stagedRef)).token});

        await expect(commitBrowserStoreStagedArtifact(
            store,
            stagedArtifact,
            workingRef,
            workingRevision.token,
        )).rejects.toThrow('changed after staging');
        await expect(store.read(workingRef)).resolves.toEqual(Uint8Array.of(37, 80, 68, 70, 1));
        await expect(store.exists(stagedRef)).resolves.toBe(true);
    });
});
