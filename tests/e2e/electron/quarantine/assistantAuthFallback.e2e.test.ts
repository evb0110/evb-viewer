import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    chmodSync,
    mkdirSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import {
    dirname,
    resolve,
} from 'node:path';
import { createMultiPageTextFixturePdf } from '@tests/e2e/electron/helpers/fixtures';
import { createElectronE2ESessionFixture } from '@tests/e2e/electron/helpers/createElectronE2ESessionFixture';
import {
    openPdfInApp,
    waitForPdfLoaded,
    waitForViewerInteractive,
} from '@tests/e2e/electron/helpers/viewerCore';
import { waitForFunctionInPage } from '@tests/e2e/electron/helpers/pageRuntime';
import { waitForWorkspaceToolbarSnapshot } from '@tests/e2e/electron/helpers/workspaceExpose';
import type { IE2EWindow } from '@tests/e2e/electron/helpers/e2EWindow';
import {
    electronUserDataPath,
    sessionDir,
} from '@scripts/electron-run/electronRunSessionPaths';
import { createE2ERunScopedSessionName } from '@scripts/electron-run/electronRunRunId';
import { PINNED_CODEX_CLI_VERSION } from '@electron/features/agent/codexCliReleaseManifest';

const ASSISTANT_AUTH_E2E_TIMEOUT_MS = 90_000;
const SESSION_NAME = 'assistant-auth-fallback';
const SCOPED_SESSION_NAME = createE2ERunScopedSessionName(SESSION_NAME);
const fakeCodexPath = resolve(process.cwd(), '.devkit', 'tmp', 'e2e-fake-codex', 'assistant-auth-fallback', 'codex');

function installFakeCodexCli() {
    mkdirSync(dirname(fakeCodexPath), {recursive: true});
    writeFileSync(fakeCodexPath, `#!/usr/bin/env node
import readline from 'node:readline';

if (process.argv.includes('--version')) {
  console.log('codex-cli ${PINNED_CODEX_CLI_VERSION}');
  process.exit(0);
}

if (process.argv[2] !== 'app-server') {
  console.error('Fake Codex only supports --version and app-server.');
  process.exit(1);
}

function send(payload) {
  process.stdout.write(JSON.stringify(payload) + '\\n');
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const request = JSON.parse(line);
  if (request.id === undefined) {
    return;
  }

  switch (request.method) {
    case 'initialize':
      send({ jsonrpc: '2.0', id: request.id, result: {} });
      return;
    case 'account/read':
      send({
        jsonrpc: '2.0',
        id: request.id,
        error: { message: 'account/read timed out after 8000ms.' },
      });
      return;
    case 'getAuthStatus':
      send({
        jsonrpc: '2.0',
        id: request.id,
        result: {
          requiresOpenaiAuth: false,
          authMethod: 'chatgpt',
        },
      });
      return;
    case 'model/list':
      send({
        jsonrpc: '2.0',
        id: request.id,
        result: {
          data: [{ id: 'gpt-5.6-sol', displayName: 'GPT-5.6-Sol', isDefault: true }],
        },
      });
      return;
    case 'mcpServerStatus/list':
      send({
        jsonrpc: '2.0',
        id: request.id,
        result: {
          data: [{
            name: 'evb_viewer_embedded_v2',
            tools: {
              evb_workspace_snapshot: {},
              evb_run_action: {},
            },
          }],
        },
      });
      return;
    default:
      send({ jsonrpc: '2.0', id: request.id, result: {} });
  }
});
`, 'utf-8');
    chmodSync(fakeCodexPath, 0o755);
}

installFakeCodexCli();
rmSync(sessionDir(SCOPED_SESSION_NAME), {
    recursive: true,
    force: true,
});
mkdirSync(electronUserDataPath(SCOPED_SESSION_NAME), {recursive: true});
writeFileSync(
    resolve(electronUserDataPath(SCOPED_SESSION_NAME), 'settings.json'),
    JSON.stringify({assistantPanelEnabled: true}, null, 2),
    'utf-8',
);

const sessionFixture = createElectronE2ESessionFixture({
    sessionName: SCOPED_SESSION_NAME,
    clean: false,
    extraEnv: {CODEX_CLI_PATH: fakeCodexPath},
    timeoutMs: ASSISTANT_AUTH_E2E_TIMEOUT_MS,
});

describe('assistant auth fallback', () => {
    it('leaves checking state when account profile read fails but auth status is available', async () => {
        const session = sessionFixture.getSession();
        expect(session).toBeTruthy();

        const settings = await session.page.evaluate(async () => (
            (window as IE2EWindow).electronAPI?.settings.get()
        ));
        expect(settings?.assistantPanelEnabled).toBe(true);

        const pdfPath = await createMultiPageTextFixturePdf('assistant-auth-fallback.pdf', 2);
        await openPdfInApp(session.page, pdfPath, ASSISTANT_AUTH_E2E_TIMEOUT_MS);
        await waitForPdfLoaded(session.page, ASSISTANT_AUTH_E2E_TIMEOUT_MS);
        await waitForViewerInteractive(session.page, ASSISTANT_AUTH_E2E_TIMEOUT_MS);
        await waitForWorkspaceToolbarSnapshot(
            session.page,
            {
                hasPdf: true,
                minTotalPages: 2,
            },
            {timeoutMs: ASSISTANT_AUTH_E2E_TIMEOUT_MS},
        );

        const preToggleAssistantState = await session.page.evaluate(async () => (
            (window as IE2EWindow).electronAPI?.agent.getAssistantState()
        ));
        expect(preToggleAssistantState).toBeTruthy();
        if (!preToggleAssistantState) {
            return;
        }
        expect(preToggleAssistantState.status.authState).toBe('signed-in');
        expect(preToggleAssistantState.status.runtimeState).toBe('ready');
        expect(preToggleAssistantState.status.error).toBeUndefined();

        await waitForFunctionInPage(session.page, () => (
            [...document.querySelectorAll<HTMLButtonElement>('button[aria-label="Toggle EVB Assistant"]:not([disabled])')]
                .some((button) => {
                    const rect = button.getBoundingClientRect();
                    return rect.width > 0 && rect.height > 0;
                })
        ), {timeout: 30_000});
        await session.page.evaluate(() => {
            const toggleButton = [...document.querySelectorAll<HTMLButtonElement>('button[aria-label="Toggle EVB Assistant"]:not([disabled])')]
                .find((button) => {
                    const rect = button.getBoundingClientRect();
                    return rect.width > 0 && rect.height > 0;
                });
            if (!toggleButton) {
                throw new Error('Assistant toolbar toggle is not available.');
            }
            toggleButton.click();
        });

        await session.page.waitForSelector('.agent-assistant-panel', {timeout: 30_000});
        await waitForFunctionInPage(session.page, () => {
            const panel = document.querySelector('.agent-assistant-panel');
            const text = panel?.textContent ?? '';
            const composer = panel?.querySelector<HTMLTextAreaElement>('textarea[placeholder="Ask about this document..."]');
            return text.includes('Ask about the current document')
                && composer !== null
                && !text.includes('Checking EVB Assistant');
        }, {timeout: 30_000});

        const assistantState = await session.page.evaluate(async () => (
            (window as IE2EWindow).electronAPI?.agent.getAssistantState()
        ));
        expect(assistantState).toBeTruthy();
        if (!assistantState) {
            return;
        }
        expect(assistantState.status.authState).toBe('signed-in');
        expect(assistantState.status.runtimeState).toBe('ready');
        expect(assistantState.status.error).toBeUndefined();
    }, ASSISTANT_AUTH_E2E_TIMEOUT_MS);
});
