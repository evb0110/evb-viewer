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
import {
    electronUserDataPath,
    sessionDir,
} from '@scripts/electron-run/electronRunSessionPaths';
import { createE2ERunScopedSessionName } from '@scripts/electron-run/electronRunRunId';
import { PINNED_CODEX_CLI_VERSION } from '@electron/features/agent/codexCliReleaseManifest';

const ASSISTANT_COMPLETION_E2E_TIMEOUT_MS = 90_000;
const SESSION_NAME = 'assistant-completion-finalization';
const SCOPED_SESSION_NAME = createE2ERunScopedSessionName(SESSION_NAME);
const fakeCodexPath = resolve(process.cwd(), '.devkit', 'tmp', 'e2e-fake-codex', SESSION_NAME, 'codex');

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

let threadCount = 0;
let turnCount = 0;

function send(payload) {
  process.stdout.write(JSON.stringify(payload) + '\\n');
}

function respond(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function notify(method, params) {
  send({ jsonrpc: '2.0', method, params });
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const request = JSON.parse(line);
  if (request.id === undefined) {
    return;
  }

  switch (request.method) {
    case 'initialize':
      respond(request.id, {});
      return;
    case 'account/read':
      respond(request.id, {
        account: {
          type: 'chatgpt',
          email: 'reader@example.test',
        },
      });
      return;
    case 'getAuthStatus':
      respond(request.id, {
        requiresOpenaiAuth: false,
        authMethod: 'chatgpt',
      });
      return;
    case 'model/list':
      respond(request.id, {
        data: [{ id: 'gpt-5.6-sol', displayName: 'GPT-5.6-Sol', isDefault: true }],
      });
      return;
    case 'mcpServerStatus/list':
      respond(request.id, {
        data: [{
          name: 'evb_viewer_embedded_v2',
          tools: {
            evb_workspace_snapshot: {},
            evb_run_action: {},
          },
        }],
      });
      return;
    case 'thread/start':
      threadCount += 1;
      respond(request.id, { thread: { id: \`thread-\${threadCount}\` } });
      return;
    case 'turn/start': {
      turnCount += 1;
      const threadId = request.params?.threadId;
      const turnId = \`turn-\${turnCount}\`;
      const assistantId = \`assistant-\${turnCount}\`;
      notify('item/completed', {
        threadId,
        item: {
          type: 'agentMessage',
          id: assistantId,
          text: 'Done before turn response',
        },
      });
      notify('turn/completed', { threadId });
      respond(request.id, { turn: { id: turnId } });
      notify('turn/started', {
        threadId,
        turn: { id: turnId },
      });
      return;
    }
    default:
      respond(request.id, {});
  }
});
`, 'utf-8');
    chmodSync(fakeCodexPath, 0o755);
}

installFakeCodexCli();
rmSync(sessionDir(SCOPED_SESSION_NAME), {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100,
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
    timeoutMs: ASSISTANT_COMPLETION_E2E_TIMEOUT_MS,
});

async function openAssistantPanel() {
    const session = sessionFixture.getSession();
    expect(session).toBeTruthy();

    const alreadyOpen = await session.page.evaluate(() => {
        const panel = document.querySelector('.agent-assistant-panel');
        const composer = panel
            ? panel.querySelector<HTMLTextAreaElement>('textarea[placeholder="Ask about this document..."]')
            : null;
        return composer !== null && !composer.disabled;
    });
    if (alreadyOpen) {
        return;
    }

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
        const composer = panel
            ? panel.querySelector<HTMLTextAreaElement>('textarea[placeholder="Ask about this document..."]')
            : null;
        return composer !== null && !composer.disabled;
    }, {timeout: 30_000});
}

describe('assistant completion finalization', () => {
    it('re-enables the composer when Codex completes before turn/start responds', async () => {
        const session = sessionFixture.getSession();
        expect(session).toBeTruthy();

        const pdfPath = await createMultiPageTextFixturePdf('assistant-completion-finalization.pdf', 2);
        await openPdfInApp(session.page, pdfPath, ASSISTANT_COMPLETION_E2E_TIMEOUT_MS);
        await waitForPdfLoaded(session.page, ASSISTANT_COMPLETION_E2E_TIMEOUT_MS);
        await waitForViewerInteractive(session.page, ASSISTANT_COMPLETION_E2E_TIMEOUT_MS);
        await waitForWorkspaceToolbarSnapshot(
            session.page,
            {
                hasPdf: true,
                minTotalPages: 2,
            },
            {timeoutMs: ASSISTANT_COMPLETION_E2E_TIMEOUT_MS},
        );

        await openAssistantPanel();

        await session.page.evaluate(() => {
            const panel = document.querySelector('.agent-assistant-panel');
            const composer = panel?.querySelector<HTMLTextAreaElement>('textarea[placeholder="Ask about this document..."]');
            if (!composer) {
                throw new Error('Assistant composer is not available.');
            }
            composer.value = 'completed-before-turn-response';
            composer.dispatchEvent(new Event('input', {bubbles: true}));
        });
        await waitForFunctionInPage(session.page, () => {
            const panel = document.querySelector('.agent-assistant-panel');
            const sendButton = panel
                ? panel.querySelector<HTMLButtonElement>('button[aria-label="Send"]')
                : null;
            return sendButton !== null && !sendButton.disabled;
        }, {timeout: 30_000});
        await session.page.evaluate(() => {
            const panel = document.querySelector('.agent-assistant-panel');
            const sendButton = panel?.querySelector<HTMLButtonElement>('button[aria-label="Send"]');
            if (!sendButton || sendButton.disabled) {
                throw new Error('Assistant send button is not ready.');
            }
            sendButton.click();
        });

        await waitForFunctionInPage(session.page, () => {
            const panel = document.querySelector('.agent-assistant-panel');
            const text = panel?.textContent ?? '';
            const composer = panel
                ? panel.querySelector<HTMLTextAreaElement>('textarea[placeholder="Ask about this document..."]')
                : null;
            const stopButton = panel
                ? panel.querySelector<HTMLButtonElement>('button[aria-label="Stop"]')
                : null;
            const sendButton = panel
                ? panel.querySelector<HTMLButtonElement>('button[aria-label="Send"]')
                : null;
            return text.includes('Done before turn response')
                && composer !== null
                && !composer.disabled
                && stopButton === null
                && sendButton !== null
                && sendButton.disabled;
        }, {timeout: 30_000});

        const finalUiState = await session.page.evaluate(() => {
            const panel = document.querySelector('.agent-assistant-panel');
            const text = panel?.textContent ?? '';
            const composer = panel
                ? panel.querySelector<HTMLTextAreaElement>('textarea[placeholder="Ask about this document..."]')
                : null;
            const stopButton = panel
                ? panel.querySelector<HTMLButtonElement>('button[aria-label="Stop"]')
                : null;
            const sendButton = panel
                ? panel.querySelector<HTMLButtonElement>('button[aria-label="Send"]')
                : null;
            return {
                hasAssistantReply: text.includes('Done before turn response'),
                composerDisabled: composer?.disabled ?? null,
                hasPendingMessage: Boolean(panel?.querySelector('.agent-assistant-message.is-pending')),
                hasStopButton: stopButton !== null,
                sendDisabled: sendButton?.disabled ?? null,
            };
        });
        expect(finalUiState).toEqual({
            hasAssistantReply: true,
            composerDisabled: false,
            hasPendingMessage: false,
            hasStopButton: false,
            sendDisabled: true,
        });
    }, ASSISTANT_COMPLETION_E2E_TIMEOUT_MS);
});
