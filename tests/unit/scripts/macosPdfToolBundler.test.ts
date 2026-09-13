import {
    chmodSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
    delimiter,
    join,
    resolve,
} from 'node:path';
import { spawnSync } from 'node:child_process';
import {
    afterEach,
    describe,
    expect,
    it,
} from 'vitest';

const tempRoots: string[] = [];
const bundlerPath = resolve(process.cwd(), 'scripts/bundle-pdf-tools-macos.sh');

function writeExecutable(filePath: string, source: string) {
    writeFileSync(filePath, source);
    chmodSync(filePath, 0o755);
}

function createFakeMacBundlingHost() {
    const root = mkdtempSync(join(tmpdir(), 'evb-macos-pdf-bundle-'));
    tempRoots.push(root);
    const binDir = join(root, 'bin');
    const brewPrefix = join(root, 'homebrew');
    mkdirSync(binDir, { recursive: true });
    mkdirSync(join(brewPrefix, 'bin'), { recursive: true });
    mkdirSync(join(brewPrefix, 'lib'), { recursive: true });
    mkdirSync(join(brewPrefix, 'opt/poppler/lib'), { recursive: true });
    mkdirSync(join(brewPrefix, 'opt/qpdf/lib'), { recursive: true });

    for (const tool of [
        'pdftoppm',
        'pdftotext',
        'pdfinfo',
        'pdfimages',
        'qpdf',
    ]) {
        writeExecutable(join(brewPrefix, 'bin', tool), '#!/bin/sh\nexit 0\n');
    }
    writeFileSync(join(brewPrefix, 'opt/poppler/lib/libpoppler.1.dylib'), 'poppler');
    writeFileSync(join(brewPrefix, 'opt/qpdf/lib/libqpdf.1.dylib'), 'qpdf');
    writeFileSync(join(brewPrefix, 'lib/libshared.dylib'), 'shared');

    writeExecutable(join(binDir, 'uname'), '#!/bin/sh\necho arm64\n');
    writeExecutable(join(binDir, 'brew'), [
        '#!/bin/sh',
        'if [ "$1" = "--prefix" ]; then',
        '  printf "%s\\n" "$FAKE_BREW_PREFIX"',
        'fi',
        'exit 0',
        '',
    ].join('\n'));
    writeExecutable(join(binDir, 'install_name_tool'), '#!/bin/sh\nexit 0\n');
    writeExecutable(join(binDir, 'codesign'), '#!/bin/sh\nexit 0\n');

    return {
        binDir,
        brewPrefix,
        resourcesDir: join(root, 'resources'),
    };
}

function runBundler(host: ReturnType<typeof createFakeMacBundlingHost>) {
    return spawnSync('bash', [bundlerPath], {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: {
            ...process.env,
            EVB_PDF_TOOLS_RESOURCES_DIR: host.resourcesDir,
            EVB_RUNTIME_BINARIES_FROM_SOURCE: '1',
            FAKE_BREW_PREFIX: host.brewPrefix,
            PATH: `${host.binDir}${delimiter}${process.env.PATH ?? ''}`,
        },
    });
}

describe('macOS PDF tool bundler', { timeout: 60_000 }, () => {
    afterEach(() => {
        for (const root of tempRoots.splice(0)) {
            rmSync(root, {
                force: true,
                recursive: true,
            });
        }
    });

    it('fails before replacing resources when a required Homebrew tool is missing', () => {
        const host = createFakeMacBundlingHost();
        rmSync(join(host.brewPrefix, 'bin/pdfimages'));
        writeExecutable(join(host.binDir, 'otool'), '#!/bin/sh\nexit 0\n');

        const result = runBundler(host);

        expect(result.status).not.toBe(0);
        expect(`${result.stdout}${result.stderr}`).toContain('Missing required Homebrew tool');
    });

    it('stages only canonical SONAME dylibs instead of dead unversioned and full-version copies', () => {
        const host = createFakeMacBundlingHost();
        writeFileSync(join(host.brewPrefix, 'opt/poppler/lib/libpoppler.dylib'), 'dead');
        writeFileSync(join(host.brewPrefix, 'opt/poppler/lib/libpoppler.1.2.3.dylib'), 'dead');
        writeFileSync(join(host.brewPrefix, 'opt/qpdf/lib/libqpdf.dylib'), 'dead');
        writeFileSync(join(host.brewPrefix, 'opt/qpdf/lib/libqpdf.1.2.3.dylib'), 'dead');
        writeExecutable(join(host.binDir, 'otool'), '#!/bin/sh\nexit 0\n');

        const result = runBundler(host);

        expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
        const popplerLib = join(host.resourcesDir, 'poppler/darwin-arm64/lib');
        const qpdfLib = join(host.resourcesDir, 'qpdf/darwin-arm64/lib');
        expect(existsSync(join(popplerLib, 'libpoppler.1.dylib'))).toBe(true);
        expect(existsSync(join(qpdfLib, 'libqpdf.1.dylib'))).toBe(true);
        expect(existsSync(join(popplerLib, 'libpoppler.dylib'))).toBe(false);
        expect(existsSync(join(popplerLib, 'libpoppler.1.2.3.dylib'))).toBe(false);
        expect(existsSync(join(qpdfLib, 'libqpdf.dylib'))).toBe(false);
        expect(existsSync(join(qpdfLib, 'libqpdf.1.2.3.dylib'))).toBe(false);
    });

    it('fails when rewritten bundles retain Homebrew references', () => {
        const host = createFakeMacBundlingHost();
        writeExecutable(join(host.binDir, 'otool'), [
            '#!/bin/sh',
            'printf "%s:\\n" "$2"',
            'printf "\\t%s/lib/libshared.dylib (compatibility version 1.0.0, current version 1.0.0)\\n" "$FAKE_BREW_PREFIX"',
            '',
        ].join('\n'));

        const result = runBundler(host);

        expect(result.status).not.toBe(0);
        expect(`${result.stdout}${result.stderr}`).toContain('Unrelocated dependency');
    });
});
