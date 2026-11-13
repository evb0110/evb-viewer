import {createHash} from 'node:crypto';
import {
    mkdirSync, readFileSync, writeFileSync,
} from 'node:fs';
import {resolve} from 'node:path';
import {
    describe, expect, it,
} from 'vitest';
import {
    openPdfFromChooser, readRecoveries, lifecycle, waitForOpenFileReady, collectConsoleProblems, clickCenter,
} from './documentLifecycleTestHelpers';

describe('browser document lifecycle UI', () => {
    // T2/T4: a surviving linked view keeps the payload paired with retained bytes.
    it('A46 restores an unsaved note after closing its linked recovery carrier', async () => {
        const evidenceDir = resolve(process.env.EVB_A46_EVIDENCE_DIR ?? '.devkit/checks/browser/after', 'carrier');
        mkdirSync(evidenceDir, {recursive: true});
        const context = await lifecycle.browser.newContext({viewport: {
            width: 1600,
            height: 900,
        }});
        const observations: unknown[] = [];
        const page = await context.newPage();
        const problems = collectConsoleProblems(page);
        try {
            // Controlled writer refusal keeps a real unapplied draft on its byte base.
            await page.route('**/composables/useWorkspaceAnnotationSession.ts*', async route => {
                const response = await route.fetch();
                const body = await response.text();
                const marker = 'const comment = resolveNoteComment(annotationId);';
                if (!body.includes(marker)) throw new Error('Note update fault seam was not found');
                await route.fulfill({
                    response,
                    body: body.replace(marker,
                        'if (Reflect.get(window, "__a46NoteFailure")) throw new Error("A46 carrier note update rejection"); ' + marker),
                });
            });
            await page.addInitScript(() => Reflect.set(window, '__a46NoteFailure', true));
            await openPdfFromChooser(page, resolve('tests/fixtures/electron/generated-text.pdf'));
            await page.locator('.page_container--rendered canvas').first().waitFor({state: 'visible'});
            await clickCenter(page, '.editor-pane.is-active .tab.is-active[data-tab-id]', 'right');
            await page.getByRole('menuitem', {
                name: 'Split Right',
                exact: true,
            }).click();
            await expect.poll(() => page.locator('.editor-pane').count()).toBe(2);
            await page.locator('.editor-pane').last().locator('.page_container--rendered canvas').first().waitFor({state: 'visible'});
            const carrier = page.locator('.editor-pane').first();
            await carrier.locator('.tab').first().click();
            await page.getByRole('button', {
                name: 'Place a sticky note on the page.',
                exact: true,
            }).click();
            await carrier.locator('.page_container[data-page="1"]').first().click({position: {
                x: 200,
                y: 200,
            }});
            const draft = 'A46 draft survives the closed carrier';
            const input = page.getByRole('textbox', {
                name: 'Write annotation note',
                exact: true,
            });
            await input.fill(draft);
            await page.waitForFunction(() => document.querySelector('.app-toast-failure')?.textContent?.includes('A46 carrier note update rejection'));
            await expect.poll(async () => (await readRecoveries(page)).some(({checkpoint}) =>
                checkpoint.tabs.length === 2 && checkpoint.tabs[0]?.annotationRecovery?.payload?.drafts.some(value => value.text === draft))).toBe(true);
            const before = (await readRecoveries(page)).find(({checkpoint}) => checkpoint.tabs.length === 2)!;
            const ref = before.checkpoint.tabs[0]!.workingCopyRef;
            const hash = createHash('sha256').update(Uint8Array.from(before.bytes)).digest('hex');
            observations.push({
                step: 'two-linked-views',
                checkpoint: before.checkpoint,
                hash,
            });
            await carrier.getByRole('button', {
                name: 'Close Tab',
                exact: true,
            }).click();
            await expect.poll(() => page.locator('.editor-pane').count()).toBe(1);
            await expect.poll(async () => (await readRecoveries(page)).some(({checkpoint}) => checkpoint.tabs.length === 1)).toBe(true);
            const after = (await readRecoveries(page)).find(({checkpoint}) => checkpoint.tabs.length === 1)!;
            observations.push({
                step: 'carrier-closed',
                checkpoint: after.checkpoint,
            });
            expect(after.checkpoint.tabs[0]!.workingCopyRef).toBe(ref);
            expect(createHash('sha256').update(Uint8Array.from(after.bytes)).digest('hex')).toBe(hash);
            await page.reload({waitUntil: 'domcontentloaded'});
            await waitForOpenFileReady(page);
            await page.locator('.page_container--rendered canvas').first().waitFor({state: 'visible'});
            // The restored draft must be visible, beyond the checkpoint payload.
            await expect.poll(() => input.inputValue()).toBe(draft);
            await page.screenshot({path: resolve(evidenceDir, 'restored.png')});
            expect(await page.getByRole('button', {
                name: 'Save',
                exact: true,
            }).first().isEnabled()).toBe(true);
            observations.push({
                step: 'restored',
                draft: await input.inputValue(),
            });
            expect(problems.filter(problem => !problem.includes('A46 carrier note update rejection'))).toEqual([]);
        } finally {
            writeFileSync(resolve(evidenceDir, 'observations.json'), JSON.stringify({
                observations,
                problems,
            }, null, 2));
            await context.close();
        }
    }, 90_000);

    // T2: every admitted recovery names the document whose bytes it contains.
    it('A46 rejects a capture after the ordinary tab replaces its document', async () => {
        const evidenceDir = resolve(process.env.EVB_A46_EVIDENCE_DIR ?? '.devkit/checks/browser/after', 'replacement');
        mkdirSync(evidenceDir, {recursive: true});
        const context = await lifecycle.browser.newContext({viewport: {
            width: 1280,
            height: 800,
        }});
        const page = await context.newPage();
        const problems = collectConsoleProblems(page);
        const observations: unknown[] = [];
        try {
            await openPdfFromChooser(page, resolve('tests/fixtures/electron/generated-text.pdf'));
            await page.locator('.page_container--rendered canvas').first().waitFor({state: 'visible'});
            const originalTab = await page.locator('.tab.is-active[data-tab-id]').getAttribute('data-tab-id');
            // Hold the window's next recovery record, leaving all document input and bytes real.
            await page.evaluate(`(async () => {
                const {getWindowTabsCapability} = await import('/_nuxt/utils/platformWindowTabs.ts');
                const recovery = getWindowTabsCapability().browserRecovery;
                const save = recovery.save.bind(recovery);
                const gate = new Promise(resolve => Reflect.set(window, '__a46ReleaseLoad', resolve));
                let holding = true;
                recovery.save = async (checkpoint) => {
                    if (holding) {
                        holding = false;
                        document.body.dataset.a46Load = 'held';
                        await gate;
                    }
                    return save(checkpoint);
                };
            })()`);
            await page.getByRole('button', {
                name: 'Place a sticky note on the page.',
                exact: true,
            }).click();
            await page.locator('.page_container[data-page="1"]').first().click({position: {
                x: 200,
                y: 200,
            }});
            await page.getByRole('textbox', {
                name: 'Write annotation note',
                exact: true,
            }).fill('Discarded A note');
            await page.getByRole('button', {
                name: 'Minimize note',
                exact: true,
            }).click();
            await page.waitForFunction(() => document.body.dataset.a46Load === 'held');
            const chooser = page.waitForEvent('filechooser');
            await page.getByRole('button', {
                name: 'Menu',
                exact: true,
            }).click();
            await page.getByRole('menuitem', {name: /^Open File/u}).click();
            await page.getByRole('button', {
                name: 'Discard changes',
                exact: true,
            }).click();
            await (await chooser).setFiles({
                name: 'a46-replacement.pdf',
                mimeType: 'application/pdf',
                buffer: readFileSync(resolve('tests/fixtures/electron/generated-text.pdf')),
            });
            await expect.poll(() => page.locator('.tab.is-active[data-tab-id]').textContent()).toContain('a46-replacement.pdf');
            expect(await page.locator('.tab.is-active[data-tab-id]').getAttribute('data-tab-id')).toBe(originalTab);
            await page.locator('.page_container--rendered canvas').first().waitFor({state: 'visible'});
            await page.getByRole('button', {
                name: 'Place a sticky note on the page.',
                exact: true,
            }).click();
            await page.locator('.page_container[data-page="1"]').first().click({position: {
                x: 220,
                y: 220,
            }});
            const replacementNote = 'Replacement B recovery bytes';
            await page.getByRole('textbox', {
                name: 'Write annotation note',
                exact: true,
            }).fill(replacementNote);
            await page.getByRole('button', {
                name: 'Minimize note',
                exact: true,
            }).click();
            await page.evaluate(() => Reflect.get(window, '__a46ReleaseLoad')());
            await expect.poll(async () => (await readRecoveries(page, '/Text')).some(record => record.notes.has(replacementNote))).toBe(true);
            // The held capture of the replaced document wrote nothing: every stored record names the replacement.
            const records = await readRecoveries(page, '/Text');
            observations.push({
                step: 'records',
                records: records.map(record => record.checkpoint),
            });
            expect(records.length).toBeGreaterThan(0);
            for (const record of records) {
                for (const tab of record.checkpoint.tabs.filter(candidate => candidate.isDirty)) {
                    expect((tab as {fileName?: string}).fileName).toBe('a46-replacement.pdf');
                }
                expect(record.notes.has('Discarded A note')).toBe(false);
            }
            await page.reload({waitUntil: 'domcontentloaded'});
            await waitForOpenFileReady(page);
            await page.getByRole('button', {
                name: 'Open Note',
                exact: true,
            }).click();
            await expect.poll(() => page.getByRole('textbox', {
                name: 'Write annotation note',
                exact: true,
            }).inputValue()).toBe(replacementNote);
            await page.screenshot({path: resolve(evidenceDir, 'restored.png')});
            expect(problems).toEqual([]);
        } finally {
            writeFileSync(resolve(evidenceDir, 'observations.json'), JSON.stringify({
                observations,
                problems,
            }, null, 2));
            await context.close();
        }
    }, 90_000);
});
