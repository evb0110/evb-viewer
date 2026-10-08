import { randomUUID } from 'crypto';
import type {
    TAgentAssistantProviderId,
    TAgentAssistantTurnPhase,
    TAgentWorkspaceCommandTarget,
} from '@contracts/agent';
import type {
    TDocumentBackend,
    TDocumentRef,
} from '@contracts/documentRef';
import type { IDocumentRevisionInfo } from '@contracts/documentRevision';
import type { TDocumentInstanceId } from '@contracts/documentInstanceId';
import type {TTabId} from '@contracts/windowTabs';

export interface IAssistantSessionScopeBinding {
    sessionKey: string;
    scopeKey: string;
    provider: TAgentAssistantProviderId;
    turnGeneration: number;
    windowId: number;
    tabId: TTabId;
    documentSessionKey?: string | null;
    documentRef: TDocumentRef | null;
    documentBackend?: TDocumentBackend;
    documentInstanceId?: TDocumentInstanceId | null;
    documentIdentity: IDocumentRevisionInfo | null;
    commandTarget?: TAgentWorkspaceCommandTarget;
}

export type TAssistantTurnOwnerState =
    | {
        phase: 'idle';
        generation: number;
        turnId: null;
        localTurnId: null;
    }
    | {
        phase: 'starting';
        generation: number;
        localTurnId: string;
        providerTurnId: null;
        scope: IAssistantSessionScopeBinding;
    }
    | {
        phase: 'running';
        generation: number;
        localTurnId: string;
        providerTurnId: string;
        scope: IAssistantSessionScopeBinding;
    }
    | {
        phase: 'interrupting';
        generation: number;
        localTurnId: string;
        providerTurnId: string | null;
        scope: IAssistantSessionScopeBinding;
    }
    | {
        phase: 'error';
        generation: number;
        turnId: null;
        localTurnId: null;
        error: string;
    };

export interface ICompleteAssistantTurnOptions { allowStartingWithoutProviderTurn?: boolean; }

export function createInitialAssistantTurnOwner(): TAssistantTurnOwnerState {
    return {
        phase: 'idle',
        generation: 0,
        turnId: null,
        localTurnId: null,
    };
}

export function claimAssistantTurn(
    owner: TAssistantTurnOwnerState,
    scope: Omit<IAssistantSessionScopeBinding, 'turnGeneration'>,
    localTurnId: string = randomUUID(),
): TAssistantTurnOwnerState {
    const generation = owner.generation + 1;
    return {
        phase: 'starting',
        generation,
        localTurnId,
        providerTurnId: null,
        scope: {
            ...scope,
            turnGeneration: generation,
        },
    };
}

export function markAssistantTurnRunning(
    owner: TAssistantTurnOwnerState,
    generation: number,
    providerTurnId: string | null,
): TAssistantTurnOwnerState {
    if (!matchesSessionGeneration(owner, generation) || !providerTurnId) {
        return owner;
    }

    if (owner.phase !== 'starting' && owner.phase !== 'running' && owner.phase !== 'interrupting') {
        return owner;
    }

    if (owner.phase === 'running') {
        return owner;
    }

    if (owner.phase === 'interrupting' && owner.providerTurnId !== null && owner.providerTurnId !== providerTurnId) {
        return owner;
    }

    return {
        phase: 'running',
        generation,
        localTurnId: owner.localTurnId,
        providerTurnId,
        scope: owner.scope,
    };
}

export function markAssistantTurnInterrupting(
    owner: TAssistantTurnOwnerState,
    generation = owner.generation,
): TAssistantTurnOwnerState {
    if (!matchesSessionGeneration(owner, generation)) {
        return owner;
    }

    if (owner.phase !== 'starting' && owner.phase !== 'running' && owner.phase !== 'interrupting') {
        return owner;
    }

    return {
        phase: 'interrupting',
        generation,
        localTurnId: owner.localTurnId,
        providerTurnId: owner.providerTurnId,
        scope: {
            ...owner.scope,
            turnGeneration: generation,
        },
    };
}

export function completeAssistantTurn(
    owner: TAssistantTurnOwnerState,
    generation: number,
    providerTurnId?: string | null,
    options: ICompleteAssistantTurnOptions = {},
): TAssistantTurnOwnerState {
    if (!matchesSessionGeneration(owner, generation) || !matchesProviderTurn(owner, providerTurnId)) {
        return owner;
    }

    if (owner.phase !== 'starting' && owner.phase !== 'running' && owner.phase !== 'interrupting') {
        return owner;
    }

    if (
        providerTurnId == null
        && owner.phase === 'starting'
        && options.allowStartingWithoutProviderTurn !== true
    ) {
        return owner;
    }

    return {
        phase: 'idle',
        generation,
        turnId: null,
        localTurnId: null,
    };
}

export function errorAssistantTurn(
    owner: TAssistantTurnOwnerState,
    generation: number,
    error: string,
    providerTurnId?: string | null,
): TAssistantTurnOwnerState {
    if (!matchesSessionGeneration(owner, generation) || !matchesProviderTurn(owner, providerTurnId)) {
        return owner;
    }

    return {
        phase: 'error',
        generation,
        turnId: null,
        localTurnId: null,
        error,
    };
}

export function supersedeAssistantTurn(
    owner: TAssistantTurnOwnerState,
): TAssistantTurnOwnerState {
    return {
        phase: 'idle',
        generation: owner.generation + 1,
        turnId: null,
        localTurnId: null,
    };
}

function matchesSessionGeneration(owner: TAssistantTurnOwnerState, generation: number) {
    return owner.generation === generation;
}

export function matchesProviderTurn(
    owner: TAssistantTurnOwnerState,
    providerTurnId?: string | null,
) {
    if (providerTurnId == null) {
        return true;
    }

    return getAssistantTurnProviderTurnId(owner) === providerTurnId;
}

export function isAssistantTurnActive(owner: TAssistantTurnOwnerState) {
    return owner.phase === 'starting'
        || owner.phase === 'running'
        || owner.phase === 'interrupting';
}

export function canCompleteAssistantTurnWithoutProviderTurn(owner: TAssistantTurnOwnerState) {
    return owner.phase === 'running' || owner.phase === 'interrupting';
}

export function getAssistantTurnProviderTurnId(owner: TAssistantTurnOwnerState) {
    return owner.phase === 'running' || owner.phase === 'interrupting'
        ? owner.providerTurnId
        : null;
}

export function getAssistantTurnPhase(owner: TAssistantTurnOwnerState): TAgentAssistantTurnPhase {
    switch (owner.phase) {
        case 'idle': return 'idle';
        case 'starting': return 'queued';
        case 'running': return 'streaming';
        case 'interrupting': return 'interrupting';
        case 'error': return 'failed';
    }
}

export function getAssistantTurnScope(owner: TAssistantTurnOwnerState) {
    return isAssistantTurnActive(owner) ? owner.scope : null;
}

export function buildAssistantSessionScopeBindingFingerprint(
    binding: IAssistantSessionScopeBinding | null | undefined,
) {
    return JSON.stringify({
        provider: binding?.provider ?? null,
        scopeKey: binding?.scopeKey ?? null,
        tabId: binding?.tabId ?? null,
        documentSessionKey: binding?.documentSessionKey ?? binding?.scopeKey ?? null,
        documentInstanceId: binding?.documentInstanceId ?? binding?.commandTarget?.documentInstanceId ?? null,
        documentRef: binding?.documentRef ?? binding?.commandTarget?.documentRef ?? null,
        documentRevisionToken: binding?.commandTarget?.documentRevisionToken
            ?? binding?.documentIdentity?.token
            ?? null,
    });
}
