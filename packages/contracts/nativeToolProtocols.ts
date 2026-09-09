export interface IGeneratedRustNativeToolCapability {
    name: string;
    required: boolean;
    introducedIn: number;
}

export interface IGeneratedRustNativeToolProtocol {
    binaryName: string;
    crateName: string;
    protocolVersion: number;
    capabilities?: readonly IGeneratedRustNativeToolCapability[];
    resourceFamilyId: 'pdf-image-combine' | 'pdf-page-ops' | 'pdf-search' | 'scan-cleanup';
    stagingName: string;
}

export const GENERATED_RUST_NATIVE_TOOL_PROTOCOLS = [
    {
        binaryName: 'evb-pdf-image-combine',
        crateName: 'pdf-image-combine',
        protocolVersion: 4,
        resourceFamilyId: 'pdf-image-combine',
        stagingName: 'pdf-image-combine',
    },
    {
        binaryName: 'evb-pdf-page-ops',
        crateName: 'pdf-page-ops',
        protocolVersion: 1,
        resourceFamilyId: 'pdf-page-ops',
        stagingName: 'pdf-page-ops',
    },
    {
        binaryName: 'evb-pdf-search',
        crateName: 'pdf-search',
        protocolVersion: 1,
        resourceFamilyId: 'pdf-search',
        stagingName: 'pdf-search',
    },
    {
        binaryName: 'evb-scan-cleanup',
        crateName: 'scan-cleanup',
        // Runtime capability negotiation is independent of the public JSON
        // `version`. The manifest contract ignores additive fields, so legacy
        // revision 9 remains usable with the required `manifest-v3`
        // capability. Revision 10 adds optional `structured-warning-events`.
        // Callers that require that capability must refuse a legacy binary;
        // callers that do not require it use the legacy warning fallback.
        protocolVersion: 10,
        capabilities: [
            {
                name: 'manifest-v3',
                required: true,
                introducedIn: 1,
            },
            {
                name: 'structured-warning-events',
                required: false,
                introducedIn: 10,
            },
        ],
        resourceFamilyId: 'scan-cleanup',
        stagingName: 'scan-cleanup',
    },
] as const satisfies readonly IGeneratedRustNativeToolProtocol[];

export const SEARCH_NATIVE_PROTOCOL_VERSION = GENERATED_RUST_NATIVE_TOOL_PROTOCOLS[2].protocolVersion;
