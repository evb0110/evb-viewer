import {
    afterAll,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { join } from 'node:path';
import type * as ElectronConfigModule from '@electron/config';

const mocks = vi.hoisted(() => ({app: {isPackaged: false}}));

vi.mock('electron', () => ({app: mocks.app}));

const originalResourcesPath = process.resourcesPath;

function setResourcesPath(value: string | undefined) {
    Object.defineProperty(process, 'resourcesPath', {
        configurable: true,
        value,
    });
}

describe('electron config runtime mode', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.unstubAllEnvs();
        mocks.app.isPackaged = false;
        setResourcesPath('/Applications/EVB Viewer.app/Contents/Resources');
    });

    afterAll(() => {
        setResourcesPath(originalResourcesPath);
    });

    it('uses Electron app.isPackaged for development mode detection', async () => {
        const {
            config,
            resolveIsPackaged,
        }: typeof ElectronConfigModule = await import('@electron/config');

        expect(resolveIsPackaged()).toBe(false);
        expect(config.isDev).toBe(true);
        expect(config.renderer.url).toBe('http://127.0.0.1:3235/electron');
        expect(config.renderer.trustedOrigin).toBe('http://127.0.0.1:3235');
        expect(config.renderer.trustedUrl).toBe(config.server.url);
        expect(config.renderer.staticRoot).toContain(join('nuxt-output', 'public'));
    });

    it('uses Electron app.isPackaged for packaged mode detection without inspecting module paths', async () => {
        mocks.app.isPackaged = true;

        const {
            config,
            resolveIsPackaged,
        }: typeof ElectronConfigModule = await import('@electron/config');

        expect(resolveIsPackaged()).toBe(true);
        expect(config.isDev).toBe(false);
        expect(config.renderer.url).toBe('evb-viewer://app/electron');
        expect(config.renderer.trustedOrigin).toBe('evb-viewer://app');
        expect(config.renderer.trustedUrl).toBe('evb-viewer://app/electron');
        expect(config.renderer.staticRoot).toBe(join(process.resourcesPath, 'app.asar', 'nuxt-output', 'public'));
    });

    it('keeps the development server on loopback and uses fixed updater defaults', async () => {
        const {config}: typeof ElectronConfigModule = await import('@electron/config');

        expect(config.server.host).toBe('127.0.0.1');
        expect(config.updates).toEqual({
            metadataUrl: 'https://evb-viewer.com/api/releases/latest',
            mirrorMetadataUrl: 'https://vps-420c0bae.vps.ovh.net/api/mss-backend/api/evb-viewer/channels/stable.json',
            mirrorReleaseBaseUrl: 'https://vps-420c0bae.vps.ovh.net/api/mss-backend/api/evb-viewer/releases',
            pollIntervalMs: 6 * 60 * 60 * 1000,
            initialDelayMs: 2 * 60 * 1000,
        });
    });

    it('rejects non-loopback runtime server hosts', async () => {
        const {config}: typeof ElectronConfigModule = await import('@electron/config');

        config.server.setHost('example.com');

        expect(config.server.host).toBe('127.0.0.1');
        expect(config.renderer.trustedOrigin).toBe('http://127.0.0.1:3235');
    });
});
