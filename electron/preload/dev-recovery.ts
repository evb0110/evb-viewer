interface IReloadEvent {
    timestamp: number;
    reason: string;
    blocked: boolean;
    blockReason?: string;
    reloadId: string;
}

interface IReloadDecision {
    allowed: boolean;
    blockReason?: string;
}

interface IWindowWithReloadHistory extends Window {__reloadHistory?: IReloadEvent[];}

/**
 * In development, Vite can transiently fail module fetches after dependency optimize changes.
 * This recovery logic does a bounded auto-reload with guardrails to avoid loops.
 */
export function installViteOutdatedOptimizeDepRecovery() {
    if (!process.defaultApp) {
        return;
    }
    if (typeof window === 'undefined') {
        return;
    }

    const RELOAD_KEY = 'evb-viewer:dev:optimize-dep-reload';
    const RELOAD_COOLDOWN_MS = 10_000;
    const INITIAL_LOAD_GRACE_MS = 1_000;
    const MAX_RELOADS_KEY = 'evb-viewer:dev:reload-count';
    const MAX_RELOADS_PER_SESSION = 3;

    const reloadHistory: IReloadEvent[] = [];
    (window as IWindowWithReloadHistory).__reloadHistory = reloadHistory;

    const pageLoadTime = Date.now();

    function isViteOptimizeDepError(message: string) {
        if (message.includes('Outdated Optimize Dep')) {
            return true;
        }
        return message.includes('Failed to fetch dynamically imported module') && message.includes('localhost:');
    }

    function shouldReloadNow(): IReloadDecision {
        try {
            const timeSinceLoad = Date.now() - pageLoadTime;
            if (timeSinceLoad < INITIAL_LOAD_GRACE_MS) {
                return {
                    allowed: false,
                    blockReason: `Within initial load grace period (${timeSinceLoad}ms < ${INITIAL_LOAD_GRACE_MS}ms)`,
                };
            }

            const reloadCount = Number(window.sessionStorage.getItem(MAX_RELOADS_KEY) ?? '0');
            if (reloadCount >= MAX_RELOADS_PER_SESSION) {
                return {
                    allowed: false,
                    blockReason: `Maximum reloads exceeded (${reloadCount} >= ${MAX_RELOADS_PER_SESSION})`,
                };
            }

            const last = Number(window.sessionStorage.getItem(RELOAD_KEY) ?? '0');
            if (Number.isFinite(last) && last > 0 && Date.now() - last < RELOAD_COOLDOWN_MS) {
                return {
                    allowed: false,
                    blockReason: `Cooldown active (${Date.now() - last}ms < ${RELOAD_COOLDOWN_MS}ms)`,
                };
            }

            window.sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
            window.sessionStorage.setItem(MAX_RELOADS_KEY, String(reloadCount + 1));
            return { allowed: true };
        } catch {
            return { allowed: true };
        }
    }

    function scheduleReload(reason: string) {
        const reloadId = `reload-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

        if (!window.location?.href?.includes('localhost:')) {
            reloadHistory.push({
                timestamp: Date.now(),
                reason,
                blocked: true,
                blockReason: 'Not running on localhost',
                reloadId,
            });
            return;
        }

        const decision = shouldReloadNow();
        if (!decision.allowed) {
            reloadHistory.push({
                timestamp: Date.now(),
                reason,
                blocked: true,
                blockReason: decision.blockReason,
                reloadId,
            });
            console.debug(`[Dev] Reload blocked: ${decision.blockReason} [${reloadId}]`);
            return;
        }

        reloadHistory.push({
            timestamp: Date.now(),
            reason,
            blocked: false,
            reloadId,
        });

        console.warn(`[Dev] Recovering from Vite optimize-deps error (${reason}); reloading... [${reloadId}]`);
        try {
            console.warn(`[Dev] Reload scheduled at ${new Date().toISOString()}, cooldown state:`, {
                lastReload: window.sessionStorage.getItem(RELOAD_KEY),
                timeSinceLastReload: Date.now() - Number(window.sessionStorage.getItem(RELOAD_KEY) ?? '0'),
                reloadCount: window.sessionStorage.getItem(MAX_RELOADS_KEY),
            });
        } catch {
            // sessionStorage may be unavailable
        }

        setTimeout(() => window.location.reload(), 250);
    }

    window.addEventListener('unhandledrejection', (event: PromiseRejectionEvent) => {
        const message = event?.reason instanceof Error ? event.reason.message : String(event?.reason ?? '');
        if (isViteOptimizeDepError(message)) {
            scheduleReload(message);
        }
    });
}
