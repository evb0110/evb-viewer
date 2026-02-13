import { session } from 'electron';
import { config } from '@electron/config';

let isCspConfigured = false;

export function setupContentSecurityPolicy() {
    if (isCspConfigured) {
        return;
    }
    isCspConfigured = true;

    const connectSrc = config.isDev
        ? 'connect-src \'self\' blob: data: ws:'
        : 'connect-src \'self\' blob: data:';

    const csp = [
        'default-src \'self\'',
        'script-src \'self\' \'unsafe-inline\' \'wasm-unsafe-eval\'',
        'style-src \'self\' \'unsafe-inline\'',
        'img-src \'self\' data: blob:',
        'font-src \'self\' data:',
        connectSrc,
        'worker-src \'self\' blob:',
        'object-src \'none\'',
        'base-uri \'self\'',
        'form-action \'self\'',
    ].join('; ');

    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
        callback({responseHeaders: {
            ...details.responseHeaders,
            'Content-Security-Policy': [csp],
        }});
    });
}
