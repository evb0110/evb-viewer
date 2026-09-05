// Supplemental macOS Intel and Windows ARM64 channels attach to the GitHub
// release after promotion, per the critical-path rule in docs/releasing.md. Their
// assets are therefore intentionally absent from the immutable SHA256SUMS
// core set, and release verification must tolerate them on repair reruns.
// With a release version the exemption is the exact expected asset name;
// the pattern fallback exists only for callers without version context.
const SUPPLEMENTAL_RELEASE_ASSET_PATTERNS = [
    /^EVB-Viewer-.+-x64\.zip$/u,
    /^EVB-Viewer-.+-arm64-setup\.exe$/u,
    /^EVB-Viewer-.+-win-arm64-provenance\.json$/u,
];

export function getSupplementalReleaseAssetNames(version) {
    return [
        `EVB-Viewer-${version}-x64.zip`,
        `EVB-Viewer-${version}-arm64-setup.exe`,
        `EVB-Viewer-${version}-win-arm64-provenance.json`,
    ];
}

export function isSupplementalReleaseAsset(fileName, version) {
    if (version !== undefined) {
        if (typeof version !== 'string' || version.trim() === '') {
            throw new Error('Supplemental asset policy requires a non-empty release version when one is supplied');
        }
        return getSupplementalReleaseAssetNames(version).includes(fileName);
    }
    return SUPPLEMENTAL_RELEASE_ASSET_PATTERNS.some(pattern => pattern.test(fileName));
}

export function hasDeveloperIdSigningCredentials(env = process.env) {
    return Boolean(env.CSC_LINK && env.CSC_KEY_PASSWORD);
}

export function hasWindowsSigningCredentials(env = process.env) {
    return Boolean(env.WIN_CSC_LINK && env.WIN_CSC_KEY_PASSWORD);
}

// Keep the native-save dependency graph in one place. The CI workflow mirrors
// these paths in its push trigger because GitHub evaluates that trigger before
// JavaScript can run; the policy tests require the two lists to stay aligned.
export const NATIVE_PDF_SAVE_DEPENDENCY_PATHS = Object.freeze([
    '.github/workflows/ci.yml',
    'app/composables/useAnalytics.ts',
    'app/modules/pdf-viewer/annotations/**',
    'app/modules/pdf-viewer/engine/**',
    'app/modules/pdf-viewer/public.ts',
    'app/modules/pdf-viewer/runtime/save/**',
    'app/modules/workspace-shell/automation/automationReadinessEvents.ts',
    'app/modules/workspace-shell/composables/document-session/**',
    'app/modules/workspace-shell/composables/document-session/createDocumentPersistResults.ts',
    'app/modules/workspace-shell/composables/document-session/createDocumentPersistence.ts',
    'app/modules/workspace-shell/composables/document-session/nativePdfMutationCommit.ts',
    'app/modules/workspace-shell/composables/file-operations/**',
    'app/modules/workspace-shell/composables/file-operations/useWorkspaceSaveService.ts',
    'app/modules/workspace-shell/composables/file-operations/workspaceSaveExecutionResult.ts',
    'app/modules/workspace-shell/composables/file-operations/workspaceSavePlan.ts',
    'app/modules/workspace-shell/composables/file-operations/workspaceSaveTransactionRequest.ts',
    'app/modules/workspace-shell/composables/usePageSaveOrchestration.ts',
    'app/modules/workspace-shell/composables/usePdfFile.ts',
    'app/modules/workspace-shell/composables/useWorkspaceFailureSurface.ts',
    'app/modules/workspace-shell/composables/nativePdfMutationArtifact.ts',
    'app/modules/workspace-shell/public/nativePdfMutationArtifact.ts',
    'app/modules/workspace-shell/viewers/workspaceDocumentDriver.ts',
    'app/platform/browser-api/public.ts',
    'app/platform/browser/browserDocumentConstants.ts',
    'app/services/pdf-file/**',
    'app/types/documentOperationKind.ts',
    'app/types/**',
    'app/types/pdfContracts.ts',
    'app/types/pdfUi.ts',
    'app/utils/asyncGuard.ts',
    'app/utils/browserLogger.ts',
    'app/utils/**',
    'app/utils/documentBytes.ts',
    'app/utils/documentRef.ts',
    'app/utils/error.ts',
    'app/utils/pdfDate.ts',
    'app/utils/platformDocuments.ts',
    'electron/features/documents/createDocumentsPreloadFileClient.ts',
    'electron/features/documents/createDocumentsService.ts',
    'electron/features/documents/contract.ts',
    'electron/features/documents/documentsIpcCodecs.ts',
    'electron/features/documents/documentsService.ts',
    'electron/features/documents/**',
    'electron/features/documents/registerDocumentsIpcAdapter.ts',
    'electron/features/documents/serializedPdfPersistenceContract.ts',
    'electron/file-access/**',
    'electron/preload/createElectronApi.ts',
    'electron/preload/**',
    'electron/platform-ipc/**',
    'native/pdf-page-ops/**',
    'native/evb-native-support/**',
    'packages/contracts/documentPersistenceFrames.ts',
    'packages/contracts/**',
    'packages/contracts/document*.ts',
    'packages/contracts/documentsPersistenceSchemas.ts',
    'packages/contracts/documentsPlatformFeatureSchemas.ts',
    'packages/contracts/electronApiDocuments.ts',
    'packages/contracts/nativePdfMutations.ts',
    'packages/pdf-core/**',
    'packages/pdf-core/nativePdfMutationPolicy.ts',
    'scripts/build-native-tool.mjs',
    'scripts/ci/runElectronQuarantine.ts',
    'scripts/ci/stageExactPdfFixture.ts',
    'tests/e2e/electron/blockingPdfSaveSmoke.e2e.test.ts',
    'tests/e2e/electron/largePdfAnnotationSave.e2e.test.ts',
    'tests/e2e/electron/nativeSaveReopen.e2e.test.ts',
    'tests/e2e/electron/savePipeline.e2e.test.ts',
    'tests/e2e/electron/xlargeDocumentAcceptance.e2e.test.ts',
    'tests/integration/native/**',
    'tests/unit/app/services/pdf-save/**',
    'tests/unit/electron/documentFileWriteAtomic*.test.ts',
]);

const GATE_POLICY_MANIFEST = Object.freeze({
    ci: {changedAreas: {
        browserIntegration: {
            output: 'browser_integration',
            owner: 'pr_browser_integration',
            paths: [
                'app/**',
                'drizzle/**',
                'packages/**',
                'public/**',
                'vendor/**',
                'scan-cleanup-adapters/**',
                'scan-cleanup-core/**',
                'server/**',
                'nuxt.config.ts',
                'tests/integration/browser/**',
                // Browser specs mount real components through the shared test
                // helpers and the shared unit setup file, so those are part of
                // this job's input graph too.
                'tests/helpers/**',
                'tests/setup.ts',
                'tests/fixtures/electron/generated-text.pdf',
                'tsconfig.base.json',
                'tsconfig.json',
                'tsconfig.workspace-paths.json',
                'vitest.config.ts',
                'vitest.shared.config.ts',
                'package.json',
                'pnpm-lock.yaml',
                'patches/**',
            ],
        },
        scanCleanupExport: {
            output: 'scan_cleanup_export',
            owner: 'pr_scan_cleanup_oracles',
            paths: [
                '.github/workflows/**',
                'app/modules/scan-cleanup/**',
                'native/Cargo.lock',
                'native/Cargo.toml',
                'native/evb-native-support/**',
                'native/evb-raster-io/**',
                'native/jbig2-codec/**',
                'native/pdf-image-combine/**',
                'native/scan-cleanup/**',
                'native/scan-primitives/**',
                'packages/contracts/**',
                'public/wasm/evb-pdf-image-combine.wasm',
                'scan-cleanup-adapters/**',
                'scan-cleanup-core/**',
                'scripts/build-native-tool.mjs',
                'scripts/cargo-artifacts.mjs',
                'scripts/ci-install-dependencies.mjs',
                'scripts/ci/apt-install.sh',
                'scripts/ci/classify-changed-areas.mjs',
                'scripts/ci/scan-cleanup-oracles.sh',
                'scripts/diagnostics/load-grayscale-image.mjs',
                'scripts/diagnostics/scan-cleanup-**',
                'scripts/diagnostics/stroke-weight-oracle/**',
                'scripts/flattenLayeredManifestPage.ts',
                'scripts/native-rust-targets.mjs',
                'scripts/nativeResourceManifest.ts',
                'scripts/release/policy.mjs',
                'scripts/scan-cleanup-**',
                'scripts/scanCleanup*.ts',
                'scripts/validation-gates.mjs',
                'tests/fixtures/electron/test-scanned.pdf',
                'package.json',
                'pnpm-lock.yaml',
                'patches/**',
                'pnpm-workspace.yaml',
                'rust-toolchain.toml',
                'tsconfig.base.json',
                'tsconfig.json',
                'tsconfig.scripts.json',
                'tsconfig.workspace-paths.json',
            ],
        },
        electronSmoke: {
            output: 'electron_smoke',
            owner: 'pr_electron_blocking_smoke',
            paths: [
                'app/**',
                'drizzle/**',
                'electron/**',
                'packages/**',
                'public/pdf/**',
                'vendor/**',
                'scan-cleanup-adapters/**',
                'scan-cleanup-core/**',
                'resources/**',
                'tests/e2e/electron/**',
                'scripts/build-electron.mjs',
                'scripts/electron-run/**',
                'scripts/electron-run-headless.sh',
                'scripts/electronRun.ts',
                'electron-builder.yml',
                'nuxt.config.ts',
                'package.json',
                'pnpm-lock.yaml',
                'patches/**',
                'vitest.config.ts',
                'vitest.shared.config.ts',
                // Native save changes also need the controlled pressure save
                // in blocking smoke, not only the focused reopen lane.
                ...NATIVE_PDF_SAVE_DEPENDENCY_PATHS,
            ],
        },
        nativePdfSave: {
            output: 'electron_save_reopen',
            owner: 'pr_electron_native_save_reopen',
            paths: [...NATIVE_PDF_SAVE_DEPENDENCY_PATHS],
        },
        // The packaged core-PDF journey used to run only inside release
        // builds, so a change to the verifier or to packaging was first
        // executed during a release cut (v0.1.447 and v0.1.448 both failed
        // on all four platforms from verifier-only mistakes). This lane
        // runs the same build-target.yml Linux job on push CI whenever the
        // proof itself or the packaging pipeline changes.
        packagedSmoke: {
            output: 'packaged_smoke',
            owner: 'pr_packaged_linux',
            paths: [
                '.github/actions/setup-release-env/**',
                '.github/workflows/build.yml',
                '.github/workflows/build-target.yml',
                '.github/workflows/ci.yml',
                'electron-builder.yml',
                'native/pdf-page-ops/**',
                'package.json',
                'pnpm-lock.yaml',
                'scripts/afterPack.cjs',
                'scripts/afterSign.cjs',
                'scripts/bundle-tools-linux.sh',
                'scripts/ci/classify-changed-areas.mjs',
                'scripts/electron-run/electronRunProcessTree.ts',
                'scripts/release/policy.mjs',
                'scripts/release/assert-build-artifacts.mjs',
                'scripts/release/assert-linux-glibc-baseline.mjs',
                'scripts/release/assert-packaged-app-contents.mjs',
                'scripts/release/assertNoPackagedRendererFailures.ts',
                'scripts/release/verifyPackagedCorePdfSmoke.ts',
                'scripts/release/waitForPackagedCdpEndpoint.ts',
                'scripts/verify-packaged-native-tools.sh',
                'tests/e2e/electron/helpers/**',
            ],
        },
        landing: {
            output: 'landing',
            owner: 'pr_landing_quality',
            paths: [
                'landing/**',
                'packages/contracts/**',
                'packages/i18n-core/**',
                'packages/release-selection/**',
                'package.json',
                'pnpm-lock.yaml',
                'patches/**',
                'pnpm-workspace.yaml',
                'scripts/ci/classify-changed-areas.mjs',
                'scripts/release/policy.mjs',
                '.github/workflows/**',
            ],
        },
        nativeOrBuild: {
            output: 'native_or_build',
            owner: 'pr_native_build_safety',
            paths: [
                '.github/actions/**',
                '.github/workflows/**',
                'build/**',
                'native/**',
                'resources/**',
                'server/**',
                'scripts/afterPack.cjs',
                'scripts/afterSign.cjs',
                'scripts/bundle-*.sh',
                'scripts/build-*.mjs',
                'scripts/build-*.sh',
                'scripts/cargo-artifacts.mjs',
                'scripts/check-build-*.mjs',
                'scripts/check-drizzle-schema.mjs',
                'scripts/check-electron-builder-asar-unpack.mjs',
                'scripts/check-native-tools-source-matrix.sh',
                'scripts/checkSearchNativeParity.ts',
                'scripts/check-wasm-freshness.mjs',
                'scripts/ci/classify-changed-areas.mjs',
                'scripts/ci/scan-cleanup-oracles.sh',
                'scripts/generateBuildArtifacts.ts',
                'scripts/generateElectronBuilderResources.ts',
                'scripts/generateNativeToolProtocols.ts',
                'scripts/generateReleaseTargetManifest.ts',
                'scripts/native-rust-targets.mjs',
                'scripts/nativeResourceManifest.ts',
                'scripts/nativeResourceManifestCli.ts',
                'scripts/generate-djvu-fidelity-corpus.mjs',
                'scripts/prune-build-artifacts.mjs',
                'scripts/release/**',
                'scripts/run-workspace-package-typecheck.mjs',
                'scripts/run-build-strict.mjs',
                'scripts/fixtures/ocr-quality-corpus.json',
                'scripts/ocrQualityMetrics.mjs',
                'scripts/test-ocr-native-smoke.mjs',
                'scripts/test-ocr-quality-corpus.mjs',
                'scripts/verify-packaged-native-tools.sh',
                'scripts/verify-packaged-startup.sh',
                'scripts/writeGeneratedFileIfChanged.ts',
                'scripts/wasm-artifacts.mjs',
                'scripts/workspace-roots.mjs',
                'tests/integration/native/**',
                'electron-builder.yml',
                'package.json',
                'pnpm-lock.yaml',
                'patches/**',
                'pnpm-workspace.yaml',
                'rust-toolchain.toml',
                'types/**',
                // Keep native integration and build safety coupled to the
                // same save graph that drives the Electron reopen lane.
                ...NATIVE_PDF_SAVE_DEPENDENCY_PATHS,
            ],
        },
    }},
    validation: {
        impacts: {
            app: {paths: [
                'app/**',
                'drizzle/**',
                'scan-cleanup-adapters/**',
                'scan-cleanup-core/**',
                'nuxt.config.ts',
                'public/pdf/**',
                'vendor/**',
                'tsconfig.json',
                'tsconfig.base.json',
                'tsconfig.workspace-paths.json',
            ]},
            build: {paths: [
                'electron-builder.yml',
                'nuxt.config.ts',
                'resources/**',
                'scripts/build-*.mjs',
                'scripts/generateBuildArtifacts.ts',
                'scripts/generateElectronBuilderResources.ts',
                'scripts/prune-build-artifacts.mjs',
                'scripts/release/**',
                'scripts/run-build-strict.mjs',
                'public/pdf/**',
                'vendor/**',
            ]},
            docs: {paths: [
                '*.md',
                'docs/**',
            ]},
            electron: {paths: [
                'electron/**',
                'scripts/electron-run/**',
                'scripts/electron-run-headless.sh',
                'scripts/electronRun.ts',
                'tests/e2e/electron/**',
                'public/pdf/**',
                'vendor/**',
            ]},
            landing: {paths: ['landing/**']},
            native: {paths: [
                'native/**',
                'rust-toolchain.toml',
                'scripts/build-native-tool.mjs',
                'scripts/cargo-artifacts.mjs',
                'scripts/check-native-tools-source-matrix.sh',
                'scripts/generateNativeToolProtocols.ts',
                'scripts/native-rust-targets.mjs',
                'scripts/nativeResourceManifest.ts',
                'scripts/nativeResourceManifestCli.ts',
                'scripts/verify-packaged-native-tools.sh',
            ]},
            packages: {paths: ['packages/**']},
            policy: {paths: [
                '.github/**',
                '.husky/**',
                '.fallowrc.json',
                '.vercelignore',
                'eslint-plugin-custom.mjs',
                'eslint.config.mjs',
                'package.json',
                'pnpm-lock.yaml',
                'patches/**',
                'pnpm-workspace.yaml',
                'vendor/**',
                'scripts/ci/**',
                'scripts/release/policy.mjs',
                'scripts/run-nuxt-typecheck.mjs',
                'scripts/run-ts7-typecheck.mjs',
                'scripts/run-workspace-package-typecheck.mjs',
                'scripts/validation-gates.mjs',
                'stylelint.config.mjs',
                'tsconfig*.json',
                'vitest.config.ts',
                'vitest.shared.config.ts',
            ]},
            scripts: {paths: ['scripts/**']},
            server: {paths: ['server/**']},
            tests: {paths: ['tests/**']},
            webDeploy: {paths: [
                '.vercelignore',
                'app/**',
                'scan-cleanup-adapters/**',
                'scan-cleanup-core/**',
                'nuxt.config.ts',
                'package.json',
                'pnpm-lock.yaml',
                'patches/**',
                'public/**',
                'vendor/**',
                'scripts/check-web-deploy-source.mjs',
                'scripts/deployVercelPrivate.mjs',
                'server/**',
                'vercel.json',
            ]},
        },
        owner: 'validation',
    },
    release: {
        localChecks: {
            gateGroups: [{
                id: 'lint-static',
                owner: 'release',
                scripts: [
                    'check:drizzle-schema',
                    'check:electron:install',
                    'check:electron-builder:asar-unpack',
                ],
            }],
            owner: 'release',
        },
        localVerify: {
            gates: [
                {
                    args: [
                        'run',
                        'release:verify:checks',
                    ],
                    command: 'pnpm',
                    id: 'checks',
                    owner: 'release',
                },
                {
                    args: [
                        'run',
                        'release:verify:package:local',
                    ],
                    command: 'pnpm',
                    id: 'package-local',
                    owner: 'release',
                },
            ],
            owner: 'release',
        },
    },
    schemaVersion: 2,
});

function cloneGateCommand(gate) {
    return {
        args: [...gate.args],
        command: gate.command,
    };
}

export function getGatePolicyManifest() {
    return {
        ci: {changedAreas: Object.fromEntries(
            Object.entries(GATE_POLICY_MANIFEST.ci.changedAreas).map(([
                area,
                policy,
            ]) => [
                area,
                {
                    output: policy.output,
                    owner: policy.owner,
                    paths: [...policy.paths],
                },
            ]),
        )},
        release: {
            localChecks: {
                gateGroups: GATE_POLICY_MANIFEST.release.localChecks.gateGroups.map(group => ({
                    id: group.id,
                    owner: group.owner,
                    scripts: [...group.scripts],
                })),
                owner: GATE_POLICY_MANIFEST.release.localChecks.owner,
            },
            localVerify: {
                gates: GATE_POLICY_MANIFEST.release.localVerify.gates.map(gate => ({
                    ...cloneGateCommand(gate),
                    id: gate.id,
                    owner: gate.owner,
                })),
                owner: GATE_POLICY_MANIFEST.release.localVerify.owner,
            },
        },
        validation: {
            impacts: Object.fromEntries(
                Object.entries(GATE_POLICY_MANIFEST.validation.impacts).map(([
                    impact,
                    policy,
                ]) => [
                    impact,
                    {paths: [...policy.paths]},
                ]),
            ),
            owner: GATE_POLICY_MANIFEST.validation.owner,
        },
        schemaVersion: GATE_POLICY_MANIFEST.schemaVersion,
    };
}

export function getNativeOrBuildChangedAreaPaths() {
    return [...GATE_POLICY_MANIFEST.ci.changedAreas.nativeOrBuild.paths];
}

export function getNativePdfSaveDependencyPaths() {
    return [...NATIVE_PDF_SAVE_DEPENDENCY_PATHS];
}

export function getCiChangedAreaPolicy() {
    return getGatePolicyManifest().ci.changedAreas;
}

export function getValidationImpactPolicy() {
    return getGatePolicyManifest().validation.impacts;
}

export function getLocalReleaseCheckGateScripts() {
    return GATE_POLICY_MANIFEST.release.localChecks.gateGroups
        .flatMap(group => group.scripts);
}

export function getLocalReleaseVerifyGateCommands() {
    return GATE_POLICY_MANIFEST.release.localVerify.gates.map(cloneGateCommand);
}

export function expectsUpdaterMetadata(target, env = process.env) {
    if (!target.expectsUpdaterMetadata) {
        return false;
    }

    if (target.platform === 'mac' && !hasMacPublishUpdaterMetadataPolicy(env)) {
        return false;
    }
    if (target.platform === 'win' && !hasWindowsPublishUpdaterMetadataPolicy(env)) {
        return false;
    }

    return true;
}

export function detectHostReleasePlatform(nodePlatform = process.platform) {
    switch (nodePlatform) {
        case 'darwin':
            return 'mac';
        case 'linux':
            return 'linux';
        case 'win32':
            return 'win';
        default:
            throw new Error(`Unsupported local release platform "${nodePlatform}"`);
    }
}

export function getLocalReleaseTargets(options = {}) {
    const platform = detectHostReleasePlatform(options.platform ?? process.platform);
    const arch = options.arch ?? process.arch;

    if (arch !== 'arm64' && arch !== 'x64') {
        throw new Error(`Unsupported local release arch "${arch}"`);
    }

    // Local packaging verifies the current host package only. Cross-arch macOS
    // packages require matching bundled native-tool resources and are covered by
    // the GitHub release/build matrix on the corresponding runner architecture.
    const targetArchs = [arch];

    return targetArchs.map((targetArch) => ({
        arch: targetArch,
        expectsUpdaterMetadata: (
            (platform === 'mac' && targetArch === 'arm64')
            || (platform === 'win' && targetArch === 'x64')
        ),
        isPrimaryHostTarget: targetArch === arch,
        platform,
    }));
}

export function getRequiredArtifactPatterns(target, env = process.env) {
    switch (target.platform) {
        case 'mac':
            if (target.arch === 'x64') {
                return [ /\.zip$/ ];
            }

            // Unsigned local mac verification prunes updater metadata; the DMG
            // is the release-critical manual-install artifact in that mode.
            return expectsUpdaterMetadata(target, env)
                ? [
                    /\.dmg$/,
                    /\.zip$/,
                ]
                : [ /\.dmg$/ ];
        case 'linux':
            return [
                /\.AppImage$/,
                /\.deb$/,
            ];
        case 'win':
            return [ /\.exe$/ ];
        default:
            return [];
    }
}

export function shouldVerifyPackagedStartup(target, env = process.env) {
    return target.platform === 'mac' && hasDeveloperIdSigningCredentials(env);
}

export function hasMacPublishUpdaterMetadataPolicy(env = process.env) {
    if (env.EVB_RELEASE_HAS_MAC_SIGNING === 'true') {
        return true;
    }
    if (env.EVB_RELEASE_HAS_MAC_SIGNING === 'false') {
        return false;
    }
    return hasDeveloperIdSigningCredentials(env);
}

export function hasWindowsPublishUpdaterMetadataPolicy(env = process.env) {
    if (env.EVB_RELEASE_HAS_WINDOWS_SIGNING === 'true') {
        return true;
    }
    if (env.EVB_RELEASE_HAS_WINDOWS_SIGNING === 'false') {
        return false;
    }
    return hasWindowsSigningCredentials(env);
}

export function assertPublishUpdaterMetadataPolicy(artifactNames, env = process.env) {
    const files = [...artifactNames];
    const hasMacPolicy = hasMacPublishUpdaterMetadataPolicy(env);
    const hasWindowsPolicy = hasWindowsPublishUpdaterMetadataPolicy(env);
    const forbidden = files.filter((fileName) => {
        if (/^latest-mac.*\.yml$/u.test(fileName)) {
            return !hasMacPolicy;
        }
        if (/^latest(?:-win(?:-.*)?)?\.yml$/u.test(fileName)) {
            return !hasWindowsPolicy;
        }
        if (/^latest.*\.yml$/u.test(fileName)) {
            return true;
        }
        if (fileName.endsWith('.dmg.blockmap') || fileName.endsWith('.zip.blockmap')) {
            return !hasMacPolicy;
        }
        if (fileName.endsWith('.exe.blockmap')) {
            return !hasWindowsPolicy;
        }
        return fileName.endsWith('.blockmap');
    });

    if (forbidden.length > 0) {
        throw new Error(
            'Release artifacts include updater metadata forbidden by publish policy: '
            + forbidden.sort().join(', '),
        );
    }
}

export function getUpdaterMetadataFileNames(artifactNames) {
    return [...artifactNames].filter(fileName => /^latest.*\.yml$/u.test(fileName));
}

export function parseUpdaterMetadataVersion(metadataFileName, metadataText) {
    const versionLine = metadataText
        .split(/\r?\n/u)
        .find(line => /^version:\s*/u.test(line));
    if (!versionLine) {
        throw new Error(`Missing version entry in ${metadataFileName}`);
    }
    const match = versionLine.match(/^version:\s*(?:"([^"]+)"|'([^']+)'|([^#\s]+))\s*(?:#.*)?$/u);
    if (!match) {
        throw new Error(`Unsupported version entry in ${metadataFileName}: ${versionLine}`);
    }
    return match[1] ?? match[2] ?? match[3];
}

export function assertUpdaterMetadataVersion(artifactNames, readMetadataText, expectedVersion) {
    for (const metadataFileName of getUpdaterMetadataFileNames(artifactNames)) {
        const actualVersion = parseUpdaterMetadataVersion(metadataFileName, readMetadataText(metadataFileName));
        if (actualVersion !== expectedVersion) {
            throw new Error(
                `Updater metadata version mismatch in ${metadataFileName}: expected ${expectedVersion}, got ${actualVersion}`,
            );
        }
    }
}

function assertSafeArtifactReference(metadataFileName, artifactPath) {
    if (
        artifactPath.startsWith('/')
        || /^[A-Za-z]:[\\/]/u.test(artifactPath)
        || artifactPath.split(/[\\/]/u).some(segment => segment === '' || segment === '.' || segment === '..')
    ) {
        throw new Error(`Unsafe path entry in ${metadataFileName}: ${artifactPath}`);
    }

    return artifactPath;
}

export function parseUpdaterMetadataPath(metadataFileName, metadataText) {
    const pathLine = metadataText
        .split(/\r?\n/u)
        .find(line => /^path:\s*/u.test(line));

    if (!pathLine) {
        throw new Error(`Missing path entry in ${metadataFileName}`);
    }

    const match = pathLine.match(/^path:\s*(?:"([^"]+)"|'([^']+)'|([^#\s]+))\s*(?:#.*)?$/u);
    if (!match) {
        throw new Error(`Unsupported path entry in ${metadataFileName}: ${pathLine}`);
    }

    return assertSafeArtifactReference(metadataFileName, match[1] ?? match[2] ?? match[3]);
}

export function parseUpdaterMetadataFileUrls(metadataFileName, metadataText) {
    const urls = [];

    for (const line of metadataText.split(/\r?\n/u)) {
        const match = line.match(/^\s*(?:-\s*)?url:\s*(?:"([^"]+)"|'([^']+)'|([^#\s]+))\s*(?:#.*)?$/u);
        if (!match) {
            continue;
        }
        urls.push(assertSafeArtifactReference(metadataFileName, match[1] ?? match[2] ?? match[3]));
    }

    return urls;
}

export function assertPublishUpdaterMetadataReferences(artifactNames, readMetadataText) {
    const files = [...artifactNames];
    const artifactSet = new Set(files);
    const metadataFileNames = getUpdaterMetadataFileNames(files);

    if (metadataFileNames.length === 0) {
        return false;
    }

    for (const metadataFileName of metadataFileNames) {
        const metadataText = readMetadataText(metadataFileName);
        const referencedArtifacts = new Set([
            parseUpdaterMetadataPath(metadataFileName, metadataText),
            ...parseUpdaterMetadataFileUrls(metadataFileName, metadataText),
        ]);

        for (const artifactPath of referencedArtifacts) {
            if (!artifactSet.has(artifactPath)) {
                throw new Error(
                    `Updater metadata mismatch in ${metadataFileName} -> ${artifactPath} not found. `
                    + `Available artifacts: ${files.sort().join(', ')}`,
                );
            }
        }
    }

    return true;
}

export function createReleaseVerificationEnvs(baseEnv = process.env) {
    const releaseCiEnv = {
        ...baseEnv,
        CI: 'true',
    };

    return {
        releaseAutomationEnv: {
            ...releaseCiEnv,
            EVB_AUTOMATION_HIDE_WINDOW: '1',
            EVB_AUTOMATION_NO_FOCUS: '1',
        },
        releaseCiEnv,
    };
}

export function getReleaseCiEnv(baseEnv = process.env) {
    return createReleaseVerificationEnvs(baseEnv).releaseCiEnv;
}

export function getReleaseAutomationEnv(baseEnv = process.env) {
    return createReleaseVerificationEnvs(baseEnv).releaseAutomationEnv;
}
