import {execFileSync} from 'node:child_process';
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    realpathSync,
    rmSync,
} from 'node:fs';
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
    prepareMacOSHiddenAppBundle,
} from '@scripts/electron-run/electronRunLaunchConfig';

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
        };
    }

    const sourceAppPath = dirname(dirname(dirname(executablePath)));
    if (!sourceAppPath.endsWith('.app')
        || dirname(executablePath) !== join(sourceAppPath, 'Contents', 'MacOS')) {
        throw new Error('macOS packaged automation requires an executable inside a .app/Contents/MacOS bundle.');
    }
    const bundleExecutable = execFileSync('/usr/bin/plutil', [
        '-extract',
        'CFBundleExecutable',
        'raw',
        '-o',
        '-',
        join(sourceAppPath, 'Contents', 'Info.plist'),
    ], {
        encoding: 'utf8',
        stdio: [
            'ignore',
            'pipe',
            'pipe',
        ],
    }).trim();
    if (bundleExecutable !== basename(executablePath)
        || bundleExecutable !== basename(sourceAppPath, '.app')) {
        throw new Error('Packaged automation executable must match CFBundleExecutable and the app bundle name.');
    }

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

    // A unique APFS clone belongs to this run. Never reuse another artifact or
    // prune a concurrent run's bundle. The original signed package stays intact.
    const bundleDirectory = mkdtempSync(join(workDirectory, 'hidden-packaged-app-'));
    try {
        const bundle = prepareMacOSHiddenAppBundle({
            sourceAppPath,
            destinationRoot: bundleDirectory,
        });
        console.info(`Packaged automation uses an LSUIElement copy at ${bundle.appPath}. `
            + `Original artifact: ${sourceAppPath}. This run does not verify the original bundle signature or Dock behavior.`);
        return {
            executablePath: bundle.executablePath,
            env,
            appPath: bundle.appPath,
            bundleDirectory,
        };
    } catch (error) {
        rmSync(bundleDirectory, {
            recursive: true,
            force: true,
        });
        throw error;
    }
}
