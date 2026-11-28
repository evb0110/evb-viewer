import {readFileSync, statSync} from 'node:fs';
import {join} from 'node:path';
import {app} from 'electron';
import {parseClientDiagnosticsPreference} from '@contracts/diagnostics/diagnosticsPreference';
import {DEFAULT_SETTINGS, migrateSettings, sanitizeSettings} from '@contracts/settings';
import type {ISettingsData} from '@contracts/shared';
import {isRecord} from '@contracts/runtimeGuards';

export interface IStartupSettingsFileIdentity {
    readonly dev: bigint;
    readonly ino: bigint;
    readonly size: bigint;
    readonly mtimeNs: bigint;
}

export interface IStartupSettingsSnapshot {
    readonly settings: ISettingsData;
    readonly identity: IStartupSettingsFileIdentity;
}

function readSettingsFileIdentity(settingsPath: string): IStartupSettingsFileIdentity | null {
    try {
        const fileStat = statSync(settingsPath, {bigint: true});
        return {
            dev: fileStat.dev,
            ino: fileStat.ino,
            size: fileStat.size,
            mtimeNs: fileStat.mtimeNs,
        };
    } catch {
        return null;
    }
}

function sameSettingsFileIdentity(left: IStartupSettingsFileIdentity, right: IStartupSettingsFileIdentity): boolean {
    return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeNs === right.mtimeNs;
}

function isCompleteSettingsSchemaV2(value: unknown): value is ISettingsData {
    if (!isRecord(value) || value.version !== DEFAULT_SETTINGS.version) {
        return false;
    }

    const normalized = sanitizeSettings(value);
    return (Object.keys(DEFAULT_SETTINGS) as Array<keyof ISettingsData>).every(
        (key) => Object.hasOwn(value, key) && value[key] === normalized[key],
    );
}

export function readCompleteSettingsSync(): ISettingsData | null {
    try {
        const settingsPath = join(app.getPath('userData'), 'settings.json');
        const payload: unknown = JSON.parse(readFileSync(settingsPath, 'utf-8'));
        if (!isCompleteSettingsSchemaV2(payload)) {
            return null;
        }
        return migrateSettings(payload);
    } catch {
        return null;
    }
}

export function readStartupSettingsSnapshotSync(): IStartupSettingsSnapshot | null {
    const settingsPath = join(app.getPath('userData'), 'settings.json');
    const before = readSettingsFileIdentity(settingsPath);
    if (before === null) {
        return null;
    }
    const settings = readCompleteSettingsSync();
    if (settings === null) {
        return null;
    }
    const after = readSettingsFileIdentity(settingsPath);
    if (after === null || !sameSettingsFileIdentity(before, after)) {
        return null;
    }
    return {
        settings,
        identity: after,
    };
}

export function isStartupSettingsSnapshotCurrent(snapshot: IStartupSettingsSnapshot): boolean {
    const current = readSettingsFileIdentity(join(app.getPath('userData'), 'settings.json'));
    return current !== null && sameSettingsFileIdentity(snapshot.identity, current);
}

export function readDiagnosticsPreferenceSync() {
    const settings = readCompleteSettingsSync();
    return settings ? parseClientDiagnosticsPreference(settings.clientDiagnosticsPreference) : ('unknown' as const);
}
