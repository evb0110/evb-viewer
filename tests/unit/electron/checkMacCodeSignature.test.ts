import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { NativeProcessError } from '@electron/native-tools/processResult';
import { runNativeCommand } from '@electron/native-tools/runNativeCommand';
import { checkMacCodeSignature } from '@electron/updates/checkMacCodeSignature';

vi.mock('@electron/native-tools/runNativeCommand', () => ({runNativeCommand: vi.fn()}));

const developerId = 'Authority=Developer ID Application: Fixture\nTeamIdentifier=ABCDE12345\n';

function codesignFixture(details: string, failure?: {stage: string; error: Error}) {
    vi.mocked(runNativeCommand).mockImplementation(async (command, args) => {
        const stage = args[0];
        if (command !== 'codesign' || !args.at(-1)?.endsWith('Signature Fixture.app')) {
            throw new Error('No signature data for this fixture');
        }
        if (failure && stage === failure.stage) {
            throw failure.error;
        }
        return {
            stdout: '',
            stderr: stage === '-d' ? details : '',
            exitCode: 0,
        };
    });
}

describe('checkMacCodeSignature', () => {
    beforeEach(() => {
        vi.stubGlobal('process', {
            ...process,
            execPath: '/fixtures/Signature Fixture.app/Contents/MacOS/Electron',
        });
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.mocked(runNativeCommand).mockReset();
    });

    it('accepts a verified Developer ID application signature with a team identifier', async () => {
        codesignFixture(developerId);

        await expect(checkMacCodeSignature()).resolves.toBe(true);
    });

    it.each([
        'Signature=adhoc\nTeamIdentifier=ABCDE12345',
        'Authority=Developer ID Application: Fixture\nTeamIdentifier=',
    ])('rejects a verified signature with incomplete Developer ID details (%s)', async (details) => {
        codesignFixture(details);

        await expect(checkMacCodeSignature()).resolves.toBe(false);
    });

    it.each(['--verify', '-d'])('reports an invalid signature when %s fails', async (stage) => {
        codesignFixture(developerId, {
            stage,
            error: new NativeProcessError('exit-code', 1, null, 'fixture signature is invalid'),
        });

        await expect(checkMacCodeSignature()).resolves.toBe(false);
    });

    it.each([
        ['--verify', 'codesign failed to start: ENOENT'],
        ['-d', 'codesign timed out after 30000ms'],
    ])('reports an unavailable result when %s cannot finish', async (stage, message) => {
        codesignFixture(developerId, {stage, error: new Error(message)});

        await expect(checkMacCodeSignature()).resolves.toBeNull();
    });
});
