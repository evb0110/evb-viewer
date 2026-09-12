import {
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    rmSync,
    statSync,
    writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import {
    basename,
    dirname,
    join,
} from 'path';
import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type { IAgentAssistantChatScope } from '@contracts/agent';
import {requireDocumentRef} from '@contracts/documentRef';
import {requireTabId} from '@contracts/windowTabs';
import {
    AssistantChatPersistence,
    AssistantChatPersistenceError,
} from '@electron/features/agent/assistantChatPersistence';
import { createAssistantChatSessionStore } from '@electron/features/agent/assistantChatSessionStore';
import { createAssistantSessionTurnCoordinator } from '@electron/features/agent/createAssistantSessionTurnCoordinator';
import type { IAssistantSelection } from '@electron/features/agent/assistantProviderStatus';

const tempRoots: string[] = [];

const scope = {
    kind: 'document',
    key: 'document:/tmp/a.pdf',
    title: 'a.pdf',
    tabId: requireTabId('tab-a'),
    documentRef: requireDocumentRef('/tmp/a.pdf'),
} satisfies IAgentAssistantChatScope;

const selection = {
    provider: 'codex',
    model: 'gpt-5',
    effort: 'medium',
    speedMode: 'standard',
} satisfies IAssistantSelection;

function createTempRoot() {
    const root = mkdtempSync(join(tmpdir(), 'evb-assistant-chat-'));
    tempRoots.push(root);
    return root;
}

function createPersistence(rootDir = createTempRoot(), options: Partial<ConstructorParameters<typeof AssistantChatPersistence>[0]> = {}) {
    return new AssistantChatPersistence({
        rootDir,
        maxSessionBytes: 64 * 1024,
        maxSessions: 16,
        ...options,
    });
}

function mutateLastPersistedSnapshot(
    transcriptPath: string,
    mutate: (session: Record<string, unknown>) => void,
) {
    const records = readFileSync(transcriptPath, 'utf8')
        .split(/\r?\n/u)
        .filter(Boolean)
        .map(line => JSON.parse(line) as Record<string, unknown>);
    const snapshot = [...records].reverse().find(record => record.type === 'session-snapshot');
    if (!snapshot || typeof snapshot.session !== 'object' || snapshot.session === null) {
        throw new Error('Expected persisted session snapshot');
    }
    mutate(snapshot.session as Record<string, unknown>);
    writeFileSync(transcriptPath, `${records.map(record => JSON.stringify(record)).join('\n')}\n`);
}

function persistedRecordCount(transcriptPath: string) {
    return readFileSync(transcriptPath, 'utf8').split(/\r?\n/u).filter(Boolean).length;
}

function directoryFileBytes(directory: string) {
    return readdirSync(directory, {withFileTypes: true})
        .filter(entry => entry.isFile())
        .reduce((total, entry) => total + statSync(join(directory, entry.name)).size, 0);
}

afterEach(() => {
    for (const root of tempRoots.splice(0)) {
        rmSync(root, {
            recursive: true,
            force: true,
            maxRetries: 5,
            retryDelay: 20,
        });
    }
});

describe('assistant chat session store persistence', () => {
    it('keeps visible history after the old inactivity window passes', () => {
        const store = createAssistantChatSessionStore({
            persistence: false,
            maxEntries: 4,
        });
        const session = store.getSession(scope, selection, {create: true});
        store.addMessage(session, {
            role: 'user',
            text: 'history must remain visible',
        });
        session.lastAccessedAtMs = Date.now() - 2 * 60 * 60 * 1000;

        expect(store.getSession(scope, selection)?.messages.map(message => message.text)).toEqual(['history must remain visible']);
    });

    it('writes JSONL transcripts and recovers messages', async () => {
        const rootDir = createTempRoot();
        const persistence = createPersistence(rootDir);
        const store = createAssistantChatSessionStore({ persistence });
        const session = store.getSession(scope, selection, { create: true });

        store.addMessage(session, {
            role: 'user',
            text: 'hello',
        });
        store.upsertAssistantMessage(session, 'assistant-1', {
            role: 'assistant',
            text: 'hi',
            pending: false,
        });
        await store.flushPersistenceForTests();

        const recoveredStore = createAssistantChatSessionStore({persistence: createPersistence(rootDir)});
        const messages = recoveredStore.getMessages(scope, selection);

        expect(messages).toHaveLength(2);
        expect(messages.map(message => [
            message.role,
            message.text,
        ])).toEqual([
            [
                'user',
                'hello',
            ],
            [
                'assistant',
                'hi',
            ],
        ]);
    });

    it('coalesces rapid deltas and persists the newest snapshot', async () => {
        const rootDir = createTempRoot();
        const persistence = createPersistence(rootDir);
        const store = createAssistantChatSessionStore({persistence});
        const session = store.getSession(scope, selection, {create: true});
        const deltaCount = 20;

        for (let index = 0; index < deltaCount; index += 1) {
            store.appendAssistantDelta(session, 'assistant-1', String(index % 10));
        }
        await store.flushPersistenceForTests();

        const transcriptPath = persistence.sessionPath(store.keyForSession(session));
        expect(persistedRecordCount(transcriptPath)).toBeLessThan(deltaCount);
        const recoveredStore = createAssistantChatSessionStore({persistence: createPersistence(rootDir)});
        expect(recoveredStore.getMessages(scope, selection)[0]?.text).toBe('01234567890123456789');
    });

    it('does not clone the transcript for each streamed delta', async () => {
        const persistence = createPersistence(createTempRoot(), {snapshotDebounceMs: 60_000});
        const store = createAssistantChatSessionStore({persistence});
        const session = store.getSession(scope, selection, {create: true});
        const message = store.addMessage(session, {
            role: 'user',
            text: 'long conversation history',
        });
        store.upsertAssistantMessage(session, 'assistant-1', {
            role: 'assistant',
            text: '',
            pending: true,
        });
        const createdAt = message.createdAt;
        let createdAtReads = 0;
        Object.defineProperty(message, 'createdAt', {
            configurable: true,
            enumerable: true,
            get() {
                createdAtReads += 1;
                return createdAt;
            },
        });

        for (let index = 0; index < 20; index += 1) {
            store.appendAssistantDelta(session, 'assistant-1', String(index));
        }

        expect(createdAtReads).toBe(0);
        await store.flushPersistenceForTests();
        expect(createdAtReads).toBe(1);
    });

    it('writes a turn boundary without waiting for the snapshot debounce', async () => {
        const persistence = createPersistence(createTempRoot(), {snapshotDebounceMs: 60_000});
        const store = createAssistantChatSessionStore({persistence});
        const coordinator = createAssistantSessionTurnCoordinator({sessionStore: store});
        const session = store.getSession(scope, selection, {create: true});

        coordinator.claimSessionTurn(session);

        const transcriptPath = persistence.sessionPath(store.keyForSession(session));
        await vi.waitFor(() => {
            expect(persistedRecordCount(transcriptPath)).toBe(1);
        });
    });

    it('quarantines a transcript containing corrupt lines instead of partially recovering it', async () => {
        const rootDir = createTempRoot();
        const persistence = createPersistence(rootDir);
        const store = createAssistantChatSessionStore({ persistence });
        const session = store.getSession(scope, selection, { create: true });
        store.addMessage(session, {
            role: 'user',
            text: 'before corrupt line',
        });
        await store.flushPersistenceForTests();

        const transcriptPath = persistence.sessionPath(store.keyForSession(session));
        writeFileSync(transcriptPath, 'not json\n', { flag: 'a' });
        store.addMessage(session, {
            role: 'assistant',
            text: 'after corrupt line',
        });
        await store.flushPersistenceForTests();

        const recoveredStore = createAssistantChatSessionStore({persistence: createPersistence(rootDir)});

        expect(recoveredStore.getMessages(scope, selection)).toEqual([]);
        expect(readdirSync(join(rootDir, 'archive')).some(entry => entry.includes('.corrupt.'))).toBe(true);
        expect(readdirSync(join(rootDir, 'sessions'))).toEqual([]);
    });

    it('recovers the last durable snapshot when a crash leaves a torn final record', async () => {
        const rootDir = createTempRoot();
        const persistence = createPersistence(rootDir);
        const store = createAssistantChatSessionStore({persistence});
        const session = store.getSession(scope, selection, {create: true});
        store.addMessage(session, {
            role: 'user',
            text: 'durable message',
        });
        await store.flushPersistenceForTests();

        const transcriptPath = persistence.sessionPath(store.keyForSession(session));
        writeFileSync(transcriptPath, '{"type":"session-snapshot"', {flag: 'a'});

        const recoveredStore = createAssistantChatSessionStore({persistence: createPersistence(rootDir)});

        expect(recoveredStore.getMessages(scope, selection).map(message => message.text)).toEqual(['durable message']);
        expect(readFileSync(transcriptPath, 'utf8')).toMatch(/\n$/u);
        expect(readdirSync(join(rootDir, 'archive'))).toEqual([]);
    });

    it('deeply rejects and quarantines malformed nested recovery payloads', async () => {
        const corruptions: Array<{
            name: string;
            mutate(session: Record<string, unknown>): void;
        }> = [
            {
                name: 'message attachment',
                mutate(session) {
                    const messages = session.messages as Array<Record<string, unknown>>;
                    messages[0]!.attachments = [{
                        type: 'image',
                        id: 'image-1',
                        name: 'page.png',
                        mimeType: 'image/png',
                        dataUrl: 'data:image/png;base64,AA==',
                        sizeBytes: 'not-a-number',
                    }];
                },
            },
            {
                name: 'message error envelope',
                mutate(session) {
                    const messages = session.messages as Array<Record<string, unknown>>;
                    messages[0]!.errorEnvelope = {
                        code: 'INTERNAL',
                        message: 'broken',
                        retryable: false,
                        timestamp: Number.NaN,
                    };
                },
            },
            {
                name: 'turn owner scope',
                mutate(session) {
                    const turnOwner = session.turnOwner as Record<string, unknown>;
                    const ownerScope = turnOwner.scope as Record<string, unknown>;
                    ownerScope.windowId = 'not-a-window-id';
                },
            },
            {
                name: 'session document identity',
                mutate(session) {
                    const persistedScope = session.scope as Record<string, unknown>;
                    persistedScope.documentIdentity = {
                        version: 1,
                        token: 'revision-1',
                        documentRef: '/tmp/a.pdf',
                        authority: 'electron-working-copy',
                        contentRevision: 1,
                        mintedAt: 'not-a-timestamp',
                    };
                },
            },
        ];

        for (const corruption of corruptions) {
            const rootDir = createTempRoot();
            const onError = vi.fn();
            const persistence = createPersistence(rootDir, {onError});
            const store = createAssistantChatSessionStore({persistence});
            const coordinator = createAssistantSessionTurnCoordinator({sessionStore: store});
            const session = store.getSession(scope, selection, {create: true});
            store.addMessage(session, {
                role: 'user',
                text: corruption.name,
            });
            coordinator.claimSessionTurn(session);
            store.recordSessionSnapshot(session);
            await store.flushPersistenceForTests();

            const transcriptPath = persistence.sessionPath(store.keyForSession(session));
            mutateLastPersistedSnapshot(transcriptPath, corruption.mutate);
            const recoveredPersistence = createPersistence(rootDir, {onError});
            const recoveredStore = createAssistantChatSessionStore({persistence: recoveredPersistence});

            expect(recoveredStore.getMessages(scope, selection), corruption.name).toEqual([]);
            expect(readdirSync(join(rootDir, 'archive')).some(entry => entry.includes('.corrupt.')), corruption.name).toBe(true);
            expect(onError, corruption.name).toHaveBeenCalled();
        }
    });

    it('marks active turns as interrupted during recovery', async () => {
        const rootDir = createTempRoot();
        const persistence = createPersistence(rootDir);
        const store = createAssistantChatSessionStore({ persistence });
        const coordinator = createAssistantSessionTurnCoordinator({ sessionStore: store });
        const session = store.getSession(scope, selection, { create: true });

        coordinator.claimSessionTurn(session);
        coordinator.markSessionTurnRunning(session, session.turnOwner.generation, 'turn-1');
        store.upsertAssistantMessage(session, 'assistant-1', {
            role: 'assistant',
            text: 'partial',
            pending: true,
        });
        await store.flushPersistenceForTests();

        const recoveredStore = createAssistantChatSessionStore({persistence: createPersistence(rootDir)});
        const recovered = recoveredStore.getSession(scope, selection);

        expect(recovered?.turnOwner).toMatchObject({
            phase: 'error',
            generation: session.turnOwner.generation,
        });
        expect(recovered?.lastError).toContain('interrupted');
        expect(recovered?.messages[0]).toMatchObject({
            pending: false,
            error: expect.stringContaining('interrupted'),
        });
    });

    it('prunes persisted sessions by least recent access', async () => {
        const rootDir = createTempRoot();
        const persistence = createPersistence(rootDir, { maxSessions: 2 });
        const store = createAssistantChatSessionStore({
            persistence,
            maxEntries: 10,
        });
        const now = Date.now();

        for (const index of [
            1,
            2,
            3,
        ]) {
            const session = store.getSession({
                ...scope,
                key: `document:/tmp/${index}.pdf`,
                title: `${index}.pdf`,
            }, selection, { create: true });
            store.addMessage(session, {
                role: 'user',
                text: `message-${index}`,
            });
            session.lastAccessedAtMs = now + index;
            store.recordSessionSnapshot(session);
        }
        await store.flushPersistenceForTests();

        const recoveredStore = createAssistantChatSessionStore({
            persistence: createPersistence(rootDir, { maxSessions: 2 }),
            maxEntries: 10,
        });

        expect(recoveredStore.listSessions().map(session => session.scope.key).sort()).toEqual([
            'document:/tmp/2.pdf',
            'document:/tmp/3.pdf',
        ]);
    });

    it('archives transcripts when a session is reset', async () => {
        const rootDir = createTempRoot();
        const persistence = createPersistence(rootDir);
        const store = createAssistantChatSessionStore({ persistence });
        const session = store.getSession(scope, selection, { create: true });
        store.addMessage(session, {
            role: 'user',
            text: 'before reset',
        });

        session.messages.length = 0;
        store.resetSessionTranscript(session, 'reset');
        await store.flushPersistenceForTests();

        const archiveRoot = join(rootDir, 'archive');
        const archiveEntries = readdirSync(archiveRoot);
        const recoveredStore = createAssistantChatSessionStore({persistence: createPersistence(rootDir)});

        expect(archiveEntries.some(entry => entry.includes('.reset.'))).toBe(true);
        const archivedTranscript = archiveEntries.find(entry => entry.includes('.reset.'));
        expect(readFileSync(join(archiveRoot, archivedTranscript!), 'utf8')).toContain('before reset');
        expect(recoveredStore.getMessages(scope, selection)).toEqual([]);
    });

    it('uses the expected storage layout under the persistence root', async () => {
        const rootDir = createTempRoot();
        const persistence = createPersistence(rootDir);
        const store = createAssistantChatSessionStore({ persistence });
        const session = store.getSession(scope, selection, { create: true });
        store.addMessage(session, {
            role: 'user',
            text: 'layout',
        });
        await store.flushPersistenceForTests();

        const transcriptPath = persistence.sessionPath(store.keyForSession(session));
        expect(dirname(transcriptPath)).toBe(join(rootDir, 'sessions'));
        expect(transcriptPath.endsWith('.jsonl')).toBe(true);
    });

    it('keeps transcript filenames bounded for long document session keys', async () => {
        const rootDir = createTempRoot();
        const persistence = createPersistence(rootDir);
        const store = createAssistantChatSessionStore({ persistence });
        const longScope = {
            ...scope,
            key: `document:/tmp/${'deep-path-segment/'.repeat(80)}large.pdf`,
            title: 'large.pdf',
            documentRef: requireDocumentRef(`/tmp/${'deep-path-segment/'.repeat(80)}large.pdf`),
        } satisfies IAgentAssistantChatScope;
        const session = store.getSession(longScope, selection, { create: true });

        store.addMessage(session, {
            role: 'user',
            text: 'long key',
        });
        await store.flushPersistenceForTests();

        const transcriptPath = persistence.sessionPath(store.keyForSession(session));
        expect(basename(transcriptPath)).toMatch(/^v2-[a-f0-9]{64}\.jsonl$/u);
        expect(basename(transcriptPath).length).toBeLessThan(80);

        const recoveredStore = createAssistantChatSessionStore({persistence: createPersistence(rootDir)});
        expect(recoveredStore.getMessages(longScope, selection).map(message => message.text)).toEqual(['long key']);
    });

    it('keeps oversized snapshots within the byte cap and recovers their full history', async () => {
        const rootDir = createTempRoot();
        const persistence = createPersistence(rootDir, {maxSessionBytes: 64 * 1024});
        const store = createAssistantChatSessionStore({persistence});
        const session = store.getSession(scope, selection, {create: true});
        const largeText = 'large transcript '.repeat(10_000);

        store.addMessage(session, {
            role: 'user',
            text: largeText,
        });
        await store.flushPersistenceForTests();

        const transcriptPath = persistence.sessionPath(store.keyForSession(session));
        expect(statSync(transcriptPath).size).toBeLessThanOrEqual(64 * 1024);
        expect(readFileSync(transcriptPath, 'utf8')).toContain('session-snapshot-ref');
        const recoveredStore = createAssistantChatSessionStore({persistence: createPersistence(rootDir)});
        expect(recoveredStore.getMessages(scope, selection).map(message => message.text)).toEqual([largeText]);
    });

    it('bounds changing oversized snapshot storage by live data', async () => {
        const rootDir = createTempRoot();
        const persistence = createPersistence(rootDir);
        const store = createAssistantChatSessionStore({persistence});
        const session = store.getSession(scope, selection, {create: true});
        const attachmentData = `data:image/png;base64,${'A'.repeat(90_000)}`;

        store.addMessage(session, {
            role: 'user',
            text: 'image history',
            attachments: [{
                type: 'image',
                id: 'image-1',
                name: 'image.png',
                mimeType: 'image/png',
                sizeBytes: 67_500,
                dataUrl: attachmentData,
            }],
        });
        await store.flushPersistenceForTests();

        for (let index = 0; index < 32; index += 1) {
            session.messages[0]!.text = `image history ${index}`;
            store.recordSessionSnapshot(session);
            await store.flushPersistenceForTests();
        }

        const blobsDir = join(rootDir, 'blobs');
        expect(readdirSync(blobsDir).filter(entry => entry.endsWith('.json'))).toHaveLength(1);
        expect(directoryFileBytes(blobsDir)).toBeLessThan(2 * 64 * 1024);
        const recoveredStore = createAssistantChatSessionStore({persistence: createPersistence(rootDir)});
        expect(recoveredStore.getMessages(scope, selection)[0]).toMatchObject({
            text: 'image history 31',
            attachments: [{dataUrl: attachmentData}],
        });
    });

    it('reuses one blob when only snapshot timestamps change', async () => {
        const rootDir = createTempRoot();
        const persistence = createPersistence(rootDir);
        const store = createAssistantChatSessionStore({persistence});
        const session = store.getSession(scope, selection, {create: true});
        store.addMessage(session, {
            role: 'user',
            text: 'same content '.repeat(10_000),
        });
        await store.flushPersistenceForTests();

        for (let index = 0; index < 20; index += 1) {
            store.recordSessionSnapshot(session);
            await store.flushPersistenceForTests();
        }

        expect(readdirSync(join(rootDir, 'blobs')).filter(entry => entry.endsWith('.json'))).toHaveLength(1);
    });

    it('recovers the prior generation when the newest external blob is corrupt', async () => {
        const rootDir = createTempRoot();
        const persistence = createPersistence(rootDir);
        const store = createAssistantChatSessionStore({persistence});
        const session = store.getSession(scope, selection, {create: true});
        store.addMessage(session, {
            role: 'user',
            text: 'prior generation '.repeat(10_000),
        });
        await store.flushPersistenceForTests();

        const transcriptPath = persistence.sessionPath(store.keyForSession(session));
        const previousReference = JSON.parse(readFileSync(transcriptPath, 'utf8')) as Record<string, unknown>;
        const corruptReference = {
            ...previousReference,
            blobFile: `${'f'.repeat(64)}.json`,
        };
        writeFileSync(join(rootDir, 'blobs', `${'f'.repeat(64)}.json`), 'corrupt');
        writeFileSync(transcriptPath, `${JSON.stringify(previousReference)}\n${JSON.stringify(corruptReference)}\n`);

        const recoveredStore = createAssistantChatSessionStore({persistence: createPersistence(rootDir)});
        expect(recoveredStore.getMessages(scope, selection)[0]?.text).toBe('prior generation '.repeat(10_000));
    });

    it('rejects a failed flush while retaining the pending snapshot for retry', async () => {
        const rootDir = createTempRoot();
        const errors: unknown[] = [];
        const persistence = createPersistence(rootDir, {onError: (_message, error) => errors.push(error)});
        const store = createAssistantChatSessionStore({persistence});
        const session = store.getSession(scope, selection, {create: true});
        store.addMessage(session, {
            role: 'user',
            text: 'retry me',
        });
        const transcriptPath = persistence.sessionPath(store.keyForSession(session));
        mkdirSync(transcriptPath);

        await expect(store.flushPersistenceForTests()).rejects.toBeInstanceOf(AssistantChatPersistenceError);
        expect(errors).toHaveLength(1);
        expect(errors[0]).toMatchObject({
            code: 'write-failed',
            retryable: true,
            pendingKeys: [store.keyForSession(session)],
        });

        rmSync(transcriptPath, {
            recursive: true,
            force: true,
        });
        await store.flushPersistenceForTests();
        const recoveredStore = createAssistantChatSessionStore({persistence: createPersistence(rootDir)});
        expect(recoveredStore.getMessages(scope, selection).map(message => message.text)).toEqual(['retry me']);
    });

    it('retains only the configured number of archived transcripts', async () => {
        const rootDir = createTempRoot();
        const persistence = createPersistence(rootDir, {maxArchives: 2});
        const store = createAssistantChatSessionStore({persistence});
        const session = store.getSession(scope, selection, {create: true});

        for (const index of [
            1,
            2,
            3,
        ]) {
            store.addMessage(session, {
                role: 'user',
                text: `archive-${index}`,
            });
            session.messages.length = 0;
            store.resetSessionTranscript(session, 'reset');
            await store.flushPersistenceForTests();
        }

        expect(readdirSync(join(rootDir, 'archive')).filter(entry => entry.endsWith('.jsonl'))).toHaveLength(2);
    });

    it('exposes a production persistence flush that drains queued snapshots', async () => {
        const rootDir = createTempRoot();
        const persistence = createPersistence(rootDir, {snapshotDebounceMs: 60_000});
        const store = createAssistantChatSessionStore({ persistence });
        const session = store.getSession(scope, selection, { create: true });

        store.appendAssistantDelta(session, 'assistant-1', 'flush ');
        store.appendAssistantDelta(session, 'assistant-1', 'the newest pending state');
        await store.flushPersistence();

        const recoveredStore = createAssistantChatSessionStore({persistence: createPersistence(rootDir)});
        expect(recoveredStore.getMessages(scope, selection).map(message => message.text))
            .toEqual(['flush the newest pending state']);
    });
});
