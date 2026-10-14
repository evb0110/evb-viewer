import { join } from 'node:path';
import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    electronAppStatePath,
    electronFileLogDir,
    getCurrentSessionName,
    releaseCurrentSessionName,
    resolveAutomationFileLogDir,
    sessionsBaseDir,
    sessionDir,
    setCurrentSessionName,
    validateSessionName,
} from '@scripts/electron-run/electronRunSessionPaths';

describe('electron run session paths', () => {
    it('allows simple session names', () => {
        expect(validateSessionName('default')).toBe('default');
        expect(validateSessionName('smoke-test_1.local')).toBe('smoke-test_1.local');
    });

    it('isolates default automation directories by session', () => {
        const first = electronFileLogDir('first-session');
        const second = electronFileLogDir('second-session');

        expect(first).not.toBe(second);
        expect(first).toBe(join(sessionsBaseDir, 'first-session', 'electron-logs'));
        expect(second).toBe(join(sessionsBaseDir, 'second-session', 'electron-logs'));
        try {
            for (const value of [
                '',
                '   ',
            ]) {
                vi.stubEnv('EVB_APP_STATE_DIR', value);
                expect(electronAppStatePath('first-session')).toBe(join(sessionsBaseDir, 'first-session', 'app-state'));
                expect(electronAppStatePath('second-session')).toBe(join(sessionsBaseDir, 'second-session', 'app-state'));
            }
            vi.stubEnv('EVB_APP_STATE_DIR', '  /task/explicit-state  ');
            expect(electronAppStatePath('first-session')).toBe('/task/explicit-state');
        } finally {
            vi.unstubAllEnvs();
        }
    });

    it('uses a safe session directory when the override is unset or empty', () => {
        expect(resolveAutomationFileLogDir({}, 'session')).toBe(electronFileLogDir('session'));
        expect(resolveAutomationFileLogDir({EVB_FILE_LOG_DIR: ''}, 'session')).toBe(electronFileLogDir('session'));
    });

    it('keeps an explicit non-empty automation log directory override', () => {
        expect(resolveAutomationFileLogDir({EVB_FILE_LOG_DIR: '/tmp/explicit-logs'}, 'session'))
            .toBe('/tmp/explicit-logs');
    });

    it('rejects session names that can escape the sessions directory', () => {
        for (const name of [
            '',
            '.',
            '..',
            '../default',
            'default/other',
            'default\\other',
            '/tmp/default',
        ]) {
            expect(() => validateSessionName(name)).toThrow(/Session name/u);
            expect(() => sessionDir(name)).toThrow(/Session name/u);
        }
    });

    it('validates the current session before storing it', () => {
        expect(() => setCurrentSessionName('../default')).toThrow(/Session name/u);
    });

    it('releases only the session that still owns the process scope', () => {
        setCurrentSessionName('retiring-session');
        expect(releaseCurrentSessionName('retiring-session')).toBe(true);
        expect(getCurrentSessionName()).toBe('default');

        setCurrentSessionName('replacement-session');
        expect(releaseCurrentSessionName('retiring-session')).toBe(false);
        expect(getCurrentSessionName()).toBe('replacement-session');
        setCurrentSessionName('default');
    });
});
