import {isRecord} from '@contracts/runtimeGuards';
import {initializeRendererDiagnostics} from '@app/utils/failureReporter';

export default defineNuxtPlugin(() => {
    const sentry: unknown = useRuntimeConfig().public.sentry;
    initializeRendererDiagnostics(isRecord(sentry) && typeof sentry.dsn === 'string' && sentry.dsn !== ''
        ? {
            dsn: sentry.dsn,
            release: String(sentry.release),
            environment: String(sentry.environment),
        }
        : null);
});
