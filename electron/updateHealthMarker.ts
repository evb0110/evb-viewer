import { app } from 'electron';
import {
    readFile,
    rm,
    writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { isRecord } from '@contracts/runtimeGuards';
import {
    atomicReplace,
    makeSiblingTempPath,
} from '@electron/utils/atomicReplace';
import { normalizeVersion } from '@electron/updates/versionCompare';

interface IUpdateHealthMarker {
    version: 1;
    pendingVersion: string;
    installRequestedAt: number;
    startupAttempts: number;
}

export const UPDATE_STARTUP_FAILURE_THRESHOLD = 3;
export const UPDATE_SUPPRESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

let markerMutation = Promise.resolve();

function runMarkerMutation<TResult>(action: () => Promise<TResult>) {
    const result = markerMutation.then(action, action);
    markerMutation = result.then(
        () => undefined,
        () => undefined,
    );
    return result;
}

function getMarkerPath() {
    return join(app.getPath('userData'), 'update-health.json');
}

function decodeMarker(value: unknown): IUpdateHealthMarker | null {
    if (
        !isRecord(value)
        || value.version !== 1
        || typeof value.pendingVersion !== 'string'
        || typeof value.installRequestedAt !== 'number'
        || typeof value.startupAttempts !== 'number'
    ) {
        return null;
    }
    return {
        version: 1,
        pendingVersion: value.pendingVersion,
        installRequestedAt: value.installRequestedAt,
        startupAttempts: value.startupAttempts,
    };
}

async function readMarker() {
    try {
        return decodeMarker(JSON.parse(await readFile(getMarkerPath(), 'utf-8')));
    } catch {
        return null;
    }
}

async function writeMarker(marker: IUpdateHealthMarker) {
    const markerPath = getMarkerPath();
    const tempPath = makeSiblingTempPath(markerPath);
    await writeFile(tempPath, JSON.stringify(marker, null, 2), 'utf-8');
    await atomicReplace(tempPath, markerPath);
}

export async function markUpdateInstallPending(pendingVersion: string) {
    await runMarkerMutation(async () => {
        const existingMarker = await readMarker();
        if (existingMarker?.pendingVersion === pendingVersion) {
            return;
        }
        await writeMarker({
            version: 1,
            pendingVersion,
            installRequestedAt: Date.now(),
            startupAttempts: 0,
        });
    });
}

export async function recordPendingUpdateStartup(currentVersion: string) {
    return runMarkerMutation(async () => {
        const marker = await readMarker();
        if (!marker) {
            return null;
        }
        const updated = {
            ...marker,
            startupAttempts: marker.startupAttempts + 1,
        };
        await writeMarker(updated);
        return {
            ...updated,
            installationApplied: normalizeVersion(marker.pendingVersion) === normalizeVersion(currentVersion),
        };
    });
}

export async function markPendingUpdateHealthy(currentVersion: string) {
    return runMarkerMutation(async () => {
        const marker = await readMarker();
        if (!marker || normalizeVersion(marker.pendingVersion) !== normalizeVersion(currentVersion)) {
            return false;
        }
        await rm(getMarkerPath(), {force: true});
        return true;
    });
}

export async function getSuppressedUpdateVersion(currentVersion: string) {
    return runMarkerMutation(async () => {
        const marker = await readMarker();
        if (
            !marker
            || normalizeVersion(marker.pendingVersion) === normalizeVersion(currentVersion)
            || marker.startupAttempts < UPDATE_STARTUP_FAILURE_THRESHOLD
        ) {
            return null;
        }
        if (Date.now() - marker.installRequestedAt >= UPDATE_SUPPRESSION_TTL_MS) {
            await rm(getMarkerPath(), {force: true});
            return null;
        }
        return marker.pendingVersion;
    });
}
