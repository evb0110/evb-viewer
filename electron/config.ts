import { app } from 'electron';
import {
    dirname,
    join,
} from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const config = {
    isDev: !app.isPackaged,
    isMac: process.platform === 'darwin',

    server: {
        port: 3235,
        get url() {
            return `http://localhost:${this.port}`;
        },
        get entryPath() {
            return join(__dirname, '../nuxt-output/server/index.mjs');
        },
    },

    window: {
        width: 900,
        height: 700,
        title: 'EVB Viewer',
        backgroundColor: '#ffffff',
    },
} as const;
