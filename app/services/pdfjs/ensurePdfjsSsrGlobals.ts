class DOMMatrixSsrStub {
    public a = 1;
    public b = 0;
    public c = 0;
    public d = 1;
    public e = 0;
    public f = 0;
    public m11 = 1;
    public m12 = 0;
    public m13 = 0;
    public m14 = 0;
    public m21 = 0;
    public m22 = 1;
    public m23 = 0;
    public m24 = 0;
    public m31 = 0;
    public m32 = 0;
    public m33 = 1;
    public m34 = 0;
    public m41 = 0;
    public m42 = 0;
    public m43 = 0;
    public m44 = 1;

    public multiplySelf() {
        return this;
    }

    public preMultiplySelf() {
        return this;
    }

    public translateSelf() {
        return this;
    }

    public scaleSelf() {
        return this;
    }

    public rotateSelf() {
        return this;
    }

    public rotateAxisAngleSelf() {
        return this;
    }

    public skewXSelf() {
        return this;
    }

    public skewYSelf() {
        return this;
    }

    public invertSelf() {
        return this;
    }

    public transformPoint(point?: {x?: number; y?: number; z?: number; w?: number}) {
        return {
            x: point?.x ?? 0,
            y: point?.y ?? 0,
            z: point?.z ?? 0,
            w: point?.w ?? 1,
        };
    }
}

interface IPdfjsSsrGlobalScope {
    DOMMatrix?: new () => DOMMatrixSsrStub;
}

function isBrowserDocumentRuntime() {
    return typeof window !== 'undefined' && typeof document !== 'undefined';
}

export function ensurePdfjsSsrGlobals() {
    if (!import.meta.server && isBrowserDocumentRuntime()) {
        return;
    }

    const globalScope = globalThis as IPdfjsSsrGlobalScope;

    if (typeof globalScope.DOMMatrix === 'undefined') {
        globalScope.DOMMatrix = DOMMatrixSsrStub;
    }
}
