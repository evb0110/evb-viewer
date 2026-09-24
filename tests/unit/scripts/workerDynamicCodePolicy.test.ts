import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
    describe,
    expect,
    it,
} from 'vitest';

interface IDynamicCodeAnalysis {
    allowedIdioms: string[];
    violations: Array<{
        excerpt: string;
        kind: string;
    }>;
}

interface IWorkerDynamicCodePolicyModule {analyzeDynamicCodeConstruction: (content: string) => IDynamicCodeAnalysis}

const {analyzeDynamicCodeConstruction} = await import(
    pathToFileURL(path.resolve(process.cwd(), 'scripts/lib/worker-dynamic-code-policy.mjs')).href
) as IWorkerDynamicCodePolicyModule;

function violationKinds(content: string) {
    return analyzeDynamicCodeConstruction(content).violations.map(({kind}) => kind);
}

// The analyzer is a textual scan for bare `eval`/`Function` construction call
// sites in a worker bundle. These tests describe exactly that: they do not
// claim aliased references or computed member access are caught.
describe('worker dynamic code policy', () => {
    it.each([
        [
            'const value=eval("1+1");',
            'eval(',
        ],
        [
            '(0, eval)("1+1")',
            'indirect (0, eval)',
        ],
        [
            'const fn=new Function("return 1");',
            'new Function(',
        ],
        [
            'const fn = new  Function(body);',
            'new Function(',
        ],
        [
            'const fn=Function("return "+expression)();',
            'Function(',
        ],
        [
            'globalThis.eval(source);',
            'globalThis.eval(',
        ],
        [
            'self.Function("return 1")();',
            'self.Function(',
        ],
        [
            'const fn=new window.Function(body);',
            'new window.Function(',
        ],
    ])('flags %s', (content, expectedKind) => {
        expect(violationKinds(content)).toEqual([expectedKind]);
    });

    it('ignores property access, identifiers, and prose that merely contain the names', () => {
        const harmless = 'const retrieval=1;options.evaluator.eval(x);'
            + 'import { createRequire as __evbCreateRequire } from "node:module";'
            + 'const require = __evbCreateRequire(import.meta.url);'
            + 'var __require=()=>{throw Error(\'Dynamic require not supported\')};'
            + 'const label="evaluation";Function.prototype.call;'
            + 'const aFunction=(x)=>x;aFunction(1);this.Function(2);'
            + 'sandbox.globalThis.eval(1);host.self.Function(2);';

        expect(analyzeDynamicCodeConstruction(harmless)).toEqual({
            allowedIdioms: [],
            violations: [],
        });
    });

    // The scan matches literal call sites only. Indirection through a binding or
    // a computed property is outside what a regular expression over bundle text
    // can see, and the check does not pretend otherwise.
    it('does not see indirection through a binding or computed member access', () => {
        expect(violationKinds('const build=Reflect.get(globalThis,"eval");build(source);')).toEqual([]);
        expect(violationKinds('globalThis["ev"+"al"](source);')).toEqual([]);
    });

    it('allows only the exact vendored idioms the bundles ship', () => {
        const vendored = 'var g=typeof globalThis=="object"&&globalThis||Function("return this")();'
            + 'try{return Function(\'return require("\'+a+\'")\')()}catch{}';

        expect(analyzeDynamicCodeConstruction(vendored)).toEqual({
            allowedIdioms: [
                'core-js/whatwg globalThis polyfill',
                'core-js Node built-in module fallback',
            ],
            violations: [],
        });
    });

    it('does not let a near-miss of an allowed idiom pass', () => {
        expect(violationKinds('Function("return this; " + payload)()')).toEqual(['Function(']);
        expect(violationKinds('Function(\'return require("\'+a+\'").run(\'+b+\')\')()'))
            .toEqual(['Function(']);
    });
});
