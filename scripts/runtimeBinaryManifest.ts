import type {
    IRuntimeBinaryDataManifestEntry,
    IRuntimeBinaryManifest,
    IRuntimeBinaryManifestEntry,
} from '@scripts/runtimeBinaryArchive';
import {parseNativeResourcePlatformArch} from '@scripts/nativeResourceManifest';

const RUNTIME_ASSET_BASE_URL = 'https://github.com/evb0110/evb-viewer/releases/download';

const RUNTIME_ARCHIVES = {
    'poppler-darwin-arm64': {
        releaseName: 'runtime-binaries-v3',
        archiveBytes: 7274975,
        archiveSha256: 'eea821ec7dabec07f06b45d6836bc5bf6a91cdb58ebc5f170c901e21cf190888',
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
    // v4 restores the shared libqpdf that pdf-page-ops loads beside qpdf.
    'qpdf-darwin-arm64': {
        releaseName: 'runtime-binaries-v4',
        archiveBytes: 1350407,
        archiveSha256: '8b148823fa24423285a2b768a54021af6d6c5f41295858957f04756faaafa2ec',
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
    'tesseract-tessdata': {
        assetName: 'tesseract-tessdata-v3',
        archiveBytes: 335082789,
        archiveSha256: '8f5093955af710d99796199d4897268cf36001e94f0375ac10ee6ba0dafaaecc',
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
    createRuntimeEntry('poppler', target, target.startsWith('win32') ? 'pdftoppm.exe' : 'pdftoppm'),
    createRuntimeEntry('qpdf', target, target.startsWith('win32') ? 'qpdf.exe' : 'qpdf'),
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
    manifestSha256: '1c5c5fe0a746c00b71120b6d291754fd064a56642b6ed78226d8f2f8faac1f24',
};
