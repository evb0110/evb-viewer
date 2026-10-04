import {
    describe, expect, it,
} from 'vitest';
import type {Page} from 'puppeteer-core';
import {createElectronE2ESessionFixture} from '@tests/e2e/electron/helpers/createElectronE2ESessionFixture';
import {
    clickAsUser, clickFoundAsUser,
} from '@tests/e2e/electron/helpers/userInput';

const sessions = createElectronE2ESessionFixture({sessionName: () => `e2e-user-input-${Date.now()}`});

// These are pointer fixtures inside the real hidden window. The helper is the
// subject: DOM setup supplies the layout, and only trusted input can record
// the outcome. No application command substitutes for the click or wheel.
async function mountPointerFixture(page: Page, markup: string) {
    await page.evaluate((html) => {
        const fixture = document.createElement('div');
        fixture.id = 'pointer-fixture';
        fixture.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:white;color:black';
        fixture.innerHTML = html;
        fixture.addEventListener('click', (event) => {
            const target = event.target as HTMLElement;
            fixture.dataset.clicked = target.closest('[data-target]')?.getAttribute('data-target') ?? '';
            fixture.dataset.trusted = String(event.isTrusted);
            if (target.closest('[data-target="dismiss"]')) {
                fixture.querySelector('#pointer-cover')?.remove();
            }
        });
        document.body.append(fixture);
    }, markup);
}

async function readPointerOutcome(page: Page) {
    return page.evaluate(() => {
        const fixture = document.querySelector<HTMLElement>('#pointer-fixture');
        const scroller = fixture?.querySelector<HTMLElement>('[data-scroller]');
        return {
            clicked: fixture?.dataset.clicked ?? null,
            trusted: fixture?.dataset.trusted ?? null,
            scrollLeft: scroller?.scrollLeft ?? 0,
            scrollTop: scroller?.scrollTop ?? 0,
        };
    });
}

describe('trusted pointer harness', () => {
    it('clicks a child of a visible target with trusted input', async () => {
        const {page} = sessions.getSession();
        await mountPointerFixture(page, '<button data-target="visible" style="margin:40px"><span>Visible target</span></button>');
        await clickAsUser(page, '[data-target="visible"]');
        expect(await readPointerOutcome(page)).toMatchObject({
            clicked: 'visible',
            trusted: 'true',
        });
    });

    it('clicks the visible portion of a target wider and taller than its scroll panel without scrolling it away', async () => {
        const {page} = sessions.getSession();
        await mountPointerFixture(page, `
            <div data-scroller style="position:absolute;left:40px;top:40px;width:240px;height:180px;overflow:auto">
                <button data-target="oversized" style="display:block;width:1000px;height:800px">Large target</button>
            </div>
        `);
        await clickAsUser(page, '[data-target="oversized"]', {timeoutMs: 2000});
        expect(await readPointerOutcome(page)).toEqual({
            clicked: 'oversized',
            trusted: 'true',
            scrollLeft: 0,
            scrollTop: 0,
        });
    });

    it('reveals an offscreen nested scroll panel before wheeling its target', async () => {
        const {page} = sessions.getSession();
        await mountPointerFixture(page, `
            <div data-scroller style="position:absolute;left:40px;top:40px;width:260px;height:180px;overflow:auto">
                <div style="height:800px;padding-top:400px">
                    <div style="width:220px;height:140px;overflow:auto">
                        <div style="height:350px"></div>
                        <button data-target="nested">Nested target</button>
                    </div>
                </div>
            </div>
        `);
        await clickAsUser(page, '[data-target="nested"]', {timeoutMs: 3000});
        expect(await readPointerOutcome(page)).toMatchObject({
            clicked: 'nested',
            trusted: 'true',
        });
    });

    it('aims again when hovering the target moves it before the click', async () => {
        const {page} = sessions.getSession();
        await mountPointerFixture(page, '<button data-target="hover" style="position:absolute;left:40px;top:40px">Moving target</button>');
        await page.evaluate(() => {
            const target = document.querySelector<HTMLElement>('[data-target="hover"]')!;
            target.addEventListener('pointerenter', () => {target.style.left = '350px';}, {once: true});
        });
        await clickAsUser(page, '[data-target="hover"]');
        expect(await readPointerOutcome(page)).toMatchObject({
            clicked: 'hover',
            trusted: 'true',
        });
    });

    it('refuses a target covered by a dialog and clicks it after the dialog is dismissed', async () => {
        const {page} = sessions.getSession();
        await mountPointerFixture(page, `
            <button data-target="covered" style="position:absolute;left:50px;top:50px">Covered target</button>
            <div id="pointer-cover" style="position:absolute;inset:0;background:white">
                <button data-target="dismiss" style="margin:200px">Dismiss</button>
            </div>
        `);
        await expect(clickAsUser(page, '[data-target="covered"]', {timeoutMs: 250})).rejects.toThrow('covered by');
        expect((await readPointerOutcome(page)).clicked).toBeNull();
        await clickAsUser(page, '[data-target="dismiss"]');
        await clickAsUser(page, '[data-target="covered"]');
        expect(await readPointerOutcome(page)).toMatchObject({
            clicked: 'covered',
            trusted: 'true',
        });
    });

    it('wheels a target into view and resolves a found target in the page', async () => {
        const {page} = sessions.getSession();
        await mountPointerFixture(page, `
            <div data-scroller style="position:absolute;left:40px;top:40px;width:240px;height:180px;overflow:auto;scroll-behavior:smooth">
                <div style="height:450px"></div>
                <button data-target="found">Find me</button>
            </div>
        `);
        await clickFoundAsUser(page, (label) => Array.from(document.querySelectorAll('button'))
            .find(button => button.textContent === label), 'Find me', {description: 'the found button'});
        expect(await readPointerOutcome(page)).toMatchObject({
            clicked: 'found',
            trusted: 'true',
        });
    });

    it('restores native content size, scale and focus after viewport emulation and a real resize', async () => {
        const session = sessions.getSession();
        await session.command('windowResize', [
            600,
            500,
        ]);
        await session.page.setViewport({
            width: 1200,
            height: 800,
            deviceScaleFactor: 3,
        });
        await session.resetForE2E();
        expect(await session.page.evaluate(() => ({
            width: innerWidth,
            height: innerHeight,
            scale: devicePixelRatio,
            focus: document.hasFocus(),
            visibility: document.visibilityState,
        }))).toEqual({
            width: 900,
            height: 672,
            scale: 1,
            focus: true,
            visibility: 'visible',
        });
    });

    it('preserves native high-DPI rendering through a renderer reset', async () => {
        const session = await sessions.restart({
            hard: true,
            extraEnv: {EVB_AUTOMATION_DEVICE_SCALE_FACTOR: '2'},
        });
        await session.page.setViewport({
            width: 500,
            height: 400,
            deviceScaleFactor: 3,
        });
        await session.resetForE2E();
        expect(await session.page.evaluate(() => devicePixelRatio)).toBe(2);
        const png = Buffer.from(await session.page.screenshot({type: 'png'}));
        expect({
            width: png.readUInt32BE(16),
            height: png.readUInt32BE(20),
        }).toEqual({
            width: 1800,
            height: 1344,
        });
    });
});
