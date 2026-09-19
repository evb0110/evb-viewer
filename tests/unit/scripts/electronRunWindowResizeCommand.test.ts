import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type { Page } from 'puppeteer-core';
import { createCommandHandler } from '@scripts/electron-run/createCommandHandler';
import {
    isElectronRunCommand,
    parseElectronRunCommandRequest,
} from '@scripts/electron-run/electronRunProtocol';
import type { ISessionState } from '@scripts/electron-run/electronRunSessionTypes';
import { cast } from '@tests/helpers/cast';

// The window a person resizes is the native one. These cases keep the two
// commands apart: `windowResize` must move the native window through its own
// frame arithmetic, and `emulateViewport` must never touch it.

interface INativeWindowModel {
    contentWidth: number;
    contentHeight: number;
    frameWidth: number;
    frameHeight: number;
    minimumContentWidth: number;
    resizeRequests: Array<{
        width: number;
        height: number;
    }>;
}

function createNativeWindowModel(overrides: Partial<INativeWindowModel> = {}): INativeWindowModel {
    return {
        contentWidth: 900,
        contentHeight: 668,
        frameWidth: 0,
        frameHeight: 32,
        minimumContentWidth: 0,
        resizeRequests: [],
        ...overrides,
    };
}

function stubRendererWindow(model: INativeWindowModel) {
    vi.stubGlobal('window', {
        get innerWidth() {
            return model.contentWidth;
        },
        get innerHeight() {
            return model.contentHeight;
        },
        get outerWidth() {
            return model.contentWidth + model.frameWidth;
        },
        get outerHeight() {
            return model.contentHeight + model.frameHeight;
        },
        devicePixelRatio: 2,
        resizeTo(width: number, height: number) {
            model.resizeRequests.push({
                width,
                height,
            });
            model.contentWidth = Math.max(model.minimumContentWidth, width - model.frameWidth);
            model.contentHeight = height - model.frameHeight;
        },
    });
}

function createHandlerForModel(model: INativeWindowModel) {
    stubRendererWindow(model);
    const setViewport = vi.fn();
    const viewport = vi.fn(() => null);
    const page = cast<Page>({
        evaluate: <TArgs extends unknown[], TResult>(
            pageFunction: (...args: TArgs) => TResult,
            ...args: TArgs
        ) => Promise.resolve(pageFunction(...args)),
        setViewport,
        viewport,
    });
    const sessionState = cast<ISessionState>({page});
    return {
        handleCommand: createCommandHandler(() => sessionState),
        setViewport,
    };
}

describe('electron run window resize command', () => {
    it('accepts the two size commands and no longer accepts the ambiguous name', () => {
        expect(isElectronRunCommand('windowResize')).toBe(true);
        expect(isElectronRunCommand('emulateViewport')).toBe(true);
        expect(isElectronRunCommand('resize')).toBe(false);
        expect(parseElectronRunCommandRequest({
            command: 'windowResize',
            args: [
                640,
                480,
            ],
        })).toEqual({
            command: 'windowResize',
            args: [
                640,
                480,
            ],
        });
    });

    it('resizes the native window so the content area gets the requested size', async () => {
        const model = createNativeWindowModel();
        const {handleCommand} = createHandlerForModel(model);

        const result = await handleCommand('windowResize', [
            '640',
            '480',
        ]) as {
            after: {contentSize: {
                width: number;
                height: number;
            };};
            before: {contentSize: {width: number;};};
            settled: boolean;
        };

        // The request names the whole window, so the frame has to be added
        // back or the document would lose the frame's worth of layout.
        expect(model.resizeRequests).toEqual([{
            width: 640,
            height: 512,
        }]);
        expect(result.before.contentSize.width).toBe(900);
        expect(result.after.contentSize).toEqual({
            width: 640,
            height: 480,
        });
        expect(result.settled).toBe(true);
    });

    it('refuses a size the native window did not reach', async () => {
        const model = createNativeWindowModel({minimumContentWidth: 700});
        const {handleCommand} = createHandlerForModel(model);

        await expect(handleCommand('windowResize', [
            '320',
            '480',
            '10',
        ])).rejects.toThrow(/did not reach 320x480; it settled at 700x480/u);
    });

    it('requires both dimensions', async () => {
        const {handleCommand} = createHandlerForModel(createNativeWindowModel());

        await expect(handleCommand('windowResize', ['640'])).rejects.toThrow('Width and height required');
        await expect(handleCommand('emulateViewport', [
            '0',
            '480',
        ])).rejects.toThrow('Width and height required');
    });

    it('emulates a viewport without moving the native window', async () => {
        const model = createNativeWindowModel();
        const {
            handleCommand,
            setViewport,
        } = createHandlerForModel(model);

        const result = await handleCommand('emulateViewport', [
            '1280',
            '820',
        ]) as {emulated: {
            width: number;
            height: number;
        };};

        expect(setViewport).toHaveBeenCalledWith({
            width: 1280,
            height: 820,
        });
        expect(result.emulated).toEqual({
            width: 1280,
            height: 820,
        });
        expect(model.resizeRequests).toEqual([]);
        expect(model.contentWidth).toBe(900);
    });
});
