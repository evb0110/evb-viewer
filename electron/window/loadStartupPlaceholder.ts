import type {BrowserWindow} from 'electron';
import {getErrorMessage} from '@electron/utils/error';

interface IStartupPlaceholderLogger {
    warn(msg: string): void;
}

function buildStartupPlaceholderHtml(title: string) {
    return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>${title}</title>
<style>
html,
body {
  width: 100%;
  height: 100%;
  margin: 0;
  background: #fff;
  color: #475569;
  font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  line-height: 1;
}
body {
  display: flex;
  align-items: center;
  justify-content: center;
}
.loader {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  width: 128px;
  height: 43px;
  min-height: 43px;
  font-size: 13px;
  line-height: 13px;
}
.spinner {
  width: 20px;
  height: 20px;
  flex: 0 0 20px;
  border-radius: 999px;
  background: conic-gradient(
    from 0deg,
    rgba(0, 0, 0, 0.12) 0deg,
    rgba(0, 0, 0, 0.12) 260deg,
    rgba(0, 0, 0, 0.5) 360deg
  );
  -webkit-mask: radial-gradient(farthest-side, transparent calc(100% - 3px), #000 0);
  mask: radial-gradient(farthest-side, transparent calc(100% - 3px), #000 0);
  animation: spin 1s linear infinite;
  will-change: transform;
  transform: translateZ(0);
}
@keyframes spin {
  from { transform: translateZ(0) rotate(0deg); }
  to { transform: translateZ(0) rotate(360deg); }
}
.text {
  height: 13px;
  margin: 0;
  font-weight: 400;
  letter-spacing: 0.2px;
}
</style>
</head>
<body>
<main class="loader" role="status" aria-live="polite">
  <div class="spinner" aria-hidden="true"></div>
  <div class="text">Loading...</div>
</main>
</body>
</html>`;
}

export async function loadStartupPlaceholder(
    window: BrowserWindow,
    options: {
        title: string;
        logger: IStartupPlaceholderLogger;
    },
) {
    try {
        await window.loadURL('about:blank');
        if (window.isDestroyed()) {
            return;
        }

        await window.webContents.executeJavaScript(`
            document.open();
            document.write(${JSON.stringify(buildStartupPlaceholderHtml(options.title))});
            document.close();
        `);
    } catch (error) {
        options.logger.warn(`Failed to load startup placeholder: ${getErrorMessage(error)}`);
    }
}
