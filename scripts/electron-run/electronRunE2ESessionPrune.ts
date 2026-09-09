import {
    readdirSync,
    rmSync,
    statSync,
} from 'node:fs';
import { join } from 'node:path';
import {getErrorMessage} from '@contracts/getErrorMessage';
import {
    cleanupStaleSessionArtifacts,
    getSessionInfo,
    getSessionStartingInfo,
    type ICleanupStaleSessionArtifactsOptions,
} from '@scripts/electron-run/electronRunSessionArtifacts';
import {
    sessionDir,
    sessionsBaseDir,
} from '@scripts/electron-run/electronRunSessionPaths';
import {hasWorkspaceRecoveryEvidence} from '@scripts/electron-run/electronRunSessionCleanup';

const DEFAULT_STALE_E2E_SESSION_AGE_MS = 24 * 60 * 60 * 1000;

export interface IE2ESessionDirCandidate {
    name: string;
    path: string;
    mtimeMs: number;
}

export interface IStaleE2ESessionPruneResult {
    stale: string[];
    removed: string[];
    refused: Array<{
        name: string;
        reason: string;
    }>;
}

export interface ISelectStaleE2ESessionsOptions {
    nowMs?: number;
    maxAgeMs?: number;
    candidates?: IE2ESessionDirCandidate[];
    cleanupOptions?: ICleanupStaleSessionArtifactsOptions;
}

export function isE2ESessionName(name: string) {
    return /^e2e-[a-zA-Z0-9]/u.test(name);
}

export function assertE2ESessionName(name: string) {
    if (!isE2ESessionName(name)) {
        throw new Error(`Electron E2E operation refused non-isolated session: ${name}`);
    }
    return name;
}

export function selectStaleE2ESessionDirs(
    candidates: IE2ESessionDirCandidate[],
    options: ISelectStaleE2ESessionsOptions = {},
) {
    const nowMs = options.nowMs ?? Date.now();
    const maxAgeMs = options.maxAgeMs ?? DEFAULT_STALE_E2E_SESSION_AGE_MS;
    return candidates
        .filter(candidate => isE2ESessionName(candidate.name))
        .filter(candidate => nowMs - candidate.mtimeMs > maxAgeMs)
        .sort((left, right) => left.mtimeMs - right.mtimeMs);
}

function listE2ESessionDirCandidates(): IE2ESessionDirCandidate[] {
    try {
        return readdirSync(sessionsBaseDir, { withFileTypes: true })
            .filter(entry => entry.isDirectory() && isE2ESessionName(entry.name))
            .map(entry => {
                const path = join(sessionsBaseDir, entry.name);
                return {
                    name: entry.name,
                    path,
                    mtimeMs: statSync(path).mtimeMs,
                };
            });
    } catch {
        return [];
    }
}

export async function pruneStaleE2ESessions(options: ISelectStaleE2ESessionsOptions = {}): Promise<IStaleE2ESessionPruneResult> {
    const stale = selectStaleE2ESessionDirs(options.candidates ?? listE2ESessionDirCandidates(), options);
    const result: IStaleE2ESessionPruneResult = {
        stale: stale.map(candidate => candidate.name),
        removed: [],
        refused: [],
    };

    for (const candidate of stale) {
        let cleanupResult;
        try {
            cleanupResult = await cleanupStaleSessionArtifacts(candidate.name, options.cleanupOptions);
        } catch (error) {
            result.refused.push({
                name: candidate.name,
                reason: getErrorMessage(error),
            });
            continue;
        }
        if (cleanupResult.retained) {
            result.refused.push({
                name: candidate.name,
                reason: cleanupResult.reason ?? 'automatic stale-artifact cleanup retained the session for safety',
            });
            continue;
        }

        try {
            // Cleanup can yield while a new controller recreates metadata. Take
            // a final filesystem snapshot immediately before recursive removal.
            // A changed directory or newly recreated metadata means this stale
            // candidate is no longer safe to delete.
            const beforeRemoval = statSync(sessionDir(candidate.name));
            if (beforeRemoval.mtimeMs !== statSync(sessionDir(candidate.name)).mtimeMs
                || getSessionInfo(candidate.name)
                || getSessionStartingInfo(candidate.name)
                || hasWorkspaceRecoveryEvidence(candidate.name)) {
                result.refused.push({
                    name: candidate.name,
                    reason: 'session metadata changed during cleanup; retained for recovery',
                });
                continue;
            }
            rmSync(sessionDir(candidate.name), {
                recursive: true,
                force: true,
            });
            result.removed.push(candidate.name);
        } catch (error) {
            result.refused.push({
                name: candidate.name,
                reason: getErrorMessage(error),
            });
        }
    }

    return result;
}
