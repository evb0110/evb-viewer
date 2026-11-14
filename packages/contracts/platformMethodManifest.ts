import { PLATFORM_API_DESCRIPTOR } from '@contracts/platformApiDescriptor';

// Compatibility exports for the consumer-inventory tooling. The canonical method
// inventory lives in PLATFORM_API_DESCRIPTOR and is also the source for generated
// browser forwarding artifacts, so a second hand-maintained list cannot drift.
export const platformMethodDescriptorList = PLATFORM_API_DESCRIPTOR.methods;
