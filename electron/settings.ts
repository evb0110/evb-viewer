import {
    readFile,
    rm,
    writeFile,
} from 'fs/promises';
import { join } from 'path';
import { app } from 'electron';
import { userInfo } from 'node:os';
import {
    DEFAULT_SETTINGS,
    migrateSettings,
    sanitizeSettings,
    UnsupportedSettingsSchemaError,
    type ISettingsRecoveryNotice,
} from '@contracts/settings';
import type { ISettingsData } from '@contracts/shared';
import {
    isErrnoException,
    isRecord,
} from '@contracts/runtimeGuards';
import { createLogger } from '@electron/utils/createLogger';
import { getErrorMessage } from '@electron/utils/error';
import {
    atomicReplace,
    makeSiblingTempPath,
} from '@electron/utils/atomicReplace';
import { quarantineCorruptFile } from '@electron/utils/quarantineCorruptFile';
import {setMainDiagnosticsPreference} from '@electron/features/diagnostics/public';
import {
    parseClientDiagnosticsPreference,
    type TClientDiagnosticsPreference,
} from '@contracts/diagnostics/diagnosticsPreference';

const logger = createLogger('settings');
const STARTUP_TRACE_ENABLED = process.env.EVB_STARTUP_TRACE === '1';

let settingsCache: ISettingsData | null = null;
let settingsLoadPromise: Promise<ISettingsData> | null = null;
let settingsCacheGeneration = 0;
let settingsMutationQueue: Promise<unknown> = Promise.resolve();
let settingsRecoveryNotice: ISettingsRecoveryNotice | null = null;
// The user's latest diagnostics choice, recorded as soon as it reaches main.
// It wins over whatever an older queued write carries.
let consentIntent: {
    revision: number;
    preference: TClientDiagnosticsPreference | null;
} = {
    revision: 0,
    preference: null,
};

type TSettingsUpdateResult = Partial<ISettingsData> | undefined;
type TSettingsUpdater = (
    settings: ISettingsData,
) => TSettingsUpdateResult | Promise<TSettingsUpdateResult>;

/** A revocation takes effect immediately; a grant only once it is on disk. */
export function recordMainDiagnosticsConsentIntent(value: unknown) {
    const preference = parseClientDiagnosticsPreference(value);
    consentIntent = {
        revision: consentIntent.revision + 1,
        preference,
    };
    if (preference !== 'granted') {
        setMainDiagnosticsPreference(preference);
        if (settingsCache) {
            settingsCache = {
                ...settingsCache,
                clientDiagnosticsPreference: preference,
            };
        }
    }
    return consentIntent.revision;
}

function withLatestConsent(settings: ISettingsData): ISettingsData {
    return consentIntent.preference === null
        ? settings
        : migrateSettings({
            ...settings,
            clientDiagnosticsPreference: consentIntent.preference,
        });
}

function getStoragePath() {
    return join(app.getPath('userData'), 'settings.json');
}

function cloneSettings(settings: ISettingsData): ISettingsData {
    return {...settings};
}

function applyElectronDefaults(settings: ISettingsData): ISettingsData {
    if (settings.authorName.trim()) {
        return settings;
    }
    try {
        const username = userInfo().username.trim();
        return username
            ? {
                ...settings,
                authorName: username,
            }
            : settings;
    } catch {
        return settings;
    }
}

function parseSettingsPayload(content: string): unknown {
    const parsed: unknown = JSON.parse(content);
    return parsed;
}

function queueSettingsMutation<T>(mutation: () => Promise<T>) {
    const task = settingsMutationQueue.then(() => mutation());
    settingsMutationQueue = task.then(() => undefined, () => undefined);
    return task;
}

async function writeSettingsAtomically(storagePath: string, settings: ISettingsData) {
    const tempPath = makeSiblingTempPath(storagePath);
    await writeFile(tempPath, JSON.stringify(settings, null, 2), 'utf-8');

    try {
        await atomicReplace(tempPath, storagePath);
    } catch (error) {
        await rm(tempPath, { force: true }).catch(() => {});
        throw error;
    }
}

function getDefaultSettings() {
    return applyElectronDefaults(sanitizeSettings(DEFAULT_SETTINGS));
}

async function recoverSettingsFromStorage(storagePath: string, reason: 'corrupt' | 'unsupported') {
    let quarantinePath: string | null = null;
    try {
        quarantinePath = await quarantineCorruptFile(storagePath);
        await writeSettingsAtomically(storagePath, getDefaultSettings());
        logger.warn(`Quarantined ${reason} settings at ${quarantinePath ?? storagePath}`);
    } catch (recoveryError) {
        logger.error(`Failed to recover ${reason} settings: ${getErrorMessage(recoveryError)}`, {
            code: 'MAIN_SETTINGS_OPERATION_FAILED',
            cause: recoveryError,
        });
    }
    settingsRecoveryNotice ??= {
        reason,
        ...(quarantinePath === null ? {} : {quarantinePath}),
    };
    return getDefaultSettings();
}

export function consumeSettingsRecoveryNotice() {
    const notice = settingsRecoveryNotice;
    settingsRecoveryNotice = null;
    return notice;
}

async function readSettingsFromStorage(storagePath: string) {
    let content: string;
    try {
        content = await readFile(storagePath, 'utf-8');
    } catch (err) {
        if (isErrnoException(err) && err.code === 'ENOENT') {
            return getDefaultSettings();
        }
        logger.error(`Failed to read settings: ${getErrorMessage(err)}`, {
            code: 'MAIN_SETTINGS_OPERATION_FAILED',
            cause: err,
        });
        // An EIO or a permission blip can be transient, and quarantining renames
        // the file away: one bad boot would become permanently lost settings.
        // Boot on defaults, leave the file alone, and let the next launch retry.
        settingsRecoveryNotice ??= {reason: 'unreadable'};
        return getDefaultSettings();
    }

    try {
        const parsed = parseSettingsPayload(content);
        return applyElectronDefaults(migrateSettings(parsed));
    } catch (err) {
        if (err instanceof UnsupportedSettingsSchemaError) {
            logger.error(`Failed to load settings: ${getErrorMessage(err)}`, {
                code: 'MAIN_SETTINGS_OPERATION_FAILED',
                cause: err,
            });
            return recoverSettingsFromStorage(storagePath, 'unsupported');
        }
        logger.error(`Failed to load settings: ${getErrorMessage(err)}`, {
            code: 'MAIN_SETTINGS_OPERATION_FAILED',
            cause: err,
        });
        return recoverSettingsFromStorage(storagePath, 'corrupt');
    }
}

export async function loadSettings(): Promise<ISettingsData> {
    const startedAt = Date.now();
    if (settingsCache) {
        if (STARTUP_TRACE_ENABLED) {
            logger.info(`[startup] loadSettings cache hit (+${Date.now() - startedAt}ms)`);
        }
        return cloneSettings(settingsCache);
    }

    if (settingsLoadPromise) {
        return cloneSettings(withLatestConsent(await settingsLoadPromise));
    }

    const generation = settingsCacheGeneration;
    const storagePath = getStoragePath();
    const loadPromise = readSettingsFromStorage(storagePath);
    settingsLoadPromise = loadPromise;
    let parsed: ISettingsData;
    try {
        parsed = await loadPromise;
        if (generation === settingsCacheGeneration) {
            settingsCache = withLatestConsent(parsed);
        }
    } finally {
        if (settingsLoadPromise === loadPromise) {
            settingsLoadPromise = null;
        }
    }
    if (STARTUP_TRACE_ENABLED) {
        logger.info(`[startup] loadSettings file read complete (+${Date.now() - startedAt}ms)`);
    }
    return cloneSettings(withLatestConsent(parsed));
}

export function resetSettingsCacheAfterUserDataPathChange() {
    settingsCacheGeneration += 1;
    settingsCache = null;
    settingsLoadPromise = null;
    settingsRecoveryNotice = null;
}

export async function updateSettings(
    mutate: TSettingsUpdater,
    options: {diagnosticsConsentRevision?: number} = {},
): Promise<ISettingsData> {
    return queueSettingsMutation(async () => {
        const generation = settingsCacheGeneration;
        const storagePath = getStoragePath();
        const current = settingsCache ? cloneSettings(settingsCache) : await loadSettings();
        const draft = cloneSettings(current);
        const mutationResult = await mutate(draft);
        let next = migrateSettings(isRecord(mutationResult)
            ? {
                ...draft,
                ...mutationResult,
            }
            : draft);
        if (
            options.diagnosticsConsentRevision === undefined
            && next.clientDiagnosticsPreference !== current.clientDiagnosticsPreference
        ) {
            recordMainDiagnosticsConsentIntent(next.clientDiagnosticsPreference);
        }
        // A choice made while this write was in flight is written after it.
        for (;;) {
            const revision = consentIntent.revision;
            next = withLatestConsent(next);
            await writeSettingsAtomically(storagePath, next);
            if (revision === consentIntent.revision) {
                break;
            }
        }
        setMainDiagnosticsPreference(next.clientDiagnosticsPreference);
        if (generation === settingsCacheGeneration) {
            settingsCache = next;
        }
        return cloneSettings(next);
    });
}
