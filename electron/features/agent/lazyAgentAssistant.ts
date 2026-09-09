// fallow-ignore-file duplicate-export
// The dynamic module shape keeps this facade coupled to the runtime exports
// without creating the static import that this boundary exists to avoid.
type TAgentAssistantRuntimeModule =
    // eslint-disable-next-line @typescript-eslint/consistent-type-imports
    typeof import('@electron/features/agent/assistantService');

let runtimeModulePromise: Promise<TAgentAssistantRuntimeModule> | null = null;
let runtimeModule: TAgentAssistantRuntimeModule | null = null;

function loadAgentAssistantRuntime() {
    runtimeModulePromise ??=
        import('@electron/features/agent/assistantService').then((loadedRuntime) => {
            runtimeModule = loadedRuntime;
            return loadedRuntime;
        });
    return runtimeModulePromise;
}

export async function getAgentAssistantState(
    ...args: Parameters<TAgentAssistantRuntimeModule['getAgentAssistantState']>
): Promise<Awaited<ReturnType<TAgentAssistantRuntimeModule['getAgentAssistantState']>>> {
    const runtime = await loadAgentAssistantRuntime();
    return runtime.getAgentAssistantState(...args);
}

export async function installAgentAssistantCodex(
    ...args: Parameters<TAgentAssistantRuntimeModule['installAgentAssistantCodex']>
): Promise<Awaited<ReturnType<TAgentAssistantRuntimeModule['installAgentAssistantCodex']>>> {
    const runtime = await loadAgentAssistantRuntime();
    runtime.initializeAgentAssistantRuntime();
    return runtime.installAgentAssistantCodex(...args);
}

export async function startAgentAssistantLogin(
    ...args: Parameters<TAgentAssistantRuntimeModule['startAgentAssistantLogin']>
): Promise<Awaited<ReturnType<TAgentAssistantRuntimeModule['startAgentAssistantLogin']>>> {
    const runtime = await loadAgentAssistantRuntime();
    runtime.initializeAgentAssistantRuntime();
    return runtime.startAgentAssistantLogin(...args);
}

export async function cancelAgentAssistantLogin(
    ...args: Parameters<TAgentAssistantRuntimeModule['cancelAgentAssistantLogin']>
): Promise<Awaited<ReturnType<TAgentAssistantRuntimeModule['cancelAgentAssistantLogin']>>> {
    const runtime = await loadAgentAssistantRuntime();
    runtime.initializeAgentAssistantRuntime();
    return runtime.cancelAgentAssistantLogin(...args);
}

export async function sendAgentAssistantMessage(
    ...args: Parameters<TAgentAssistantRuntimeModule['sendAgentAssistantMessage']>
): Promise<Awaited<ReturnType<TAgentAssistantRuntimeModule['sendAgentAssistantMessage']>>> {
    const runtime = await loadAgentAssistantRuntime();
    runtime.initializeAgentAssistantRuntime();
    return runtime.sendAgentAssistantMessage(...args);
}

export async function interruptAgentAssistant(
    ...args: Parameters<TAgentAssistantRuntimeModule['interruptAgentAssistant']>
): Promise<Awaited<ReturnType<TAgentAssistantRuntimeModule['interruptAgentAssistant']>>> {
    const runtime = await loadAgentAssistantRuntime();
    runtime.initializeAgentAssistantRuntime();
    return runtime.interruptAgentAssistant(...args);
}

export async function resetAgentAssistantChat(
    ...args: Parameters<TAgentAssistantRuntimeModule['resetAgentAssistantChat']>
): Promise<Awaited<ReturnType<TAgentAssistantRuntimeModule['resetAgentAssistantChat']>>> {
    const runtime = await loadAgentAssistantRuntime();
    runtime.initializeAgentAssistantRuntime();
    return runtime.resetAgentAssistantChat(...args);
}

export async function shutdownAgentAssistantIfLoaded() {
    if (runtimeModule) {
        // Calling the runtime before the first await synchronously invalidates
        // in-flight startup/send generations as soon as opt-out is observed.
        await runtimeModule.shutdownAgentAssistant();
        return;
    }
    if (!runtimeModulePromise) {
        return;
    }
    const runtime = await runtimeModulePromise;
    await runtime.shutdownAgentAssistant();
}
