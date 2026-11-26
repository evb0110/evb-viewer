import { spawnSync } from 'node:child_process';
import {
    mkdir,
    mkdtemp,
    readFile,
    rm,
    writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    createNativeToolBuildPlan,
    getCargoBuildEnvironment,
    getCargoFingerprintEnvironment,
    parseNativeToolBuildRequest,
} from '@scripts/build-native-tool.mjs';
import {
    computeNativeBuildId,
    getNativeExternalBuildInputs,
} from '@scripts/native-build-id.mjs';
import { createWasmToolBuildPlan } from '@scripts/build-wasm-tool.mjs';
import { getRequestedNativeRustTarget } from '@scripts/native-rust-targets.mjs';
import { getGeneratedNativeToolResource } from '@scripts/nativeResourceManifest';
import { getWasmArtifactsByCrateName } from '@scripts/wasm-artifacts.mjs';
import {
    countWasmBulkMemory,
    lowerWasmBulkMemory,
} from '@scripts/lib/lower-wasm-bulk-memory.mjs';
import { existsSync } from 'node:fs';
import { readFile as readFileBytes } from 'node:fs/promises';

interface ICargoArtifactsModule {
    computeCargoInputFingerprint: (options: {
        cargoArgs: string[];
        environment?: Record<string, string>;
        projectRoot: string;
        sourcePaths: string[];
        toolchain: Record<string, string>;
    }) => Promise<{
        fileCount: number;
        fingerprint: string;
    }>;
    copyCargoArtifactVerified: (sourcePath: string, destinationPath: string) => Promise<{
        byteLength: number;
        sha256: string;
    }>;
    discardCargoBuildFromOtherWrapperFlags: (options: {
        env: NodeJS.ProcessEnv;
        projectRoot: string;
        rustTarget?: string;
        targetDirectory: string;
    }) => void;
    getCargoArtifactPath: (options: {
        fileName: string;
        profile?: string;
        rustTarget?: string;
        targetDirectory: string;
    }) => string;
    parseCargoToolBuildRequest: (argv: string[], usage: string) => {
        dryRun: boolean;
        help: boolean;
        toolId?: string;
    };
    parseCargoTargetDirectory: (metadataOutput: string) => string;
    readValidCargoBuildReceipt: (options: {
        binaryPath: string;
        fingerprint: string;
        receiptPath: string;
    }) => Promise<unknown | null>;
    resolveCargoTargetDirectory: (options: {
        env?: NodeJS.ProcessEnv;
        manifestPath: string;
        projectRoot: string;
        runCommand?: (command: string, args: string[], options: {
            cwd: string;
            encoding: string;
            env: NodeJS.ProcessEnv;
        }) => {
            status: number | null;
            stderr: string;
            stdout: string;
        };
    }) => string;
    writeCargoBuildReceipt: (options: {
        artifact: {
            byteLength: number;
            sha256: string;
        };
        binaryPath: string;
        fileCount: number;
        fingerprint: string;
        receiptPath: string;
        toolchain: Record<string, string>;
    }) => Promise<unknown>;
}

const {
    computeCargoInputFingerprint,
    copyCargoArtifactVerified,
    discardCargoBuildFromOtherWrapperFlags,
    getCargoArtifactPath,
    parseCargoToolBuildRequest,
    parseCargoTargetDirectory,
    readValidCargoBuildReceipt,
    resolveCargoTargetDirectory,
    writeCargoBuildReceipt,
} = await import(
    pathToFileURL(path.join(process.cwd(), 'scripts/cargo-artifacts.mjs')).href
) as ICargoArtifactsModule;

describe('Cargo artifact staging', () => {
    it.each(getNativeExternalBuildInputs('pdf-page-ops'))('invalidates the native build ID and cache when %s changes', async (fontPath) => {
        const root = await mkdtemp(path.join(tmpdir(), 'evb-font-build-id-'));
        const fontPaths = getNativeExternalBuildInputs('pdf-page-ops');
        try {
            for (const relativePath of [
                'native/Cargo.toml',
                'native/Cargo.lock',
                'native/rust-toolchain.toml',
                'native/pdf-page-ops/Cargo.toml',
                'native/pdf-page-ops/src/lib.rs',
                ...fontPaths,
            ]) {
                await mkdir(path.dirname(path.join(root, relativePath)), {recursive: true});
                await writeFile(path.join(root, relativePath), 'original');
            }
            const beforeId = computeNativeBuildId(root, 'pdf-page-ops');
            const options = {
                cargoArgs: ['build'],
                projectRoot: root,
                sourcePaths: getNativeExternalBuildInputs('pdf-page-ops').map(input => path.join(root, input)),
                toolchain: {rustc: 'fixture'},
            };
            const beforeCache = await computeCargoInputFingerprint(options);
            await writeFile(path.join(root, fontPath), 'changed font bytes');
            expect(computeNativeBuildId(root, 'pdf-page-ops')).not.toBe(beforeId);
            expect((await computeCargoInputFingerprint(options)).fingerprint).not.toBe(beforeCache.fingerprint);
        } finally {
            await rm(root, {
                force: true,
                recursive: true,
            });
        }
    });

    it('shares strict CLI parsing across native and WASM tool builders', () => {
        expect(parseCargoToolBuildRequest(['pdf-search'], 'usage')).toEqual({
            dryRun: false,
            help: false,
            toolId: 'pdf-search',
        });
        expect(parseCargoToolBuildRequest([
            'pdf-page-ops',
            '--dry-run',
        ], 'usage')).toEqual({
            dryRun: true,
            help: false,
            toolId: 'pdf-page-ops',
        });
        expect(parseCargoToolBuildRequest(['--help'], 'usage')).toEqual({
            dryRun: false,
            help: true,
        });
        expect(() => parseCargoToolBuildRequest([], 'expected usage')).toThrow('expected usage');
        expect(() => parseCargoToolBuildRequest([
            'one',
            'two',
        ], 'expected usage'))
            .toThrow('expected usage');
        expect(() => parseCargoToolBuildRequest([
            'pdf-page-ops',
            '--output-dir=',
        ], 'expected usage')).toThrow('expected usage');
        expect(() => parseCargoToolBuildRequest([
            'pdf-page-ops',
            '--output-dir=one',
            '--output-dir=two',
        ], 'expected usage')).toThrow('expected usage');
    });

    it('accepts native batches while rejecting ambiguous all-plus-explicit requests', () => {
        expect(parseNativeToolBuildRequest([
            'pdf-search',
            'scan-cleanup',
        ])).toEqual({
            all: false,
            dryRun: false,
            help: false,
            toolIds: [
                'pdf-search',
                'scan-cleanup',
            ],
        });
        expect(parseNativeToolBuildRequest([
            '--all',
            '--dry-run',
        ])).toEqual({
            all: true,
            dryRun: true,
            help: false,
            toolIds: [],
        });
        expect(() => parseNativeToolBuildRequest([
            '--all',
            'pdf-search',
        ])).toThrow('Usage:');
    });

    it('remaps the build folder, cargo home and rustup home out of native and WASM builds', () => {
        // Toolchain homes are absolute paths on the host, so a Windows host gives them a drive letter.
        const cargoHome = path.resolve('/home/dev/cargo home');
        const rustupHome = path.resolve('/opt/rustup');
        const env = {
            CARGO_HOME: cargoHome,
            RUSTFLAGS: '--cfg inherited',
            RUSTUP_HOME: rustupHome,
        };
        const remaps = [
            `--remap-path-prefix=${cargoHome}=/cargo-home`,
            `--remap-path-prefix=${rustupHome}=/rustup-home`,
            '--remap-path-prefix=/work/evb viewer=/evb-viewer',
        ];
        const native = getCargoBuildEnvironment({
            env,
            platform: 'linux',
            projectRoot: '/work/evb viewer',
            runCommand: vi.fn(),
        });
        expect(native.env).toMatchObject({RUSTFLAGS: env.RUSTFLAGS});
        expect(JSON.parse(native.env.EVB_CARGO_RUSTFLAGS)).toEqual([...remaps]);
        const apple = getCargoBuildEnvironment({
            env,
            platform: 'darwin',
            projectRoot: '/work/evb viewer',
            runCommand: vi.fn(),
        });
        expect(JSON.parse(apple.env.EVB_CARGO_RUSTFLAGS)).toEqual([...remaps]);
        expect(JSON.parse(apple.env.EVB_CARGO_APPLE_RUSTFLAGS)).toEqual([
            '-C',
            'link-arg=-Wl,-oso_prefix,/work/evb viewer',
        ]);
        const plan = createWasmToolBuildPlan({
            artifact: getWasmArtifactsByCrateName('pdf-page-ops')[0]!,
            env,
            projectRoot: '/work/evb viewer',
        });
        expect(plan.rustflags).toEqual([
            ...remaps,
            '--cfg',
            'getrandom_backend="custom"',
            '-C',
            'target-feature=+simd128',
        ]);
    });

    it('names installed standard library source by its /rustc commit path, as hosts without it do', () => {
        const sysroot = path.resolve('/opt/rustup/toolchains/1.89.0-aarch64-apple-darwin');
        const runCommand = vi.fn((_command: string, args: string[]) => ({
            status: 0,
            stdout: args[0] === '-vV'
                ? 'rustc 1.89.0\ncommit-hash: 29483883eed69d5fb4db01964cdf2af4d86e9cb2\nhost: aarch64-apple-darwin\n'
                : `${sysroot}\n`,
        }));
        const {env} = getCargoBuildEnvironment({
            env: {RUSTUP_HOME: path.resolve('/opt/rustup')},
            platform: 'linux',
            projectRoot: '/work/evb viewer',
            runCommand,
        });
        // rustc applies the last matching remap, so the source remap follows rustup's.
        expect(JSON.parse(env.EVB_CARGO_RUSTFLAGS).slice(1)).toEqual([
            `--remap-path-prefix=${path.resolve('/opt/rustup')}=/rustup-home`,
            `--remap-path-prefix=${path.join(sysroot, 'lib', 'rustlib', 'src', 'rust')}=/rustc/29483883eed69d5fb4db01964cdf2af4d86e9cb2`,
            '--remap-path-prefix=/work/evb viewer=/evb-viewer',
        ]);
    });

    it('discards a target build compiled under other wrapper flags and keeps one compiled under the same', async () => {
        const targetDirectory = await mkdtemp(path.join(tmpdir(), 'cargo-wrapper-flags-'));
        try {
            const crate = getCargoArtifactPath({
                fileName: 'deps/libcrate.rlib',
                rustTarget: 'wasm32-unknown-unknown',
                targetDirectory,
            });
            const discard = (flags: string) => discardCargoBuildFromOtherWrapperFlags({
                env: {EVB_CARGO_RUSTFLAGS: flags},
                projectRoot: process.cwd(),
                rustTarget: 'wasm32-unknown-unknown',
                targetDirectory,
            });
            await mkdir(path.dirname(crate), {recursive: true});
            await writeFile(crate, 'compiled before the wrapper recorded its flags');
            discard('["--remap-path-prefix=/a=/b"]');
            expect(existsSync(crate)).toBe(false);
            await mkdir(path.dirname(crate), {recursive: true});
            await writeFile(crate, 'compiled under the recorded flags');
            discard('["--remap-path-prefix=/a=/b"]');
            expect(await readFile(crate, 'utf8')).toBe('compiled under the recorded flags');
            discard('["--remap-path-prefix=/a=/c"]');
            expect(existsSync(crate)).toBe(false);
        } finally {
            await rm(targetDirectory, {
                recursive: true,
                force: true,
            });
        }
    });

    it.skipIf(process.platform !== 'win32')('forwards long Windows compiler arguments intact', async () => {
        const directory = await mkdtemp(path.join(tmpdir(), 'cargo-long-args-'));
        try {
            const output = path.join(directory, 'args.json');
            const capture = path.join(directory, 'capture.cjs');
            await writeFile(capture, 'require(\'node:fs\').writeFileSync(process.env.ARG_OUTPUT, JSON.stringify(process.argv.slice(2)))');
            const args = Array.from({length: 150}, (_, index) => `arg ${index} ${'x'.repeat(80)} "quoted"`);
            const {env} = getCargoBuildEnvironment({projectRoot: process.cwd()});
            const result = spawnSync(env.RUSTC_WRAPPER, [
                process.execPath,
                capture,
                ...args,
            ], {
                env: {
                    ...env,
                    ARG_OUTPUT: output,
                },
                encoding: 'utf8',
            });
            expect(result.stderr).toBe('');
            expect(result.status).toBe(0);
            expect(JSON.parse(await readFile(output, 'utf8')).slice(0, args.length)).toEqual(args);
            expect(args.join(' ').length).toBeGreaterThan(8191);
        } finally {
            await rm(directory, {
                recursive: true,
                force: true,
            });
        }
    });

    it('uses an existing Rust wrapper, probes sccache, and safely degrades when unavailable', () => {
        const existing = {RUSTC_WRAPPER: '/custom/wrapper'};
        const configured = getCargoBuildEnvironment({
            env: existing,
            platform: 'linux',
            projectRoot: '/repo',
            runCommand: vi.fn(),
        });
        expect(configured.env.EVB_CARGO_INNER_WRAPPER).toBe('/custom/wrapper');
        expect(configured.env.RUSTC_WRAPPER).toContain('cargo-rustc-wrapper');
        expect(configured.sccache).toBe('configured (/custom/wrapper)');
        const probe = vi.fn(() => ({
            status: 0,
            stdout: 'sccache 0.10.0\n',
        }));
        const cached = getCargoBuildEnvironment({
            env: {EVB_RUST_SCCACHE: '1'},
            platform: 'linux',
            projectRoot: '/repo',
            runCommand: probe,
        });
        expect(cached.env.EVB_CARGO_INNER_WRAPPER).toBe('sccache');
        expect(cached.sccache).toBe('sccache 0.10.0');
        expect(getCargoBuildEnvironment({
            env: {EVB_RUST_SCCACHE: '1'},
            platform: 'linux',
            projectRoot: '/repo',
            runCommand: vi.fn(() => ({
                status: null,
                stdout: '',
            })),
        }).sccache).toBe('unavailable');
        expect(getCargoBuildEnvironment({
            env: {},
            platform: 'linux',
            projectRoot: '/repo',
            runCommand: vi.fn(),
        }).sccache).toBe('disabled');
        expect(getCargoFingerprintEnvironment({
            CARGO_TARGET_DIR: '/target',
            PATH: '/bin',
            RUSTFLAGS: '--cfg receipt',
            SECRET_TOKEN: 'must-not-be-recorded',
        })).toEqual({
            CARGO_TARGET_DIR: '/target',
            RUSTFLAGS: '--cfg receipt',
        });
    });

    it.each([
        'scan-cleanup',
        'pdf-image-combine',
    ] as const)('applies static CRT only to the %s release binary, not its proc-macro dependencies', (toolId) => {
        const target = {
            binaryExtension: '',
            cargoTargetArgs: [],
            platform: 'linux',
            platformArch: 'linux-x64',
        };
        const tool = getGeneratedNativeToolResource(toolId);
        const normal = createNativeToolBuildPlan({
            projectRoot: '/repo',
            target,
            tool,
        });
        const release = createNativeToolBuildPlan({
            projectRoot: '/repo',
            staticLinuxCrt: true,
            target,
            tool,
        });

        expect(normal.cargoArgs[0]).toBe('build');
        expect(normal.cargoArgs).not.toContain('target-feature=+crt-static');
        expect(release.cargoArgs).toEqual([
            'rustc',
            '--manifest-path',
            `native/${toolId}/Cargo.toml`,
            '--release',
            '--locked',
            '--bin',
            `evb-${toolId}`,
            '--',
            '-C',
            'target-feature=+crt-static',
        ]);
    });

    it('builds and stages the host target by name, whatever Cargo defaults to', () => {
        // A CARGO_BUILD_TARGET or config default would send an unnamed build
        // elsewhere and leave an older binary at the unqualified path.
        const plan = createNativeToolBuildPlan({
            projectRoot: '/repo',
            target: getRequestedNativeRustTarget({}, {
                arch: 'x64',
                platform: 'linux',
            }),
            tool: getGeneratedNativeToolResource('scan-cleanup'),
        });
        expect(plan.cargoArgs).toEqual([
            'build',
            '--manifest-path',
            'native/scan-cleanup/Cargo.toml',
            '--release',
            '--locked',
            '--target',
            'x86_64-unknown-linux-gnu',
        ]);
        expect(getCargoArtifactPath({
            fileName: plan.binaryName,
            rustTarget: plan.rustTarget,
            targetDirectory: '/checkout/native/target',
        })).toBe(path.join('/checkout/native/target', 'x86_64-unknown-linux-gnu', 'release', 'evb-scan-cleanup'));
    });

    it('uses Cargo metadata as the authority for a shared workspace target directory', () => {
        const runCommand = vi.fn(() => ({
            status: 0,
            stderr: '',
            stdout: JSON.stringify({target_directory: '/checkout/native/target'}),
        }));

        expect(resolveCargoTargetDirectory({
            env: {CARGO_TARGET_DIR: '/cache/overridden-target'},
            manifestPath: 'native/pdf-search/Cargo.toml',
            projectRoot: '/checkout',
            runCommand,
        })).toBe('/checkout/native/target');
        expect(runCommand).toHaveBeenCalledWith('cargo', [
            'metadata',
            '--manifest-path',
            'native/pdf-search/Cargo.toml',
            '--format-version',
            '1',
            '--no-deps',
        ], expect.objectContaining({
            cwd: '/checkout',
            env: {CARGO_TARGET_DIR: '/cache/overridden-target'},
        }));
    });

    it('resolves host, cross-target, and WASM artifacts under the metadata target directory', () => {
        expect(getCargoArtifactPath({
            fileName: 'evb-pdf-search',
            targetDirectory: '/checkout/native/target',
        })).toBe(path.join('/checkout/native/target', 'release', 'evb-pdf-search'));
        expect(getCargoArtifactPath({
            fileName: 'evb-pdf-search.exe',
            rustTarget: 'aarch64-pc-windows-msvc',
            targetDirectory: '/shared/cargo-target',
        })).toBe(path.join('/shared/cargo-target', 'aarch64-pc-windows-msvc', 'release', 'evb-pdf-search.exe'));
        expect(getCargoArtifactPath({
            fileName: 'evb_pdf_page_ops.wasm',
            rustTarget: 'wasm32-unknown-unknown',
            targetDirectory: '/checkout/native/target',
        })).toBe(path.join('/checkout/native/target', 'wasm32-unknown-unknown', 'release', 'evb_pdf_page_ops.wasm'));
    });

    it('rejects malformed or non-absolute Cargo metadata paths', () => {
        expect(() => parseCargoTargetDirectory('{')).toThrow('invalid JSON');
        expect(() => parseCargoTargetDirectory(JSON.stringify({target_directory: 'native/target'})))
            .toThrow('absolute target_directory');
    });

    it('proves staged bytes are identical to the Cargo build output', async () => {
        const tempRoot = await mkdtemp(path.join(tmpdir(), 'evb-cargo-artifact-'));
        const sourcePath = path.join(tempRoot, 'native', 'target', 'release', 'evb-pdf-search');
        const destinationPath = path.join(tempRoot, '.tmp', 'pdf-search', 'darwin-arm64', 'bin', 'evb-pdf-search');
        const sourceBytes = Buffer.from('fresh-workspace-binary');

        try {
            await mkdir(path.dirname(sourcePath), {recursive: true});
            await mkdir(path.dirname(destinationPath), {recursive: true});
            await writeFile(sourcePath, sourceBytes);

            await expect(copyCargoArtifactVerified(sourcePath, destinationPath)).resolves.toEqual({
                byteLength: sourceBytes.byteLength,
                sha256: 'e409a299ecb918b9fada7382ed9437d1f7f2918c4ba3e6984be9a2737aff0625',
            });
            await expect(readFile(destinationPath)).resolves.toEqual(sourceBytes);
        } finally {
            await rm(tempRoot, {
                force: true,
                recursive: true,
            });
        }
    });

    it('reuses staged Cargo outputs only for matching content, toolchain, and bytes', async () => {
        const tempRoot = await mkdtemp(path.join(tmpdir(), 'evb-cargo-receipt-'));
        const sourcePath = path.join(tempRoot, 'native', 'crate', 'src', 'main.rs');
        const binaryPath = path.join(tempRoot, '.tmp', 'tool', 'platform', 'bin', 'tool');
        const receiptPath = path.join(tempRoot, '.tmp', 'tool', 'platform', 'build-receipt.json');
        const toolchain = {
            cargo: 'cargo 1',
            rustc: 'rustc 1',
            target: 'host',
        };

        try {
            await mkdir(path.dirname(sourcePath), {recursive: true});
            await mkdir(path.dirname(binaryPath), {recursive: true});
            await writeFile(sourcePath, 'fn main() {}');
            await writeFile(binaryPath, 'binary');
            const input = await computeCargoInputFingerprint({
                cargoArgs: [
                    'build',
                    '--release',
                ],
                projectRoot: tempRoot,
                sourcePaths: [path.dirname(sourcePath)],
                toolchain,
            });
            const artifact = {
                byteLength: 6,
                sha256: '9a3a45d01531a20e89ac6ae10b0b0beb0492acd7216a368aa062d1a5fecaf9cd',
            };
            await writeCargoBuildReceipt({
                artifact,
                binaryPath,
                fileCount: input.fileCount,
                fingerprint: input.fingerprint,
                receiptPath,
                toolchain,
            });
            await expect(readValidCargoBuildReceipt({
                binaryPath,
                fingerprint: input.fingerprint,
                receiptPath,
            })).resolves.toMatchObject({
                artifact,
                inputFingerprint: input.fingerprint,
            });

            await writeFile(sourcePath, 'fn main() { println!("changed"); }');
            const changedInput = await computeCargoInputFingerprint({
                cargoArgs: [
                    'build',
                    '--release',
                ],
                projectRoot: tempRoot,
                sourcePaths: [path.dirname(sourcePath)],
                toolchain,
            });
            expect(changedInput.fingerprint).not.toBe(input.fingerprint);
            const environmentChanged = await computeCargoInputFingerprint({
                cargoArgs: [
                    'build',
                    '--release',
                ],
                environment: {RUSTFLAGS: '--cfg changed'},
                projectRoot: tempRoot,
                sourcePaths: [path.dirname(sourcePath)],
                toolchain,
            });
            expect(environmentChanged.fingerprint).not.toBe(changedInput.fingerprint);
            await expect(readValidCargoBuildReceipt({
                binaryPath,
                fingerprint: changedInput.fingerprint,
                receiptPath,
            })).resolves.toBeNull();

            await writeFile(binaryPath, 'tampered');
            await expect(readValidCargoBuildReceipt({
                binaryPath,
                fingerprint: input.fingerprint,
                receiptPath,
            })).resolves.toBeNull();
        } finally {
            await rm(tempRoot, {
                force: true,
                recursive: true,
            });
        }
    });

    it('derives every native and WASM staging plan from artifact manifests', async () => {
        for (const toolId of [
            'pdf-image-combine',
            'scan-cleanup',
        ]) {
            const tool = getGeneratedNativeToolResource(toolId);
            const plan = createNativeToolBuildPlan({
                projectRoot: '/repo',
                target: {
                    binaryExtension: '.exe',
                    cargoTargetArgs: [
                        '--target',
                        'aarch64-pc-windows-msvc',
                    ],
                    isHostTarget: false,
                    platform: 'win32',
                    platformArch: 'win32-arm64',
                    rustTarget: 'aarch64-pc-windows-msvc',
                },
                tool,
            });
            expect(plan.manifestPath).toBe(`native/${tool.crateName}/Cargo.toml`);
            expect(plan.destinationPath).toBe(path.join(
                '/repo',
                '.tmp',
                tool.stagingName,
                'win32-arm64',
                'bin',
                `${tool.binaryName}.exe`,
            ));
            expect(plan.rustTarget).toBe('aarch64-pc-windows-msvc');
        }

        for (const crateName of [
            'pdf-image-combine',
            'pdf-page-ops',
            'pdf-search',
            'scan-cleanup',
        ]) {
            for (const artifact of getWasmArtifactsByCrateName(crateName)) {
                const plan = createWasmToolBuildPlan({
                    artifact,
                    env: {RUSTFLAGS: '--cfg existing'},
                    projectRoot: '/repo',
                });
                expect(plan.manifestPath).toBe(`native/${crateName}/Cargo.toml`);
                expect(plan.destinationPath).toBe(path.join('/repo', artifact.publicRelativePath));
                expect(plan.requiredExports).toBe(artifact.requiredExports);
                expect(plan.rustflags).toContain('--remap-path-prefix=/repo=/evb-viewer');
                expect(plan.cargoArgs).toContain(artifact.rustTarget);
            }
        }
        expect(getWasmArtifactsByCrateName('scan-cleanup').map(artifact => [
            artifact.publicRelativePath,
            artifact.rustTarget,
        ])).toEqual([
            [
                'public/wasm/evb-scan-cleanup.wasm',
                'wasm32-unknown-unknown',
            ],
            [
                'public/wasm/evb-scan-cleanup-threads.wasm',
                'wasm32-wasip1-threads',
            ],
        ]);
        expect(getWasmArtifactsByCrateName('pdf-search').map(artifact => [
            artifact.publicRelativePath,
            artifact.rustTarget,
        ])).toEqual([
            [
                'public/wasm/evb-pdf-search.wasm',
                'wasm32-unknown-unknown',
            ],
        ]);
        expect(() => getWasmArtifactsByCrateName('not-a-crate')).toThrow(
            'Unknown WASM artifact crate: not-a-crate',
        );
    });
});

// A minimal WebAssembly encoder for the lowering's test modules.
function leb(value: number | bigint, signed = false, width = 0): number[] {
    let remaining = BigInt(value);
    const out: number[] = [];
    for (;;) {
        const byte = Number(remaining & 0x7fn);
        remaining >>= 7n;
        const done = signed
            ? (remaining === 0n && !(byte & 0x40)) || (remaining === -1n && Boolean(byte & 0x40))
            : remaining === 0n;
        if (done && out.length + 1 >= width) {
            out.push(byte);
            return out;
        }
        out.push(byte | 0x80);
        if (done) {
            // Pad a non-minimal encoding with continuation bytes of the sign.
            const fill = signed && remaining === -1n ? 0x7f : 0x00;
            while (out.length + 1 < width) out.push(fill | 0x80);
            out.push(fill);
            return out;
        }
    }
}
const wasmVector = (items: number[][]) => [...leb(items.length), ...items.flat()];
const wasmSection = (id: number, content: number[]) => [id, ...leb(content.length), ...content];
const wasmName = (name: string) => [...leb(name.length), ...Buffer.from(name)];
const wasmModule = (...sections: number[][]) => Uint8Array.from([0x00, 0x61, 0x73, 0x6d, 1, 0, 0, 0, ...sections.flat()]);
const wasmBody = (code: number[], locals: number[][] = []) => {
    const body = [...wasmVector(locals), ...code, 0x0b];
    return [...leb(body.length), ...body];
};
const I32 = 0x7f;
const memoryImport = (name: string, shared: boolean) => [...wasmName('env'), ...wasmName(name), 0x02, ...(shared ? [0x03, 1, 1] : [0x00, 1])];
const MEMORY_COPY = [0xfc, 0x0a, 0x00, 0x00];
const MEMORY_FILL = [0xfc, 0x0b, 0x00];
const get = (local: number) => [0x20, local];
const i32 = (value: number) => [0x41, ...leb(value, true)];

/** A module whose `copy` and `fill` exports run the two bulk instructions on an imported memory. */
function bulkMemoryModule(shared: boolean) {
    return wasmModule(
        wasmSection(1, wasmVector([[0x60, 3, I32, I32, I32, 0]])),
        wasmSection(2, wasmVector([memoryImport('memory', shared)])),
        wasmSection(3, wasmVector([[0], [0]])),
        wasmSection(7, wasmVector([[...wasmName('copy'), 0, 0], [...wasmName('fill'), 0, 1]])),
        wasmSection(10, wasmVector([
            wasmBody([...get(0), ...get(1), ...get(2), ...MEMORY_COPY]),
            wasmBody([...get(0), ...get(1), ...get(2), ...MEMORY_FILL]),
        ])),
    );
}

function instantiate(bytes: Uint8Array<ArrayBuffer>, imports: WebAssembly.Imports) {
    return new WebAssembly.Instance(new WebAssembly.Module(bytes), imports).exports as Record<string, (...args: number[]) => number>;
}

describe('browser WASM bulk memory lowering', () => {
    for (const shared of [false, true]) {
        it(`copies and fills a${shared ? ' shared' : 'n unshared'} memory exactly as memory.copy and memory.fill do`, () => {
            const original = bulkMemoryModule(shared);
            const {bytes, lowered} = lowerWasmBulkMemory(original);
            expect(lowered).toEqual({copy: 1, fill: 1});
            expect(countWasmBulkMemory(bytes)).toEqual({copy: 0, fill: 0});
            const pattern = Uint8Array.from({length: 65536}, (_, index) => (index * 7 + 3) & 0xff);
            const engines = [original, bytes].map((moduleBytes) => {
                const memory = new WebAssembly.Memory({initial: 1, maximum: 1, shared});
                return {memory, exports: instantiate(moduleBytes, {env: {memory}})};
            });
            const end = 65536;
            const cases: Array<['copy' | 'fill', number, number, number]> = [];
            for (let length = 0; length <= 65; length += 1) {
                for (const base of [0, 3, 1000, end - length]) {
                    for (const delta of [-40, -9, -8, -7, -1, 0, 1, 7, 8, 9, 40]) {
                        const source = base + delta;
                        if (source >= 0 && source + length <= end) cases.push(['copy', base, source, length]);
                    }
                    for (const value of [0, 1, 0x7f, 0x80, 0xff, 0x1ab, -1, -128]) cases.push(['fill', base, value, length]);
                }
            }
            cases.push(['copy', end, 0, 0], ['copy', 0, end, 0], ['fill', end, 9, 0]);
            for (const [kind, destination, sourceOrValue, length] of cases) {
                const results = engines.map(({memory, exports}) => {
                    const view = new Uint8Array(memory.buffer);
                    view.set(pattern);
                    exports[kind]!(destination, sourceOrValue, length);
                    return view.slice();
                });
                expect(Buffer.compare(results[0]!, results[1]!), `${kind}(${destination}, ${sourceOrValue}, ${length})`).toBe(0);
            }
            expect(cases.length).toBeGreaterThan(3000);
        });
    }

    it('keeps imports, tables, start, passive segments and indirect calls working', () => {
        const T_VOID = 0;
        const T_LOG = 1;
        const T_RESULT = 2;
        const original = wasmModule(
            wasmSection(1, wasmVector([[0x60, 0, 0], [0x60, 1, I32, 0], [0x60, 0, 1, I32]])),
            wasmSection(2, wasmVector([
                memoryImport('memory', false),
                [...wasmName('env'), ...wasmName('log'), 0x00, T_LOG],
            ])),
            // 1: start, 2: indirect target, 3: run
            wasmSection(3, wasmVector([[T_VOID], [T_RESULT], [T_RESULT]])),
            wasmSection(4, wasmVector([[0x70, 0x00, 1]])),
            wasmSection(7, wasmVector([[...wasmName('run'), 0, 3]])),
            wasmSection(8, leb(1)),
            wasmSection(9, wasmVector([[0x00, ...i32(0), 0x0b, ...wasmVector([[2]])]])),
            wasmSection(12, leb(1)),
            wasmSection(10, wasmVector([
                wasmBody([...i32(100), ...i32(1), 0x36, 0x02, 0x00]),
                wasmBody([...i32(7), 0x10, 0, ...i32(42)]),
                wasmBody([
                    ...i32(200), ...i32(0), ...i32(8), 0xfc, 0x08, 0x00, 0x00, 0xfc, 0x09, 0x00,
                    ...i32(300), ...i32(200), ...i32(8), ...MEMORY_COPY,
                    ...i32(400), ...i32(0x5a), ...i32(4), ...MEMORY_FILL,
                    0xd2, 2, 0x1a,
                    ...i32(0), 0x11, T_RESULT, 0x00,
                ]),
            ])),
            wasmSection(11, wasmVector([[0x01, ...wasmVector([...Buffer.from('ABCDEFGH')].map(byte => [byte]))]])),
        );
        const {bytes} = lowerWasmBulkMemory(original);
        const outcomes = [original, bytes].map((moduleBytes) => {
            const memory = new WebAssembly.Memory({initial: 1});
            const logged: number[] = [];
            const exports = instantiate(moduleBytes, {env: {memory, log: (value: number) => logged.push(value)}});
            return {result: exports.run!(), logged, memory: new Uint8Array(memory.buffer).slice(0, 512)};
        });
        expect(outcomes[0]!.result).toBe(42);
        expect(outcomes[0]!.logged).toEqual([7]);
        expect(Buffer.from(outcomes[0]!.memory.subarray(300, 308)).toString()).toBe('ABCDEFGH');
        expect(outcomes[1]).toEqual(outcomes[0]);
    });

    it('lowers a function body larger than a call can spread', () => {
        const original = wasmModule(
            wasmSection(1, wasmVector([[0x60, 0, 0]])),
            wasmSection(2, wasmVector([memoryImport('memory', false)])),
            wasmSection(3, wasmVector([[0]])),
            wasmSection(10, wasmVector([wasmBody([...new Array(160_000).fill(0x01), ...i32(0), ...i32(1), ...i32(1), ...MEMORY_FILL])])),
        );
        const {bytes, lowered} = lowerWasmBulkMemory(original);
        expect(lowered).toEqual({copy: 0, fill: 1});
        expect(WebAssembly.validate(bytes)).toBe(true);
    });

    it('reads a memory index in a load and refuses bulk memory on another memory', () => {
        const twoMemories = (code: number[]) => wasmModule(
            wasmSection(1, wasmVector([[0x60, 0, 1, I32]])),
            wasmSection(2, wasmVector([memoryImport('m0', false), memoryImport('m1', false)])),
            wasmSection(3, wasmVector([[0]])),
            wasmSection(7, wasmVector([[...wasmName('run'), 0, 0]])),
            wasmSection(10, wasmVector([wasmBody(code)])),
        );
        // i32.load from memory 1 at offset 1404, whose LEB128 bytes read as memory.copy.
        const load = twoMemories([...i32(0), ...i32(5), ...i32(1), ...MEMORY_FILL, ...i32(0), 0x28, 0x40, 0x01, ...leb(1404)]);
        expect(countWasmBulkMemory(load)).toEqual({copy: 0, fill: 1});
        const m0 = new WebAssembly.Memory({initial: 1});
        const m1 = new WebAssembly.Memory({initial: 1});
        new DataView(m1.buffer).setInt32(1404, 123456, true);
        expect(instantiate(lowerWasmBulkMemory(load).bytes, {env: {m0, m1}}).run!()).toBe(123456);
        expect(new Uint8Array(m0.buffer)[0]).toBe(5);

        const fillSecond = twoMemories([...i32(0), ...i32(5), ...i32(1), 0xfc, 0x0b, 0x01, ...i32(0)]);
        expect(() => lowerWasmBulkMemory(fillSecond)).toThrow(/targets memory 1/u);
    });

    it('passes WebAssembly SIMD128 instructions through unchanged and refuses unknown opcodes', () => {
        // v128.const containing bytes that mimic memory.copy (0xfc 0x0a 0x00 0x00),
        // i8x16.shuffle, i8x16.extract_lane_u, v128.load, v128.load8_lane, and memory.fill.
        const simdModule = wasmModule(
            wasmSection(1, wasmVector([[0x60, 0, 1, I32]])),
            wasmSection(2, wasmVector([memoryImport('memory', false)])),
            wasmSection(3, wasmVector([[0]])),
            wasmSection(7, wasmVector([[...wasmName('run'), 0, 0]])),
            wasmSection(10, wasmVector([wasmBody([
                ...i32(0), ...i32(0x11), ...i32(16), ...MEMORY_FILL,
                // v128.const with fake memory.copy bytes inside immediate
                0xfd, 0x0c, 0xfc, 0x0a, 0x00, 0x00, 0xfc, 0x0b, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09,
                // v128.load align=0 offset=0
                ...i32(0), 0xfd, 0x00, 0x00, 0x00,
                // i8x16.add (0x6e, no immediate)
                0xfd, 0x6e,
                // i8x16.extract_lane_u lane 7 (0x16, 1-byte laneidx) -> 0x01 + 0x11 = 0x12
                0xfd, 0x16, 0x07,
            ])])),
        );
        expect(countWasmBulkMemory(simdModule)).toEqual({copy: 0, fill: 1});
        const {bytes, lowered} = lowerWasmBulkMemory(simdModule);
        expect(lowered).toEqual({copy: 0, fill: 1});
        expect(countWasmBulkMemory(bytes)).toEqual({copy: 0, fill: 0});
        const memory = new WebAssembly.Memory({initial: 1});
        expect(instantiate(bytes, {env: {memory}}).run!()).toBe(0x12);

        const unknownGc = wasmModule(
            wasmSection(1, wasmVector([[0x60, 0, 0]])),
            wasmSection(3, wasmVector([[0]])),
            wasmSection(10, wasmVector([wasmBody([0xfb, 0x00])])),
        );
        expect(() => lowerWasmBulkMemory(unknownGc)).toThrow(/Unknown WebAssembly instruction 0xfb/u);

        const unknownSimd = wasmModule(
            wasmSection(1, wasmVector([[0x60, 0, 0]])),
            wasmSection(3, wasmVector([[0]])),
            wasmSection(10, wasmVector([wasmBody([0xfd, ...leb(0x100)])])),
        );
        expect(() => lowerWasmBulkMemory(unknownSimd)).toThrow(/Unknown WebAssembly 0xfd instruction 256/u);
    });

    it('reads five- and ten-byte LEB128 immediates', () => {
        const original = wasmModule(
            wasmSection(1, wasmVector([[0x60, 0, 1, I32]])),
            wasmSection(2, wasmVector([memoryImport('memory', false)])),
            wasmSection(3, wasmVector([[0]])),
            wasmSection(7, wasmVector([[...wasmName('run'), 0, 0]])),
            wasmSection(10, wasmVector([wasmBody([
                0x41, ...leb(0, true, 5), 0x41, ...leb(7, true, 5), 0x41, ...leb(1, true, 5), ...MEMORY_FILL,
                0x42, ...leb(-5n, true, 10), 0xa7,
            ])])),
        );
        const memory = new WebAssembly.Memory({initial: 1});
        expect(instantiate(lowerWasmBulkMemory(original).bytes, {env: {memory}}).run!()).toBe(-5);
        expect(new Uint8Array(memory.buffer)[0]).toBe(7);
    });

    it('traps before writing when a range would wrap past 4 GiB', () => {
        const memory = new WebAssembly.Memory({initial: 1});
        const exports = instantiate(lowerWasmBulkMemory(bulkMemoryModule(false)).bytes, {env: {memory}});
        const before = new Uint8Array(memory.buffer).slice();
        expect(() => exports.copy!(0, 0xffffffff, 2)).toThrow(/unreachable/u);
        expect(() => exports.fill!(0xfffffff8, 0xaa, 16)).toThrow(/unreachable/u);
        expect(Buffer.compare(new Uint8Array(memory.buffer), before)).toBe(0);
    });

    const threadsWasm = path.join(process.cwd(), 'public', 'wasm', 'evb-scan-cleanup-threads.wasm');
    it.skipIf(!existsSync(threadsWasm))('builds the threaded engine without bulk memory instructions', async () => {
        expect(countWasmBulkMemory(new Uint8Array(await readFileBytes(threadsWasm)))).toEqual({copy: 0, fill: 0});
    });
});
