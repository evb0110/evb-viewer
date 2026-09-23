import {execFileSync} from 'node:child_process';
import {
    chmodSync,
    mkdirSync,
    mkdtempSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    assertElectronNativePageOps,
    assertStagedNativeToolProtocols,
} from '@scripts/assert-electron-native-page-ops.mjs';
import {GENERATED_RUST_NATIVE_TOOL_PROTOCOLS} from '@contracts/nativeToolProtocols';

const scriptPath = fileURLToPath(new URL('../../../scripts/assert-electron-native-page-ops.mjs', import.meta.url));
const pageOpsProtocol = GENERATED_RUST_NATIVE_TOOL_PROTOCOLS.find(protocol => protocol.binaryName === 'evb-pdf-page-ops')!;

function currentHandshake(protocol: typeof GENERATED_RUST_NATIVE_TOOL_PROTOCOLS[number]) {
    return JSON.stringify({
        protocolVersion: protocol.protocolVersion,
        capabilities: ('capabilities' in protocol ? protocol.capabilities : []).map(capability => capability.name),
    });
}

// A POSIX fake helper that answers --protocol-version with `handshake`.
function writeFakeHelper(path: string, handshake: string) {
    writeFileSync(path, `#!/bin/sh\nif [ "$1" = "--protocol-version" ]; then printf '%s' '${handshake}'; else printf 'fixture\\n'; fi\n`);
    chmodSync(path, 0o755);
}

describe('Electron native page-ops admission', () => {
    it('requires the launcher flag for native suites', () => {
        expect(() => assertElectronNativePageOps({
            project: 'e2e-regression',
            env: {},
        })).toThrow('EVB_PDF_PAGE_OPS_ENABLE=1');
    });

    it('keeps explicit native-disabled negative runs admissible', () => {
        expect(assertElectronNativePageOps({
            project: 'e2e-regression',
            env: {EVB_PDF_PAGE_OPS_DISABLE: '1'},
        })).toMatchObject({
            required: true,
            disabled: true,
            toolPath: null,
        });
    });

    it('does not require page ops for non-native suites', () => {
        expect(assertElectronNativePageOps({
            project: 'e2e-rapid-navigation',
            env: {},
        })).toMatchObject({
            required: false,
            disabled: false,
            toolPath: null,
        });
    });

    it('admits a runnable native binary that speaks the current protocol', () => {
        const directory = mkdtempSync(join(tmpdir(), 'evb-native-page-ops-admission-'));
        const binaryPath = join(directory, process.platform === 'win32' ? 'evb-pdf-page-ops.cmd' : 'evb-pdf-page-ops');
        try {
            if (process.platform === 'win32') {
                writeFileSync(binaryPath, `@if "%1"=="--protocol-version" (echo ${currentHandshake(pageOpsProtocol)}) else (echo evb-pdf-page-ops test fixture)\r\n`);
            } else {
                writeFakeHelper(binaryPath, currentHandshake(pageOpsProtocol));
            }
            const output = execFileSync(process.execPath, [
                scriptPath,
                'e2e-regression',
            ], {
                // An empty project root keeps this machine's staged helpers out of the check.
                cwd: directory,
                env: {
                    ...process.env,
                    EVB_PDF_PAGE_OPS_ENABLE: '1',
                    EVB_PDF_PAGE_OPS_DISABLE: '',
                    EVB_PDF_PAGE_OPS_PATH: binaryPath,
                },
                encoding: 'utf8',
            });
            expect(output).toContain('[native-page-ops] admitted e2e-regression:');
        } finally {
            rmSync(directory, {
                recursive: true,
                force: true,
            });
        }
    });

    it.skipIf(process.platform === 'win32')('refuses a page-ops helper built from older sources and names the rebuild', () => {
        const directory = mkdtempSync(join(tmpdir(), 'evb-native-page-ops-stale-'));
        const binaryPath = join(directory, 'evb-pdf-page-ops');
        try {
            writeFakeHelper(binaryPath, '1');
            expect(() => assertElectronNativePageOps({
                project: 'e2e-regression',
                projectRoot: directory,
                env: {
                    EVB_PDF_PAGE_OPS_ENABLE: '1',
                    EVB_PDF_PAGE_OPS_PATH: binaryPath,
                },
                protocols: GENERATED_RUST_NATIVE_TOOL_PROTOCOLS,
            })).toThrow(`speaks protocol 1${pageOpsProtocol.capabilities.length > 0 ? ' without incremental-page-rotation' : ''}, but this checkout expects ${pageOpsProtocol.protocolVersion}. It was built from older sources; rebuild it with node scripts/build-native-tool.mjs pdf-page-ops.`);
        } finally {
            rmSync(directory, {
                recursive: true,
                force: true,
            });
        }
    });

    it.skipIf(process.platform === 'win32')('refuses any staged helper that speaks an older protocol', () => {
        const projectRoot = mkdtempSync(join(tmpdir(), 'evb-native-staged-protocols-'));
        const imageCombine = GENERATED_RUST_NATIVE_TOOL_PROTOCOLS.find(protocol => protocol.binaryName === 'evb-pdf-image-combine')!;
        const binDirectory = join(projectRoot, '.tmp', imageCombine.stagingName, `${process.platform}-${process.arch}`, 'bin');
        try {
            mkdirSync(binDirectory, {recursive: true});
            writeFakeHelper(join(binDirectory, imageCombine.binaryName), String(imageCombine.protocolVersion));
            expect(() => assertStagedNativeToolProtocols({
                projectRoot,
                protocols: GENERATED_RUST_NATIVE_TOOL_PROTOCOLS,
            })).not.toThrow();

            writeFakeHelper(join(binDirectory, imageCombine.binaryName), String(imageCombine.protocolVersion - 1));
            expect(() => assertStagedNativeToolProtocols({
                projectRoot,
                protocols: GENERATED_RUST_NATIVE_TOOL_PROTOCOLS,
            })).toThrow('rebuild it with node scripts/build-native-tool.mjs pdf-image-combine');
        } finally {
            rmSync(projectRoot, {
                recursive: true,
                force: true,
            });
        }
    });
});
