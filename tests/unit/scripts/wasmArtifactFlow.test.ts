import {
    mkdtemp,
    readFile,
    rm,
    writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
    describe,
    expect,
    it,
} from 'vitest';
import { WASM_ARTIFACTS } from '@scripts/wasm-artifacts.mjs';
import {
    buildWasmArtifacts,
    parseWasmArtifactsRequest,
    writeWasmArtifactManifest,
} from '@scripts/build-wasm-artifacts.mjs';
import { stageWasmArtifacts } from '@scripts/stage-wasm-artifacts.mjs';
import {
    computeWasmSourceFingerprint,
    stampWasmArtifact,
} from '@scripts/wasm-fingerprint.mjs';

describe('WASM artifact flow', () => {
    it('accepts pnpm argument separators and resolves canonical output names', () => {
        expect(parseWasmArtifactsRequest([
            '--',
            '--output-dir=.tmp/wasm-artifacts',
        ]).outputDir)
            .toContain(path.join('.tmp', 'wasm-artifacts'));
        const calls: string[][] = [];
        buildWasmArtifacts({
            outputDir: '/tmp/wasm-artifacts',
            run: (_command, args) => {
                calls.push(args);
                return {status: 0};
            },
        });
        expect(calls).toHaveLength(WASM_ARTIFACTS.length);
        expect(calls.map(args => args.at(-1)))
            .toEqual(WASM_ARTIFACTS.map(() => '--output-dir=/tmp/wasm-artifacts'));
    });

    it('stages a clean-cache bundle only when its manifest and source identity match', async () => {
        const inputDir = await mkdtemp(path.join(tmpdir(), 'evb-wasm-flow-'));
        const outputDir = await mkdtemp(path.join(tmpdir(), 'evb-wasm-stage-'));
        try {
            for (const artifact of WASM_ARTIFACTS) {
                const fileName = path.basename(artifact.publicRelativePath);
                const fingerprint = await computeWasmSourceFingerprint(artifact, {rustflags: artifact.rustflags.join(' ')});
                const bytes = stampWasmArtifact(Buffer.from([
                    0,
                    97,
                    115,
                    109,
                    1,
                    0,
                    0,
                    0,
                ]), fingerprint);
                await writeFile(path.join(inputDir, fileName), bytes);
            }
            await writeWasmArtifactManifest(inputDir);
            await stageWasmArtifacts(inputDir, outputDir);
            const stagedSnapshot = new Map(
                await Promise.all(WASM_ARTIFACTS.map(async artifact => {
                    const fileName = path.basename(artifact.publicRelativePath);
                    return [
                        fileName,
                        await readFile(path.join(outputDir, fileName)),
                    ] as const;
                })),
            );
            const stagedBytes = await readFile(path.join(outputDir, 'evb-pdf-page-ops.wasm'));
            expect(stagedBytes.subarray(0, 8)).toEqual(Buffer.from([
                0,
                97,
                115,
                109,
                1,
                0,
                0,
                0,
            ]));
            expect(stagedBytes.length).toBeGreaterThan(8);

            const manifest = JSON.parse(await readFile(path.join(inputDir, 'manifest.json'), 'utf8'));
            manifest.artifacts[0].fingerprint = '0'.repeat(64);
            await writeFile(path.join(inputDir, 'manifest.json'), `${JSON.stringify(manifest)}\n`);
            await expect(stageWasmArtifacts(inputDir, outputDir)).rejects.toThrow('manifest does not match');
            await expectOutputSnapshot(outputDir, stagedSnapshot);

            const firstArtifact = WASM_ARTIFACTS[0];
            const firstFileName = path.basename(firstArtifact.publicRelativePath);
            await writeFile(
                path.join(inputDir, firstFileName),
                stampWasmArtifact(Buffer.from([
                    0,
                    97,
                    115,
                    109,
                    1,
                    0,
                    0,
                    0,
                ]), '0'.repeat(64)),
            );
            await writeWasmArtifactManifest(inputDir);
            await expect(stageWasmArtifacts(inputDir, outputDir)).rejects.toThrow('built from different sources');
            await expectOutputSnapshot(outputDir, stagedSnapshot);
        } finally {
            await rm(inputDir, {
                force: true,
                recursive: true,
            });
            await rm(outputDir, {
                force: true,
                recursive: true,
            });
        }
    });
});

async function expectOutputSnapshot(outputDir: string, snapshot: Map<string, Buffer>) {
    const current = new Map(
        await Promise.all([...snapshot.keys()].map(async fileName => [
            fileName,
            await readFile(path.join(outputDir, fileName)),
        ] as const)),
    );
    expect(current).toEqual(snapshot);
}
