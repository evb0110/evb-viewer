import {
    createHash,
    randomBytes,
} from 'node:crypto';
import {
    mkdirSync,
    type BigIntStats,
} from 'fs';
import {
    appendFile,
    copyFile,
    mkdir,
    readFile,
    readdir,
    rename,
    rm,
    stat,
    writeFile,
} from 'fs/promises';
import {
    basename,
    dirname,
    join,
} from 'path';
import { app } from 'electron';
import type {
    IAgentAssistantChatScope,
    IAgentAssistantErrorEnvelope,
    IAgentAssistantImageAttachment,
    TAgentWorkspaceCommandTarget,
    TAgentAssistantEffort,
    TAgentAssistantProviderId,
    TAgentAssistantSpeedMode,
} from '@contracts/agent';
import { isErrnoException } from '@contracts/runtimeGuards';
import { ASSISTANT_INSTANCE_ID_PATTERN } from '@contracts/assistant';
import { isDocumentRevisionInfo } from '@contracts/documentRevision';
import {
    inferDocumentRefBackend, parseDocumentRef,
} from '@contracts/documentRef';
import {
    isEpochMs,
    parseIsoTimestamp,
    type TIsoTimestamp,
} from '@contracts/timestamps';
import {parseTabId} from '@contracts/windowTabs';
import { createLogger } from '@electron/utils/createLogger';
import { getErrorMessage } from '@electron/utils/error';
import type {IAssistantSessionScopeBinding} from '@electron/features/agent/assistantMcpSessionScope';
import {fsyncParentDirectory} from '@electron/utils/atomicReplace';
import {fsyncFile} from '@electron/utils/fsyncPath';
import {AssistantChatSnapshotStorage} from '@electron/features/agent/assistantChatSnapshotStorage';
import pruneAssistantChatSnapshotBlobs from '@electron/features/agent/pruneAssistantChatSnapshotBlobs';
import {pruneAssistantChatArchives} from '@electron/features/agent/pruneAssistantChatArchives';

const ASSISTANT_CHAT_PERSISTENCE_SCHEMA_VERSION = 1;

/** Version-1 records carry the turn owner of the release that wrote them. */
type TAssistantTurnOwnerState =
    | {
        phase: 'idle';
        generation: number;
        turnId: null;
        localTurnId: null;
    }
    | {
        phase: 'starting';
        generation: number;
        localTurnId: string;
        providerTurnId: null;
        scope: IAssistantSessionScopeBinding;
    }
    | {
        phase: 'running';
        generation: number;
        localTurnId: string;
        providerTurnId: string;
        scope: IAssistantSessionScopeBinding;
    }
    | {
        phase: 'interrupting';
        generation: number;
        localTurnId: string;
        providerTurnId: string | null;
        scope: IAssistantSessionScopeBinding;
    }
    | {
        phase: 'error';
        generation: number;
        turnId: null;
        localTurnId: null;
        error: string;
    };

function isAssistantTurnActive(owner: TAssistantTurnOwnerState) {
    return owner.phase === 'starting' || owner.phase === 'running' || owner.phase === 'interrupting';
}


const ASSISTANT_CHAT_STORAGE_DIR = 'assistant-chat';
const ASSISTANT_CHAT_SESSION_DIR = 'sessions';
const ASSISTANT_CHAT_ARCHIVE_DIR = 'archive';
const ASSISTANT_CHAT_SESSION_FILE_PREFIX = 'v2-';
const ASSISTANT_CHAT_SNAPSHOT_BLOB_DIR = 'blobs';
export const DEFAULT_ASSISTANT_CHAT_MAX_SESSION_BYTES = 2 * 1024 * 1024;
const DEFAULT_ASSISTANT_CHAT_MAX_SESSIONS = 64;
const DEFAULT_ASSISTANT_CHAT_MAX_ARCHIVES = 128;
const DEFAULT_ASSISTANT_CHAT_SNAPSHOT_DEBOUNCE_MS = 300;
const ASSISTANT_CHAT_INTERRUPTED_ERROR = 'Assistant turn interrupted because EVB Viewer closed before it completed.';

const logger = createLogger('assistant-chat-persistence');

/**
 * A timeline item as stored. `role` is the item kind; records written before
 * provider instances carry only user, assistant and system roles with
 * `pending`/`error` instead of `status`.
 */
export interface IPersistedAssistantMessage {
    id: string;
    role: 'user' | 'assistant' | 'system' | 'reasoning' | 'tool';
    text: string;
    createdAt: TIsoTimestamp;
    attachments?: IAgentAssistantImageAttachment[];
    turnId?: string | null;
    status?: 'streaming' | 'completed' | 'interrupted' | 'failed';
    toolName?: string;
    toolDetail?: string;
    completedAt?: TIsoTimestamp;
    pending?: boolean;
    error?: string;
    errorEnvelope?: IAgentAssistantErrorEnvelope;
}

export interface IPersistedAssistantChatSession {
    /** The driver. Absent `instanceId` means the driver's default instance. */
    provider: TAgentAssistantProviderId;
    instanceId?: string;
    scope: IAgentAssistantChatScope;
    model: string;
    effort: TAgentAssistantEffort;
    speedMode: TAgentAssistantSpeedMode;
    providerThreadId: string | null;
    turnOwner: TAssistantTurnOwnerState;
    messages: IPersistedAssistantMessage[];
    lastAccessedAtMs: number;
    lastError?: string;
}

/**
 * A recovered session never carries an action grant: the sender window and
 * scope binding are live-only state, so they are not part of the persisted
 * session and recovery sets them to null.
 */
export type TRecoveredAssistantChatSessionData = IPersistedAssistantChatSession & {
    lastSenderWindowId: null;
    scopeBinding: null;
};

interface IAssistantChatSessionEntry {
    filePath: string;
    key: string;
    session: IPersistedAssistantChatSession;
    lastAccessedAtMs: number;
    sizeBytes: number;
}

type TAssistantChatSessionIndexEntry = Omit<IAssistantChatSessionEntry, 'session'>;

/** A session file's identity: any write, repair or replacement changes it. */
function sessionFileIdentity(fileStat: BigIntStats) {
    return `${fileStat.dev}:${fileStat.ino}:${fileStat.size}:${fileStat.mtimeNs}:${fileStat.ctimeNs}`;
}

type TPersistedAssistantChatRecord =
    | {
        schemaVersion: typeof ASSISTANT_CHAT_PERSISTENCE_SCHEMA_VERSION;
        type: 'session-snapshot';
        key: string;
        writtenAt: string;
        session: IPersistedAssistantChatSession;
    }
    | {
        schemaVersion: typeof ASSISTANT_CHAT_PERSISTENCE_SCHEMA_VERSION;
        type: 'session-reset';
        key: string;
        writtenAt: string;
    }
    | {
        schemaVersion: typeof ASSISTANT_CHAT_PERSISTENCE_SCHEMA_VERSION;
        type: 'session-snapshot-ref';
        keyDigest: string;
        writtenAt: string;
        blobFile: string;
        sha256: string;
        sizeBytes: number;
    };

export type TAssistantChatPersistenceFailureCode =
    | 'write-failed'
    | 'maintenance-failed'
    | 'snapshot-too-large';

export class AssistantChatPersistenceError extends Error {
    readonly code: TAssistantChatPersistenceFailureCode;
    readonly sessionKey: string;
    readonly pendingKeys: readonly string[];
    readonly retryable: boolean;

    constructor(
        code: TAssistantChatPersistenceFailureCode,
        sessionKey: string,
        message: string,
        pendingKeys: readonly string[] = [sessionKey],
        cause?: unknown,
    ) {
        super(message);
        this.name = 'AssistantChatPersistenceError';
        this.code = code;
        this.sessionKey = sessionKey;
        this.pendingKeys = [...new Set(pendingKeys)];
        this.retryable = code !== 'snapshot-too-large';
        if (cause !== undefined) {
            Object.defineProperty(this, 'cause', {
                configurable: true,
                value: cause,
            });
        }
    }
}

export interface IRecoveredAssistantChatSession {
    key: string;
    session: TRecoveredAssistantChatSessionData;
    filePath: string;
    sizeBytes: number;
}

interface IRecoveredAssistantChatSessionFile {
    key: string;
    session: IPersistedAssistantChatSession;
}

export interface IAssistantChatPersistenceOptions {
    rootDir?: string;
    maxSessionBytes?: number;
    maxSessions?: number;
    maxArchives?: number;
    snapshotDebounceMs?: number;
    now?: () => number;
    onError?: (message: string, error: unknown) => void;
}

interface IPendingAssistantChatSnapshot {
    ready: boolean;
    /**
     * The record actually handed to the write, kept so a completing write can
     * tell whether the pending entry is still the one it started from. Null
     * until the snapshot is taken, which for a streamed delta is deferred to
     * the moment the debounce fires rather than paid once per delta.
     */
    written: TPersistedAssistantChatRecord | null;
    takeSnapshot: () => TPersistedAssistantChatRecord;
    timer: ReturnType<typeof setTimeout> | null;
    failure: AssistantChatPersistenceError | undefined;
}

function getDefaultAssistantChatPersistenceRoot() {
    return join(app.getPath('userData'), ASSISTANT_CHAT_STORAGE_DIR);
}

function createPersistenceSessionFileName(sessionKey: string) {
    const digest = createHash('sha256').update(sessionKey).digest('hex');
    return `${ASSISTANT_CHAT_SESSION_FILE_PREFIX}${digest}.jsonl`;
}

function decodePersistenceSessionFileName(fileName: string) {
    if (!fileName.endsWith('.jsonl')) {
        return null;
    }
    if (fileName.startsWith(ASSISTANT_CHAT_SESSION_FILE_PREFIX)) {
        return null;
    }

    try {
        return Buffer.from(fileName.slice(0, -'.jsonl'.length), 'base64url').toString('utf8');
    } catch {
        return null;
    }
}

function randomSuffix() {
    return randomBytes(8).toString('hex');
}

async function atomicWriteJsonFile(filePath: string, payload: unknown) {
    await mkdir(dirname(filePath), { recursive: true });
    const tempPath = join(dirname(filePath), `.${basename(filePath)}.${randomSuffix()}.tmp`);
    await writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    await fsyncFile(tempPath);
    await rename(tempPath, filePath);
    await fsyncParentDirectory(filePath);
}

function clonePersistedSession(session: IPersistedAssistantChatSession): IPersistedAssistantChatSession {
    return {
        provider: session.provider,
        ...(session.instanceId === undefined ? {} : {instanceId: session.instanceId}),
        scope: {...session.scope},
        model: session.model,
        effort: session.effort,
        speedMode: session.speedMode,
        providerThreadId: session.providerThreadId,
        turnOwner: {...session.turnOwner},
        messages: session.messages.map((message: IPersistedAssistantMessage): IPersistedAssistantMessage => {
            const attachments = message.attachments;
            return {
                ...message,
                ...(attachments === undefined
                    ? {}
                    : {attachments: attachments.map(attachment => ({...attachment}))}),
            };
        }),
        lastAccessedAtMs: session.lastAccessedAtMs,
        ...(session.lastError === undefined ? {} : { lastError: session.lastError }),
    };
}

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function isNonNegativeInteger(value: unknown) {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isSafeInteger(value: unknown) {
    return typeof value === 'number' && Number.isSafeInteger(value);
}

function isNullableString(value: unknown) {
    return value === null || typeof value === 'string';
}

function isOptionalNullableString(value: unknown) {
    return value === undefined || isNullableString(value);
}

function isOptionalDocumentBackend(value: unknown) {
    return value === undefined || value === 'electron' || value === 'browser';
}

function isWorkspaceCommandTarget(value: unknown): value is TAgentWorkspaceCommandTarget {
    if (
        !isObject(value)
        || typeof value.tabId !== 'string'
        || value.tabId.length === 0
        || typeof value.sessionId !== 'string'
        || value.sessionId.length === 0
        || !isNullableString(value.documentRef)
        || !isOptionalDocumentBackend(value.documentBackend)
        || !isOptionalNullableString(value.documentInstanceId)
        || (
            value.documentRevisionToken !== undefined
            && (typeof value.documentRevisionToken !== 'string' || value.documentRevisionToken.length === 0)
        )
    ) {
        return false;
    }
    return value.kind === 'transaction'
        ? typeof value.transactionId === 'string' && value.transactionId.length > 0
        : value.kind === 'revision' && isNonNegativeInteger(value.sessionRevision);
}

function isAssistantChatScope(value: unknown): value is IAgentAssistantChatScope {
    return isObject(value)
        && value.kind === 'document'
        && typeof value.key === 'string'
        && value.key.length > 0
        && isNullableString(value.title)
        && isOptionalNullableString(value.tabId)
        && isOptionalNullableString(value.documentSessionKey)
        && isOptionalNullableString(value.documentInstanceId)
        && isOptionalNullableString(value.documentRef)
        && isOptionalDocumentBackend(value.documentBackend)
        && (
            value.documentIdentity === undefined
            || value.documentIdentity === null
            || isDocumentRevisionInfo(value.documentIdentity)
        )
        && (
            value.commandTarget === undefined
            || isWorkspaceCommandTarget(value.commandTarget)
        );
}

function isAssistantErrorEnvelope(value: unknown) {
    return isObject(value)
        && (
            value.code === 'AUTH_REQUIRED'
            || value.code === 'INSTALL_MISSING'
            || value.code === 'LOGIN_CANCELLED'
            || value.code === 'USER_INTERRUPTED'
            || value.code === 'MODEL_UNAVAILABLE'
            || value.code === 'RUNTIME_UNAVAILABLE'
            || value.code === 'PROVIDER_RATE_LIMITED'
            || value.code === 'INTERNAL'
        )
        && typeof value.message === 'string'
        && typeof value.retryable === 'boolean'
        && isObject(value.details)
        && isEpochMs(value.details.timestamp);
}

function isAssistantImageAttachment(value: unknown) {
    return isObject(value)
        && value.type === 'image'
        && typeof value.id === 'string'
        && typeof value.name === 'string'
        && typeof value.mimeType === 'string'
        && typeof value.dataUrl === 'string'
        && typeof value.sizeBytes === 'number'
        && Number.isFinite(value.sizeBytes)
        && value.sizeBytes > 0;
}

const PERSISTED_MESSAGE_ROLES = new Set([
    'user',
    'assistant',
    'system',
    'reasoning',
    'tool',
]);
const PERSISTED_MESSAGE_STATUSES = new Set([
    'streaming',
    'completed',
    'interrupted',
    'failed',
]);

function isOptionalString(value: unknown) {
    return value === undefined || typeof value === 'string';
}

function isAssistantChatMessage(value: unknown): value is IPersistedAssistantMessage {
    return isObject(value)
        && typeof value.id === 'string'
        && typeof value.role === 'string'
        && PERSISTED_MESSAGE_ROLES.has(value.role)
        && typeof value.text === 'string'
        && parseIsoTimestamp(value.createdAt) !== null
        && (
            value.attachments === undefined
            || Array.isArray(value.attachments) && value.attachments.every(isAssistantImageAttachment)
        )
        && (value.turnId === undefined || value.turnId === null || typeof value.turnId === 'string')
        && (value.status === undefined || typeof value.status === 'string' && PERSISTED_MESSAGE_STATUSES.has(value.status))
        && isOptionalString(value.toolName)
        && isOptionalString(value.toolDetail)
        && (value.completedAt === undefined || parseIsoTimestamp(value.completedAt) !== null)
        && (value.pending === undefined || typeof value.pending === 'boolean')
        && isOptionalString(value.error)
        && (value.errorEnvelope === undefined || isAssistantErrorEnvelope(value.errorEnvelope));
}

function isAssistantSessionScopeBinding(value: unknown): value is IAssistantSessionScopeBinding {
    return isObject(value)
        && typeof value.sessionKey === 'string'
        && value.sessionKey.length > 0
        && typeof value.scopeKey === 'string'
        && value.scopeKey.length > 0
        && (value.provider === 'codex' || value.provider === 'claude')
        && isNonNegativeInteger(value.turnGeneration)
        && isSafeInteger(value.windowId)
        && parseTabId(value.tabId) !== null
        && isOptionalNullableString(value.documentSessionKey)
        && (value.documentRef === null || parseDocumentRef(value.documentRef) !== null)
        && isOptionalDocumentBackend(value.documentBackend)
        && isOptionalNullableString(value.documentInstanceId)
        && (value.documentIdentity === null || isDocumentRevisionInfo(value.documentIdentity))
        && (value.commandTarget === undefined || isWorkspaceCommandTarget(value.commandTarget));
}

function isAssistantTurnOwner(value: unknown): value is TAssistantTurnOwnerState {
    if (!isObject(value) || !isNonNegativeInteger(value.generation)) {
        return false;
    }
    if (value.phase === 'idle') {
        return value.turnId === null && value.localTurnId === null;
    }
    if (value.phase === 'error') {
        return value.turnId === null
            && value.localTurnId === null
            && typeof value.error === 'string';
    }
    if (value.phase === 'starting') {
        return typeof value.localTurnId === 'string'
            && value.providerTurnId === null
            && isAssistantSessionScopeBinding(value.scope)
            && value.scope.turnGeneration === value.generation;
    }
    if (value.phase === 'running' || value.phase === 'interrupting') {
        return typeof value.localTurnId === 'string'
            && (
                value.phase === 'interrupting' && value.providerTurnId === null
                || typeof value.providerTurnId === 'string'
            )
            && isAssistantSessionScopeBinding(value.scope)
            && value.scope.turnGeneration === value.generation;
    }
    return false;
}

function isPersistedSession(value: unknown): value is IPersistedAssistantChatSession {
    if (!isObject(value)) {
        return false;
    }
    return (value.provider === 'codex' || value.provider === 'claude')
        && (value.instanceId === undefined || typeof value.instanceId === 'string' && ASSISTANT_INSTANCE_ID_PATTERN.test(value.instanceId))
        && isAssistantChatScope(value.scope)
        && typeof value.model === 'string'
        && typeof value.effort === 'string'
        && (value.speedMode === 'fast' || value.speedMode === 'standard')
        && (typeof value.providerThreadId === 'string' || value.providerThreadId === null)
        && isAssistantTurnOwner(value.turnOwner)
        && Array.isArray(value.messages)
        && value.messages.every(isAssistantChatMessage)
        && typeof value.lastAccessedAtMs === 'number'
        && Number.isFinite(value.lastAccessedAtMs)
        && (value.lastError === undefined || typeof value.lastError === 'string');
}

function parsePersistedRecord(line: string): TPersistedAssistantChatRecord | null {
    let parsed: unknown;
    try {
        parsed = JSON.parse(line);
    } catch {
        return null;
    }

    if (!isObject(parsed) || parsed.schemaVersion !== ASSISTANT_CHAT_PERSISTENCE_SCHEMA_VERSION) {
        return null;
    }
    if (
        parsed.type === 'session-reset'
        && typeof parsed.key === 'string'
        && parsed.key.length > 0
        && typeof parsed.writtenAt === 'string'
    ) {
        return parsed as TPersistedAssistantChatRecord;
    }
    if (
        parsed.type === 'session-snapshot'
        && typeof parsed.key === 'string'
        && parsed.key.length > 0
        && typeof parsed.writtenAt === 'string'
        && isPersistedSession(parsed.session)
    ) {
        return parsed as TPersistedAssistantChatRecord;
    }
    if (
        parsed.type === 'session-snapshot-ref'
        && typeof parsed.keyDigest === 'string'
        && /^[a-f0-9]{64}$/u.test(parsed.keyDigest)
        && typeof parsed.writtenAt === 'string'
        && typeof parsed.blobFile === 'string'
        && /^[a-f0-9]{64}\.json$/u.test(parsed.blobFile)
        && typeof parsed.sha256 === 'string'
        && /^[a-f0-9]{64}$/u.test(parsed.sha256)
        && typeof parsed.sizeBytes === 'number'
        && Number.isSafeInteger(parsed.sizeBytes)
        && parsed.sizeBytes > 0
    ) {
        return parsed as TPersistedAssistantChatRecord;
    }
    return null;
}

function interruptRecoveredSession(session: IPersistedAssistantChatSession): TRecoveredAssistantChatSessionData {
    // A transcript and provider resume ID survive a cache miss. Version-1
    // snapshots may still carry grant fields that this build never writes, so
    // recovery overwrites them and no action grant survives a restart.
    const recovered = Object.assign(session, {
        lastSenderWindowId: null,
        scopeBinding: null,
    });
    if (!isAssistantTurnActive(recovered.turnOwner)) {
        interruptStreamingMessages(session);
        return recovered;
    }

    session.turnOwner = {
        phase: 'error',
        generation: session.turnOwner.generation,
        turnId: null,
        localTurnId: null,
        error: ASSISTANT_CHAT_INTERRUPTED_ERROR,
    };
    session.lastError = ASSISTANT_CHAT_INTERRUPTED_ERROR;
    interruptStreamingMessages(session);
    return recovered;
}

function interruptStreamingMessages(session: IPersistedAssistantChatSession) {
    for (const message of session.messages) {
        if (message.status === 'streaming') {
            message.status = 'interrupted';
        }
        if (message.role === 'assistant' && message.pending) {
            message.pending = false;
            message.error = message.error ?? ASSISTANT_CHAT_INTERRUPTED_ERROR;
        }
    }
}

function createSnapshotRecord(
    key: string,
    session: IPersistedAssistantChatSession,
): Extract<TPersistedAssistantChatRecord, {type: 'session-snapshot'}> {
    return {
        schemaVersion: ASSISTANT_CHAT_PERSISTENCE_SCHEMA_VERSION,
        type: 'session-snapshot',
        key,
        writtenAt: new Date().toISOString(),
        session: clonePersistedSession(session),
    };
}

function createPersistedSnapshotRecord(
    key: string,
    session: IPersistedAssistantChatSession,
): Extract<TPersistedAssistantChatRecord, {type: 'session-snapshot'}> {
    return {
        schemaVersion: ASSISTANT_CHAT_PERSISTENCE_SCHEMA_VERSION,
        type: 'session-snapshot',
        key,
        writtenAt: new Date().toISOString(),
        session,
    };
}

// Compatibility for pre-004d174623 document-session scopes. Remove only when
// importing schema-1 chats from those releases is no longer supported.
function legacyDocumentScopeKey(entry: IRecoveredAssistantChatSessionFile) {
    const {
        provider, scope,
    } = entry.session;
    if (!scope.key.startsWith('document-session:')
        || scope.key === 'document-session:'
        || entry.key !== `${provider}:${scope.key}`) return null;
    const documentRef = parseDocumentRef(scope.documentRef);
    if (documentRef === null) return null;
    const backend = inferDocumentRefBackend(documentRef);
    if (scope.documentBackend !== undefined && scope.documentBackend !== backend) return null;
    return `document:${backend}:${documentRef}`;
}

export class AssistantChatPersistence {
    readonly rootDir: string;
    readonly sessionsDir: string;
    readonly archiveDir: string;
    readonly blobsDir: string;
    readonly indexPath: string;
    private readonly maxSessionBytes: number;
    private readonly maxSessions: number;
    private readonly maxArchives: number;
    private readonly snapshotStorage: AssistantChatSnapshotStorage<IPersistedAssistantChatSession, 1>;
    private readonly snapshotDebounceMs: number;
    private readonly now: () => number;
    private readonly onError: (message: string, error: unknown) => void;
    private readonly queues = new Map<string, Promise<void>>();
    private readonly pendingSnapshots = new Map<string, IPendingAssistantChatSnapshot>();
    private readonly activeSnapshotCounts = new Map<string, number>();
    /** Index metadata of each recovered session file, with the identity it was read at. */
    private readonly indexedSessionFiles = new Map<string, TAssistantChatSessionIndexEntry & {identity: string}>();
    /** The compatibility pass runs once per owner, and only after a complete read. */
    private legacyScopesMigrated = false;
    private writeQueue: Promise<void> = Promise.resolve();
    private writeOutcome: Promise<void> = Promise.resolve();

    constructor(options: IAssistantChatPersistenceOptions = {}) {
        this.rootDir = options.rootDir ?? getDefaultAssistantChatPersistenceRoot();
        this.sessionsDir = join(this.rootDir, ASSISTANT_CHAT_SESSION_DIR);
        this.archiveDir = join(this.rootDir, ASSISTANT_CHAT_ARCHIVE_DIR);
        this.blobsDir = join(this.rootDir, ASSISTANT_CHAT_SNAPSHOT_BLOB_DIR);
        this.indexPath = join(this.rootDir, 'index.json');
        this.maxSessionBytes = options.maxSessionBytes ?? DEFAULT_ASSISTANT_CHAT_MAX_SESSION_BYTES;
        this.maxSessions = options.maxSessions ?? DEFAULT_ASSISTANT_CHAT_MAX_SESSIONS;
        this.maxArchives = options.maxArchives ?? DEFAULT_ASSISTANT_CHAT_MAX_ARCHIVES;
        this.snapshotDebounceMs = options.snapshotDebounceMs ?? DEFAULT_ASSISTANT_CHAT_SNAPSHOT_DEBOUNCE_MS;
        this.now = options.now ?? Date.now;
        this.onError = options.onError ?? ((message, error) => {
            logger.warn(`${message}: ${getErrorMessage(error)}`);
        });
        mkdirSync(this.sessionsDir, { recursive: true });
        mkdirSync(this.archiveDir, { recursive: true });
        this.snapshotStorage = new AssistantChatSnapshotStorage<IPersistedAssistantChatSession, 1>({
            blobsDir: this.blobsDir,
            maxSessionBytes: this.maxSessionBytes,
            createTooLargeError: (key, message) => new AssistantChatPersistenceError(
                'snapshot-too-large',
                key,
                message,
            ),
            parseRecord: parsePersistedRecord,
        });
    }

    sessionPath(key: string): string {
        return join(this.sessionsDir, createPersistenceSessionFileName(key));
    }

    getMaxSessionBytes() {
        return this.maxSessionBytes;
    }

    async recoverSessions(): Promise<IRecoveredAssistantChatSession[]> {
        let entries: IAssistantChatSessionEntry[];
        try {
            entries = await this.readSessionEntries();
        } catch (error) {
            this.onError('Failed to enumerate assistant chat sessions', error);
            return [];
        }
        let migrationFailure: AssistantChatPersistenceError | undefined;
        await this.enqueue('scope-migration', async () => {
            try {
                entries = await this.adoptLegacyDocumentScopes(entries);
            } catch (error) {
                migrationFailure = this.toPersistenceError('scope-migration', error);
            }
        });
        if (migrationFailure) throw migrationFailure;
        const recovered = entries.map(entry => ({
            ...entry,
            session: interruptRecoveredSession(entry.session),
        }));
        await this.pruneRecoveredSessionsAsync(recovered);
        await pruneAssistantChatArchives(this.archiveDir, this.maxArchives, this.onError);
        await this.pruneSnapshotBlobs();
        return recovered;
    }

    async recoverSession(key: string): Promise<IRecoveredAssistantChatSession | null> {
        let recovered = null as IRecoveredAssistantChatSession | AssistantChatPersistenceError | null;
        this.forcePendingSnapshot(key, true);
        await this.enqueue(key, async () => {
            try {
                if (!this.legacyScopesMigrated && /^(codex|claude):document:/u.test(key)) {
                    await this.adoptLegacyDocumentScopes(await this.readSessionEntries());
                }
                const {entry} = await this.readSessionForRecovery(key);
                if (entry) recovered = {
                    ...entry,
                    session: interruptRecoveredSession(entry.session),
                };
            } catch (error) {
                recovered = this.toPersistenceError(key, error);
                this.onError(`Failed to recover assistant chat session "${key}" during lookup`, recovered);
            }
        }, true);
        // Report failure after the queued callback settles, so a retry is usable.
        if (recovered instanceof AssistantChatPersistenceError) throw recovered;
        return recovered;
    }

    /** One authority rule for ordinary lookup and legacy scope adoption. */
    private async readSessionForRecovery(key: string): Promise<{
        entry: IAssistantChatSessionEntry | null;
        blocksImport: boolean;
    }> {
        const legacyName = `${Buffer.from(key).toString('base64url')}.jsonl`;
        const paths = [this.sessionPath(key)];
        if (Buffer.byteLength(legacyName) <= 255) paths.push(join(this.sessionsDir, legacyName));
        const archives = await this.readSessionArchives(key);
        const isBarrier = (reason: string) => reason === 'reset' || reason === 'corrupt' || reason === 'scope-migrated';
        const retiredLegacyKey = /^(codex|claude):document-session:/u.test(key)
            && archives.some(archive => archive.reason === 'scope-migrated');
        for (const candidate of [
            ...paths.map(filePath => ({
                filePath,
                reason: 'live',
            })),
            ...archives,
        ]) {
            if (isBarrier(candidate.reason) || candidate.reason !== 'live' && retiredLegacyKey) return {
                entry: null,
                blocksImport: true,
            };
            let contents: string;
            try {
                contents = await this.readSessionContents(candidate.filePath, key);
            } catch (error) {
                if (isErrnoException(error) && error.code === 'ENOENT') continue;
                throw error;
            }
            let file;
            try {
                file = this.recoverSessionContents(candidate.filePath, key, contents);
            } catch (error) {
                if (error instanceof AssistantChatPersistenceError) throw error;
                await this.quarantineCorruptSession(candidate.filePath);
                this.onError(`Failed to recover assistant chat session "${key}" during lookup`, error);
                return {
                    entry: null,
                    blocksImport: true,
                };
            }
            return {
                entry: file ? {
                    key: file.key,
                    session: file.session,
                    filePath: candidate.filePath,
                    lastAccessedAtMs: file.session.lastAccessedAtMs,
                    sizeBytes: Buffer.byteLength(contents),
                } : null,
                // An empty/reset transcript and explicit reset/corrupt archives
                // must never be treated as an automatically-created empty chat.
                blocksImport: !file || archives.some(archive => archive.reason === 'reset' || archive.reason === 'corrupt'),
            };
        }
        return {
            entry: null,
            blocksImport: false,
        };
    }

    /** Runs inside the existing write queue, before any recovered grants escape. */
    private async adoptLegacyDocumentScopes(entries: IAssistantChatSessionEntry[]) {
        if (this.legacyScopesMigrated) return entries;
        // A transiently unreadable live transcript keeps the pass retryable.
        const completeRead = (await this.listSessionFiles()).length === entries.length;
        const candidates: IRecoveredAssistantChatSessionFile[] = [...entries];
        // Discover old logical keys even when their only retained copy was evicted.
        // Choose the newest archive per filename prefix before reading its bytes.
        const newest = new Map<string, {
            filePath: string;
            reason: string;
            time: number
        }>();
        for (const file of await readdir(this.archiveDir, {withFileTypes: true})) {
            const match = /^(.*)\.(evicted|expired|reset|corrupt|scope-migrated)\.(\d+)\.[a-f0-9]+\.jsonl$/u.exec(file.name);
            if (!file.isFile() || !match) continue;
            const candidate = {
                filePath: join(this.archiveDir, file.name),
                reason: match[2]!,
                time: Number(match[3]),
            };
            const previous = newest.get(match[1]!);
            const terminal = (reason: string) => /^(reset|corrupt|scope-migrated)$/u.test(reason);
            if (!previous || candidate.time > previous.time
                || candidate.time === previous.time && (
                    Number(terminal(candidate.reason)) > Number(terminal(previous.reason))
                    || terminal(candidate.reason) === terminal(previous.reason) && candidate.filePath > previous.filePath
                )) newest.set(match[1]!, candidate);
        }
        for (const archive of newest.values()) {
            if (archive.reason !== 'evicted' && archive.reason !== 'expired') continue;
            try {
                const entry = await this.recoverSessionFileAsync(archive.filePath);
                if (entry) candidates.push(entry);
            } catch (error) {
                if (error instanceof AssistantChatPersistenceError) throw error;
                await this.quarantineCorruptSession(archive.filePath);
                this.onError('Failed to inspect archived assistant chat scope', error);
            }
        }
        const groups = new Map<string, Set<string>>();
        for (const entry of candidates) {
            const scopeKey = legacyDocumentScopeKey(entry);
            if (scopeKey === null) continue;
            const key = `${entry.session.provider}:${scopeKey}`;
            const group = groups.get(key) ?? new Set<string>();
            group.add(entry.key);
            groups.set(key, group);
        }
        let changed = false;
        for (const [
            key,
            oldKeys,
        ] of [...groups].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
            const current = await this.readSessionForRecovery(key);
            const legacy: IAssistantChatSessionEntry[] = [];
            for (const oldKey of oldKeys) {
                const source = await this.readSessionForRecovery(oldKey);
                if (source.entry) {
                    const scopeKey = legacyDocumentScopeKey(source.entry);
                    if (scopeKey !== null && `${source.entry.session.provider}:${scopeKey}` === key) legacy.push(source.entry);
                }
            }
            const hasConversation = (entry: IAssistantChatSessionEntry) => entry.session.messages.length > 0 || entry.session.providerThreadId !== null;
            legacy.sort((a, b) => Number(hasConversation(b)) - Number(hasConversation(a))
                || b.lastAccessedAtMs - a.lastAccessedAtMs || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
            if (legacy.length === 0) continue;
            let canonical = current.entry;
            if (!current.blocksImport && (!canonical || !hasConversation(canonical))) {
                const winner = legacy[0]!;
                const session = clonePersistedSession(interruptRecoveredSession(winner.session));
                session.scope = {
                    ...session.scope,
                    key: key.slice(`${session.provider}:`.length),
                };
                // Retain any existing empty transcript before replacing it.
                if (canonical) await this.archiveSessionFile(canonical.filePath, 'scope-backup');
                await this.snapshotStorage.writeBoundedSnapshot(this.sessionPath(key), createSnapshotRecord(key, session), key);
                canonical = {
                    key,
                    session,
                    filePath: this.sessionPath(key),
                    lastAccessedAtMs: session.lastAccessedAtMs,
                    sizeBytes: (await stat(this.sessionPath(key))).size,
                };
                changed = true;
            }
            // A reset/corrupt canonical entry forbids adoption, but old histories
            // still retire to protected backups instead of being re-imported.
            if (!canonical && !current.blocksImport) continue;
            if (canonical && canonical.filePath !== this.sessionPath(key)) {
                const session = clonePersistedSession(interruptRecoveredSession(canonical.session));
                await this.snapshotStorage.writeBoundedSnapshot(this.sessionPath(key), createSnapshotRecord(key, session), key);
                canonical = {
                    ...canonical,
                    session,
                    filePath: this.sessionPath(key),
                };
                changed = true;
            }
            // Publication above is durable before any old live filename retires.
            for (const source of legacy) {
                const oldName = `${Buffer.from(source.key).toString('base64url')}.jsonl`;
                const paths = new Set([
                    source.filePath,
                    this.sessionPath(source.key),
                ]);
                if (Buffer.byteLength(oldName) <= 255) paths.add(join(this.sessionsDir, oldName));
                for (const filePath of paths) {
                    if (await this.pathExists(filePath)) await this.archiveSessionFile(filePath, 'scope-migrated');
                }
                changed = true;
            }
            // Retire a canonical base64 sibling too, so directory order cannot
            // replace the published hashed transcript on the next startup.
            for (const entry of entries) {
                if (entry.key === key && entry.filePath !== canonical?.filePath
                    && await this.pathExists(entry.filePath)) {
                    await this.archiveSessionFile(entry.filePath, 'scope-migrated');
                    changed = true;
                }
            }
        }
        if (changed) {
            this.indexedSessionFiles.clear();
        }
        const migrated = changed ? await this.readSessionEntries() : entries;
        await this.writeIndex(migrated);
        this.legacyScopesMigrated = completeRead;
        return migrated;
    }

    private async readSessionArchives(key: string) {
        const prefixes = [
            `${basename(this.sessionPath(key), '.jsonl')}.`,
            `${Buffer.from(key).toString('base64url')}.`,
        ];
        const entries = await readdir(this.archiveDir, {withFileTypes: true});
        const archives = [];
        for (const entry of entries) {
            const prefix = prefixes.find(value => entry.name.startsWith(value));
            const match = prefix && /^(evicted|expired|reset|corrupt|scope-migrated)\.(\d+)\.[a-f0-9]+\.jsonl$/u.exec(entry.name.slice(prefix.length));
            if (entry.isFile() && match) {
                archives.push({
                    filePath: join(this.archiveDir, entry.name),
                    reason: match[1]!,
                    archivedAt: Number(match[2]),
                });
            }
        }
        const terminal = (reason: string) => /^(reset|corrupt|scope-migrated)$/u.test(reason);
        return archives.sort((left, right) => right.archivedAt - left.archivedAt
            || Number(terminal(right.reason)) - Number(terminal(left.reason))
            || (left.filePath < right.filePath ? -1 : left.filePath > right.filePath ? 1 : 0));
    }

    // fallow-ignore-next-line unused-class-member
    recordSessionSnapshot(key: string, session: IPersistedAssistantChatSession): void {
        const record = createSnapshotRecord(key, session);
        this.setPendingSnapshot(key, () => record, false);
    }

    // fallow-ignore-next-line unused-class-member
    recordAssistantDelta(key: string, session: IPersistedAssistantChatSession): void {
        this.setPendingSnapshot(key, () => createSnapshotRecord(key, session), false);
    }

    // fallow-ignore-next-line unused-class-member
    recordTurnBoundary(key: string, session: IPersistedAssistantChatSession): void {
        const record = createSnapshotRecord(key, session);
        this.setPendingSnapshot(key, () => record, true);
    }

    // fallow-ignore-next-line unused-class-member
    archiveSession(key: string, reason: string): void {
        this.enqueueAfterSnapshots(key, async () => {
            if (reason === 'reset') {
                for (const archive of await this.readSessionArchives(key)) {
                    if (archive.reason !== 'reset') {
                        await rm(archive.filePath, {force: true});
                    }
                }
            }
            const sourcePath = this.sessionPath(key);
            if (!await this.pathExists(sourcePath)) {
                return;
            }
            await this.archiveSessionFile(sourcePath, reason);
            await pruneAssistantChatArchives(this.archiveDir, this.maxArchives, this.onError);
            await this.writeIndex();
            await this.pruneSnapshotBlobs();
        });
    }

    // fallow-ignore-next-line unused-class-member
    removeSession(key: string): void {
        this.enqueueAfterSnapshots(key, async () => {
            await rm(this.sessionPath(key), { force: true });
            await pruneAssistantChatArchives(this.archiveDir, this.maxArchives, this.onError);
            await this.writeIndex();
            await this.pruneSnapshotBlobs();
        });
    }

    // fallow-ignore-next-line unused-class-member
    flushForTests(): Promise<unknown[]> {
        return this.flushUntilIdle();
    }

    // fallow-ignore-next-line unused-class-member
    flush(): Promise<unknown[]> {
        return this.flushUntilIdle();
    }

    private enqueue(key: string, task: () => Promise<void>, requirePreviousSuccess = false): Promise<void> {
        const previous = requirePreviousSuccess ? this.writeOutcome : this.writeQueue;
        const next = previous.then(task).catch((error: unknown) => {
            const typedError = this.toPersistenceError(key, error);
            try {
                this.onError(`Failed to persist assistant chat session "${key}"`, typedError);
            } catch {
                // Error reporting cannot change the durable write outcome.
            }
            throw typedError;
        });
        this.writeOutcome = next;
        this.writeQueue = next.catch(() => undefined);
        this.queues.set(key, next);
        void next.then(() => undefined, () => undefined).finally(() => {
            if (this.queues.get(key) === next) {
                this.queues.delete(key);
            }
        });
        return next;
    }

    private setPendingSnapshot(
        key: string,
        takeSnapshot: () => TPersistedAssistantChatRecord,
        durable: boolean,
    ) {
        const existing = this.pendingSnapshots.get(key);
        if (existing?.timer) {
            clearTimeout(existing.timer);
        }
        const pending = existing ?? {
            ready: false,
            written: null,
            takeSnapshot,
            timer: null,
            failure: undefined,
        };
        pending.written = null;
        pending.takeSnapshot = takeSnapshot;
        pending.timer = null;
        pending.failure = undefined;
        if (durable || pending.ready) {
            pending.ready = true;
            this.pendingSnapshots.set(key, pending);
            this.schedulePendingSnapshot(key);
            return;
        }
        pending.timer = setTimeout(() => {
            pending.timer = null;
            pending.ready = true;
            this.schedulePendingSnapshot(key);
        }, this.snapshotDebounceMs);
        pending.timer.unref();
        this.pendingSnapshots.set(key, pending);
    }

    private forcePendingSnapshot(key: string, allowConcurrent = false, allowRetry = false) {
        const pending = this.pendingSnapshots.get(key);
        if (!pending) {
            return;
        }
        if (pending.timer) {
            clearTimeout(pending.timer);
            pending.timer = null;
        }
        pending.ready = true;
        if (allowRetry) {
            pending.failure = undefined;
        }
        this.schedulePendingSnapshot(key, allowConcurrent, allowRetry);
    }

    private schedulePendingSnapshot(key: string, allowConcurrent = false, allowRetry = false) {
        const pending = this.pendingSnapshots.get(key);
        const activeCount = this.activeSnapshotCounts.get(key) ?? 0;
        if (!pending?.ready || pending.failure && !allowRetry || activeCount > 0 && !allowConcurrent) {
            return;
        }
        this.activeSnapshotCounts.set(key, activeCount + 1);
        const record = pending.takeSnapshot();
        pending.written = record;
        const activeWrite = this.enqueue(key, async () => {
            const storageRecord = await this.appendRecord(key, record);
            await this.compactOversizedSession(key, storageRecord);
            await this.writeIndex(await this.pruneSessions());
            await this.pruneSnapshotBlobs();
        });
        void activeWrite.catch((error: unknown) => {
            const current = this.pendingSnapshots.get(key);
            if (current?.written === record) {
                current.failure = this.toPersistenceError(key, error);
                current.ready = true;
            }
        });
        void activeWrite.then(() => {
            const current = this.pendingSnapshots.get(key);
            if (current?.written === record) {
                this.pendingSnapshots.delete(key);
            }
        }, () => undefined).finally(() => {
            const remaining = (this.activeSnapshotCounts.get(key) ?? 1) - 1;
            if (remaining === 0) {
                this.activeSnapshotCounts.delete(key);
            } else {
                this.activeSnapshotCounts.set(key, remaining);
            }
            this.schedulePendingSnapshot(key);
        });
    }

    private enqueueAfterSnapshots(key: string, task: () => Promise<void>) {
        this.forcePendingSnapshot(key, true, true);
        void this.enqueue(key, task, true).catch(() => undefined);
    }

    private hasPendingPersistenceWork() {
        return this.queues.size > 0
            || this.pendingSnapshots.size > 0
            || this.activeSnapshotCounts.size > 0;
    }

    private async flushUntilIdle() {
        const results: unknown[] = [];
        for (;;) {
            for (const key of this.pendingSnapshots.keys()) {
                this.forcePendingSnapshot(key, false, true);
            }
            const pending = [
                ...this.queues.values(),
                this.writeQueue,
            ];
            const settled = await Promise.allSettled(pending);
            for (const result of settled) {
                if (result.status === 'fulfilled') {
                    results.push(result.value);
                }
            }
            const failure = settled.find((result): result is PromiseRejectedResult => result.status === 'rejected');
            if (failure) {
                throw failure.reason;
            }
            if (!this.hasPendingPersistenceWork()) {
                await this.writeQueue;
                if (!this.hasPendingPersistenceWork()) {
                    return results;
                }
            }
        }
    }

    private async appendRecord(key: string, record: TPersistedAssistantChatRecord) {
        await mkdir(this.sessionsDir, { recursive: true });
        const filePath = this.sessionPath(key);
        const storageRecord = await this.snapshotStorage.prepareRecordForStorage(record, key);
        await appendFile(filePath, `${JSON.stringify(storageRecord)}\n`, 'utf8');
        await fsyncFile(filePath);
        return storageRecord;
    }

    private toPersistenceError(key: string, error: unknown) {
        if (error instanceof AssistantChatPersistenceError) {
            return new AssistantChatPersistenceError(
                error.code,
                error.sessionKey,
                error.message,
                [...new Set([
                    ...error.pendingKeys,
                    ...this.pendingSnapshots.keys(),
                    key,
                ])],
                error,
            );
        }
        return new AssistantChatPersistenceError(
            'write-failed',
            key,
            `Assistant chat persistence failed for "${key}": ${getErrorMessage(error)}`,
            [...new Set([
                ...this.pendingSnapshots.keys(),
                key,
            ])],
            error,
        );
    }

    private async compactOversizedSession(
        key: string,
        latestStorageRecord: TPersistedAssistantChatRecord,
    ) {
        const filePath = this.sessionPath(key);
        if (latestStorageRecord.type === 'session-snapshot-ref') {
            await this.snapshotStorage.writeReference(filePath, latestStorageRecord);
            return;
        }
        let fileStat: Awaited<ReturnType<typeof stat>>;
        try {
            fileStat = await stat(filePath);
        } catch {
            return;
        }
        if (fileStat.size <= this.maxSessionBytes) {
            return;
        }

        let recovered: IRecoveredAssistantChatSessionFile | null;
        try {
            recovered = await this.recoverSessionFileAsync(filePath, key);
        } catch (error) {
            if (error instanceof AssistantChatPersistenceError) {
                throw error;
            }
            await this.quarantineCorruptSession(filePath);
            this.onError(`Quarantined corrupt assistant chat session "${key}" during compaction`, error);
            return;
        }
        if (!recovered) {
            await rm(filePath, { force: true });
            return;
        }
        await this.snapshotStorage.writeBoundedSnapshot(
            filePath,
            createPersistedSnapshotRecord(key, clonePersistedSession(recovered.session)),
            key,
        );
    }

    private async recoverSessionFileAsync(filePath: string, expectedKey?: string) {
        const contents = await this.readSessionContents(filePath, expectedKey ?? basename(filePath));
        return this.recoverSessionContents(filePath, expectedKey, contents);
    }

    private async readSessionContents(filePath: string, key: string) {
        try {
            return await readFile(filePath, 'utf8');
        } catch (error) {
            if (isErrnoException(error) && error.code === 'ENOENT') throw error;
            throw this.toPersistenceError(key, error);
        }
    }

    private recoverSessionContents(
        filePath: string,
        expectedKey: string | undefined,
        contents: string,
    ): IRecoveredAssistantChatSessionFile | null {
        let key: string | null = null;
        let lastSession: IPersistedAssistantChatSession | null = null;
        const lines = contents.split(/\r?\n/u);
        const lastContentLineIndex = lines.reduce(
            (lastIndex, line, index) => line.trim() ? index : lastIndex,
            -1,
        );
        for (const [
            lineIndex,
            rawLine,
        ] of lines.entries()) {
            const line = rawLine.trim();
            if (!line) {
                continue;
            }
            const record = parsePersistedRecord(line);
            if (!record) {
                if (
                    lineIndex === lines.length - 1
                    && !contents.endsWith('\n')
                    && key !== null
                    && lastSession !== null
                ) {
                    try {
                        this.snapshotStorage.writeBoundedSnapshotSync(
                            filePath,
                            createPersistedSnapshotRecord(key, clonePersistedSession(lastSession)),
                            key,
                        );
                    } catch (error) {
                        throw this.toPersistenceError(key, error);
                    }
                    break;
                }
                throw new Error('Assistant chat transcript contains a malformed persisted record.');
            }
            let resolvedSnapshot: {
                key: string;
                session: IPersistedAssistantChatSession
            } | null = null;
            if (record.type === 'session-snapshot-ref') {
                try {
                    resolvedSnapshot = this.snapshotStorage.readSnapshotBlobSync(record);
                } catch (error) {
                    if (lineIndex === lastContentLineIndex && key !== null && lastSession !== null) {
                        break;
                    }
                    throw error;
                }
            } else if (record.type === 'session-snapshot') {
                resolvedSnapshot = {
                    key: record.key,
                    session: record.session,
                };
            }
            const recordKey = resolvedSnapshot?.key ?? (record.type === 'session-reset' ? record.key : null);
            if (
                recordKey === null
                || (expectedKey !== undefined && recordKey !== expectedKey)
                || (key !== null && recordKey !== key)
            ) {
                throw new Error('Assistant chat transcript contains records for different session keys.');
            }
            key = recordKey;
            if (resolvedSnapshot) {
                lastSession = resolvedSnapshot.session;
            }
            if (record.type === 'session-reset') {
                lastSession = null;
            }
        }
        return key && lastSession
            ? {
                key,
                session: lastSession,
            }
            : null;
    }

    private async quarantineCorruptSession(filePath: string) {
        if (!await this.pathExists(filePath)) {
            return;
        }
        await this.archiveSessionFile(filePath, 'corrupt');
    }

    private async archiveSessionFile(filePath: string, reason: string) {
        await mkdir(this.archiveDir, {recursive: true});
        const name = basename(filePath, '.jsonl').replace(/\.(?:evicted|expired|reset|corrupt|scope-migrated)\.\d+\.[a-f0-9]+$/u, '');
        const archivedPath = join(
            this.archiveDir,
            `${name}.${reason}.${this.now()}.${randomSuffix()}.jsonl`,
        );
        if (reason === 'scope-backup') {
            await copyFile(filePath, archivedPath);
            await fsyncFile(archivedPath);
        } else {
            await rename(filePath, archivedPath);
        }
        await fsyncParentDirectory(filePath);
        await fsyncParentDirectory(archivedPath);
    }

    private async pruneSessions() {
        const entries = await this.readSessionIndexEntries();
        if (entries.length <= this.maxSessions) {
            return entries;
        }
        const removed = [...entries].sort((left, right) => left.lastAccessedAtMs - right.lastAccessedAtMs)
            .slice(0, entries.length - this.maxSessions);
        for (const entry of removed) {
            await this.archiveSessionFile(entry.filePath, 'evicted');
        }
        await pruneAssistantChatArchives(this.archiveDir, this.maxArchives, this.onError);
        return entries.filter(entry => !removed.includes(entry));
    }

    private async pruneSnapshotBlobs() {
        const blobs = await readdir(this.blobsDir, {withFileTypes: true}).catch((error: unknown) => {
            if (isErrnoException(error) && error.code === 'ENOENT') return [];
            throw error;
        });
        if (!blobs.some(entry => entry.isFile() && entry.name.endsWith('.json'))) return;
        await pruneAssistantChatSnapshotBlobs(
            [
                this.sessionsDir,
                this.archiveDir,
            ],
            this.blobsDir,
            parsePersistedRecord,
            this.onError,
        );
    }

    private async listSessionFiles() {
        let sessionEntries;
        try {
            sessionEntries = await readdir(this.sessionsDir, { withFileTypes: true });
        } catch (error) {
            if (isErrnoException(error) && error.code === 'ENOENT') {
                return [];
            }
            throw error;
        }
        return sessionEntries.flatMap((entry) => {
            const key = decodePersistenceSessionFileName(entry.name);
            return entry.isFile() && (key !== null || entry.name.endsWith('.jsonl'))
                ? [{
                    name: entry.name,
                    key,
                    filePath: join(this.sessionsDir, entry.name),
                }]
                : [];
        });
    }

    /** Recovers one session file, quarantining a corrupt one, and records its index metadata. */
    private async readSessionEntry(file: {
        name: string;
        key: string | null;
        filePath: string
    }) {
        await new Promise<void>(resolve => setImmediate(resolve));
        let recovered: IRecoveredAssistantChatSessionFile | null;
        try {
            recovered = await this.recoverSessionFileAsync(file.filePath, file.key ?? undefined);
        } catch (error) {
            if (!(error instanceof AssistantChatPersistenceError)) {
                try {
                    await this.quarantineCorruptSession(file.filePath);
                } catch (quarantineError) {
                    this.onError(`Failed to quarantine corrupt assistant chat session "${file.key ?? file.name}"`, quarantineError);
                }
            }
            this.onError(`Failed to recover assistant chat session "${file.key ?? file.name}"`, error);
            return null;
        }
        const fileStat = await stat(file.filePath, {bigint: true}).catch(() => null);
        if (!recovered || !fileStat) {
            return null;
        }
        const entry: IAssistantChatSessionEntry = {
            filePath: file.filePath,
            key: recovered.key,
            session: recovered.session,
            lastAccessedAtMs: recovered.session.lastAccessedAtMs,
            sizeBytes: Number(fileStat.size),
        };
        this.indexedSessionFiles.set(file.filePath, {
            identity: sessionFileIdentity(fileStat),
            filePath: entry.filePath,
            key: entry.key,
            lastAccessedAtMs: entry.lastAccessedAtMs,
            sizeBytes: entry.sizeBytes,
        });
        return entry;
    }

    private async readSessionEntries() {
        const entries: IAssistantChatSessionEntry[] = [];
        for (const file of await this.listSessionFiles()) {
            const entry = await this.readSessionEntry(file);
            if (entry) entries.push(entry);
        }
        return entries;
    }

    /**
     * The index's view of every retained session. A persisted snapshot
     * rewrites one transcript, so files whose identity is unchanged keep the
     * metadata they were recovered with; recovering all of them per snapshot
     * reread every retained transcript, 105 MB at 64 large sessions.
     */
    private async readSessionIndexEntries() {
        const files = await this.listSessionFiles();
        const listed = new Set(files.map(file => file.filePath));
        for (const filePath of this.indexedSessionFiles.keys()) {
            if (!listed.has(filePath)) this.indexedSessionFiles.delete(filePath);
        }
        const entries: TAssistantChatSessionIndexEntry[] = [];
        for (const file of files) {
            const fileStat = await stat(file.filePath, {bigint: true}).catch(() => null);
            const indexed = this.indexedSessionFiles.get(file.filePath);
            const entry = fileStat && indexed?.identity === sessionFileIdentity(fileStat)
                ? indexed
                : await this.readSessionEntry(file);
            if (entry) entries.push(entry);
        }
        return entries;
    }

    private async pruneRecoveredSessionsAsync(recovered: IRecoveredAssistantChatSession[]) {
        if (recovered.length <= this.maxSessions) {
            return;
        }
        const removable = [...recovered].sort((left, right) => left.session.lastAccessedAtMs - right.session.lastAccessedAtMs);
        for (const entry of removable.slice(0, recovered.length - this.maxSessions)) {
            try {
                await this.archiveSessionFile(entry.filePath, 'evicted');
                recovered.splice(recovered.indexOf(entry), 1);
            } catch (error) {
                this.onError(`Failed to prune recovered assistant chat session "${entry.key}"`, error);
            }
        }
        await this.writeIndex();
    }

    private async writeIndex(entries?: readonly TAssistantChatSessionIndexEntry[]) {
        const sessions = entries ?? await this.readSessionEntries();
        await atomicWriteJsonFile(this.indexPath, {
            schemaVersion: ASSISTANT_CHAT_PERSISTENCE_SCHEMA_VERSION,
            sessions: sessions.map(entry => ({
                key: entry.key,
                file: basename(entry.filePath),
                lastAccessedAtMs: entry.lastAccessedAtMs,
                sizeBytes: entry.sizeBytes,
            })),
        });
    }

    private async pathExists(filePath: string) {
        try {
            await stat(filePath);
            return true;
        } catch (error) {
            if (isErrnoException(error) && error.code === 'ENOENT') {
                return false;
            }
            throw error;
        }
    }
}
