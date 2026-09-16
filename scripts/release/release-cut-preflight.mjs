#!/usr/bin/env node

import { getCliErrorMessage } from '../lib/cli-error.mjs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {
    assertReleaseCutPreconditions,
    parseCutReleaseArgs,
} from './cut-release.mjs';

/** @typedef {'patch' | 'minor' | 'major'} TReleaseLevel */
/** @typedef {{candidateCiRunId: number, candidateCiRunUrl: string, candidateSha: string, currentVersion: string, nextVersion: string, upstream: {ref: string}}} IPreflightResult */
/** @typedef {'mandatory' | 'advisory'} TArtifactEvidencePolicy */
/** @typedef {(options: {artifactEvidence?: TArtifactEvidencePolicy | undefined, context: string, level: TReleaseLevel, requiredCommits: string[]}) => Promise<IPreflightResult>} TAssertPreconditions */

/** @param {string[]} argv @returns {{artifactEvidence?: TArtifactEvidencePolicy | undefined, requiredCommits: string[]}} */
export function parseReleasePreflightArgs(argv) {
    const parsed = parseCutReleaseArgs([
        'patch',
        ...argv,
    ]);
    return {
        artifactEvidence: parsed.artifactEvidence,
        requiredCommits: parsed.requiredCommits,
    };
}

/** @param {{artifactEvidence?: TArtifactEvidencePolicy | undefined, assertPreconditions?: TAssertPreconditions, level?: TReleaseLevel, requiredCommits?: string[], write?: (message: string) => unknown}} [options] @returns {Promise<IPreflightResult>} */
export async function runReleasePreflight({
    artifactEvidence,
    assertPreconditions = assertReleaseCutPreconditions,
    level = 'patch',
    requiredCommits = [],
    write = message => {
        process.stdout.write(message);
    },
} = {}) {
    const result = await assertPreconditions({
        artifactEvidence,
        context: 'Release preflight',
        level,
        requiredCommits,
    });
    const {
        candidateCiRunId,
        candidateCiRunUrl,
        candidateSha,
        currentVersion,
        nextVersion,
        upstream,
    } = result;

    write(
        `Release ${level} preflight passed for candidate ${candidateSha} `
        + `(ci.yml run ${candidateCiRunId}: ${candidateCiRunUrl}): `
        + `${currentVersion} -> ${nextVersion} on ${upstream.ref}.\n`,
    );
    return result;
}

const isMain = process.argv[1]
    && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
    Promise.resolve()
        .then(() => runReleasePreflight(parseReleasePreflightArgs(process.argv.slice(2))))
        .catch(error => {
            process.stderr.write(`${getCliErrorMessage(error)}\n`);
            process.exitCode = 1;
        });
}
