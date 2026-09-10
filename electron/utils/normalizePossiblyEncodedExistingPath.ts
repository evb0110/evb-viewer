import { realpathSync } from 'fs';
import { resolve } from 'path';

function decodeURIComponentRepeatedly(value: string, maxPasses = 3) {
    let decoded = value;

    for (let pass = 0; pass < maxPasses; pass += 1) {
        try {
            const nextDecoded = decodeURIComponent(decoded);
            if (nextDecoded === decoded) {
                break;
            }
            decoded = nextDecoded;
        } catch {
            break;
        }
    }

    return decoded;
}

function repairUtf8BytesReadAsLatin1(value: string) {
    try {
        const repaired = Buffer.from(value, 'latin1').toString('utf8');
        return repaired.includes('\uFFFD') ? null : repaired;
    } catch {
        return null;
    }
}

function addCandidate(candidates: string[], seen: Set<string>, candidate: string | null | undefined) {
    if (!candidate || !candidate.trim() || seen.has(candidate)) {
        return;
    }

    seen.add(candidate);
    candidates.push(candidate);
}

function addTrimmedCandidate(candidates: string[], seen: Set<string>, candidate: string | null | undefined) {
    addCandidate(candidates, seen, candidate?.trim());
}

function getPossiblyEncodedPathCandidates(filePath: string) {
    const candidates: string[] = [];
    const seen = new Set<string>();
    addCandidate(candidates, seen, filePath);

    const decodedPath = decodeURIComponentRepeatedly(filePath);
    addCandidate(candidates, seen, decodedPath);

    for (const candidate of [...candidates]) {
        addCandidate(candidates, seen, repairUtf8BytesReadAsLatin1(candidate));
    }

    for (const candidate of [...candidates]) {
        addTrimmedCandidate(candidates, seen, candidate);
        addTrimmedCandidate(candidates, seen, decodeURIComponentRepeatedly(candidate));
        addTrimmedCandidate(candidates, seen, repairUtf8BytesReadAsLatin1(candidate));
    }

    return candidates;
}

export function normalizePossiblyEncodedExistingPath(filePath: string) {
    for (const candidate of getPossiblyEncodedPathCandidates(filePath)) {
        try {
            return realpathSync.native(resolve(candidate));
        } catch {
            // Try the next representation.
        }
    }

    return null;
}
