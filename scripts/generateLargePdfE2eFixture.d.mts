declare module '@scripts/generate-large-pdf-e2e-fixture.mjs' {
    export const DEFAULT_LARGE_PDF_FIXTURE_BYTES: number;
    export const DEFAULT_LARGE_PDF_FIXTURE_PAGES: number;
    export function generateLargePdfE2eFixture(options: {
        outputPath: string;
        pageCount?: number;
        targetBytes?: number;
    }): Promise<string>;
}
