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
        archiveBytes: 744199,
        archiveSha256: 'df70594d1fab95c1616411c3dbbf566188d91bdff00b99f6f39d699a282b35f1',
    },
    'djvulibre-win32-arm64': {
        releaseName: 'runtime-binaries-v2',
        archiveBytes: 27857136,
        archiveSha256: '29cf605759ec9e67024878e7834e599e029e81381dce7b2ce0af8579e362a510',
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
        archiveBytes: 1397022,
        archiveSha256: '10355e009b44387e712bc577d47af70396f1ac0771a35fc3e00685b4e481929c',
    },
    'qpdf-darwin-arm64': {
        archiveBytes: 5097153,
        archiveSha256: '8031fb1f62b159179bc38ba80bc3ee478141d2b511357db63f880c5edab60aa0',
    },
    'qpdf-linux-x64': {
        releaseName: 'runtime-binaries-v2',
        archiveBytes: 1479305,
        archiveSha256: '6ac9bb703d5240fc1f3582b088f6ebdc652c565f4e9b0f66da35d40171b8ff1c',
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
        assetName: 'tesseract-darwin-arm64-5.5.3',
        archiveBytes: 3302588,
        archiveSha256: '5c0083aafd1b00e9c432251e961512eb3a9efa0d2e4e9b465a96f2773cab94f3',
    },
    'tesseract-linux-x64': {
        // Versioned so the v1 runtime-binaries asset stays byte-identical.
        releaseName: 'runtime-binaries-v2',
        assetName: 'tesseract-linux-x64-5.5.3',
        archiveBytes: 4098923,
        archiveSha256: '2854ed939528208a9e5ceaf2a4eed3a0bd6a5a7d6e493e4ff30338fc4bbbb192',
    },
    'tesseract-linux-arm64': {
        releaseName: 'runtime-binaries-v2',
        assetName: 'tesseract-linux-arm64-5.5.3',
        archiveBytes: 3963817,
        archiveSha256: '0a240c51ec1bc016b2eb3409ba6534acf3b5afeaa60482ad03a36fcf1cb87519',
    },
    'tesseract-win32-x64': {
        releaseName: 'runtime-binaries-v2',
        assetName: 'tesseract-win32-x64-5.5.3',
        archiveBytes: 2833675,
        archiveSha256: '72a8f91a5e136deba14d2da35494cc49ffd526d0b17e582c03b060014fa108dc',
    },
    'tesseract-win32-arm64': {
        releaseName: 'runtime-binaries-v2',
        assetName: 'tesseract-win32-arm64-5.5.3',
        archiveBytes: 2399912,
        archiveSha256: 'dc716e3902c7577de2fee6ade4522f97beb70ae4cb4d62e2a78181bd5b6190f2',
    },
    'tesseract-tessdata': {
        archiveBytes: 258006852,
        archiveSha256: '320164b0e06576afcde72f686f6de130aa4335e8e620be9e4a85435afd5d6767',
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
    archiveUrl: archiveUrl('tesseract-tessdata'),
    resourceRoot: 'tesseract/tessdata',
};

export const RUNTIME_BINARY_MANIFEST: IRuntimeBinaryManifest = {
    entries: RUNTIME_BINARY_MANIFEST_ENTRIES,
    dataEntries: [TESSDATA_RUNTIME_DATA_ENTRY],
    manifestSha256: 'a169d6bf6bb48a8ca490ca254ff8e5aca669abc291b5982fd222e2f329d75f15',
};
