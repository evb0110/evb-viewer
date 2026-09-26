#!/usr/bin/env node

import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {getCliErrorMessage} from '../lib/cli-error.mjs';
import {
    planRelease, parseCutReleaseArgs,
} from './cut-release.mjs';

/** @param {'patch'|'minor'|'major'} [level] */
export function runReleasePreflight(level = 'patch') {
    const result = planRelease(level);
    process.stdout.write(`Release preflight passed: ${result.candidateSha} (ci.yml run ${result.candidateCiRunId}) ${result.currentVersion} -> ${result.nextVersion}.\n`);
    return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
    try { runReleasePreflight(parseCutReleaseArgs(process.argv.slice(2))); }
    catch (error) { process.stderr.write(`${getCliErrorMessage(error)}\n`); process.exitCode = 1; }
}
