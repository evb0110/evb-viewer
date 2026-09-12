import type {FailurePresentation} from '@app/composables/useFailureToast';
import {BrowserLogger} from '@app/utils/browserLogger';

export type TRendererBootstrapFailureKey =
    | 'app-bootstrap'
    | 'electron-platform-contract'
    | 'electron-preload-bridge'
    | 'workspace-startup';

export interface IRendererBootstrapFailureOptions {
    error: unknown;
    key: TRendererBootstrapFailureKey;
    message: string;
    section: string;
    title: string;
    description?: string;
}

const rendererBootstrapFailures = new Map<TRendererBootstrapFailureKey, FailurePresentation>();

export function getOrCaptureRendererBootstrapFailure(
    options: IRendererBootstrapFailureOptions,
): FailurePresentation {
    const existing = rendererBootstrapFailures.get(options.key);
    if (existing) {
        return existing;
    }

    const failure = BrowserLogger.error(options.section, options.message, options.error, {
        code: 'RENDERER_STARTUP_WARMUP_FAILED',
        context: {},
    });
    const presentation: FailurePresentation = {
        failure,
        title: options.title,
        ...(options.description === undefined ? {} : {description: options.description}),
    };
    rendererBootstrapFailures.set(options.key, presentation);
    return presentation;
}
