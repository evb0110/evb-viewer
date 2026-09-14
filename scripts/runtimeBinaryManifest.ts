import type {
    IRuntimeBinaryDataManifestEntry,
    IRuntimeBinaryManifest,
    IRuntimeBinaryManifestEntry,
} from '@scripts/runtimeBinaryArchive';
import {parseNativeResourcePlatformArch} from '@scripts/nativeResourceManifest';

const RUNTIME_ASSET_BASE_URL = 'https://github.com/evb0110/evb-viewer/releases/download/runtime-binaries-v1';

const RUNTIME_ARCHIVES = {
    'djvulibre-darwin-arm64': {
        archiveBytes: 1266990,
        archiveSha256: 'd1d15fb133cc885fb48bb952b42c7f3488cd340a532c595a99a4c7adea92d4d9',
    },
    'djvulibre-linux-x64': {
        archiveBytes: 1982130,
        archiveSha256: '45279beb3d88ff4e1b8785313a2f5ad3ab6e277599828c6c51645128704a24fa',
    },
    'djvulibre-win32-x64': {
        archiveBytes: 744199,
        archiveSha256: 'df70594d1fab95c1616411c3dbbf566188d91bdff00b99f6f39d699a282b35f1',
    },
    'poppler-darwin-arm64': {
        archiveBytes: 5062527,
        archiveSha256: '6af16714ed6ff3b81c806c0f225cbb0f27028c4ce9429aecb5985a9d85379304',
    },
    'poppler-linux-x64': {
        archiveBytes: 8820348,
        archiveSha256: '88ed8ec41ba1e230eef7a0657237c907d00380a9b7fdfba5c1c9b3d2af034f07',
    },
    'poppler-win32-x64': {
        archiveBytes: 13375476,
        archiveSha256: '05c7e58af8a8f0c1d0f8e9fbb270fe51312a17e4ccb7ab201c0461b3e164a694',
    },
    'qpdf-darwin-arm64': {
        archiveBytes: 5097153,
        archiveSha256: '8031fb1f62b159179bc38ba80bc3ee478141d2b511357db63f880c5edab60aa0',
    },
    'qpdf-linux-x64': {
        archiveBytes: 1471609,
        archiveSha256: 'cb01670b9155c524e73f7ef3a72c38a1569a8db730ace91c1ad51317ea5ff6a6',
    },
    'qpdf-win32-x64': {
        archiveBytes: 3205447,
        archiveSha256: 'a9b0295aef660c10644c351c2b1810066d930e9d8b871bd3d81755adcbe434dd',
    },
    'tesseract-darwin-arm64': {
        archiveBytes: 27863568,
        archiveSha256: '0544ed3014ac8cb8cc21166037d45b2b2c7fe6cb3683b166d16eb8e59570adda',
    },
    'tesseract-linux-x64': {
        // Tesseract 5.5.3 from scripts/bundle-tools-linux.sh. Versioned so the
        // 4.1.1 asset that older commits pin stays byte-identical.
        assetName: 'tesseract-linux-x64-5.5.3',
        archiveBytes: 4472496,
        archiveSha256: '65f3f9ce37a0cd57adf1df170aade5f2fc4275229cb60e3990d16ae9c2120e7c',
    },
    'tesseract-win32-x64': {
        archiveBytes: 56140942,
        archiveSha256: 'db15391cd3d6026b1106433adbd7ad0348171b81011f4ddd3b72241b91bfc315',
    },
    'tesseract-tessdata': {
        archiveBytes: 258006852,
        archiveSha256: '320164b0e06576afcde72f686f6de130aa4335e8e620be9e4a85435afd5d6767',
    },
} as const;

function archiveUrl(name: string) {
    return `${RUNTIME_ASSET_BASE_URL}/${name}.tar.gz`;
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
        archiveUrl: archiveUrl('assetName' in archive ? archive.assetName : key),
        executableEntry: `${familyId}/${targetTag}/bin/${executableName}`,
        familyId,
        target: parseNativeResourcePlatformArch(targetTag),
    } satisfies IRuntimeBinaryManifestEntry;
}

export const RUNTIME_BINARY_MANIFEST_ENTRIES: readonly IRuntimeBinaryManifestEntry[] = [...([
    'darwin-arm64',
    'linux-x64',
    'win32-x64',
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
    manifestSha256: 'ed076f0c2658d6b0aee8f8557e60b17c8040325987ce930ec9f07c55fb3c3bbf',
};
