import {
    afterEach,
    describe,
    expect,
    it,
} from 'vitest';
import type { THostResourceTier } from '@contracts/hostResourceProfile';
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

describe('Electron E2E - Performance Profile Visuals', () => {
    let session: IElectronE2ESession | null = null;

    afterEach(async () => {
        await session?.stop();
        session = null;
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
});
