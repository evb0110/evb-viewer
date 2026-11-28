import * as nodeModule from 'node:module';

try {
    nodeModule.enableCompileCache?.();
} catch {
    // Compile cache is optional and may be unavailable in restricted or read-only environments.
}

await import('@electron/bootstrap/mainProcess');
