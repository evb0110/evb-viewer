const {
    execFileSync,
    spawnSync,
} = require('child_process');
const fs = require('fs');
const path = require('path');

const {manifest: RELEASE_TARGET_MANIFEST} = require('./release/generated-release-targets.cjs');
const HARDENED_RUNTIME_ENTITLEMENTS = path.resolve(
    __dirname,
    '..',
    ...RELEASE_TARGET_MANIFEST.signing.entitlementsPathSegments,
);

function hasDeveloperIdCredentials() {
    return Boolean(process.env.CSC_LINK && process.env.CSC_KEY_PASSWORD);
}

function hasNotaryCredentials() {
    return Boolean(
        process.env.APPLE_API_KEY
        && process.env.APPLE_API_KEY_ID
        && process.env.APPLE_API_ISSUER,
    );
}

// Notarize + staple must run AFTER all re-signing above, otherwise the ticket is
// bound to a code hash the shipped bundle no longer has. Because afterSign runs
// before electron-builder builds the DMG/ZIP, stapling here means both artifacts
// embed a stapled app and the updater metadata hashes stay correct.
function notarizeAndStapleApp(appPath, identity) {
    if (identity === '-') {
        console.log('[afterSign] Ad-hoc signature; skipping notarization.');
        return;
    }

    if (!hasNotaryCredentials()) {
        console.log('[afterSign] APPLE_API_KEY/APPLE_API_KEY_ID/APPLE_API_ISSUER not set; skipping notarization.');
        return;
    }

    const zipPath = `${appPath}.notarize.zip`;
    console.log('[afterSign] Zipping app for notarization submission.');
    execFileSync('ditto', [
        '-c',
        '-k',
        '--keepParent',
        appPath,
        zipPath,
    ], { stdio: 'inherit' });

    try {
        console.log('[afterSign] Submitting to Apple notary service (waits for the result).');
        execFileSync('xcrun', [
            'notarytool',
            'submit',
            zipPath,
            '--key',
            process.env.APPLE_API_KEY,
            '--key-id',
            process.env.APPLE_API_KEY_ID,
            '--issuer',
            process.env.APPLE_API_ISSUER,
            '--wait',
        ], { stdio: 'inherit' });

        console.log('[afterSign] Stapling notarization ticket to the app.');
        execFileSync('xcrun', [
            'stapler',
            'staple',
            appPath,
        ], { stdio: 'inherit' });
    } finally {
        fs.rmSync(zipPath, { force: true });
    }
}

function walkFiles(rootDir) {
    if (!fs.existsSync(rootDir)) {
        return [];
    }

    const pending = [rootDir];
    const files = [];

    while (pending.length > 0) {
        const currentDir = pending.pop();
        if (!currentDir) {
            continue;
        }

        for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
            const entryPath = path.join(currentDir, entry.name);
            if (entry.isDirectory()) {
                pending.push(entryPath);
                continue;
            }

            if (entry.isFile()) {
                files.push(entryPath);
            }
        }
    }

    return files;
}

function walkDirectories(rootDir) {
    if (!fs.existsSync(rootDir)) {
        return [];
    }

    const pending = [rootDir];
    const directories = [];

    while (pending.length > 0) {
        const currentDir = pending.pop();
        if (!currentDir) {
            continue;
        }

        directories.push(currentDir);
        for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
            if (entry.isDirectory()) {
                pending.push(path.join(currentDir, entry.name));
            }
        }
    }

    return directories;
}

function isMacNativeCodeFile(filePath) {
    if (isMacSharedLibrary(filePath)) {
        return true;
    }

    try {
        return (fs.statSync(filePath).mode & 0o111) !== 0;
    } catch {
        return false;
    }
}

function isMacSharedLibrary(filePath) {
    return filePath.endsWith('.dylib') || filePath.endsWith('.so');
}

function readCodesignMetadata(targetPath) {
    const result = spawnSync('codesign', [
        '-dv',
        '--verbose=4',
        targetPath,
    ], {
        encoding: 'utf8',
        stdio: [
            'ignore',
            'pipe',
            'pipe',
        ],
    });

    return `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
}

function resolveAppSigningIdentity(appPath) {
    if (!hasDeveloperIdCredentials()) {
        return '-';
    }

    const metadata = readCodesignMetadata(appPath);
    const authorityMatch = metadata.match(/^Authority=(.+)$/m);
    if (authorityMatch?.[1]) {
        return authorityMatch[1].trim();
    }

    if (process.env.CSC_NAME) {
        return process.env.CSC_NAME.trim();
    }

    throw new Error('[afterSign] Failed to determine Developer ID signing identity from app bundle');
}

function signTarget(targetPath, identity, options = {}) {
    const args = ['--force'];

    if (options.deep === true) {
        args.push('--deep');
    }

    if (options.preserveMetadata) {
        args.push(`--preserve-metadata=${options.preserveMetadata}`);
    }

    if (options.entitlements) {
        args.push(
            '--entitlements',
            options.entitlements,
        );
    }

    args.push(
        '--sign',
        identity,
    );

    if (identity === '-') {
        args.push('--timestamp=none');
    } else {
        args.push('--timestamp');
        if (options.runtime === true) {
            args.push(
                '--options',
                'runtime',
            );
        }
    }

    args.push(targetPath);
    execFileSync('codesign', args, { stdio: 'inherit' });
}

function signOptionsForCodeFile(filePath, identity) {
    if (identity === '-') {
        return {};
    }

    // Shared libraries are signed with a secure timestamp but do not carry the
    // hardened runtime flag — that requirement is specific to executables.
    if (isMacSharedLibrary(filePath)) {
        return {};
    }

    // Every Mach-O executable must enable the hardened runtime, or notarization
    // rejects the app with "The executable does not have the hardened runtime
    // enabled" for that file. The app's permissive entitlements (JIT, unsigned
    // executable memory, dyld environment variables) are applied to the native
    // tools and bundled Electron/Squirrel helper executables.
    if (!fs.existsSync(HARDENED_RUNTIME_ENTITLEMENTS)) {
        throw new Error(`[afterSign] Hardened-runtime entitlements not found: ${HARDENED_RUNTIME_ENTITLEMENTS}`);
    }

    return {
        entitlements: HARDENED_RUNTIME_ENTITLEMENTS,
        runtime: true,
    };
}

function resignEmbeddedAppCode(appPath, identity) {
    const frameworksDir = path.join(appPath, 'Contents', 'Frameworks');
    if (!fs.existsSync(frameworksDir)) {
        return;
    }

    const nestedCodeFiles = walkFiles(frameworksDir)
        .filter(isMacNativeCodeFile)
        .sort((leftPath, rightPath) => rightPath.length - leftPath.length);

    for (const filePath of nestedCodeFiles) {
        signTarget(filePath, identity, signOptionsForCodeFile(filePath, identity));
    }

    const nestedBundles = walkDirectories(frameworksDir)
        .filter((directoryPath) => directoryPath.endsWith('.framework') || directoryPath.endsWith('.app'))
        .sort((leftPath, rightPath) => rightPath.length - leftPath.length);

    for (const bundlePath of nestedBundles) {
        const options = identity === '-'
            ? {}
            : {
                preserveMetadata: 'entitlements,requirements,flags,runtime',
                runtime: true,
            };
        signTarget(bundlePath, identity, options);
    }
}

function resignBundledNativeToolPayloads(appPath, identity) {
    const nativeToolsDir = path.join(appPath, 'Contents', 'MacOS', 'native-tools');
    const toolRoots = RELEASE_TARGET_MANIFEST.signing.executableRoots
        .map(rootSegments => path.join(nativeToolsDir, ...rootSegments));

    const sharedLibraries = [];
    const executables = [];
    const nestedBundles = [];

    for (const toolRoot of toolRoots) {
        nestedBundles.push(
            ...walkDirectories(toolRoot)
                .filter((directoryPath) => directoryPath.endsWith('.framework') || directoryPath.endsWith('.app')),
        );

        for (const filePath of walkFiles(toolRoot)) {
            if (!isMacNativeCodeFile(filePath)) {
                continue;
            }

            if (isMacSharedLibrary(filePath)) {
                sharedLibraries.push(filePath);
                continue;
            }

            executables.push(filePath);
        }
    }

    for (const libraryPath of sharedLibraries) {
        signTarget(libraryPath, identity);
    }

    for (const executablePath of executables) {
        signTarget(executablePath, identity, signOptionsForCodeFile(executablePath, identity));
    }

    for (const bundlePath of nestedBundles.sort((leftPath, rightPath) => rightPath.length - leftPath.length)) {
        const options = identity === '-'
            ? {}
            : {
                preserveMetadata: 'entitlements,requirements,flags,runtime',
                runtime: true,
            };
        signTarget(bundlePath, identity, options);
    }
}

exports.default = async function afterSign(context) {
    if (!RELEASE_TARGET_MANIFEST.signing.platforms.includes(context.electronPlatformName)) {
        return;
    }

    const appName = context.packager.appInfo.productFilename;
    const appPath = path.join(context.appOutDir, `${appName}.app`);

    if (!fs.existsSync(appPath)) {
        console.warn('[afterSign] App bundle not found:', appPath);
        return;
    }

    const identity = resolveAppSigningIdentity(appPath);
    console.log(
        identity === '-'
            ? '[afterSign] No Developer ID credentials detected, applying ad-hoc signature to bundled native tools and app.'
            : `[afterSign] Re-signing bundled native tools with ${identity}.`,
    );

    // Native tools shipped via extraResources keep their upstream signatures.
    // Re-sign them inside-out so macOS library validation sees the same Team ID
    // across the signed app and the mapped non-platform dylibs.
    resignBundledNativeToolPayloads(appPath, identity);
    // Some macOS runners still leave nested Electron framework bundles unsigned
    // by the time the afterSign hook runs. Re-sign them explicitly before the
    // app root so the final bundle seal does not fail.
    resignEmbeddedAppCode(appPath, identity);
    const appSignOptions = identity === '-'
        ? {}
        : {
            preserveMetadata: 'entitlements,requirements,flags,runtime',
            runtime: true,
        };
    // Ad-hoc re-signing must not preserve hardened-runtime metadata from the
    // original Electron bundle. On newer macOS releases that leaves an
    // apparently valid bundle that still crashes at launch while dyld loads
    // Electron Framework with library-validation/Team-ID errors.
    signTarget(appPath, identity, appSignOptions);
    execFileSync('codesign', [
        '--verify',
        '--deep',
        '--strict',
        '--verbose=2',
        appPath,
    ], { stdio: 'inherit' });

    // Final step: notarize the fully re-signed bundle and staple the ticket, so the
    // shipped app (and the DMG/ZIP built from it) passes Gatekeeper offline.
    notarizeAndStapleApp(appPath, identity);
};
