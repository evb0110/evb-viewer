import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    decodeCanonicalAppFrame,
    normalizeCanonicalApplicationFrames,
} from '@contracts/diagnostics/canonicalAppFrames';

describe('canonical application frame normalization', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('normalizes macOS source frames and removes local paths, queries, and fragments', () => {
        const result = normalizeCanonicalApplicationFrames(`Error: local message
    at openDocument (file:///Users/alice/Projects/evb-viewer/app/modules/viewer.ts?document=/Users/alice/private.pdf#secret:12:8)
    at __webpack_require__ (file:///Users/alice/Projects/evb-viewer/dist-electron/runtime.js:1:1)
    at injected (https://evil.example/app/injected.js:2:3)`);

        expect(result.frames).toEqual([{
            module: 'app/modules/viewer.ts',
            function: 'openDocument',
            line: 12,
            column: 8,
        }]);
        expect(JSON.stringify(result)).not.toContain('/Users/alice');
        expect(JSON.stringify(result)).not.toContain('?');
        expect(JSON.stringify(result)).not.toContain('#');
    });

    it('normalizes Windows development paths and Vite file-system origins', () => {
        const result = normalizeCanonicalApplicationFrames(`at load (C:\\Users\\Alice\\src\\evb-viewer\\electron\\window.ts?token=private#fragment:23:4)
    at render (http://127.0.0.1:3235/@fs/C:/Users/Alice/src/evb-viewer/app/render.ts:31:9)
    at external (https://example.test/app/external.ts:1:1)`);

        expect(result.frames).toEqual([
            {
                module: 'electron/window.ts',
                function: 'load',
                line: 23,
                column: 4,
            },
            {
                module: 'app/render.ts',
                function: 'render',
                line: 31,
                column: 9,
            },
        ]);
    });

    it('normalizes Linux packaged bundles and vendored pdf.js frames', () => {
        const result = normalizeCanonicalApplicationFrames(`at draw (file:///opt/EVB%20Viewer/resources/app.asar/.output/public/_nuxt/viewer-abc.js:31:7)
    at getPage (file:///opt/EVB%20Viewer/resources/app.asar/node_modules/pdfjs-dist/build/pdf.mjs:88:5)
    at main (file:///opt/EVB%20Viewer/resources/app.asar/dist-electron/main.js:4:2)`);

        expect(result.frames).toEqual([
            {
                module: '_nuxt/viewer-abc.js',
                function: 'draw',
                line: 31,
                column: 7,
            },
            {
                module: 'node_modules/pdfjs-dist/build/pdf.mjs',
                function: 'getPage',
                line: 88,
                column: 5,
            },
            {
                module: 'dist-electron/main.js',
                function: 'main',
                line: 4,
                column: 2,
            },
        ]);
    });

    it('normalizes packaged renderer frames only from the application origin', () => {
        const result = normalizeCanonicalApplicationFrames(`at canary (evb-viewer://app/_nuxt/viewer-abc.js:17:9)
    at injected (evb-viewer://extension/_nuxt/injected.js:2:3)`);

        expect(result.frames).toEqual([{
            module: '_nuxt/viewer-abc.js',
            function: 'canary',
            line: 17,
            column: 9,
        }]);
    });

    it('normalizes the production web host, the current preview host, and Nitro task bundles', () => {
        vi.stubGlobal('location', {hostname: 'evb-viewer-preview-abc.vercel.app'});
        const result = normalizeCanonicalApplicationFrames(`Error: hosted failure
    at production (https://web.evb-viewer.com/_nuxt/viewer-abc.js:12:3)
    at preview (https://evb-viewer-preview-abc.vercel.app/_nuxt/viewer-def.js:13:4)
    at nitro (file:///var/task/.output/server/chunks/nitro/server.mjs:14:5)
    at nitroPreset (file:///var/task/server/chunks/routes/api.mjs:15:6)
    at otherPreview (https://other-project.vercel.app/_nuxt/injected.js:16:7)`);

        expect(result.frames).toEqual([
            {
                module: '_nuxt/viewer-abc.js',
                function: 'production',
                line: 12,
                column: 3,
            },
            {
                module: '_nuxt/viewer-def.js',
                function: 'preview',
                line: 13,
                column: 4,
            },
            {
                module: 'server-bundle/chunks/nitro/server.mjs',
                function: 'nitro',
                line: 14,
                column: 5,
            },
            {
                module: 'server-bundle/chunks/routes/api.mjs',
                function: 'nitroPreset',
                line: 15,
                column: 6,
            },
        ]);
        expect(JSON.stringify(result)).not.toContain('/var/task');
    });

    it('normalizes source-map protocol paths and updates debug images in the same call', () => {
        const result = normalizeCanonicalApplicationFrames({
            stack: 'at render (webpack://evb-viewer/./packages/contracts/diagnostics/diagnosticRecord.ts:10:2)',
            debug_meta: {images: [
                {code_file: 'file:///Users/alice/Projects/evb-viewer/packages/contracts/diagnostics/diagnosticRecord.ts?cache=1#x'},
                {code_file: 'file:///opt/OtherApp/resources/app.asar/main.js'},
            ]},
        });

        expect(result.frames).toEqual([{
            module: 'packages/contracts/diagnostics/diagnosticRecord.ts',
            function: 'render',
            line: 10,
            column: 2,
        }]);
        expect(result.debugMeta).toEqual({images: [{code_file: 'packages/contracts/diagnostics/diagnosticRecord.ts'}]});
        expect(result.frames[0]?.module).toBe(result.debugMeta.images[0]?.code_file);
    });

    it('accepts scan-cleanup files through their packages root', () => {
        const result = normalizeCanonicalApplicationFrames(`at render (file:///Users/alice/Projects/evb-viewer/packages/scan-cleanup/core/render.ts:10:2)
    at stale (file:///Users/alice/Projects/evb-viewer/scan-cleanup-core/render.ts:11:3)`);

        expect(result.frames).toEqual([{
            module: 'packages/scan-cleanup/core/render.ts',
            function: 'render',
            line: 10,
            column: 2,
        }]);
    });

    it('keeps a line-only location while omitting an absent column', () => {
        const result = normalizeCanonicalApplicationFrames(
            'at openDocument (file:///Users/alice/Projects/evb-viewer/app/viewer.ts:27)',
        );

        expect(result.frames).toEqual([{
            module: 'app/viewer.ts',
            function: 'openDocument',
            line: 27,
        }]);
    });

    it('bounds stack candidates before accepting a late application frame', () => {
        const externalFrames = Array.from(
            {length: 512},
            () => 'at extension (https://evil.example/extension.js:1:1)',
        );
        externalFrames.push('at openDocument (file:///Users/alice/Projects/evb-viewer/app/viewer.ts:27:4)');

        expect(normalizeCanonicalApplicationFrames(externalFrames).frames).toEqual([]);
    });

    it('returns no frames for stacks outside EVB-shipped application code', () => {
        const result = normalizeCanonicalApplicationFrames(`Error: injected
    at extension (https://evil.example/app/extension.js:1:1)
    at devtools (file:///Users/alice/DevTools/injected.js:2:2)
    at node (node:internal/process/task_queues:3:3)
    at wrapper (__webpack_require__:4:4)`);

        expect(result.frames).toEqual([]);
        expect(result.debugMeta.images).toEqual([]);
    });

    it('drops development-only Vitest runner frames', () => {
        const result = normalizeCanonicalApplicationFrames(
            'at runWithCancel (node_modules/.pnpm/@vitest+runner@4.1.11/node_modules/@vitest/runner/dist/chunk-artifact.js:2323:10)',
        );

        expect(result.frames).toEqual([]);
    });

    it('rejects non-canonical frames, wrappers, and extra fields at the record boundary', () => {
        expect(decodeCanonicalAppFrame({module: '/Users/alice/evb-viewer/app/viewer.ts'})).toBeNull();
        expect(decodeCanonicalAppFrame({module: 'app/viewer.ts?document=secret'})).toBeNull();
        expect(decodeCanonicalAppFrame({
            module: 'app/viewer.ts',
            function: '__webpack_require__',
        })).toBeNull();
        expect(decodeCanonicalAppFrame({
            module: 'app/viewer.ts',
            raw: 'raw stack',
        })).toBeNull();
        expect(decodeCanonicalAppFrame({
            module: 'app/viewer.ts',
            line: Number.POSITIVE_INFINITY,
        })).toBeNull();
    });
});
