declare module '@scripts/ensure-pdfjs-dev-install.mjs' {
    interface IPdfjsDevIdentity {
        archivePath: string;
        expectedVersion: string;
        installedPackagePath: string;
        installedVersion: string | null;
        publicStampPath: string;
        publicVersion: string | null;
    }

    export function readPdfjsDevIdentity(root?: string): IPdfjsDevIdentity;
    export function getPdfjsDevIdentityProblems(identity: IPdfjsDevIdentity): string[];
    export function formatPdfjsDevIdentityFailure(identity: IPdfjsDevIdentity, problems: string[]): string;
    export function ensurePdfjsDevInstall(options?: {root?: string; install?: () => unknown; readIdentity?: () => IPdfjsDevIdentity}): {
        repaired: boolean;
        identity: IPdfjsDevIdentity;
    };
}
