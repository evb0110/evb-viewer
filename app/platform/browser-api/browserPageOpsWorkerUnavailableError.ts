export class BrowserPageOpsWorkerUnavailableError extends Error {
    public constructor(message: string) {
        super(message);
        this.name = 'BrowserPageOpsWorkerUnavailableError';
    }
}
