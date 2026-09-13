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
        archiveBytes: 2232144,
        archiveSha256: 'fefe5412c56bb97d1b4349ad022fba28437ed96bd337052d827ac56ab92fae31',
    },
    'djvulibre-win32-x64': {
        archiveBytes: 743966,
        archiveSha256: '5784c92dceca50aadf0a282eb5b03211e4a5a5a5bea1fe1af443fadf032699e2',
    },
    'poppler-darwin-arm64': {
        archiveBytes: 5062527,
        archiveSha256: '6af16714ed6ff3b81c806c0f225cbb0f27028c4ce9429aecb5985a9d85379304',
    },
    'poppler-linux-x64': {
        archiveBytes: 15494364,
        archiveSha256: 'bd6d36375d18fd4bd32669105e8fded23fb886cffc245817a61a5f4e2f34cd91',
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
        archiveBytes: 3958419,
        archiveSha256: '9e94819f38366a8e5b73886e0c533d8094ac07608231b262ebfe8ce5af1902c4',
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
        archiveBytes: 70734477,
        archiveSha256: '5ce0e22bf79807d9b79badb768e0bcc1b4037b6044fc4f3d23bb2914698eac39',
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
        archiveUrl: archiveUrl(key),
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
    manifestSha256: '51e8244fede9bf9577b6d3b00d3c4deedd622a94100767222a9b3dae197beeb9',
};
