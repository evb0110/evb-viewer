import { vi } from 'vitest';
import type { IPlatformMethodDescriptor } from '@contracts/platformApiDescriptor';
import { cast } from '@tests/helpers/cast';

export interface IPlatformApiFixtureEventMethod {
    emit: (payload: unknown) => void;
    dispose: () => void;
}

type TPlatformApiFixtureEventFunction = (
    callback: (payload: unknown) => void,
) => () => void;

function createAsyncDefault(path: string) {
    if (path === 'updates.getState') {
        return vi.fn(async () => ({
            phase: 'unsupported',
            origin: 'auto',
            version: null,
            percent: null,
            message: null,
        }));
    }
    if (path === 'updates.check' || path === 'updates.download' || path === 'updates.install') {
        return vi.fn(async () => ({started: false}));
    }
    if (path.endsWith('.get')) {
        return vi.fn(async () => ({}));
    }
    if (path.endsWith('.getMemoryInfo')) {
        return vi.fn(() => null);
    }
    if (path.endsWith('.fileExists')) {
        return vi.fn(async () => false);
    }
    if (path.endsWith('.readFile') || path.endsWith('.readFileRange')) {
        return vi.fn(async () => new Uint8Array());
    }
    if (path.endsWith('.readFileChunks')) {
        return vi.fn(async () => ({
            bytesRead: 0,
            chunks: 0,
            size: 0,
        }));
    }
    if (path.endsWith('.readTextFile')) {
        return vi.fn(async () => '');
    }
    if (path.endsWith('.registerFilesForOpen')) {
        return vi.fn(async () => []);
    }
    if (path.endsWith('.getDocumentRevision')) {
        return vi.fn(async () => ({
            authority: 'electron-working-copy',
            contentRevision: 1,
            documentRef: '/tmp/fixture.pdf',
            mintedAt: 1,
            token: 'drt1:1:1:fixture',
            version: 1,
        }));
    }
    if (path.includes('validatePdf') || path.includes('repairPdf') || path.includes('savePdfData')) {
        return vi.fn(async () => ({valid: true}));
    }
    if (path.endsWith('.saveFileStructured')) {
        return vi.fn(async () => ({
            externalWriteCommitted: true,
            ok: true,
            validation: null,
            workingCopyRefreshed: true,
        }));
    }
    if (path.includes('openDocument') || path.includes('openPdf')) {
        return vi.fn(async () => null);
    }
    if (path.includes('getPathForFile')) {
        return vi.fn(() => '/tmp/fixture.pdf');
    }
    if (path.includes('getPathsForFiles')) {
        return vi.fn(() => []);
    }
    return vi.fn(async () => {
        throw new Error(`Unsupported platform API fixture call: ${path}`);
    });
}

export function createDefaultPlatformApiFixtureMethod(
    descriptor: IPlatformMethodDescriptor, example?: () => unknown,
) {
    if (descriptor.kind === 'event') {
        const subscribers = new Set<(payload: unknown) => void>();
        const method = cast<TPlatformApiFixtureEventFunction & IPlatformApiFixtureEventMethod>(vi.fn((callback: (payload: unknown) => void) => {
            subscribers.add(callback);
            let subscribed = true;
            return () => {
                if (!subscribed) {
                    return;
                }
                subscribed = false;
                subscribers.delete(callback);
            };
        }));
        const controls: IPlatformApiFixtureEventMethod = {
            emit: payload => {
                for (const subscriber of subscribers) {
                    subscriber(payload);
                }
            },
            dispose: () => subscribers.clear(),
        };
        Object.assign(method, controls);
        return method;
    }
    if (example !== undefined) {
        return descriptor.kind === 'async'
            ? vi.fn(async () => example())
            : vi.fn(() => example());
    }
    const path = descriptor.path.join('.');
    if (descriptor.kind === 'sync') {
        if (
            path.endsWith('.getMemoryInfo')
            || path.endsWith('.getResourceProfile')
        ) {
            return vi.fn(() => null);
        }
        if (path.endsWith('.getPathForFile')) {
            return vi.fn(() => '/tmp/fixture.pdf');
        }
        if (path.endsWith('.getPathsForFiles')) {
            return vi.fn(() => []);
        }
    }
    if (descriptor.kind === 'void') {
        return vi.fn(() => undefined);
    }
    return createAsyncDefault(path);
}
