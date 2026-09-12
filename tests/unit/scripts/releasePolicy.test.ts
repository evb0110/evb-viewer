import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    accessSync,
    chmodSync,
    constants,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import {
    delimiter,
    join,
    resolve,
} from 'node:path';
type TReleaseArch = 'arm64' | 'x64';
type TReleasePlatform = 'linux' | 'mac' | 'win';
type TReleaseEnv = Record<string, string>;
type TRunCommand = (
    command: string,
    args: string[],
    options: IRunCommandOptions,
) => unknown;
type TSleepFn = (duration: number) => Promise<void>;

interface IReleaseTarget {
    arch: string;
    expectsUpdaterMetadata?: boolean;
    isPrimaryHostTarget?: boolean;
    platform: string;
}

interface IReleaseCommand {
    args: string[];
    command: string;
}

interface IReleaseGatePolicyManifest {
    ci: {changedAreas: {
        landing: IChangedAreaPolicy;
        nativeOrBuild: IChangedAreaPolicy;
    };};
    release: {
        localChecks: {
            gateGroups: Array<{
                id: string;
                owner: string;
                scripts: string[];
            }>;
            owner: string;
        };
        localVerify: {
            gates: Array<IReleaseCommand & {
                id: string;
                owner: string;
            }>;
            owner: string;
        };
    };
    schemaVersion: number;
}

interface IChangedAreaPolicy {
    output: string;
    owner: string;
    paths: string[];
}

interface IRunCommandOptions {
    env?: TReleaseEnv;
    stdio?: 'inherit';
}

interface IReleasePolicyModule {
    assertPublishUpdaterMetadataReferences: (
        artifactNames: string[],
        readMetadataText: (fileName: string) => string,
    ) => boolean;
    assertPublishUpdaterMetadataPolicy: (
        artifactNames: string[],
        env?: TReleaseEnv,
    ) => void;
    detectHostReleasePlatform: (nodePlatform?: string) => TReleasePlatform;
    expectsUpdaterMetadata: (
        target: IReleaseTarget,
        env?: TReleaseEnv,
    ) => boolean;
    getLocalReleaseTargets: (options?: {
        arch?: TReleaseArch;
        platform?: NodeJS.Platform;
    }) => IReleaseTarget[];
    getGatePolicyManifest: () => IReleaseGatePolicyManifest;
    getReleaseAutomationEnv: (
        baseEnv?: TReleaseEnv,
    ) => TReleaseEnv;
    getSupplementalReleaseAssetNames: (version: string) => string[];
    getRequiredArtifactPatterns: (
        target: IReleaseTarget,
        env?: TReleaseEnv,
    ) => RegExp[];
    isSupplementalReleaseAsset: (fileName: string, version?: string) => boolean;
    parseUpdaterMetadataFileUrls: (
        metadataFileName: string,
        metadataText: string,
    ) => string[];
    shouldVerifyPackagedStartup: (
        target: IReleaseTarget,
        env?: TReleaseEnv,
    ) => boolean;
}

interface IReleaseChecksModule {
    assertReleaseVerifySkipAcknowledged: (
        skippedScripts: string[],
        options?: { allowSkip?: boolean },
    ) => void;
    getLocalReleaseCheckCommands: () => IReleaseCommand[];
    isReleaseVerifySkipAcknowledged: (options?: {
        argv?: string[];
        env?: TReleaseEnv;
    }) => boolean;
    parseReleaseVerifySkipList: (
        rawSkipList: string | undefined,
        options?: { knownScripts?: string[] },
    ) => string[];
    runLocalReleaseChecks: (options?: {
        allowSkip?: boolean;
        argv?: string[];
        env?: TReleaseEnv;
        runCommand?: TRunCommand;
        skipList?: string;
        stderr?: { write: (message: string) => void };
        validateBuildReceipt?: (
            receiptPath: string,
            options: { env: TReleaseEnv },
        ) => {
            reason?: string;
            valid: boolean;
        };
        writeBuildReceipt?: (receiptPath: string, options: { env: TReleaseEnv }) => unknown;
    }) => void;
}

interface IReleaseVerifySnapshot {
    stagedDiff: string;
    trackedDiff: string;
    untrackedFiles: string[];
}

interface IReleaseVerifyModule {
    assertReleaseVerifyDidNotMutateWorktree: (
        before: IReleaseVerifySnapshot,
        after: IReleaseVerifySnapshot,
    ) => void;
    getLocalReleaseVerifyCommands: () => IReleaseCommand[];
    runLocalReleaseVerify: (options?: {
        env?: TReleaseEnv;
        receiptPath?: string;
        runCommand?: TRunCommand;
        snapshotGetter?: () => IReleaseVerifySnapshot;
    }) => void;
}

interface IReleasePackageModule {
    getLocalReleaseBuildCommand: () => IReleaseCommand;
    getPackagingArgs: (
        target: IReleaseTarget,
        env?: TReleaseEnv,
    ) => string[];
}

interface IAssertBuildArtifactsOptions {
    arch: TReleaseArch;
    artifactNames: string[];
    env?: TReleaseEnv;
    platform: TReleasePlatform;
    readArtifactInfo?: (artifactName: string) => IMacUpdaterFileInfo;
    readMetadataText: (fileName: string) => string;
}

interface IAssertBuildArtifactsModule { assertBuildArtifacts: (options: IAssertBuildArtifactsOptions) => boolean; }

interface IMacUpdaterFileInfo {
    sha512: string;
    size: number;
}

interface IMacDmgNotarizationModule {
    assertMacUpdaterMetadataHashes: (options: {
        artifactNames: string[];
        readArtifactInfo: (artifactName: string) => IMacUpdaterFileInfo;
        readMetadataText: (fileName: string) => string;
    }) => boolean;
    computeArtifactFileInfo: (filePath: string) => IMacUpdaterFileInfo;
    findAppBuilderExecutable: (projectRoot: string, options?: {
        arch?: string;
        env?: TReleaseEnv;
        platform?: NodeJS.Platform;
        projectRoot?: string;
    }) => string;
    notarizeMacDmgArtifacts: (options?: {
        arch?: string;
        artifactsDir?: string;
        env?: TReleaseEnv;
        platform?: NodeJS.Platform;
        projectRoot?: string;
    }) => {
        processed: number;
        skipped: boolean;
    };
    parseMacUpdaterFileEntries: (
        metadataFileName: string,
        metadataText: string,
    ) => Array<{
        sha512: string;
        size: number;
        url: string;
    }>;
    updateMacUpdaterMetadataArtifactInfo: (
        metadataFileName: string,
        metadataText: string,
        artifactName: string,
        fileInfo: IMacUpdaterFileInfo,
    ) => string;
}

interface IReleaseSharedModule {
    PUBLICATION_POLICY_SCRIPT: string;
    getPublicationPolicyCheckArgs: (beforeSha: string, headSha: string) => string[];
    assertGitHubCliReady: (
        workflowName: string,
        options: {
            delayMs: number;
            runCommand: TRunCommand;
            sleepFn: TSleepFn;
            stderr: { write: (message: string) => void };
        },
    ) => Promise<void>;
    assertTagAbsent: (
        tag: string,
        remote: string,
        options: {
            delayMs: number;
            runCommand: TRunCommand;
            sleepFn: TSleepFn;
            stderr: { write: (message: string) => void };
        },
    ) => Promise<void>;
    filterIgnoredFiles: (files: string[], ignoredRoots: string[]) => string[];
    isTransientGitHubAuthError: (error: unknown) => boolean;
    isTransientRemoteGitError: (error: unknown) => boolean;
}

interface ICutReleaseArgs {
    level: string | null;
    resume: boolean;
}

interface IUpstream {
    branch: string;
    remote: string;
}

interface IPublishDependencies {
    dispatchWorkflow?: (options: unknown) => void;
    printHandoff?: (options: unknown) => Promise<void>;
    pushReleaseTag?: (options: unknown, dependencies?: unknown) => void;
    runCommand?: (command: string, args: string[], options?: unknown) => string;
}

interface ICutReleaseModule {
    getReleaseWorkflowDispatchArgs: (options: {
        branch: string;
        tag: string;
        targetSha: string;
    }) => string[];
    parseCutReleaseArgs: (argv: string[]) => ICutReleaseArgs;
    publishReleaseCommit: (
        options: {
            parentSha: string;
            tag: string;
            targetSha: string;
            upstream: IUpstream;
        },
        dependencies: IPublishDependencies,
    ) => Promise<string>;
}

interface IReleaseArtifactsDispatchOptions {
    branch: string;
    targetSha: string;
}

interface IReleaseArtifactsModule {
    getReleaseArtifactsWorkflowDispatchArgs: (options: IReleaseArtifactsDispatchOptions) => string[];
    publishReleaseArtifactsCommit: (
        options: {upstream: IUpstream},
        dependencies: IPublishDependencies,
    ) => Promise<string>;
}

function getPackageScripts(): Record<string, string> {
    const packageJson = JSON.parse(
        readFileSync(resolve(process.cwd(), 'package.json'), 'utf8'),
    ) as { scripts?: Record<string, string> };

    return packageJson.scripts ?? {};
}

const {
    detectHostReleasePlatform,
    assertPublishUpdaterMetadataReferences,
    assertPublishUpdaterMetadataPolicy,
    expectsUpdaterMetadata,
    getGatePolicyManifest,
    getLocalReleaseTargets,
    getReleaseAutomationEnv,
    getRequiredArtifactPatterns,
    getSupplementalReleaseAssetNames,
    isSupplementalReleaseAsset,
    parseUpdaterMetadataFileUrls,
    shouldVerifyPackagedStartup,
} = await import(pathToFileURL(resolve(process.cwd(), 'scripts/release/policy.mjs')).href) as IReleasePolicyModule;
const {
    assertReleaseVerifySkipAcknowledged,
    getLocalReleaseCheckCommands,
    isReleaseVerifySkipAcknowledged,
    parseReleaseVerifySkipList,
    runLocalReleaseChecks,
} = await import(pathToFileURL(resolve(process.cwd(), 'scripts/release/verify-local-checks.mjs')).href) as IReleaseChecksModule;
const {
    assertReleaseVerifyDidNotMutateWorktree,
    getLocalReleaseVerifyCommands,
    runLocalReleaseVerify,
} = await import(pathToFileURL(resolve(process.cwd(), 'scripts/release/verify-local.mjs')).href) as IReleaseVerifyModule;
const {
    getLocalReleaseBuildCommand,
    getPackagingArgs,
} = await import(pathToFileURL(resolve(process.cwd(), 'scripts/release/verify-local-package.mjs')).href) as IReleasePackageModule;
const { assertBuildArtifacts } = await import(pathToFileURL(resolve(process.cwd(), 'scripts/release/assert-build-artifacts.mjs')).href) as IAssertBuildArtifactsModule;
const {
    assertMacUpdaterMetadataHashes,
    computeArtifactFileInfo,
    findAppBuilderExecutable,
    notarizeMacDmgArtifacts,
    parseMacUpdaterFileEntries,
    updateMacUpdaterMetadataArtifactInfo,
} = await import(pathToFileURL(resolve(process.cwd(), 'scripts/release/notarize-macos-dmgs.mjs')).href) as IMacDmgNotarizationModule;
const {
    PUBLICATION_POLICY_SCRIPT,
    assertGitHubCliReady,
    assertTagAbsent,
    filterIgnoredFiles,
    getPublicationPolicyCheckArgs,
    isTransientGitHubAuthError,
    isTransientRemoteGitError,
} = await import(pathToFileURL(resolve(process.cwd(), 'scripts/release/shared.mjs')).href) as IReleaseSharedModule;
const {
    getReleaseWorkflowDispatchArgs,
    parseCutReleaseArgs,
    publishReleaseCommit,
} = await import(pathToFileURL(resolve(process.cwd(), 'scripts/release/cut-release.mjs')).href) as ICutReleaseModule;
const {
    getReleaseArtifactsWorkflowDispatchArgs,
    publishReleaseArtifactsCommit,
} = await import(pathToFileURL(resolve(process.cwd(), 'scripts/release/build-artifacts.mjs')).href) as IReleaseArtifactsModule;

function writeExecutable(filePath: string, lines: string[]): void {
    writeFileSync(filePath, `${lines.join('\n')}\n`);
    chmodSync(filePath, 0o755);
}

function createFakeDmgNotaryTools(binDir: string): string {
    writeExecutable(join(binDir, 'codesign'), [
        '#!/usr/bin/env node',
        'const args = process.argv.slice(2);',
        'if (args[0] === \'-dv\') {',
        '    process.stderr.write(\'not signed\\n\');',
        '    process.exit(1);',
        '}',
        'process.exit(0);',
    ]);

    writeExecutable(join(binDir, 'xcrun'), [
        '#!/usr/bin/env node',
        'const { appendFileSync, existsSync, writeFileSync } = require(\'node:fs\');',
        'const args = process.argv.slice(2);',
        'if (args[0] === \'stapler\' && args[1] === \'validate\') {',
        '    const markerPath = `${args[2]}.stapled`;',
        '    if (existsSync(markerPath)) {',
        '        process.stdout.write(\'valid\\n\');',
        '        process.exit(0);',
        '    }',
        '    process.stderr.write(\'not stapled\\n\');',
        '    process.exit(1);',
        '}',
        'if (args[0] === \'stapler\' && args[1] === \'staple\') {',
        '    appendFileSync(args[2], \'\\nstapled-ticket\\n\');',
        '    writeFileSync(`${args[2]}.stapled`, \'1\');',
        '    process.exit(0);',
        '}',
        'if (args[0] === \'notarytool\' && args[1] === \'submit\') {',
        '    process.stdout.write(JSON.stringify({ id: \'submission-1\' }));',
        '    process.exit(0);',
        '}',
        'if (args[0] === \'notarytool\' && args[1] === \'wait\') {',
        '    process.stdout.write(JSON.stringify({ status: \'Accepted\' }));',
        '    process.exit(0);',
        '}',
        'process.stderr.write(`Unexpected xcrun args: ${args.join(\' \')}\\n`);',
        'process.exit(2);',
    ]);

    const appBuilderPath = join(binDir, 'app-builder');
    writeExecutable(appBuilderPath, [
        '#!/usr/bin/env node',
        'const { createHash } = require(\'node:crypto\');',
        'const { readFileSync, statSync, writeFileSync } = require(\'node:fs\');',
        'const args = process.argv.slice(2);',
        'if (args[0] !== \'blockmap\') {',
        '    process.stderr.write(`Unexpected app-builder args: ${args.join(\' \')}\\n`);',
        '    process.exit(2);',
        '}',
        'const inputPath = args[args.indexOf(\'--input\') + 1];',
        'const outputPath = args[args.indexOf(\'--output\') + 1];',
        'writeFileSync(outputPath, \'blockmap\');',
        'const data = readFileSync(inputPath);',
        'const info = {',
        '    sha512: createHash(\'sha512\').update(data).digest(\'base64\'),',
        '    size: statSync(inputPath).size,',
        '};',
        'process.stdout.write(JSON.stringify(info));',
    ]);

    return appBuilderPath;
}

describe('release policy', () => {
    it('resolves a runnable app-builder binary from the pinned release dependency', () => {
        const executable = findAppBuilderExecutable(resolve(process.cwd()), {
            arch: 'arm64',
            platform: 'darwin',
        });

        expect(existsSync(executable)).toBe(true);
        expect(() => accessSync(executable, constants.X_OK)).not.toThrow();
    });

    it('classifies only supplemental channel assets as outside the immutable core set', () => {
        expect(isSupplementalReleaseAsset('EVB-Viewer-0.1.427-x64.zip')).toBe(true);
        expect(isSupplementalReleaseAsset('EVB-Viewer-0.1.427-arm64-setup.exe')).toBe(true);
        expect(isSupplementalReleaseAsset('EVB-Viewer-0.1.427-win-arm64-provenance.json')).toBe(true);
        expect(isSupplementalReleaseAsset('EVB-Viewer-0.1.427-arm64.zip')).toBe(false);
        expect(isSupplementalReleaseAsset('EVB-Viewer-0.1.427-x64-setup.exe')).toBe(false);
        expect(isSupplementalReleaseAsset('SHA256SUMS')).toBe(false);

        // With a release version, only that release's exact asset name is
        // supplemental; other versions stop being exempt, and an explicitly
        // supplied empty version is a caller bug, not a pattern fallback.
        expect(isSupplementalReleaseAsset('EVB-Viewer-0.1.427-x64.zip', '0.1.427')).toBe(true);
        expect(isSupplementalReleaseAsset('EVB-Viewer-0.1.427-arm64-setup.exe', '0.1.427')).toBe(true);
        expect(isSupplementalReleaseAsset('EVB-Viewer-0.1.427-win-arm64-provenance.json', '0.1.427')).toBe(true);
        expect(isSupplementalReleaseAsset('EVB-Viewer-0.1.426-x64.zip', '0.1.427')).toBe(false);
        expect(isSupplementalReleaseAsset('EVB-Viewer-0.1.426-arm64-setup.exe', '0.1.427')).toBe(false);
        expect(isSupplementalReleaseAsset('EVB-Viewer-0.1.426-win-arm64-provenance.json', '0.1.427'))
            .toBe(false);
        expect(getSupplementalReleaseAssetNames('0.1.427')).toEqual([
            'EVB-Viewer-0.1.427-x64.zip',
            'EVB-Viewer-0.1.427-arm64-setup.exe',
            'EVB-Viewer-0.1.427-win-arm64-provenance.json',
        ]);
        expect(() => isSupplementalReleaseAsset('EVB-Viewer-0.1.427-x64.zip', ''))
            .toThrow('non-empty release version');
    });

    it('derives local release targets from host platform and arch', () => {
        expect(getLocalReleaseTargets({
            arch: 'arm64',
            platform: 'darwin',
        })).toEqual([{
            arch: 'arm64',
            expectsUpdaterMetadata: true,
            isPrimaryHostTarget: true,
            platform: 'mac',
        }]);

        expect(getLocalReleaseTargets({
            arch: 'x64',
            platform: 'win32',
        })).toEqual([{
            arch: 'x64',
            expectsUpdaterMetadata: true,
            isPrimaryHostTarget: true,
            platform: 'win',
        }]);
    });

    it('keeps updater metadata and startup verification aligned with signing state', () => {
        const macTarget = {
            arch: 'arm64',
            expectsUpdaterMetadata: true,
            isPrimaryHostTarget: true,
            platform: 'mac',
        };
        const unsignedEnv = {};
        const signedEnv = {
            CSC_KEY_PASSWORD: 'secret',
            CSC_LINK: 'base64://cert',
        };

        expect(expectsUpdaterMetadata(macTarget, unsignedEnv)).toBe(false);
        expect(expectsUpdaterMetadata(macTarget, signedEnv)).toBe(true);
        expect(expectsUpdaterMetadata(macTarget, { EVB_RELEASE_HAS_MAC_SIGNING: 'true' })).toBe(true);
        expect(shouldVerifyPackagedStartup(macTarget, unsignedEnv)).toBe(false);
        expect(shouldVerifyPackagedStartup(macTarget, signedEnv)).toBe(true);
    });

    it('provides a release automation env that stays in CI mode', () => {
        expect(getReleaseAutomationEnv({ FOO: 'bar' })).toEqual({
            CI: 'true',
            EVB_AUTOMATION_HIDE_WINDOW: '1',
            EVB_AUTOMATION_NO_FOCUS: '1',
            FOO: 'bar',
        });
    });

    it('reports supported host platforms and required packaged artifacts', () => {
        expect(detectHostReleasePlatform('darwin')).toBe('mac');
        expect(detectHostReleasePlatform('linux')).toBe('linux');
        expect(detectHostReleasePlatform('win32')).toBe('win');
        expect(() => detectHostReleasePlatform('freebsd')).toThrow(
            'Unsupported local release platform "freebsd"',
        );

        expect(getRequiredArtifactPatterns({
            arch: 'arm64',
            expectsUpdaterMetadata: true,
            platform: 'mac',
        }, {
            CSC_KEY_PASSWORD: 'password',
            CSC_LINK: 'certificate',
        }).map((pattern: RegExp) => pattern.source)).toEqual([
            '\\.dmg$',
            '\\.zip$',
        ]);

        expect(getRequiredArtifactPatterns({
            arch: 'arm64',
            expectsUpdaterMetadata: true,
            platform: 'mac',
        }, { EVB_RELEASE_HAS_MAC_SIGNING: 'true' }).map((pattern: RegExp) => pattern.source)).toEqual([
            '\\.dmg$',
            '\\.zip$',
        ]);

        expect(getRequiredArtifactPatterns({
            arch: 'arm64',
            expectsUpdaterMetadata: true,
            platform: 'mac',
        }, {}).map((pattern: RegExp) => pattern.source)).toEqual([ '\\.dmg$' ]);
    });

    it('rejects publish-time updater metadata that does not match signing policy', () => {
        expect(() => assertPublishUpdaterMetadataPolicy([
            'EVB Viewer-0.1.0-arm64.dmg',
            'latest-mac.yml',
            'EVB Viewer-0.1.0-arm64.dmg.blockmap',
        ], {
            EVB_RELEASE_HAS_MAC_SIGNING: 'false',
            EVB_RELEASE_HAS_WINDOWS_SIGNING: 'false',
        })).toThrow('latest-mac.yml');

        expect(() => assertPublishUpdaterMetadataPolicy([
            'EVB Viewer Setup 0.1.0.exe',
            'latest.yml',
            'EVB Viewer Setup 0.1.0.exe.blockmap',
        ], {
            EVB_RELEASE_HAS_MAC_SIGNING: 'false',
            EVB_RELEASE_HAS_WINDOWS_SIGNING: 'false',
        })).toThrow('latest.yml');

        expect(() => assertPublishUpdaterMetadataPolicy([
            'EVB Viewer-0.1.0.AppImage',
            'latest-linux.yml',
        ], {
            EVB_RELEASE_HAS_MAC_SIGNING: 'false',
            EVB_RELEASE_HAS_WINDOWS_SIGNING: 'true',
        })).toThrow('latest-linux.yml');

        expect(() => assertPublishUpdaterMetadataPolicy([
            'EVB Viewer-0.1.0-arm64.dmg',
            'latest-mac.yml',
            'EVB Viewer-0.1.0-arm64.dmg.blockmap',
            'EVB Viewer Setup 0.1.0.exe',
            'latest.yml',
            'EVB Viewer Setup 0.1.0.exe.blockmap',
        ], {
            EVB_RELEASE_HAS_MAC_SIGNING: 'true',
            EVB_RELEASE_HAS_WINDOWS_SIGNING: 'true',
        })).not.toThrow();
    });

    it('validates publish-time updater metadata asset references without shell parsing', () => {
        const metadata = new Map([
            [
                'latest-mac.yml',
                [
                    'version: 0.1.0',
                    'path: "EVB Viewer-0.1.0-arm64.dmg"',
                    'sha512: abc',
                ].join('\n'),
            ],
            [
                'latest.yml',
                [
                    'version: 0.1.0',
                    'path: \'EVB Viewer Setup 0.1.0.exe\'',
                    'sha512: def',
                ].join('\n'),
            ],
        ]);

        expect(assertPublishUpdaterMetadataReferences([
            'EVB Viewer-0.1.0-arm64.dmg',
            'EVB Viewer Setup 0.1.0.exe',
            'latest-mac.yml',
            'latest.yml',
        ], (fileName: string) => metadata.get(fileName) ?? '')).toBe(true);
    });

    it('rejects publish-time updater metadata that points at missing or unsafe assets', () => {
        expect(() => assertPublishUpdaterMetadataReferences([ 'latest-mac.yml' ], () => 'path: "Missing.dmg"\n'))
            .toThrow('Missing.dmg not found');

        expect(() => assertPublishUpdaterMetadataReferences([ 'latest.yml' ], () => 'path: "../EVB Viewer Setup 0.1.0.exe"\n'))
            .toThrow('Unsafe path entry');
    });

    describe('updater metadata file url validation', () => {
        const metadataText = [
            'version: 0.1.0',
            'files:',
            '  - url: EVB-Viewer-0.1.0-arm64.zip',
            '    sha512: abc',
            '  - url: EVB-Viewer-0.1.0-arm64.dmg',
            '    sha512: def',
            'path: EVB-Viewer-0.1.0-arm64.zip',
        ].join('\n');

        it('parses every files[].url entry', () => {
            expect(parseUpdaterMetadataFileUrls('latest-mac.yml', metadataText)).toEqual([
                'EVB-Viewer-0.1.0-arm64.zip',
                'EVB-Viewer-0.1.0-arm64.dmg',
            ]);
        });

        it('rejects metadata whose files[].url is not among the artifacts', () => {
            const artifacts = [
                'latest-mac.yml',
                'EVB-Viewer-0.1.0-arm64.zip',
            ];
            expect(() => assertPublishUpdaterMetadataReferences(
                artifacts,
                () => metadataText,
            )).toThrow(/EVB-Viewer-0\.1\.0-arm64\.dmg not found/u);
        });

        it('accepts metadata whose path and files[].url all exist', () => {
            const artifacts = [
                'latest-mac.yml',
                'EVB-Viewer-0.1.0-arm64.zip',
                'EVB-Viewer-0.1.0-arm64.dmg',
            ];
            expect(assertPublishUpdaterMetadataReferences(
                artifacts,
                () => metadataText,
            )).toBe(true);
        });

        it('rejects unsafe url entries', () => {
            expect(() => parseUpdaterMetadataFileUrls('latest-mac.yml', 'files:\n  - url: ../evil.zip\n')).toThrow(/Unsafe path entry/u);
        });

        it('updates the DMG file info without changing the ZIP update path', () => {
            const updatedText = updateMacUpdaterMetadataArtifactInfo(
                'latest-mac.yml',
                [
                    'version: 0.1.0',
                    'files:',
                    '  - url: EVB-Viewer-0.1.0-arm64.zip',
                    '    sha512: zip-hash',
                    '    size: 100',
                    '  - url: EVB-Viewer-0.1.0-arm64.dmg',
                    '    sha512: stale-dmg-hash',
                    '    size: 200',
                    'path: EVB-Viewer-0.1.0-arm64.zip',
                    'sha512: zip-hash',
                ].join('\n'),
                'EVB-Viewer-0.1.0-arm64.dmg',
                {
                    sha512: 'fresh-dmg-hash',
                    size: 250,
                },
            );

            expect(parseMacUpdaterFileEntries('latest-mac.yml', updatedText)).toEqual([
                {
                    sha512: 'zip-hash',
                    size: 100,
                    url: 'EVB-Viewer-0.1.0-arm64.zip',
                },
                {
                    sha512: 'fresh-dmg-hash',
                    size: 250,
                    url: 'EVB-Viewer-0.1.0-arm64.dmg',
                },
            ]);
            expect(updatedText).toContain('path: EVB-Viewer-0.1.0-arm64.zip');
            expect(updatedText).toContain('sha512: zip-hash');
        });

        it('rejects stale macOS updater metadata hashes and sizes', () => {
            const macMetadata = [
                'version: 0.1.0',
                'files:',
                '  - url: EVB-Viewer-0.1.0-arm64.zip',
                '    sha512: zip-hash',
                '    size: 100',
                '  - url: EVB-Viewer-0.1.0-arm64.dmg',
                '    sha512: dmg-hash',
                '    size: 250',
                'path: EVB-Viewer-0.1.0-arm64.zip',
                'sha512: zip-hash',
            ].join('\n');
            const artifactInfo = new Map([
                [
                    'EVB-Viewer-0.1.0-arm64.zip',
                    {
                        sha512: 'zip-hash',
                        size: 100,
                    },
                ],
                [
                    'EVB-Viewer-0.1.0-arm64.dmg',
                    {
                        sha512: 'dmg-hash',
                        size: 250,
                    },
                ],
            ]);
            const readArtifactInfo = (artifactName: string) => {
                const info = artifactInfo.get(artifactName);
                if (!info) {
                    throw new Error(`Missing test artifact info: ${artifactName}`);
                }
                return info;
            };

            expect(assertMacUpdaterMetadataHashes({
                artifactNames: [
                    'EVB-Viewer-0.1.0-arm64.zip',
                    'EVB-Viewer-0.1.0-arm64.dmg',
                    'latest-mac.yml',
                ],
                readArtifactInfo,
                readMetadataText: () => macMetadata,
            })).toBe(true);

            artifactInfo.set('EVB-Viewer-0.1.0-arm64.dmg', {
                sha512: 'new-dmg-hash',
                size: 250,
            });
            expect(() => assertMacUpdaterMetadataHashes({
                artifactNames: [
                    'EVB-Viewer-0.1.0-arm64.zip',
                    'EVB-Viewer-0.1.0-arm64.dmg',
                    'latest-mac.yml',
                ],
                readArtifactInfo,
                readMetadataText: () => macMetadata,
            })).toThrow(/hash mismatch/u);

            artifactInfo.set('EVB-Viewer-0.1.0-arm64.dmg', {
                sha512: 'dmg-hash',
                size: 251,
            });
            expect(() => assertMacUpdaterMetadataHashes({
                artifactNames: [
                    'EVB-Viewer-0.1.0-arm64.zip',
                    'EVB-Viewer-0.1.0-arm64.dmg',
                    'latest-mac.yml',
                ],
                readArtifactInfo,
                readMetadataText: () => macMetadata,
            })).toThrow(/size mismatch/u);
        });

        it('notarizes and staples DMGs before refreshing macOS updater hashes', () => {
            const projectRoot = mkdtempSync(join(tmpdir(), 'evb-dmg-notary-'));

            try {
                const artifactsDir = join(projectRoot, 'release');
                const binDir = join(projectRoot, 'bin');
                mkdirSync(artifactsDir, { recursive: true });
                mkdirSync(binDir, { recursive: true });

                const appBuilderPath = createFakeDmgNotaryTools(binDir);
                const dmgName = 'EVB-Viewer-0.1.0-arm64.dmg';
                const zipName = 'EVB-Viewer-0.1.0-arm64.zip';
                const dmgPath = join(artifactsDir, dmgName);
                const zipPath = join(artifactsDir, zipName);
                const metadataPath = join(artifactsDir, 'latest-mac.yml');
                writeFileSync(dmgPath, 'dmg-before-staple');
                writeFileSync(zipPath, 'zip-bytes');

                const zipInfo = computeArtifactFileInfo(zipPath);
                writeFileSync(metadataPath, [
                    'version: 0.1.0',
                    'files:',
                    `  - url: ${zipName}`,
                    `    sha512: ${zipInfo.sha512}`,
                    `    size: ${zipInfo.size}`,
                    `  - url: ${dmgName}`,
                    '    sha512: stale-dmg-hash',
                    '    size: 1',
                    `path: ${zipName}`,
                    `sha512: ${zipInfo.sha512}`,
                ].join('\n'));

                expect(notarizeMacDmgArtifacts({
                    arch: 'arm64',
                    artifactsDir: 'release',
                    env: {
                        APP_BUILDER_BINARY: appBuilderPath,
                        APPLE_API_ISSUER: 'issuer',
                        APPLE_API_KEY: '/tmp/AuthKey_Test.p8',
                        APPLE_API_KEY_ID: 'key-id',
                        CSC_NAME: 'Developer ID Application: Example (TEAMID)',
                        PATH: `${binDir}${delimiter}${process.env.PATH ?? ''}`,
                    },
                    platform: 'darwin',
                    projectRoot,
                })).toEqual({
                    processed: 1,
                    skipped: false,
                });

                const updatedMetadata = readFileSync(metadataPath, 'utf8');
                const dmgInfo = computeArtifactFileInfo(dmgPath);
                expect(readFileSync(`${dmgPath}.blockmap`, 'utf8')).toBe('blockmap');
                expect(readFileSync(`${dmgPath}.stapled`, 'utf8')).toBe('1');
                expect(parseMacUpdaterFileEntries('latest-mac.yml', updatedMetadata)).toEqual([
                    {
                        sha512: zipInfo.sha512,
                        size: zipInfo.size,
                        url: zipName,
                    },
                    {
                        sha512: dmgInfo.sha512,
                        size: dmgInfo.size,
                        url: dmgName,
                    },
                ]);
                expect(updatedMetadata.split(/\r?\n/u).slice(-2)).toEqual([
                    `path: ${zipName}`,
                    `sha512: ${zipInfo.sha512}`,
                ]);
            } finally {
                rmSync(projectRoot, {
                    force: true,
                    recursive: true,
                });
            }
        });
    });

    it('keeps release checks in the policy-owned lint/static gate', () => {
        const manifest = getGatePolicyManifest();
        const commandArgs: string[][] = getLocalReleaseCheckCommands()
            .map((command: { args: string[] }) => command.args);
        const packageScripts = getPackageScripts();
        const lintAndStaticGate = manifest.release.localChecks.gateGroups.find(group => group.id === 'lint-static');
        const scriptNames = manifest.release.localChecks.gateGroups.flatMap(group => group.scripts);

        expect(manifest.schemaVersion).toBe(2);
        expect(manifest.release.localChecks.owner).toBe('release');
        expect(manifest.release.localChecks.gateGroups.map(group => group.id)).toEqual(['lint-static']);
        expect(lintAndStaticGate?.owner).toBe('release');
        expect(lintAndStaticGate?.scripts).toEqual([
            'check:drizzle-schema',
            'check:electron:install',
            'check:electron-builder:asar-unpack',
        ]);
        expect(scriptNames.every(scriptName => Boolean(packageScripts[scriptName]))).toBe(true);
        expect(commandArgs).toEqual(scriptNames.map(scriptName => [
            'run',
            scriptName,
        ]));
        expect(scriptNames).not.toContain('build:strict');
        expect(scriptNames).not.toContain('validate');
        expect(scriptNames).not.toContain('test:release');
        expect(scriptNames).not.toContain('check:architecture:all');
        expect(scriptNames).not.toContain('db:generate');
        expect(scriptNames).not.toContain('db:migrate');
        expect(scriptNames).not.toContain('db:check');
        expect(commandArgs.flat()).not.toContain('landing');
    });

    it('keeps native/build and landing changed-area policy in one release manifest', () => {
        const changedAreas = getGatePolicyManifest().ci.changedAreas;

        expect(changedAreas.nativeOrBuild).toMatchObject({
            output: 'native_or_build',
            owner: 'pr_native_build_safety',
        });
        expect(changedAreas.nativeOrBuild.paths).toEqual(expect.arrayContaining([
            '.github/workflows/**',
            'native/**',
            'resources/**',
            'scripts/afterPack.cjs',
            'scripts/afterSign.cjs',
            'scripts/ci/classify-changed-areas.mjs',
            'scripts/generateBuildArtifacts.ts',
            'scripts/generateElectronBuilderResources.ts',
            'scripts/generateNativeToolProtocols.ts',
            'scripts/nativeResourceManifest.ts',
            'scripts/nativeResourceManifestCli.ts',
            'scripts/release/**',
            'scripts/verify-packaged-native-tools.sh',
            'scripts/verify-packaged-startup.sh',
            'electron-builder.yml',
            'rust-toolchain.toml',
        ]));
        expect(changedAreas.landing).toMatchObject({
            output: 'landing',
            owner: 'pr_landing_quality',
        });
        expect(changedAreas.landing.paths).toEqual(expect.arrayContaining([
            '.github/actions/setup-ci-env/**',
            '.github/workflows/**',
            'landing/**',
            'pnpm-lock.yaml',
            'pnpm-workspace.yaml',
            'packages/release-selection/**',
            'scripts/ci/classify-changed-areas.mjs',
            'scripts/release/policy.mjs',
        ]));
    });

    // Every release entry point runs with HUSKY=0, and the release commit carries
    // `[skip ci]`, so this scan — run as part of the same command before push — is
    // the only publication gate: neither the pre-push hook nor the CI publication policy
    // job sees these pushes.
    describe('release publication gate', () => {
        const upstream = {
            branch: 'main',
            remote: 'origin',
        };

        function createRunCommandRecorder(failingCommand?: string, {
            lsRemoteError,
            lsRemoteOutput = 'beforesha\trefs/heads/main\n',
            missingLocalOids = [],
        }: {
            lsRemoteError?: string;
            lsRemoteOutput?: string;
            missingLocalOids?: string[];
        } = {}) {
            const calls: Array<{
                args: string[];
                command: string;
            }> = [];

            return {
                calls,
                runCommand(command: string, args: string[]) {
                    calls.push({
                        args,
                        command,
                    });
                    if (command === failingCommand) {
                        throw new Error('a local-only artifact was found');
                    }
                    if (command === 'git' && args[0] === 'ls-remote') {
                        if (lsRemoteError != null) {
                            throw new Error(lsRemoteError);
                        }
                        return lsRemoteOutput;
                    }
                    // `git rev-parse --verify --quiet <oid>^{commit}` exits non-zero
                    // when the object is absent from this checkout.
                    if (command === 'git' && args[0] === 'rev-parse' && args[1] === '--verify') {
                        const oid = String(args.at(-1)).replace('^{commit}', '');
                        if (missingLocalOids.includes(oid)) {
                            throw new Error(`fatal: ${oid} is not a valid object name`);
                        }
                        return oid;
                    }
                    if (command === 'git' && args[0] === 'rev-parse') {
                        return 'headsha';
                    }
                    return '';
                },
            };
        }

        // The artifact canary pushes the operator's branch tip, so it scans
        // the whole upstream-before..HEAD range. The release cutter is tested
        // separately below: it publishes one version-only commit by tag.
        const publishers = [[
            'release:artifacts',
            async (dependencies: IPublishDependencies) => await publishReleaseArtifactsCommit(
                {upstream},
                dependencies,
            ),
            [['dispatch']],
        ]] as const;

        function publish(
            publisher: (dependencies: IPublishDependencies) => Promise<string>,
            failingCommand?: string,
            recorderOptions?: Parameters<typeof createRunCommandRecorder>[1],
        ) {
            const recorder = createRunCommandRecorder(failingCommand, recorderOptions);

            return {
                calls: recorder.calls,
                result: publisher({
                    // Recorded like a command so the ordering assertion covers the
                    // workflow dispatch too.
                    dispatchWorkflow: () => recorder.calls.push({
                        args: [],
                        command: 'dispatch',
                    }),
                    printHandoff: async () => undefined,
                    pushReleaseTag: () => recorder.calls.push({
                        args: [],
                        command: 'tag',
                    }),
                    runCommand: recorder.runCommand,
                }),
            };
        }

        it('release:cut scans exactly the release commit over its parent before tagging and dispatching', async () => {
            const recorder = createRunCommandRecorder();

            await expect(publishReleaseCommit({
                parentSha: 'parentsha',
                tag: 'v1.2.3',
                targetSha: 'releasesha',
                upstream,
            }, {
                dispatchWorkflow: () => recorder.calls.push({
                    args: [],
                    command: 'dispatch',
                }),
                printHandoff: async () => undefined,
                pushReleaseTag: () => recorder.calls.push({
                    args: [],
                    command: 'tag',
                }),
                runCommand: recorder.runCommand,
            })).resolves.toBe('releasesha');

            expect(recorder.calls.map(({command}) => command)).toEqual([
                'node',
                'tag',
                'dispatch',
            ]);
            expect(recorder.calls[0]?.args).toEqual(getPublicationPolicyCheckArgs('parentsha', 'releasesha'));
        });

        it('release:cut propagates a failing scan and never tags or dispatches', async () => {
            const recorder = createRunCommandRecorder('node');

            await expect(publishReleaseCommit({
                parentSha: 'parentsha',
                tag: 'v1.2.3',
                targetSha: 'releasesha',
                upstream,
            }, {
                dispatchWorkflow: () => recorder.calls.push({
                    args: [],
                    command: 'dispatch',
                }),
                printHandoff: async () => undefined,
                pushReleaseTag: () => recorder.calls.push({
                    args: [],
                    command: 'tag',
                }),
                runCommand: recorder.runCommand,
            })).rejects.toThrow('a local-only artifact was found');

            expect(recorder.calls.map(({command}) => command)).toEqual(['node']);
        });

        it.each(publishers)('%s scans the upstream-before SHA through HEAD before pushing', async (
            _label,
            publisher,
            afterPush,
        ) => {
            const {
                calls,
                result,
            } = publish(publisher);

            await expect(result).resolves.toBe('headsha');
            expect(calls.map(({
                args,
                command,
            }) => [
                command,
                ...args.slice(0, 2),
            ])).toEqual([
                [
                    'git',
                    'rev-parse',
                    'HEAD',
                ],
                [
                    'git',
                    'ls-remote',
                    'origin',
                ],
                [
                    'git',
                    'rev-parse',
                    '--verify',
                ],
                [
                    'node',
                    PUBLICATION_POLICY_SCRIPT,
                    '--pushed-range',
                ],
                [
                    'git',
                    'push',
                    'origin',
                ],
                ...afterPush,
            ]);
            expect(calls[2]?.args.at(-1)).toBe('beforesha^{commit}');
            expect(calls[3]?.args).toEqual(getPublicationPolicyCheckArgs('beforesha', 'headsha'));
            // The scanned script has to be the real checker, resolved from the
            // module rather than from the caller's working directory.
            expect(PUBLICATION_POLICY_SCRIPT)
                .toBe(resolve(process.cwd(), 'scripts/check-publication-policy.mjs'));
            expect(existsSync(PUBLICATION_POLICY_SCRIPT)).toBe(true);
        });

        // A stale checkout cannot exclude the advertised upstream tip from the
        // scan, so the scan would widen to the head's whole history and report
        // every artifact any historical commit ever touched. That reads as a
        // policy failure when the real remedy is `git fetch`, so publishing has
        // to stop before the scan and say so.
        it.each(publishers)('%s fails closed when the advertised upstream tip is missing locally', async (
            _label,
            publisher,
        ) => {
            const {
                calls,
                result,
            } = publish(publisher, undefined, {missingLocalOids: ['beforesha']});

            await expect(result).rejects.toThrow(
                /origin\/main is at beforesha, which is missing from this checkout.*git fetch origin main/su,
            );
            expect(calls.some(({command}) => command === 'node')).toBe(false);
            expect(calls.some(({
                args,
                command,
            }) => command === 'git' && args[0] === 'push')).toBe(false);
            expect(calls.some(({command}) => command === 'dispatch')).toBe(false);
            // Fetching is the operator's call: the gate must not move refs itself.
            expect(calls.some(({
                args,
                command,
            }) => command === 'git' && [
                'fetch',
                'remote',
                'update-ref',
            ].includes(String(args[0])))).toBe(false);
        });

        it.each(publishers)('%s scans the advertised range when the upstream tip is present locally', async (
            _label,
            publisher,
        ) => {
            const {
                calls,
                result,
            } = publish(publisher);

            await expect(result).resolves.toBe('headsha');
            expect(calls.find(({command}) => command === 'node')?.args)
                .toEqual(getPublicationPolicyCheckArgs('beforesha', 'headsha'));
        });

        // A branch the remote does not have yet advertises nothing; the empty
        // before SHA keeps the checker's full-history scan for a new branch.
        it.each(publishers)('%s scans the full history when the upstream advertises nothing', async (
            _label,
            publisher,
        ) => {
            const {
                calls,
                result,
            } = publish(publisher, undefined, {lsRemoteOutput: ''});

            await expect(result).resolves.toBe('headsha');
            expect(calls.find(({command}) => command === 'node')?.args)
                .toEqual(getPublicationPolicyCheckArgs('', 'headsha'));
            // Nothing to look up locally, so no presence probe is issued.
            expect(calls.some(({
                args,
                command,
            }) => command === 'git' && args[1] === '--verify')).toBe(false);
        });

        it.each(publishers)('%s aborts when the remote advertisement cannot be read', async (
            _label,
            publisher,
        ) => {
            const {
                calls,
                result,
            } = publish(publisher, undefined, {lsRemoteError: 'fatal: Could not resolve host: github.com'});

            await expect(result).rejects.toThrow('Could not resolve host');
            expect(calls.some(({command}) => command === 'node')).toBe(false);
            expect(calls.some(({
                args,
                command,
            }) => command === 'git' && args[0] === 'push')).toBe(false);
            expect(calls.some(({command}) => command === 'dispatch')).toBe(false);
        });

        it.each(publishers)('%s propagates a failing scan and never pushes or dispatches', async (
            _label,
            publisher,
        ) => {
            const {
                calls,
                result,
            } = publish(publisher, 'node');

            await expect(result).rejects.toThrow('a local-only artifact was found');
            expect(calls.some(({
                args,
                command,
            }) => command === 'git' && args[0] === 'push')).toBe(false);
            expect(calls.some(({command}) => command === 'dispatch')).toBe(false);
        });

        // The runtime tests above prove that the publishers scan before pushing.
        // What they cannot observe is a *second* push written elsewhere in
        // scripts/release/, which would publish without a scan. Every `git push`
        // in these scripts spells the subcommand as a string literal in the
        // argument array whatever the surrounding formatting, so count those:
        // exactly two, both in the module that owns the scanned publisher. The
        // second is the release tag push, which the cutter reaches only after
        // scanning the one commit that tag makes public.
        it('routes every release push through the scanned publisher', () => {
            const releaseDirectory = resolve(process.cwd(), 'scripts/release');
            const sources = new Map(readdirSync(releaseDirectory)
                .filter(fileName => fileName.endsWith('.mjs'))
                .map(fileName => [
                    fileName,
                    readFileSync(join(releaseDirectory, fileName), 'utf8'),
                ]));

            expect(sources.size).toBeGreaterThan(1);
            expect([...sources]
                .map(([
                    fileName,
                    source,
                ]) => ({
                    fileName,
                    pushes: source.match(/(['"])push\1/gu)?.length ?? 0,
                }))
                .filter(({pushes}) => pushes > 0)).toEqual([
                {
                    fileName: 'shared.mjs',
                    pushes: 2,
                },
                {
                    fileName: 'wait-for-exact-sha-ci.mjs',
                    pushes: 1,
                },
            ]);

            // Both release entry-point modules reach that publisher instead of
            // pushing themselves.
            for (const fileName of [
                'cut-release.mjs',
                'build-artifacts.mjs',
            ]) {
                expect(sources.get(fileName), fileName).toMatch(/\bpushReleaseBranch\b/u);
            }
        });
    });

    it('supports release resume without requiring a new version bump level', () => {
        expect(parseCutReleaseArgs(['patch'])).toEqual({
            level: 'patch',
            resume: false,
        });
        expect(parseCutReleaseArgs(['--resume'])).toEqual({
            level: null,
            resume: true,
        });
        expect(() => parseCutReleaseArgs([
            'patch',
            '--resume',
        ])).toThrow('does not accept a release level');
        expect(() => parseCutReleaseArgs(['--full-verify'])).toThrow('Unknown release option');
    });

    it('dispatches release and artifact workflows with exact target refs', () => {
        expect(getReleaseWorkflowDispatchArgs({
            branch: 'main',
            tag: 'v1.2.3',
            targetSha: 'abc123',
        })).toEqual([
            'workflow',
            'run',
            'release.yml',
            '--ref',
            'main',
            '--field',
            'tag=v1.2.3',
            '--field',
            'target_ref=abc123',
        ]);
        expect(getReleaseArtifactsWorkflowDispatchArgs({
            branch: 'main',
            targetSha: 'abc123',
        })).toEqual([
            'workflow',
            'run',
            'release-artifacts.yml',
            '--ref',
            'main',
            '--field',
            'target_ref=abc123',
        ]);
    });

    it('reports release promotion gates by their actual verified outcomes', () => {
        const workflow = readFileSync(resolve(process.cwd(), '.github/workflows/release.yml'), 'utf8');
        expect(workflow).toContain('Report release gate outcomes');
        expect(workflow).toContain('Updater metadata path policy');
        expect(workflow).toContain('Published asset presence and integrity');
        expect(workflow).toContain('Public promotion | deferred until required distribution channels complete');
        expect(workflow).toContain('steps.uploaded_assets.outcome');
    });

    it('reuses immutable public assets before the extracted publish chain', () => {
        const workflow = readFileSync(resolve(process.cwd(), '.github/workflows/release.yml'), 'utf8');
        const publishJobStart = workflow.indexOf('\n  publish:\n');
        expect(publishJobStart).toBeGreaterThanOrEqual(0);
        const chainJobStart = workflow.indexOf('\n  chain:\n');
        expect(chainJobStart).toBeGreaterThan(publishJobStart);
        const publishJob = workflow.slice(publishJobStart, chainJobStart);

        expect(workflow).toContain('release view "$RELEASE_TAG" --json isDraft,targetCommitish');
        expect(workflow).toContain('git/ref/tags/${RELEASE_TAG}');
        expect(workflow).toContain('git/tags/${resolved_release_sha}');
        expect(workflow).toContain('[ "$resolved_release_sha" != "$TARGET_SHA" ]');
        expect(workflow).toContain('already_public=true');
        expect(workflow).toContain('Existing public assets passed presence and updater integrity checks');
        expect(workflow).toContain('Retaining checksum-finalized draft assets from the same target');
        expect(workflow).toContain('grep -Fq \'release not found\'');
        expect(publishJob).not.toContain('gh release upload "$RELEASE_TAG" artifacts/* --clobber');
        expect(workflow).toContain('uses: ./.github/workflows/publish-chain.yml');
        expect(workflow).toContain('Mirror channel');
    });

    it('keeps standalone release verification split into check and package gates', () => {
        const manifest = getGatePolicyManifest();
        const packageScripts = getPackageScripts();
        const manifestCommands = manifest.release.localVerify.gates.map(gate => ({
            args: gate.args,
            command: gate.command,
        }));

        expect(manifest.release.localVerify.owner).toBe('release');
        expect(manifest.release.localVerify.gates.map(gate => gate.id)).toEqual([
            'checks',
            'package-local',
        ]);
        expect(manifest.release.localVerify.gates.every((gate) => {
            const scriptName = gate.args[1];
            return gate.command === 'pnpm'
                && gate.args[0] === 'run'
                && typeof scriptName === 'string'
                && Boolean(packageScripts[scriptName]);
        })).toBe(true);
        expect(getLocalReleaseVerifyCommands()).toEqual(manifestCommands);
    });

    it('can ignore landing-only worktree changes for main app releases', () => {
        expect(filterIgnoredFiles([
            'package.json',
            'landing/app/pages/index.vue',
            'landing/package.json',
            'app/app.vue',
        ], [ 'landing' ])).toEqual([
            'package.json',
            'app/app.vue',
        ]);
    });

    it('retries transient remote tag lookup failures during release preflight', async () => {
        const stderr: string[] = [];
        const sleeps: number[] = [];
        let remoteAttempts = 0;

        await assertTagAbsent('v1.2.3', 'origin', {
            delayMs: 10,
            runCommand: (_command: string, args: string[]) => {
                if (args[0] === 'rev-parse') {
                    throw Object.assign(new Error('unknown revision'), { status: 128 });
                }

                remoteAttempts += 1;
                if (remoteAttempts === 1) {
                    throw Object.assign(new Error('Recv failure: Connection reset by peer'), { status: 128 });
                }

                throw Object.assign(new Error('not found'), { status: 2 });
            },
            sleepFn: async (duration: number) => {
                sleeps.push(duration);
            },
            stderr: { write: (message: string) => stderr.push(message) },
        });

        expect(remoteAttempts).toBe(2);
        expect(sleeps).toEqual([10]);
        expect(stderr.join('')).toContain('Transient remote tag check failure for v1.2.3');
        expect(isTransientRemoteGitError(new Error('Recv failure: Connection reset by peer'))).toBe(true);
    });

    it('retries transient GitHub CLI auth keyring failures during release preflight', async () => {
        const stderr: string[] = [];
        const sleeps: number[] = [];
        let attempts = 0;

        await assertGitHubCliReady('Release', {
            delayMs: 10,
            runCommand: () => {
                attempts += 1;
                if (attempts === 1) {
                    throw new Error('Timeout trying to log in to github.com account evb0110 (keyring)');
                }
                return '';
            },
            sleepFn: async (duration: number) => {
                sleeps.push(duration);
            },
            stderr: { write: (message: string) => stderr.push(message) },
        });

        expect(attempts).toBe(2);
        expect(sleeps).toEqual([10]);
        expect(stderr.join('')).toContain('Transient GitHub CLI auth check failure');
        expect(isTransientGitHubAuthError(new Error('Timeout trying to log in to github.com account evb0110 (keyring)'))).toBe(true);
    });

    it('accepts an authenticated GraphQL fallback when GitHub REST auth status stays unavailable', async () => {
        const calls: string[][] = [];
        const stderr: string[] = [];

        await assertGitHubCliReady('Release', {
            delayMs: 0,
            runCommand: (_command: string, args: string[]) => {
                calls.push(args);
                if (args[0] === 'auth') {
                    throw new Error('HTTP 503: 503 Service Unavailable (keyring)');
                }
                return 'evb0110';
            },
            sleepFn: async () => undefined,
            stderr: { write: (message: string) => stderr.push(message) },
        });

        expect(calls.filter(args => args[0] === 'auth')).toHaveLength(3);
        expect(calls.at(-1)).toEqual([
            'api',
            'graphql',
            '--field',
            'query=query { viewer { login } }',
            '--jq',
            '.data.viewer.login',
        ]);
        expect(stderr.join('')).toContain('authenticated GraphQL fallback succeeded');
    });

    it('runs release checks under the supplied CI-mode environment', () => {
        const calls: Array<{
            args: string[];
            command: string;
            env?: Record<string, string>;
        }> = [];

        runLocalReleaseChecks({
            env: {
                CI: 'true',
                FOO: 'bar',
            },
            runCommand: (command: string, args: string[], options: { env?: Record<string, string> }) => {
                calls.push({
                    args,
                    command,
                    ...(options.env === undefined ? {} : { env: options.env }),
                });
            },
        });

        expect(calls).toHaveLength(getLocalReleaseCheckCommands().length);
        expect(calls.every(call => call.command === 'pnpm')).toBe(true);
        expect(calls.every(call => call.env?.CI === 'true')).toBe(true);
        expect(calls.every(call => call.env?.FOO === 'bar')).toBe(true);
    });

    it('defaults release checks to the shared CI-mode environment', () => {
        const calls: Array<{
            args: string[];
            command: string;
            env?: Record<string, string>;
        }> = [];
        const runCommand = (command: string, args: string[], options: { env?: Record<string, string> }) => {
            calls.push({
                args,
                command,
                ...(options.env === undefined ? {} : { env: options.env }),
            });
        };

        runLocalReleaseChecks({ runCommand });

        expect(calls).toHaveLength(getLocalReleaseCheckCommands().length);
        expect(calls.every(call => call.command === 'pnpm')).toBe(true);
        expect(calls.every(call => call.env?.CI === 'true')).toBe(true);
        expect(calls.every(call => call.env?.EVB_AUTOMATION_HIDE_WINDOW === undefined)).toBe(true);
        expect(calls.every(call => call.env?.EVB_AUTOMATION_NO_FOCUS === undefined)).toBe(true);
    });

    it('records a strict-build receipt after the policy-owned release checks', () => {
        const scripts: string[] = [];
        const receipts: string[] = [];
        const childEnvironments = new Map<string, Record<string, string>>();

        runLocalReleaseChecks({
            env: {
                CI: 'true',
                EVB_RELEASE_BUILD_RECEIPT: '/tmp/release-build-receipt.json',
                EVB_RELEASE_VERIFY_SKIP: '',
                EVB_RELEASE_VERIFY_SKIP_ACK: '1',
            },
            runCommand: (
                _command: string,
                args: string[],
                options: {env?: Record<string, string>},
            ) => {
                const script = args[1] ?? args[0] ?? '';
                scripts.push(script);
                childEnvironments.set(script, options.env ?? {});
            },
            stderr: {write: () => {}},
            writeBuildReceipt: receiptPath => receipts.push(receiptPath),
        });

        expect(scripts.indexOf('build:strict')).toBeGreaterThan(
            scripts.indexOf('check:electron-builder:asar-unpack'),
        );
        expect(scripts).toEqual([
            'check:drizzle-schema',
            'check:electron:install',
            'check:electron-builder:asar-unpack',
            'build:strict',
        ]);
        expect(receipts).toEqual(['/tmp/release-build-receipt.json']);
        expect(childEnvironments.get('check:drizzle-schema')).toMatchObject({
            EVB_RELEASE_BUILD_RECEIPT: '/tmp/release-build-receipt.json',
            EVB_RELEASE_VERIFY_SKIP: '',
            EVB_RELEASE_VERIFY_SKIP_ACK: '1',
        });
        expect(childEnvironments.get('check:electron-builder:asar-unpack')).toHaveProperty(
            'EVB_RELEASE_BUILD_RECEIPT',
        );
        expect(childEnvironments.get('check:electron-builder:asar-unpack')).toHaveProperty(
            'EVB_RELEASE_VERIFY_SKIP',
        );
        expect(childEnvironments.get('check:electron-builder:asar-unpack')).toHaveProperty(
            'EVB_RELEASE_VERIFY_SKIP_ACK',
        );
    });

    it('reuses a validated strict build from the same all-gates run', () => {
        const scripts: string[] = [];
        const receipts: string[] = [];
        const stderrLines: string[] = [];

        runLocalReleaseChecks({
            env: {
                CI: 'true',
                EVB_RELEASE_BUILD_RECEIPT: '/tmp/release-build-receipt.json',
                EVB_RELEASE_VERIFY_REUSE_BUILD_RECEIPT: '1',
            },
            runCommand: (_command: string, args: string[]) => {
                scripts.push(args[1] ?? args[0] ?? '');
            },
            stderr: {write: message => stderrLines.push(message)},
            validateBuildReceipt: () => ({valid: true}),
            writeBuildReceipt: receiptPath => receipts.push(receiptPath),
        });

        expect(scripts).not.toContain('build:strict');
        expect(scripts).toEqual([
            'check:drizzle-schema',
            'check:electron:install',
            'check:electron-builder:asar-unpack',
        ]);
        expect(receipts).toEqual([]);
        expect(stderrLines.join('')).toContain('Reusing strict-build receipt');
    });

    it('fails closed instead of rebuilding when an all-gates receipt is stale', () => {
        expect(() => runLocalReleaseChecks({
            env: {
                CI: 'true',
                EVB_RELEASE_BUILD_RECEIPT: '/tmp/stale-release-build-receipt.json',
                EVB_RELEASE_VERIFY_REUSE_BUILD_RECEIPT: '1',
            },
            stderr: {write: () => {}},
            validateBuildReceipt: () => ({
                reason: 'outputs-changed',
                valid: false,
            }),
        })).toThrow(
            'Cannot reuse strict-build receipt /tmp/stale-release-build-receipt.json: outputs-changed',
        );
    });

    it('rejects explicit receipt reuse when no complete handoff is available', () => {
        expect(() => runLocalReleaseChecks({
            env: {EVB_RELEASE_VERIFY_REUSE_BUILD_RECEIPT: '1'},
            stderr: {write: () => {}},
        })).toThrow('Cannot reuse the all-gates strict build: EVB_RELEASE_BUILD_RECEIPT is missing');

        expect(() => runLocalReleaseChecks({
            allowSkip: true,
            env: {
                EVB_RELEASE_BUILD_RECEIPT: '/tmp/release-build-receipt.json',
                EVB_RELEASE_VERIFY_REUSE_BUILD_RECEIPT: '1',
            },
            skipList: 'check:drizzle-schema',
            stderr: {write: () => {}},
        })).toThrow('Cannot reuse strict-build receipt /tmp/release-build-receipt.json: missing');
    });

    it('skips explicitly listed release gates without changing the default gate list', () => {
        const calls: string[][] = [];
        const stderrLines: string[] = [];

        runLocalReleaseChecks({
            allowSkip: true,
            runCommand: (_command: string, args: string[]) => {
                calls.push(args);
            },
            skipList: 'check:drizzle-schema, check:electron:install',
            stderr: { write: (message: string) => stderrLines.push(message) },
        });

        const scriptNames = calls.map(args => args[1]);
        expect(scriptNames).not.toContain('check:drizzle-schema');
        expect(scriptNames).not.toContain('check:electron:install');
        expect(calls).toHaveLength(getLocalReleaseCheckCommands().length - 2);
        expect(stderrLines.join('')).toContain('release:verify is running with skipped local gates');
        expect(stderrLines.join('')).toContain('skipped gates: check:drizzle-schema, check:electron:install');
    });

    it('requires explicit acknowledgement before release verification skips gates', () => {
        expect(isReleaseVerifySkipAcknowledged({
            argv: [],
            env: {},
        })).toBe(false);
        expect(isReleaseVerifySkipAcknowledged({
            argv: ['--allow-skip'],
            env: {},
        })).toBe(true);
        expect(isReleaseVerifySkipAcknowledged({
            argv: [],
            env: {EVB_RELEASE_VERIFY_SKIP_ACK: '1'},
        })).toBe(true);
        expect(() => assertReleaseVerifySkipAcknowledged(['check:drizzle-schema'], {allowSkip: false}))
            .toThrow(/without explicit acknowledgement/u);
        expect(() => runLocalReleaseChecks({
            runCommand: () => {},
            skipList: 'check:drizzle-schema',
            stderr: { write: () => {} },
        })).toThrow(/EVB_RELEASE_VERIFY_SKIP was set without explicit acknowledgement/u);
    });

    it('rejects unknown gate names in the release verify skip list', () => {
        expect(() => runLocalReleaseChecks({
            runCommand: () => {},
            skipList: 'test:coferage',
            stderr: { write: () => {} },
        })).toThrow(/unknown release gates: test:coferage/u);
        expect(parseReleaseVerifySkipList(undefined)).toEqual([]);
        expect(parseReleaseVerifySkipList('')).toEqual([]);
    });

    it('fails standalone release verification when the worktree snapshot changes', () => {
        expect(() => assertReleaseVerifyDidNotMutateWorktree({
            stagedDiff: '',
            trackedDiff: '',
            untrackedFiles: [],
        }, {
            stagedDiff: '',
            trackedDiff: 'diff --git a/package.json b/package.json',
            untrackedFiles: [],
        })).toThrow('tracked diff');
    });

    it('checks standalone release verification mutations after successful commands', () => {
        const calls: Array<{
            args: string[];
            command: string;
        }> = [];
        let snapshotCount = 0;

        expect(() => runLocalReleaseVerify({
            runCommand: (command: string, args: string[]) => {
                calls.push({
                    args,
                    command,
                });
                return '';
            },
            snapshotGetter: () => {
                snapshotCount += 1;
                return {
                    stagedDiff: '',
                    trackedDiff: snapshotCount === 1 ? '' : 'changed',
                    untrackedFiles: [],
                };
            },
        })).toThrow('tracked diff');

        expect(calls).toEqual(getLocalReleaseVerifyCommands());
    });

    it('preserves an all-gates build receipt but clears standalone receipts', () => {
        const reusedReceipt = join(tmpdir(), `evb-reused-receipt-${process.pid}.json`);
        const standaloneReceipt = join(tmpdir(), `evb-standalone-receipt-${process.pid}.json`);
        writeFileSync(reusedReceipt, '{}\n');
        writeFileSync(standaloneReceipt, '{}\n');
        const snapshot = () => ({
            stagedDiff: '',
            trackedDiff: '',
            untrackedFiles: [],
        });

        try {
            runLocalReleaseVerify({
                env: {EVB_RELEASE_VERIFY_REUSE_BUILD_RECEIPT: '1'},
                receiptPath: reusedReceipt,
                runCommand: () => '',
                snapshotGetter: snapshot,
            });
            runLocalReleaseVerify({
                env: {},
                receiptPath: standaloneReceipt,
                runCommand: () => '',
                snapshotGetter: snapshot,
            });

            expect(existsSync(reusedReceipt)).toBe(true);
            expect(existsSync(standaloneReceipt)).toBe(false);
        } finally {
            rmSync(reusedReceipt, {force: true});
            rmSync(standaloneReceipt, {force: true});
        }
    });

    it('forwards the all-gates receipt path to every release verifier command', () => {
        const receiptPath = join(tmpdir(), `evb-forwarded-receipt-${process.pid}.json`);
        const childReceiptPaths: Array<string | undefined> = [];
        writeFileSync(receiptPath, '{}\n');
        const snapshot = () => ({
            stagedDiff: '',
            trackedDiff: '',
            untrackedFiles: [],
        });

        try {
            runLocalReleaseVerify({
                env: {
                    EVB_RELEASE_BUILD_RECEIPT: receiptPath,
                    EVB_RELEASE_VERIFY_REUSE_BUILD_RECEIPT: '1',
                },
                runCommand: (_command, _args, options) => {
                    childReceiptPaths.push(options.env?.EVB_RELEASE_BUILD_RECEIPT);
                    return '';
                },
                snapshotGetter: snapshot,
            });

            expect(childReceiptPaths).toEqual(
                getLocalReleaseVerifyCommands().map(() => receiptPath),
            );
            expect(existsSync(receiptPath)).toBe(true);
        } finally {
            rmSync(receiptPath, {force: true});
        }
    });

    it('keeps strict build enforcement in the local packaging phase', () => {
        expect(getLocalReleaseBuildCommand()).toEqual({
            args: [
                'run',
                'build:strict',
            ],
            command: 'pnpm',
        });
    });

    it('keeps Electron bundle static integrity reusable without rebuilding after build output exists', () => {
        const scripts = getPackageScripts();

        expect(scripts['test:electron-bundle-static-integrity']).toBe(
            'pnpm run build:electron && pnpm run test:electron-bundle-static-integrity:no-build && node scripts/prune-build-artifacts.mjs && pnpm run check:build-artifacts:hygiene',
        );
        expect(scripts['test:electron-bundle-static-integrity:no-build']).toBe(
            'vitest run --project electron-bundle-static-integrity',
        );
    });

    it('uses a ZIP-only local package check for supplemental macOS Intel builds', () => {
        expect(getPackagingArgs({
            arch: 'x64',
            platform: 'mac',
        })).toEqual([
            'exec',
            'electron-builder',
            '--publish',
            'never',
            '--mac',
            'zip',
            '--x64',
        ]);
    });

    it('uses a DMG-only local package check for unsigned macOS arm64 builds', () => {
        expect(getPackagingArgs({
            arch: 'arm64',
            expectsUpdaterMetadata: true,
            platform: 'mac',
        }, {})).toEqual([
            'exec',
            'electron-builder',
            '--publish',
            'never',
            '--mac',
            'dmg',
            '--arm64',
        ]);
    });

    it('keeps ZIP generation for signed macOS arm64 builds with updater metadata', () => {
        expect(getPackagingArgs({
            arch: 'arm64',
            expectsUpdaterMetadata: true,
            platform: 'mac',
        }, {
            CSC_KEY_PASSWORD: 'password',
            CSC_LINK: 'certificate',
        })).toEqual([
            'exec',
            'electron-builder',
            '--publish',
            'never',
            '--mac',
            '--arm64',
        ]);
    });

    it('validates matrix build artifacts before upload', () => {
        const macMetadata = [
            'version: 0.1.0',
            'path: EVB-Viewer-0.1.0-arm64.zip',
            'files:',
            '  - url: EVB-Viewer-0.1.0-arm64.zip',
            '  - url: EVB-Viewer-0.1.0-arm64.dmg',
        ].join('\n');

        expect(assertBuildArtifacts({
            arch: 'arm64',
            platform: 'mac',
            env: {
                EVB_RELEASE_HAS_MAC_SIGNING: 'true',
                EVB_RELEASE_HAS_WINDOWS_SIGNING: 'false',
            },
            artifactNames: [
                'EVB-Viewer-0.1.0-arm64.dmg',
                'EVB-Viewer-0.1.0-arm64.dmg.blockmap',
                'EVB-Viewer-0.1.0-arm64.zip',
                'EVB-Viewer-0.1.0-arm64.zip.blockmap',
                'latest-mac.yml',
            ],
            readMetadataText: () => macMetadata,
        })).toBe(true);

        expect(() => assertBuildArtifacts({
            arch: 'arm64',
            platform: 'linux',
            artifactNames: [
                'EVB Viewer-0.1.0-arm64.AppImage',
                'EVB Viewer-0.1.0-arm64.deb',
                'latest-linux.yml',
            ],
            readMetadataText: () => 'path: EVB Viewer-0.1.0-arm64.AppImage\n',
        })).toThrow('latest-linux.yml');

        expect(() => assertBuildArtifacts({
            arch: 'arm64',
            platform: 'win',
            env: {
                EVB_RELEASE_HAS_MAC_SIGNING: 'false',
                EVB_RELEASE_HAS_WINDOWS_SIGNING: 'true',
            },
            artifactNames: [
                'EVB Viewer Setup 0.1.0-arm64.exe',
                'EVB Viewer Setup 0.1.0-arm64.exe.blockmap',
            ],
            readMetadataText: () => '',
        })).toThrow('Unexpected updater metadata for win-arm64');
    });
});
