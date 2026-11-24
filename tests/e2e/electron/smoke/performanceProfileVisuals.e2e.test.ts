import {
    mkdtempSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    PDFDocument,
    StandardFonts,
} from 'pdf-lib';
import type { Page } from 'puppeteer-core';
import {
    afterEach,
    describe,
    expect,
    it,
} from 'vitest';
import {
    resolveHostWindowRasterShare,
    type THostResourceTier,
} from '@contracts/hostResourceProfile';
import type { IHostRasterBudgetSnapshot } from '@contracts/hostPlatformFeature';
import { moveTabToNewWindow } from '@tests/e2e/electron/helpers/moveTabToNewWindow';
import {
    openPdfInApp,
    waitForPdfLoaded,
} from '@tests/e2e/electron/helpers/viewerCore';
import {startConfiguredElectronE2ESession} from '@tests/e2e/electron/helpers/startConfiguredElectronE2ESession';
import type {IElectronE2ESession} from '@tests/e2e/electron/helpers/startElectronE2ESession';

const E2E_TIMEOUT_MS = 180_000;
const APP_READY_TIMEOUT_MS = 60_000;

interface IRootProfileSnapshot {
    appLowGraphics: boolean;
    profileAccessWasSynchronous: boolean;
    profileTier: THostResourceTier | null;
    tierClasses: string[];
}

interface IGraphicsStyleSnapshot {
    backdropBlurMd: string;
    backdropBlurSm: string;
    skeletonDuration: string;
}

async function waitForAppReady(session: IElectronE2ESession) {
    await session.page.waitForFunction(
        () => (window as Window & {__appReady?: boolean}).__appReady === true,
        {timeout: APP_READY_TIMEOUT_MS},
    );
}

async function resetReducedMotionPreference(session: IElectronE2ESession) {
    // macOS runner preferences and a previous test's CDP emulation can both
    // leave prefers-reduced-motion active. The tier assertions below exercise
    // the host profile, so establish the neutral media baseline explicitly.
    const client = await session.page.createCDPSession();
    try {
        await client.send('Emulation.setEmulatedMedia', {features: [{
            name: 'prefers-reduced-motion',
            value: 'no-preference',
        }]});
    } finally {
        await client.detach();
    }
}

async function readRootProfileSnapshot(session: IElectronE2ESession): Promise<IRootProfileSnapshot> {
    return session.page.evaluate(() => {
        let microtaskReached = false;
        queueMicrotask(() => {
            microtaskReached = true;
        });
        const profile = window.electronAPI?.host.getResourceProfile() ?? null;
        return {
            appLowGraphics: document.documentElement.classList.contains('app-low-graphics'),
            profileAccessWasSynchronous: !microtaskReached && !(profile && 'then' in profile),
            profileTier: profile?.tier ?? null,
            tierClasses: [...document.documentElement.classList]
                .filter(className => className.startsWith('performance-tier-')),
        };
    });
}

async function readGraphicsStyleSnapshot(
    session: IElectronE2ESession,
): Promise<IGraphicsStyleSnapshot> {
    // Scoped component declarations gate on html.app-low-graphics but only
    // exist once their components mount, which needs opened documents; the
    // real-app proof here is the token layer plus the root-class mechanism.
    return session.page.evaluate(() => {
        const rootStyle = getComputedStyle(document.documentElement);
        return {
            backdropBlurMd: rootStyle.getPropertyValue('--app-backdrop-blur-md').trim(),
            backdropBlurSm: rootStyle.getPropertyValue('--app-backdrop-blur-sm').trim(),
            skeletonDuration: rootStyle.getPropertyValue('--app-animation-duration-skeleton').trim(),
        };
    });
}

function expectGraphicsTokens(snapshot: IGraphicsStyleSnapshot) {
    expect(snapshot).toEqual({
        backdropBlurMd: '8px',
        backdropBlurSm: '6px',
        skeletonDuration: '1.2s',
    });
}

interface ISurfaceBudgetProbeWindow extends Window {
    __getWorkspaceSurfaceBudgetForE2E?: () => {
        maxBytes: number;
        effectiveMaxBytes: number;
        reservedBytes: number;
        leaseCount: number;
        pressureLevel: 'none' | 'moderate' | 'critical';
    };
}

async function createMultiPagePdfFixture(filePath: string) {
    const document = await PDFDocument.create();
    const font = await document.embedFont(StandardFonts.Helvetica);
    for (let pageNumber = 1; pageNumber <= 2; pageNumber += 1) {
        const page = document.addPage([
            612,
            792,
        ]);
        page.drawText(`Raster share multi-window page ${pageNumber}`, {
            x: 72,
            y: 700,
            size: 20,
            font,
        });
    }
    writeFileSync(filePath, await document.save());
}

async function waitForSurfaceBudgetMaxBytes(page: Page, expectedMaxBytes: number) {
    await page.waitForFunction(
        (targetMaxBytes: number) => (
            (window as ISurfaceBudgetProbeWindow).__getWorkspaceSurfaceBudgetForE2E?.().maxBytes === targetMaxBytes
        ),
        {timeout: APP_READY_TIMEOUT_MS},
        expectedMaxBytes,
    );
}

async function readWindowRasterBudgetState(page: Page) {
    return page.evaluate(async () => {
        const hostBudget: IHostRasterBudgetSnapshot | null = await window.electronAPI!.host.getRasterBudget();
        const surfaceBudget = (window as ISurfaceBudgetProbeWindow).__getWorkspaceSurfaceBudgetForE2E?.() ?? null;
        return {
            hostBudget,
            surfaceBudget,
        };
    });
}

describe('Electron E2E - Performance Profile Visuals', () => {
    let session: IElectronE2ESession | null = null;
    const tempDirectories: string[] = [];

    afterEach(async () => {
        await session?.stop();
        session = null;
        for (const directory of tempDirectories.splice(0)) {
            rmSync(directory, {
                recursive: true,
                force: true,
            });
        }
    });

    it('installs the low tier synchronously and disables expensive visuals', async () => {
        session = await startConfiguredElectronE2ESession(
            `e2e-performance-visuals-low-${Date.now()}`,
            'low',
        );
        await resetReducedMotionPreference(session);
        await waitForAppReady(session);

        expect(await readRootProfileSnapshot(session)).toMatchObject({
            appLowGraphics: true,
            profileAccessWasSynchronous: true,
            profileTier: 'low',
            tierClasses: ['performance-tier-low'],
        });
        expectGraphicsTokens(await readGraphicsStyleSnapshot(session));
    }, E2E_TIMEOUT_MS);

    it('toggles low graphics with reduced motion while preserving medium visuals', async () => {
        session = await startConfiguredElectronE2ESession(
            `e2e-performance-visuals-medium-${Date.now()}`,
            'medium',
        );
        await resetReducedMotionPreference(session);
        await waitForAppReady(session);

        expect(await readRootProfileSnapshot(session)).toMatchObject({
            appLowGraphics: false,
            profileAccessWasSynchronous: true,
            profileTier: 'medium',
            tierClasses: ['performance-tier-medium'],
        });
        expectGraphicsTokens(await readGraphicsStyleSnapshot(session));

        const client = await session.page.createCDPSession();
        try {
            await client.send('Emulation.setEmulatedMedia', {features: [{
                name: 'prefers-reduced-motion',
                value: 'reduce',
            }]});
            await session.page.waitForFunction(
                () => document.documentElement.classList.contains('app-low-graphics'),
            );
            expectGraphicsTokens(await readGraphicsStyleSnapshot(session));

            await client.send('Emulation.setEmulatedMedia', {features: [{
                name: 'prefers-reduced-motion',
                value: 'no-preference',
            }]});
            await session.page.waitForFunction(
                () => !document.documentElement.classList.contains('app-low-graphics'),
            );
            expectGraphicsTokens(await readGraphicsStyleSnapshot(session));
        } finally {
            await client.detach();
        }
    }, E2E_TIMEOUT_MS);

    it('keeps high-tier visuals unchanged with exactly one tier class', async () => {
        session = await startConfiguredElectronE2ESession(
            `e2e-performance-visuals-high-${Date.now()}`,
            'high',
        );
        await resetReducedMotionPreference(session);
        await waitForAppReady(session);

        expect(await readRootProfileSnapshot(session)).toMatchObject({
            appLowGraphics: false,
            profileAccessWasSynchronous: true,
            profileTier: 'high',
            tierClasses: ['performance-tier-high'],
        });
        expectGraphicsTokens(await readGraphicsStyleSnapshot(session));
    }, E2E_TIMEOUT_MS);

    it('pushes reduced per-window raster shares across two real windows and restores on close', async () => {
        const fixtureDir = mkdtempSync(join(tmpdir(), 'evb-raster-share-e2e-'));
        tempDirectories.push(fixtureDir);
        const pdfPath = join(fixtureDir, 'raster-share.pdf');
        await createMultiPagePdfFixture(pdfPath);
        session = await startConfiguredElectronE2ESession(
            `e2e-raster-share-multi-window-${Date.now()}`,
            'high',
        );
        await waitForAppReady(session);
        await openPdfInApp(session.page, pdfPath);
        await waitForPdfLoaded(session.page);

        const profile = await session.page.evaluate(() => window.electronAPI!.host.getResourceProfile());
        expect(profile).not.toBeNull();
        const oneWindowShare = resolveHostWindowRasterShare({
            totalRamBytes: profile!.totalRamBytes,
            windowCount: 1,
        });
        const twoWindowShare = resolveHostWindowRasterShare({
            totalRamBytes: profile!.totalRamBytes,
            windowCount: 2,
        });
        expect(twoWindowShare.maxRasterSurfaceBytes).toBeLessThan(oneWindowShare.maxRasterSurfaceBytes);

        await waitForSurfaceBudgetMaxBytes(session.page, oneWindowShare.maxRasterSurfaceBytes);
        const singleWindowState = await readWindowRasterBudgetState(session.page);
        expect(singleWindowState.hostBudget).toEqual(oneWindowShare);
        expect(singleWindowState.surfaceBudget).toMatchObject({
            maxBytes: oneWindowShare.maxRasterSurfaceBytes,
        });
        expect(singleWindowState.surfaceBudget!.reservedBytes).toBeGreaterThan(0);
        expect(singleWindowState.surfaceBudget!.reservedBytes)
            .toBeLessThanOrEqual(singleWindowState.surfaceBudget!.effectiveMaxBytes);

        // Open a second real Electron window through the real Move Tab to New Window flow.
        const secondWindow = await moveTabToNewWindow(session.page, {tabTitle: 'raster-share'});
        await waitForSurfaceBudgetMaxBytes(session.page, twoWindowShare.maxRasterSurfaceBytes);
        await waitForSurfaceBudgetMaxBytes(secondWindow, twoWindowShare.maxRasterSurfaceBytes);

        const firstWindowWithTwo = await readWindowRasterBudgetState(session.page);
        const secondWindowWithTwo = await readWindowRasterBudgetState(secondWindow);
        expect(firstWindowWithTwo.hostBudget).toEqual(twoWindowShare);
        expect(secondWindowWithTwo.hostBudget).toEqual(twoWindowShare);
        expect(firstWindowWithTwo.surfaceBudget!.maxBytes).toBe(twoWindowShare.maxRasterSurfaceBytes);
        expect(secondWindowWithTwo.surfaceBudget!.maxBytes).toBe(twoWindowShare.maxRasterSurfaceBytes);
        expect(secondWindowWithTwo.surfaceBudget!.reservedBytes).toBeGreaterThan(0);
        expect(firstWindowWithTwo.surfaceBudget!.reservedBytes)
            .toBeLessThanOrEqual(firstWindowWithTwo.surfaceBudget!.effectiveMaxBytes);
        expect(secondWindowWithTwo.surfaceBudget!.reservedBytes)
            .toBeLessThanOrEqual(secondWindowWithTwo.surfaceBudget!.effectiveMaxBytes);

        // Closing the second window broadcasts the restored 1-window share to the survivor.
        await secondWindow.close();
        await waitForSurfaceBudgetMaxBytes(session.page, oneWindowShare.maxRasterSurfaceBytes);
        const restoredState = await readWindowRasterBudgetState(session.page);
        expect(restoredState.hostBudget).toEqual(oneWindowShare);
        expect(restoredState.surfaceBudget!.maxBytes).toBe(oneWindowShare.maxRasterSurfaceBytes);
    }, E2E_TIMEOUT_MS);
});
