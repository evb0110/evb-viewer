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
    assertSupportedSettingsSchema,
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
import {
    setMainDiagnosticsPreference,
    waitForMainDiagnosticsTransportReady,
} from '@electron/features/diagnostics/public';
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
let diagnosticsConsentRevision = 0;
let diagnosticsDeniedOverride: TClientDiagnosticsPreference | null = null;
let settingsRecoveryNotice: ISettingsRecoveryNotice | null = null;

type TSettingsUpdateResult = Partial<ISettingsData> | undefined;
type TSettingsUpdater = (
    settings: ISettingsData,
) => TSettingsUpdateResult | Promise<TSettingsUpdateResult>;

export function recordMainDiagnosticsConsentIntent(value: unknown) {
    const preference = parseClientDiagnosticsPreference(value);
    diagnosticsConsentRevision += 1;
    if (preference !== 'granted') {
        diagnosticsDeniedOverride = preference;
        setMainDiagnosticsPreference(preference);
    }
    return diagnosticsConsentRevision;
}

function applyDiagnosticsDeniedOverride(settings: ISettingsData) {
    return diagnosticsDeniedOverride === null || settings.clientDiagnosticsPreference !== 'granted'
        ? settings
        : {
            ...settings,
            clientDiagnosticsPreference: diagnosticsDeniedOverride,
        };
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
    settingsRecoveryNotice ??= {reason};
    try {
        const quarantinePath = await quarantineCorruptFile(storagePath);
        await writeSettingsAtomically(storagePath, getDefaultSettings());
        logger.warn(`Quarantined ${reason} settings at ${quarantinePath ?? storagePath}`);
    } catch (recoveryError) {
        logger.error(`Failed to recover ${reason} settings: ${getErrorMessage(recoveryError)}`, {
            code: 'MAIN_SETTINGS_OPERATION_FAILED',
            context: {},
            cause: recoveryError,
        });
    }
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
            context: {},
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
        assertSupportedSettingsSchema(parsed);
        return applyElectronDefaults(sanitizeSettings(parsed));
    } catch (err) {
        if (err instanceof UnsupportedSettingsSchemaError) {
            logger.error(`Failed to load settings: ${getErrorMessage(err)}`, {
                code: 'MAIN_SETTINGS_OPERATION_FAILED',
                context: {},
                cause: err,
            });
            return recoverSettingsFromStorage(storagePath, 'unsupported');
        }
        logger.error(`Failed to load settings: ${getErrorMessage(err)}`, {
            code: 'MAIN_SETTINGS_OPERATION_FAILED',
            context: {},
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
        return cloneSettings(applyDiagnosticsDeniedOverride(settingsCache));
    }

    if (settingsLoadPromise) {
        return cloneSettings(applyDiagnosticsDeniedOverride(await settingsLoadPromise));
    }

    const generation = settingsCacheGeneration;
    const storagePath = getStoragePath();
    const loadPromise = readSettingsFromStorage(storagePath);
    settingsLoadPromise = loadPromise;
    let parsed: ISettingsData;
    try {
        parsed = await loadPromise;
        if (generation === settingsCacheGeneration) {
            settingsCache = applyDiagnosticsDeniedOverride(parsed);
        }
    } finally {
        if (settingsLoadPromise === loadPromise) {
            settingsLoadPromise = null;
        }
    }
    if (STARTUP_TRACE_ENABLED) {
        logger.info(`[startup] loadSettings file read complete (+${Date.now() - startedAt}ms)`);
    }
    return cloneSettings(applyDiagnosticsDeniedOverride(parsed));
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
    const storagePath = getStoragePath();
    return queueSettingsMutation(async () => {
        const startingConsentRevision = diagnosticsConsentRevision;
        const current = settingsCache
            ? cloneSettings(applyDiagnosticsDeniedOverride(settingsCache))
            : await loadSettings();
        const workingCopy = cloneSettings(current);
        const mutationResult = await mutate(workingCopy);
        let next = sanitizeSettings(
            isRecord(mutationResult)
                ? {
                    ...workingCopy,
                    ...mutationResult,
                }
                : workingCopy,
        );

        let consentIntentRevision = options.diagnosticsConsentRevision;
        if (
            consentIntentRevision === undefined
            && next.clientDiagnosticsPreference !== current.clientDiagnosticsPreference
        ) {
            consentIntentRevision = recordMainDiagnosticsConsentIntent(next.clientDiagnosticsPreference);
        }

        const staleConsentIntent = consentIntentRevision === undefined
            ? startingConsentRevision !== diagnosticsConsentRevision
            : consentIntentRevision !== diagnosticsConsentRevision;
        if (next.clientDiagnosticsPreference === 'granted' && staleConsentIntent) {
            next = sanitizeSettings({
                ...next,
                clientDiagnosticsPreference: diagnosticsDeniedOverride ?? 'unknown',
            });
        }
        if (
            next.clientDiagnosticsPreference !== current.clientDiagnosticsPreference
            && next.clientDiagnosticsPreference !== 'granted'
        ) {
            // Keep later settings writes from reopening a failed revocation
            // from the stale durable snapshot.
            settingsCache = {
                ...current,
                clientDiagnosticsPreference: next.clientDiagnosticsPreference,
            };
        }
        try {
            const hasExplicitGrantIntent = next.clientDiagnosticsPreference === 'granted'
                && consentIntentRevision !== undefined;
            const persistedBeforeGrant = hasExplicitGrantIntent
                ? sanitizeSettings({
                    ...next,
                    clientDiagnosticsPreference: 'denied',
                })
                : next;
            await writeSettingsAtomically(storagePath, persistedBeforeGrant);
            if (next.clientDiagnosticsPreference === 'granted') {
                await waitForMainDiagnosticsTransportReady();
                const consentStillCurrent = consentIntentRevision === undefined
                    ? startingConsentRevision === diagnosticsConsentRevision
                    : consentIntentRevision === diagnosticsConsentRevision;
                if (!consentStillCurrent) {
                    next = sanitizeSettings({
                        ...next,
                        clientDiagnosticsPreference: diagnosticsDeniedOverride ?? 'unknown',
                    });
                    if (
                        !hasExplicitGrantIntent
                        || next.clientDiagnosticsPreference !== persistedBeforeGrant.clientDiagnosticsPreference
                    ) {
                        await writeSettingsAtomically(storagePath, next);
                    }
                } else if (hasExplicitGrantIntent) {
                    await writeSettingsAtomically(storagePath, next);
                    diagnosticsDeniedOverride = null;
                    setMainDiagnosticsPreference(next.clientDiagnosticsPreference);
                } else {
                    setMainDiagnosticsPreference(next.clientDiagnosticsPreference);
                }
            } else {
                setMainDiagnosticsPreference(next.clientDiagnosticsPreference);
            }
        } catch (error) {
            if (consentIntentRevision !== undefined && next.clientDiagnosticsPreference === 'granted') {
                diagnosticsDeniedOverride = 'denied';
                settingsCache = {
                    ...current,
                    clientDiagnosticsPreference: 'denied',
                };
                setMainDiagnosticsPreference('denied');
            }
            throw error;
        }
        settingsCache = next;
        return cloneSettings(next);
    });
}
