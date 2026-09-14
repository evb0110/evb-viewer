const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..');
const {manifest: RELEASE_TARGET_MANIFEST} = require('./release/generated-release-targets.cjs');
const SUPPORTED_CHROMIUM_LOCALES = {
    darwin: new Set([
        'de',
        'en',
        'es',
        'fr',
        'it',
        'nl',
        'pt_BR',
        'pt_PT',
        'ru',
    ]),
    linux: new Set([
        'de',
        'en-US',
        'es',
        'fr',
        'it',
        'nl',
        'pt-BR',
        'pt-PT',
        'ru',
    ]),
    win32: new Set([
        'de',
        'en-US',
        'es',
        'fr',
        'it',
        'nl',
        'pt-BR',
        'pt-PT',
        'ru',
    ]),
};

function archName(arch) {
    switch (arch) {
        case 1:
        case 'x64':
            return 'x64';
        case 3:
        case 'arm64':
            return 'arm64';
        default:
            return null;
    }
}

function resourcesDirForContext(context) {
    if (context.packager && typeof context.packager.getResourcesDir === 'function') {
        return context.packager.getResourcesDir(context.appOutDir);
    }

    if (context.electronPlatformName === 'darwin') {
        const appName = context.packager.appInfo.productFilename;
        return path.join(context.appOutDir, `${appName}.app`, 'Contents', 'Resources');
    }

    return path.join(context.appOutDir, 'resources');
}

function platformArchTagForContext(context) {
    const platform = context.electronPlatformName;
    if (!RELEASE_TARGET_MANIFEST.electronBuilderPlatformKeys[platform]) {
        throw new Error(`[afterPack] Unsupported required extraResources platform: ${platform}`);
    }

    const arch = archName(context.arch);
    if (arch === null) {
        throw new Error(`[afterPack] Unsupported required extraResources arch: ${context.arch}`);
    }

    return `${platform}-${arch}`;
}

function requiredExtraResourcesForContext(context, {
    projectRoot: root = projectRoot,
    resourcesDir = resourcesDirForContext(context),
} = {}) {
    const tag = platformArchTagForContext(context);
    const entries = RELEASE_TARGET_MANIFEST.globalResources.map(entry => ({
        label: entry.label,
        ...(entry.requiredFiles === undefined ? {} : {packagedEntries: entry.requiredFiles.map(relativePath => ({
            label: `${entry.label} file`,
            relativePath,
            type: 'file',
        }))}),
        sourcePath: path.join(root, ...entry.sourceSegments),
        stagedPath: path.join(resourcesDir, ...entry.stagedSegments),
        tag,
        type: entry.type,
    }));

    for (const entry of RELEASE_TARGET_MANIFEST.families) {
        const binaryExtension = context.electronPlatformName === 'win32' ? '.exe' : '';
        const packagedEntries = entry.packagedEntries
            .filter(resource => !resource.platforms || resource.platforms.includes(context.electronPlatformName))
            .map(resource => ({
                label: resource.label,
                relativePath: path.join(...resource.pathSegments)
                    .replaceAll('{exeSuffix}', binaryExtension),
                type: resource.type,
            }));
        if (packagedEntries.length === 0) {
            continue;
        }
        entries.push({
            label: `${entry.label} (${tag})`,
            packagedEntries,
            sourcePath: path.join(root, ...entry.sourceRootSegments, tag),
            stagedPath: path.join(resourcesDir, ...entry.stagedRootSegments, tag),
            tag,
            type: 'directory',
        });
    }

    return entries;
}

function hasExpectedPathType(filePath, type) {
    try {
        const stat = fs.statSync(filePath);
        return type === 'file'
            ? stat.isFile()
            : stat.isDirectory();
    } catch (error) {
        if (error && error.code === 'ENOENT') {
            return false;
        }

        throw error;
    }
}

function assertRequiredExtraResources(context, options) {
    const missing = [];
    const entries = requiredExtraResourcesForContext(context, options);

    for (const entry of entries) {
        if (!hasExpectedPathType(entry.sourcePath, entry.type)) {
            missing.push(`source ${entry.label}: ${entry.sourcePath}`);
            continue;
        }

        if (!hasExpectedPathType(entry.stagedPath, entry.type)) {
            missing.push(`packaged ${entry.label}: ${entry.stagedPath}`);
            continue;
        }

        for (const packagedEntry of entry.packagedEntries ?? []) {
            const sourceEntryPath = path.join(entry.sourcePath, packagedEntry.relativePath);
            const packagedEntryPath = path.join(entry.stagedPath, packagedEntry.relativePath);
            if (!hasExpectedPathType(sourceEntryPath, packagedEntry.type)) {
                missing.push(`source ${packagedEntry.label}: ${sourceEntryPath}`);
                continue;
            }
            if (!hasExpectedPathType(packagedEntryPath, packagedEntry.type)) {
                missing.push(`packaged ${packagedEntry.label}: ${packagedEntryPath}`);
                continue;
            }
            if (packagedEntry.type === 'file') {
                const sourceHash = crypto.createHash('sha256').update(fs.readFileSync(sourceEntryPath)).digest('hex');
                const packagedHash = crypto.createHash('sha256').update(fs.readFileSync(packagedEntryPath)).digest('hex');
                if (sourceHash !== packagedHash) {
                    missing.push(`packaged ${packagedEntry.label} differs from staged build: ${packagedEntryPath}`);
                }
            }
        }
    }

    if (missing.length > 0) {
        throw new Error([
            `[afterPack] Missing required electron-builder extraResources for ${entries[0].tag}:`,
            ...missing.map(item => `- ${item}`),
            'Run the platform native-tool build steps before packaging and verify electron-builder.yml extraResources.',
        ].join('\n'));
    }
}

function appPathForContext(context) {
    const appName = context.packager.appInfo.productFilename;
    return path.join(context.appOutDir, `${appName}.app`);
}

function nativeToolsDirForContext(context) {
    if (context.electronPlatformName === 'darwin') {
        return path.join(appPathForContext(context), 'Contents', 'MacOS', 'native-tools');
    }

    return resourcesDirForContext(context);
}

function chromiumLocaleDirectoryForContext(context) {
    if (context.electronPlatformName === 'darwin') {
        return path.join(
            appPathForContext(context),
            'Contents',
            'Frameworks',
            'Electron Framework.framework',
            'Versions',
            'A',
            'Resources',
        );
    }

    // Electron places Chromium locale packs beside the resources directory on
    // Linux and Windows (for example, appOutDir/locales/en-US.pak). The
    // resources directory itself contains app.asar and extraResources.
    return path.join(context.appOutDir, 'locales');
}

function pruneChromiumLocales(context) {
    const platform = context.electronPlatformName;
    const keep = SUPPORTED_CHROMIUM_LOCALES[platform];
    if (!keep) {
        throw new Error(`[afterPack] Unsupported Chromium locale platform: ${platform}`);
    }
    const localeDirectory = chromiumLocaleDirectoryForContext(context);
    if (!fs.existsSync(localeDirectory)) {
        throw new Error(`[afterPack] Chromium locale directory is missing: ${localeDirectory}`);
    }

    const present = new Set();
    let removed = 0;
    for (const entry of fs.readdirSync(localeDirectory, {withFileTypes: true})) {
        const locale = platform === 'darwin'
            ? (entry.isDirectory() && entry.name.endsWith('.lproj')
                ? entry.name.slice(0, -'.lproj'.length)
                : null)
            : (entry.isFile() && entry.name.endsWith('.pak')
                ? entry.name.slice(0, -'.pak'.length)
                : null);
        if (locale === null) {
            continue;
        }
        const baseLocale = platform === 'darwin'
            ? locale.replace(/_(?:FEMININE|MASCULINE|NEUTER)$/u, '')
            : locale;
        if (keep.has(baseLocale)) {
            if (baseLocale === locale) {
                present.add(locale);
            }
            continue;
        }
        fs.rmSync(path.join(localeDirectory, entry.name), {
            force: true,
            recursive: true,
        });
        removed++;
    }

    const missing = [...keep].filter(locale => !present.has(locale));
    if (missing.length > 0) {
        throw new Error(`[afterPack] Required Chromium locales are missing for ${platform}: ${missing.join(', ')}`);
    }
    console.log(`[afterPack] Pruned ${removed} unused Chromium locale packs; retained ${keep.size}`);
}

function removeEmptyDir(dir) {
    try {
        if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) {
            fs.rmdirSync(dir);
        }
    } catch {
        // Best effort cleanup only; the moved payload is what matters.
    }
}

function moveMacNativeToolResources(context) {
    if (context.electronPlatformName !== 'darwin') {
        return;
    }

    const arch = archName(context.arch);
    if (arch === null) {
        throw new Error(`[afterPack] Unsupported macOS native-tool arch: ${context.arch}`);
    }

    const tag = `darwin-${arch}`;
    const resourcesDir = resourcesDirForContext(context);
    const nativeToolsDir = nativeToolsDirForContext(context);

    for (const family of RELEASE_TARGET_MANIFEST.families) {
        const src = path.join(resourcesDir, ...family.stagedRootSegments, tag);
        if (!fs.existsSync(src)) {
            continue;
        }

        const dst = path.join(nativeToolsDir, ...family.stagedRootSegments, tag);
        fs.rmSync(dst, {
            force: true,
            recursive: true,
        });
        fs.mkdirSync(path.dirname(dst), {recursive: true});
        fs.cpSync(src, dst, {
            recursive: true,
            verbatimSymlinks: true,
        });
        fs.rmSync(src, {
            force: true,
            recursive: true,
        });
        removeEmptyDir(path.dirname(src));
        console.log('[afterPack] Moved macOS native tool resources:', dst);
    }
}

function removeNativeBuildReceipts(context) {
    const tag = platformArchTagForContext(context);
    const resourcesDir = resourcesDirForContext(context);

    for (const family of RELEASE_TARGET_MANIFEST.families) {
        const receiptPath = path.join(
            resourcesDir,
            ...family.stagedRootSegments,
            tag,
            'build-receipt.json',
        );
        fs.rmSync(receiptPath, {force: true});
    }
}

function makeTreeOwnerWritable(rootPath) {
    if (!fs.existsSync(rootPath)) {
        return;
    }

    const pending = [rootPath];
    while (pending.length > 0) {
        const currentPath = pending.pop();
        const stat = fs.lstatSync(currentPath);
        if (stat.isSymbolicLink()) {
            continue;
        }

        // ShipIt removes quarantine metadata from the unpacked update before it
        // swaps the application bundle. A read-only native binary or dylib makes
        // that operation fail with EACCES and causes the old version to relaunch.
        // Preserve executable bits while ensuring the bundle owner may update
        // metadata. This runs before afterSign, so signatures cover final modes.
        const requiredMode = stat.isDirectory() ? 0o300 : 0o200;
        const nextMode = stat.mode | requiredMode;
        if (nextMode !== stat.mode) {
            fs.chmodSync(currentPath, nextMode);
        }

        if (stat.isDirectory()) {
            for (const child of fs.readdirSync(currentPath)) {
                pending.push(path.join(currentPath, child));
            }
        }
    }
}

function configureWindowsNsisArchiveFilter(context) {
    if (context.electronPlatformName !== 'win32') {
        return;
    }

    // electron-builder 26.15.x forces differential NSIS archives back to
    // normal compression, so win.compression: store does not prevent 7za from
    // emitting BCJ2 streams. The bundled Nsis7z extractor silently skips
    // those PE entries. BCJ is supported by both sides.
    process.env.ELECTRON_BUILDER_7Z_FILTER = 'BCJ';
}

exports.default = async function afterPack(context) {
    configureWindowsNsisArchiveFilter(context);
    assertRequiredExtraResources(context);
    pruneChromiumLocales(context);
    removeNativeBuildReceipts(context);
    moveMacNativeToolResources(context);

    if (context.electronPlatformName !== 'darwin') {
        return;
    }

    const nativeToolsDir = nativeToolsDirForContext(context);
    makeTreeOwnerWritable(nativeToolsDir);
    console.log('[afterPack] Made macOS native tools owner-writable for ShipIt updates:', nativeToolsDir);

    const src = path.resolve(__dirname, '..', 'resources', 'icon.icns');
    const dst = path.join(appPathForContext(context), 'Contents', 'Resources', 'icon.icns');

    if (!fs.existsSync(src)) {
        console.warn('[afterPack] Source icon not found:', src);
        return;
    }

    fs.copyFileSync(src, dst);
    console.log('[afterPack] Restored original icon.icns (bypassing app-builder alpha corruption)');
};
exports.assertRequiredExtraResources = assertRequiredExtraResources;
exports.configureWindowsNsisArchiveFilter = configureWindowsNsisArchiveFilter;
exports.makeTreeOwnerWritable = makeTreeOwnerWritable;
exports.pruneChromiumLocales = pruneChromiumLocales;
exports.removeNativeBuildReceipts = removeNativeBuildReceipts;
exports.requiredExtraResourcesForContext = requiredExtraResourcesForContext;
