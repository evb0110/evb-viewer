import {
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    renameSync,
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
import {
    ASSISTANT_MAX_IMAGE_ATTACHMENTS,
    ASSISTANT_MAX_IMAGE_BYTES,
} from '@contracts/agent';
import {requireDocumentRef} from '@contracts/documentRef';
import {requireIsoTimestamp} from '@contracts/timestamps';
import {requireTabId} from '@contracts/windowTabs';
import {
    AssistantChatPersistence,
    AssistantChatPersistenceError,
    type IPersistedAssistantChatSession,
} from '@electron/features/agent/assistantChatPersistence';
import { createAssistantChatSessionStore } from '@electron/features/agent/assistantChatSessionStore';
import { createAssistantSessionTurnCoordinator } from '@electron/features/agent/createAssistantSessionTurnCoordinator';
import type { IAssistantSelection } from '@electron/features/agent/assistantProviderStatus';
import type { IAssistantSessionScopeBinding } from '@electron/features/agent/assistantTurnLifecycle';
import {normalizeOutgoingMessageRequest} from '@electron/features/agent/assistantOutgoingMessage';
import {createLargeAssistantImage} from '@tests/fixtures/electron/createLargeAssistantImage';
import * as fileFlush from '@electron/utils/fsyncPath';
import {AssistantChatSnapshotStorage} from '@electron/features/agent/assistantChatSnapshotStorage';

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
    it('hydrates persisted sessions asynchronously after construction', async () => {
        const rootDir = createTempRoot();
        const persistence = createPersistence(rootDir);
        const writer = createAssistantChatSessionStore({persistence});
        const session = writer.getSession(scope, selection, {create: true});
        writer.addMessage(session, {
            role: 'user',
            text: 'async history',
        });
        await writer.flushPersistenceForTests();

        const recoverSessions = vi.spyOn(persistence, 'recoverSessions');
        const recoveredStore = createAssistantChatSessionStore({persistence});

        expect(recoverSessions).toHaveBeenCalledOnce();
        expect(recoverSessions.mock.results[0]?.value).toBeInstanceOf(Promise);
        await recoveredStore.ready;
        expect(recoveredStore.getMessages(scope, selection).map(message => message.text)).toEqual(['async history']);
    });

    it('bounds the live transcript to the persistence byte budget', () => {
        const persistence = createPersistence(createTempRoot(), {maxSessionBytes: 1_024});
        const store = createAssistantChatSessionStore({persistence});
        const session = store.getSession(scope, selection, {create: true});

        for (let index = 0; index < 20; index += 1) {
            store.addMessage(session, {
                role: 'user',
                text: `message-${index} ${'x'.repeat(180)}`,
            });
        }

        expect(session.messages.length).toBeLessThan(20);
        expect(session.messages.at(-1)?.text).toContain('message-19');
    });

    it.each([
        1,
        3,
    ])('retains a prompt with %i accepted large images through the answer and restart', async (imageCount) => {
        const rootDir = createTempRoot();
        const persistence = new AssistantChatPersistence({rootDir});
        const store = createAssistantChatSessionStore({persistence});
        await store.ready;
        const session = store.getSession(scope, selection, {create: true});
        const png = createLargeAssistantImage();
        expect(png.length).toBeGreaterThan(2 * 1024 * 1024);
        const dataUrl = `data:image/png;base64,${png.toString('base64')}`;
        const outgoing = normalizeOutgoingMessageRequest({
            scope,
            text: 'Explain these images.',
            attachments: Array.from({length: imageCount}, (_, index) => ({
                type: 'image',
                id: `image-${index}`,
                name: `image-${index}.png`,
                mimeType: 'image/png',
                sizeBytes: 0,
                dataUrl,
            })),
        });
        store.addMessage(session, {
            id: 'image-question',
            role: 'user',
            ...outgoing,
        });
        store.appendAssistantDelta(session, 'reply', 'An answer begins.');
        expect(store.getMessages(scope, selection).map(message => message.text)).toEqual([
            outgoing.text,
            'An answer begins.',
        ]);
        store.upsertAssistantMessage(session, 'reply', {pending: false});
        await store.flushPersistenceForTests();
        const transcriptPath = persistence.sessionPath(store.keyForSession(session));
        expect(readFileSync(transcriptPath, 'utf8')).toContain('session-snapshot-ref');
        expect(statSync(transcriptPath).size).toBeLessThanOrEqual(persistence.getMaxSessionBytes());
        const restarted = createAssistantChatSessionStore({persistence: new AssistantChatPersistence({rootDir})});
        await restarted.ready;
        expect(restarted.getMessages(scope, selection)).toEqual(store.getMessages(scope, selection));
    });

    it('keeps the latest question and answer together when older text is pruned', () => {
        const store = createAssistantChatSessionStore({persistence: createPersistence(createTempRoot(), {maxSessionBytes: 1024})});
        const session = store.getSession(scope, selection, {create: true});
        store.addMessage(session, {
            role: 'user',
            text: 'old question',
        });
        store.addMessage(session, {
            role: 'assistant',
            text: 'old answer',
        });
        store.addMessage(session, {
            role: 'user',
            text: 'current question',
        });
        store.appendAssistantDelta(session, 'current-reply', 'answer '.repeat(200));
        expect(session.messages.map(message => message.text)).toEqual([
            'current question',
            'answer '.repeat(200),
        ]);
    });

    it('keeps exact UTF-8 cap boundaries across split surrogates, empty deltas and recovery', async () => {
        const rootDir = createTempRoot();
        const persistence = createPersistence(rootDir, {maxSessionBytes: 1024});
        const store = createAssistantChatSessionStore({persistence});
        await store.ready;
        const session = store.getSession(scope, selection, {create: true});
        store.addMessage(session, {
            id: 'old',
            role: 'system',
            text: '',
        });
        const question = 'q'.repeat(250);
        store.addMessage(session, {
            id: 'question',
            role: 'user',
            text: question,
        });
        store.appendAssistantDelta(session, 'reply', 'ab');
        store.appendAssistantDelta(session, 'reply', '\uD83E');
        const beforeRestart = store.getMessages(scope, selection);
        expect(beforeRestart.map(message => message.text)).toEqual([
            '',
            question,
            'ab\uD83E',
        ]);
        expect(beforeRestart.reduce((total, message) => total + Buffer.byteLength(message.text) + 256, 0)).toBe(1023);
        await store.flushPersistenceForTests();

        const restarted = createAssistantChatSessionStore({persistence: createPersistence(rootDir, {maxSessionBytes: 1024})});
        const recovered = await restarted.loadSession(scope, selection, {create: true});
        expect(restarted.getMessages(scope, selection)).toEqual(beforeRestart);
        restarted.appendAssistantDelta(recovered, 'reply', '');
        restarted.appendAssistantDelta(recovered, 'reply', '\uDD80');
        expect(restarted.getMessages(scope, selection).map(message => message.text)).toEqual([
            '',
            question,
            'ab🦀',
        ]);
        expect(recovered.messages.reduce((total, message) => total + Buffer.byteLength(message.text) + 256, 0)).toBe(1024);
        restarted.appendAssistantDelta(recovered, 'reply', 'x');
        restarted.upsertAssistantMessage(recovered, 'reply', {pending: false});
        expect(recovered.messages.map(message => [
            message.id,
            message.text,
            message.pending,
        ])).toEqual([
            [
                'question',
                question,
                undefined,
            ],
            [
                'reply',
                'ab🦀x',
                false,
            ],
        ]);
        await restarted.flushPersistenceForTests();
        const completed = createAssistantChatSessionStore({persistence: createPersistence(rootDir, {maxSessionBytes: 1024})});
        await completed.ready;
        expect(completed.getMessages(scope, selection)).toEqual(restarted.getMessages(scope, selection));
    });

    it('uses replacement text and metadata-only completion at exact retention boundaries', () => {
        const store = createAssistantChatSessionStore({persistence: createPersistence(createTempRoot(), {maxSessionBytes: 1024})});
        const session = store.getSession(scope, selection, {create: true});
        store.addMessage(session, {
            id: 'old',
            role: 'system',
            text: '',
        });
        store.addMessage(session, {
            id: 'question',
            role: 'user',
            text: 'q',
        });
        store.appendAssistantDelta(session, 'reply', 'x'.repeat(255));
        store.upsertAssistantMessage(session, 'reply', {
            text: '한',
            pending: false,
        });
        store.appendAssistantDelta(session, 'reply', 'x'.repeat(252));
        expect(session.messages.map(message => message.text)).toEqual([
            '',
            'q',
            `한${'x'.repeat(252)}`,
        ]);
        store.upsertAssistantMessage(session, 'reply', {
            pending: false,
            error: 'interrupted',
        });
        expect(session.messages.at(-1)).toMatchObject({
            pending: false,
            error: 'interrupted',
        });
        store.appendAssistantDelta(session, 'reply', 'x');
        expect(session.messages.map(message => message.text)).toEqual([
            'q',
            `한${'x'.repeat(253)}`,
        ]);
    });

    it('updates attachment metadata budgets independently of text when a message changes', () => {
        const store = createAssistantChatSessionStore({persistence: false});
        const session = store.getSession(scope, selection, {create: true});
        const image = {
            type: 'image',
            id: 'image',
            name: 'image.png',
            mimeType: 'image/png',
            sizeBytes: ASSISTANT_MAX_IMAGE_BYTES,
            dataUrl: 'data:image/png;base64,AA==',
        } as const;
        store.addMessage(session, {
            id: 'old',
            role: 'system',
            text: 'older image',
            attachments: [image],
        });
        const attachments = Array.from({length: ASSISTANT_MAX_IMAGE_ATTACHMENTS - 1}, (_, index) => ({
            ...image,
            id: `image-${index}`,
        }));
        store.addMessage(session, {
            id: 'question',
            role: 'user',
            text: 'current image question',
            attachments,
        });
        store.appendAssistantDelta(session, 'reply', '한글🦀');
        expect(session.messages.map(message => message.id)).toEqual([
            'old',
            'question',
            'reply',
        ]);
        store.upsertAssistantMessage(session, 'reply', {
            attachments: [image],
            pending: false,
        });
        expect(store.getMessages(scope, selection).map(message => [
            message.id,
            message.text,
            message.attachments,
            message.pending,
        ])).toEqual([
            [
                'question',
                'current image question',
                attachments,
                undefined,
            ],
            [
                'reply',
                '한글🦀',
                [image],
                false,
            ],
        ]);
    });

    it('keeps canonical transcript output through reentrant callbacks, pending trimming and reset', () => {
        const store = createAssistantChatSessionStore({
            persistence: false,
            onSessionMessageEvent: (event, session) => {
                if (event.type === 'message-delta' && event.delta === 'first') {
                    store.upsertAssistantMessage(session, 'reply', {
                        text: '한\uD83E',
                        pending: false,
                    });
                    store.removeMessage(session, 'canceled');
                }
            },
        });
        const session = store.getSession(scope, selection, {create: true});
        store.addMessage(session, {
            id: 'question',
            role: 'user',
            text: 'q',
        });
        store.addMessage(session, {
            id: 'canceled',
            role: 'user',
            text: 'not submitted',
        });
        store.appendAssistantDelta(session, 'reply', 'first');
        store.appendAssistantDelta(session, 'reply', '\uDD80');
        expect(store.getMessages(scope, selection).map(message => [
            message.id,
            message.text,
        ])).toEqual([
            [
                'question',
                'q',
            ],
            [
                'reply',
                '한🦀',
            ],
        ]);
        // The service filters failed pending bubbles directly on this owner.
        session.messages = session.messages.filter(message => !message.pending);
        store.addMessage(session, {
            id: 'failure',
            role: 'system',
            text: 'failed',
            error: 'failed',
        });
        store.appendAssistantDelta(session, 'reply', 'new reply');
        expect(store.getMessages(scope, selection).map(message => message.text)).toEqual([
            'q',
            'failed',
            'new reply',
        ]);
        session.messages.length = 0;
        store.resetSessionTranscript(session);
        store.addMessage(session, {
            id: 'question',
            role: 'user',
            text: 'reset question',
        });
        store.appendAssistantDelta(session, 'reply', '\uDD80');
        store.upsertAssistantMessage(session, 'reply', {pending: false});
        expect(store.getMessages(scope, selection).map(message => [
            message.id,
            message.text,
            message.pending,
        ])).toEqual([
            [
                'question',
                'reset question',
                undefined,
            ],
            [
                'reply',
                '\uDD80',
                false,
            ],
        ]);
    });

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

    it.each([
        33,
        65,
    ])('rehydrates history and provider resume IDs after %i document lookups and restart', async (count) => {
        // Check the default 32-entry boundary without writing empty histories.
        // The durable scenario then crosses a two-entry cache once or twice,
        // exercising the same eviction/reload path with three or five files.
        const defaultStore = createAssistantChatSessionStore({persistence: false});
        for (let index = 0; index < count; index += 1) {
            defaultStore.getSession({
                ...scope,
                key: `document-${index}`,
            }, selection, {create: true});
        }
        expect(defaultStore.listSessions()).toHaveLength(32);
        const rootDir = createTempRoot();
        const persistence = new AssistantChatPersistence({rootDir});
        const store = createAssistantChatSessionStore({
            persistence,
            maxEntries: 2,
        });
        await store.ready;
        const original = store.getSession(scope, selection, {create: true});
        original.providerThreadId = 'resume-original';
        original.lastSenderWindowId = 7;
        original.scopeBinding = {
            sessionKey: store.keyForSession(original),
            scopeKey: scope.key,
            provider: 'codex',
            turnGeneration: 0,
            windowId: 7,
            tabId: scope.tabId!,
            documentRef: scope.documentRef!,
            documentIdentity: null,
        };
        store.addMessage(original, {
            role: 'user',
            text: 'original document question',
        });
        store.addMessage(original, {
            role: 'system',
            text: 'original tool result',
        });
        const expected = structuredClone(original.messages);
        for (let index = 1; index < (count === 33 ? 3 : 5); index += 1) {
            store.getSession({
                ...scope,
                key: `document-${index}`,
            }, selection, {create: true});
        }
        await store.flushPersistenceForTests();
        expect(store.listSessions()).toHaveLength(2);

        const requestedScope = {
            ...scope,
            tabId: requireTabId('new-tab'),
        };
        const returned = await store.loadSession(requestedScope, selection, {create: true});
        expect(returned.messages).toEqual(expected);
        expect(returned.providerThreadId).toBe('resume-original');
        expect(returned.scope.tabId).toBe(requestedScope.tabId);
        expect(returned.scopeBinding).toBeNull();
        expect(returned.lastSenderWindowId).toBeNull();
        await store.flushPersistenceForTests();

        const restarted = createAssistantChatSessionStore({
            persistence: new AssistantChatPersistence({rootDir}),
            maxEntries: 2,
        });
        const cold = await restarted.loadSession(requestedScope, selection, {create: true});
        expect(cold.messages).toEqual(expected);
        expect(cold.providerThreadId).toBe('resume-original');
        expect(restarted.listSessions()).toHaveLength(2);
        await restarted.flushPersistenceForTests();
    });

    it.each([
        'codex',
        'claude',
    ] as const)('rehydrates %s image history from disk eviction without replacing a concurrent owner', async (provider) => {
        const rootDir = createTempRoot();
        const persistence = createPersistence(rootDir, {maxSessions: 1});
        const store = createAssistantChatSessionStore({
            persistence,
            maxEntries: 1,
        });
        await store.ready;
        const requested = {
            ...selection,
            provider,
        };
        const session = store.getSession(scope, requested, {create: true});
        session.providerThreadId = `${provider}-resume`;
        const png = createLargeAssistantImage();
        store.addMessage(session, {
            role: 'user',
            text: 'Keep this image question.',
            attachments: [{
                type: 'image',
                id: 'image',
                name: 'image.png',
                mimeType: 'image/png',
                sizeBytes: png.length,
                dataUrl: `data:image/png;base64,${png.toString('base64')}`,
            }],
        });
        const expected = structuredClone(session.messages);
        store.getSession({
            ...scope,
            key: 'other',
        }, requested, {create: true});
        await store.flushPersistenceForTests();
        const [
            first,
            second,
        ] = await Promise.all([
            store.loadSession(scope, requested, {create: true}),
            store.loadSession(scope, requested, {create: true}),
        ]);
        expect(first).toBe(second);
        expect(first.messages).toEqual(expected);
        expect(first.providerThreadId).toBe(`${provider}-resume`);
        first.messages.length = 0;
        first.providerThreadId = null;
        store.resetSessionTranscript(first);
        await store.flushPersistenceForTests();
        store.getSession({
            ...scope,
            key: 'third',
        }, requested, {create: true});
        await store.flushPersistenceForTests();
        const restarted = createAssistantChatSessionStore({
            persistence: createPersistence(rootDir, {maxSessions: 1}),
            maxEntries: 1,
        });
        const reset = await restarted.loadSession(scope, requested, {create: true});
        expect(reset.messages).toEqual([]);
        expect(reset.providerThreadId).toBeNull();
        await restarted.flushPersistenceForTests();
    });

    it('recovers a legacy eviction archive and rejects an unreadable current transcript', async () => {
        const persistence = createPersistence();
        const store = createAssistantChatSessionStore({persistence});
        await store.ready;
        const session = store.getSession(scope, selection, {create: true});
        store.addMessage(session, {
            role: 'user',
            text: 'legacy history',
        });
        await store.flushPersistenceForTests();
        const key = store.keyForSession(session);
        const filePath = persistence.sessionPath(key);
        const legacyArchive = join(persistence.archiveDir, `${Buffer.from(key).toString('base64url')}.evicted.1.abcd.jsonl`);
        renameSync(filePath, legacyArchive);
        expect((await persistence.recoverSession(key))?.session.messages.map(message => message.text)).toEqual(['legacy history']);
        mkdirSync(filePath);
        await expect(persistence.recoverSession(key)).rejects.toBeInstanceOf(AssistantChatPersistenceError);
        expect(statSync(filePath).isDirectory()).toBe(true);
        expect(readFileSync(legacyArchive, 'utf8')).toContain('legacy history');
    });

    it('quarantines a corrupt eviction archive without resurrecting an older conversation', async () => {
        const persistence = createPersistence();
        const store = createAssistantChatSessionStore({persistence});
        await store.ready;
        const session = store.getSession(scope, selection, {create: true});
        store.addMessage(session, {
            role: 'user',
            text: 'older history',
        });
        await store.flushPersistenceForTests();
        const key = store.keyForSession(session);
        const filePath = persistence.sessionPath(key);
        const prefix = basename(filePath, '.jsonl');
        renameSync(filePath, join(persistence.archiveDir, `${prefix}.evicted.1.abcd.jsonl`));
        writeFileSync(join(persistence.archiveDir, `${prefix}.evicted.2.abcd.jsonl`), 'corrupt\n');
        expect(await persistence.recoverSession(key)).toBeNull();
        expect(await persistence.recoverSession(key)).toBeNull();
        expect(readdirSync(persistence.archiveDir).some(name => name.includes('.corrupt.'))).toBe(true);
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
        await recoveredStore.ready;
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

    it('persists removing a canceled message before a restart', async () => {
        const rootDir = createTempRoot();
        const persistence = createPersistence(rootDir);
        const store = createAssistantChatSessionStore({persistence});
        const session = store.getSession(scope, selection, {create: true});
        const message = store.addMessage(session, {
            role: 'user',
            text: 'canceled before submission',
        });

        expect(store.removeMessage(session, message.id)).toBe(true);
        expect(store.removeMessage(session, message.id)).toBe(false);
        await store.flushPersistenceForTests();

        const recoveredStore = createAssistantChatSessionStore({persistence: createPersistence(rootDir)});
        await recoveredStore.ready;
        expect(recoveredStore.getMessages(scope, selection)).toEqual([]);
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
        await recoveredStore.ready;
        expect(recoveredStore.getMessages(scope, selection)[0]?.text).toBe('01234567890123456789');
    });

    it('writes turn boundaries immediately and keeps identical running notifications durable no-ops', async () => {
        const persistence = createPersistence(createTempRoot(), {snapshotDebounceMs: 60_000});
        const store = createAssistantChatSessionStore({persistence});
        const coordinator = createAssistantSessionTurnCoordinator({sessionStore: store});
        const session = store.getSession(scope, selection, {create: true});

        coordinator.claimSessionTurn(session);

        const transcriptPath = persistence.sessionPath(store.keyForSession(session));
        await vi.waitFor(() => {
            expect(persistedRecordCount(transcriptPath)).toBe(1);
        });
        const generation = session.turnOwner.generation;
        coordinator.markSessionTurnRunning(session, generation, 'turn-1');
        await persistence.flush();
        const contents = readFileSync(transcriptPath, 'utf8');
        for (let index = 0; index < 100; index += 1) {
            coordinator.markSessionTurnRunning(session, generation, 'turn-1');
        }
        await persistence.flush();
        expect(readFileSync(transcriptPath, 'utf8')).toBe(contents);
        store.getMessages(scope, selection);
        await persistence.flush();
        const recovered = await persistence.recoverSession(store.keyForSession(session));
        expect(recovered?.session.lastAccessedAtMs).toBe(session.lastAccessedAtMs);
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
        await recoveredStore.ready;

        expect(recoveredStore.getMessages(scope, selection)).toEqual([]);
        expect(readdirSync(join(rootDir, 'archive')).some(entry => entry.includes('.corrupt.'))).toBe(true);
        expect(readdirSync(join(rootDir, 'sessions'))).toEqual([]);
    });

    it.each([
        false,
        true,
    ])('keeps a torn final record recoverable when its repair flush fails (%s)', async (flushFails) => {
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
        const originalContents = readFileSync(transcriptPath, 'utf8');

        const flush = vi.spyOn(fileFlush, 'fsyncFileSync');
        const flushError = new Error('Recovery flush failed');
        if (flushFails) flush.mockImplementation(() => {throw flushError;});
        const onError = vi.fn();
        const recovery = createPersistence(rootDir, {onError});
        try {
            const recovered = await recovery.recoverSessions();
            expect(recovered.flatMap(record => record.session.messages.map(message => message.text)))
                .toEqual(flushFails ? [] : ['durable message']);
            if (flushFails) {
                expect(await recovery.recoverSession(store.keyForSession(session))).toBeNull();
                expect(readFileSync(transcriptPath, 'utf8')).toBe(originalContents);
                expect(onError).toHaveBeenCalledWith(expect.stringContaining('Failed to recover'), expect.objectContaining({
                    code: 'write-failed',
                    cause: flushError,
                }));
            } else {
                expect(readFileSync(transcriptPath, 'utf8')).toMatch(/\n$/u);
                expect(onError).not.toHaveBeenCalled();
            }
            expect(readdirSync(join(rootDir, 'archive'))).toEqual([]);
            expect(readdirSync(join(rootDir, 'sessions'))).toEqual([basename(transcriptPath)]);
        } finally {
            flush.mockRestore();
        }
        expect((await recovery.recoverSession(store.keyForSession(session)))?.session.messages.map(message => message.text))
            .toEqual(['durable message']);
        expect(readFileSync(transcriptPath, 'utf8')).toMatch(/\n$/u);
    });

    it('removes a recovery staging file when replacement fails and keeps the destination', () => {
        const rootDir = createTempRoot();
        const destination = join(rootDir, 'blocked.jsonl');
        mkdirSync(destination);
        writeFileSync(join(destination, 'keep'), 'original');
        const storage = new AssistantChatSnapshotStorage<{text: string}, 1>({
            blobsDir: join(rootDir, 'blobs'),
            maxSessionBytes: 1024,
            createTooLargeError: (_key, message) => new Error(message),
            parseRecord: () => null,
        });

        expect(() => storage.writeBoundedSnapshotSync(destination, {
            schemaVersion: 1,
            type: 'session-snapshot',
            key: 'session',
            writtenAt: '2026-10-10T00:00:00.000Z',
            session: {text: 'recovered'},
        }, 'session')).toThrow();
        expect(readFileSync(join(destination, 'keep'), 'utf8')).toBe('original');
        expect(readdirSync(rootDir).sort()).toEqual([
            'blobs',
            'blocked.jsonl',
        ]);
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
                        details: {timestamp: Number.NaN},
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
            await recoveredStore.ready;

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
        await recoveredStore.ready;
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
        await recoveredStore.ready;
        await recoveredStore.ready;

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
        await recoveredStore.ready;

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
        await recoveredStore.ready;
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
        await recoveredStore.ready;
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

        for (let index = 0; index < 3; index += 1) {
            session.messages[0]!.text = `image history ${index}`;
            store.recordSessionSnapshot(session);
            await store.flushPersistenceForTests();
        }

        const blobsDir = join(rootDir, 'blobs');
        expect(readdirSync(blobsDir).filter(entry => entry.endsWith('.json'))).toHaveLength(1);
        expect(directoryFileBytes(blobsDir)).toBeLessThan(2 * 64 * 1024);
        const recoveredStore = createAssistantChatSessionStore({persistence: createPersistence(rootDir)});
        await recoveredStore.ready;
        expect(recoveredStore.getMessages(scope, selection)[0]).toMatchObject({
            text: 'image history 2',
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
        await recoveredStore.ready;
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
        await recoveredStore.ready;
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
        await recoveredStore.ready;
        expect(recoveredStore.getMessages(scope, selection).map(message => message.text))
            .toEqual(['flush the newest pending state']);
    });
});

describe('assistant chat persistence grant fields', () => {
    const grantFields = {
        lastSenderWindowId: 7,
        scopeBinding: {
            sessionKey: 'document:/tmp/a.pdf',
            scopeKey: scope.key,
            provider: 'codex',
            turnGeneration: 1,
            windowId: 7,
            tabId: requireTabId('tab-a'),
            documentRef: requireDocumentRef('/tmp/a.pdf'),
            documentIdentity: null,
        } satisfies IAssistantSessionScopeBinding,
    };
    const persistedSession = (overrides: Partial<IPersistedAssistantChatSession> = {}): IPersistedAssistantChatSession => ({
        provider: 'codex',
        scope,
        model: selection.model,
        effort: selection.effort,
        speedMode: selection.speedMode,
        providerThreadId: 'resume-original',
        turnOwner: {
            phase: 'idle',
            generation: 1,
            turnId: null,
            localTurnId: null,
        },
        messages: [{
            id: 'message-1',
            role: 'user',
            text: 'question',
            createdAt: requireIsoTimestamp('2026-10-10T00:00:00.000Z'),
        }],
        lastAccessedAtMs: 1_800_000_000_000,
        ...overrides,
    });
    const writeSnapshot = (persistence: AssistantChatPersistence, session: unknown) => {
        writeFileSync(persistence.sessionPath(scopeKey), `${JSON.stringify({
            schemaVersion: 1,
            type: 'session-snapshot',
            key: scopeKey,
            writtenAt: '2026-10-10T00:00:00.000Z',
            session,
        })}\n`);
    };
    const scopeKey = 'document:/tmp/a.pdf';

    it('loads a version-1 snapshot that carries grant fields without a scope binding', async () => {
        const persistence = createPersistence();
        writeSnapshot(persistence, {
            ...persistedSession(),
            ...grantFields,
        });

        const [recovered] = await persistence.recoverSessions();

        expect(recovered?.key).toBe(scopeKey);
        expect(recovered?.session.lastSenderWindowId).toBeNull();
        expect(recovered?.session.scopeBinding).toBeNull();
        expect(recovered?.session.providerThreadId).toBe('resume-original');
        expect(recovered?.session.messages.map(message => message.text)).toEqual(['question']);
    });

    it('interrupts an in-flight turn from a version-1 snapshot and clears its grant', async () => {
        const persistence = createPersistence();
        writeSnapshot(persistence, {
            ...persistedSession({
                turnOwner: {
                    phase: 'running',
                    generation: 1,
                    localTurnId: 'local-1',
                    providerTurnId: 'provider-1',
                    scope: {
                        ...grantFields.scopeBinding,
                        turnGeneration: 1,
                    },
                },
                messages: [{
                    id: 'message-1',
                    role: 'assistant',
                    text: '',
                    createdAt: requireIsoTimestamp('2026-10-10T00:00:00.000Z'),
                    pending: true,
                }],
            }),
            ...grantFields,
        });

        const [recovered] = await persistence.recoverSessions();

        expect(recovered?.session.turnOwner.phase).toBe('error');
        expect(recovered?.session.lastError).toMatch(/interrupted/u);
        expect(recovered?.session.messages[0]?.pending).toBe(false);
        expect(recovered?.session.scopeBinding).toBeNull();
        expect(recovered?.session.lastSenderWindowId).toBeNull();
    });

    it('does not write grant fields into new snapshots', async () => {
        const persistence = createPersistence();
        persistence.recordSessionSnapshot(scopeKey, {
            ...persistedSession(),
            ...grantFields,
        });
        await persistence.flush();

        const [record] = readFileSync(persistence.sessionPath(scopeKey), 'utf8')
            .split(/\r?\n/u)
            .filter(Boolean)
            .map(line => JSON.parse(line) as {session: Record<string, unknown>});
        expect(record?.session).not.toHaveProperty('lastSenderWindowId');
        expect(record?.session).not.toHaveProperty('scopeBinding');
        expect(record?.session.providerThreadId).toBe('resume-original');
    });

    it('drops grant fields when a torn tail rewrites a version-1 snapshot', async () => {
        const persistence = createPersistence();
        writeSnapshot(persistence, {
            ...persistedSession(),
            ...grantFields,
        });
        writeFileSync(persistence.sessionPath(scopeKey), '{"type":"session-snap', {flag: 'a'});

        await persistence.recoverSessions();

        const [record] = readFileSync(persistence.sessionPath(scopeKey), 'utf8')
            .split(/\r?\n/u)
            .filter(Boolean)
            .map(line => JSON.parse(line) as {session: Record<string, unknown>});
        expect(record?.session).not.toHaveProperty('lastSenderWindowId');
        expect(record?.session).not.toHaveProperty('scopeBinding');
        expect(record?.session.providerThreadId).toBe('resume-original');
    });
});
