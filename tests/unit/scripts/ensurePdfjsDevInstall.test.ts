import {describe, expect, it, vi} from 'vitest';
import {ensurePdfjsDevInstall, formatPdfjsDevIdentityFailure, getPdfjsDevIdentityProblems} from '@scripts/ensure-pdfjs-dev-install.mjs';

const expected = {
    archivePath: '/repo/vendor/pdfjs-dist/pdfjs-dist.tgz',
    expectedVersion: '6.3.311',
    installedPackagePath: '/repo/node_modules/pdfjs-dist/package.json',
    publicStampPath: '/repo/public/pdf/.pdfjs-version',
};

describe('PDF.js development install identity', () => {
    it('detects an old installed runtime and reports the exact transition boundary', () => {
        const identity = {
            ...expected,
            installedVersion: '5.7.284',
            publicVersion: '6.3.311',
        };

        expect(getPdfjsDevIdentityProblems(identity)).toEqual(['installed 5.7.284 != expected 6.3.311']);
        expect(formatPdfjsDevIdentityFailure(identity, getPdfjsDevIdentityProblems(identity))).toContain('pnpm install --frozen-lockfile');
    });

    it('repairs once and verifies both installed and served identities', () => {
        const stale = {
            ...expected,
            installedVersion: '5.7.284',
            publicVersion: '6.3.311',
        };
        const fresh = {
            ...expected,
            installedVersion: '6.3.311',
            publicVersion: '6.3.311',
        };
        const install = vi.fn();
        const readIdentity = vi.fn().mockReturnValueOnce(stale).mockReturnValueOnce(fresh);

        expect(
            ensurePdfjsDevInstall({
                install,
                readIdentity,
            }),
        ).toEqual({
            repaired: true,
            identity: fresh,
        });
        expect(install).toHaveBeenCalledOnce();
        expect(readIdentity).toHaveBeenCalledTimes(2);
    });

    it('does not reinstall a synchronized identity', () => {
        const identity = {
            ...expected,
            installedVersion: '6.3.311',
            publicVersion: '6.3.311',
        };
        const install = vi.fn();

        expect(
            ensurePdfjsDevInstall({
                install,
                readIdentity: () => identity,
            }),
        ).toEqual({
            repaired: false,
            identity,
        });
        expect(install).not.toHaveBeenCalled();
    });

    it('repairs a stale served asset stamp even when the installed runtime is current', () => {
        const stale = {
            ...expected,
            installedVersion: '6.3.311',
            publicVersion: '5.7.284',
        };
        const fresh = {
            ...expected,
            installedVersion: '6.3.311',
            publicVersion: '6.3.311',
        };
        const install = vi.fn();
        const readIdentity = vi.fn().mockReturnValueOnce(stale).mockReturnValueOnce(fresh);

        expect(
            ensurePdfjsDevInstall({
                install,
                readIdentity,
            }),
        ).toEqual({
            repaired: true,
            identity: fresh,
        });
        expect(install).toHaveBeenCalledOnce();
    });

    it('fails closed when installation does not repair the identity', () => {
        const stale = {
            ...expected,
            installedVersion: '5.7.284',
            publicVersion: '6.3.311',
        };
        const install = vi.fn();

        expect(() =>
            ensurePdfjsDevInstall({
                install,
                readIdentity: () => stale,
            }),
        ).toThrow('installed 5.7.284 != expected 6.3.311');
        expect(install).toHaveBeenCalledOnce();
    });
});
