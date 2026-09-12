import {
    createHash,
    randomBytes,
} from 'node:crypto';
import {
    closeSync,
    constants as fsConstants,
    existsSync,
    fsyncSync,
    mkdirSync,
    openSync,
    readdirSync,
    readFileSync,
    renameSync,
    statSync,
    unlinkSync,
    writeFileSync,
} from 'fs';
import {
    appendFile,
    mkdir,
    open,
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
    IAgentAssistantChatMessage,
    IAgentAssistantChatScope,
    TAgentWorkspaceCommandTarget,
    TAgentAssistantEffort,
    TAgentAssistantProviderId,
    TAgentAssistantSpeedMode,
} from '@contracts/agent';
import { isErrnoException } from '@contracts/runtimeGuards';
import { isDocumentRevisionInfo } from '@contracts/documentRevision';
import {parseDocumentRef} from '@contracts/documentRef';
import {
    isEpochMs,
    parseIsoTimestamp,
} from '@contracts/timestamps';
import {parseTabId} from '@contracts/windowTabs';
import { createLogger } from '@electron/utils/createLogger';
import { getErrorMessage } from '@electron/utils/error';
import {
    type IAssistantSessionScopeBinding,
    type TAssistantTurnOwnerState,
    isAssistantTurnActive,
} from '@electron/features/agent/assistantTurnLifecycle';
import {fsyncParentDirectory} from '@electron/utils/atomicReplace';
import {AssistantChatSnapshotStorage} from '@electron/features/agent/assistantChatSnapshotStorage';
import {
    pruneAssistantChatSnapshotBlobs,
    pruneAssistantChatSnapshotBlobsSync,
} from '@electron/features/agent/assistantChatSnapshotBlobMaintenance';
import {
    pruneAssistantChatArchives,
    pruneAssistantChatArchivesSync,
} from '@electron/features/agent/pruneAssistantChatArchives';

const ASSISTANT_CHAT_PERSISTENCE_SCHEMA_VERSION = 1;
const ASSISTANT_CHAT_STORAGE_DIR = 'assistant-chat';
const ASSISTANT_CHAT_SESSION_DIR = 'sessions';
const ASSISTANT_CHAT_ARCHIVE_DIR = 'archive';
const ASSISTANT_CHAT_SESSION_FILE_PREFIX = 'v2-';
const ASSISTANT_CHAT_SNAPSHOT_BLOB_DIR = 'blobs';
const DEFAULT_ASSISTANT_CHAT_MAX_SESSION_BYTES = 2 * 1024 * 1024;
const DEFAULT_ASSISTANT_CHAT_MAX_SESSIONS = 64;
const DEFAULT_ASSISTANT_CHAT_MAX_ARCHIVES = 128;
const DEFAULT_ASSISTANT_CHAT_SNAPSHOT_DEBOUNCE_MS = 300;
const ASSISTANT_CHAT_INTERRUPTED_ERROR = 'Assistant turn interrupted because EVB Viewer closed before it completed.';

const logger = createLogger('assistant-chat-persistence');

export interface IPersistedAssistantChatSession {
    provider: TAgentAssistantProviderId;
    scope: IAgentAssistantChatScope;
    model: string;
    effort: TAgentAssistantEffort;
    speedMode: TAgentAssistantSpeedMode;
    providerThreadId: string | null;
    lastSenderWindowId: number | null;
    turnOwner: TAssistantTurnOwnerState;
    scopeBinding: IAssistantSessionScopeBinding | null;
    messages: IAgentAssistantChatMessage[];
    lastAccessedAtMs: number;
    lastError?: string;
}

interface IAssistantChatPersistenceSession {
    provider: TAgentAssistantProviderId;
    scope: IAgentAssistantChatScope;
    model: string;
    effort: TAgentAssistantEffort;
    speedMode: TAgentAssistantSpeedMode;
    providerThreadId: string | null;
    lastSenderWindowId: number | null;
    turnOwner: TAssistantTurnOwnerState;
    scopeBinding: IAssistantSessionScopeBinding | null;
    messages: IAgentAssistantChatMessage[];
    lastAccessedAtMs: number;
    lastError?: string;
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
    session: IPersistedAssistantChatSession;
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

export function readBoundedIntegerEnv(name: string, fallback: number, minimum: number, maximum?: number) {
    const parsed = Number.parseInt(process.env[name] ?? `${fallback}`, 10);
    if (!Number.isFinite(parsed) || parsed < minimum) {
        return fallback;
    }
    return maximum === undefined ? parsed : Math.min(parsed, maximum);
}

function readAssistantChatMaxSessionBytes() {
    return readBoundedIntegerEnv(
        'EVB_ASSISTANT_CHAT_MAX_SESSION_BYTES',
        DEFAULT_ASSISTANT_CHAT_MAX_SESSION_BYTES,
        64 * 1024,
        128 * 1024 * 1024,
    );
}

function readAssistantChatMaxSessions() {
    return readBoundedIntegerEnv(
        'EVB_ASSISTANT_CHAT_MAX_SESSIONS',
        DEFAULT_ASSISTANT_CHAT_MAX_SESSIONS,
        1,
        512,
    );
}

function readAssistantChatMaxArchives() {
    return readBoundedIntegerEnv(
        'EVB_ASSISTANT_CHAT_MAX_ARCHIVES',
        DEFAULT_ASSISTANT_CHAT_MAX_ARCHIVES,
        1,
        4_096,
    );
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

function safeCloseSync(fd: number | null) {
    if (fd === null) {
        return;
    }

    try {
        closeSync(fd);
    } catch {
        // best effort
    }
}

function fsyncParentDirectorySync(filePath: string) {
    if (process.platform === 'win32') {
        return;
    }

    let fd: number | null = null;
    try {
        fd = openSync(dirname(filePath), fsConstants.O_RDONLY);
        fsyncSyncBestEffort(fd);
    } catch {
        return;
    } finally {
        safeCloseSync(fd);
    }
}

function fsyncSyncBestEffort(fd: number) {
    try {
        fsyncSync(fd);
    } catch {
        // best effort
    }
}

async function atomicWriteJsonFile(filePath: string, payload: unknown) {
    await mkdir(dirname(filePath), { recursive: true });
    const tempPath = join(dirname(filePath), `.${basename(filePath)}.${randomSuffix()}.tmp`);
    await writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    const handle = await open(tempPath, 'r');
    try {
        await handle.sync();
    } finally {
        await handle.close();
    }
    await rename(tempPath, filePath);
    await fsyncParentDirectory(filePath);
}

function atomicWriteJsonFileSync(filePath: string, payload: unknown) {
    mkdirSync(dirname(filePath), { recursive: true });
    const tempPath = join(dirname(filePath), `.${basename(filePath)}.${randomSuffix()}.tmp`);
    writeFileSync(tempPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    let fd: number | null = null;
    try {
        fd = openSync(tempPath, 'r');
        fsyncSyncBestEffort(fd);
    } finally {
        safeCloseSync(fd);
    }
    renameSync(tempPath, filePath);
    fsyncParentDirectorySync(filePath);
}

function clonePersistedSession(session: IAssistantChatPersistenceSession): IPersistedAssistantChatSession {
    return {
        provider: session.provider,
        scope: {...session.scope},
        model: session.model,
        effort: session.effort,
        speedMode: session.speedMode,
        providerThreadId: session.providerThreadId,
        lastSenderWindowId: session.lastSenderWindowId,
        turnOwner: {...session.turnOwner},
        scopeBinding: session.scopeBinding ? {...session.scopeBinding} : null,
        messages: session.messages.map((message: IAgentAssistantChatMessage): IAgentAssistantChatMessage => {
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
        && isEpochMs(value.timestamp);
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

function isAssistantChatMessage(value: unknown): value is IAgentAssistantChatMessage {
    return isObject(value)
        && typeof value.id === 'string'
        && (value.role === 'user' || value.role === 'assistant' || value.role === 'system')
        && typeof value.text === 'string'
        && parseIsoTimestamp(value.createdAt) !== null
        && (
            value.attachments === undefined
            || Array.isArray(value.attachments) && value.attachments.every(isAssistantImageAttachment)
        )
        && (value.pending === undefined || typeof value.pending === 'boolean')
        && (value.error === undefined || typeof value.error === 'string')
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
        && isAssistantChatScope(value.scope)
        && typeof value.model === 'string'
        && typeof value.effort === 'string'
        && (value.speedMode === 'fast' || value.speedMode === 'standard')
        && (typeof value.providerThreadId === 'string' || value.providerThreadId === null)
        && (isNonNegativeInteger(value.lastSenderWindowId) || value.lastSenderWindowId === null)
        && isAssistantTurnOwner(value.turnOwner)
        && (value.scopeBinding === null || isAssistantSessionScopeBinding(value.scopeBinding))
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
        && parsed.sizeBytes >= 0
        && parsed.sizeBytes > 0
    ) {
        return parsed as TPersistedAssistantChatRecord;
    }
    return null;
}

function interruptRecoveredSession(session: IPersistedAssistantChatSession): IPersistedAssistantChatSession {
    if (!isAssistantTurnActive(session.turnOwner)) {
        return session;
    }

    session.turnOwner = {
        phase: 'error',
        generation: session.turnOwner.generation,
        turnId: null,
        localTurnId: null,
        error: ASSISTANT_CHAT_INTERRUPTED_ERROR,
    };
    session.scopeBinding = null;
    session.lastError = ASSISTANT_CHAT_INTERRUPTED_ERROR;
    for (const message of session.messages) {
        if (message.role === 'assistant' && message.pending) {
            message.pending = false;
            message.error = message.error ?? ASSISTANT_CHAT_INTERRUPTED_ERROR;
        }
    }
    return session;
}

function createSnapshotRecord(
    key: string,
    session: IAssistantChatPersistenceSession,
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
    private writeQueue: Promise<void> = Promise.resolve();
    private writeOutcome: Promise<void> = Promise.resolve();
    private maintenanceQueue: Promise<void> = Promise.resolve();

    constructor(options: IAssistantChatPersistenceOptions = {}) {
        this.rootDir = options.rootDir ?? getDefaultAssistantChatPersistenceRoot();
        this.sessionsDir = join(this.rootDir, ASSISTANT_CHAT_SESSION_DIR);
        this.archiveDir = join(this.rootDir, ASSISTANT_CHAT_ARCHIVE_DIR);
        this.blobsDir = join(this.rootDir, ASSISTANT_CHAT_SNAPSHOT_BLOB_DIR);
        this.indexPath = join(this.rootDir, 'index.json');
        this.maxSessionBytes = options.maxSessionBytes ?? readAssistantChatMaxSessionBytes();
        this.maxSessions = options.maxSessions ?? readAssistantChatMaxSessions();
        this.maxArchives = options.maxArchives ?? readAssistantChatMaxArchives();
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

    // fallow-ignore-next-line unused-class-member
    recoverSessions(): IRecoveredAssistantChatSession[] {
        const recovered: IRecoveredAssistantChatSession[] = [];
        if (!existsSync(this.sessionsDir)) {
            return recovered;
        }

        for (const entry of readdirSync(this.sessionsDir, { withFileTypes: true })) {
            if (!entry.isFile()) {
                continue;
            }
            const key = decodePersistenceSessionFileName(entry.name);
            if (key === null && !entry.name.endsWith('.jsonl')) {
                continue;
            }
            const filePath = join(this.sessionsDir, entry.name);
            try {
                const recoveredFile = this.recoverSessionFile(filePath, key ?? undefined);
                if (!recoveredFile) {
                    continue;
                }
                recovered.push({
                    key: recoveredFile.key,
                    session: interruptRecoveredSession(recoveredFile.session),
                    filePath,
                    sizeBytes: statSync(filePath).size,
                });
            } catch (error) {
                try {
                    this.quarantineCorruptSessionSync(filePath);
                } catch (quarantineError) {
                    this.onError(`Failed to quarantine corrupt assistant chat session "${key ?? entry.name}"`, quarantineError);
                }
                this.onError(`Failed to recover assistant chat session "${key ?? entry.name}"`, error);
            }
        }
        this.pruneRecoveredSessionsSync(recovered);
        pruneAssistantChatArchivesSync(this.archiveDir, this.maxArchives, this.onError);
        this.pruneSnapshotBlobsSync();
        return recovered;
    }

    // fallow-ignore-next-line unused-class-member
    recordSessionSnapshot(key: string, session: IAssistantChatPersistenceSession): void {
        const record = createSnapshotRecord(key, session);
        this.setPendingSnapshot(key, () => record, false);
    }

    // fallow-ignore-next-line unused-class-member
    recordAssistantDelta(key: string, session: IAssistantChatPersistenceSession): void {
        this.setPendingSnapshot(key, () => createSnapshotRecord(key, session), false);
    }

    // fallow-ignore-next-line unused-class-member
    recordTurnBoundary(key: string, session: IAssistantChatPersistenceSession): void {
        const record = createSnapshotRecord(key, session);
        this.setPendingSnapshot(key, () => record, true);
    }

    // fallow-ignore-next-line unused-class-member
    archiveSession(key: string, reason: string): void {
        this.enqueueAfterSnapshots(key, async () => {
            const sourcePath = this.sessionPath(key);
            if (!await this.pathExists(sourcePath)) {
                return;
            }
            await mkdir(this.archiveDir, { recursive: true });
            const archivedPath = join(
                this.archiveDir,
                `${basename(sourcePath, '.jsonl')}.${reason}.${this.now()}.${randomSuffix()}.jsonl`,
            );
            await rename(sourcePath, archivedPath);
            await fsyncParentDirectory(sourcePath);
            await this.runMaintenance(async () => {
                await pruneAssistantChatArchives(this.archiveDir, this.maxArchives, this.onError);
                await this.writeIndex();
                await this.pruneSnapshotBlobs();
            });
        });
    }

    // fallow-ignore-next-line unused-class-member
    removeSession(key: string): void {
        this.enqueueAfterSnapshots(key, async () => {
            await rm(this.sessionPath(key), { force: true });
            await this.runMaintenance(async () => {
                await pruneAssistantChatArchives(this.archiveDir, this.maxArchives, this.onError);
                await this.writeIndex();
                await this.pruneSnapshotBlobs();
            });
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
            await this.runMaintenance(async () => {
                await this.compactOversizedSession(key, storageRecord);
                await this.pruneSessions();
                await this.writeIndex();
                await this.pruneSnapshotBlobs();
            });
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

    private async runMaintenance(task: () => Promise<void>) {
        const next = this.maintenanceQueue.catch(() => undefined).then(task);
        this.maintenanceQueue = next.catch(() => undefined);
        await next;
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
                this.maintenanceQueue,
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
                await this.maintenanceQueue;
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
        const handle = await open(filePath, 'r');
        try {
            await handle.sync();
        } finally {
            await handle.close();
        }
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
            recovered = this.recoverSessionFile(filePath, key);
        } catch (error) {
            this.quarantineCorruptSessionSync(filePath);
            this.onError(`Quarantined corrupt assistant chat session "${key}" during compaction`, error);
            return;
        }
        if (!recovered) {
            await rm(filePath, { force: true });
            return;
        }
        await this.snapshotStorage.writeBoundedSnapshot(
            filePath,
            createPersistedSnapshotRecord(key, recovered.session),
            key,
        );
    }

    private recoverSessionFile(filePath: string, expectedKey?: string): IRecoveredAssistantChatSessionFile | null {
        let key: string | null = null;
        let lastSession: IPersistedAssistantChatSession | null = null;
        const contents = readFileSync(filePath, 'utf8');
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
                    this.snapshotStorage.writeBoundedSnapshotSync(
                        filePath,
                        createPersistedSnapshotRecord(key, lastSession),
                        key,
                    );
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

    private quarantineCorruptSessionSync(filePath: string) {
        if (!existsSync(filePath)) {
            return;
        }
        mkdirSync(this.archiveDir, {recursive: true});
        const archivedPath = join(
            this.archiveDir,
            `${basename(filePath, '.jsonl')}.corrupt.${this.now()}.${randomSuffix()}.jsonl`,
        );
        renameSync(filePath, archivedPath);
        fsyncParentDirectorySync(filePath);
        fsyncParentDirectorySync(archivedPath);
    }

    private async pruneSessions() {
        let entries = await this.readSessionEntries();
        if (entries.length <= this.maxSessions) {
            return;
        }
        entries = entries.sort((left, right) => left.lastAccessedAtMs - right.lastAccessedAtMs);
        const removeCount = entries.length - this.maxSessions;
        for (const entry of entries.slice(0, removeCount)) {
            await rm(entry.filePath, { force: true });
        }
        await this.writeIndex();
    }

    private async pruneSnapshotBlobs() {
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

    private pruneSnapshotBlobsSync() {
        pruneAssistantChatSnapshotBlobsSync(
            [
                this.sessionsDir,
                this.archiveDir,
            ],
            this.blobsDir,
            parsePersistedRecord,
            this.onError,
        );
    }

    private pruneRecoveredSessionsSync(recovered: IRecoveredAssistantChatSession[]) {
        if (recovered.length <= this.maxSessions) {
            return;
        }
        const removable = [...recovered].sort((left, right) => left.session.lastAccessedAtMs - right.session.lastAccessedAtMs);
        for (const entry of removable.slice(0, recovered.length - this.maxSessions)) {
            try {
                unlinkSync(entry.filePath);
                recovered.splice(recovered.indexOf(entry), 1);
            } catch (error) {
                this.onError(`Failed to prune recovered assistant chat session "${entry.key}"`, error);
            }
        }
        this.writeIndexSync();
    }

    private async readSessionEntries() {
        const entries: Array<{
            filePath: string;
            key: string;
            lastAccessedAtMs: number;
            sizeBytes: number;
        }> = [];
        let sessionEntries;
        try {
            sessionEntries = await readdir(this.sessionsDir, { withFileTypes: true });
        } catch (error) {
            if (isErrnoException(error) && error.code === 'ENOENT') {
                return entries;
            }
            throw error;
        }
        for (const entry of sessionEntries) {
            if (!entry.isFile()) {
                continue;
            }
            const key = decodePersistenceSessionFileName(entry.name);
            if (key === null && !entry.name.endsWith('.jsonl')) {
                continue;
            }
            const filePath = join(this.sessionsDir, entry.name);
            let recovered: IRecoveredAssistantChatSessionFile | null;
            try {
                recovered = this.recoverSessionFile(filePath, key ?? undefined);
            } catch (error) {
                this.quarantineCorruptSessionSync(filePath);
                this.onError(`Quarantined corrupt assistant chat session "${key ?? entry.name}" during maintenance`, error);
                continue;
            }
            const fileStat = await stat(filePath).catch(() => null);
            if (!recovered || !fileStat) {
                continue;
            }
            entries.push({
                filePath,
                key: recovered.key,
                lastAccessedAtMs: recovered.session.lastAccessedAtMs,
                sizeBytes: fileStat.size,
            });
        }
        return entries;
    }

    private async writeIndex() {
        await atomicWriteJsonFile(this.indexPath, {
            schemaVersion: ASSISTANT_CHAT_PERSISTENCE_SCHEMA_VERSION,
            sessions: (await this.readSessionEntries()).map(entry => ({
                key: entry.key,
                file: basename(entry.filePath),
                lastAccessedAtMs: entry.lastAccessedAtMs,
                sizeBytes: entry.sizeBytes,
            })),
        });
    }

    private writeIndexSync() {
        const sessions: Array<{
            key: string;
            file: string;
            lastAccessedAtMs: number;
            sizeBytes: number;
        }> = [];
        for (const entry of readdirSync(this.sessionsDir, { withFileTypes: true })) {
            if (!entry.isFile()) {
                continue;
            }
            const key = decodePersistenceSessionFileName(entry.name);
            if (key === null && !entry.name.endsWith('.jsonl')) {
                continue;
            }
            const filePath = join(this.sessionsDir, entry.name);
            const recovered = this.recoverSessionFile(filePath, key ?? undefined);
            if (!recovered) {
                continue;
            }
            sessions.push({
                key: recovered.key,
                file: entry.name,
                lastAccessedAtMs: recovered.session.lastAccessedAtMs,
                sizeBytes: statSync(filePath).size,
            });
        }
        atomicWriteJsonFileSync(this.indexPath, {
            schemaVersion: ASSISTANT_CHAT_PERSISTENCE_SCHEMA_VERSION,
            sessions,
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
