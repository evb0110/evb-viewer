/* eslint-disable custom/file-naming */
export interface ITestRect {
    left: number;
    top: number;
    width: number;
    height: number;
}

export function createTestDomRect(rect: ITestRect): DOMRect {
    const {
        left,
        top,
        width,
        height,
    } = rect;
    return {
        bottom: top + height,
        height,
        left,
        right: left + width,
        toJSON: () => ({
            bottom: top + height,
            height,
            left,
            right: left + width,
            top,
            width,
            x: left,
            y: top,
        }),
        top,
        width,
        x: left,
        y: top,
    };
}
