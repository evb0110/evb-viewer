// Only invariants from ARCHITECTURE.md, the design charter, ADR 0002,
// behavior contract C4, and AGENTS.md's real-input evidence policy live here.
// Oxlint supplies the AST for TypeScript and extracted Vue scripts; template
// visitors are not available through its JS plugin API.
import path from 'node:path';

function toRepoPath(filePath) {
    return path.relative(import.meta.dirname, filePath).split(path.sep).join('/');
}

function getLiteralValue(node) {
    if (!node) {
        return null;
    }
    if (node.type === 'VLiteral') {
        return node.value;
    }
    if (node.type === 'Literal' && typeof node.value === 'string') {
        return node.value;
    }
    if (node.type === 'TemplateLiteral' && node.expressions.length === 0) {
        return node.quasis[0]?.value?.cooked ?? node.quasis[0]?.value?.raw ?? null;
    }
    return null;
}

function getStaticMemberPath(node) {
    if (node?.type === 'Identifier') {
        return node.name;
    }
    if (
        node?.type === 'MemberExpression'
        && !node.computed
        && node.property?.type === 'Identifier'
    ) {
        const objectPath = getStaticMemberPath(node.object);
        return objectPath ? `${objectPath}.${node.property.name}` : null;
    }
    return null;
}

function isToastObject(node) {
    if (node?.type === 'CallExpression' && node.callee?.type === 'Identifier' && node.callee.name === 'useToast') {
        return true;
    }
    return getStaticMemberPath(node)?.split('.').some(part => part.toLowerCase().includes('toast')) ?? false;
}

function getStaticPropertyName(property) {
    if (!property || property.computed) {
        return null;
    }
    if (property.key?.type === 'Identifier') {
        return property.key.name;
    }
    if (property.key?.type === 'VIdentifier') {
        return property.key.name;
    }
    return getLiteralValue(property.key);
}

function getErrorColorProperty(argument) {
    if (argument?.type !== 'ObjectExpression') {
        return null;
    }
    return argument.properties.find(property => (
        property?.type === 'Property'
        && getStaticPropertyName(property) === 'color'
        && getLiteralValue(property.value) === 'error'
    )) ?? null;
}

function getSentryRepoPath(context) {
    const filePath = context.physicalFilename ?? context.filename;
    if (!filePath || filePath.startsWith('<')) {
        return '';
    }
    return toRepoPath(path.resolve(filePath));
}

function isApplicationSource(repoPath) {
    return /^(app|electron|landing|server)\//u.test(repoPath);
}

function isSharedFailurePresenter(repoPath) {
    return repoPath === 'app/composables/useFailureToast.ts'
        || repoPath === 'app/components/AppFatalRuntimeDialog.vue';
}

const noRawRedPresentationRule = {
    meta: {
        type: 'problem',
        docs: {
            description: 'Warn when application code creates a red toast or alert outside the shared failure presenters',
            recommended: false,
        },
        schema: [],
    },
    create(context) {
        const repoPath = getSentryRepoPath(context);
        if (!isApplicationSource(repoPath) || isSharedFailurePresenter(repoPath)) {
            return {};
        }

        const visitors = {CallExpression(node) {
            if (
                node.callee?.type !== 'MemberExpression'
                    || node.callee.computed
                    || node.callee.property?.type !== 'Identifier'
                    || node.callee.property.name !== 'add'
                    || !isToastObject(node.callee.object)
            ) {
                return;
            }

            const colorProperty = getErrorColorProperty(node.arguments[0]);
            if (colorProperty) {
                context.report({
                    node: colorProperty,
                    message: 'Route red failure presentation through the shared receipt-aware presenter.',
                });
            }
        }};
        return visitors;
    },
};

const IN_PAGE_FUNCTION_CALLEES = new Set([
    '$eval',
    '$$eval',
    'evaluate',
    'evaluateHandle',
    'evaluateInPage',
    'evaluateOnNewDocument',
    'waitForFunction',
    'waitForFunctionInPage',
]);

function getCalleeName(callee) {
    if (callee?.type === 'Identifier') {
        return callee.name;
    }
    if (callee?.type === 'MemberExpression' && !callee.computed && callee.property?.type === 'Identifier') {
        return callee.property.name;
    }
    return null;
}

function isInsideInPageFunction(node) {
    for (let current = node.parent; current; current = current.parent) {
        if (
            (current.type === 'ArrowFunctionExpression' || current.type === 'FunctionExpression')
            && current.parent?.type === 'CallExpression'
            && current.parent.arguments.includes(current)
            && IN_PAGE_FUNCTION_CALLEES.has(getCalleeName(current.parent.callee))
        ) {
            return true;
        }
    }
    return false;
}

// Without type information the rule cannot tell Puppeteer's
// ElementHandle.click() or page.click(selector) from the DOM's element.click(),
// so it allows only clicks in a function handed to the page.
const e2eClickAsUserRule = {
    meta: {
        type: 'problem',
        docs: {
            description: 'Require E2E element clicks to go through clickAsUser',
            recommended: false,
        },
        schema: [],
    },
    create(context) {
        return {CallExpression(node) {
            const callee = node.callee;
            if (
                callee.type !== 'MemberExpression'
                || callee.computed
                || callee.property.type !== 'Identifier'
                || callee.property.name !== 'click'
                || getCalleeName(callee.object) === 'mouse'
            ) {
                return;
            }
            if (isInsideInPageFunction(node)) {
                return;
            }
            context.report({
                node,
                message: 'Click through clickAsUser from tests/e2e/electron/helpers/userInput.ts; ElementHandle.click and page.click do not check what covers the target.',
            });
        }};
    },
};

function makeArchitectureRule(description, create) {
    return {
        meta: {
            type: 'problem',
            docs: {description},
            schema: [],
        },
        create,
    };
}

function hasRepoPathPrefix(fileName, prefix) {
    return fileName === prefix || fileName.startsWith(`${prefix}/`);
}

const architectureRules = {
    'annotation-storage-public-access': makeArchitectureRule(
        'Require public annotation storage diagnostics access',
        context => {
            const fileName = toRepoPath(context.filename);
            if (![
                'app',
                'electron',
                'landing',
                'packages',
                'scripts',
                'server',
            ].some(root => hasRepoPathPrefix(fileName, root))) return {};
            const source = context.sourceCode.text;
            const aliases = new Set(['annotationStorage']);
            for (const match of source.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*[^;]*?\??\.\s*annotationStorage\b/gu)) {
                if (match[1]) aliases.add(match[1]);
            }
            const members = '(?:serializable|modifiedIds|resetModified|resetModifiedIds)';
            return {Program() {
                if ([...aliases].some(alias => new RegExp(`\\b${alias}\\s*(?:\\?\\.)?\\s*(?:\\.\\s*${members}|\\?\\.\\s*${members}|\\[\\s*["']${members}["']\\s*\\])`, 'u').test(source))) {
                    context.report({
                        node: context.sourceCode.ast,
                        message: 'PDF.js annotationStorage internals must be accessed through the public annotation diagnostics accessor.',
                    });
                }
            }};
        },
    ),
    'platform-api-narrow-getter': makeArchitectureRule('Require narrow platform capability getters', context => {
        const fileName = toRepoPath(context.filename);
        if (!hasRepoPathPrefix(fileName, 'app') || /\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(fileName)
            || fileName.includes('/__tests__/')) return {};
        const allowed = new Set([
            'app/utils/platformDocuments.ts',
            'app/utils/getShellCapability.ts',
            'app/utils/getSettingsCapability.ts',
            'app/utils/getDjvuCapability.ts',
            'app/utils/getOcrCapability.ts',
            'app/utils/getScanCleanupCapability.ts',
            'app/utils/getSearchCapability.ts',
            'app/utils/platformUpdates.ts',
            'app/utils/platformWindowTabs.ts',
            'app/utils/getAgentCapability.ts',
            'app/utils/getHostCapability.ts',
            'app/utils/getSystemCapability.ts',
        ]);
        if (allowed.has(fileName)) return {};
        const direct = new Set();
        const namespace = new Set();
        const normalize = value => value.startsWith('@app/') ? `app/${value.slice(5)}`
            : value.startsWith('~/') ? `app/${value.slice(2)}`
                : value.startsWith('./') || value.startsWith('../')
                    ? path.posix.normalize(path.posix.join(path.posix.dirname(fileName), value)) : value;
        function isPlatformHelper(value) {
            return path.posix.normalize(normalize(value).replace(/\.[cm]?[jt]sx?$/u, '')) === 'app/utils/platform';
        }
        return {
            ImportDeclaration(node) {
                if (!isPlatformHelper(node.source.value) || node.importKind === 'type') return;
                for (const specifier of node.specifiers) {
                    if (specifier.importKind === 'type') continue;
                    if (specifier.type === 'ImportNamespaceSpecifier') namespace.add(specifier.local.name);
                    if (specifier.type === 'ImportSpecifier' && (specifier.imported.name ?? specifier.imported.value) === 'getPlatformAPI') direct.add(specifier.local.name);
                }
            },
            CallExpression(node) {
                const callee = node.callee;
                if ((callee.type === 'Identifier' && direct.has(callee.name))
                    || (callee.type === 'MemberExpression' && !callee.computed && callee.property.name === 'getPlatformAPI'
                        && callee.object.type === 'Identifier' && namespace.has(callee.object.name))) {
                    context.report({
                        node,
                        message: 'App code must use a narrow platform capability getter instead of calling getPlatformAPI() directly.',
                    });
                }
            },
        };
    }),
    'workspace-format-comparison': makeArchitectureRule('Avoid format comparisons in workspace shell', context => {
        if (!hasRepoPathPrefix(toRepoPath(context.filename), 'app/modules/workspace-shell')) return {};
        const formatLiterals = new Set([
            'pdf',
            'native-pdf',
            'pdfjs',
            'djvu',
            'image',
        ]);
        const isLiteral = node => node?.type === 'Literal' && typeof node.value === 'string' && formatLiterals.has(node.value);
        const unwrap = node => {
            let current = node;
            while (current && [
                'ChainExpression',
                'TSAsExpression',
                'TSTypeAssertion',
                'TSNonNullExpression',
                'TSSatisfiesExpression',
            ].includes(current.type)) current = current.expression;
            return current;
        };
        const liveName = name => name === 'adapter' || name === 'document' || name === 'driver' || name === 'format' || name === 'sourceKind' || name === 'viewer'
            || /^(?:active|workspace)?(?:adapter|document|driver|viewer)(?:adapter|driver|viewer|id|type|kind|format|identifier|state)?$/iu.test(name)
            || /^(?:document|driver|viewer)(?:id|type|kind|format|identifier|state)$/iu.test(name);
        const memberNames = node => {
            const item = unwrap(node);
            if (item?.type === 'Identifier') return [item.name];
            if (item?.type !== 'MemberExpression') return [];
            const property = item.property.type === 'Identifier' ? item.property.name : item.property.value;
            return [
                ...memberNames(item.object),
                property,
            ].filter(Boolean);
        };
        const isDiscriminant = node => {
            const item = unwrap(node);
            return item?.type === 'Identifier' ? liveName(item.name)
                : item?.type === 'MemberExpression' && memberNames(item).some(liveName);
        };
        const text = node => context.sourceCode.getText(node);
        return {
            BinaryExpression(node) {
                if (![
                    '==',
                    '===',
                    '!=',
                    '!==',
                ].includes(node.operator)) return;
                const literal = isLiteral(node.left) ? node.left : isLiteral(node.right) ? node.right : null;
                const discriminant = literal === node.left ? node.right : node.left;
                if (literal && isDiscriminant(discriminant)) context.report({
                    node,
                    message: `Format comparison on ${text(discriminant)} uses "${literal.value}".`,
                });
            },
            SwitchStatement(node) {
                if (!isDiscriminant(node.discriminant)) return;
                for (const item of node.cases) if (isLiteral(item.test)) context.report({
                    node: item,
                    message: `Format switch case on ${text(node.discriminant)} uses "${item.test.value}".`,
                });
            },
        };
    }),
    'component-directory-source': makeArchitectureRule('Keep component directories limited to Vue SFCs', context => ({Program() {
        const fileName = toRepoPath(context.filename);
        if ([
            'app',
            'electron',
            'landing',
            'packages',
            'scripts',
            'server',
        ].some(root => hasRepoPathPrefix(fileName, root))
            && fileName.split('/').includes('components') && !fileName.endsWith('.vue')
            && !/\.d\.(?:ts|mts|cts)$/u.test(fileName)) context.report({
            node: context.sourceCode.ast,
            message: 'Component directories must contain Vue SFCs only; move helpers, state, and schedulers into feature modules.',
        });
    }})),
    'top-level-pdf-composable': makeArchitectureRule('Keep PDF composables in feature modules', context => ({Program() {
        const fileName = toRepoPath(context.filename);
        if (fileName.startsWith('app/composables/usePdf') && fileName.endsWith('.ts')
            && !fileName.endsWith('.d.ts') && fileName !== 'app/composables/usePdfFile.ts') context.report({
            node: context.sourceCode.ast,
            message: 'Top-level app/composables/usePdf*.ts files are blocked; keep PDF composables in feature modules.',
        });
    }})),
};

export default {rules: {
    ...architectureRules,
    'no-core-correctness-timers': {
        meta: {
            type: 'problem',
            docs: {
                description: 'Disallow correctness timers in the new viewer core',
                recommended: true,
            },
            schema: [],
        },
        create(context) {
            const repoPath = toRepoPath(context.physicalFilename ?? context.filename);
            const guarded = [
                'app/modules/document-viewer/viewport/',
                'app/modules/pdf-viewer/runtime/page-slots/',
                'app/modules/pdf-viewer/runtime/viewport/',
            ].some(root => repoPath.startsWith(root));
            if (!guarded) {
                return {};
            }

            const timers = new Set(['setTimeout', 'setInterval']);
            const timerGlobals = new Set(['window', 'globalThis', 'self']);
            return {CallExpression(node) {
                const {callee} = node;
                const isBareTimer = callee.type === 'Identifier' && timers.has(callee.name);
                const isGlobalTimer = callee.type === 'MemberExpression'
                    && !callee.computed
                    && callee.object.type === 'Identifier'
                    && timerGlobals.has(callee.object.name)
                    && callee.property.type === 'Identifier'
                    && timers.has(callee.property.name);
                if (isBareTimer || isGlobalTimer) {
                    context.report({
                        node,
                        message: 'New viewer-core coordination must use abortable state/epochs, not correctness timers.',
                    });
                }
            }};
        },
    },
    'no-raw-red-presentation': noRawRedPresentationRule,
    'e2e-click-as-user': e2eClickAsUserRule,
}};
