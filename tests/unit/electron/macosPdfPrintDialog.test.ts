import type * as TViMockOriginalModule from '@electron/native-tools/resolveNativeToolsBase';
import type * as TViMockOriginalModule2 from '@electron/utils/platformArch';

import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {join} from 'node:path';

const mocks = vi.hoisted(() => ({
    existsSync: vi.fn(),
    resolveNativeToolsBase: vi.fn(),
    resolvePlatformArchTag: vi.fn(),
    runNativeCommand: vi.fn(),
}));

vi.mock('node:fs', () => ({existsSync: mocks.existsSync}));
vi.mock('@electron/native-tools/resolveNativeToolsBase', async (importOriginal) => ({
    ...(await importOriginal<typeof TViMockOriginalModule>()),
    resolveNativeToolsBase: mocks.resolveNativeToolsBase,
}));
vi.mock('@electron/utils/platformArch', async (importOriginal_1) => ({
    ...(await importOriginal_1<typeof TViMockOriginalModule2>()),
    resolvePlatformArchTag: mocks.resolvePlatformArchTag,
}));
vi.mock('@electron/native-tools/runNativeCommand', () => ({runNativeCommand: mocks.runNativeCommand}));

async function loadModule() {
    vi.resetModules();
    return await import('@electron/utils/openMacOsPdfPrintDialog');
}

async function loadBinaryResolver() {
    vi.resetModules();
    return await import('@electron/utils/resolveMacOsPdfPrintDialogBinary');
}

describe('macOS PDF print dialog helper', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.existsSync.mockReturnValue(false);
        mocks.resolveNativeToolsBase.mockReturnValue('/repo/resources');
        mocks.resolvePlatformArchTag.mockReturnValue('darwin-arm64');
        mocks.runNativeCommand.mockResolvedValue({
            exitCode: 0,
            stderr: '',
            stdout: '',
        });
    });

    it('resolves the staged development helper when no bundled candidate exists', async () => {
        const {resolveMacOsPdfPrintDialogBinary} = await loadBinaryResolver();

        expect(resolveMacOsPdfPrintDialogBinary({
            cwd: '/repo',
            exists: () => false,
            isPackaged: false,
            nativeToolsBase: '/repo/resources',
            platformArch: 'darwin-arm64',
        })).toBe(join(
            '/repo',
            '.tmp',
            'pdf-print-dialog',
            'darwin-arm64',
            'bin',
            'pdf-print-dialog',
        ));
    });

    it('uses a staged bundled candidate during development when it is present', async () => {
        const bundledCandidate = join(
            '/repo/resources',
            'pdf-print-dialog',
            'darwin-arm64',
            'bin',
            'pdf-print-dialog',
        );
        const {resolveMacOsPdfPrintDialogBinary} = await loadBinaryResolver();

        expect(resolveMacOsPdfPrintDialogBinary({
            cwd: '/repo',
            exists: candidate => candidate === bundledCandidate,
            isPackaged: false,
            nativeToolsBase: '/repo/resources',
            platformArch: 'darwin-arm64',
        })).toBe(bundledCandidate);
    });

    it('resolves the packaged helper from the launchable native-tools root', async () => {
        const {resolveMacOsPdfPrintDialogBinary} = await loadBinaryResolver();

        expect(resolveMacOsPdfPrintDialogBinary({
            cwd: '/repo',
            exists: () => false,
            isPackaged: true,
            nativeToolsBase: '/app/Contents/MacOS/native-tools',
            platformArch: 'darwin-arm64',
        })).toBe(join(
            '/app',
            'Contents',
            'MacOS',
            'native-tools',
            'pdf-print-dialog',
            'darwin-arm64',
            'bin',
            'pdf-print-dialog',
        ));
    });

    it('reports a successful native dialog and forwards the callback and signal', async () => {
        const onNativeDialogOpened = vi.fn();
        const controller = new AbortController();
        const pdfPath = '/documents/print-source.pdf';
        const {openMacOsPdfPrintDialog} = await loadModule();

        const resultPromise = openMacOsPdfPrintDialog(pdfPath, {
            onNativeDialogOpened,
            signal: controller.signal,
        });
        await vi.waitFor(() => {
            expect(mocks.runNativeCommand).toHaveBeenCalledOnce();
        });
        const commandOptions = mocks.runNativeCommand.mock.calls[0]?.[2] as {
            onSpawn?: (pid: number) => void;
            signal?: AbortSignal;
        } | undefined;
        commandOptions?.onSpawn?.(12_345);

        await expect(resultPromise).resolves.toEqual({success: true});
        expect(onNativeDialogOpened).toHaveBeenCalledOnce();
        expect(mocks.runNativeCommand).toHaveBeenCalledWith(
            join(
                process.cwd(),
                '.tmp',
                'pdf-print-dialog',
                'darwin-arm64',
                'bin',
                'pdf-print-dialog',
            ),
            [pdfPath],
            expect.objectContaining({
                allowedExitCodes: [
                    0,
                    2,
                ],
                commandLabel: 'pdf-print-dialog',
                maxStderrBytes: 64 * 1024,
                maxStdoutBytes: 64 * 1024,
                signal: controller.signal,
                timeoutMs: 30 * 60_000,
            }),
        );
    });

    it('maps the native cancellation exit code to a canceled result', async () => {
        mocks.runNativeCommand.mockResolvedValue({
            exitCode: 2,
            stderr: '',
            stdout: '',
        });
        const {openMacOsPdfPrintDialog} = await loadModule();

        await expect(openMacOsPdfPrintDialog('/documents/print-source.pdf'))
            .resolves.toEqual({
                success: false,
                canceled: true,
                error: 'Print dialog canceled',
            });
    });

    it('propagates a native command failure to the print handoff', async () => {
        mocks.runNativeCommand.mockRejectedValue(new Error('Native print helper failed'));
        const {openMacOsPdfPrintDialog} = await loadModule();

        await expect(openMacOsPdfPrintDialog('/documents/print-source.pdf'))
            .rejects.toThrow('Native print helper failed');
    });
});
