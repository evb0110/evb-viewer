import {
    chmod,
    lstat,
    mkdir,
    readdir,
    readFile,
    symlink,
    unlink,
    writeFile,
} from 'node:fs/promises';
import {homedir} from 'node:os';
import {
    isAbsolute,
    join,
    resolve,
} from 'node:path';
import electron from 'electron';
import * as v from 'valibot';
import {
    ASSISTANT_DEFAULT_INSTANCE_IDS,
    ASSISTANT_INSTANCE_ID_PATTERN,
    ASSISTANT_INSTANCES_SCHEMA,
    type IAssistantEnvironmentEntry,
    type IAssistantInstanceConfig,
    type IAssistantInstancesResult,
    type TAssistantDriver,
} from '@contracts/assistant';
import {isRecord} from '@contracts/runtimeGuards';
import {
    atomicReplace,
    makeSiblingTempPath,
} from '@electron/utils/atomicReplace';
import {te} from '@electron/te';
import {createLogger} from '@electron/utils/createLogger';
import {getErrorMessage} from '@electron/utils/error';
import {ASSISTANT_MODEL_CONFIG_DIR} from '@electron/features/agent/codexAssistantConfig';

const logger = createLogger('assistant-instances');
const STORE_VERSION = 1;
const SECRET_NAME_PATTERN = /token|secret|password|passwd|api[_-]?key|credential|auth/iu;
const SECRET_ARGS_PATTERN = /token|secret|password|api[_-]?key|bearer/iu;
// Entries a Codex shadow home keeps to itself: its own login, the lock that
// guards it, the account's model cache, and process-local scratch.
const SHADOW_PRIVATE_ENTRIES = new Set([
    'auth.json',
    'auth.lock',
    'models_cache.json',
    'log',
    'memories',
    'tmp',
    '.DS_Store',
]);
// Host-session markers a Claude child must not inherit from a parent Claude.
const CLAUDE_HOST_ENV = [
    'CLAUDECODE',
    'CLAUDE_CODE_ENTRYPOINT',
    'CLAUDE_CODE_SESSION_ID',
    'CLAUDE_CODE_SSE_PORT',
    'ELECTRON_RUN_AS_NODE',
];

interface IStoredEnvironmentEntry {
    name: string;
    secret: boolean;
    value?: string;
    encrypted?: string;
}

interface IStoredInstance extends Omit<IAssistantInstanceConfig, 'environment' | 'launchArgs' | 'launchArgsConfigured'> {
    environment?: IStoredEnvironmentEntry[];
    launchArgs?: string;
    launchArgsEncrypted?: string;
}

interface IStoredInstances {
    version: typeof STORE_VERSION;
    instances: IStoredInstance[];
}

/** Everything needed to start one instance's process. Never leaves main. */
export interface IAssistantLaunchContext {
    instance: IAssistantInstanceConfig;
    binaryPath: string | null;
    env: NodeJS.ProcessEnv;
    launchArgs: string[];
    /** Effective CODEX_HOME or CLAUDE_CONFIG_DIR; null means the CLI default. */
    homePath: string | null;
    customEndpoint: boolean;
    /** Claude launch flags for the SDK's `extraArgs`; empty for Codex. */
    claudeExtraArgs: Record<string, string | null>;
}

// Claude flags that would undo EVB's tool, permission, MCP or prompt
// restrictions, or that the SDK itself owns.
const CLAUDE_RESERVED_FLAGS = new Set([
    'tools',
    'allowedtools',
    'allowed-tools',
    'disallowedtools',
    'disallowed-tools',
    'permission-mode',
    'permission-prompt-tool',
    'dangerously-skip-permissions',
    'allow-dangerously-skip-permissions',
    'mcp-config',
    'strict-mcp-config',
    'settings',
    'setting-sources',
    'add-dir',
    'system-prompt',
    'system-prompt-file',
    'append-system-prompt',
    'append-system-prompt-file',
    'plugin-dir',
    'agents',
    'resume',
    'continue',
    'session-id',
    'fork-session',
    'print',
    'output-format',
    'input-format',
    'model',
]);

/**
 * Turns Claude launch arguments into SDK `extraArgs` (`--flag value`,
 * `--flag=value` or a bare switch). Flags that would change EVB's
 * restrictions are refused rather than dropped.
 */
export function parseClaudeExtraArgs(tokens: readonly string[], label: string) {
    const extraArgs: Record<string, string | null> = {};
    for (let index = 0; index < tokens.length; index += 1) {
        const token = tokens[index] ?? '';
        if (!token.startsWith('--') || token.length === 2) {
            throw new Error(te('dialogs.agentAssistant.launchArgUnsupported', {
                label,
                argument: token,
            }));
        }
        const [
            rawName = '',
            inlineValue,
        ] = token.slice(2).split(/=(.*)/su, 2);
        if (CLAUDE_RESERVED_FLAGS.has(rawName.toLowerCase())) {
            throw new Error(te('dialogs.agentAssistant.launchArgUnsupported', {
                label,
                argument: `--${rawName}`,
            }));
        }
        if (inlineValue !== undefined) {
            extraArgs[rawName] = inlineValue;
            continue;
        }
        const next = tokens[index + 1];
        if (next !== undefined && !next.startsWith('--')) {
            extraArgs[rawName] = next;
            index += 1;
        } else {
            extraArgs[rawName] = null;
        }
    }
    return extraArgs;
}

export function defaultAssistantInstances(): IAssistantInstanceConfig[] {
    return [
        {
            id: ASSISTANT_DEFAULT_INSTANCE_IDS.codex,
            driver: 'codex',
            displayName: 'Codex',
            enabled: true,
        },
        {
            id: ASSISTANT_DEFAULT_INSTANCE_IDS.claude,
            driver: 'claude',
            displayName: 'Claude',
            enabled: true,
        },
    ];
}

function storePath() {
    return join(electron.app.getPath('userData'), ASSISTANT_MODEL_CONFIG_DIR, 'providers.json');
}

function canEncrypt() {
    return electron.safeStorage.isEncryptionAvailable()
        && (process.platform !== 'linux' || electron.safeStorage.getSelectedStorageBackend() !== 'basic_text');
}

function encrypt(value: string) {
    if (!canEncrypt()) {
        throw new Error(te('dialogs.agentAssistant.secureStorageUnavailable'));
    }
    return electron.safeStorage.encryptString(value).toString('base64');
}

function decrypt(value: string) {
    return electron.safeStorage.decryptString(Buffer.from(value, 'base64'));
}

async function readStore(): Promise<IStoredInstances | null> {
    let text: string;
    try {
        text = await readFile(storePath(), 'utf8');
    } catch (error) {
        if (isRecord(error) && error.code === 'ENOENT') {
            return null;
        }
        throw error;
    }
    const parsed: unknown = JSON.parse(text);
    if (!isStoredInstances(parsed)) {
        throw new Error(te('dialogs.agentAssistant.storeUnsupported'));
    }
    return parsed;
}

function isStoredInstances(value: unknown): value is IStoredInstances {
    return isRecord(value)
        && value.version === STORE_VERSION
        && Array.isArray(value.instances)
        && value.instances.every(instance => isRecord(instance)
            && typeof instance.id === 'string'
            && (instance.driver === 'codex' || instance.driver === 'claude')
            && typeof instance.displayName === 'string'
            && typeof instance.enabled === 'boolean');
}

async function writeStore(store: IStoredInstances) {
    const path = storePath();
    await mkdir(join(electron.app.getPath('userData'), ASSISTANT_MODEL_CONFIG_DIR), {
        recursive: true,
        mode: 0o700,
    });
    const temporaryPath = makeSiblingTempPath(path);
    try {
        await writeFile(temporaryPath, `${JSON.stringify(store, null, 2)}\n`, {
            encoding: 'utf8',
            mode: 0o600,
        });
        await atomicReplace(temporaryPath, path);
        await chmod(path, 0o600);
    } catch (error) {
        await unlink(temporaryPath).catch(() => undefined);
        throw error;
    }
}

function redact(stored: IStoredInstance): IAssistantInstanceConfig {
    const {
        environment,
        launchArgsEncrypted,
        launchArgs,
        ...rest
    } = stored;
    return {
        ...rest,
        ...(launchArgs !== undefined || launchArgsEncrypted !== undefined
            ? {
                launchArgs: stored.launchArgsSecret ? '' : (launchArgs ?? ''),
                launchArgsConfigured: true,
            }
            : {}),
        ...(environment
            ? {environment: environment.map(entry => ({
                name: entry.name,
                secret: entry.secret,
                value: entry.secret ? '' : (entry.value ?? ''),
                configured: entry.secret ? entry.encrypted !== undefined : undefined,
            }))}
            : {}),
    };
}

let cachedStore: Promise<IStoredInstances | null> | null = null;

function loadStore() {
    cachedStore ??= readStore().catch((error: unknown) => {
        cachedStore = null;
        throw error;
    });
    return cachedStore;
}

/** The configured instances for the renderer: secrets are never included. */
export async function getAssistantInstanceConfigs(): Promise<IAssistantInstanceConfig[]> {
    const store = await loadStore();
    return store ? store.instances.map(redact) : defaultAssistantInstances();
}

async function getStoredInstances(): Promise<IStoredInstance[]> {
    const store = await loadStore();
    return store?.instances ?? (defaultAssistantInstances() as IStoredInstance[]);
}

function storeInstance(next: IAssistantInstanceConfig, previous: IStoredInstance | undefined): IStoredInstance {
    const {
        environment,
        launchArgs,
        launchArgsConfigured: _launchArgsConfigured,
        ...rest
    } = next;
    const stored: IStoredInstance = {...rest};
    if (launchArgs !== undefined) {
        if (next.launchArgsSecret) {
            if (launchArgs.length > 0) {
                stored.launchArgsEncrypted = encrypt(launchArgs);
            } else if (previous?.launchArgsEncrypted) {
                stored.launchArgsEncrypted = previous.launchArgsEncrypted;
            } else if (previous?.launchArgs) {
                stored.launchArgsEncrypted = encrypt(previous.launchArgs);
            }
        } else if (launchArgs.length > 0) {
            stored.launchArgs = launchArgs;
        }
    }
    if (environment) {
        stored.environment = environment.map((entry): IStoredEnvironmentEntry => {
            if (!entry.secret) {
                return {
                    name: entry.name,
                    secret: false,
                    value: entry.value,
                };
            }
            if (entry.value.length > 0) {
                return {
                    name: entry.name,
                    secret: true,
                    encrypted: encrypt(entry.value),
                };
            }
            const kept = previous?.environment?.find(candidate => candidate.name === entry.name);
            if (kept?.encrypted) {
                return {
                    name: entry.name,
                    secret: true,
                    encrypted: kept.encrypted,
                };
            }
            return {
                name: entry.name,
                secret: true,
                ...(kept?.value ? {encrypted: encrypt(kept.value)} : {}),
            };
        });
    }
    return stored;
}

type TInstancesListener = () => void;
const listeners = new Set<TInstancesListener>();

export function onAssistantInstancesChanged(listener: TInstancesListener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

export async function saveAssistantInstanceConfigs(input: unknown): Promise<IAssistantInstancesResult> {
    try {
        const next = v.parse(ASSISTANT_INSTANCES_SCHEMA, input);
        for (const instance of next) {
            if (instance.driver !== 'codex' && instance.shadowHomePath?.trim()) {
                throw new Error(te('dialogs.agentAssistant.shadowCodexOnly', {label: instance.displayName}));
            }
        }
        const previous = new Map((await getStoredInstances()).map(instance => [
            instance.id,
            instance,
        ]));
        const store: IStoredInstances = {
            version: STORE_VERSION,
            instances: next.map(instance => storeInstance(instance, previous.get(instance.id))),
        };
        await writeStore(store);
        cachedStore = Promise.resolve(store);
        for (const listener of listeners) {
            listener();
        }
        return {
            ok: true,
            instances: store.instances.map(redact),
            notices: [],
        };
    } catch (error) {
        return {
            ok: false,
            instances: await getAssistantInstanceConfigs().catch(() => defaultAssistantInstances()),
            notices: [],
            error: getErrorMessage(error),
        };
    }
}

function expandHome(path: string) {
    const trimmed = path.trim();
    if (trimmed === '~') {
        return homedir();
    }
    if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
        return join(homedir(), trimmed.slice(2));
    }
    return trimmed;
}

/** Splits a launch-argument string like a POSIX shell would, without evaluating it. */
export function tokenizeLaunchArgs(input: string) {
    const tokens: string[] = [];
    let current = '';
    let inToken = false;
    let quote: '"' | '\'' | null = null;
    for (let index = 0; index < input.length; index += 1) {
        const character = input[index] ?? '';
        if (quote) {
            if (character === quote) {
                quote = null;
            } else if (character === '\\' && quote === '"' && (input[index + 1] === '"' || input[index + 1] === '\\')) {
                current += input[index + 1];
                index += 1;
            } else {
                current += character;
            }
            continue;
        }
        if (character === '"' || character === '\'') {
            quote = character;
            inToken = true;
            continue;
        }
        if (/\s/u.test(character)) {
            if (inToken) {
                tokens.push(current);
                current = '';
                inToken = false;
            }
            continue;
        }
        if (character === '\\' && index + 1 < input.length && process.platform !== 'win32') {
            current += input[index + 1];
            index += 1;
            inToken = true;
            continue;
        }
        current += character;
        inToken = true;
    }
    if (quote) {
        throw new Error(te('dialogs.agentAssistant.unmatchedQuote'));
    }
    if (inToken) {
        tokens.push(current);
    }
    return tokens;
}

/**
 * Creates a Codex shadow home when it does not exist yet: every entry of the
 * base home is linked in, except the login and process-local entries, so the
 * shadow shares sessions and configuration but keeps its own sign-in. An
 * existing shadow home is used as is; EVB does not rearrange another tool's
 * directory.
 */
async function ensureShadowHome(baseHome: string, shadowHome: string) {
    if (resolve(baseHome) === resolve(shadowHome)) {
        throw new Error(te('dialogs.agentAssistant.shadowSameAsBase'));
    }
    try {
        await lstat(shadowHome);
        return;
    } catch (error) {
        if (!isRecord(error) || error.code !== 'ENOENT') {
            throw error;
        }
    }
    await mkdir(shadowHome, {
        recursive: true,
        mode: 0o700,
    });
    let entries: string[] = [];
    try {
        entries = await readdir(baseHome);
    } catch (error) {
        logger.warn(`Codex base home ${baseHome} could not be read: ${getErrorMessage(error)}`);
    }
    for (const entry of entries) {
        if (SHADOW_PRIVATE_ENTRIES.has(entry)) {
            continue;
        }
        await symlink(join(baseHome, entry), join(shadowHome, entry)).catch((error: unknown) => {
            logger.warn(`Could not link ${entry} into Codex shadow home: ${getErrorMessage(error)}`);
        });
    }
}

function decryptEnvironment(entries: IStoredEnvironmentEntry[] | undefined, label: string) {
    const env: Record<string, string> = {};
    for (const entry of entries ?? []) {
        if (entry.secret) {
            if (!entry.encrypted) {
                throw new Error(te('dialogs.agentAssistant.secretMissing', {
                    label,
                    name: entry.name,
                }));
            }
            try {
                env[entry.name] = decrypt(entry.encrypted);
            } catch {
                throw new Error(te('dialogs.agentAssistant.secretUnreadable', {
                    label,
                    name: entry.name,
                }));
            }
            continue;
        }
        env[entry.name] = entry.value ?? '';
    }
    return env;
}

function decryptLaunchArgs(stored: IStoredInstance, label: string) {
    if (stored.launchArgsEncrypted) {
        try {
            return decrypt(stored.launchArgsEncrypted);
        } catch {
            throw new Error(te('dialogs.agentAssistant.argsUnreadable', {label}));
        }
    }
    return stored.launchArgs ?? '';
}

export interface IAssistantBinaryResolvers {
    codex: () => Promise<string | null>;
    claude: (env: NodeJS.ProcessEnv) => Promise<string | null>;
}

export function assistantInstanceLabel(instance: Pick<IAssistantInstanceConfig, 'driver' | 'displayName'>) {
    const driverLabel = instance.driver === 'codex' ? 'Codex' : 'Claude';
    return instance.displayName === driverLabel ? driverLabel : `${driverLabel} · ${instance.displayName}`;
}

/**
 * Resolves one instance into its launch context. The executable, home,
 * arguments and environment come from the instance alone, so status probes,
 * sign-in and chats of one instance never borrow another instance's account.
 */
export async function resolveAssistantLaunchContext(
    instanceId: string,
    resolvers: IAssistantBinaryResolvers,
): Promise<IAssistantLaunchContext> {
    const stored = (await getStoredInstances()).find(instance => instance.id === instanceId);
    if (!stored) {
        throw new Error(te('dialogs.agentAssistant.instanceNotConfigured', {id: instanceId}));
    }
    const instance = redact(stored);
    const label = assistantInstanceLabel(instance);
    const instanceEnv = decryptEnvironment(stored.environment, label);
    const hostEnv = instance.driver === 'claude'
        ? Object.fromEntries(Object.entries(process.env).filter(([name]) => !CLAUDE_HOST_ENV.includes(name)))
        : process.env;
    const env: NodeJS.ProcessEnv = {
        ...hostEnv,
        ...instanceEnv,
    };
    const launchArgs = tokenizeLaunchArgs(decryptLaunchArgs(stored, label));
    let homePath: string | null = null;
    if (instance.driver === 'codex') {
        const baseHome = instance.homePath?.trim() ? expandHome(instance.homePath) : null;
        const shadowHome = instance.shadowHomePath?.trim() ? expandHome(instance.shadowHomePath) : null;
        if (shadowHome) {
            await ensureShadowHome(baseHome ?? join(homedir(), '.codex'), shadowHome);
            homePath = shadowHome;
        } else {
            homePath = baseHome ?? (instanceEnv.CODEX_HOME ? expandHome(instanceEnv.CODEX_HOME) : null);
        }
        if (homePath) {
            env.CODEX_HOME = homePath;
        }
    } else {
        homePath = instance.homePath?.trim()
            ? expandHome(instance.homePath)
            : (instanceEnv.CLAUDE_CONFIG_DIR ? expandHome(instanceEnv.CLAUDE_CONFIG_DIR) : null);
        if (homePath) {
            // HOME stays: replacing it would hide the macOS Keychain login.
            env.CLAUDE_CONFIG_DIR = homePath;
        }
    }
    const configuredBinary = instance.binaryPath?.trim() ? expandHome(instance.binaryPath) : null;
    const binaryPath = configuredBinary
        ?? (instance.driver === 'codex' ? await resolvers.codex() : await resolvers.claude(env));
    const joinedArgs = launchArgs.join(' ');
    const customEndpoint = instance.driver === 'codex'
        ? /model_provider\s*=|base_url\s*=/u.test(joinedArgs)
        : Boolean(instanceEnv.ANTHROPIC_BASE_URL?.trim());
    return {
        instance,
        binaryPath: binaryPath && !isAbsolute(binaryPath) && binaryPath.includes('/') ? resolve(binaryPath) : binaryPath,
        env,
        launchArgs,
        homePath,
        customEndpoint,
        claudeExtraArgs: instance.driver === 'claude' ? parseClaudeExtraArgs(launchArgs, label) : refuseCodexEnableFlags(launchArgs, label),
    };
}

/**
 * Codex `--enable` turns a feature on outside the `-c` overrides EVB appends
 * to keep the shell, apps and similar features off, so it is refused.
 */
function refuseCodexEnableFlags(tokens: readonly string[], label: string) {
    const enable = tokens.find(token => token === '--enable' || token.startsWith('--enable='));
    if (enable) {
        throw new Error(te('dialogs.agentAssistant.launchArgUnsupported', {
            label,
            argument: '--enable',
        }));
    }
    return {};
}

/**
 * One fingerprint per instance from its stored form, secrets included as
 * ciphertext, so a runtime restarts when anything it was started with changes.
 */
export async function getAssistantInstanceFingerprints() {
    return new Map((await getStoredInstances()).map(instance => [
        instance.id,
        JSON.stringify(instance),
    ]));
}

function slugify(value: string) {
    const slug = value.toLowerCase().replace(/[^a-z0-9_-]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 64);
    return ASSISTANT_INSTANCE_ID_PATTERN.test(slug) ? slug : null;
}

function readT3String(record: Record<string, unknown>, key: string) {
    const value = record[key];
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * Maps T3 Code's `providerInstances` onto EVB instances. T3's default
 * instances map onto EVB's defaults; other ids are kept. T3's permission
 * wrapper for Claude is replaced by the Claude executable it wraps, because
 * EVB keeps its own tool restrictions.
 */
export function mapT3ProviderInstances(raw: unknown) {
    const notices: string[] = [];
    const instances: IAssistantInstanceConfig[] = [];
    if (!isRecord(raw)) {
        return {
            instances,
            notices: [te('dialogs.agentAssistant.t3NoInstances')],
        };
    }
    for (const [
        key,
        value,
    ] of Object.entries(raw)) {
        if (!isRecord(value)) {
            continue;
        }
        const t3Driver = value.driver;
        const driver: TAssistantDriver | null = t3Driver === 'codex'
            ? 'codex'
            : t3Driver === 'claudeAgent' ? 'claude' : null;
        if (!driver) {
            continue;
        }
        const id = key === 'claudeAgent' ? ASSISTANT_DEFAULT_INSTANCE_IDS.claude : slugify(key);
        if (!id) {
            notices.push(te('dialogs.agentAssistant.t3SkippedId', {id: key}));
            continue;
        }
        const config = isRecord(value.config) ? value.config : {};
        if (config.setupMode === 'managed') {
            notices.push(te('dialogs.agentAssistant.t3SkippedManaged', {id: key}));
            continue;
        }
        const environment: IAssistantEnvironmentEntry[] = [];
        let binaryPath = readT3String(config, 'binaryPath');
        const rawEnvironment: unknown[] = Array.isArray(value.environment) ? value.environment : [];
        const wrapped = rawEnvironment.find(entry => isRecord(entry) && entry.name === 'T3_CLAUDE_BINARY');
        for (const entry of rawEnvironment) {
            if (!isRecord(entry) || typeof entry.name !== 'string' || typeof entry.value !== 'string') {
                continue;
            }
            if (driver === 'claude' && wrapped && (entry.name === 'T3_YOLO' || entry.name === 'T3_CLAUDE_BINARY')) {
                continue;
            }
            if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(entry.name)) {
                continue;
            }
            environment.push({
                name: entry.name,
                value: entry.value,
                secret: entry.sensitive === true || SECRET_NAME_PATTERN.test(entry.name) && entry.name !== 'PATH',
            });
        }
        if (driver === 'claude' && isRecord(wrapped) && typeof wrapped.value === 'string') {
            binaryPath = wrapped.value;
            notices.push(te('dialogs.agentAssistant.t3WrapperReplaced', {id: key}));
        }
        const launchArgs = readT3String(config, 'launchArgs');
        const enabled = value.enabled !== false && config.enabled !== false;
        const displayName = readT3String(value, 'displayName') ?? (driver === 'codex' ? 'Codex' : 'Claude');
        instances.push({
            id,
            driver,
            displayName,
            enabled,
            ...(binaryPath ? {binaryPath} : {}),
            ...(readT3String(config, 'homePath') ? {homePath: readT3String(config, 'homePath')} : {}),
            ...(driver === 'codex' && readT3String(config, 'shadowHomePath')
                ? {shadowHomePath: readT3String(config, 'shadowHomePath')}
                : {}),
            ...(launchArgs
                ? {
                    launchArgs,
                    launchArgsSecret: SECRET_ARGS_PATTERN.test(launchArgs),
                }
                : {}),
            ...(environment.length > 0 ? {environment} : {}),
            importedFrom: 't3code',
        });
    }
    if (instances.length === 0) {
        notices.push(te('dialogs.agentAssistant.t3NoInstances'));
    }
    return {
        instances,
        notices,
    };
}

export async function importAssistantInstancesFromT3(): Promise<IAssistantInstancesResult> {
    const settingsPath = join(homedir(), '.t3', 'userdata', 'settings.json');
    let raw: unknown;
    try {
        const text = await readFile(settingsPath, 'utf8');
        raw = JSON.parse(text) as unknown;
    } catch (error) {
        return {
            ok: false,
            instances: await getAssistantInstanceConfigs(),
            notices: [],
            error: isRecord(error) && error.code === 'ENOENT'
                ? te('dialogs.agentAssistant.t3Missing')
                : te('dialogs.agentAssistant.t3Unreadable', {reason: getErrorMessage(error)}),
        };
    }
    const mapped = mapT3ProviderInstances(isRecord(raw) ? raw.providerInstances : null);
    if (mapped.instances.length === 0) {
        return {
            ok: false,
            instances: await getAssistantInstanceConfigs(),
            notices: mapped.notices,
        };
    }
    const current = await getStoredInstances();
    const importedIds = new Set(mapped.instances.map(instance => instance.id));
    // Imported rows replace the rows with the same id; other rows stay. A
    // secret in a replaced row is carried by the import itself.
    const merged: IAssistantInstanceConfig[] = [
        ...current.filter(instance => !importedIds.has(instance.id)).map(redact),
        ...mapped.instances,
    ];
    const result = await saveAssistantInstanceConfigs(merged);
    return {
        ...result,
        notices: [
            te('dialogs.agentAssistant.t3Imported', {count: mapped.instances.length}),
            ...mapped.notices,
            ...result.notices,
        ],
    };
}
