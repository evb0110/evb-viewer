import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {compileAppStylesheet} from '@tests/helpers/compileAppStylesheet';

/**
 * `compileAppStylesheet` has to install a fallback `defineAppConfig` to read
 * `app/app.config.ts` outside Nuxt. That global belongs to the app build, not to
 * the test worker, so the helper must hand the worker back exactly the global it
 * borrowed — including the case where there was none, and the case where the
 * read failed.
 */

const scope = globalThis as {defineAppConfig?: <T>(config: T) => T};

function ownDefineAppConfig() {
    return Object.getOwnPropertyDescriptor(scope, 'defineAppConfig');
}

function identityAppConfig<T>(config: T) {
    return config;
}

function failingAppConfig(): never {
    throw new Error('app config unavailable');
}

let restoreOuterDescriptor: (() => void) | null = null;

beforeEach(() => {
    const outerDescriptor = ownDefineAppConfig();
    restoreOuterDescriptor = () => {
        if (outerDescriptor) {
            Object.defineProperty(scope, 'defineAppConfig', outerDescriptor);
        } else {
            delete scope.defineAppConfig;
        }
    };
    delete scope.defineAppConfig;
});

afterEach(() => {
    restoreOuterDescriptor?.();
    restoreOuterDescriptor = null;
    vi.doUnmock('@app/app.config');
    vi.resetModules();
});

describe('compileAppStylesheet', () => {
    it('compiles the product stylesheet the app itself ships', async () => {
        const css = await compileAppStylesheet(['flex']);

        // The rule the whole UI-scale chain hangs off, plus proof that Tailwind
        // really resolved `@import 'tailwindcss'` rather than passing the file
        // through: a hand-written stand-in would carry neither.
        expect(css).toContain('calc(16px * var(--app-ui-scale, 1))');
        expect(css).toMatch(/\.flex\s*\{\s*display:\s*flex;?\s*\}/u);
        // Nuxt UI's colour roles are re-derived from the same app config the
        // build reads, which is what needs the borrowed global: `neutral` maps
        // to a Tailwind palette there, so its shades have to come out resolved.
        expect(css).toMatch(/--ui-color-neutral-500:\s*[^;\s][^;]*;/u);
    });

    it('inlines the shipped font files so a page can measure real text', async () => {
        const css = await compileAppStylesheet([]);

        // A browser test builds its page with `setContent`, where a root-relative
        // font URL resolves against nothing and text silently falls back to a
        // system face that measures differently.
        expect(css).not.toContain("url('/fonts/noto-sans/");
        expect(css).toContain('url("data:font/woff2;base64,');
        // Only fonts: inlining every root-relative asset would drag images into
        // the stylesheet as base64 for no measurement benefit.
        expect(css).not.toMatch(/url\("data:image/u);
    });

    it('leaves no fallback global behind when the worker had none', async () => {
        expect(ownDefineAppConfig()).toBeUndefined();

        await compileAppStylesheet([]);

        expect(ownDefineAppConfig()).toBeUndefined();
        expect('defineAppConfig' in scope).toBe(false);
    });

    it('restores a pre-existing global untouched', async () => {
        const existing = identityAppConfig;
        scope.defineAppConfig = existing;

        await compileAppStylesheet([]);

        expect(scope.defineAppConfig).toBe(existing);
        expect(ownDefineAppConfig()).toStrictEqual({
            configurable: true,
            enumerable: true,
            value: existing,
            writable: true,
        });
    });

    it('restores an explicitly undefined global as an own property', async () => {
        // `??=` overwrites this one, so restoring the value alone is not enough:
        // the property has to come back, still owned and still undefined.
        Object.defineProperty(scope, 'defineAppConfig', {
            configurable: true,
            enumerable: true,
            value: undefined,
            writable: true,
        });

        await compileAppStylesheet([]);

        expect('defineAppConfig' in scope).toBe(true);
        expect(scope.defineAppConfig).toBeUndefined();
    });

    it('restores the global when reading the app config throws', async () => {
        vi.doMock('@app/app.config', failingAppConfig);
        vi.resetModules();

        // Vitest reports a failing module factory through its own error, so the
        // assertion is that the read failed at all — what matters here is the
        // state the helper leaves behind when it does.
        await expect(compileAppStylesheet([])).rejects.toThrow();

        expect(ownDefineAppConfig()).toBeUndefined();
        expect('defineAppConfig' in scope).toBe(false);
    });

    it('restores a pre-existing global when reading the app config throws', async () => {
        const existing = identityAppConfig;
        scope.defineAppConfig = existing;
        vi.doMock('@app/app.config', failingAppConfig);
        vi.resetModules();

        await expect(compileAppStylesheet([])).rejects.toThrow();

        expect(scope.defineAppConfig).toBe(existing);
    });

    /**
     * A runner may be started from anywhere — another worktree, a parent
     * directory, a CI scratch dir — so the helper has to find the repository
     * from its own location. The decoy tree makes the failure mode concrete: a
     * cwd-derived root would find a readable `app/assets/css/main.css` there and
     * compile that instead of the product's, silently and without an ENOENT.
     */
    it('compiles the repository stylesheet from an unrelated working directory', async () => {
        const originalCwd = process.cwd();
        const decoyRoot = await mkdtemp(join(tmpdir(), 'evb-compile-app-stylesheet-'));
        await mkdir(join(decoyRoot, 'app/assets/css'), {recursive: true});
        await writeFile(join(decoyRoot, 'app/assets/css/main.css'), '.decoy-stylesheet {color: red;}\n', 'utf8');

        try {
            process.chdir(decoyRoot);
            // The module reads its paths once, at import time, so the fresh
            // import is what proves the resolution no longer follows the cwd.
            vi.resetModules();
            const {compileAppStylesheet: compileFromDecoyCwd} = await import('@tests/helpers/compileAppStylesheet');

            const css = await compileFromDecoyCwd(['flex']);

            expect(css).toContain('calc(16px * var(--app-ui-scale, 1))');
            expect(css).toMatch(/\.flex\s*\{\s*display:\s*flex;?\s*\}/u);
            expect(css).not.toContain('decoy-stylesheet');
        } finally {
            process.chdir(originalCwd);
            await rm(decoyRoot, {
                force: true,
                recursive: true,
            });
        }
    });
});
