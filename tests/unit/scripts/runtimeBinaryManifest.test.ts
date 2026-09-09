import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    POPPLER_RUNTIME_BINARY_ENTRY,
    POPPLER_RUNTIME_BINARY_MEMBER_POLICY,
    QPDF_RUNTIME_BINARY_ENTRY,
    QPDF_RUNTIME_BINARY_MEMBER_POLICY,
    RUNTIME_BINARY_MANIFEST,
} from '@scripts/runtimeBinaryManifest';
import {
    computeRuntimeBinaryManifestSha256,
    validateRuntimeBinaryManifest,
} from '@scripts/runtimeBinaryArchive';
import {validateRuntimeBinaryArchiveMembers} from '@scripts/validateRuntimeBinaryArchiveMembers';
import {
    assertAllowedRuntimeBinaryDownloadRedirect,
    fetchRuntimeBinaryArchiveResponseBody,
    runRuntimeBinaryArchiveCli,
} from '@scripts/runRuntimeBinaryArchiveCli';

describe('runtime binary manifest', () => {
    it('pins qpdf to the supported target and publisher archive', () => {
        expect(validateRuntimeBinaryManifest(RUNTIME_BINARY_MANIFEST)).toBe(RUNTIME_BINARY_MANIFEST);
        expect(computeRuntimeBinaryManifestSha256(RUNTIME_BINARY_MANIFEST.entries)).toBe(
            'e1cc5ebe5e7b0e8e0a938b3741ec8940e0a49bff8790a863a5b5cc6ed8b494a1',
        );
        expect(RUNTIME_BINARY_MANIFEST.manifestSha256).toBe(
            'e1cc5ebe5e7b0e8e0a938b3741ec8940e0a49bff8790a863a5b5cc6ed8b494a1',
        );
        expect(QPDF_RUNTIME_BINARY_ENTRY).toMatchObject({
            archiveKind: 'zip',
            archiveBytes: 24555583,
            archiveSha256: '8941870a604e7c87ed24566b038d46c24ce76616254d2383c578f60c0677f202',
            archiveUrl: 'https://github.com/qpdf/qpdf/releases/download/v12.3.2/qpdf-12.3.2-msvc64.zip',
            executableEntry: 'qpdf-12.3.2-msvc64/bin/qpdf.exe',
            familyId: 'qpdf',
            target: {
                arch: 'x64',
                exeSuffix: '.exe',
                platform: 'win32',
                platformArch: 'win32-x64',
            },
        });
        expect(QPDF_RUNTIME_BINARY_MEMBER_POLICY.requiredAdjacentDllEntries).toHaveLength(9);
        expect(POPPLER_RUNTIME_BINARY_ENTRY).toMatchObject({
            archiveKind: 'zip',
            archiveBytes: 15090263,
            archiveSha256: '58a6f9ae269756231d2f9aa6cba39d75fec6deacaf3c4a50683383b5f3d5a527',
            archiveUrl: 'https://github.com/oschwartz10612/poppler-windows/releases/download/v24.08.0-0/Release-24.08.0-0.zip',
            executableEntry: 'poppler-24.08.0/Library/bin/pdftoppm.exe',
            familyId: 'poppler',
            target: {
                arch: 'x64',
                exeSuffix: '.exe',
                platform: 'win32',
                platformArch: 'win32-x64',
            },
        });
        expect(POPPLER_RUNTIME_BINARY_MEMBER_POLICY.requiredExecutableEntries).toHaveLength(4);
        expect(POPPLER_RUNTIME_BINARY_MEMBER_POLICY.requiredAdjacentDllEntries).toHaveLength(25);
        expect(POPPLER_RUNTIME_BINARY_MEMBER_POLICY.excludedAdjacentDllEntries).toEqual(['poppler-24.08.0/Library/bin/poppler-glib.dll']);
        expect(POPPLER_RUNTIME_BINARY_MEMBER_POLICY.requiredDirectoryEntries).toEqual(['poppler-24.08.0/share/poppler/']);
    });

    it('rejects a changed qpdf entry under the fixed manifest identity', () => {
        expect(() => validateRuntimeBinaryManifest({
            ...RUNTIME_BINARY_MANIFEST,
            entries: [{
                ...QPDF_RUNTIME_BINARY_ENTRY,
                archiveUrl: 'https://example.test/replaced-qpdf.zip',
            }],
        })).toThrow('does not match');
    });

    it('keeps the manifest executable and member contract aligned', () => {
        const members = [
            QPDF_RUNTIME_BINARY_ENTRY.executableEntry,
            ...QPDF_RUNTIME_BINARY_MEMBER_POLICY.requiredAdjacentDllEntries,
        ];
        expect(validateRuntimeBinaryArchiveMembers(
            members,
            QPDF_RUNTIME_BINARY_MEMBER_POLICY,
        ).executableEntry).toBe(QPDF_RUNTIME_BINARY_ENTRY.executableEntry);
    });

    it('records the qpdf runtime bin listing without rejecting upstream helper executables', () => {
        const recordedBinMembers = [
            'qpdf-12.3.2-msvc64/bin/concrt140.dll',
            'qpdf-12.3.2-msvc64/bin/fix-qdf.exe',
            'qpdf-12.3.2-msvc64/bin/msvcp140.dll',
            'qpdf-12.3.2-msvc64/bin/msvcp140_1.dll',
            'qpdf-12.3.2-msvc64/bin/msvcp140_2.dll',
            'qpdf-12.3.2-msvc64/bin/msvcp140_atomic_wait.dll',
            'qpdf-12.3.2-msvc64/bin/msvcp140_codecvt_ids.dll',
            'qpdf-12.3.2-msvc64/bin/qpdf.exe',
            'qpdf-12.3.2-msvc64/bin/qpdf30.dll',
            'qpdf-12.3.2-msvc64/bin/vcruntime140.dll',
            'qpdf-12.3.2-msvc64/bin/vcruntime140_1.dll',
            'qpdf-12.3.2-msvc64/bin/zlib-flate.exe',
        ];
        expect(validateRuntimeBinaryArchiveMembers(
            recordedBinMembers,
            QPDF_RUNTIME_BINARY_MEMBER_POLICY,
        )).toEqual({
            adjacentDllEntries: QPDF_RUNTIME_BINARY_MEMBER_POLICY.requiredAdjacentDllEntries,
            executableEntry: QPDF_RUNTIME_BINARY_ENTRY.executableEntry,
            executableEntries: [QPDF_RUNTIME_BINARY_ENTRY.executableEntry],
            requiredDirectoryEntries: [],
        });
    });

    it('keeps the Poppler executable, DLL, and data-directory contract explicit', () => {
        const members = [
            ...POPPLER_RUNTIME_BINARY_MEMBER_POLICY.requiredExecutableEntries!,
            POPPLER_RUNTIME_BINARY_ENTRY.executableEntry,
            ...POPPLER_RUNTIME_BINARY_MEMBER_POLICY.requiredAdjacentDllEntries,
            ...POPPLER_RUNTIME_BINARY_MEMBER_POLICY.excludedAdjacentDllEntries!,
            ...POPPLER_RUNTIME_BINARY_MEMBER_POLICY.requiredDirectoryEntries!,
        ];
        const result = validateRuntimeBinaryArchiveMembers(
            members,
            POPPLER_RUNTIME_BINARY_MEMBER_POLICY,
        );

        expect(result.executableEntries).toHaveLength(5);
        expect(result.adjacentDllEntries).toHaveLength(25);
        expect(result.adjacentDllEntries).not.toContain(
            'poppler-24.08.0/Library/bin/poppler-glib.dll',
        );
        expect(result.requiredDirectoryEntries).toEqual(['poppler-24.08.0/share/poppler/']);
    });

    it('executes both explicit Poppler and legacy qpdf member dispatch', async () => {
        const popplerMembers = [
            'poppler-24.08.0/Library/bin/pdftoppm.exe',
            'poppler-24.08.0/Library/bin/pdfinfo.exe',
            'poppler-24.08.0/Library/bin/pdftocairo.exe',
            'poppler-24.08.0/Library/bin/pdftotext.exe',
            'poppler-24.08.0/Library/bin/pdfimages.exe',
            ...POPPLER_RUNTIME_BINARY_MEMBER_POLICY.requiredAdjacentDllEntries,
            ...POPPLER_RUNTIME_BINARY_MEMBER_POLICY.excludedAdjacentDllEntries!,
            'poppler-24.08.0/share/poppler/cidToUnicode',
        ];
        const qpdfMembers = [
            'qpdf-12.3.2-msvc64/bin/qpdf.exe',
            ...QPDF_RUNTIME_BINARY_MEMBER_POLICY.requiredAdjacentDllEntries,
        ];
        const readMembers = vi.fn((archivePath: string) => (
            archivePath.endsWith('poppler.zip') ? popplerMembers : qpdfMembers
        ));
        const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

        try {
            await runRuntimeBinaryArchiveCli([
                'verify-members',
                'poppler',
                'poppler.zip',
            ], readMembers);
            const popplerResult = JSON.parse(String(log.mock.calls.at(-1)?.[0])) as {
                executableEntries: string[];
                adjacentDllEntries: string[];
            };
            expect(popplerResult.executableEntries).toHaveLength(5);
            expect(popplerResult.adjacentDllEntries).toHaveLength(25);

            await runRuntimeBinaryArchiveCli([
                'verify-members',
                'qpdf.zip',
            ], readMembers);
            const qpdfResult = JSON.parse(String(log.mock.calls.at(-1)?.[0])) as {
                executableEntries: string[];
                adjacentDllEntries: string[];
            };
            expect(qpdfResult.executableEntries).toEqual([QPDF_RUNTIME_BINARY_ENTRY.executableEntry]);
            expect(qpdfResult.adjacentDllEntries).toHaveLength(9);
        } finally {
            log.mockRestore();
        }

        expect(readMembers).toHaveBeenNthCalledWith(1, expect.stringMatching(/poppler\.zip$/u));
        expect(readMembers).toHaveBeenNthCalledWith(2, expect.stringMatching(/qpdf\.zip$/u));
    });

    it('routes Windows x64 qpdf staging through verified archive and member checks', () => {
        const bundlerSource = readFileSync('scripts/bundle-tools-windows.sh', 'utf8');
        const archiveLookup = bundlerSource.indexOf(
            'runRuntimeBinaryArchiveCli.ts" fetch qpdf "$PLATFORM_ARCH" "$QPDF_CACHE_DIR_FOR_NODE"',
        );
        const memberCheck = bundlerSource.indexOf(
            'runRuntimeBinaryArchiveCli.ts" verify-members "$QPDF_ARCHIVE_WINDOWS" paths',
        );
        const extraction = bundlerSource.indexOf('unzip -qo "$QPDF_ARCHIVE"');

        expect(archiveLookup).toBeGreaterThanOrEqual(0);
        expect(memberCheck).toBeGreaterThan(archiveLookup);
        expect(extraction).toBeGreaterThan(memberCheck);
        expect(bundlerSource).toContain('cygpath -w "$CACHE_DIR"');
        expect(bundlerSource).toContain('cygpath -u "$QPDF_ARCHIVE_WINDOWS"');
        expect(bundlerSource).toContain('run-with-retries.sh" 5 10 "Windows qpdf archive download"');
        expect(bundlerSource).not.toContain('QPDF_SHA256=');
        expect(bundlerSource).not.toContain('cp "$QPDF_ARCHIVE" "$TEMP_DIR/qpdf.zip"');
        expect(bundlerSource).toContain('QPDF_EXE_RELATIVE="$(sed -n \'1p\' "$QPDF_MEMBER_PATHS_FILE")"');
        expect(bundlerSource).toContain('tail -n +2 "$QPDF_MEMBER_PATHS_FILE"');
        expect(bundlerSource).toContain('QPDF_DLL_MEMBER_PATHS_FILE="$TEMP_DIR/qpdf-dll-members.paths"');
        expect(bundlerSource).toContain('tail -n +2 "$QPDF_MEMBER_PATHS_FILE" > "$QPDF_DLL_MEMBER_PATHS_FILE"');
        expect(bundlerSource).toContain('done < "$QPDF_DLL_MEMBER_PATHS_FILE"');
        expect(bundlerSource).toContain('QPDF_EXPECTED_DLL_COUNT="$(awk \'END {print NR}\' "$QPDF_DLL_MEMBER_PATHS_FILE")"');
        expect(bundlerSource).toContain('QPDF_COPIED_DLL_COUNT="$(find "$QPDF_DIR/bin" -maxdepth 1 -type f -iname \'*.dll\' | wc -l)"');
        expect(bundlerSource).toContain('QPDF_EXPECTED_DLL_COUNT" -eq 0');
        expect(bundlerSource).toContain('Copied $QPDF_COPIED_DLL_COUNT qpdf DLLs, expected $QPDF_EXPECTED_DLL_COUNT');
    });

    it('routes Windows x64 Poppler staging through the shared verified archive contract', () => {
        const bundlerSource = readFileSync('scripts/bundle-tools-windows.sh', 'utf8');
        const archiveLookup = bundlerSource.indexOf(
            'runRuntimeBinaryArchiveCli.ts" fetch poppler "$PLATFORM_ARCH" "$POPPLER_CACHE_DIR_FOR_NODE"',
        );
        const memberCheck = bundlerSource.indexOf(
            'runRuntimeBinaryArchiveCli.ts" verify-members poppler "$POPPLER_ARCHIVE_WINDOWS" paths',
        );
        const extraction = bundlerSource.indexOf('unzip -qo "$POPPLER_ARCHIVE"');

        expect(archiveLookup).toBeGreaterThanOrEqual(0);
        expect(memberCheck).toBeGreaterThan(archiveLookup);
        expect(extraction).toBeGreaterThan(memberCheck);
        expect(bundlerSource).toContain('cygpath -w "$CACHE_DIR"');
        expect(bundlerSource).toContain('cygpath -u "$POPPLER_ARCHIVE_WINDOWS"');
        expect(bundlerSource).toContain('run-with-retries.sh" 5 10 "Windows Poppler archive download"');
        expect(bundlerSource).not.toContain('POPPLER_URL=');
        expect(bundlerSource).not.toContain('POPPLER_SHA256=');
        expect(bundlerSource).not.toContain('download "$POPPLER_URL"');
        expect(bundlerSource).toContain('POPPLER_EXE_MEMBER_PATHS_FILE=');
        expect(bundlerSource).toContain('POPPLER_DLL_MEMBER_PATHS_FILE=');
        expect(bundlerSource).toContain('POPPLER_EXPECTED_DLL_COUNT" -eq 0');
        expect(bundlerSource).toContain('require_directory "$POPPLER_ROOT/share/poppler"');
    });

    it('restricts qpdf redirects to the signed GitHub release asset origin', () => {
        const publisherUrl = QPDF_RUNTIME_BINARY_ENTRY.archiveUrl;
        expect(assertAllowedRuntimeBinaryDownloadRedirect(
            publisherUrl,
            'https://release-assets.githubusercontent.com/github-production-release-asset/example',
        )).toContain('release-assets.githubusercontent.com');
        expect(assertAllowedRuntimeBinaryDownloadRedirect(
            'https://release-assets.githubusercontent.com/github-production-release-asset/example',
            '/same-origin-follow-up',
        )).toContain('release-assets.githubusercontent.com');
        expect(() => assertAllowedRuntimeBinaryDownloadRedirect(
            publisherUrl,
            'https://objects.example.test/qpdf.zip',
        )).toThrow('untrusted origin');
        expect(() => assertAllowedRuntimeBinaryDownloadRedirect(
            publisherUrl,
            'http://release-assets.githubusercontent.com/qpdf.zip',
        )).toThrow('untrusted origin');
        expect(() => assertAllowedRuntimeBinaryDownloadRedirect(
            publisherUrl,
            'https://release-assets.githubusercontent.com:443/qpdf.zip',
        )).not.toThrow();
    });

    it('cancels a non-success response body before reporting the HTTP failure', async () => {
        const response = new Response('not found', {status: 404});
        const cancel = vi.spyOn(response.body!, 'cancel');
        vi.stubGlobal('fetch', vi.fn(async () => response));
        try {
            const iterator = fetchRuntimeBinaryArchiveResponseBody('https://github.com/qpdf/qpdf/archive.zip');
            await expect(iterator.next()).rejects.toThrow('HTTP status 404');
        } finally {
            vi.unstubAllGlobals();
        }
        expect(cancel).toHaveBeenCalledOnce();
    });

    it('cancels every trusted redirect body before consuming the archive', async () => {
        const redirectResponse = new Response('redirect', {
            headers: {location: 'https://release-assets.githubusercontent.com/github-production-release-asset/archive'},
            status: 302,
        });
        const redirectCancel = vi.spyOn(redirectResponse.body!, 'cancel');
        const successResponse = new Response('archive', {status: 200});
        vi.stubGlobal('fetch', vi.fn()
            .mockResolvedValueOnce(redirectResponse)
            .mockResolvedValueOnce(successResponse));
        try {
            const iterator = fetchRuntimeBinaryArchiveResponseBody('https://github.com/qpdf/qpdf/archive.zip');
            await expect(iterator.next()).resolves.toMatchObject({done: false});
            await iterator.return?.();
        } finally {
            vi.unstubAllGlobals();
        }
        expect(redirectCancel).toHaveBeenCalledOnce();
    });

    it('cancels the final redirect body before rejecting an excessive redirect chain', async () => {
        const responses = Array.from({length: 4}, () => new Response('redirect', {
            headers: {location: 'https://release-assets.githubusercontent.com/github-production-release-asset/archive'},
            status: 302,
        }));
        const cancellations = responses.map(response => vi.spyOn(response.body!, 'cancel'));
        vi.stubGlobal('fetch', vi.fn(async () => {
            const response = responses.shift();
            if (!response) throw new Error('unexpected fetch count');
            return response;
        }));
        try {
            const iterator = fetchRuntimeBinaryArchiveResponseBody('https://github.com/qpdf/qpdf/archive.zip');
            await expect(iterator.next()).rejects.toThrow('trusted redirect limit');
        } finally {
            vi.unstubAllGlobals();
        }
        expect(cancellations.every(cancel => cancel.mock.calls.length === 1)).toBe(true);
    });

    it('keeps qpdf DLL copy failures in the parent shell', () => {
        const bundlerSource = readFileSync('scripts/bundle-tools-windows.sh', 'utf8');
        const qpdfMemberFile = bundlerSource.indexOf('QPDF_DLL_MEMBER_PATHS_FILE=');
        const loopStart = bundlerSource.indexOf('while IFS= read -r dll_entry;', qpdfMemberFile);
        const loopEnd = bundlerSource.indexOf('\nQPDF_EXPECTED_DLL_COUNT=', loopStart);
        expect(loopStart).toBeGreaterThanOrEqual(0);
        expect(loopEnd).toBeGreaterThan(loopStart);
        const loop = bundlerSource.slice(loopStart, loopEnd);
        const result = spawnSync('bash', [
            '-c',
            [
                'set -euo pipefail',
                'TEMP_DIR="$(mktemp -d)"',
                'trap \'rm -rf "$TEMP_DIR"\' EXIT',
                'QPDF_DIR="$TEMP_DIR/qpdf"',
                'mkdir -p "$QPDF_DIR/bin"',
                'QPDF_DLL_MEMBER_PATHS_FILE="$TEMP_DIR/dll-members"',
                'printf \'qpdf-12.3.2-msvc64/bin/qpdf30.dll\\n\' > "$QPDF_DLL_MEMBER_PATHS_FILE"',
                'copy_required_tool() { return 1; }',
                loop,
                'printf \'sentinel\\n\'',
            ].join('\n'),
        ], {encoding: 'utf8'});
        expect(result.error).toBeUndefined();
        expect(result.status).toBe(1);
        expect(`${result.stdout}${result.stderr}`).not.toContain('sentinel');
    });
});
