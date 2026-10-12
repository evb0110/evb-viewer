import {execFileSync} from 'node:child_process';
import {
    chmodSync,
    existsSync,
    lstatSync,
    mkdtempSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    realpathSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {
    dirname,
    join,
    resolve,
} from 'node:path';
import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {prepareMacOSHiddenAppBundle} from '@scripts/electron-run/electronRunLaunchConfig';
import {
    preparePackagedAutomationLaunch,
    removeMacOSAutomationCopyRecords,
} from '@scripts/release/preparePackagedAutomationLaunch';
import {startOwnedPackagedProcess} from '@scripts/release/runPackagedAutomation';

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
        expect(launch.executablePath).toBe(resolve('/artifact/evb-viewer'));
        expect(launch.env).toEqual({
            PATH: '/bin',
            EVB_AUTOMATION_HIDE_WINDOW: '1',
            EVB_AUTOMATION_NO_FOCUS: '1',
            EVB_AUTOMATION_USE_HIDDEN_APP_BUNDLE: '1',
        });
        expect(launch.bundleDirectory).toBeUndefined();
    });

    it('launches the Windows installer payload by its own name without a bundle copy', () => {
        const launch = preparePackagedAutomationLaunch({
            executablePath: '/artifact/EVB Viewer/EVB Viewer.exe',
            workDirectory: '/unused',
            platform: 'win32',
            env: {EVB_AUTOMATION_HIDE_WINDOW: '0'},
        });
        expect(launch.executablePath).toBe(resolve('/artifact/EVB Viewer/EVB Viewer.exe'));
        expect(launch.env.EVB_AUTOMATION_HIDE_WINDOW).toBe('1');
        expect(launch.bundleDirectory).toBeUndefined();
    });
});

describe.skipIf(process.platform !== 'darwin')('macOS hidden bundle launch contract', () => {
    const roots: string[] = [];
    afterEach(() => {
        vi.unstubAllEnvs();
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
        // Record cleanup at prepare reads the home directory, so keep it inside this test's root.
        mkdirSync(join(root, 'home', 'Library'), {recursive: true});
        vi.stubEnv('HOME', join(root, 'home'));
        const sourceAppPath = join(root, 'source', 'Example.app');
        mkdirSync(join(sourceAppPath, 'Contents', 'MacOS'), {recursive: true});
        writeFileSync(join(sourceAppPath, 'Contents', 'MacOS', 'Example'), 'fixture executable');
        const infoPlistPath = join(sourceAppPath, 'Contents', 'Info.plist');
        writeFileSync(infoPlistPath, '<?xml version="1.0" encoding="UTF-8"?>'
            + '<plist version="1.0"><dict>'
            + '<key>CFBundleExecutable</key><string>Example</string>'
            + '<key>CFBundleIdentifier</key><string>com.example.fixture</string>'
            + '</dict></plist>');
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

    it('starts a copy under its own identifier and task-owned folders, then removes its records and itself', async () => {
        const root = mkdtempSync(join(tmpdir(), 'evb-owned-copy-test-'));
        roots.push(root);
        const sourceAppPath = join(root, 'source', 'Example.app');
        const executablePath = join(sourceAppPath, 'Contents', 'MacOS', 'Example');
        const infoPlistPath = join(sourceAppPath, 'Contents', 'Info.plist');
        mkdirSync(join(sourceAppPath, 'Contents', 'MacOS'), {recursive: true});
        writeFileSync(infoPlistPath, '<?xml version="1.0" encoding="UTF-8"?>'
            + '<plist version="1.0"><dict>'
            + '<key>CFBundleExecutable</key><string>Example</string>'
            + '<key>CFBundleIdentifier</key><string>com.example.fixture</string>'
            + '</dict></plist>');
        // The payload records the identifier and folders it was launched with.
        writeFileSync(executablePath, '#!/bin/sh\n'
            + 'printf "%s\\n" "$(/usr/bin/plutil -extract CFBundleIdentifier raw -o - "$(dirname "$0")/../Info.plist")" '
            + '"$EVB_AUTOMATION_USER_DATA_DIR" "$EVB_FILE_LOG_DIR" > "$EVB_AUTOMATION_USER_DATA_DIR.env"\n', {mode: 0o755});
        const originalPlist = readFileSync(infoPlistPath);
        const workDirectory = join(root, 'run');
        const owned = await startOwnedPackagedProcess({
            executablePath,
            workDirectory,
            args: [],
            stdio: 'ignore',
        });
        expect(await owned.exited).toBe(0);
        const [
            copyIdentifier = '',
            userDataPath = '',
            logDirectory = '',
        ] = readFileSync(`${join(workDirectory, 'user-data')}.env`, 'utf8').trim().split('\n');
        expect(copyIdentifier).toMatch(/^com\.example\.fixture\.automation-[0-9a-f]{8}$/u);
        expect(realpathSync(dirname(userDataPath))).toBe(realpathSync(workDirectory));
        expect(realpathSync(dirname(logDirectory))).toBe(realpathSync(workDirectory));
        expect(readFileSync(infoPlistPath)).toEqual(originalPlist);

        // Records named for the copy are removed; the installed identifier's records stay.
        const library = join(root, 'Library');
        mkdirSync(join(library, 'Preferences'), {recursive: true});
        writeFileSync(join(library, 'Preferences', `${copyIdentifier}.plist`), 'copy');
        writeFileSync(join(library, 'Preferences', 'com.example.fixture.plist'), 'installed');
        removeMacOSAutomationCopyRecords(copyIdentifier, library);
        expect(readdirSync(join(library, 'Preferences'))).toEqual(['com.example.fixture.plist']);

        await owned.stop();
        expect(readdirSync(workDirectory).filter(name => name.startsWith('hidden-packaged-app-'))).toEqual([]);
    });

    it('gives each nested helper app an identifier derived from the copy, and refuses a copy whose helper keeps the installed one', () => {
        const options = fixture();
        const helpers = [
            {
                name: 'Example Helper',
                identifier: 'com.example.fixture.helper',
            },
            {
                name: 'Example Helper (Renderer)',
                identifier: 'com.example.fixture.helper.Renderer',
            },
        ];
        for (const helper of helpers) {
            const helperPath = join(options.sourceAppPath, 'Contents', 'Frameworks', `${helper.name}.app`);
            mkdirSync(join(helperPath, 'Contents', 'MacOS'), {recursive: true});
            writeFileSync(join(helperPath, 'Contents', 'MacOS', helper.name), 'fixture helper');
            writeFileSync(join(helperPath, 'Contents', 'Info.plist'), '<?xml version="1.0" encoding="UTF-8"?>'
                + '<plist version="1.0"><dict>'
                + `<key>CFBundleExecutable</key><string>${helper.name}</string>`
                + `<key>CFBundleIdentifier</key><string>${helper.identifier}</string>`
                + '</dict></plist>');
        }
        const bundleIdentifier = 'com.example.fixture.automation-0badc0de';
        const bundle = prepareMacOSHiddenAppBundle({
            ...options,
            bundleIdentifier,
        });
        const helperPlistPath = (name: string) => join(bundle.appPath, 'Contents', 'Frameworks', `${name}.app`, 'Contents', 'Info.plist');
        const helperIdentifier = (name: string) => execFileSync('/usr/bin/plutil', [
            '-extract',
            'CFBundleIdentifier',
            'raw',
            '-o',
            '-',
            helperPlistPath(name),
        ], {encoding: 'utf8'}).trim();
        expect(helperIdentifier('Example Helper')).toBe(`${bundleIdentifier}.helper`);
        expect(helperIdentifier('Example Helper (Renderer)')).toBe(`${bundleIdentifier}.helper.Renderer`);
        // A copy whose helper still carries the installed identifier is refused.
        execFileSync('/usr/bin/plutil', [
            '-replace',
            'CFBundleIdentifier',
            '-string',
            'com.example.fixture.helper',
            helperPlistPath('Example Helper'),
        ]);
        expect(() => prepareMacOSHiddenAppBundle({
            ...options,
            bundleIdentifier,
        })).toThrow(/helper/u);
    });
});

describe('macOS copy records', () => {
    const roots: string[] = [];
    afterEach(() => {
        vi.restoreAllMocks();
        for (const root of roots.splice(0)) {
            rmSync(root, {
                recursive: true,
                force: true,
            });
        }
    });

    function plantRecord(path: string) {
        mkdirSync(dirname(path), {recursive: true});
        writeFileSync(path, 'record');
    }

    it('removes the records of this copy and of earlier copies from the folders where a copy keeps them, and nothing else', () => {
        const library = mkdtempSync(join(tmpdir(), 'evb-copy-records-test-'));
        roots.push(library);
        const recent = join(library, 'Application Support', 'com.apple.sharedfilelist', 'com.apple.LSSharedFileList.ApplicationRecentDocuments');
        const folderRecord = join(library, 'Caches', 'com.evb.viewer.automation-22222222');
        mkdirSync(folderRecord, {recursive: true});
        writeFileSync(join(folderRecord, 'cache.db'), 'record');
        const removed = [
            folderRecord,
            join(library, 'Preferences', 'com.evb.viewer.automation-11111111.plist'),
            join(library, 'Saved Application State', 'com.evb.viewer.automation-33333333.savedState'),
            join(library, 'HTTPStorages', 'com.evb.viewer.automation-44444444'),
            join(library, 'WebKit', 'com.evb.viewer.automation-55555555.helper'),
            join(library, 'Application Support', 'com.evb.viewer.automation-66666666'),
            join(recent, 'com.evb.viewer.automation-77777777.sfl4'),
            join(recent, 'com.evb.viewer.automation-88888888.helper.sfl4'),
        ];
        const kept = [
            join(library, 'Preferences', 'com.evb.viewer.plist'),
            join(library, 'Caches', 'com.evb.viewer'),
            join(library, 'Saved Application State', 'com.evb.viewer.savedState'),
            join(library, 'Application Support', 'com.evb.viewer'),
            join(recent, 'com.evb.viewer.sfl4'),
            join(recent, 'com.evb.viewer.helper.sfl4'),
            join(library, 'Preferences', 'com.evb.viewer.automation-5555555.plist'),
            join(library, 'Preferences', 'com.evb.viewer.automation-666666666.plist'),
            join(library, 'Preferences', 'com.evb.viewer.dev.automation-77777777.plist'),
            join(library, 'Preferences', 'com.example.fixture.automation-88888888.plist'),
            join(library, 'Caches', 'SomeApp', 'com.evb.viewer.automation-99999999'),
            join(library, 'Application Support', 'Vendor', 'com.evb.viewer.automation-10101010'),
            join(library, 'Containers', 'com.evb.viewer.automation-11111112'),
        ];
        for (const path of [
            ...removed.slice(1),
            ...kept,
        ]) {
            plantRecord(path);
        }
        removeMacOSAutomationCopyRecords('com.evb.viewer.automation-44444444', library);
        expect(removed.filter(path => existsSync(path))).toEqual([]);
        expect(kept.filter(path => !existsSync(path))).toEqual([]);
    });

    it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('reports a listed folder that cannot be read, and still cleans the other folders', () => {
        const library = mkdtempSync(join(tmpdir(), 'evb-copy-records-unreadable-test-'));
        roots.push(library);
        const caches = join(library, 'Caches');
        const cachedRecord = join(caches, 'com.evb.viewer.automation-16161616');
        const preference = join(library, 'Preferences', 'com.evb.viewer.automation-17171717.plist');
        const storage = join(library, 'HTTPStorages', 'com.evb.viewer.automation-18181818');
        mkdirSync(cachedRecord, {recursive: true});
        plantRecord(preference);
        mkdirSync(storage, {recursive: true});
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        chmodSync(caches, 0o000);
        try {
            expect(() => removeMacOSAutomationCopyRecords('com.evb.viewer.automation-19191919', library)).not.toThrow();
        } finally {
            chmodSync(caches, 0o700);
        }
        expect(existsSync(preference)).toBe(false);
        expect(existsSync(storage)).toBe(false);
        expect(existsSync(cachedRecord)).toBe(true);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining(caches));
    });
});
