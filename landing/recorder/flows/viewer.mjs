// Main landing film: open a raw 1880 scan, clean it up, run OCR on every page in German,
// then search the new text layer for "Edessa".
import {
    copyFileSync,
    mkdirSync,
} from 'node:fs';
import path from 'node:path';
import { LANDING } from '../recorder.mjs';

export const title = 'EVB Viewer';
export const size = {
    width: 1280,
    height: 800,
};

const SOURCE = path.join(LANDING, 'recorder/documents/noldeke-1880-raw-scan.pdf');
const FILE_NAME = 'Nöldeke - Kurzgefasste syrische Grammatik (1880).pdf';
const SHOWN_FOLDER = '~/Documents';
// Camera framings (1.6:1): the source pages beside the cleanup preview, and the search panel beside the page.
const BEFORE_AFTER = [
    8,
    64,
    944,
    590,
];
const SEARCH = [
    0,
    44,
    944,
    590,
];

/** A fresh copy of the scan per run (OCR saves into it) and the German model the flow selects. */
export function prepare({
    profile,
    userData,
    repo,
}) {
    const folder = path.join(profile, 'Documents');
    mkdirSync(folder, { recursive: true });
    const document = path.join(folder, FILE_NAME);
    copyFileSync(SOURCE, document);
    mkdirSync(path.join(userData, 'tessdata'), { recursive: true });
    copyFileSync(path.join(repo, 'resources/tesseract/tessdata/deu.traineddata'), path.join(userData, 'tessdata/deu.traineddata'));
    return {
        documentPath: document,
        folder,
        userData,
    };
}

export default async function flow(win, rec, {
    app,
    documentPath,
    folder,
    userData,
}) {
    // Labels come from the app's own messages, so one flow records every interface language.
    const t = (key) => win.evaluate((k) => document.querySelector('#__nuxt').__vue_app__.config.globalProperties.$t(k), key);
    // Show home-relative folders instead of this machine's scratch profile, including in title attributes.
    const tidy = () => win.evaluate(({
        roots,
        shown,
    }) => {
        const escaped = roots.map((root) => root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
        // Cleaned copies live in a folder named by a random id.
        const pattern = new RegExp(`(?:${escaped.join('|')})(?:/[0-9a-f-]{36})?`, 'g');
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            const value = node.nodeValue.replace(pattern, shown);
            if (value !== node.nodeValue) node.nodeValue = value;
        }
        for (const element of document.querySelectorAll('[title]')) {
            const value = element.title.replace(pattern, shown);
            if (value !== element.title) element.title = value;
        }
    }, {
        roots: [
            path.join(userData, 'scan-cleanup/output'),
            folder,
        ],
        shown: SHOWN_FOLDER,
    });
    const snap = async (options) => {
        await tidy();
        await rec.snap(options);
    };
    await app.evaluate(({ dialog }, file) => {
        dialog.showOpenDialog = async () => ({
            canceled: false,
            filePaths: [file],
        });
    }, documentPath);

    const open = win.getByRole('button', {
        name: await t('toolbar.openPdf'),
        exact: true,
    });
    await open.waitFor();
    // The window opens with keyboard focus on a toolbar button; a visitor would not see its ring.
    await win.evaluate(() => document.activeElement?.blur());
    await win.mouse.move(760, 560);
    await snap({
        dur: 36,
        cursor: [
            760,
            560,
        ],
    });
    await snap({
        dur: 22,
        cursor: await rec.center(open),
        click: true,
    });
    await open.click();

    // The raw scan: yellowed paper, specks and no text layer.
    await win.locator('canvas').first().waitFor();
    await win.waitForTimeout(3500);
    await snap({
        dur: 46,
        transition: 'dip',
        fade: 12,
        cursor: [
            900,
            520,
        ],
    });

    // Scan cleanup previews every page before it writes anything.
    const cleanup = win.locator('.scan-cleanup-trigger:visible').first();
    await snap({
        dur: 22,
        cursor: await rec.center(cleanup),
        click: true,
    });
    await cleanup.click();
    await win.getByRole('button', { name: await t('scanCleanup.firstRun.dismiss') }).click();
    const cleanUp = win.getByRole('button', {
        name: await t('scanCleanup.cleanUp'),
        exact: true,
    });
    await cleanUp.waitFor();
    await win.waitForFunction(() => !document.querySelector('.scan-cleanup-workspace [aria-busy="true"]'), null, { timeout: 60_000 }).catch(() => {});
    await win.waitForTimeout(4000);
    await snap({
        dur: 56,
        transition: 'fade',
        fade: 10,
        cursor: [
            760,
            700,
        ],
    });
    const original = win.locator('.scan-cleanup-segmented-option', { hasText: await t('scanCleanup.preview.original') });
    const cleaned = win.locator('.scan-cleanup-segmented-option', { hasText: await t('scanCleanup.preview.cleaned') });
    await snap({
        dur: 20,
        cursor: await rec.center(original),
        click: true,
        focus: BEFORE_AFTER,
    });
    await original.click();
    await win.waitForTimeout(1500);
    await snap({
        dur: 34,
        transition: 'fade',
        fade: 6,
        focus: BEFORE_AFTER,
    });
    await snap({
        dur: 18,
        cursor: await rec.center(cleaned),
        click: true,
        focus: BEFORE_AFTER,
    });
    await cleaned.click();
    await win.waitForTimeout(1500);
    await snap({
        dur: 40,
        transition: 'fade',
        fade: 6,
        focus: BEFORE_AFTER,
    });
    await snap({
        dur: 22,
        cursor: await rec.center(cleanUp),
        click: true,
    });
    await cleanUp.click();

    // The cleaned copy opens in a new tab.
    await win.waitForFunction(() => document.querySelectorAll('.tab-close').length > 1, null, { timeout: 120_000 });
    await win.waitForTimeout(3500);
    await snap({
        dur: 50,
        transition: 'dip',
        fade: 12,
        cursor: [
            900,
            520,
        ],
    });

    const ocr = win.getByRole('button', {
        name: await t('ocr.button'),
        exact: true,
    }).last();
    await snap({
        dur: 22,
        cursor: await rec.center(ocr),
        click: true,
    });
    await ocr.click();
    const dialog = win.getByRole('dialog').first();
    await dialog.waitFor();
    await win.waitForTimeout(800);
    await snap({
        dur: 30,
        transition: 'fade',
        fade: 8,
    });

    // The radios are visually hidden; people click the labels around them.
    const option = (value) => dialog.locator('label').filter({ has: win.locator(`[role=radio][value="${value}"]`) });
    const allPages = option('all');
    await snap({
        dur: 16,
        cursor: await rec.center(allPages),
        click: true,
    });
    await allPages.click();
    await win.waitForTimeout(300);
    const german = option('deu');
    await german.scrollIntoViewIfNeeded();
    await win.waitForTimeout(300);
    await snap({
        dur: 20,
        cursor: await rec.center(german),
        click: true,
    });
    await german.click();
    await win.waitForTimeout(500);
    await snap({ dur: 26 });

    const start = dialog.getByRole('button', { name: await t('ocr.languagePicker.startWithoutDownload') });
    await snap({
        dur: 20,
        cursor: await rec.center(start),
        click: true,
    });
    await start.click();

    // Real progress, one state per visible change, until the dialog reports completion.
    const complete = await t('ocr.complete');
    let last = '';
    for (let tick = 0; tick < 600; tick++) {
        await win.waitForTimeout(400);
        const text = await dialog.innerText().catch(() => '');
        if (text.includes(complete)) break;
        const status = text.split('\n').find((line) => /\d+\s*\/\s*\d+/.test(line)) ?? '';
        if (status && status !== last) {
            last = status;
            await snap({
                dur: 22,
                cursor: [
                    1180,
                    740,
                ],
            });
        }
    }
    await win.waitForTimeout(500);
    await snap({
        dur: 40,
        cursor: [
            1180,
            740,
        ],
    });
    const close = dialog.getByRole('button', {
        name: await t('common.close'),
        exact: true,
    }).last();
    await snap({
        dur: 18,
        cursor: await rec.center(close),
        click: true,
    });
    await close.click();
    await dialog.waitFor({ state: 'hidden' });
    await win.waitForTimeout(2500);
    await snap({
        dur: 34,
        transition: 'fade',
        fade: 10,
        cursor: [
            900,
            520,
        ],
    });

    // Search the recognised text.
    await win.keyboard.press('Control+f');
    const search = win.getByPlaceholder(await t('search.placeholder')).first();
    await search.waitFor();
    await win.waitForTimeout(600);
    await snap({
        dur: 18,
        cursor: await rec.center(search),
    });
    for (const character of 'Edessa') {
        await win.keyboard.type(character);
        await win.waitForTimeout(120);
        await snap({ dur: 5 });
    }
    await win.keyboard.press('Enter');
    await win.waitForTimeout(2500);
    await snap({
        dur: 60,
        focus: SEARCH,
    });
    const hits = win.locator('button.document-search-result');
    if ((await hits.count()) > 1) {
        await snap({
            dur: 22,
            cursor: await rec.center(hits.nth(1)),
            click: true,
            focus: SEARCH,
        });
        await hits.nth(1).click();
        await win.waitForTimeout(2500);
        await snap({
            dur: 80,
            focus: SEARCH,
        });
    }
}
