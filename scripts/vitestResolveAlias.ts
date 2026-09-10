import { resolve } from 'node:path';

const projectRoot = resolve(__dirname, '..');

export const vitestResolveAlias = {
    // Nuxt's own alias for the generated build directory, so a test can read the
    // resolved component themes the app runs against instead of a copy of them.
    '#build': resolve(projectRoot, '.nuxt'),
    '@app': resolve(projectRoot, 'app'),
    '@electron': resolve(projectRoot, 'electron'),
    '@electron-worker-bundles': resolve(projectRoot, 'packages/electron-worker-bundles'),
    '@contracts': resolve(projectRoot, 'packages/contracts'),
    '@node-runtime': resolve(projectRoot, 'packages/node-runtime'),
    '@pdf-core': resolve(projectRoot, 'packages/pdf-core'),
    '@evb/scan-cleanup': resolve(projectRoot, 'packages/scan-cleanup'),
    '@evb/scan-cleanup/core': resolve(projectRoot, 'packages/scan-cleanup/core'),
    '@evb/scan-cleanup/adapters': resolve(projectRoot, 'packages/scan-cleanup/adapters'),
    '@i18n-core': resolve(projectRoot, 'packages/i18n-core'),
    '@i18n-app': resolve(projectRoot, 'packages/i18n-app'),
    '@releaseSelection': resolve(projectRoot, 'packages/release-selection'),
    '@scripts': resolve(projectRoot, 'scripts'),
    '@server': resolve(projectRoot, 'server'),
    '@landing': resolve(projectRoot, 'landing'),
    '@tests': resolve(projectRoot, 'tests'),
    '@root-package': resolve(projectRoot, 'package.json'),
    electron: resolve(projectRoot, 'tests/mocks/electron.ts'),
} as const;
