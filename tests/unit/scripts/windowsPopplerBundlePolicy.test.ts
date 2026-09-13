import { readFileSync } from 'node:fs';
import {spawnSync} from 'node:child_process';
import { resolve } from 'node:path';
import {
    describe,
    expect,
    it,
} from 'vitest';

const bundlerSource = readFileSync(resolve(process.cwd(), 'scripts/bundle-tools-windows.sh'), 'utf8');

describe('Windows Poppler bundle policy', () => {
    it('uses the verified runtime manifest for x64 acquisition and member selection', () => {
        expect(bundlerSource).toContain(
            'runRuntimeBinaryArchiveCli.ts" fetch poppler "$PLATFORM_ARCH" "$POPPLER_CACHE_DIR_FOR_NODE"',
        );
        expect(bundlerSource).toContain(
            'runRuntimeBinaryArchiveCli.ts" verify-members poppler "$POPPLER_ARCHIVE_WINDOWS" paths',
        );
        expect(bundlerSource).toContain('POPPLER_EXE_MEMBER_PATHS_FILE=');
        expect(bundlerSource).toContain('POPPLER_DLL_MEMBER_PATHS_FILE=');
        expect(bundlerSource).toContain('POPPLER_EXPECTED_DLL_COUNT" -eq 0');
        expect(bundlerSource).toContain(
            'require_directory "$POPPLER_ROOT/share/poppler" "Poppler data directory from the verified archive"',
        );
        expect(bundlerSource).not.toContain('POPPLER_URL=');
        expect(bundlerSource).not.toContain('POPPLER_SHA256=');
        expect(bundlerSource).not.toContain('download "$POPPLER_URL"');
    });

    it('keeps Poppler DLL copy failures in the parent shell', () => {
        const memberFile = bundlerSource.indexOf('POPPLER_DLL_MEMBER_PATHS_FILE=');
        const loopStart = bundlerSource.indexOf('while IFS= read -r dll_entry;', memberFile);
        const loopEnd = bundlerSource.indexOf('\nPOPPLER_EXPECTED_EXE_COUNT=', loopStart);
        expect(loopStart).toBeGreaterThan(memberFile);
        expect(loopEnd).toBeGreaterThan(loopStart);
        const loop = bundlerSource.slice(loopStart, loopEnd);
        const result = spawnSync('bash', [
            '-c',
            [
                'set -euo pipefail',
                'TEMP_DIR="$(mktemp -d)"',
                'trap \'rm -rf "$TEMP_DIR"\' EXIT',
                'POPPLER_DIR="$TEMP_DIR/poppler"',
                'mkdir -p "$POPPLER_DIR/bin"',
                'POPPLER_DLL_MEMBER_PATHS_FILE="$TEMP_DIR/dll-members"',
                'printf \'poppler-24.08.0/Library/bin/poppler.dll\\n\' > "$POPPLER_DLL_MEMBER_PATHS_FILE"',
                'copy_required_tool() { return 1; }',
                loop,
                'printf \'sentinel\\n\'',
            ].join('\n'),
        ], {encoding: 'utf8'});

        expect(result.error).toBeUndefined();
        expect(result.status).toBe(1);
        expect(`${result.stdout}${result.stderr}`).not.toContain('sentinel');
    });

    it('does not retain the unused optional GLib binding', () => {
        expect(bundlerSource).toContain('rm -f "$POPPLER_DIR/bin/poppler-glib.dll"');
    });
});
