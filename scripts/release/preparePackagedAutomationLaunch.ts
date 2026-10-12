import {execFileSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    realpathSync,
    rmSync,
} from 'node:fs';
import {homedir} from 'node:os';
import {
    basename,
    dirname,
    isAbsolute,
    join,
    relative,
    resolve,
    sep,
} from 'node:path';
import {
    buildHeadlessAutomationEnv,
    listMacOSNestedHelperApps,
    prepareMacOSHiddenAppBundle,
} from '@scripts/electron-run/electronRunLaunchConfig';

// The folders under ~/Library where a copy keeps its records, relative to ~/Library.
// Each one is read one level deep, and nothing below an entry is opened.
// Application Support is read at its top level only, where a copy's <id> folder
// sits. Recent-document lists are the one named folder inside it.
const COPY_RECORD_FOLDERS = [
    'Preferences',
    'Caches',
    'HTTPStorages',
    'WebKit',
    'Saved Application State',
    'Application Support',
    join('Application Support', 'com.apple.sharedfilelist', 'com.apple.LSSharedFileList.ApplicationRecentDocuments'),
];

// Every automation copy identifier ends with .automation-<8 hex digits>.
const AUTOMATION_COPY_SUFFIX = /\.automation-[0-9a-f]{8}$/u;

const LSREGISTER = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';

function readInfoPlistString(infoPlistPath: string, key: string) {
    return execFileSync('/usr/bin/plutil', [
        '-extract',
        key,
        'raw',
        '-o',
        '-',
        infoPlistPath,
    ], {
        encoding: 'utf8',
        stdio: [
            'ignore',
            'pipe',
            'pipe',
        ],
    }).trim();
}

/** Prepare only. The caller owns the child process and removes workDirectory after it exits. */
export function preparePackagedAutomationLaunch(options: {
    executablePath: string;
    workDirectory: string;
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
}) {
    const env: NodeJS.ProcessEnv = buildHeadlessAutomationEnv(options.env);
    delete env.ELECTRON_RUN_AS_NODE;
    const executablePath = resolve(options.executablePath);
    if ((options.platform ?? process.platform) !== 'darwin') {
        return {
            executablePath,
            env,
            appPath: undefined,
            bundleDirectory: undefined,
            bundleIdentifier: undefined,
        };
    }

    const sourceAppPath = dirname(dirname(dirname(executablePath)));
    if (!sourceAppPath.endsWith('.app')
        || dirname(executablePath) !== join(sourceAppPath, 'Contents', 'MacOS')) {
        throw new Error('macOS packaged automation requires an executable inside a .app/Contents/MacOS bundle.');
    }
    const sourceInfoPlistPath = join(sourceAppPath, 'Contents', 'Info.plist');
    const bundleExecutable = readInfoPlistString(sourceInfoPlistPath, 'CFBundleExecutable');
    if (bundleExecutable !== basename(executablePath)
        || bundleExecutable !== basename(sourceAppPath, '.app')) {
        throw new Error('Packaged automation executable must match CFBundleExecutable and the app bundle name.');
    }
    // A copy that kept the installed identifier would read and write the installed
    // app's defaults, saved state and caches. The random suffix is new for each
    // launch, so no run shares another run's records.
    const bundleIdentifier = `${readInfoPlistString(sourceInfoPlistPath, 'CFBundleIdentifier')}.automation-${randomBytes(4).toString('hex')}`;

    const sourceRealPath = realpathSync(sourceAppPath);
    let existingWorkAncestor = resolve(options.workDirectory);
    while (!existsSync(existingWorkAncestor)) {
        existingWorkAncestor = dirname(existingWorkAncestor);
    }
    const sourceRelativeWork = relative(sourceRealPath, realpathSync(existingWorkAncestor));
    if (!sourceRelativeWork || (sourceRelativeWork !== '..'
        && !sourceRelativeWork.startsWith(`..${sep}`) && !isAbsolute(sourceRelativeWork))) {
        throw new Error('Packaged automation workDirectory must be outside the source app bundle.');
    }
    mkdirSync(options.workDirectory, {recursive: true});
    const workDirectory = realpathSync(options.workDirectory);

    // Records that earlier copies left are removed at prepare too, not only at stop,
    // so a record written after an earlier run ended cannot outlive the next run.
    removeMacOSAutomationCopyRecords(bundleIdentifier);

    // A unique APFS clone belongs to this run. Never reuse another artifact or
    // prune a concurrent run's bundle. The original signed package stays intact.
    const bundleDirectory = mkdtempSync(join(workDirectory, 'hidden-packaged-app-'));
    try {
        const bundle = prepareMacOSHiddenAppBundle({
            sourceAppPath,
            destinationRoot: bundleDirectory,
            bundleIdentifier,
        });
        console.info(`Packaged automation uses an LSUIElement copy at ${bundle.appPath} with bundle identifier ${bundleIdentifier}. `
            + `Original artifact: ${sourceAppPath}. This run does not verify the original bundle signature or Dock behavior.`);
        return {
            executablePath: bundle.executablePath,
            env,
            appPath: bundle.appPath,
            bundleDirectory,
            bundleIdentifier,
        };
    } catch (error) {
        rmSync(bundleDirectory, {
            recursive: true,
            force: true,
        });
        throw error;
    }
}

function escapeRegExp(text: string) {
    return text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/**
 * Deletes the defaults of a launched copy, and its records and the records earlier
 * copies of the same installed app left, from the folders where a copy keeps them.
 * A name belongs to a copy when it is the copy's identifier, optionally followed by
 * a dot and more, or when it is <installed id>.automation-<8 hex digits> followed by
 * the end of the name or a dot. Nothing else matches: the installed app's records
 * and any other name stay where they are.
 */
export function removeMacOSAutomationCopyRecords(
    bundleIdentifier: string,
    libraryDirectory = join(homedir(), 'Library'),
) {
    const installedIdentifier = bundleIdentifier.replace(AUTOMATION_COPY_SUFFIX, '');
    if (installedIdentifier === bundleIdentifier) {
        throw new Error(`Not an automation copy identifier: ${bundleIdentifier}`);
    }
    const earlierCopyRecord = new RegExp(`^${escapeRegExp(installedIdentifier)}\\.automation-[0-9a-f]{8}(?:\\.|$)`, 'u');
    const isCopyRecord = (name: string) => name === bundleIdentifier
        || name.startsWith(`${bundleIdentifier}.`)
        || earlierCopyRecord.test(name);
    try {
        execFileSync('/usr/bin/defaults', [
            'delete',
            bundleIdentifier,
        ], {stdio: 'ignore'});
    } catch {
        // `defaults` reports a missing domain as an error; the copy wrote none.
    }
    for (const folder of COPY_RECORD_FOLDERS) {
        removeCopyRecordsIn(join(libraryDirectory, folder), isCopyRecord);
    }
}

/**
 * Removes the copy and its nested helper apps from the LaunchServices database.
 * A started app checks in there even when it is executed directly, so the
 * copy stays registered after its run unless this runs before its bundle goes.
 */
export function unregisterMacOSAutomationCopy(appPath: string) {
    for (const bundlePath of [
        appPath,
        ...listMacOSNestedHelperApps(appPath),
    ]) {
        try {
            execFileSync(LSREGISTER, [
                '-u',
                bundlePath,
            ], {stdio: 'ignore'});
        } catch {
            // lsregister exits non-zero for a bundle that never checked in, which leaves nothing to remove.
        }
    }
}

/**
 * Removes the entries of one folder that are copy records. The folder is read one
 * level deep, and a matched entry is removed whole. A missing folder is skipped.
 * Any other failure is reported, and cleanup goes on with the other folders,
 * because the copy has already exited when this runs.
 */
function removeCopyRecordsIn(folderPath: string, isCopyRecord: (name: string) => boolean) {
    for (const entry of readFolderEntries(folderPath)) {
        if (!isCopyRecord(entry.name)) {
            continue;
        }
        const entryPath = join(folderPath, entry.name);
        try {
            rmSync(entryPath, {
                recursive: true,
                force: true,
            });
        } catch (error) {
            console.warn(`Packaged automation could not remove ${entryPath} (${describeError(error)}).`);
        }
    }
}

function readFolderEntries(folderPath: string) {
    try {
        return readdirSync(folderPath, {withFileTypes: true});
    } catch (error) {
        if (error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
            return [];
        }
        console.warn(`Packaged automation could not read ${folderPath} (${describeError(error)}), so copy records there were not removed.`);
        return [];
    }
}

function describeError(error: unknown) {
    if (error instanceof Error) {
        return (error as NodeJS.ErrnoException).code ?? error.message;
    }
    return String(error);
}
