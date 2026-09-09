export class BrowserWorkerResetError extends Error {
    public readonly code = 'BROWSER_WORKER_RESET';

    public constructor(message = 'Browser worker was reset before the request completed') {
        super(message);
        this.name = 'AbortError';
    }
}

export class BrowserWorkerClientLifecycle {
    private registered = false;
    private targetWindow: Window | null = null;

    public register(resetWorker: () => void) {
        const targetWindow = typeof window === 'undefined' ? null : window;
        if (
            this.registered
            || !targetWindow
            || typeof targetWindow.addEventListener !== 'function'
            || typeof targetWindow.removeEventListener !== 'function'
        ) {
            return;
        }

        const handlePageHide = (event: PageTransitionEvent) => {
            if (!event.persisted) {
                resetWorker();
            }
        };
        const handlePageShow = (event: PageTransitionEvent) => {
            if (event.persisted) {
                resetWorker();
            }
        };

        this.registered = true;
        this.targetWindow = targetWindow;
        targetWindow.addEventListener('pagehide', handlePageHide);
        targetWindow.addEventListener('pageshow', handlePageShow);
        this.pageHideHandler = handlePageHide;
        this.pageShowHandler = handlePageShow;
    }

    public clear() {
        if (!this.registered || !this.targetWindow || !this.pageHideHandler || !this.pageShowHandler) {
            this.registered = false;
            this.targetWindow = null;
            return;
        }

        this.targetWindow.removeEventListener('pagehide', this.pageHideHandler);
        this.targetWindow.removeEventListener('pageshow', this.pageShowHandler);
        this.registered = false;
        this.targetWindow = null;
        this.pageHideHandler = null;
        this.pageShowHandler = null;
    }

    private pageHideHandler: ((event: PageTransitionEvent) => void) | null = null;
    private pageShowHandler: ((event: PageTransitionEvent) => void) | null = null;
}
