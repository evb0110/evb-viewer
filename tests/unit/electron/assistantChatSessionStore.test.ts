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
import {requireIsoTimestamp} from '@contracts/timestamps';
import {requireTabId} from '@contracts/windowTabs';
import {
    AssistantChatPersistence,
    AssistantChatPersistenceError,
    type IPersistedAssistantChatSession,
} from '@electron/features/agent/assistantChatPersistence';
import type { IAssistantSessionScopeBinding } from '@electron/features/agent/assistantMcpSessionScope';
import {createLargeAssistantImage} from '@tests/fixtures/electron/createLargeAssistantImage';
import * as chatFiles from 'fs/promises';
import {AssistantChatSnapshotStorage} from '@electron/features/agent/assistantChatSnapshotStorage';

vi.mock('fs/promises', {spy: true});

const tempRoots: string[] = [];
const persistences: AssistantChatPersistence[] = [];

/** Persistence debounces its writes; each one is flushed before its root is removed. */
class FlushedAssistantChatPersistence extends AssistantChatPersistence {
    constructor(...args: ConstructorParameters<typeof AssistantChatPersistence>) {
        super(...args);
        persistences.push(this);
    }
}

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
} as const;

function createTempRoot() {
    const root = mkdtempSync(join(tmpdir(), 'evb-assistant-chat-'));
    tempRoots.push(root);
    return root;
}

function createPersistence(rootDir = createTempRoot(), options: Partial<ConstructorParameters<typeof AssistantChatPersistence>[0]> = {}) {
    return new FlushedAssistantChatPersistence({
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

afterEach(async () => {
    try {
        await Promise.all(persistences.splice(0).map(persistence => persistence.flush()));
    } finally {
        for (const root of tempRoots.splice(0)) {
            rmSync(root, {
                recursive: true,
                force: true,
                maxRetries: 5,
                retryDelay: 20,
            });
        }
    }
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

describe('pre-file-key chat upgrade compatibility', () => {
    const currentScope = {
        ...scope,
        key: `document:electron:${scope.documentRef}`,
        documentBackend: 'electron' as const,
        documentSessionKey: 'reopened',
    };
    const currentKey = `codex:${currentScope.key}`;

    function seed(
        persistence: AssistantChatPersistence,
        key: string,
        text: string | null,
        time: number,
        options: {
            base64?: boolean;
            threadOnly?: boolean;
            session?: Partial<IPersistedAssistantChatSession>;
        } = {},
    ) {
        const session: IPersistedAssistantChatSession = {
            ...selection,
            scope: {
                ...scope,
                key: key.slice('codex:'.length),
                documentBackend: 'electron',
                documentSessionKey: 'old-opening',
            },
            providerThreadId: text === null && !options.threadOnly ? null : `thread-${text ?? 'empty'}`,
            turnOwner: {
                phase: 'idle',
                generation: 0,
                turnId: null,
                localTurnId: null,
            },
            messages: text === null ? [] : [{
                id: text.slice(0, 40),
                role: 'user',
                text,
                createdAt: requireIsoTimestamp('2026-01-01T00:00:00.000Z'),
            }],
            lastAccessedAtMs: time,
            ...options.session,
        };
        const bytes = `${JSON.stringify({
            schemaVersion: 1,
            type: 'session-snapshot',
            key,
            writtenAt: '2026-01-01T00:00:00.000Z',
            session,
        })}\n`;
        const path = options.base64
            ? join(persistence.sessionsDir, `${Buffer.from(key).toString('base64url')}.jsonl`)
            : persistence.sessionPath(key);
        writeFileSync(path, bytes);
        return {
            key,
            path,
            bytes,
            session,
        };
    }

    function preserved(persistence: AssistantChatPersistence, bytes: string) {
        return readdirSync(persistence.archiveDir).some(name => readFileSync(join(persistence.archiveDir, name), 'utf8') === bytes);
    }

    it.each([
        {
            mode: 'startup',
            restart: false,
        },
        {
            mode: 'startup',
            restart: true,
        },
        {
            mode: 'direct',
            restart: false,
        },
        {
            mode: 'direct',
            restart: true,
        },
    ] as const)('preserves own $mode failure and repairs the index with restart=$restart', async ({
        mode, restart,
    }) => {
        const persistence = createPersistence();
        const original = seed(persistence, 'codex:document-session:a', 'durable winner', 20);
        mkdirSync(persistence.indexPath);
        const first = mode === 'startup'
            ? persistence.recoverSessions()
            : persistence.recoverSession(currentKey);
        await expect(first).rejects.toMatchObject({
            name: 'AssistantChatPersistenceError',
            code: 'write-failed',
            sessionKey: mode === 'startup' ? 'scope-migration' : currentKey,
            retryable: true,
        });
        expect(readFileSync(persistence.sessionPath(currentKey), 'utf8')).toContain('durable winner');
        expect(preserved(persistence, original.bytes)).toBe(true);
        rmSync(persistence.indexPath, {recursive: true});

        const retry = restart ? createPersistence(persistence.rootDir) : persistence;
        const recovered = mode === 'startup'
            ? (await retry.recoverSessions()).find(entry => entry.key === currentKey)
            : await retry.recoverSession(currentKey);
        expect(recovered?.session.messages).toEqual(original.session.messages);
        expect(recovered?.session.providerThreadId).toBe(original.session.providerThreadId);
        expect(JSON.parse(readFileSync(retry.indexPath, 'utf8'))).toMatchObject({
            schemaVersion: 1,
            sessions: [{
                key: currentKey,
                file: basename(retry.sessionPath(currentKey)),
            }],
        });
        expect(preserved(retry, original.bytes)).toBe(true);
    });

    it('direct recovery rejects a failed pending write and explicit flush retries it', async () => {
        const persistence = createPersistence();
        const original = seed(persistence, currentKey, 'older durable bytes', 10);
        const latest = {
            ...original.session,
            messages: [{
                ...original.session.messages[0]!,
                text: 'latest pending bytes',
            }],
            lastAccessedAtMs: 20,
        };
        const append = vi.spyOn(chatFiles, 'appendFile').mockRejectedValueOnce(new Error('snapshot append refused'));
        try {
            persistence.recordSessionSnapshot(currentKey, latest);
            await expect(persistence.recoverSession(currentKey)).rejects.toBeInstanceOf(AssistantChatPersistenceError);
            expect(readFileSync(original.path, 'utf8')).toBe(original.bytes);
        } finally {
            append.mockRestore();
        }
        await persistence.flush();
        expect((await persistence.recoverSession(currentKey))?.session.messages).toEqual(latest.messages);
        expect((await createPersistence(persistence.rootDir).recoverSession(currentKey))?.session.messages).toEqual(latest.messages);
    });

    it('direct recovery publishes a pending snapshot before returning its bytes', async () => {
        const persistence = createPersistence();
        const original = seed(persistence, currentKey, 'older durable bytes', 10);
        const latest = {
            ...original.session,
            messages: [{
                ...original.session.messages[0]!,
                text: 'latest pending bytes',
            }],
            lastAccessedAtMs: 20,
        };
        persistence.recordSessionSnapshot(currentKey, latest);
        expect((await persistence.recoverSession(currentKey))?.session.messages).toEqual(latest.messages);
        expect((await createPersistence(persistence.rootDir).recoverSession(currentKey))?.session.messages).toEqual(latest.messages);
    });

    it.each([
        'codex',
        'claude',
    ] as const)('adopts %s schema-1 history using the current UI key and preserves its original bytes', async (provider) => {
        const rootDir = createTempRoot();
        const persistence = createPersistence(rootDir, {maxArchives: 0});
        const legacyScope = {
            ...scope,
            key: 'document-session:old-opening',
            documentSessionKey: 'old-opening',
            documentBackend: 'electron' as const,
        };
        const currentScope = {
            ...scope,
            key: `document:electron:${scope.documentRef}`,
            documentSessionKey: 'reopened',
            documentBackend: 'electron' as const,
        };
        const key = `${provider}:${legacyScope.key}`;
        const session: IPersistedAssistantChatSession = {
            provider,
            scope: legacyScope,
            model: selection.model,
            effort: selection.effort,
            speedMode: selection.speedMode,
            providerThreadId: 'pre-upgrade-thread',
            turnOwner: {
                phase: 'idle',
                generation: 0,
                turnId: null,
                localTurnId: null,
            },
            messages: [{
                id: 'old-message',
                role: 'user',
                text: 'Saved before the key change',
                createdAt: requireIsoTimestamp('2026-01-01T00:00:00.000Z'),
            }],
            lastAccessedAtMs: 10,
        };
        // Literal historical schema-1 writer shape, including old live-only fields.
        const bytes = `${JSON.stringify({
            schemaVersion: 1,
            type: 'session-snapshot',
            key,
            writtenAt: '2026-01-01T00:00:00.000Z',
            session: {
                ...session,
                lastSenderWindowId: 99,
                scopeBinding: null,
            },
        })}\n`;
        writeFileSync(persistence.sessionPath(key), bytes);
        const canonicalKey = `${provider}:${currentScope.key}`;
        const loaded = (await persistence.recoverSession(canonicalKey))!.session;
        expect(loaded.messages).toEqual(session.messages);
        expect(loaded.providerThreadId).toBe('pre-upgrade-thread');
        expect(loaded.lastSenderWindowId).toBeNull();
        expect(loaded.scopeBinding).toBeNull();
        expect(loaded.scope.key).toBe(currentScope.key);
        await persistence.flush();
        expect(readdirSync(persistence.archiveDir).some(name => readFileSync(join(persistence.archiveDir, name), 'utf8') === bytes)).toBe(true);
        const restarted = createPersistence(rootDir, {maxArchives: 0});
        const afterRestart = (await restarted.recoverSession(canonicalKey))!.session;
        expect(afterRestart.messages).toEqual(session.messages);
        expect(afterRestart.providerThreadId).toBe('pre-upgrade-thread');
        expect(afterRestart.scopeBinding).toBeNull();
    });

    it.each([
        false,
        true,
    ])('selects the same old conversation with reversed directory insertion %s and retains every log', async (reverse) => {
        const persistence = createPersistence(createTempRoot(), {maxArchives: 0});
        const placeholder = seed(persistence, currentKey, null, 99, {base64: true});
        const aliases = [
            [
                'codex:document-session:a',
                'winner',
                20,
            ],
            [
                'codex:document-session:b',
                'other conversation',
                20,
            ],
            [
                'codex:document-session:empty',
                null,
                100,
            ],
        ] as const;
        const old = (reverse ? [...aliases].reverse() : aliases).map(([
            key,
            text,
            time,
        ], index) =>
            seed(persistence, key, text, time, {base64: index === 1}));
        const loaded = (await persistence.recoverSession(currentKey))!.session;
        expect(loaded.messages.map(message => message.text)).toEqual(['winner']);
        expect(loaded.providerThreadId).toBe('thread-winner');
        await persistence.flush();
        for (const original of [
            placeholder,
            ...old,
        ]) expect(preserved(persistence, original.bytes)).toBe(true);
        expect(readdirSync(persistence.sessionsDir)).toEqual([basename(persistence.sessionPath(currentKey))]);
        const restarted = createPersistence(persistence.rootDir, {maxArchives: 0});
        expect((await restarted.recoverSession(currentKey))?.session.messages).toEqual(loaded.messages);
        expect((await restarted.recoverSession(currentKey))?.session.providerThreadId).toBe('thread-winner');
    });

    it.each([
        false,
        true,
    ])('preserves an authoritative canonical conversation including a thread without messages %s', async (threadOnly) => {
        const persistence = createPersistence();
        const canonical = seed(persistence, currentKey, threadOnly ? null : 'canonical', 1, {threadOnly});
        const legacy = seed(persistence, 'codex:document-session:a', 'newer legacy', 20);
        const recovered = await persistence.recoverSession(currentKey);
        expect(recovered?.session.messages).toEqual(canonical.session.messages);
        expect(recovered?.session.providerThreadId).toBe(canonical.session.providerThreadId);
        expect(preserved(persistence, legacy.bytes)).toBe(true);
        const restarted = createPersistence(persistence.rootDir);
        expect((await restarted.recoverSession(currentKey))?.session.messages).toEqual(canonical.session.messages);
    });

    it('prefers meaningful history by recency before newer empty aliases', async () => {
        const persistence = createPersistence();
        const old = [
            seed(persistence, 'codex:document-session:a', 'older', 20),
            seed(persistence, 'codex:document-session:b', 'newer', 21),
            seed(persistence, 'codex:document-session:c', null, 99),
        ];
        const recovered = await persistence.recoverSession(currentKey);
        expect(recovered?.session.messages.map(message => message.text)).toEqual(['newer']);
        expect(recovered?.session.providerThreadId).toBe('thread-newer');
        for (const original of old) expect(preserved(persistence, original.bytes)).toBe(true);
    });

    it.each([
        'live',
        'archive',
        'corrupt',
    ] as const)('does not revive history behind a canonical %s reset/corruption barrier', async (barrier) => {
        const persistence = createPersistence();
        const canonical = seed(persistence, currentKey, null, 99);
        if (barrier === 'live') writeFileSync(canonical.path, '');
        if (barrier === 'corrupt') writeFileSync(canonical.path, 'not a chat record\n');
        if (barrier === 'archive') {
            renameSync(canonical.path, join(persistence.archiveDir, `${basename(canonical.path, '.jsonl')}.reset.1.abcd.jsonl`));
        }
        const legacy = seed(persistence, 'codex:document-session:a', 'before reset', 20);
        const recovered = await persistence.recoverSession(currentKey);
        expect(recovered?.session.messages ?? []).toEqual([]);
        expect(recovered?.session.providerThreadId ?? null).toBeNull();
        expect(preserved(persistence, legacy.bytes)).toBe(true);
        const restarted = createPersistence(persistence.rootDir);
        expect((await restarted.recoverSession(currentKey))?.session.messages ?? []).toEqual([]);
    });

    it.each([
        false,
        true,
    ])('adopts an evicted-only alias with a base64 filename %s through direct lookup', async (base64) => {
        const persistence = createPersistence();
        const original = seed(persistence, 'codex:document-session:a', 'evicted history', 20, {base64});
        renameSync(original.path, join(persistence.archiveDir, `${basename(original.path, '.jsonl')}.evicted.1.abcd.jsonl`));
        const fresh = createPersistence(persistence.rootDir);
        expect((await fresh.recoverSession(currentKey))?.session.messages).toEqual(original.session.messages);
        expect((await createPersistence(persistence.rootDir).recoverSession(currentKey))?.session.providerThreadId).toBe('thread-evicted history');
        expect(preserved(fresh, original.bytes)).toBe(true);
    });

    it('keeps the old live bytes when canonical publication fails and permits recovery on the same owner', async () => {
        const persistence = createPersistence();
        const original = seed(persistence, 'codex:document-session:a', 'publish safely', 20);
        const write = vi.spyOn(AssistantChatSnapshotStorage.prototype, 'writeBoundedSnapshot').mockRejectedValueOnce(new Error('publication refused'));
        try {
            await expect(persistence.recoverSession(currentKey)).rejects.toBeInstanceOf(AssistantChatPersistenceError);
            expect(readFileSync(original.path, 'utf8')).toBe(original.bytes);
        } finally {
            write.mockRestore();
        }
        expect((await persistence.recoverSession(currentKey))?.session.messages).toEqual(original.session.messages);
        expect(preserved(persistence, original.bytes)).toBe(true);
    });

    it('finishes interrupted retirement without replacing already-published messages', async () => {
        const persistence = createPersistence();
        const canonical = seed(persistence, currentKey, 'continued after adoption', 1);
        const original = seed(persistence, 'codex:document-session:a', 'pre-adoption history', 20);
        expect((await persistence.recoverSession(currentKey))?.session.messages).toEqual(canonical.session.messages);
        expect(preserved(persistence, original.bytes)).toBe(true);
        expect((await createPersistence(persistence.rootDir).recoverSession(currentKey))?.session.messages).toEqual(canonical.session.messages);
    });

    it('keeps published history and backups when the index fails and repairs it on recovery', async () => {
        const persistence = createPersistence();
        const original = seed(persistence, 'codex:document-session:a', 'index repair', 20);
        mkdirSync(persistence.indexPath);
        await expect(persistence.recoverSession(currentKey)).rejects.toBeInstanceOf(AssistantChatPersistenceError);
        expect(readFileSync(persistence.sessionPath(currentKey), 'utf8')).toContain('index repair');
        expect(preserved(persistence, original.bytes)).toBe(true);
        rmSync(persistence.indexPath, {recursive: true});
        expect((await persistence.recoverSession(currentKey))?.session.messages).toEqual(original.session.messages);
        await persistence.recoverSessions();
        expect(JSON.parse(readFileSync(persistence.indexPath, 'utf8'))).toMatchObject({schemaVersion: 1});
        expect((await createPersistence(persistence.rootDir).recoverSession(currentKey))?.session.messages).toEqual(original.session.messages);
    });

    it.each([
        false,
        true,
    ])('round-trips an oversized legacy transcript and attachments with a pre-existing blob %s', async (blob) => {
        const persistence = createPersistence(createTempRoot(), {
            maxSessionBytes: 1_024,
            maxArchives: 0,
        });
        const image = createLargeAssistantImage(16, 16);
        const attachments = [{
            type: 'image' as const,
            id: 'image-1',
            name: 'image.png',
            mimeType: 'image/png' as const,
            sizeBytes: image.length,
            dataUrl: `data:image/png;base64,${image.toString('base64')}`,
        }];
        const original = seed(persistence, 'codex:document-session:a', 'long history '.repeat(10_000), 20);
        original.session.messages[0]!.attachments = attachments;
        const record = {
            schemaVersion: 1 as const,
            type: 'session-snapshot' as const,
            key: original.key,
            writtenAt: requireIsoTimestamp('2026-01-01T00:00:00.000Z'),
            session: original.session,
        };
        if (blob) {
            const storage = new AssistantChatSnapshotStorage<IPersistedAssistantChatSession, 1>({
                blobsDir: persistence.blobsDir,
                maxSessionBytes: 1_024,
                createTooLargeError: key => new Error(key),
                parseRecord: value => JSON.parse(value) as typeof record,
            });
            await storage.writeBoundedSnapshot(original.path, record, original.key);
        } else writeFileSync(original.path, `${JSON.stringify(record)}\n`);
        const originalBytes = readFileSync(original.path, 'utf8');
        const loaded = (await persistence.recoverSession(currentKey))!.session;
        expect(loaded.messages).toEqual(original.session.messages);
        expect(loaded.providerThreadId).toBe(original.session.providerThreadId);
        await persistence.flush();
        expect(statSync(persistence.sessionPath(currentKey)).size).toBeLessThanOrEqual(1_024);
        expect(preserved(persistence, originalBytes)).toBe(true);
        const restarted = createPersistence(persistence.rootDir, {
            maxSessionBytes: 1_024,
            maxArchives: 0,
        });
        expect((await restarted.recoverSession(currentKey))?.session.messages).toEqual(original.session.messages);
        if (blob) {
            const backup = readdirSync(persistence.archiveDir).find(name => readFileSync(join(persistence.archiveDir, name), 'utf8') === originalBytes)!;
            // A separate root can still decode the original backup using its retained blobs.
            const backupRoot = createPersistence(createTempRoot());
            for (const name of readdirSync(persistence.blobsDir)) {
                mkdirSync(backupRoot.blobsDir, {recursive: true});
                writeFileSync(join(backupRoot.blobsDir, name), readFileSync(join(persistence.blobsDir, name)));
            }
            writeFileSync(backupRoot.sessionPath(original.key), readFileSync(join(persistence.archiveDir, backup)));
            expect((await backupRoot.recoverSession(original.key))?.session.messages).toEqual(original.session.messages);
        }
    });

    it.each([
        'custom',
        'missing-ref',
        'provider-mismatch',
        'backend-conflict',
    ] as const)('leaves %s records untouched while adopting an eligible sibling', async (kind) => {
        const persistence = createPersistence();
        const key = kind === 'custom' ? 'custom:document-session:a' : 'codex:document-session:a';
        const invalidScope = {
            ...scope,
            key: key.slice('codex:'.length),
            ...(kind === 'missing-ref' ? {documentRef: undefined} : {}),
            ...(kind === 'backend-conflict' ? {documentBackend: 'browser' as const} : {}),
        };
        const invalid = seed(persistence, key, 'leave me alone', 30, {session: {
            scope: invalidScope,
            ...(kind === 'provider-mismatch' ? {provider: 'claude' as const} : {}),
        }});
        const eligible = seed(persistence, 'codex:document-session:valid', 'adopt me', 20);
        expect((await persistence.recoverSession(currentKey))?.session.messages).toEqual(eligible.session.messages);
        expect(readFileSync(invalid.path, 'utf8')).toBe(invalid.bytes);
        expect((await persistence.recoverSession(key))?.session.messages).toEqual(invalid.session.messages);
    });


    it('retires stale canonical and alias base64 siblings while retaining hashed live precedence', async () => {
        const persistence = createPersistence();
        const canonical = seed(persistence, currentKey, 'canonical live', 1);
        const staleCanonical = seed(persistence, currentKey, 'stale sibling', 99, {base64: true});
        const alias = seed(persistence, 'codex:document-session:a', 'hashed alias', 20);
        const staleAlias = seed(persistence, alias.key, 'base64 alias', 99, {base64: true});
        expect((await persistence.recoverSession(currentKey))?.session.messages).toEqual(canonical.session.messages);
        for (const original of [
            staleCanonical,
            alias,
            staleAlias,
        ]) expect(preserved(persistence, original.bytes)).toBe(true);
        expect(readdirSync(persistence.sessionsDir)).toEqual([basename(canonical.path)]);
        expect((await createPersistence(persistence.rootDir).recoverSession(currentKey))?.session.providerThreadId).toBe('thread-canonical live');
    });

    it('infers the backend of eligible legacy records without stored backend metadata', async () => {
        const persistence = createPersistence();
        const original = seed(persistence, 'codex:document-session:a', 'old backend omitted', 20, {session: {scope: {
            ...scope,
            key: 'document-session:a',
        }}});
        const recovered = await persistence.recoverSession(currentKey);
        expect(recovered?.session.messages).toEqual(original.session.messages);
        expect(recovered?.session.scope.key).toBe(currentScope.key);
        expect(preserved(persistence, original.bytes)).toBe(true);
    });

});

describe('AssistantChatPersistence snapshots', () => {
    const key = `codex:${scope.key}`;
    function session(overrides: Partial<IPersistedAssistantChatSession> = {}): IPersistedAssistantChatSession {
        return {
            ...selection,
            scope,
            providerThreadId: 'thread-original',
            turnOwner: {
                phase: 'idle',
                generation: 0,
                turnId: null,
                localTurnId: null,
            },
            messages: [{
                id: 'user-1',
                role: 'user',
                text: 'question',
                createdAt: requireIsoTimestamp('2026-10-10T00:00:00.000Z'),
            }],
            lastAccessedAtMs: 10,
            ...overrides,
        };
    }
    it('writes JSONL and recovers a version-1 pre-instance pending/error message shape', async () => {
        const persistence = createPersistence();
        const old = session({messages: [
            {
                id: 'user',
                role: 'user',
                text: 'question',
                createdAt: requireIsoTimestamp('2026-10-10T00:00:00.000Z'),
            },
            {
                id: 'assistant',
                role: 'assistant',
                text: 'partial',
                createdAt: requireIsoTimestamp('2026-10-10T00:00:01.000Z'),
                pending: true,
                error: 'Original error',
            },
        ]});
        writeFileSync(persistence.sessionPath(key), `${JSON.stringify({
            schemaVersion: 1,
            type: 'session-snapshot',
            key,
            writtenAt: '2026-10-10T00:00:00.000Z',
            session: old,
        })}\n`);
        const recovered = await persistence.recoverSession(key);
        expect(recovered?.session.instanceId).toBeUndefined();
        expect(recovered?.session.providerThreadId).toBe('thread-original');
        expect(recovered?.session.messages[1]).toMatchObject({
            text: 'partial',
            pending: false,
            error: 'Original error',
        });
    });
    it('round-trips instance ids and ordered reasoning/tool timeline items', async () => {
        const persistence = createPersistence();
        const original = session({
            instanceId: 'codex_proxy',
            messages: [
                {
                    id: 'reason',
                    role: 'reasoning',
                    text: 'Inspect pages',
                    turnId: 'turn-1',
                    status: 'completed',
                    createdAt: requireIsoTimestamp('2026-10-10T00:00:00.000Z'),
                },
                {
                    id: 'tool',
                    role: 'tool',
                    text: '',
                    turnId: 'turn-1',
                    status: 'completed',
                    toolName: 'evb_read_resource',
                    toolDetail: 'page 1: text',
                    createdAt: requireIsoTimestamp('2026-10-10T00:00:01.000Z'),
                    completedAt: requireIsoTimestamp('2026-10-10T00:00:02.000Z'),
                },
            ],
        });
        const instanceKey = `codex_proxy:${scope.key}`;
        persistence.recordSessionSnapshot(instanceKey, original);
        await persistence.flush();
        expect(await createPersistence(persistence.rootDir).recoverSession(instanceKey)).toMatchObject({
            key: instanceKey,
            session: original,
        });
    });
    it.each([
        'assistant',
        'reasoning',
        'tool',
    ] as const)('recovers a streaming %s item as interrupted even with an idle stored turn', async role => {
        const persistence = createPersistence();
        persistence.recordSessionSnapshot(key, session({messages: [{
            id: 'partial',
            role,
            text: 'partial',
            status: 'streaming',
            turnId: 'turn-1',
            createdAt: requireIsoTimestamp('2026-10-10T00:00:00.000Z'),
        }]}));
        await persistence.flush();
        expect((await persistence.recoverSession(key))?.session.messages).toEqual([expect.objectContaining({
            id: 'partial',
            status: 'interrupted',
            text: 'partial',
        })]);
    });
    it('flushes the newest queued snapshot without waiting for debounce', async () => {
        const persistence = createPersistence();
        persistence.recordSessionSnapshot(key, session());
        const newest = session({model: 'gpt-5.4'});
        persistence.recordSessionSnapshot(key, newest);
        await persistence.flush();
        expect(persistedRecordCount(persistence.sessionPath(key))).toBe(1);
        expect((await persistence.recoverSession(key))?.session.model).toBe('gpt-5.4');
    });
    it('quarantines corrupt complete records instead of partially recovering history', async () => {
        const persistence = createPersistence();
        persistence.recordSessionSnapshot(key, session());
        await persistence.flush();
        writeFileSync(persistence.sessionPath(key), 'not json\n', {flag: 'a'});
        expect(await persistence.recoverSession(key)).toBeNull();
        expect(readdirSync(persistence.sessionsDir)).toEqual([]);
        const files = readdirSync(persistence.archiveDir);
        expect(files).toHaveLength(1);
        expect(files[0]).toContain('.corrupt.');
        expect(readFileSync(join(persistence.archiveDir, files[0]!), 'utf8')).toContain('not json');
    });
    it('quarantines malformed nested message metadata', async () => {
        const persistence = createPersistence();
        persistence.recordSessionSnapshot(key, session());
        await persistence.flush();
        mutateLastPersistedSnapshot(persistence.sessionPath(key), snapshot => {
            snapshot.messages = [{
                id: 'bad',
                role: 'tool',
                text: '',
                status: 'invalid',
                createdAt: '2026-10-10T00:00:00.000Z',
            }];
        });
        expect(await persistence.recoverSessions()).toEqual([]);
        expect(readdirSync(persistence.archiveDir)[0]).toContain('.corrupt.');
    });
    it('archives reset bytes and prevents their resurrection after restart', async () => {
        const persistence = createPersistence();
        persistence.recordSessionSnapshot(key, session());
        await persistence.flush();
        const bytes = readFileSync(persistence.sessionPath(key), 'utf8');
        persistence.archiveSession(key, 'reset');
        await persistence.flush();
        expect(await createPersistence(persistence.rootDir).recoverSession(key)).toBeNull();
        const archive = readdirSync(persistence.archiveDir).find(name => name.includes('.reset.'))!;
        expect(readFileSync(join(persistence.archiveDir, archive), 'utf8')).toBe(bytes);
    });
    it('prunes least recently accessed sessions while keeping their recoverable eviction bytes', async () => {
        const persistence = createPersistence(undefined, {maxSessions: 2});
        for (let index = 0; index < 3; index += 1) {
            persistence.recordSessionSnapshot(`codex:document:${index}`, session({lastAccessedAtMs: index}));
            await persistence.flush();
        }
        expect((await persistence.recoverSessions()).map(entry => entry.key).sort()).toEqual([
            'codex:document:1',
            'codex:document:2',
        ]);
        expect((await persistence.recoverSession('codex:document:0'))?.session.messages[0]?.text).toBe('question');
    });
    it('bounds transcript bytes with a blob while preserving the complete saved text', async () => {
        const persistence = createPersistence(undefined, {maxSessionBytes: 1_024});
        const original = session();
        original.messages[0]!.text = 'Large saved transcript. '.repeat(1_000);
        persistence.recordSessionSnapshot(key, original);
        await persistence.flush();
        expect(statSync(persistence.sessionPath(key)).size).toBeLessThanOrEqual(1_024);
        expect(readFileSync(persistence.sessionPath(key), 'utf8')).toContain('session-snapshot-ref');
        expect((await createPersistence(persistence.rootDir).recoverSession(key))?.session.messages).toEqual(original.messages);
    });
    it('prunes obsolete blob generations and retains blobs still referenced by an archive', async () => {
        const persistence = createPersistence(undefined, {maxSessionBytes: 1_024});
        const original = session();
        original.messages[0]!.text = 'first'.repeat(2_000);
        persistence.recordSessionSnapshot(key, original);
        await persistence.flush();
        persistence.archiveSession(key, 'evicted');
        await persistence.flush();
        const archived = readdirSync(persistence.blobsDir);
        for (let index = 0; index < 4; index += 1) {
            persistence.recordSessionSnapshot(key, session({messages: [{
                ...original.messages[0]!,
                text: String(index).repeat(10_000),
            }]}));
            await persistence.flush();
        }
        const blobs = readdirSync(persistence.blobsDir);
        expect(blobs).toEqual(expect.arrayContaining(archived));
        expect(blobs.length).toBeLessThanOrEqual(3);
        expect(directoryFileBytes(persistence.blobsDir)).toBeGreaterThan(0);
    });
    it('keeps hashed filenames bounded for deep document paths', async () => {
        const persistence = createPersistence();
        const longKey = `codex:document:/tmp/${'deep/'.repeat(200)}a.pdf`;
        persistence.recordSessionSnapshot(longKey, session());
        await persistence.flush();
        expect(basename(persistence.sessionPath(longKey))).toMatch(/^v2-[a-f0-9]{64}\.jsonl$/u);
        expect((await persistence.recoverSession(longKey))?.session.messages[0]?.text).toBe('question');
    });
    it('reuses a single content blob for repeated snapshots with unchanged content', async () => {
        const persistence = createPersistence(undefined, {maxSessionBytes: 1_024});
        const original = session();
        original.messages[0]!.text = 'unchanged content '.repeat(1_000);
        for (let index = 0; index < 5; index += 1) {
            persistence.recordSessionSnapshot(key, original);
            await persistence.flush();
        }
        expect(readdirSync(persistence.blobsDir).filter(name => name.endsWith('.json'))).toHaveLength(1);
    });
    it('recovers the previous blob generation when the newest reference is corrupt', async () => {
        const persistence = createPersistence(undefined, {maxSessionBytes: 1_024});
        const original = session();
        original.messages[0]!.text = 'prior generation '.repeat(1_000);
        persistence.recordSessionSnapshot(key, original);
        await persistence.flush();
        const previous = JSON.parse(readFileSync(persistence.sessionPath(key), 'utf8')) as Record<string, unknown>;
        const corrupt = {
            ...previous,
            blobFile: `${'f'.repeat(64)}.json`,
        };
        writeFileSync(join(persistence.blobsDir, String(corrupt.blobFile)), 'corrupt');
        writeFileSync(persistence.sessionPath(key), `${JSON.stringify(previous)}\n${JSON.stringify(corrupt)}\n`);
        expect((await createPersistence(persistence.rootDir).recoverSession(key))?.session.messages).toEqual(original.messages);
    });
    it('rejects a failed flush and retains its snapshot for an explicit retry', async () => {
        const persistence = createPersistence();
        persistence.recordSessionSnapshot(key, session());
        const path = persistence.sessionPath(key);
        mkdirSync(path);
        await expect(persistence.flush()).rejects.toMatchObject({
            code: 'write-failed',
            retryable: true,
            pendingKeys: [key],
        });
        rmSync(path, {recursive: true});
        await persistence.flush();
        expect((await persistence.recoverSession(key))?.session.messages[0]?.text).toBe('question');
    });
    it('retains only the configured archive count', async () => {
        let now = 100;
        const persistence = createPersistence(undefined, {
            maxArchives: 2,
            now: () => now++,
        });
        for (let index = 0; index < 3; index += 1) {
            const archiveKey = `codex:archive-${index}`;
            persistence.recordSessionSnapshot(archiveKey, session());
            persistence.archiveSession(archiveKey, 'evicted');
            await persistence.flush();
        }
        expect(readdirSync(persistence.archiveDir).filter(name => name.endsWith('.jsonl'))).toHaveLength(2);
        expect(await persistence.recoverSession('codex:archive-0')).toBeNull();
        expect((await persistence.recoverSession('codex:archive-2'))?.session.messages[0]?.text).toBe('question');
    });
    it('recovers legacy eviction archives but preserves an unreadable live transcript', async () => {
        const persistence = createPersistence();
        persistence.recordSessionSnapshot(key, session());
        await persistence.flush();
        const path = persistence.sessionPath(key);
        const archive = join(persistence.archiveDir, `${Buffer.from(key).toString('base64url')}.evicted.1.abcd.jsonl`);
        renameSync(path, archive);
        expect((await persistence.recoverSession(key))?.session.providerThreadId).toBe('thread-original');
        mkdirSync(path);
        await expect(persistence.recoverSession(key)).rejects.toBeInstanceOf(AssistantChatPersistenceError);
        expect(statSync(path).isDirectory()).toBe(true);
        expect(readFileSync(archive, 'utf8')).toContain('question');
    });
    it('quarantines a corrupt eviction archive without resurrecting older history', async () => {
        const persistence = createPersistence();
        persistence.recordSessionSnapshot(key, session());
        await persistence.flush();
        const path = persistence.sessionPath(key);
        const prefix = basename(path, '.jsonl');
        renameSync(path, join(persistence.archiveDir, `${prefix}.evicted.1.abcd.jsonl`));
        writeFileSync(join(persistence.archiveDir, `${prefix}.evicted.2.abcd.jsonl`), 'corrupt\n');
        expect(await persistence.recoverSession(key)).toBeNull();
        expect(await persistence.recoverSession(key)).toBeNull();
        expect(readdirSync(persistence.archiveDir).some(name => name.includes('.corrupt.'))).toBe(true);
    });
    it('repairs a torn final record and permits later snapshots to recover', async () => {
        const persistence = createPersistence();
        persistence.recordSessionSnapshot(key, session());
        await persistence.flush();
        writeFileSync(persistence.sessionPath(key), '{"type":"session-snap', {flag: 'a'});
        expect((await persistence.recoverSession(key))?.session.messages[0]?.text).toBe('question');
        persistence.recordSessionSnapshot(key, session({model: 'after-repair'}));
        await persistence.flush();
        expect((await createPersistence(persistence.rootDir).recoverSession(key))?.session.model).toBe('after-repair');
    });

});
