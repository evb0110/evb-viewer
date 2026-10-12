import {
    mkdirSync, writeFileSync,
} from 'node:fs';
import {resolve} from 'node:path';
import type {Page} from 'playwright';
import {
    afterAll, describe, expect, it,
} from 'vitest';
import {
    lifecycle, waitForOpenFileReady, keepFileChooserInterceptionEnabled,
} from './documentLifecycleTestHelpers';

// Public two-page regression PDF. Subsets of DejaVu Sans, Noto Serif Hebrew
// and Noto Sans Syriac retain real glyphs, marks and ToUnicode mappings.
const RTL_SEARCH_PDF_BASE64 =
    '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' +
    'ijNajLcVPefwzSJa41hjWD+/eQPDf/lTNtg/b0Q7h6MzaK38IwIFmYowhnbzBucEWk0b9WnE/GJomcYvDhHUNBvVSBvoKLYJZKA4W65mSTqObQw0A3dgS2Mo' +
    'Gn6b0Y+CiEYxasgFbI9gZEcM6QC2AXz/Ty3Y0sbR36E35WMeBu8LHRzGbrMZGj/uIfqaUMfjXzOLuISY8r63oM0mYDoy3ftQyxn8+iM+Oh7C6hBjvGLuxNFh' +
    '8G6wMp6/Aa/zR8gKZW5kc3RyZWFtCmVuZG9iagoKMTIgMCBvYmoKPDwKL0ZpbHRlciAvRmxhdGVEZWNvZGUKL0xlbmd0aCAyMAo+PgpzdHJlYW0KeJxjYGBg' +
    'YmBhYGZgZWADAABeABUKZW5kc3RyZWFtCmVuZG9iagoKMTQgMCBvYmoKPDwKL0ZpbHRlciAvRmxhdGVEZWNvZGUKL0xlbmd0aCAyNDEKPj4Kc3RyZWFtCnic' +
    'XZBLS8QwEMfv/RRz3D2l7Vq8lICsCD2sitUPkMe0BmwSpumh3948ygoOJPCb/7zZdXgerAnA3smpEQNMxmrC1W2kECTOxlZNC9qocFD+1SJ8xWLyuK8Bl8FO' +
    'Dvoe2EcU10A7nJ60k3gG9kYaydgZTl/XMfK4ef+DC9oANXAOGqdY6Cb8q1gwyXLFMO5khIrOP/lz9wht5qZMopzG1QuFJOyMVV9H49C/ROMVWv1P70qWnNS3' +
    'oBzdxOj6sal5pjZT2xS6FDq0h0KyUJfp0uUuR73UL93kvonaiOKS+XB5gTS6sXi/rXc+ZaX3C1j9efEKZW5kc3RyZWFtCmVuZG9iagoKMTYgMCBvYmoKPDwK' +
    'L0xlbmd0aDEgMjM2OAovRmlsdGVyIC9GbGF0ZURlY29kZQovTGVuZ3RoIDE1MjYKPj4Kc3RyZWFtCniclVVdbFNVHP+fe+5HP26/1vvVdXTd7dqOspWtXddt' +
    'DMQxVswIM5vDSeKkQFmRbR3bQAia8KIkJBKIxPiAkIjRRHzQBD94MhLig+HJL16QRB/EJTyYoFFm0vo/t4WxaWK4N+ec//f/d/7nf88FAgBuOAEUducGtg5C' +
    'FAQA2w2UxnJPD48OHNl+GPnfkQ/nRsf63ytf+QvAriCfGB5dn5pr3/ccgHAO+d17p/Oz5jt1l5Fn9guT+flZXL3ofx1X2+TUsf1Xx/tGkL4LQH8pFvL7fD1D' +
    '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' +
    'KSpDUMvtVajWf/Rg0SfZog/378CJGGRWbQJC/k/iPUBOGF4fmTov2MJzmGQXZRdY/Rw/eS32HQWY1783w9m4Ceuq69s9nExWzV2gyr9pV6Gt6jWczFcEsur3' +
    'rzjOdrsJ9wxaMI7PvhidXAaYFe9BUmWS7D19GElipEydpEoZ1OCNSa03zvI596kT+TA2Uqd0ZhUNlbSps1J4VoxRqbY5SnZCi2lu4oQ2LlV6GFrh0twf7Eb6' +
    'VMZQaGkjhUJJUiyaVLNVIorURqOgn5FIgDBCMipPrRn8SFI/jpUhdCPUo8qH4Q6ZF7fN63lxXW7BvFgyNorjtZrWy2bFdcjGOpxejdRZlcQMWsM3mR1vsNvm' +
    '57qiNQHc07GfY/hi31bl8tsxXIr/SfExga9GcSmPcNwrAc4RH7QBnzOzHpFB4n9lw5jWl7KB/icf0UEeuT6e48NVuGvDn9+QDy+fn+f5MCbw9fhgj/BBO662' +
    'Qs5ACzXcNBbtE6w4ck5fZsWY3Bezwj9mBT5x4viZw4+dlrM+8P0mdM2uXdLzh/0GFMOgAB8dZgt+lcXhFT/EDttmv7y5+xiWgzur00/960XP/8fRwLbrsKrK' +
    'yKrDhQx0ITPQSV03A/bhbVb3IWaCI7+/N9z6AfdfhWzmSQplbmRzdHJlYW0KZW5kb2JqCgoyNyAwIG9iago8PAovU2l6ZSAyOAovUm9vdCAyIDAgUgovSW5m' +
    'byAzIDAgUgovRmlsdGVyIC9GbGF0ZURlY29kZQovVHlwZSAvWFJlZgovTGVuZ3RoIDkzCi9XIFsgMSAyIDIgXQovSW5kZXggWyAwIDI4IF0KPj4Kc3RyZWFt' +
    'CnicJce5DYAwAATBO/N/EjKZgQBRD23QFAWQQg20Qk5OwGNdspoF8L4GDvChjyFqbcB8l0IWoxSxXKWYdpYS2kNK2TxSRjdJOd0mFT4l21tbsbsA9uefYQE+' +
    'QMUNBwplbmRzdHJlYW0KZW5kb2JqCgpzdGFydHhyZWYKODYwMwolJUVPRg==';

describe.each([
    'dom',
    'css',
] as const)('ordinary RTL search (%s)', (mode) => {
    let page: Page;
    // Both regex modes use the same unchanged two-page PDF and text layer.
    // Every query is cleared before the next, including between these cases.

    afterAll(async () => {
        await page?.context().close();
    });

    it.each([
        false,
        true,
    ])(`ordinary RTL search uses logical text and glyph ranges (${mode}, regex=%s)`, async (regex) => {
        const out = resolve('.devkit/core4-r7/app', process.env.PROOF_REVISION ?? 'head', `${mode}-${regex}`);
        mkdirSync(out, {recursive: true});
        const bytes = Buffer.from(RTL_SEARCH_PDF_BASE64, 'base64');
        writeFileSync(resolve(out, 'fixture.pdf'), bytes);
        const observations: unknown[] = [];
        try {
            if (!page) {
                page = await lifecycle.browser.newPage({viewport: {
                    width: 1280,
                    height: 900,
                }});
                // Advance product timers without replacing search or render work.
                await page.clock.install();
                await page.addInitScript(highlightMode => {
                    Reflect.set(window, '__allowRendererFileOpenForAutomation', () => true);
                    window.localStorage.setItem('pdfHighlightMode', highlightMode);
                    window.sessionStorage.setItem('evb-viewer:browser:open-picker-mode', 'input');
                }, mode);
                await page.goto(lifecycle.origin, {waitUntil: 'domcontentloaded'});
                await waitForOpenFileReady(page);
                keepFileChooserInterceptionEnabled(page);
                const chooser = page.waitForEvent('filechooser');
                await page.getByRole('button', {
                    name: 'Open File',
                    exact: true,
                }).first().click();
                await (await chooser).setFiles({
                    name: 'rtl-search.pdf',
                    mimeType: 'application/pdf',
                    buffer: bytes,
                });
                await page.waitForFunction(() => document.querySelector('.page_container[data-page="1"] .textLayer')?.getAttribute('data-pdf-text-layer-ready') === 'true', undefined, {timeout: 30000});
                if (!await page.getByRole('tab', {
                    name: 'Search',
                    exact: true,
                }).isVisible()) {
                    await page.getByRole('button', {
                        name: 'Toggle Sidebar',
                        exact: true,
                    }).click();
                }
                await page.getByRole('tab', {
                    name: 'Search',
                    exact: true,
                }).click();
            }
            if (regex) await page.locator('.document-search-bar button').filter({hasText: '.*'}).click();
            const input = page.locator('.document-search-bar input:visible').first();
            const current = () => page.evaluate(highlightMode => {
                const ranges = highlightMode === 'css'
                    ? [...CSS.highlights.get('pdf-search-current-match') ?? []].filter((range): range is Range => range instanceof Range)
                    : [...document.querySelectorAll('.pdf-search-highlight--current')].map(element => {
                        const range = document.createRange();
                        range.selectNodeContents(element);
                        return range;
                    });
                return ranges.map(range => {
                    const layer = range.startContainer.parentElement?.closest('.textLayer');
                    const run = [...layer?.children ?? []].find(child => child.contains(range.startContainer));
                    const ink = document.createRange();
                    if (run) ink.selectNodeContents(run);
                    return {
                        text: range.toString(),
                        offset: (() => {
                            const prefix = document.createRange();
                            if (layer) prefix.setStart(layer, 0);
                            prefix.setEnd(range.startContainer, range.startOffset);
                            return prefix.toString().length;
                        })(),
                        sourceText: layer?.textContent ?? '',
                        page: Number(layer?.closest<HTMLElement>('.page_container')?.dataset.page),
                        ink: ink.getBoundingClientRect().toJSON(),
                        rects: [...range.getClientRects()].map(rect => rect.toJSON()),
                    };
                });
            }, mode);
            const cases = [
                {
                    query: 'שלום',
                    text: 'שלום',
                    count: 2,
                },
                {
                    query: 'של',
                    text: 'של',
                    count: 2,
                },
                {
                    query: 'السلام',
                    text: 'السلام',
                    count: 2,
                },
                {
                    query: 'ܫܠܡܐ',
                    text: 'ܫܠܡܐ',
                    count: 2,
                },
                {
                    query: 'office',
                    text: 'oﬃce',
                    count: 4,
                },
                {
                    query: 'abc',
                    text: 'abc',
                    count: 2,
                },
                {
                    query: '123',
                    text: '123',
                    count: 4,
                },
                {
                    query: 'עולם123עולם',
                    text: 'עולם123עולם',
                    count: 2,
                },
                {
                    query: '123 עולם abc',
                    text: '123 עולם abc',
                    count: 2,
                },
                {
                    query: 'שָׁל֑וֹם',
                    text: 'שָׁל֑וֹם',
                    count: 2,
                },
                {
                    query: 'السَّلَام',
                    text: 'السَّلَام',
                    count: 2,
                },
                {
                    query: 'ܫܠܵܡܵܐ',
                    text: 'ܫܠܵܡܵܐ',
                    count: 2,
                },
            ];
            for (const testCase of cases) {
                await input.fill('');
                await input.press('Enter');
                await expect.poll(() => page.locator('.document-search-results').innerText()).toContain('Enter a search term');
                await input.fill(testCase.query);
                await input.press('Enter');
                await page.clock.fastForward(300);
                await expect.poll(async () => {
                    const body = await page.locator('.document-search-results').innerText();
                    return body.includes('No results found') || body.includes('results for');
                }, {timeout: 30000}).toBe(true);
                await expect.poll(() => page.locator('.document-search-results-header-spinner:visible').count()).toBe(0);
                const count = await page.locator('.document-search-result:visible').count();
                observations.push({
                    query: testCase.query,
                    count,
                });
                writeFileSync(resolve(out, 'outcomes.json'), JSON.stringify(observations, null, 2));
                expect.soft(count).toBe(testCase.count);
                if (count !== testCase.count) continue;
                for (const index of [
                    0,
                    testCase.count - 1,
                ]) {
                    await page.locator('.document-search-result:visible').nth(index).click();
                    await expect.poll(async () => (await current()).map(range => range.text).join(''), {timeout: 10000}).toBe(testCase.text);
                    // The monitor still requires unchanged geometry and rendered
                    // pages; only its 500 ms no-input interval uses virtual time.
                    await page.clock.fastForward(600);
                    await page.evaluate(async () => {
                        const monitor = Reflect.get(window, '__evbViewerInvariants') as {waitForSettled: (options: {timeoutMs: number}) => Promise<{
                            settled: boolean;
                            reason?: string
                        }>};
                        const outcome = await monitor.waitForSettled({timeoutMs: 10000});
                        if (!outcome.settled) throw new Error(outcome.reason ?? 'Viewer did not settle');
                    });
                    const paint = await current();
                    expect([...new Set(paint.map(range => range.page))]).toEqual([index === 0 ? 1 : 2]);
                    expect(paint[0]?.offset).toBe(index === 0
                        ? paint[0]?.sourceText.indexOf(testCase.text)
                        : paint[0]?.sourceText.lastIndexOf(testCase.text));
                    expect(paint.every(range => range.rects.some(rect => rect.width > 0 && rect.height > 0)
                    && range.rects.every(rect => rect.left >= range.ink.left - 1 && rect.right <= range.ink.right + 1))).toBe(true);
                    observations.push({
                        query: testCase.query,
                        index,
                        paint,
                    });
                }
            }
        } finally {
            writeFileSync(resolve(out, 'outcomes.json'), JSON.stringify(observations, null, 2));
            await page.screenshot({path: resolve(out, 'final.png')}).catch(() => {});
        }
    }, 180000);

});
