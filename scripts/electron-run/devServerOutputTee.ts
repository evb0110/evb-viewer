import {
    appendFileSync,
    closeSync,
    fstatSync,
    ftruncateSync,
    mkdirSync,
    openSync,
    readFileSync,
    writeFileSync,
    writeSync,
} from 'node:fs';
import {
    isAbsolute,
    join,
    relative,
} from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { projectRoot } from '@scripts/electron-run/projectRoot';
import {
    getCurrentSessionName,
    sessionDir,
    sessionLogFilePath,
    validateSessionName,
} from '@scripts/electron-run/electronRunSessionPaths';
import {
    type IDevServerOutputRetentionPolicy,
    pruneDevServerOutputRuns,
    resolveDevServerOutputRetentionPolicy,
} from '@scripts/electron-run/devServerOutputRetention';

export const DEV_OUTPUT_TEE_DIR_ENV = 'EVB_DEV_OUTPUT_TEE_DIR';
export const DEV_OUTPUT_TEE_DISABLED_ENV = 'EVB_DEV_OUTPUT_TEE_DISABLED';
export const DEV_OUTPUT_TEE_STABLE_LOG_DISABLED_ENV = 'EVB_DEV_OUTPUT_TEE_STABLE_LOG_DISABLED';
export const devServerOutputTeeBaseDir = join(projectRoot, '.devkit', 'scratch', 'dev-server-logs');
export const DEV_OUTPUT_TEE_TRUNCATION_MARKER = '\n[EVB dev output truncated at file size limit]\n';

type TOutputStreamName = 'stdout' | 'stderr';
type TOutputChunk = string | Uint8Array;

interface ICreateDevServerOutputTeeOptions {
    sessionName?: string;
    runDir?: string;
    baseDir?: string;
    env?: NodeJS.ProcessEnv;
    now?: Date;
    pid?: number;
    metadataFileName?: string;
    owner?: string;
    sessionArtifactsDir?: string;
    retentionPolicy?: Partial<IDevServerOutputRetentionPolicy>;
}

export interface IDevServerLogManifest {
    readonly schemaVersion: 1;
    readonly createdAt: string;
    readonly sessionName: string;
    readonly runDir: string;
    readonly relativeRunDir: string;
    readonly sessionLogFile: string;
    readonly runCombinedLogFile: string;
    readonly sourceStems: readonly string[];
}

export interface IDevServerOutputTee {
    readonly runDir: string;
    readonly relativeRunDir: string;
    readonly sessionName: string;
    readonly logManifestFile: string;
    readonly sessionLogFile: string;
    readonly runCombinedLogFile: string;
    write(source: string, stream: TOutputStreamName, chunk: TOutputChunk, options?: ITeeWriteOptions): void;
    writeLine(source: string, stream: TOutputStreamName, line: string): void;
    installProcessStreamTee(source?: string): void;
    close(): void;
}

/**
 * `aggregate: false` keeps the chunk in its per-source files only. Raw Electron
 * and Nuxt output use this: the launcher prints a formatted line for it, and
 * that line is what the session log should contain.
 */
export interface ITeeWriteOptions {readonly aggregate?: boolean;}

let activeTee: DevServerOutputTee | null = null;
const openTeeRunDirs = new Set<string>();

function isTruthyEnvValue(value: string | undefined) {
    return value === '1' || value?.toLowerCase() === 'true' || value?.toLowerCase() === 'yes';
}

export function formatDevServerOutputTeeTimestamp(date = new Date()) {
    return date.toISOString().replace(/[:.]/gu, '-');
}

export function sanitizeDevServerOutputFileStem(value: string) {
    const sanitized = value
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/gu, '-')
        .replace(/^-+|-+$/gu, '');
    if (!sanitized || sanitized === '.' || sanitized === '..') {
        throw new Error(`Invalid dev output tee file stem: ${value}`);
    }
    return sanitized;
}

function resolveRunDir(options: Required<Pick<ICreateDevServerOutputTeeOptions, 'env' | 'now' | 'pid' | 'baseDir' | 'sessionName'>> & Pick<ICreateDevServerOutputTeeOptions, 'runDir'>) {
    const configuredRunDir = options.runDir ?? options.env[DEV_OUTPUT_TEE_DIR_ENV];
    if (configuredRunDir) {
        return isAbsolute(configuredRunDir)
            ? configuredRunDir
            : join(projectRoot, configuredRunDir);
    }

    return join(
        options.baseDir,
        options.sessionName,
        `${formatDevServerOutputTeeTimestamp(options.now)}-pid-${options.pid}`,
    );
}

function toBuffer(chunk: TOutputChunk) {
    return typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk);
}

function writeJsonFile(filePath: string, value: unknown) {
    writeFileSync(filePath, `${JSON.stringify(value, null, 4)}\n`);
}

function readLogManifest(filePath: string): IDevServerLogManifest | null {
    try {
        const value = JSON.parse(readFileSync(filePath, 'utf8')) as Partial<IDevServerLogManifest>;
        if (
            value.schemaVersion !== 1
            || typeof value.runDir !== 'string'
            || !Array.isArray(value.sourceStems)
        ) {
            return null;
        }
        return value as IDevServerLogManifest;
    } catch {
        return null;
    }
}

function createRelativeRunDir(runDir: string) {
    const relativePath = relative(projectRoot, runDir);
    return relativePath && !relativePath.startsWith('..') ? relativePath : runDir;
}

function writeLatestRunPointers(options: {
    baseDir: string;
    createdAt: string;
    runDir: string;
    relativeRunDir: string;
    sessionName: string;
}) {
    const payload = {
        schemaVersion: 1,
        createdAt: options.createdAt,
        sessionName: options.sessionName,
        runDir: options.runDir,
        relativeRunDir: options.relativeRunDir,
    };

    mkdirSync(options.baseDir, { recursive: true });
    writeJsonFile(join(options.baseDir, 'latest-run.json'), payload);

    const sessionPointerDir = join(options.baseDir, options.sessionName);
    mkdirSync(sessionPointerDir, { recursive: true });
    writeJsonFile(join(sessionPointerDir, 'latest-run.json'), payload);
}

class DevServerOutputTee implements IDevServerOutputTee {
    readonly runDir: string;
    readonly relativeRunDir: string;
    readonly sessionName: string;
    readonly logManifestFile: string;
    readonly sessionLogFile: string;
    readonly runCombinedLogFile: string;

    private readonly baseDir: string;
    private readonly descriptor: {
        schemaVersion: number;
        owner: string;
        createdAt: string;
        pid: number;
        sessionName: string;
        runDir: string;
        relativeRunDir: string;
    };
    private readonly fileDescriptors = new Map<string, {
        bytesWritten: number;
        fd: number;
        truncated: boolean;
    }>();
    private readonly metadataFilePath: string;
    private readonly retentionPolicy: IDevServerOutputRetentionPolicy;
    private readonly sourceStems = new Set<string>();
    private readonly stableLogEnabled: boolean;
    private readonly restoreProcessStreams: Array<() => void> = [];
    /** Unterminated line tails per `stem:stream`, so prefixes land on whole lines. */
    private readonly partialLines = new Map<string, string>();
    private closed = false;

    constructor(options: Required<ICreateDevServerOutputTeeOptions>) {
        this.baseDir = options.baseDir;
        this.sessionName = validateSessionName(options.sessionName);
        this.runDir = resolveRunDir({
            env: options.env,
            now: options.now,
            pid: options.pid,
            baseDir: options.baseDir,
            sessionName: this.sessionName,
            ...(options.runDir ? { runDir: options.runDir } : {}),
        });
        this.relativeRunDir = createRelativeRunDir(this.runDir);
        const sessionArtifactsDir = options.sessionArtifactsDir || sessionDir(this.sessionName);
        this.logManifestFile = join(sessionArtifactsDir, 'logs.json');
        this.sessionLogFile = options.sessionArtifactsDir
            ? join(sessionArtifactsDir, 'session.log')
            : sessionLogFilePath(this.sessionName);
        this.runCombinedLogFile = join(this.runDir, 'session.combined.log');
        this.stableLogEnabled = !isTruthyEnvValue(options.env[DEV_OUTPUT_TEE_STABLE_LOG_DISABLED_ENV]);
        const retentionPolicy = resolveDevServerOutputRetentionPolicy(options.retentionPolicy);
        this.retentionPolicy = {
            ...retentionPolicy,
            maxFileBytes: Math.max(
                Buffer.byteLength(DEV_OUTPUT_TEE_TRUNCATION_MARKER),
                retentionPolicy.maxFileBytes,
            ),
        };
        mkdirSync(this.runDir, { recursive: true });
        mkdirSync(sessionArtifactsDir, { recursive: true });
        openTeeRunDirs.add(this.runDir);

        const createdAt = options.now.toISOString();
        const previousManifest = readLogManifest(this.logManifestFile);
        if (previousManifest?.runDir === this.runDir) {
            for (const stem of previousManifest.sourceStems) {
                if (typeof stem === 'string') this.sourceStems.add(stem);
            }
        } else if (this.stableLogEnabled) {
            writeFileSync(this.sessionLogFile, '');
        }
        writeLatestRunPointers({
            baseDir: options.baseDir,
            createdAt,
            runDir: this.runDir,
            relativeRunDir: this.relativeRunDir,
            sessionName: this.sessionName,
        });
        this.metadataFilePath = join(this.runDir, options.metadataFileName);
        this.descriptor = {
            schemaVersion: 1,
            owner: options.owner,
            createdAt,
            pid: options.pid,
            sessionName: this.sessionName,
            runDir: this.runDir,
            relativeRunDir: this.relativeRunDir,
        };
        writeJsonFile(this.metadataFilePath, this.descriptor);
        this.writeLogManifest(createdAt);
        this.pruneCompletedRuns(options.now);
    }

    write(source: string, stream: TOutputStreamName, chunk: TOutputChunk, options: ITeeWriteOptions = {}) {
        if (this.closed) {
            return;
        }

        const stem = sanitizeDevServerOutputFileStem(source);
        if (!this.sourceStems.has(stem)) {
            this.sourceStems.add(stem);
            this.writeLogManifest(this.descriptor.createdAt);
        }
        const buffer = toBuffer(chunk);
        this.writeFile(`${stem}.${stream}.log`, buffer);
        const key = `${stem}:${stream}`;
        const text = (this.partialLines.get(key) ?? '') + stripVTControlCharacters(buffer.toString('utf8'));
        const lastNewline = text.lastIndexOf('\n');
        if (lastNewline === -1) {
            this.partialLines.set(key, text);
            return;
        }
        this.partialLines.set(key, text.slice(lastNewline + 1));
        this.writeCombinedLines(stem, stream, text.slice(0, lastNewline + 1), options.aggregate !== false);
    }

    writeLine(source: string, stream: TOutputStreamName, line: string) {
        this.write(source, stream, `${line}\n`);
    }

    installProcessStreamTee(source = 'electron-run-launcher') {
        if (this.closed || this.restoreProcessStreams.length > 0) {
            return;
        }

        this.restoreProcessStreams.push(
            this.patchWriteStream(process.stdout, chunk => this.write(source, 'stdout', chunk)),
            this.patchWriteStream(process.stderr, chunk => this.write(source, 'stderr', chunk)),
        );
    }

    close() {
        if (this.closed) {
            return;
        }

        for (const [
            key,
            tail,
        ] of this.partialLines) {
            if (tail.length > 0) {
                const separator = key.lastIndexOf(':');
                this.writeCombinedLines(
                    key.slice(0, separator),
                    key.slice(separator + 1) as TOutputStreamName,
                    `${tail}\n`,
                    true,
                );
            }
        }
        this.partialLines.clear();
        this.closed = true;
        for (const restore of this.restoreProcessStreams.splice(0).reverse()) {
            restore();
        }
        for (const state of this.fileDescriptors.values()) {
            try {
                closeSync(state.fd);
            } catch {}
        }
        this.fileDescriptors.clear();
        try {
            writeJsonFile(this.metadataFilePath, {
                ...this.descriptor,
                closedAt: new Date().toISOString(),
            });
        } catch {}
        this.pruneCompletedRuns();
        openTeeRunDirs.delete(this.runDir);
    }

    private patchWriteStream(
        stream: NodeJS.WriteStream,
        record: (chunk: TOutputChunk) => void,
    ) {
        const originalWrite = stream.write.bind(stream);
        stream.write = (chunk: TOutputChunk, encoding?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void) => {
            try {
                record(chunk);
            } catch {}

            if (typeof encoding === 'function') {
                return originalWrite(chunk, encoding);
            }
            return originalWrite(chunk, encoding, callback);
        };

        return () => {
            stream.write = originalWrite;
        };
    }

    private openFile(fileName: string) {
        const existing = this.fileDescriptors.get(fileName);
        if (existing !== undefined) {
            return existing;
        }

        const fd = openSync(join(this.runDir, fileName), 'a');
        const bytesWritten = fstatSync(fd).size;
        const contentLimit = Math.max(0, this.retentionPolicy.maxFileBytes - Buffer.byteLength(DEV_OUTPUT_TEE_TRUNCATION_MARKER));
        const state = {
            bytesWritten,
            fd,
            truncated: false,
        };
        if (bytesWritten > contentLimit) {
            ftruncateSync(fd, contentLimit);
            writeSync(fd, DEV_OUTPUT_TEE_TRUNCATION_MARKER);
            state.bytesWritten = contentLimit + Buffer.byteLength(DEV_OUTPUT_TEE_TRUNCATION_MARKER);
            state.truncated = true;
        }
        this.fileDescriptors.set(fileName, state);
        return state;
    }

    private writeFile(fileName: string, buffer: Buffer) {
        try {
            const state = this.openFile(fileName);
            if (state.truncated) {
                return;
            }
            const marker = Buffer.from(DEV_OUTPUT_TEE_TRUNCATION_MARKER);
            const contentLimit = Math.max(0, this.retentionPolicy.maxFileBytes - marker.byteLength);
            const availableBytes = Math.max(0, contentLimit - state.bytesWritten);
            if (buffer.byteLength <= availableBytes) {
                writeSync(state.fd, buffer);
                state.bytesWritten += buffer.byteLength;
                return;
            }
            if (availableBytes > 0) {
                writeSync(state.fd, buffer.subarray(0, availableBytes));
            }
            writeSync(state.fd, marker);
            state.bytesWritten += availableBytes + marker.byteLength;
            state.truncated = true;
        } catch {}
    }

    /** `lines` ends with a newline; every line gets exactly one prefix. */
    private writeCombinedLines(stem: string, stream: TOutputStreamName, lines: string, aggregate: boolean) {
        const timestamp = new Date().toISOString();
        const body = lines.slice(0, -1);
        const prefix = `[${timestamp} ${stream}] `;
        const text = `${body.replace(/^/gmu, prefix)}\n`;
        this.writeFile(`${stem}.combined.log`, Buffer.from(text));
        if (!aggregate) {
            return;
        }

        const aggregatePrefix = `[${timestamp} ${stem} ${stream}] `;
        const aggregateText = `${body.replace(/^/gmu, aggregatePrefix)}\n`;
        this.writeFile('session.combined.log', Buffer.from(aggregateText));
        if (this.stableLogEnabled) {
            try {
                appendFileSync(this.sessionLogFile, aggregateText);
            } catch {}
        }
    }

    private writeLogManifest(createdAt: string) {
        try {
            const existing = readLogManifest(this.logManifestFile);
            const sourceStems = new Set(
                existing?.runDir === this.runDir ? existing.sourceStems : [],
            );
            for (const stem of this.sourceStems) sourceStems.add(stem);
            writeJsonFile(this.logManifestFile, {
                schemaVersion: 1,
                createdAt,
                sessionName: this.sessionName,
                runDir: this.runDir,
                relativeRunDir: this.relativeRunDir,
                sessionLogFile: this.sessionLogFile,
                runCombinedLogFile: this.runCombinedLogFile,
                sourceStems: [...sourceStems].sort(),
            } satisfies IDevServerLogManifest);
        } catch {}
    }

    private pruneCompletedRuns(now = new Date()) {
        try {
            pruneDevServerOutputRuns({
                baseDir: this.baseDir,
                now,
                policy: this.retentionPolicy,
                protectedRunDirs: openTeeRunDirs,
            });
        } catch {}
    }
}

export function createDevServerOutputTee(options: ICreateDevServerOutputTeeOptions & {allowDisabled: true}): IDevServerOutputTee | null;
export function createDevServerOutputTee(options?: ICreateDevServerOutputTeeOptions): IDevServerOutputTee;
export function createDevServerOutputTee(options: ICreateDevServerOutputTeeOptions & {allowDisabled?: boolean} = {}): IDevServerOutputTee | null {
    const env = options.env ?? process.env;
    if (isTruthyEnvValue(env[DEV_OUTPUT_TEE_DISABLED_ENV])) {
        if (!options.allowDisabled) {
            throw new Error('Dev output tee is disabled.');
        }
        return null;
    }

    const createOptions: Required<ICreateDevServerOutputTeeOptions> = {
        sessionName: options.sessionName ?? getCurrentSessionName(),
        runDir: options.runDir ?? env[DEV_OUTPUT_TEE_DIR_ENV] ?? '',
        baseDir: options.baseDir ?? devServerOutputTeeBaseDir,
        env,
        now: options.now ?? new Date(),
        pid: options.pid ?? process.pid,
        metadataFileName: options.metadataFileName ?? 'electron-run-tee.json',
        owner: options.owner ?? 'electron-run',
        sessionArtifactsDir: options.sessionArtifactsDir ?? (
            options.baseDir && options.baseDir !== devServerOutputTeeBaseDir
                ? join(options.baseDir, '.session-artifacts')
                : ''
        ),
        retentionPolicy: options.retentionPolicy ?? {},
    };
    return new DevServerOutputTee({
        ...createOptions,
        ...(createOptions.runDir ? { runDir: createOptions.runDir } : {}),
    });
}

export function installDevServerOutputTee() {
    if (activeTee) {
        return activeTee;
    }

    const tee = createDevServerOutputTee({allowDisabled: true});
    if (!tee) {
        return null;
    }

    activeTee = tee as DevServerOutputTee;
    activeTee.installProcessStreamTee();
    process.once('exit', () => closeActiveDevServerOutputTee());
    return activeTee;
}

export function getActiveDevServerOutputTee() {
    return activeTee;
}

export function closeActiveDevServerOutputTee() {
    activeTee?.close();
    activeTee = null;
}
