import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {dirname, join} from 'node:path';
import {describe, expect, it} from 'vitest';

/**
 * `FreeTextEditor.addEditToolbar()` awaits each toolbar button. When the
 * editor is removed during that await (a layer rebuild or a resize
 * transition), an unguarded pdf.js editor continues into
 * `this._editToolbar.addButton("comment", …)` on the toolbar that
 * `removeEditToolbar()` already nulled, surfacing as an unhandled
 * "Cannot read properties of null (reading 'addButton')" rejection in the
 * renderer. The EVB fork carries a null guard once the toolbar is gone. This
 * pins that guard in both generated builds so a dependency bump cannot drop
 * it silently.
 */
const LOOP_GUARD = [
    '        const editToolbar = this._editToolbar;',
    '        if (!editToolbar) {',
    '          return null;',
    '        }',
    '        await editToolbar.addButton(name, tool);',
].join('\n');
const POST_LOOP_GUARD = ['    if (!this._editToolbar) {', '      return null;', '    }', '    if (!this.hasComment) {'].join('\n');

function resolvePdfjsBuild(relativePath: string) {
    const require = createRequire(import.meta.url);
    const packageJsonPath = require.resolve('pdfjs-dist/package.json');
    return join(dirname(packageJsonPath), relativePath);
}

describe('pdf.js edit toolbar removal guard', () => {
    it.each(['build/pdf.mjs', 'legacy/build/pdf.mjs'])('keeps the removal guard inside addEditToolbar in %s', async (relativePath) => {
        const source = await readFile(resolvePdfjsBuild(relativePath), 'utf8');
        const start = source.indexOf('async addEditToolbar() {');
        expect(start).toBeGreaterThan(-1);
        const body = source.slice(start, source.indexOf('addCommentButtonInToolbar() {', start));
        expect(body).toContain(LOOP_GUARD);
        expect(body).toContain(POST_LOOP_GUARD);
    });
});
