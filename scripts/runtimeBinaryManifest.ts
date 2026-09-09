import type {
    IRuntimeBinaryManifest,
    IRuntimeBinaryManifestEntry,
} from '@scripts/runtimeBinaryArchive';
import {parseNativeResourcePlatformArch} from '@scripts/nativeResourceManifest';
import type {IRuntimeBinaryArchiveMemberPolicy} from '@scripts/validateRuntimeBinaryArchiveMembers';

export const QPDF_RUNTIME_BINARY_ENTRY: IRuntimeBinaryManifestEntry = {
    archiveKind: 'zip',
    archiveBytes: 24555583,
    archiveSha256: '8941870a604e7c87ed24566b038d46c24ce76616254d2383c578f60c0677f202',
    archiveUrl: 'https://github.com/qpdf/qpdf/releases/download/v12.3.2/qpdf-12.3.2-msvc64.zip',
    executableEntry: 'qpdf-12.3.2-msvc64/bin/qpdf.exe',
    familyId: 'qpdf',
    target: parseNativeResourcePlatformArch('win32-x64'),
};

const POPPLER_WINDOWS_BIN = 'poppler-24.08.0/Library/bin';

export const POPPLER_RUNTIME_BINARY_ENTRY: IRuntimeBinaryManifestEntry = {
    archiveKind: 'zip',
    archiveBytes: 15090263,
    archiveSha256: '58a6f9ae269756231d2f9aa6cba39d75fec6deacaf3c4a50683383b5f3d5a527',
    archiveUrl: 'https://github.com/oschwartz10612/poppler-windows/releases/download/v24.08.0-0/Release-24.08.0-0.zip',
    executableEntry: `${POPPLER_WINDOWS_BIN}/pdftoppm.exe`,
    familyId: 'poppler',
    target: parseNativeResourcePlatformArch('win32-x64'),
};

export const RUNTIME_BINARY_MANIFEST: IRuntimeBinaryManifest = {
    entries: [
        QPDF_RUNTIME_BINARY_ENTRY,
        POPPLER_RUNTIME_BINARY_ENTRY,
    ],
    manifestSha256: 'e1cc5ebe5e7b0e8e0a938b3741ec8940e0a49bff8790a863a5b5cc6ed8b494a1',
};

export const QPDF_RUNTIME_BINARY_MEMBER_POLICY: IRuntimeBinaryArchiveMemberPolicy = {
    executableEntry: QPDF_RUNTIME_BINARY_ENTRY.executableEntry,
    requiredAdjacentDllEntries: [
        'qpdf-12.3.2-msvc64/bin/concrt140.dll',
        'qpdf-12.3.2-msvc64/bin/msvcp140.dll',
        'qpdf-12.3.2-msvc64/bin/msvcp140_1.dll',
        'qpdf-12.3.2-msvc64/bin/msvcp140_2.dll',
        'qpdf-12.3.2-msvc64/bin/msvcp140_atomic_wait.dll',
        'qpdf-12.3.2-msvc64/bin/msvcp140_codecvt_ids.dll',
        'qpdf-12.3.2-msvc64/bin/qpdf30.dll',
        'qpdf-12.3.2-msvc64/bin/vcruntime140.dll',
        'qpdf-12.3.2-msvc64/bin/vcruntime140_1.dll',
    ],
};

export const POPPLER_RUNTIME_BINARY_MEMBER_POLICY: IRuntimeBinaryArchiveMemberPolicy = {
    executableEntry: POPPLER_RUNTIME_BINARY_ENTRY.executableEntry,
    requiredExecutableEntries: [
        `${POPPLER_WINDOWS_BIN}/pdfinfo.exe`,
        `${POPPLER_WINDOWS_BIN}/pdftocairo.exe`,
        `${POPPLER_WINDOWS_BIN}/pdftotext.exe`,
        `${POPPLER_WINDOWS_BIN}/pdfimages.exe`,
    ],
    requiredAdjacentDllEntries: [
        'Lerc.dll',
        'cairo.dll',
        'charset.dll',
        'deflate.dll',
        'expat.dll',
        'fontconfig-1.dll',
        'freetype.dll',
        'iconv.dll',
        'jpeg8.dll',
        'lcms2.dll',
        'libcrypto-3-x64.dll',
        'libcurl.dll',
        'libexpat.dll',
        'liblzma.dll',
        'libpng16.dll',
        'libssh2.dll',
        'libtiff.dll',
        'libzstd.dll',
        'openjp2.dll',
        'pixman-1-0.dll',
        'poppler-cpp.dll',
        'poppler.dll',
        'tiff.dll',
        'zlib.dll',
        'zstd.dll',
    ].map(name => `${POPPLER_WINDOWS_BIN}/${name}`),
    excludedAdjacentDllEntries: [`${POPPLER_WINDOWS_BIN}/poppler-glib.dll`],
    requiredDirectoryEntries: ['poppler-24.08.0/share/poppler/'],
};
