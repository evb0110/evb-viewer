import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
    mkdir, readFile, writeFile, 
} from 'node:fs/promises';
import path from 'node:path';
import type { IWindowsTestHostLayout } from '@scripts/windows-test/contracts/windowsTestPaths';
import type { TWindowsTestArchitecture } from '@scripts/windows-test/contracts/windowsTestContracts';
import type { IWindowsTestStagedInput } from '@scripts/windows-test/host/runCoordinator';

// BtbN builds are linked by ffmpeg.org. Pin archive identity, never a moving latest asset.
const RELEASE = 'autobuild-2026-09-17-13-19';
const BUILD = 'ffmpeg-n9.0.1-69-g3e11912860';
const HASHES = {
    arm64: 'd8652294c4f131cab58fa2d3a37462f0ec1144f85a35ad19df88159c9f450375',
    x64: '0182996f8e5009885cd67b7eb9fccf44ccf02583a36e04be3acf32c655466aa4',
};

function toolPaths(layout: IWindowsTestHostLayout, arch: TWindowsTestArchitecture) {
    const name = `${BUILD}-${arch === 'arm64' ? 'winarm64' : 'win64'}-gpl-9.0`;
    const root = path.join(layout.toolsCacheDir, 'recording', name);
    return {
        name,
        root,
        archive: path.join(root, 'archive.zip'),
    };
}

export async function prepareWindowsRecordingTools(layout: IWindowsTestHostLayout, arch: TWindowsTestArchitecture) {
    const paths = toolPaths(layout, arch);
    await mkdir(paths.root, {recursive: true});
    let archive = await readFile(paths.archive).catch(() => null);
    if (!archive) {
        const response = await fetch(`https://github.com/BtbN/FFmpeg-Builds/releases/download/${RELEASE}/${paths.name}.zip`);
        if (!response.ok) { throw new Error(`Windows recording tool download failed: ${response.status}`); }
        archive = Buffer.from(await response.arrayBuffer());
    }
    if (createHash('sha256').update(archive).digest('hex') !== HASHES[arch]) {
        throw new Error('Windows FFmpeg archive failed its pinned SHA-256 check');
    }
    await writeFile(paths.archive, archive);
    for (const executable of [
        'ffmpeg.exe',
        'ffprobe.exe',
    ]) {
        const bytes = execFileSync('unzip', [
            '-p',
            paths.archive,
            `${paths.name}/bin/${executable}`,
        ], {maxBuffer: 256 * 1024 * 1024});
        if (!bytes.length) { throw new Error(`Missing ${executable} in verified archive`); }
        await writeFile(path.join(paths.root, executable), bytes);
    }
    return paths.root;
}

export async function windowsRecordingToolInputs(layout: IWindowsTestHostLayout, arch: TWindowsTestArchitecture): Promise<IWindowsTestStagedInput[]> {
    const paths = toolPaths(layout, arch);
    return Promise.all([
        'ffmpeg.exe',
        'ffprobe.exe',
    ].map(async executable => {
        const hostPath = path.join(paths.root, executable);
        const bytes = await readFile(hostPath).catch(() => {
            throw new Error(`Missing ${hostPath}. Run EVB_RECORD_SESSION=1 pnpm windows:test:prepare first.`);
        });
        return {
            hostPath,
            guestRelativePath: `recording-tools/${executable}`,
            sha256: createHash('sha256').update(bytes).digest('hex'),
        };
    }));
}
