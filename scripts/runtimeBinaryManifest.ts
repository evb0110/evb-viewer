import type {
    IRuntimeBinaryDataManifestEntry,
    IRuntimeBinaryManifest,
    IRuntimeBinaryManifestEntry,
} from '@scripts/runtimeBinaryArchive';
import {parseNativeResourcePlatformArch} from '@scripts/nativeResourceManifest';

const RUNTIME_ASSET_BASE_URL = 'https://github.com/evb0110/evb-viewer/releases/download';

const RUNTIME_ARCHIVES = {
    'djvulibre-darwin-arm64': {
        archiveBytes: 1266990,
        archiveSha256: 'd1d15fb133cc885fb48bb952b42c7f3488cd340a532c595a99a4c7adea92d4d9',
    },
    'djvulibre-linux-x64': {
        archiveBytes: 1982130,
        archiveSha256: '45279beb3d88ff4e1b8785313a2f5ad3ab6e277599828c6c51645128704a24fa',
    },
    'djvulibre-linux-arm64': {
        releaseName: 'runtime-binaries-v2',
        archiveBytes: 1898362,
        archiveSha256: 'ad1a0b8ecf48e27a1d9ac9dcd8acc0a338794697e1647edc82cc6ba09d986a88',
    },
    'djvulibre-win32-x64': {
        // DjVuLibre 3.5.30 with the Windows monitor ownership fix (#991).
        releaseName: 'runtime-binaries-v2',
        assetName: 'djvulibre-win32-x64-3.5.30-r2',
        archiveBytes: 2347377,
        archiveSha256: 'ccfe7b4c5615fdf380c4d783a70d52714ccbf7ac8a8b15caa7584cc93cbef7d9',
    },
    'djvulibre-win32-arm64': {
        releaseName: 'runtime-binaries-v2',
        assetName: 'djvulibre-win32-arm64-3.5.30-r2',
        archiveBytes: 2118748,
        archiveSha256: 'a675b31e4d01a8f25619c4e3f664de049022d4d92c93a9826422ac33209db836',
    },
    'poppler-darwin-arm64': {
        archiveBytes: 5062527,
        archiveSha256: '6af16714ed6ff3b81c806c0f225cbb0f27028c4ce9429aecb5985a9d85379304',
    },
    'poppler-linux-arm64': {
        releaseName: 'runtime-binaries-v2',
        archiveBytes: 8691429,
        archiveSha256: '667b936ce8f9943a122a1a39822ed5e0a2042d321f3609506ba2287bf1568b5b',
    },
    'poppler-linux-x64': {
        releaseName: 'runtime-binaries-v2',
        archiveBytes: 8827350,
        archiveSha256: '5f8c3b2bf377154840d6a7bb4723fba0d5851bb16e950faade3f58582b82d1dd',
    },
    'poppler-win32-x64': {
        archiveBytes: 13375476,
        archiveSha256: '05c7e58af8a8f0c1d0f8e9fbb270fe51312a17e4ccb7ab201c0461b3e164a694',
    },
    'poppler-win32-arm64': {
        releaseName: 'runtime-binaries-v2',
        archiveBytes: 32409679,
        archiveSha256: 'da4957f71b3fd9e693ddff18640aef1df4dfac48c61a8b551dfa9ed88b2c1eb8',
    },
    'qpdf-linux-arm64': {
        releaseName: 'runtime-binaries-v2',
        archiveBytes: 1397021,
        archiveSha256: '4a34454a29526e77d388a3af26dbaaad3c30569f1edf968b2c3e9ddded7a0a05',
    },
    'qpdf-darwin-arm64': {
        archiveBytes: 5097153,
        archiveSha256: '8031fb1f62b159179bc38ba80bc3ee478141d2b511357db63f880c5edab60aa0',
    },
    'qpdf-linux-x64': {
        releaseName: 'runtime-binaries-v2',
        archiveBytes: 1479305,
        archiveSha256: '51fed57410899a653137cff8a90ee6528bc319f9d7e0d6bed80fa92626c53cb6',
    },
    'qpdf-win32-x64': {
        archiveBytes: 3205447,
        archiveSha256: 'a9b0295aef660c10644c351c2b1810066d930e9d8b871bd3d81755adcbe434dd',
    },
    'qpdf-win32-arm64': {
        releaseName: 'runtime-binaries-v2',
        archiveBytes: 27716063,
        archiveSha256: '8a6130a25600225d0df1e3097eb168c8b1185abdd707cf5f88e37a85745f1feb',
    },
    'tesseract-darwin-arm64': {
        // Tesseract 5.5.3 built from the pinned source tarballs.
        releaseName: 'runtime-binaries-v2',
        assetName: 'tesseract-darwin-arm64-5.5.3-r2',
        archiveBytes: 3304377,
        archiveSha256: '16e8faa547f3b93255869577d1277c598adeefeecb039569feda3dbe254fc0ab',
    },
    'tesseract-linux-x64': {
        // Versioned so the v1 runtime-binaries asset stays byte-identical.
        releaseName: 'runtime-binaries-v2',
        assetName: 'tesseract-linux-x64-5.5.3',
        archiveBytes: 4098923,
        archiveSha256: '7fcbfd727051a018b3b3e127fc4d33533491a763f6563f0b924b5afabf3278b9',
    },
    'tesseract-linux-arm64': {
        releaseName: 'runtime-binaries-v2',
        assetName: 'tesseract-linux-arm64-5.5.3',
        archiveBytes: 3963819,
        archiveSha256: 'c8743bdf5c1ad590264cd01681322f7dbe6e9b0192cd2643ad8cbb5080c4044d',
    },
    'tesseract-win32-x64': {
        releaseName: 'runtime-binaries-v2',
        assetName: 'tesseract-win32-x64-5.5.3',
        archiveBytes: 2833681,
        archiveSha256: '44bb7800a56433fb19cbf287d5a9251bb6bf0ed6f11578946202cda811dbd2a0',
    },
    'tesseract-win32-arm64': {
        releaseName: 'runtime-binaries-v2',
        assetName: 'tesseract-win32-arm64-5.5.3',
        archiveBytes: 2399910,
        archiveSha256: 'a557170f424385adb316ddb5d405a4d6e3f6944e2f412b7ce3c1fe01febd5bfa',
    },
    'tesseract-tessdata': {
        assetName: 'tesseract-tessdata-v2',
        archiveBytes: 281957982,
        archiveSha256: '8820fbd40be49f5eefddd9cf9c6f81c9dfd6481e9d2172cb2f63dfa1f3c356ab',
    },
} as const;

function archiveUrl(name: string, releaseName = 'runtime-binaries-v1') {
    return `${RUNTIME_ASSET_BASE_URL}/${releaseName}/${name}.tar.gz`;
}

function createRuntimeEntry(
    familyId: IRuntimeBinaryManifestEntry['familyId'],
    targetTag: IRuntimeBinaryManifestEntry['target']['platformArch'],
    executableName: string,
) {
    const key = `${familyId}-${targetTag}` as keyof typeof RUNTIME_ARCHIVES;
    const archive = RUNTIME_ARCHIVES[key];
    return {
        archiveKind: 'tar.gz' as const,
        archiveBytes: archive.archiveBytes,
        archiveSha256: archive.archiveSha256,
        archiveUrl: archiveUrl(
            'assetName' in archive ? archive.assetName : key,
            'releaseName' in archive ? archive.releaseName : 'runtime-binaries-v1',
        ),
        executableEntry: `${familyId}/${targetTag}/bin/${executableName}`,
        familyId,
        target: parseNativeResourcePlatformArch(targetTag),
    } satisfies IRuntimeBinaryManifestEntry;
}

export const RUNTIME_BINARY_MANIFEST_ENTRIES: readonly IRuntimeBinaryManifestEntry[] = [...([
    'darwin-arm64',
    'linux-x64',
    'linux-arm64',
    'win32-x64',
    'win32-arm64',
] as const).flatMap(target => [
    createRuntimeEntry('tesseract', target, target.startsWith('win32') ? 'tesseract.exe' : 'tesseract'),
    createRuntimeEntry('poppler', target, target.startsWith('win32') ? 'pdftoppm.exe' : 'pdftoppm'),
    createRuntimeEntry('qpdf', target, target.startsWith('win32') ? 'qpdf.exe' : 'qpdf'),
    createRuntimeEntry('djvulibre', target, target.startsWith('win32') ? 'ddjvu.exe' : 'ddjvu'),
])];

export const TESSDATA_RUNTIME_DATA_ENTRY: IRuntimeBinaryDataManifestEntry = {
    archiveKind: 'tar.gz',
    archiveBytes: RUNTIME_ARCHIVES['tesseract-tessdata'].archiveBytes,
    archiveSha256: RUNTIME_ARCHIVES['tesseract-tessdata'].archiveSha256,
    archiveUrl: archiveUrl(RUNTIME_ARCHIVES['tesseract-tessdata'].assetName),
    resourceRoot: 'tesseract/tessdata',
};

export const RUNTIME_BINARY_MANIFEST: IRuntimeBinaryManifest = {
    entries: RUNTIME_BINARY_MANIFEST_ENTRIES,
    dataEntries: [TESSDATA_RUNTIME_DATA_ENTRY],
    manifestSha256: '2b11c167702b00390fb715ca64467548ad258407556ba4147c3123413ad08c3a',
};
