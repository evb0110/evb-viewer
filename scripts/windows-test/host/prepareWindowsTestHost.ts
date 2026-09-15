import {
    copyFile,
    mkdir,
    readFile,
    readdir,
    rename,
    rm,
    stat,
    writeFile,
} from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import {
    createHash,
    randomUUID,
} from 'node:crypto';
import type { IWindowsTestHostLayout } from '@scripts/windows-test/contracts/windowsTestPaths';
import {
    loadFixtureManifest,
    verifyFixturePack,
} from '@scripts/windows-test/fixtures/fixtureManifest';
import { runWindowsFixtureGeneration } from '@scripts/windows-test/fixtures/generateWindowsFixturesCli';
import { bundleGuestWorker } from '@scripts/windows-test/guest/bundleGuestWorker';
import { withHostLock } from '@scripts/windows-test/host/hostLock';
import type { IHostLockDependencies } from '@scripts/windows-test/host/hostLock';
import {prepareStandaloneUtmctl} from '@scripts/windows-test/host/standaloneUtmctl';
import type {
    IStandaloneUtmctlPreparationOptions,
    TStandaloneUtmctlSignatureVerifier,
} from '@scripts/windows-test/host/standaloneUtmctl';
import {
    WINDOWS_TEST_WINAPP_ARCHIVE_RELATIVE_PATH,
    WINDOWS_TEST_WINAPP_ARCHIVE_SHA256,
    windowsTestWinappToolPaths,
} from '@scripts/windows-test/host/winappTool';

function sha256(contents: Uint8Array) {
    return createHash('sha256').update(contents).digest('hex');
}

async function prepareWinappTool(layout: IWindowsTestHostLayout, sourceDirectory?: string) {
    const paths = windowsTestWinappToolPaths(layout);
    await mkdir(path.dirname(paths.executablePath), {recursive: true});
    if (sourceDirectory !== undefined) {
        for (const member of [
            'winapp.exe',
            'libSkiaSharp.dll',
        ]) {
            const source = await readFile(path.join(sourceDirectory, member));
            if (source.byteLength === 0) {
                throw new Error(`The prepared WinApp source file ${member} is empty.`);
            }
            await copyFile(path.join(sourceDirectory, member), path.join(path.dirname(paths.executablePath), member));
        }
        return paths;
    }
    if (path.relative(layout.toolsCacheDir, paths.archivePath) !== WINDOWS_TEST_WINAPP_ARCHIVE_RELATIVE_PATH) {
        throw new Error('The prepared WinApp archive path is outside the tools cache.');
    }
    const archive = await readFile(paths.archivePath).catch(() => null);
    if (archive === null) {
        throw new Error(`The pinned WinApp CLI archive is missing at ${paths.archivePath}.`);
    }
    const archiveSha256 = sha256(archive);
    if (archiveSha256 !== WINDOWS_TEST_WINAPP_ARCHIVE_SHA256) {
        throw new Error(`The pinned WinApp CLI archive hashes to ${archiveSha256}, expected ${WINDOWS_TEST_WINAPP_ARCHIVE_SHA256}.`);
    }
    for (const [
        member,
        destination,
    ] of [
            [
                'winapp.exe',
                paths.executablePath,
            ],
            [
                'libSkiaSharp.dll',
                paths.nativeLibraryPath,
            ],
        ] as const) {
        const extracted = execFileSync('unzip', [
            '-p',
            paths.archivePath,
            member,
        ], {
            encoding: 'buffer',
            maxBuffer: 64 * 1024 * 1024,
        });
        if (extracted.byteLength === 0) {
            throw new Error(`The pinned WinApp CLI archive did not contain ${member}.`);
        }
        const existing = await readFile(destination).catch(() => null);
        if (existing === null || !existing.equals(extracted)) {
            await writeFile(destination, extracted);
        }
    }
    return paths;
}

export async function prepareWindowsTestHost(options: {
    layout: IWindowsTestHostLayout;
    repositoryRoot: string;
    lock: IHostLockDependencies;
    standaloneUtmctlSourcePath?: string;
    verifyStandaloneUtmctlSignature?: TStandaloneUtmctlSignatureVerifier;
    winappToolSourceDirectory?: string;
}) {
    const {
        layout,
        repositoryRoot,
        lock,
    } = options;
    await mkdir(layout.root, { recursive: true });
    return withHostLock(layout.lockFile, lock, async () => {
        // Even a stale lease needs its explicit recovery path before cached
        // inputs can change. Never replace files an existing run may consume.
        if (await stat(layout.leaseFile).catch(() => null)) {
            throw new Error('A Windows test lease exists. Finish or recover that run with windows:test:stop before preparing inputs.');
        }
        for (const directory of [
            layout.baselinesDir,
            layout.clonesDir,
            layout.artifactsCacheDir,
            layout.fixturesCacheDir,
            layout.toolsCacheDir,
            layout.runsDir,
            layout.mailboxDir,
        ]) {
            await mkdir(directory, { recursive: true });
        }
        const standaloneUtmctlOptions: IStandaloneUtmctlPreparationOptions = {
            layout,
            ...(options.standaloneUtmctlSourcePath === undefined
                ? {}
                : {sourcePath: options.standaloneUtmctlSourcePath}),
            ...(options.verifyStandaloneUtmctlSignature === undefined
                ? {}
                : {verifyCodeSignature: options.verifyStandaloneUtmctlSignature}),
        };
        const standaloneUtmctl = await prepareStandaloneUtmctl(standaloneUtmctlOptions);
        const generated = await runWindowsFixtureGeneration({
            outputDirectory: layout.fixturesCacheDir,
            relativeTo: layout.fixturesCacheDir,
            write: true,
        });
        const byId = new Map(generated.entries.map(entry => [
            entry.fixtureId,
            entry,
        ]));
        const manifest = await loadFixtureManifest(path.join(repositoryRoot, 'tests/windows/fixtures/manifest.json'));
        const declaredFiles = manifest.packs.flatMap(pack => pack.files);
        const declaredIds = new Set(declaredFiles.map(file => file.id));
        for (const id of byId.keys()) {
            if (!declaredIds.has(id)) {
                throw new Error(`Generated fixture ${id} is absent from the repository manifest.`);
            }
        }
        for (const file of declaredFiles) {
            if (file.generated) {
                const entry = byId.get(file.id);
                if (entry === undefined) {
                    throw new Error(`Declared fixture ${file.id} was not generated.`);
                }
                file.path = entry.relativePath;
                file.bytes = entry.bytes;
                file.sha256 = entry.sha256;
            } else {
                const source = path.resolve(repositoryRoot, 'tests/windows/fixtures', file.path);
                const destination = `${file.id}${path.extname(source)}`;
                await copyFile(source, path.join(layout.fixturesCacheDir, destination));
                file.path = destination;
            }
        }
        const verification = await verifyFixturePack(layout.fixturesCacheDir, manifest);
        if (verification.problems.length > 0) {
            throw new Error(`Prepared fixtures failed verification: ${JSON.stringify(verification.problems)}`);
        }
        const fixtureManifestFile = path.join(layout.fixturesCacheDir, 'manifest.json');
        const temporaryManifest = `${fixtureManifestFile}.${randomUUID()}.tmp`;
        try {
            await writeFile(temporaryManifest, `${JSON.stringify(manifest, null, 4)}\n`, 'utf8');
            await rename(temporaryManifest, fixtureManifestFile);
        } finally {
            await rm(temporaryManifest, { force: true });
        }

        const workerDirectory = path.join(layout.toolsCacheDir, 'worker');
        const powerShellDirectory = path.join(workerDirectory, 'powershell');
        await mkdir(powerShellDirectory, { recursive: true });
        const workerFile = path.join(workerDirectory, 'guestWorker.cjs');
        const pdfWorkerSource = path.join(
            repositoryRoot,
            'node_modules',
            'pdfjs-dist',
            'legacy',
            'build',
            'pdf.worker.mjs',
        );
        const pdfWorkerFile = path.join(workerDirectory, 'pdf.worker.mjs');
        // The guest worker bundles PDF.js itself, but PDF.js resolves its
        // fake worker by file URL at runtime. Keep the matching worker beside
        // the staged guest bundle instead of relying on a host node_modules
        // tree that does not exist inside the Windows guest.
        await copyFile(pdfWorkerSource, pdfWorkerFile);
        const winappTool = await prepareWinappTool(layout, options.winappToolSourceDirectory);
        const temporaryWorkerDirectory = path.join(workerDirectory, `.bundle-${randomUUID()}`);
        await mkdir(temporaryWorkerDirectory);
        try {
            const temporaryWorkerFile = path.join(temporaryWorkerDirectory, 'guestWorker.cjs');
            await bundleGuestWorker({
                repoRoot: repositoryRoot,
                outFile: temporaryWorkerFile,
            });
            await rename(`${temporaryWorkerFile}.map`, `${workerFile}.map`);
            await rename(temporaryWorkerFile, workerFile);
        } finally {
            await rm(temporaryWorkerDirectory, {
                recursive: true,
                force: true,
            });
        }
        const scriptsDirectory = path.join(repositoryRoot, 'scripts/windows-test/guest/powershell');
        for (const name of await readdir(scriptsDirectory)) {
            if (name.endsWith('.ps1')) {
                await copyFile(path.join(scriptsDirectory, name), path.join(powerShellDirectory, name));
            }
        }
        // Preserve machine configuration and all VM images. Preparing code and
        // fixtures cannot establish a Windows installation or qualify a driver.
        return {
            workerFile,
            pdfWorkerFile,
            winappArchiveFile: winappTool.archivePath,
            winappExecutableFile: winappTool.executablePath,
            winappNativeLibraryFile: winappTool.nativeLibraryPath,
            fixtureManifestFile,
            fixtureCount: declaredFiles.length,
            standaloneUtmctl,
            configPresent: await readFile(layout.configFile).then(() => true, () => false),
        };
    });
}
