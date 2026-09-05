import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    mkdtemp,
    readFile,
    rm,
    stat,
    writeFile,
} from 'fs/promises';
import {join} from 'path';
import {tmpdir} from 'os';

let tempRoot = '';
const runNativeToolCommand = vi.hoisted(() => vi.fn());

vi.mock('electron', () => ({app: {getPath: vi.fn(() => tempRoot)}}));
vi.mock('@electron/features/page-ops/main/nativePageOpsPath', () => ({
    isNativePageOpsDisabled: () => false,
    resolveNativePageOpsPath: () => '/mock/evb-pdf-page-ops',
}));
vi.mock('@electron/native-tools/runNativeToolCommand', () => ({runNativeToolCommand}));

async function loadDecryptModule() {
    vi.resetModules();
    return import('@electron/file-access/workingCopyDecryption');
}

describe('working-copy PDF decryption', () => {
    beforeEach(async () => {
        vi.clearAllMocks();
        tempRoot = await mkdtemp(join(tmpdir(), 'evb-pdf-decrypt-test-'));
    });

    afterEach(async () => {
        await rm(tempRoot, {
            force: true,
            recursive: true,
        });
    });

    it('passes the password through a mode-600 scratch file and removes it after success', async () => {
        const observed: {
            args: string[];
            passwordFileContents: string | null
        } = {
            args: [],
            passwordFileContents: null,
        };
        runNativeToolCommand.mockImplementation(async (_command: string, args: string[]) => {
            observed.args = args;
            const outputPath = args[args.indexOf('--output') + 1]!;
            const passwordPath = args[args.indexOf('--password-file') + 1]!;
            observed.passwordFileContents = await readFile(passwordPath, 'utf8');
            await writeFile(outputPath, '%PDF-1.7\nplain\n');
            await writeFile(`${outputPath}.decrypt.json`, JSON.stringify({
                format: 'evb-pdf-decrypt',
                schemaVersion: 1,
                outcome: 'rewritten',
                wasEncrypted: true,
                revision: 6,
            }));
            return {
                stdout: '',
                stderr: '',
                exitCode: 0,
            };
        });
        const sourcePath = join(tempRoot, 'working-copy.pdf');
        await writeFile(sourcePath, '%PDF-1.7\n/Encrypt\n');
        const {decryptWorkingCopyWithWriter} = await loadDecryptModule();

        await expect(decryptWorkingCopyWithWriter(sourcePath, 'correct horse battery staple'))
            .resolves.toEqual({
                outcome: 'decrypted',
                wasEncrypted: true,
                revision: 6,
            });

        expect(observed.args).toContain('decrypt');
        expect(observed.args).toContain('--password-file');
        expect(observed.args.join(' ')).not.toContain('correct horse battery staple');
        expect(observed.passwordFileContents).toBe('correct horse battery staple\n');
        const passwordPath = observed.args[observed.args.indexOf('--password-file') + 1]!;
        await expect(stat(passwordPath)).rejects.toMatchObject({code: 'ENOENT'});
        expect(runNativeToolCommand).toHaveBeenCalledWith(
            '/mock/evb-pdf-page-ops',
            observed.args,
            expect.objectContaining({commandLabel: 'evb-pdf-page-ops(decrypt)'}),
        );
    });

    it('returns needs-password without touching the working copy for a wrong password', async () => {
        runNativeToolCommand.mockRejectedValueOnce({
            code: 'needs-password',
            message: 'password rejected',
        });
        const sourcePath = join(tempRoot, 'protected.pdf');
        const sourceBytes = '%PDF-1.7\n/Encrypt\n';
        await writeFile(sourcePath, sourceBytes);
        const {decryptWorkingCopyWithWriter} = await loadDecryptModule();

        await expect(decryptWorkingCopyWithWriter(sourcePath, 'wrong-password'))
            .resolves.toEqual({
                outcome: 'needs-password',
                wasEncrypted: true,
                revision: null,
            });
        await expect(readFile(sourcePath, 'utf8')).resolves.toBe(sourceBytes);
        expect(runNativeToolCommand.mock.calls[0]?.[1]).not.toContain('wrong-password');
        const args = runNativeToolCommand.mock.calls[0]?.[1] as string[];
        const passwordPath = args[args.indexOf('--password-file') + 1]!;
        await expect(stat(passwordPath)).rejects.toMatchObject({code: 'ENOENT'});
    });

    it('returns unsupported for a handler the writer cannot probe', async () => {
        runNativeToolCommand.mockRejectedValueOnce({
            code: 'unsupported-filter',
            message: 'public-key handler',
        });
        const sourcePath = join(tempRoot, 'public-key.pdf');
        await writeFile(sourcePath, '%PDF-1.7\n/Encrypt\n');
        const {decryptWorkingCopyWithWriter} = await loadDecryptModule();

        await expect(decryptWorkingCopyWithWriter(sourcePath))
            .resolves.toEqual({
                outcome: 'unsupported',
                wasEncrypted: true,
                revision: null,
            });
        expect(runNativeToolCommand.mock.calls[0]?.[1]).not.toContain('--password-file');
    });
});
