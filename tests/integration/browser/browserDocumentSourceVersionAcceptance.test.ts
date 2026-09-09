import {
    readFile,
    mkdir,
    mkdtemp,
    rm,
    writeFile,
} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {
    createServer,
    type Server,
} from 'node:http';
import {
    join,
    resolve,
} from 'node:path';
import {build} from 'esbuild';
import {chromium} from 'playwright';
import {
    afterAll,
    beforeAll,
    describe,
    expect,
    it,
} from 'vitest';

let server: Server;
let origin = '';
let bundlePath = '';
let temporaryDirectory = '';
let realPickerFixturePaths: string[] = [];
let realFileSystemAccessFixturePath = '';

beforeAll(async () => {
    await mkdir(join(process.cwd(), '.devkit'), {recursive: true});
    temporaryDirectory = await mkdtemp(join(process.cwd(), '.devkit/browser-document-source-version-'));
    const fixture = await readFile(resolve(process.cwd(), 'tests/fixtures/electron/interop/synthetic-annotation-interoperability.pdf'));
    const equalSizeReplacement = Buffer.from(fixture);
    const marker = equalSizeReplacement.indexOf('20260901');
    if (marker < 0) throw new Error('Real picker fixture marker missing');
    equalSizeReplacement.write('20260902', marker, 'ascii');
    const changedSizeReplacement = Buffer.concat([
        fixture,
        Buffer.from('\n% changed-size-replacement\n'),
    ]);
    realPickerFixturePaths = [
        join(temporaryDirectory, 'real-picker-first.pdf'),
        join(temporaryDirectory, 'real-picker-equal-size.pdf'),
        join(temporaryDirectory, 'real-picker-changed-size.pdf'),
    ];
    realFileSystemAccessFixturePath = join(temporaryDirectory, 'real-file-system-access.pdf');
    await Promise.all([
        writeFile(realPickerFixturePaths[0]!, fixture),
        writeFile(realPickerFixturePaths[1]!, equalSizeReplacement),
        writeFile(realPickerFixturePaths[2]!, changedSizeReplacement),
        writeFile(realFileSystemAccessFixturePath, fixture),
    ]);
    bundlePath = join(temporaryDirectory, 'browser-document-source-version-acceptance.js');
    await build({
        bundle: true,
        entryPoints: [resolve(process.cwd(), 'tests/integration/browser/browserDocumentSourceVersionAcceptanceEntry.ts')],
        format: 'iife',
        outfile: bundlePath,
        platform: 'browser',
        sourcemap: false,
        tsconfig: resolve(process.cwd(), 'tsconfig.json'),
    });
    server = createServer((_request, response) => {
        response.writeHead(200, {'content-type': 'text/html'});
        response.end('<!doctype html><title>Browser source version acceptance</title>');
    });
    await new Promise<void>((resolveListen, rejectListen) => {
        server.once('error', rejectListen);
        server.listen(0, '127.0.0.1', resolveListen);
    });
    const address = server.address();
    if (!address || typeof address === 'string') {
        throw new Error('Browser source version acceptance harness did not bind a TCP port');
    }
    origin = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
    if (server) {
        await new Promise<void>(resolveClose => server.close(() => resolveClose()));
    }
    await rm(temporaryDirectory, {
        force: true,
        recursive: true,
    });
});

describe('browser source version acceptance in Chromium', () => {
    it.skipIf(process.env.EVB_REAL_BROWSER_FILE_SYSTEM_ACCESS !== '1' || !process.env.DISPLAY)(
        'uses a real File System Access handle across physical equal-size and changed-size replacement',
        async () => {
            const browser = await chromium.launch({headless: false});
            const physicalPath = realFileSystemAccessFixturePath;
            const equalSizeReplacement = await readFile(realPickerFixturePaths[1]!);
            const changedSizeReplacement = await readFile(realPickerFixturePaths[2]!);
            const driveNativePicker = () => {
                execFileSync('xdotool', [
                    'key',
                    'ctrl+l',
                ]);
                execFileSync('xdotool', [
                    'type',
                    '--delay',
                    '2',
                    physicalPath,
                ]);
                execFileSync('xdotool', [
                    'key',
                    'Return',
                ]);
                // The shared vdesk is fixed at 1280x800, and this is the
                // Chromium native chooser's Open button location.
                execFileSync('xdotool', [
                    'mousemove',
                    '1155',
                    '742',
                ]);
                execFileSync('xdotool', [
                    'click',
                    '1',
                ]);
            };
            try {
                const page = await browser.newPage({viewport: {
                    width: 1_280,
                    height: 800,
                }});
                await page.goto(origin);
                await page.addScriptTag({path: bundlePath});
                await page.evaluate(() => {
                    const button = document.createElement('button');
                    button.id = 'evb-real-file-system-access-picker';
                    button.textContent = 'Choose physical file';
                    button.onclick = () => {
                        const run = Reflect.get(globalThis, '__evbRunBrowserRealFileSystemAccessAcceptance');
                        if (typeof run !== 'function') throw new Error('File System Access acceptance entry point was not installed');
                        Reflect.set(globalThis, '__evbRealFileSystemAccessResult', run('first'));
                    };
                    document.body.append(button);
                });

                const choose = async (stage: 'first' | 'equal-size-replacement' | 'changed-size-replacement') => {
                    if (stage !== 'first') {
                        await page.evaluate((nextStage) => {
                            const button = document.querySelector<HTMLButtonElement>('#evb-real-file-system-access-picker');
                            if (!button) throw new Error('File System Access picker button is missing');
                            button.onclick = () => {
                                const run = Reflect.get(globalThis, '__evbRunBrowserRealFileSystemAccessAcceptance');
                                if (typeof run !== 'function') throw new Error('File System Access acceptance entry point was not installed');
                                Reflect.set(globalThis, '__evbRealFileSystemAccessResult', run(nextStage));
                            };
                        }, stage);
                    }
                    await page.locator('#evb-real-file-system-access-picker').click();
                    driveNativePicker();
                    return page.evaluate(async () => await Reflect.get(globalThis, '__evbRealFileSystemAccessResult'));
                };

                const first = await choose('first');
                expect(first).toEqual(expect.objectContaining({
                    handleName: 'real-file-system-access.pdf',
                    stage: 'first',
                }));
                await writeFile(physicalPath, equalSizeReplacement);
                const equal = await choose('equal-size-replacement');
                expect(equal).toEqual(expect.objectContaining({
                    dirtyBytes: [
                        1,
                        2,
                        3,
                    ],
                    handleName: 'real-file-system-access.pdf',
                    samePhysicalEntry: true,
                    stage: 'equal-size-replacement',
                }));
                expect(equal.replacementBytes).not.toEqual(equal.firstBytes);
                expect(equal.replacementBytes).toHaveLength(equal.firstBytes.length);

                await writeFile(physicalPath, changedSizeReplacement);
                const changed = await choose('changed-size-replacement');
                expect(changed).toEqual(expect.objectContaining({
                    dirtyBytes: [
                        1,
                        2,
                        3,
                    ],
                    handleName: 'real-file-system-access.pdf',
                    samePhysicalEntry: true,
                    stage: 'changed-size-replacement',
                }));
                expect(changed.replacementBytes).toHaveLength(changedSizeReplacement.length);
                expect(changed.replacementBytes).not.toEqual(changed.firstBytes);

                await page.reload();
                await page.addScriptTag({path: bundlePath});
                const recent = await page.evaluate(async () => {
                    const readback = Reflect.get(globalThis, '__evbReadBrowserRealFileSystemAccessRecentAfterReload');
                    if (typeof readback !== 'function') throw new Error('File System Access Recent readback was not installed');
                    return readback();
                });
                expect(recent.recentBytes).toEqual(Array.from(changed.replacementBytes));
                expect(recent.recentRef).toBe(changed.replacementRef);
            } finally {
                await browser.close();
            }
        },
    );

    it('uses Chromium file input selection and reopens the persisted Recent replacement', async () => {
        const browser = await chromium.launch({headless: true});
        try {
            const page = await browser.newPage();
            await page.goto(origin);
            await page.addScriptTag({path: bundlePath});
            await page.evaluate(() => {
                HTMLInputElement.prototype.click = function() {
                    // The test supplies files to the real DOM input with
                    // Playwright, which avoids a headless native dialog.
                };
            });
            const resultPromise = page.evaluate(async () => {
                const run = Reflect.get(globalThis, '__evbRunBrowserRealInputPickerRecentAcceptance');
                if (typeof run !== 'function') throw new Error('Real picker acceptance entry point was not installed');
                return run();
            });
            for (const fixturePath of realPickerFixturePaths.slice(0, 2)) {
                const input = page.locator('input[type="file"]');
                await input.waitFor({state: 'attached'});
                await input.setInputFiles(fixturePath);
            }
            const result = await resultPromise;
            expect(result).toEqual(expect.objectContaining({
                dirtyBytes: [
                    1,
                    2,
                    3,
                ],
                firstLength: expect.any(Number),
                recentBytes: [
                    37,
                    80,
                    68,
                    70,
                    45,
                    49,
                    46,
                    55,
                ],
                recentRefIsReplacement: true,
                secondLength: expect.any(Number),
            }));
            expect(result.secondLength).toBe(result.firstLength);
        } finally {
            await browser.close();
        }
    }, 120_000);

    it('opens current physical bytes while retaining the dirty prior version', async () => {
        const browser = await chromium.launch({headless: true});
        try {
            const page = await browser.newPage();
            await page.goto(origin);
            await page.addScriptTag({path: bundlePath});
            const result = await page.evaluate(async () => {
                const run = Reflect.get(globalThis, '__evbRunBrowserDocumentSourceVersionAcceptance');
                if (typeof run !== 'function') {
                    throw new Error('Browser source version acceptance entry point was not installed');
                }
                return run();
            });
            expect(result).toEqual({
                firstBytes: [
                    37,
                    80,
                    68,
                    70,
                ],
                reopenedBytes: [
                    37,
                    80,
                    68,
                    71,
                ],
                dirtyBytes: [
                    37,
                    80,
                    68,
                    70,
                    1,
                ],
                reopenedIsFresh: true,
                dirtySourceRefIsOriginal: true,
            });
        } finally {
            await browser.close();
        }
    }, 120_000);

    it('uses the real Chromium picker and Recent Files path for replacement and retry scenarios', async () => {
        const browser = await chromium.launch({headless: true});
        try {
            const page = await browser.newPage();
            await page.goto(origin);
            await page.addScriptTag({path: bundlePath});
            const result = await page.evaluate(async () => {
                const run = Reflect.get(globalThis, '__evbRunBrowserPickerAndRecentAcceptance');
                if (typeof run !== 'function') {
                    throw new Error('Browser picker acceptance entry point was not installed');
                }
                return run();
            });
            expect(result).toEqual(expect.objectContaining({
                changedSizeReplacement: true,
                dirtyFirstUnchanged: true,
                denied: true,
                equalSizeReplacement: true,
                largeRange: [
                    66,
                    66,
                    66,
                    66,
                    66,
                    66,
                    66,
                    36,
                ],
                recentReopened: true,
                retryComplete: true,
                firstLength: expect.any(Number),
                secondLength: expect.any(Number),
                thirdLength: expect.any(Number),
            }));
        } finally {
            await browser.close();
        }
    }, 120_000);
});
