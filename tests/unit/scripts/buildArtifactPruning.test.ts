import {access, mkdir, mkdtemp, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {describe, expect, it} from 'vitest';

import {pruneBuildArtifacts, pruneDirectory} from '@scripts/prune-build-artifacts.mjs';

describe('build artifact pruning', () => {
    it('preserves traced runtime dependencies while removing app-owned test artifacts', async () => {
        const root = await mkdtemp(path.join(tmpdir(), 'evb-prune-'));
        const runtimeModule = path.join(root, 'node_modules/pkg/lib/test/runtime.js');
        const appTest = path.join(root, 'chunks/tests/unused.js');
        try {
            await mkdir(path.dirname(runtimeModule), {recursive: true});
            await mkdir(path.dirname(appTest), {recursive: true});
            await writeFile(runtimeModule, 'export const ready = true;', 'utf8');
            await writeFile(appTest, 'export const unused = true;', 'utf8');

            await expect(pruneDirectory(root)).resolves.toBe(1);
            await expect(access(runtimeModule)).resolves.toBeUndefined();
            await expect(access(appTest)).rejects.toMatchObject({code: 'ENOENT'});
        } finally {
            await rm(root, {
                force: true,
                recursive: true,
            });
        }
    });

    it('rejects traversal, absolute, and symlinked build roots outside the project', async () => {
        const parent = await mkdtemp(path.join(tmpdir(), 'evb-prune-boundary-'));
        const projectRoot = path.join(parent, 'project');
        const outsideRoot = path.join(parent, 'outside');
        const outsideArtifact = path.join(outsideRoot, 'tests/keep.js');
        try {
            await mkdir(projectRoot, {recursive: true});
            await mkdir(path.dirname(outsideArtifact), {recursive: true});
            await writeFile(outsideArtifact, 'export const keep = true;', 'utf8');

            await expect(
                pruneBuildArtifacts({
                    rootDirectory: projectRoot,
                    roots: ['../outside'],
                }),
            ).rejects.toThrow('outside the project');
            await expect(
                pruneBuildArtifacts({
                    rootDirectory: projectRoot,
                    roots: [outsideRoot],
                }),
            ).rejects.toThrow('outside the project');

            await symlink(outsideRoot, path.join(projectRoot, 'linked-build'), process.platform === 'win32' ? 'junction' : 'dir');
            await expect(
                pruneBuildArtifacts({
                    rootDirectory: projectRoot,
                    roots: ['linked-build'],
                }),
            ).rejects.toThrow('outside the project');
            await expect(access(outsideArtifact)).resolves.toBeUndefined();
        } finally {
            await rm(parent, {
                force: true,
                recursive: true,
            });
        }
    });
});
