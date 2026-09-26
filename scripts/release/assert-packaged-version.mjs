#!/usr/bin/env node

import {readdirSync} from 'node:fs';
import path from 'node:path';
import {extractFile} from '@electron/asar';

const releaseDir = path.resolve(process.argv[2] ?? 'release');
const expectedVersion = process.argv[3];
if (!expectedVersion) throw new Error('Usage: assert-packaged-version.mjs <release-dir> <version>');
/** @type {string[]} */
const archives = [];
/** @param {string} directory */
function visit(directory) {
    for (const entry of readdirSync(directory, {withFileTypes: true})) {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) visit(file);
        else if (entry.isFile() && entry.name === 'app.asar') archives.push(file);
    }
}
visit(releaseDir);
const archive = archives[0];
if (archives.length !== 1 || archive === undefined) throw new Error(`Expected one packaged app.asar, found ${archives.length}`);
const metadata = JSON.parse(extractFile(archive, 'package.json').toString('utf8'));
if (metadata.version !== expectedVersion) throw new Error(`Packaged app version is ${metadata.version}; expected ${expectedVersion}`);
process.stdout.write(`Packaged app.getVersion() source reports ${expectedVersion}.\n`);
