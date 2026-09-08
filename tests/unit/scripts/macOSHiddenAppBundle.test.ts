import {execFileSync} from 'node:child_process';
import {
    existsSync,
    lstatSync,
    mkdtempSync,
    mkdirSync,
    readFileSync,
    realpathSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
    afterEach,
    describe,
    expect,
    it,
} from 'vitest';
import {prepareMacOSHiddenAppBundle} from '@scripts/electron-run/electronRunLaunchConfig';
import {preparePackagedAutomationLaunch} from '@scripts/release/preparePackagedAutomationLaunch';

describe('packaged automation environment', () => {
    it('removes Node-mode inheritance and overrides visible defaults before spawning', () => {
        const launch = preparePackagedAutomationLaunch({
            executablePath: '/artifact/evb-viewer',
            workDirectory: '/unused',
            platform: 'linux',
            env: {
                PATH: '/bin',
                ELECTRON_RUN_AS_NODE: '1',
                EVB_AUTOMATION_HIDE_WINDOW: '0',
                EVB_AUTOMATION_NO_FOCUS: '0',
                EVB_AUTOMATION_USE_HIDDEN_APP_BUNDLE: '0',
            },
        });
        expect(launch.executablePath).toBe('/artifact/evb-viewer');
        expect(launch.env).toEqual({
            PATH: '/bin',
            EVB_AUTOMATION_HIDE_WINDOW: '1',
            EVB_AUTOMATION_NO_FOCUS: '1',
            EVB_AUTOMATION_USE_HIDDEN_APP_BUNDLE: '1',
        });
        expect(launch.bundleDirectory).toBeUndefined();
    });
});

describe.skipIf(process.platform !== 'darwin')('macOS hidden bundle launch contract', () => {
    const roots: string[] = [];
    afterEach(() => {
        for (const root of roots.splice(0)) {
            rmSync(root, {
                recursive: true,
                force: true,
            });
        }
    });

    function fixture() {
        const root = mkdtempSync(join(tmpdir(), 'evb-hidden-bundle-test-'));
        roots.push(root);
        const sourceAppPath = join(root, 'source', 'Example.app');
        mkdirSync(join(sourceAppPath, 'Contents', 'MacOS'), {recursive: true});
        writeFileSync(join(sourceAppPath, 'Contents', 'MacOS', 'Example'), 'fixture executable');
        const infoPlistPath = join(sourceAppPath, 'Contents', 'Info.plist');
        writeFileSync(infoPlistPath, '<?xml version="1.0" encoding="UTF-8"?>'
            + '<plist version="1.0"><dict><key>CFBundleExecutable</key><string>Example</string></dict></plist>');
        return {
            sourceAppPath,
            destinationRoot: join(root, 'automation'),
            infoPlistPath,
        };
    }

    it('sets launch-time Dock suppression while preserving the source bundle', () => {
        const options = fixture();
        const original = readFileSync(options.infoPlistPath);
        const bundle = prepareMacOSHiddenAppBundle(options);
        expect(execFileSync('/usr/bin/plutil', [
            '-extract',
            'LSUIElement',
            'raw',
            '-expect',
            'bool',
            '-o',
            '-',
            bundle.infoPlistPath,
        ], {encoding: 'utf8'}).trim()).toBe('true');
        expect(readFileSync(options.infoPlistPath)).toEqual(original);
    });

    it('copies a symlinked app directory without editing its source plist', () => {
        const options = fixture();
        const alias = join(options.destinationRoot, 'Example.app');
        mkdirSync(options.destinationRoot);
        symlinkSync(options.sourceAppPath, alias, 'dir');
        const original = readFileSync(options.infoPlistPath);
        const bundle = prepareMacOSHiddenAppBundle({
            sourceAppPath: alias,
            destinationRoot: join(options.destinationRoot, 'copy'),
        });
        expect(readFileSync(options.infoPlistPath)).toEqual(original);
        expect(realpathSync(bundle.appPath)).not.toBe(realpathSync(options.sourceAppPath));
        expect(lstatSync(bundle.appPath).isDirectory()).toBe(true);
        expect(lstatSync(bundle.appPath).isSymbolicLink()).toBe(false);
    });

    it('refuses a cached bundle whose Dock suppression has been removed', () => {
        const options = fixture();
        const bundle = prepareMacOSHiddenAppBundle(options);
        execFileSync('/usr/bin/plutil', [
            '-remove',
            'LSUIElement',
            bundle.infoPlistPath,
        ]);
        expect(() => prepareMacOSHiddenAppBundle(options)).toThrow(/LSUIElement/u);
    });

    it('prepares independent package copies and never reuses stale artifact bytes', () => {
        const options = fixture();
        const executablePath = join(options.sourceAppPath, 'Contents', 'MacOS', 'Example');
        const first = preparePackagedAutomationLaunch({
            executablePath,
            workDirectory: options.destinationRoot,
        });
        writeFileSync(executablePath, 'updated artifact');
        const second = preparePackagedAutomationLaunch({
            executablePath,
            workDirectory: options.destinationRoot,
        });
        expect(first.executablePath).not.toBe(executablePath);
        expect(second.executablePath).not.toBe(first.executablePath);
        expect(readFileSync(first.executablePath, 'utf8')).toBe('fixture executable');
        expect(readFileSync(second.executablePath, 'utf8')).toBe('updated artifact');
        expect(readFileSync(executablePath, 'utf8')).toBe('updated artifact');
    });

    it('rejects copying into the source app and rejects non-bundle launch paths', () => {
        const options = fixture();
        const nestedWorkDirectory = join(options.sourceAppPath, '..cache', 'new-run');
        expect(() => preparePackagedAutomationLaunch({
            executablePath: join(options.sourceAppPath, 'Contents', 'MacOS', 'Example'),
            workDirectory: options.sourceAppPath,
        })).toThrow(/outside the source app/u);
        expect(() => preparePackagedAutomationLaunch({
            executablePath: join(options.sourceAppPath, 'Contents', 'MacOS', 'Example'),
            workDirectory: nestedWorkDirectory,
        })).toThrow(/outside the source app/u);
        expect(existsSync(join(options.sourceAppPath, '..cache'))).toBe(false);
        expect(() => preparePackagedAutomationLaunch({
            executablePath: '/tmp/raw-electron',
            workDirectory: options.destinationRoot,
        })).toThrow(/inside a .app/u);
    });
});
