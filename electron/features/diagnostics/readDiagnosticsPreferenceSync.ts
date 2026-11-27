import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {app} from 'electron';
import {parseClientDiagnosticsPreference} from '@contracts/diagnostics/diagnosticsPreference';
import {DEFAULT_SETTINGS, sanitizeSettings} from '@contracts/settings';
import type {ISettingsData} from '@contracts/shared';
import {isRecord} from '@contracts/runtimeGuards';

function isCompleteSettingsSchemaV2(value: unknown): value is ISettingsData {
    if (!isRecord(value) || value.version !== DEFAULT_SETTINGS.version) {
        return false;
    }

    const normalized = sanitizeSettings(value);
    return (Object.keys(DEFAULT_SETTINGS) as Array<keyof ISettingsData>).every(
        (key) => Object.hasOwn(value, key) && value[key] === normalized[key],
    );
}

export function readDiagnosticsPreferenceSync() {
    try {
        const settingsPath = join(app.getPath('userData'), 'settings.json');
        const payload: unknown = JSON.parse(readFileSync(settingsPath, 'utf-8'));
        if (!isCompleteSettingsSchemaV2(payload)) {
            return 'unknown' as const;
        }
        return parseClientDiagnosticsPreference(payload.clientDiagnosticsPreference);
    } catch {
        return 'unknown' as const;
    }
}
