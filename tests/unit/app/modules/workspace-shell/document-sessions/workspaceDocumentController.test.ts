import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    nextTick,
    ref,
} from 'vue';
import {
    requireDocumentRef,
    type TDocumentRef,
} from '@contracts/documentRef';
import type { IDocumentRevisionInfo } from '@contracts/documentRevision';
import { requireEpochMs } from '@contracts/timestamps';
import { requireDocumentInstanceId } from '@contracts/documentInstanceId';
import { createWorkspaceDocumentController } from '@app/modules/workspace-shell/document-sessions/workspaceDocumentController';
import { createWorkspaceDocumentRecord } from '@app/modules/workspace-shell/state/workspaceDocumentRecord';
import {createTabViewSessionState} from '@app/modules/workspace-shell/tabs/createTabViewSessionState';
import {
    createDefaultWorkspaceToolbarSnapshot,
    createDefaultWorkspaceViewerCapabilities,
} from '@app/types/workspaceExpose';
import {requireDocumentRevisionToken} from '@contracts/documentRevision';
import { createWorkspaceExposeFixture } from '@tests/unit/app/modules/workspace-shell/workspaceTestFixtures';

function createDocumentRevision(token = 'revision-1', documentRef = '/tmp/working.pdf'): IDocumentRevisionInfo {
    return {
        version: 1,
        token: requireDocumentRevisionToken(token),
        documentRef: requireDocumentRef(documentRef),
        authority: 'browser-document-store',
        contentRevision: token === 'revision-1' ? 1 : 2,
        mintedAt: requireEpochMs(token === 'revision-1' ? 1 : 2),
    };
}

function createWorkspace() {
    return createWorkspaceExposeFixture({hasPdf: true});
}

describe('WorkspaceDocumentController', () => {
    it('publishes a pending document record while a cold workspace restores a parent path', async () => {
        const session = createWorkspaceDocumentController({tabId: 'tab-1'});
        const published: Array<ReturnType<typeof session.toWorkspaceRecord>> = [];

        session.bindWorkspaceProjection({
            pendingDocumentPath: ref<TDocumentRef | null | undefined>(requireDocumentRef('/docs/cold.pdf')),
            openBatchProgress: ref(null),
            hasPdf: ref(false),
            isDjvuMode: ref(false),
            fileName: ref(null),
            originalPath: ref(null),
            documentIdentity: ref(null),
            isDirty: ref(false),
            djvuSourcePath: ref(null),
            toolbarSnapshot: ref(createDefaultWorkspaceToolbarSnapshot()),
            formatPendingBatchLabel: values => `${values.processed}/${values.total}`,
            publishRecord: record => published.push(record),
        });

        await nextTick();

        expect(published.at(-1)).toMatchObject({
            tab: {
                fileName: 'cold.pdf',
                originalPath: '/docs/cold.pdf',
                isDirty: false,
                isDjvu: false,
            },
            toolbarSnapshot: {
                hasPdf: true,
                isOpeningDocument: true,
                isDjvuMode: false,
            },
            viewState: {continuousScroll: true},
        });
    });

    it('does not derive pending DjVu view state from fallback toolbar continuous-scroll defaults', async () => {
        const session = createWorkspaceDocumentController({tabId: 'tab-1'});
        const published: Array<ReturnType<typeof session.toWorkspaceRecord>> = [];
        const fallbackSnapshot = {
            ...createDefaultWorkspaceToolbarSnapshot(),
            continuousScroll: false,
        };

        session.bindWorkspaceProjection({
            pendingDocumentPath: ref<TDocumentRef | null | undefined>(requireDocumentRef('/docs/scan.djvu')),
            openBatchProgress: ref(null),
            hasPdf: ref(false),
            isDjvuMode: ref(false),
            fileName: ref(null),
            originalPath: ref(null),
            documentIdentity: ref(null),
            isDirty: ref(false),
            djvuSourcePath: ref(null),
            toolbarSnapshot: ref(fallbackSnapshot),
            formatPendingBatchLabel: values => `${values.processed}/${values.total}`,
            publishRecord: record => published.push(record),
        });

        await nextTick();

        expect(published.at(-1)?.toolbarSnapshot).toMatchObject({
            continuousScroll: false,
            isDjvuMode: true,
            isOpeningDocument: true,
        });
        expect(published.at(-1)?.viewState.continuousScroll).toBe(false);
    });

    it('publishes document identity from workspace records', () => {
        const session = createWorkspaceDocumentController({
            tabId: 'tab-1',
            sessionId: 'session-1',
        });

        session.applyWorkspaceRecord(createWorkspaceDocumentRecord({
            tab: {
                fileName: 'Document.pdf',
                originalPath: requireDocumentRef('/tmp/original.pdf'),
                isDirty: true,
                isDjvu: false,
            },
            documentIdentity: createDocumentRevision(),
            toolbarSnapshot: {
                initialVisualReady: true,
                viewerCapabilities: {
                    ...createDefaultWorkspaceViewerCapabilities(),
                    closeableDocument: true,
                },
            },
        }), 'workspace');

        expect(session.snapshot.value.identity).toMatchObject({
            documentSessionKey: expect.any(String),
            documentInstanceId: expect.any(String),
            documentRef: '/tmp/working.pdf',
            originalPath: '/tmp/original.pdf',
            workingCopyPath: '/tmp/working.pdf',
            fileName: 'Document.pdf',
            isDjvu: false,
            revisionInfo: {token: requireDocumentRevisionToken('revision-1')},
        });
        expect(session.snapshot.value.dirty).toBe(true);
        expect(session.snapshot.value.closeable).toBe(true);
        expect(session.snapshot.value.phase).toBe('ready');
    });

    it('does not let a same-revision clean adoption clear recovered dirty state', () => {
        const session = createWorkspaceDocumentController({
            tabId: 'tab-1',
            sessionId: 'session-1',
        });
        const recoveredRecord = createWorkspaceDocumentRecord({
            tab: {
                fileName: 'Document.pdf',
                originalPath: requireDocumentRef('/tmp/original.pdf'),
                isDirty: true,
                isDjvu: false,
            },
            documentIdentity: createDocumentRevision('revision-1', '/tmp/working.pdf'),
            toolbarSnapshot: {initialVisualReady: true},
        });
        session.applyWorkspaceRecord(recoveredRecord, 'workspace');

        session.applyWorkspaceRecord(createWorkspaceDocumentRecord({
            ...recoveredRecord,
            tab: {
                ...recoveredRecord.tab,
                isDirty: false,
            },
        }), 'workspace');

        expect(session.snapshot.value.dirty).toBe(true);

        session.applyWorkspaceRecord(createWorkspaceDocumentRecord({
            ...recoveredRecord,
            tab: {
                ...recoveredRecord.tab,
                isDirty: false,
            },
            documentIdentity: null,
        }), 'workspace');

        expect(session.snapshot.value.dirty).toBe(true);

        session.applyWorkspaceRecord(createWorkspaceDocumentRecord({
            ...recoveredRecord,
            tab: {
                ...recoveredRecord.tab,
                isDirty: false,
            },
            documentIdentity: createDocumentRevision('revision-2', '/tmp/working.pdf'),
        }), 'workspace');

        expect(session.snapshot.value.dirty).toBe(false);
    });

    it('clears recovered dirty state when the save revision arrives before the clean flag', () => {
        const session = createWorkspaceDocumentController({
            tabId: 'tab-1',
            sessionId: 'session-1',
        });
        const recoveredRecord = createWorkspaceDocumentRecord({
            tab: {
                fileName: 'Document.pdf',
                originalPath: requireDocumentRef('/tmp/original.pdf'),
                isDirty: true,
                isDjvu: false,
            },
            documentIdentity: createDocumentRevision('revision-1', '/tmp/working.pdf'),
            toolbarSnapshot: {initialVisualReady: true},
        });
        session.applyWorkspaceRecord(recoveredRecord, 'workspace');

        const savedRecord = createWorkspaceDocumentRecord({
            ...recoveredRecord,
            documentIdentity: createDocumentRevision('revision-2', '/tmp/working.pdf'),
        });
        session.applyWorkspaceRecord(savedRecord, 'workspace');

        expect(session.snapshot.value.dirty).toBe(true);

        session.applyWorkspaceRecord(createWorkspaceDocumentRecord({
            ...savedRecord,
            tab: {
                ...savedRecord.tab,
                isDirty: false,
            },
        }), 'workspace');

        expect(session.snapshot.value.dirty).toBe(false);
    });

    it('lets a saved revision clear recovered dirty state while the viewer reloads', () => {
        const session = createWorkspaceDocumentController({
            tabId: 'tab-1',
            sessionId: 'session-1',
        });
        const recoveredRecord = createWorkspaceDocumentRecord({
            tab: {
                fileName: 'Document.pdf',
                originalPath: requireDocumentRef('/tmp/original.pdf'),
                isDirty: true,
                isDjvu: false,
            },
            documentIdentity: createDocumentRevision('revision-1', '/tmp/working.pdf'),
            toolbarSnapshot: {initialVisualReady: true},
        });
        session.applyWorkspaceRecord(recoveredRecord, 'workspace');

        session.applyWorkspaceRecord(createWorkspaceDocumentRecord({
            ...recoveredRecord,
            tab: {
                ...recoveredRecord.tab,
                isDirty: false,
            },
            toolbarSnapshot: {isOpeningDocument: true},
        }), 'workspace');

        expect(session.snapshot.value.dirty).toBe(true);

        session.applyWorkspaceRecord(createWorkspaceDocumentRecord({
            ...recoveredRecord,
            tab: {
                ...recoveredRecord.tab,
                isDirty: false,
            },
            documentIdentity: createDocumentRevision('revision-2', '/tmp/working.pdf'),
            toolbarSnapshot: {isOpeningDocument: true},
        }), 'workspace');

        expect(session.snapshot.value.dirty).toBe(false);
    });

    it('keeps checkpoint dirty state through a failed restore opening record', () => {
        const initialTab = {
            fileName: 'Document.pdf',
            originalPath: requireDocumentRef('/tmp/original.pdf'),
            isDirty: true,
            isDjvu: false,
        };
        const initialRecord = createWorkspaceDocumentRecord({tab: initialTab});
        const session = createWorkspaceDocumentController({
            tabId: 'tab-1',
            sessionId: 'session-1',
            initialRecord,
        });
        const restore = session.beginTransaction({
            kind: 'restore',
            documentRef: requireDocumentRef('/tmp/original.pdf'),
        });

        session.applyWorkspaceRecord(createWorkspaceDocumentRecord({
            tab: {
                fileName: 'Document.pdf',
                originalPath: requireDocumentRef('/tmp/original.pdf'),
                isDirty: false,
                isDjvu: false,
            },
            toolbarSnapshot: {isOpeningDocument: true},
        }), 'workspace');

        expect(session.snapshot.value.dirty).toBe(true);
        session.finishTransaction(restore.id, 'failed');
        expect(session.snapshot.value.dirty).toBe(true);
    });

    it('keeps recovered dirty state when the restore projection arrives after the transaction', () => {
        const originalPath = requireDocumentRef('/tmp/original.pdf');
        const session = createWorkspaceDocumentController({
            tabId: 'tab-1',
            sessionId: 'session-1',
            initialRecord: createWorkspaceDocumentRecord({tab: {
                fileName: 'Document.pdf',
                originalPath,
                isDirty: true,
                isDjvu: false,
            }}),
        });

        session.applyWorkspaceRecord(createWorkspaceDocumentRecord({
            tab: {
                fileName: 'Document.pdf',
                originalPath,
                isDirty: false,
                isDjvu: false,
            },
            toolbarSnapshot: {isOpeningDocument: true},
        }), 'workspace');

        expect(session.snapshot.value.dirty).toBe(true);
    });

    it('does not infer readiness from document identity and viewer capabilities alone', () => {
        const session = createWorkspaceDocumentController({
            tabId: 'tab-1',
            sessionId: 'session-1',
        });

        session.applyWorkspaceRecord(createWorkspaceDocumentRecord({
            tab: {
                fileName: 'Document.pdf',
                originalPath: requireDocumentRef('/tmp/original.pdf'),
            },
            documentIdentity: createDocumentRevision(),
            toolbarSnapshot: {viewerCapabilities: {
                ...createDefaultWorkspaceViewerCapabilities(),
                closeableDocument: true,
                pdfDocument: true,
            }},
        }), 'workspace');

        expect(session.snapshot.value.phase).toBe('empty');
    });

    it('preserves a failed open phase until a visual-ready record arrives', () => {
        const session = createWorkspaceDocumentController({
            tabId: 'tab-1',
            sessionId: 'session-1',
        });
        const transaction = session.beginTransaction({
            kind: 'open',
            documentRef: requireDocumentRef('/tmp/original.pdf'),
        });
        session.finishTransaction(transaction.id, 'failed');

        const baseRecord = createWorkspaceDocumentRecord({
            tab: {
                fileName: 'Document.pdf',
                originalPath: requireDocumentRef('/tmp/original.pdf'),
            },
            documentIdentity: createDocumentRevision(),
            toolbarSnapshot: {viewerCapabilities: {
                ...createDefaultWorkspaceViewerCapabilities(),
                closeableDocument: true,
                pdfDocument: true,
            }},
        });
        session.applyWorkspaceRecord(baseRecord, 'workspace');
        expect(session.snapshot.value.phase).toBe('error');

        session.applyWorkspaceRecord(createWorkspaceDocumentRecord({
            ...baseRecord,
            toolbarSnapshot: {
                ...baseRecord.toolbarSnapshot,
                initialVisualReady: true,
            },
        }), 'workspace');
        expect(session.snapshot.value.phase).toBe('ready');
    });

    it('mints a document session key and preserves it across revision changes', () => {
        const session = createWorkspaceDocumentController({
            tabId: 'tab-1',
            sessionId: 'session-1',
            initialRecord: createWorkspaceDocumentRecord({
                tab: {
                    fileName: 'Document.pdf',
                    originalPath: requireDocumentRef('/tmp/original.pdf'),
                    isDirty: false,
                    isDjvu: false,
                },
                documentIdentity: createDocumentRevision('revision-1'),
            }),
            createDocumentSessionKey: input => `document-key-${input.nextDocumentSessionIndex}:${input.documentRef}`,
        });

        const initialKey = session.snapshot.value.identity.documentSessionKey;

        expect(initialKey).toBe('document-key-1:/tmp/working.pdf');

        session.applyRevisionInfo(createDocumentRevision('revision-2'));

        expect(session.snapshot.value.identity.documentSessionKey).toBe(initialKey);
    });

    it('remints the document session key when the logical document changes', () => {
        const session = createWorkspaceDocumentController({
            tabId: 'tab-1',
            sessionId: 'session-1',
            initialRecord: createWorkspaceDocumentRecord({
                tab: {
                    fileName: 'A.pdf',
                    originalPath: requireDocumentRef('/tmp/a.pdf'),
                    isDirty: false,
                    isDjvu: false,
                },
                documentIdentity: createDocumentRevision('revision-1', '/tmp/a-working.pdf'),
            }),
            createDocumentSessionKey: input => `document-key-${input.nextDocumentSessionIndex}:${input.documentRef}`,
        });

        expect(session.snapshot.value.identity.documentSessionKey).toBe('document-key-1:/tmp/a-working.pdf');

        session.applyWorkspaceRecord(createWorkspaceDocumentRecord({
            tab: {
                fileName: 'B.pdf',
                originalPath: requireDocumentRef('/tmp/b.pdf'),
                isDirty: false,
                isDjvu: false,
            },
            documentIdentity: createDocumentRevision('revision-2', '/tmp/b-working.pdf'),
        }), 'workspace');

        expect(session.snapshot.value.identity.documentSessionKey).toBe('document-key-2:/tmp/b-working.pdf');
    });

    it('clears the document session key when an explicit close makes the session empty', () => {
        const session = createWorkspaceDocumentController({
            tabId: 'tab-1',
            sessionId: 'session-1',
            initialRecord: createWorkspaceDocumentRecord({
                tab: {
                    fileName: 'A.pdf',
                    originalPath: requireDocumentRef('/tmp/a.pdf'),
                    isDirty: false,
                    isDjvu: false,
                },
                documentIdentity: createDocumentRevision('revision-1', '/tmp/a-working.pdf'),
            }),
            createDocumentSessionKey: input => `document-key-${input.nextDocumentSessionIndex}:${input.documentRef}`,
        });

        const close = session.beginTransaction({
            kind: 'close',
            documentRef: requireDocumentRef('/tmp/a-working.pdf'),
            persist: false,
        });
        session.applyWorkspaceRecord(createWorkspaceDocumentRecord(), 'workspace');
        session.finishTransaction(close.id, 'committed');

        expect(session.snapshot.value.identity.documentSessionKey).toBeNull();
    });

    it('returns the record to the empty-tab shape when a close commits', () => {
        const session = createWorkspaceDocumentController({
            tabId: 'tab-1',
            sessionId: 'session-1',
            initialRecord: createWorkspaceDocumentRecord({
                tab: {
                    fileName: 'A.pdf',
                    originalPath: requireDocumentRef('/tmp/a.pdf'),
                },
                documentIdentity: createDocumentRevision('revision-1', '/tmp/a-working.pdf'),
                toolbarSnapshot: {
                    hasPdf: true,
                    viewerCapabilities: {
                        ...createDefaultWorkspaceViewerCapabilities(),
                        closeableDocument: true,
                    },
                },
            }),
        });

        const close = session.beginTransaction({
            kind: 'close',
            documentRef: requireDocumentRef('/tmp/a-working.pdf'),
            persist: false,
        });
        session.finishTransaction(close.id, 'committed');

        const record = session.toWorkspaceRecord();
        expect(record.tab).toMatchObject({
            fileName: null,
            originalPath: null,
            isDirty: false,
            isDjvu: false,
        });
        expect(record.toolbarSnapshot.hasPdf).toBe(false);
        expect(record.toolbarSnapshot.viewerCapabilities.closeableDocument).toBe(false);
        expect(record.viewState).toEqual(createTabViewSessionState(
            createDefaultWorkspaceToolbarSnapshot(),
        ));
        expect(session.snapshot.value.closeable).toBe(false);
        expect(session.snapshot.value.phase).toBe('empty');
    });

    it('cancels a pre-mount open and commits an empty session when closed early', async () => {
        const session = createWorkspaceDocumentController({
            tabId: 'tab-1',
            initialViewState: createTabViewSessionState({
                ...createDefaultWorkspaceToolbarSnapshot(),
                currentPage: 64,
                totalPages: 882,
                zoom: 3.76,
            }),
        });
        const openStarted = Promise.withResolvers<undefined>();
        const openSignals: AbortSignal[] = [];
        const open = session.open({
            action: 'openRecentFromPlaceholder',
            target: {
                fileName: 'dictionary.pdf',
                originalPath: requireDocumentRef('/docs/dictionary.pdf'),
                isDirty: false,
                isDjvu: false,
            },
        }, async (signal) => {
            openSignals.push(signal);
            openStarted.resolve(undefined);
            await new Promise<void>((resolve) => {
                signal.addEventListener('abort', () => resolve(), {once: true});
            });
            return true;
        });
        await openStarted.promise;

        await expect(session.close({persist: true})).resolves.toBe(true);
        await expect(open).resolves.toBe(false);

        expect(openSignals[0]?.aborted).toBe(true);
        expect(session.mountedWorkspace.value).toBeNull();
        expect(session.snapshot.value.activeTransaction).toBeNull();
        expect(session.snapshot.value.phase).toBe('empty');
        expect(session.snapshot.value.viewState).toEqual(createTabViewSessionState(
            createDefaultWorkspaceToolbarSnapshot(),
        ));
    });

    it('accepts a new document assigned by the shell after a close committed', () => {
        const session = createWorkspaceDocumentController({
            tabId: 'tab-1',
            sessionId: 'session-1',
            initialRecord: createWorkspaceDocumentRecord({
                tab: {
                    fileName: 'A.pdf',
                    originalPath: requireDocumentRef('/tmp/a.pdf'),
                },
                documentIdentity: createDocumentRevision('revision-1', '/tmp/a-working.pdf'),
            }),
        });

        const close = session.beginTransaction({
            kind: 'close',
            documentRef: requireDocumentRef('/tmp/a-working.pdf'),
            persist: false,
        });
        session.finishTransaction(close.id, 'committed');
        session.applyTabUpdate({
            fileName: 'A.pdf',
            originalPath: requireDocumentRef('/tmp/a.pdf'),
        });

        expect(session.toWorkspaceRecord().tab).toMatchObject({
            fileName: 'A.pdf',
            originalPath: '/tmp/a.pdf',
        });
    });

    it('ignores a transient empty record while remounting a live document session', () => {
        const session = createWorkspaceDocumentController({
            tabId: 'tab-1',
            sessionId: 'session-1',
            initialRecord: createWorkspaceDocumentRecord({
                tab: {
                    fileName: 'A.pdf',
                    originalPath: requireDocumentRef('/tmp/a.pdf'),
                },
                documentIdentity: createDocumentRevision('revision-1', '/tmp/a-working.pdf'),
            }),
        });
        const identityBeforeRemount = session.snapshot.value.identity;

        session.applyWorkspaceRecord(createWorkspaceDocumentRecord(), 'workspace');

        expect(session.snapshot.value.identity).toEqual(identityBeforeRemount);
        expect(session.toWorkspaceRecord().tab).toMatchObject({
            fileName: 'A.pdf',
            originalPath: '/tmp/a.pdf',
        });
    });

    it('supersedes an active transaction with the latest document operation', () => {
        const session = createWorkspaceDocumentController({
            tabId: 'tab-1',
            sessionId: 'session-1',
            createTransactionId: input => `tx-${input.nextTransactionIndex}`,
        });
        const first = session.beginTransaction({
            kind: 'open',
            documentRef: requireDocumentRef('/tmp/a.pdf'),
        });
        const second = session.beginTransaction({
            kind: 'open',
            documentRef: requireDocumentRef('/tmp/b.pdf'),
        });

        expect(first.id).toBe('tx-1');
        expect(second.id).toBe('tx-2');
        expect(session.snapshot.value.activeTransaction?.id).toBe(second.id);
        expect(session.snapshot.value.pendingDocumentPath).toBe('/tmp/b.pdf');

        session.finishTransaction(first.id, 'committed');
        expect(session.snapshot.value.activeTransaction?.id).toBe(second.id);

        session.finishTransaction(second.id, 'committed');

        expect(session.snapshot.value.activeTransaction).toBeNull();
    });

    it('fences stale open records after a superseding close wins', () => {
        const session = createWorkspaceDocumentController({
            tabId: 'tab-1',
            sessionId: 'session-1',
            createTransactionId: input => `tx-${input.nextTransactionIndex}`,
        });
        const open = session.beginTransaction({
            kind: 'open',
            documentRef: requireDocumentRef('/tmp/a.pdf'),
        });
        const close = session.beginTransaction({
            kind: 'close',
            documentRef: requireDocumentRef('/tmp/a.pdf'),
            persist: false,
        });

        expect(session.snapshot.value.activeTransaction?.id).toBe(close.id);
        expect(session.snapshot.value.pendingClose?.persist).toBe(false);

        session.finishTransaction(close.id, 'committed');
        session.applyWorkspaceRecord(createWorkspaceDocumentRecord({
            tab: {
                fileName: 'A.pdf',
                originalPath: requireDocumentRef('/tmp/a.pdf'),
                isDirty: false,
                isDjvu: false,
            },
            documentIdentity: createDocumentRevision('revision-1', '/tmp/a-working.pdf'),
            toolbarSnapshot: {viewerCapabilities: {
                ...createDefaultWorkspaceViewerCapabilities(),
                closeableDocument: true,
            }},
        }), 'workspace');

        expect(session.snapshot.value.identity.documentRef).toBeNull();
        expect(session.snapshot.value.phase).toBe('empty');

        session.finishTransaction(open.id, 'committed');
        expect(session.snapshot.value.identity.documentRef).toBeNull();
    });

    it('rejects stale revision command targets after identity changes', () => {
        const session = createWorkspaceDocumentController({
            tabId: 'tab-1',
            sessionId: 'session-1',
        });
        session.applyWorkspaceRecord(createWorkspaceDocumentRecord({
            tab: {
                fileName: 'Document.pdf',
                originalPath: requireDocumentRef('/tmp/original.pdf'),
                isDirty: false,
                isDjvu: false,
            },
            documentIdentity: createDocumentRevision('revision-1'),
        }), 'workspace');
        const target = session.createCommandTarget();

        session.applyRevisionInfo(createDocumentRevision('revision-2'));

        expect(session.validateCommandTarget(target)).toEqual({
            ok: false,
            reason: 'document-revision-token-mismatch',
        });
    });

    it('rejects stale command targets when a same-revision reopen mints a new document instance', () => {
        let nextInstanceId = 0;
        const session = createWorkspaceDocumentController({
            tabId: 'tab-1',
            sessionId: 'session-1',
            createDocumentInstanceId: () => {
                nextInstanceId += 1;
                return requireDocumentInstanceId(`instance-${nextInstanceId}`);
            },
        });
        const record = createWorkspaceDocumentRecord({
            tab: {
                fileName: 'Document.pdf',
                originalPath: requireDocumentRef('/tmp/original.pdf'),
                isDirty: false,
                isDjvu: false,
            },
            documentIdentity: createDocumentRevision('revision-1'),
        });
        session.applyWorkspaceRecord(record, 'workspace');
        const initialKey = session.snapshot.value.identity.documentSessionKey;
        const target = session.createCommandTarget();

        const reopen = session.beginTransaction({
            kind: 'open',
            documentRef: requireDocumentRef('/tmp/working.pdf'),
        });
        session.applyWorkspaceRecord(record, 'workspace');
        session.finishTransaction(reopen.id, 'committed');

        expect(session.snapshot.value.identity.documentSessionKey).toBe(initialKey);
        expect(session.snapshot.value.identity.documentInstanceId).toBe('instance-2');
        expect(session.snapshot.value.identity.revisionInfo?.token).toBe('revision-1');
        expect(session.validateCommandTarget(target)).toEqual({
            ok: false,
            reason: 'document-instance-id-mismatch',
        });
    });

    it('rejects pending workspace waiters when a target goes stale', async () => {
        const session = createWorkspaceDocumentController({
            tabId: 'tab-1',
            sessionId: 'session-1',
            workspaceWaitTimeoutMs: 1000,
        });
        const target = session.createCommandTarget();
        const wait = session.waitForWorkspace(target);

        session.beginTransaction({
            kind: 'open',
            documentRef: requireDocumentRef('/tmp/next.pdf'),
        });

        await expect(wait).resolves.toBeNull();
    });

    it('resolves current workspace waiters when the workspace attaches', async () => {
        const session = createWorkspaceDocumentController({
            tabId: 'tab-1',
            sessionId: 'session-1',
        });
        const target = session.createCommandTarget();
        const workspace = createWorkspace();
        const wait = session.waitForWorkspace(target);

        session.attachWorkspace(workspace);

        await expect(wait).resolves.toBe(workspace);
        expect(session.snapshot.value.mounted).toBe(true);
    });

    it('keeps the default workspace mount wait open for slow large documents', async () => {
        vi.useFakeTimers();
        try {
            const session = createWorkspaceDocumentController({
                tabId: 'tab-1',
                sessionId: 'session-1',
            });
            let settled = false;
            const wait = session.waitForWorkspace(session.createCommandTarget()).finally(() => {
                settled = true;
            });

            await vi.advanceTimersByTimeAsync(119_999);
            expect(settled).toBe(false);

            await vi.advanceTimersByTimeAsync(1);
            await expect(wait).resolves.toBeNull();
        } finally {
            vi.useRealTimers();
        }
    });

    it('does not change command revision for view-only updates or mounting', () => {
        const session = createWorkspaceDocumentController({
            tabId: 'tab-1',
            sessionId: 'session-1',
        });
        const target = session.createCommandTarget();

        session.attachWorkspace(createWorkspace());
        session.applyViewState({
            surfaceMode: 'reader',
            zoom: 2,
            effectiveZoom: 2,
            zoomMode: 'custom',
            fitMode: 'width',
            viewMode: 'single',
            showSidebar: true,
            continuousScroll: false,
        });

        expect(session.validateCommandTarget(target)).toEqual({ok: true});
    });
});
