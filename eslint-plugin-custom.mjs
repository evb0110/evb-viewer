import path from 'node:path';

const APPROVED_TYPESCRIPT_DOT_SUFFIXES = new Set([
    'client',
    'config',
    'constants',
    'd',
    'e2e',
    'get',
    'modelPrep',
    'post',
    'service',
    'test',
    'ts',
    'txt',
    'types',
    'worker',
    'xml',
]);
const FILE_NAMING_ROOTS = new Set([
    'app',
    'electron',
    'landing',
    'packages',
    'scripts',
    'server',
    'tests',
]);
const FILE_NAMING_IGNORED_EXPORT_STEMS = new Set([
    'analyticsAdmission',
    'contract',
    'contracts',
    'eslint.config',
    'index',
    'nuxt.config',
    'pdfDiagnosticsEngine',
    'playwright.config',
    'public',
    'tailwind.config',
    'vitest.config',
    'workspaceDocumentController',
]);
const ROUTE_DIRECTORY_NAMES = new Set([
    'layouts',
    'middleware',
    'pages',
    'routes',
]);
const TYPESCRIPT_FILE_PATTERN = /\.[cm]?tsx?$/u;
const LOWER_KEBAB_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const CAMEL_PATTERN = /^[a-z][a-z0-9]*(?:[A-Z][a-z0-9]*)*$/u;
const PASCAL_PATTERN = /^[A-Z][A-Za-z0-9]*$/u;

function toRepoPath(filePath) {
    return path.relative(process.cwd(), filePath).split(path.sep).join('/');
}

const INTERNAL_MOCK_ALIAS_ROOTS = new Map([
    [
        'app',
        ['@app'],
    ],
    [
        'electron',
        ['@electron'],
    ],
    [
        'server',
        ['@server'],
    ],
    [
        'packages',
        [
            '@contracts',
            '@pdf-core',
            '@electron-worker-bundles',
            '@scan-cleanup-core',
            '@scan-cleanup-adapters',
            '@i18n-core',
            '@i18n-app',
            '@releaseSelection',
        ],
    ],
]);

const INTERNAL_MOCK_BOUNDARY_PATTERNS = [
    /^@electron\/(?:file-access|native|platform-ipc)\//u,
    /^@electron\/utils\/(?:native|runElectronCommand|processTree)/u,
    /^@electron\/(?:ocr\/worker|features\/ocr\/worker)\/runOcrCommand$/u,
    /^@electron\/pdf\/pdfPageCount$/u,
    /^@electron\/features\/[^/]+\/(?:native|public)(?:\/|$)/u,
    /^@app\/platform(?:\/|$)/u,
    /^@app\/(?:composables\/useSettings|composables\/useTypedI18n)$/u,
    /^@app\/modules\/pdf-viewer\/components\/PdfAnnotation(?:CommentsList|StyleEditor|Toolbar)\.vue$/u,
    /^@app\/modules\/workspace-shell\/composables\/nativePdfMutationArtifact$/u,
    /^@app\/modules\/workspace-shell\/splits\/cleanupSplitPayloadSnapshot$/u,
    /^@app\/utils\/(?:platformDocuments|performanceProfile|platformWindowTabs)$/u,
];

const REMOVED_PACKAGE_ALIAS_PREFIXES = [
    '@evb/contracts',
    '@evb/pdf-core',
    '@evb/electron-worker-bundles',
    '@evb/i18n-core',
    '@evb/i18n-app',
    '@evb/releaseSelection',
];

function isRemovedPackageAlias(value) {
    return value === '@contracts'
        || value === '@contracts/index'
        || REMOVED_PACKAGE_ALIAS_PREFIXES.some(prefix => (
            value === prefix || value.startsWith(`${prefix}/`)
        ));
}

const noRemovedPackageAliasesRule = {
    meta: {
        type: 'problem',
        docs: {
            description: 'Reject removed package aliases and the contracts barrel import',
            recommended: true,
        },
        schema: [],
    },
    create(context) {
        function reportSource(source) {
            const value = getLiteralValue(source);
            if (!value || !isRemovedPackageAlias(value)) {
                return;
            }
            context.report({
                node: source,
                message: `Use a canonical package subpath instead of removed alias "${value}".`,
            });
        }

        return {
            ImportDeclaration(node) {
                reportSource(node.source);
            },
            ExportNamedDeclaration(node) {
                reportSource(node.source);
            },
            ExportAllDeclaration(node) {
                reportSource(node.source);
            },
            ImportExpression(node) {
                reportSource(node.source);
            },
            TSImportType(node) {
                reportSource(node.source ?? node.argument);
            },
        };
    },
};

export function getInternalMockAllowlistGrowth(allowlist, baseline) {
    const growth = [];
    const baselineEntries = baseline instanceof Map ? baseline.entries() : Object.entries(baseline);
    const baselineCounts = new Map(baselineEntries);
    for (const [
        file,
        count,
    ] of Object.entries(allowlist)) {
        const baselineCount = baselineCounts.get(file);
        if (baselineCount === undefined) {
            growth.push(`new file ${file} (${count})`);
        } else if (count > baselineCount) {
            growth.push(`${file} increased from ${baselineCount} to ${count}`);
        }
    }
    return growth;
}

function getTestLayer(repoPath) {
    return /^tests\/unit\/([^/]+)\//u.exec(repoPath)?.[1] ?? null;
}

function getInternalMockTargetLayer(source) {
    for (const [
        layer,
        aliases,
    ] of INTERNAL_MOCK_ALIAS_ROOTS) {
        if (aliases.some(alias => source === alias || source.startsWith(`${alias}/`))) {
            return layer;
        }
    }
    return null;
}

function isApprovedInternalMockBoundary(source) {
    return INTERNAL_MOCK_BOUNDARY_PATTERNS.some(pattern => pattern.test(source));
}

function isInternalMockForTest(source, repoPath) {
    const layer = getTestLayer(repoPath);
    return layer !== null
        && getInternalMockTargetLayer(source) === layer
        && !isApprovedInternalMockBoundary(source);
}

const reportedAllowlistGrowth = new WeakSet();

const noInternalTestMocksRule = {
    meta: {
        type: 'problem',
        docs: {
            description: 'Reject same-layer business-module mocks in unit tests',
            recommended: false,
        },
        schema: [{
            type: 'object',
            properties: {
                allowlist: {
                    type: 'object',
                    additionalProperties: {
                        type: 'integer',
                        minimum: 0,
                    },
                },
                baseline: {type: 'object'},
            },
            additionalProperties: false,
        }],
    },
    create(context) {
        const repoPath = toRepoPath(context.physicalFilename ?? context.filename);
        if (!repoPath.startsWith('tests/unit/')) {
            return {};
        }

        const allowlist = context.options[0]?.allowlist ?? {};
        const baseline = context.options[0]?.baseline;
        const allowlistGrowth = baseline
            ? getInternalMockAllowlistGrowth(allowlist, baseline)
            : [];
        const allowlistGrowthReport = allowlistGrowth.length > 0
            && !reportedAllowlistGrowth.has(allowlist);
        if (allowlistGrowthReport) {
            reportedAllowlistGrowth.add(allowlist);
        }
        const allowedCount = allowlist[repoPath] ?? 0;
        let violationCount = 0;
        const importedSources = new Map();

        function report(node) {
            violationCount += 1;
            if (repoPath in allowlist && violationCount > allowedCount) {
                context.report({
                    node,
                    message: 'Do not mock same-layer internal business modules. Use a fixture or mock the process/platform boundary instead.',
                });
            }
        }

        return {
            ImportDeclaration(node) {
                const source = getLiteralValue(node.source);
                if (!source || !isInternalMockForTest(source, repoPath)) {
                    return;
                }
                for (const specifier of node.specifiers) importedSources.set(specifier.local.name, source);
            },
            CallExpression(node) {
                const callee = node.callee;
                if (callee?.type !== 'MemberExpression' || callee.computed
                    || callee.object?.type !== 'Identifier' || callee.object.name !== 'vi'
                    || callee.property?.type !== 'Identifier') {
                    return;
                }
                if (callee.property.name === 'mock' || callee.property.name === 'doMock') {
                    const source = getLiteralValue(node.arguments[0]);
                    if (source && isInternalMockForTest(source, repoPath)) report(node);
                } else if (callee.property.name === 'spyOn') {
                    const source = node.arguments[0]?.type === 'Identifier'
                        ? importedSources.get(node.arguments[0].name) : null;
                    if (source && isInternalMockForTest(source, repoPath)) report(node);
                }
            },
            'Program:exit'() {
                if (allowlistGrowthReport) {
                    context.report({
                        node: context.sourceCode.ast,
                        message: `The internal-mock allowlist may only shrink: ${allowlistGrowth.join('; ')}.`,
                    });
                }
                if (violationCount > 0 && !(repoPath in allowlist)) {
                    context.report({
                        loc: {
                            line: 1,
                            column: 0,
                        },
                        message: `Review ${violationCount} same-layer internal mock(s) in ${repoPath} before adding this file to the allowlist.`,
                    });
                }
            },
        };
    },
};

function stripTypeScriptSuffixes(fileName) {
    let stem = fileName.replace(/(?:\.d)?\.[cm]?tsx?$/u, '');
    const parts = stem.split('.');
    while (parts.length > 1 && APPROVED_TYPESCRIPT_DOT_SUFFIXES.has(parts.at(-1))) {
        parts.pop();
    }
    stem = parts.join('.');
    return stem;
}

function isInsideRouteDirectory(repoPath) {
    return repoPath.split('/').some(part => ROUTE_DIRECTORY_NAMES.has(part));
}

function getFileNamingMessages(repoPath) {
    const parts = repoPath.split('/');
    if (!FILE_NAMING_ROOTS.has(parts[0])) {
        return [];
    }

    const messages = parts.slice(1, -1)
        .filter(part => !LOWER_KEBAB_PATTERN.test(part))
        .map(part => `Directory "${part}" must use lower kebab-case.`);
    const fileName = parts.at(-1) ?? '';

    if (TYPESCRIPT_FILE_PATTERN.test(fileName) && !CAMEL_PATTERN.test(stripTypeScriptSuffixes(fileName))) {
        messages.push('TypeScript filenames must be camelCase, with only approved dot suffixes.');
    }

    if (fileName.endsWith('.vue') && fileName !== 'app.vue' && fileName !== 'error.vue') {
        const stem = fileName.slice(0, -'.vue'.length);
        const valid = isInsideRouteDirectory(repoPath)
            ? LOWER_KEBAB_PATTERN.test(stem) || CAMEL_PATTERN.test(stem)
            : PASCAL_PATTERN.test(stem);
        if (!valid) {
            messages.push('Vue components must be PascalCase; Nuxt route files may be lower kebab-case.');
        }
    }

    return messages;
}

function collectExportedSymbols(program) {
    const symbols = [];

    function add(name, kind, isValue) {
        if (name) {
            symbols.push({
                name,
                kind,
                isValue,
            });
        }
    }

    for (const statement of program.body) {
        if (statement.type !== 'ExportNamedDeclaration' || !statement.declaration) {
            continue;
        }

        const declaration = statement.declaration;
        switch (declaration.type) {
            case 'FunctionDeclaration':
                add(declaration.id?.name, 'function', true);
                break;
            case 'ClassDeclaration':
                add(declaration.id?.name, 'class', true);
                break;
            case 'TSInterfaceDeclaration':
                add(declaration.id?.name, 'interface', false);
                break;
            case 'TSTypeAliasDeclaration':
                add(declaration.id?.name, 'type', false);
                break;
            case 'TSEnumDeclaration':
                add(declaration.id?.name, 'enum', true);
                break;
            case 'VariableDeclaration':
                for (const item of declaration.declarations) {
                    if (item.id.type === 'Identifier') {
                        add(item.id.name, declaration.kind, true);
                    }
                }
                break;
        }
    }

    return symbols;
}

function normalizeExportName(symbol) {
    let name = symbol.name;
    if ((symbol.kind === 'interface' || symbol.kind === 'type') && /^[IT][A-Z]/u.test(name)) {
        name = name.slice(1);
    }
    if (/^[A-Z0-9_]+$/u.test(name) && name.includes('_')) {
        return name
            .toLowerCase()
            .split('_')
            .filter(Boolean)
            .map((part, index) => index === 0 ? part : part[0].toUpperCase() + part.slice(1))
            .join('');
    }

    const normalized = name.replace(
        /[A-Z]+(?=[A-Z][a-z]|$)/gu,
        word => word[0] + word.slice(1).toLowerCase(),
    );
    return normalized.charAt(0).toLowerCase() + normalized.slice(1);
}

function getMainExportNamingMessage(program, repoPath) {
    const fileName = repoPath.split('/').at(-1) ?? '';
    if (
        !TYPESCRIPT_FILE_PATTERN.test(fileName)
        || fileName.endsWith('.d.ts')
        || isInsideRouteDirectory(repoPath)
        || FILE_NAMING_IGNORED_EXPORT_STEMS.has(stripTypeScriptSuffixes(fileName))
        || !CAMEL_PATTERN.test(stripTypeScriptSuffixes(fileName))
    ) {
        return null;
    }

    const symbols = collectExportedSymbols(program);
    const values = symbols.filter(symbol => symbol.isValue);
    const types = symbols.filter(symbol => !symbol.isValue);
    const mainExport = symbols.length === 1
        ? symbols[0]
        : values.length === 1
            && types.length <= 2
            && !repoPath.includes('/types/')
            && !repoPath.includes('packages/contracts/')
            ? values[0]
            : null;
    if (!mainExport) {
        return null;
    }

    const expectedStem = normalizeExportName(mainExport);
    if (stripTypeScriptSuffixes(fileName) === expectedStem) {
        return null;
    }

    return `Filename must match its single/main export "${mainExport.name}" (expected stem "${expectedStem}").`;
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

function escapeForQuote(value, quote) {
    const escapedBackslash = value.replace(/\\/g, '\\\\');
    if (quote === '`') {
        return escapedBackslash.replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
    }
    return escapedBackslash.replace(new RegExp(quote, 'g'), `\\${quote}`);
}

function visitObjectLiteralKeys(node, visitor) {
    if (node.type !== 'ObjectExpression') {
        return;
    }

    for (const prop of node.properties || []) {
        const key = prop?.key;
        if (key?.type === 'Literal' && typeof key.value === 'string' && !prop.computed) {
            visitor(key);
        }
    }
}

function walkExpressionChild(value, visitor, seen) {
    if (Array.isArray(value)) {
        for (const child of value) {
            walkExpression(child, visitor, seen);
        }
        return;
    }

    if (value && typeof value === 'object' && value.type) {
        walkExpression(value, visitor, seen);
    }
}

function walkExpression(node, visitor, seen) {
    if (!node || typeof node !== 'object') {
        return;
    }
    if (seen.has(node)) {
        return;
    }
    seen.add(node);

    visitor(node);
    visitObjectLiteralKeys(node, visitor);

    for (const key of Object.keys(node)) {
        if (key === 'parent') {
            continue;
        }
        walkExpressionChild(node[key], visitor, seen);
    }
}

function getTemplateBodyServices(context) {
    const parserServices = context.parserServices || context.sourceCode?.parserServices;
    if (!parserServices || !parserServices.defineTemplateBodyVisitor) {
        return null;
    }
    const sourceCode = context.sourceCode ?? context.getSourceCode?.();
    return {
        parserServices,
        sourceCode,
    };
}

function createClassLiteralFix(sourceCode, node, replacementValue) {
    return (fixer) => {
        const raw = sourceCode.getText(node);
        const quote = raw[0];
        const escaped = escapeForQuote(replacementValue, quote);

        if (quote === '`') {
            return fixer.replaceText(node, `\`${escaped}\``);
        }
        if (quote === '"' || quote === '\'') {
            return fixer.replaceText(node, `${quote}${escaped}${quote}`);
        }
        return null;
    };
}

function createClassAttributeVisitor(analyze) {
    return {VAttribute(node) {
        const isClass =
            !node.directive
            && node.key?.type === 'VIdentifier'
            && node.key.name === 'class';

        const isBoundClass =
            node.directive
            && node.key?.name?.name === 'bind'
            && node.key.argument
            && node.key.argument.type === 'VIdentifier'
            && node.key.argument.name === 'class';

        if (isClass) {
            const literalValue = getLiteralValue(node.value);
            if (literalValue) {
                analyze(node.value, literalValue);
            }
            return;
        }

        if (isBoundClass && node.value && node.value.expression) {
            const seen = new Set();
            walkExpression(
                node.value.expression,
                (child) => {
                    const literalValue = getLiteralValue(child);
                    if (!literalValue) {
                        return;
                    }
                    analyze(child, literalValue);
                },
                seen,
            );
        }
    }};
}

function createThreeLineReturnBlockFix(sourceCode, node, returnNode) {
    return (fixer) => {
        const returnStmt = sourceCode.getText(returnNode);
        const indent = ' '.repeat(node.loc.start.column);
        const innerIndent = indent + '    ';
        const replacement = `{\n${innerIndent}${returnStmt}\n${indent}}`;
        return fixer.replaceText(node, replacement);
    };
}

function isRelativeImportSpecifier(value) {
    return value === '.'
        || value === '..'
        || value.startsWith('./')
        || value.startsWith('../');
}

function getLineIndent(sourceCode, node) {
    const line = sourceCode.lines[node.loc.start.line - 1] ?? '';
    return line.match(/^(\s*)/u)?.[1] ?? '';
}

function shouldEscapeTypeKeyCharacter(character) {
    const codePoint = character.codePointAt(0) ?? 0;
    return character === '\\'
        || character === '\''
        || codePoint <= 0x1F
        || codePoint === 0x7F
        || codePoint === 0x2028
        || codePoint === 0x2029;
}

function escapeTypeKeyCharacter(character) {
    switch (character) {
        case '\\':
            return '\\\\';
        case '\'':
            return '\\\'';
        case '\n':
            return '\\n';
        case '\r':
            return '\\r';
        case '\t':
            return '\\t';
        default: {
            const codePoint = character.codePointAt(0) ?? 0;
            return codePoint <= 0xFF
                ? `\\x${codePoint.toString(16).padStart(2, '0')}`
                : `\\u${codePoint.toString(16).padStart(4, '0')}`;
        }
    }
}

function formatPropertyKey(value) {
    if (/^[A-Za-z_$][\w$]*$/u.test(value)) {
        return value;
    }

    const escaped = Array.from(value, character => shouldEscapeTypeKeyCharacter(character)
        ? escapeTypeKeyCharacter(character)
        : character).join('');
    return `'${escaped}'`;
}

function getTypeParameterInstantiation(node) {
    return node.typeArguments ?? node.typeParameters ?? null;
}

function getStringLiteralTypeValue(node) {
    if (node?.type !== 'TSLiteralType') {
        return null;
    }

    const literal = node.literal;
    return typeof literal?.value === 'string'
        ? literal.value
        : null;
}

function getDefineEmitsEventName(param) {
    return getStringLiteralTypeValue(param?.typeAnnotation?.typeAnnotation);
}

function getDefineEmitsEventParam(member) {
    const [
        firstParam,
        secondParam,
    ] = member.params;
    return isThisParam(firstParam)
        ? secondParam
        : firstParam;
}

function hasVoidReturnType(member) {
    const returnType = member.returnType?.typeAnnotation;
    return returnType?.type === 'TSVoidKeyword';
}

function isFixableTupleParam(param) {
    if (param.type === 'Identifier') {
        return Boolean(param.typeAnnotation);
    }

    return param.type === 'RestElement'
        && param.argument?.type === 'Identifier'
        && Boolean(param.typeAnnotation);
}

function isReportableDefineEmitsSignature(member) {
    return member.type === 'TSCallSignatureDeclaration'
        && !member.typeParameters
        && member.params.length > 0
        && Boolean(getDefineEmitsEventName(getDefineEmitsEventParam(member)));
}

function isThisParam(param) {
    return param.type === 'Identifier' && param.name === 'this';
}

function isComposableFunctionDeclaration(node) {
    return node.type === 'FunctionDeclaration'
        && !node.declare
        && !node.generator
        && Boolean(node.body)
        && Boolean(node.id?.name?.startsWith('use'))
        && /^use[A-Z]/u.test(node.id.name);
}

function isComposableFunctionExpressionVariable(node) {
    return node.type === 'VariableDeclarator'
        && node.id?.type === 'Identifier'
        && /^use[A-Z]/u.test(node.id.name)
        && node.init?.type === 'FunctionExpression'
        && !node.init.generator;
}

function hasCommentsInside(sourceCode, node) {
    return sourceCode.getAllComments().some(comment => (
        comment.range[0] > node.range[0]
        && comment.range[1] < node.range[1]
    ));
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
        || repoPath === 'app/components/AppFailureAlert.vue'
        || repoPath === 'app/components/AppFatalRuntimeDialog.vue';
}

function isRawRedPresentationAttribute(attribute) {
    if (!attribute) {
        return false;
    }
    if (!attribute.directive) {
        return getStaticPropertyName(attribute) === 'color'
            && getLiteralValue(attribute.value) === 'error';
    }
    return attribute.key?.name?.name === 'bind'
        && attribute.key.argument?.type === 'VIdentifier'
        && attribute.key.argument.name === 'color'
        && getLiteralValue(attribute.value?.expression) === 'error';
}

function unwrapPresentationExpression(node) {
    if (
        node?.type === 'TSAsExpression'
        || node?.type === 'TSTypeAssertion'
        || node?.type === 'TSNonNullExpression'
        || node?.type === 'ChainExpression'
    ) {
        return unwrapPresentationExpression(node.expression);
    }
    return node;
}

function hasFailureProperty(node) {
    const expression = unwrapPresentationExpression(node);
    return expression?.type === 'ObjectExpression'
        && expression.properties.some(property => getStaticPropertyName(property) === 'failure');
}

function isNamedPresentationExpression(node) {
    const expression = unwrapPresentationExpression(node);
    return expression?.type === 'Identifier'
        && /presentation/iu.test(expression.name);
}

function isReceiptBearingPresentation(node) {
    return hasFailureProperty(node) || isNamedPresentationExpression(node);
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
        const templateServices = getTemplateBodyServices(context);
        if (!templateServices) {
            return visitors;
        }

        return {
            ...visitors,
            ...templateServices.parserServices.defineTemplateBodyVisitor({VElement(node) {
                const componentName = node.rawName ?? node.name;
                if (componentName !== 'UAlert' && componentName !== 'UToast') {
                    return;
                }
                const attribute = node.startTag.attributes.find(isRawRedPresentationAttribute);
                if (attribute) {
                    context.report({
                        node: attribute,
                        message: 'Route red failure presentation through the shared receipt-aware presenter.',
                    });
                }
            }}),
        };
    },
};

const noDirectConsoleErrorRule = {
    meta: {
        type: 'problem',
        docs: {
            description: 'Warn on direct application console.error calls outside the approved raw sinks',
            recommended: false,
        },
        schema: [],
    },
    create(context) {
        const repoPath = getSentryRepoPath(context);
        const exempt = new Set([
            'app/utils/browserLogger.ts',
            'app/utils/consoleErrorObserver.ts',
            'electron/preload/installDebugLogListener.ts',
        ]);
        if (!isApplicationSource(repoPath) || exempt.has(repoPath)) {
            return {};
        }

        return {CallExpression(node) {
            if (
                node.callee?.type === 'MemberExpression'
                    && !node.callee.computed
                    && node.callee.object?.type === 'Identifier'
                    && node.callee.object.name === 'console'
                    && node.callee.property?.type === 'Identifier'
                    && node.callee.property.name === 'error'
            ) {
                context.report({
                    node,
                    message: 'Use the approved diagnostic logger or observer instead of direct console.error.',
                });
            }
        }};
    },
};

const requireFailureReceiptRule = {
    meta: {
        type: 'problem',
        docs: {
            description: 'Warn when runtime or fatal failure presentation is not backed by a FailureReceipt',
            recommended: false,
        },
        schema: [],
    },
    create(context) {
        const repoPath = getSentryRepoPath(context);
        if (!isApplicationSource(repoPath)) {
            return {};
        }

        return {CallExpression(node) {
            if (node.callee?.type !== 'Identifier') {
                return;
            }
            const name = node.callee.name;
            if (name !== 'reportRuntimeError' && name !== 'setFatalRuntimeError') {
                return;
            }

            const presentation = name === 'reportRuntimeError'
                ? node.arguments[0]
                : node.arguments.length === 1
                    ? node.arguments[0]
                    : node.arguments[1];
            if (!isReceiptBearingPresentation(presentation)) {
                context.report({
                    node,
                    message: 'Runtime and fatal failure presentation requires a FailureReceipt.',
                });
            }
        }};
    },
};

function isUndefinedExpression(node) {
    const expression = unwrapPresentationExpression(node);
    return expression === undefined
        || expression?.type === 'Identifier' && expression.name === 'undefined'
        || expression?.type === 'Literal' && expression.value == null;
}

function hasClosedDiagnosticInput(node) {
    const expression = unwrapPresentationExpression(node);
    if (isUndefinedExpression(expression)) {
        return false;
    }
    if (expression?.type !== 'ObjectExpression') {
        return true;
    }
    return expression.properties.some(property => getStaticPropertyName(property) === 'code')
        && expression.properties.some(property => getStaticPropertyName(property) === 'context');
}

function isBrowserLoggerErrorCall(node) {
    return node.callee?.type === 'MemberExpression'
        && !node.callee.computed
        && node.callee.object?.type === 'Identifier'
        && node.callee.object.name === 'BrowserLogger'
        && node.callee.property?.type === 'Identifier'
        && node.callee.property.name === 'error';
}

function isMainLoggerErrorCall(node) {
    if (
        node.callee?.type !== 'MemberExpression'
        || node.callee.computed
        || node.callee.property?.type !== 'Identifier'
        || node.callee.property.name !== 'error'
    ) {
        return false;
    }
    const object = node.callee.object;
    if (
        object?.type === 'Identifier'
        && (
            object.name === 'log'
            || object.name === 'logger'
            || object.name.endsWith('Log')
            || object.name.endsWith('Logger')
        )
    ) {
        return true;
    }
    return object?.type === 'MemberExpression'
        && !object.computed
        && object.object?.type === 'Identifier'
        && object.object.name === 'options'
        && object.property?.type === 'Identifier'
        && object.property.name === 'logger';
}

const requireClassifiedErrorLogRule = {
    meta: {
        type: 'problem',
        docs: {
            description: 'Require application error log owners to supply a closed diagnostic code or existing receipt',
            recommended: false,
        },
        schema: [],
    },
    create(context) {
        const repoPath = getSentryRepoPath(context);
        if (!isApplicationSource(repoPath)) {
            return {};
        }
        return {CallExpression(node) {
            const diagnosticInput = isBrowserLoggerErrorCall(node)
                ? node.arguments[3]
                : isMainLoggerErrorCall(node)
                    ? node.arguments[1]
                    : null;
            if (diagnosticInput !== null && !hasClosedDiagnosticInput(diagnosticInput)) {
                context.report({
                    node,
                    message: 'Error logging requires a closed diagnostic code and context or an existing FailureReceipt.',
                });
            }
        }};
    },
};

const noUnclassifiedDiagnosticCodeRule = {
    meta: {
        type: 'problem',
        docs: {
            description: 'Disallow generic renderer or main diagnostic codes at application-owned capture sites',
            recommended: false,
        },
        schema: [],
    },
    create(context) {
        const repoPath = getSentryRepoPath(context);
        const defensiveDecoderRoots = new Set([
            'app/utils/browserLogger.ts',
            'app/utils/failureReporter.ts',
            'electron/features/diagnostics/mainFailureReporter.ts',
            'server/utils/serverFailureReporter.ts',
        ]);
        if (!isApplicationSource(repoPath) || defensiveDecoderRoots.has(repoPath)) {
            return {};
        }
        return {Literal(node) {
            if (
                node.value === 'UNCLASSIFIED_RENDERER_ERROR'
                || node.value === 'UNCLASSIFIED_MAIN_ERROR'
            ) {
                context.report({
                    node,
                    message: 'Application-owned failures require a subsystem-specific diagnostic code.',
                });
            }
        }};
    },
};

function containsBareTimestampPrimitive(node) {
    if (!node) {
        return false;
    }
    if (node.type === 'TSNumberKeyword' || node.type === 'TSStringKeyword') {
        return true;
    }
    return node.type === 'TSUnionType'
        && node.types.some(containsBareTimestampPrimitive);
}

const namedTimestampsRule = {
    meta: {
        type: 'problem',
        docs: {
            description: 'Require contract timestamp properties to use TEpochMs or TIsoTimestamp',
            recommended: false,
        },
        schema: [],
    },
    create(context) {
        const repoPath = getSentryRepoPath(context);
        if (!repoPath.startsWith('packages/contracts/')) {
            return {};
        }

        return {TSPropertySignature(node) {
            const name = getStaticPropertyName(node);
            const type = node.typeAnnotation?.typeAnnotation;
            if (name === 'insertAt' || !name?.endsWith('At') || !containsBareTimestampPrimitive(type)) {
                return;
            }
            context.report({
                node: node.typeAnnotation ?? node,
                message: `Timestamp property "${name}" must use TEpochMs or TIsoTimestamp.`,
            });
        }};
    },
};

const PAGE_ADDRESS_NAMES = new Set([
    'pageNumber',
    'pageIndex',
    'pageNumbers',
    'pageIndexes',
    'pageIndices',
]);

function getPageAddressTypeAnnotation(node) {
    if (node?.type === 'Identifier') {
        return node.typeAnnotation?.typeAnnotation ?? null;
    }
    if (node?.type === 'TSPropertySignature' || node?.type === 'PropertyDefinition') {
        return node.typeAnnotation?.typeAnnotation ?? null;
    }
    return null;
}

function getPageAddressName(node) {
    if (node?.type === 'Identifier') {
        return node.name;
    }
    if (node?.type === 'TSPropertySignature' || node?.type === 'PropertyDefinition') {
        return getStaticPropertyName(node);
    }
    return null;
}

function isBarePageAddressType(node) {
    if (!node) {
        return false;
    }
    if (node.type === 'TSNumberKeyword') {
        return true;
    }
    if (node.type === 'TSArrayType') {
        return node.elementType?.type === 'TSNumberKeyword';
    }
    if (node.type === 'TSTypeReference') {
        const typeName = node.typeName?.type === 'Identifier' ? node.typeName.name : null;
        const parameters = node.typeParameters?.params ?? node.typeArguments?.params ?? [];
        return typeName === 'Array'
            && parameters.length === 1
            && parameters[0]?.type === 'TSNumberKeyword';
    }
    return node.type === 'TSUnionType' && node.types.some(isBarePageAddressType);
}

const noBarePageNumberTypeRule = {
    meta: {
        type: 'problem',
        docs: {
            description: 'Require branded types for page-number and page-index declarations',
            recommended: false,
        },
        schema: [],
    },
    create(context) {
        function reportIfBare(node) {
            const name = getPageAddressName(node);
            const annotation = getPageAddressTypeAnnotation(node);
            if (!PAGE_ADDRESS_NAMES.has(name) || !isBarePageAddressType(annotation)) {
                return;
            }
            context.report({
                node: annotation,
                message: 'Use TPageNumber or TPageIndex instead of a bare number page address type.',
            });
        }

        return {
            Identifier: reportIfBare,
            TSPropertySignature: reportIfBare,
            PropertyDefinition: reportIfBare,
        };
    },
};

export default {rules: {
    'no-removed-package-aliases': noRemovedPackageAliasesRule,
    'no-internal-test-mocks': noInternalTestMocksRule,
    'no-raw-red-presentation': noRawRedPresentationRule,
    'no-direct-console-error': noDirectConsoleErrorRule,
    'require-failure-receipt': requireFailureReceiptRule,
    'require-classified-error-log': requireClassifiedErrorLogRule,
    'no-unclassified-diagnostic-code': noUnclassifiedDiagnosticCodeRule,
    'no-bare-page-number-type': noBarePageNumberTypeRule,
    'named-timestamps': namedTimestampsRule,
    'commonjs-named-imports': {
        meta: {
            type: 'problem',
            docs: {
                description: 'Disallow runtime named imports from guarded CommonJS packages',
                recommended: true,
            },
            schema: [],
        },
        create(context) {
            return {ImportDeclaration(node) {
                if (
                    node.source.value !== 'utif'
                    || node.importKind === 'type'
                ) {
                    return;
                }

                const importedNames = node.specifiers
                    .filter(specifier => specifier.type === 'ImportSpecifier' && specifier.importKind !== 'type')
                    .map(specifier => specifier.imported.name ?? specifier.imported.value);
                if (importedNames.length === 0) {
                    return;
                }

                context.report({
                    node,
                    message: `Import UTIF as the CommonJS default export; runtime named import(s) are unsafe: ${importedNames.join(', ')}.`,
                });
            }};
        },
    },
    'file-naming': {
        meta: {
            type: 'problem',
            docs: {
                description: 'Enforce repository directory, TypeScript, Vue, and main-export naming conventions',
                recommended: true,
            },
            schema: [],
        },
        create(context) {
            return {Program(node) {
                const filePath = context.physicalFilename ?? context.filename;
                if (!filePath || filePath.startsWith('<')) {
                    return;
                }

                const repoPath = toRepoPath(filePath);
                const messages = getFileNamingMessages(repoPath);
                const exportMessage = getMainExportNamingMessage(node, repoPath);
                if (exportMessage) {
                    messages.push(exportMessage);
                }

                for (const message of messages) {
                    context.report({
                        node,
                        message,
                    });
                }
            }};
        },
    },
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
                'app/utils/document-viewer/viewport/',
                'app/modules/pdf-viewer/runtime/page-slots/',
                'app/modules/pdf-viewer/runtime/viewport/',
            ].some(root => repoPath.startsWith(root));
            if (!guarded) {
                return {};
            }

            return {CallExpression(node) {
                if (
                    node.callee.type === 'Identifier'
                    && (
                        node.callee.name === 'setTimeout'
                        || node.callee.name === 'setInterval'
                    )
                ) {
                    context.report({
                        node,
                        message: 'New viewer-core coordination must use abortable state/epochs, not correctness timers.',
                    });
                }
            }};
        },
    },
    'no-relative-imports': {
        meta: {
            type: 'problem',
            docs: {
                description: 'Require absolute aliases instead of relative imports',
                recommended: true,
            },
            schema: [],
        },
        create(context) {
            function reportSource(source) {
                const value = getLiteralValue(source);
                if (!value || !isRelativeImportSpecifier(value)) {
                    return;
                }

                context.report({
                    node: source,
                    message: 'Use an absolute alias import instead of a relative import.',
                });
            }

            return {
                ImportDeclaration(node) {
                    reportSource(node.source);
                },
                ExportNamedDeclaration(node) {
                    reportSource(node.source);
                },
                ExportAllDeclaration(node) {
                    reportSource(node.source);
                },
                ImportExpression(node) {
                    reportSource(node.source);
                },
                CallExpression(node) {
                    if (node.callee?.type === 'Import') {
                        reportSource(node.arguments?.[0]);
                    }
                },
                TSImportType(node) {
                    reportSource(node.source ?? node.argument);
                },
            };
        },
    },
    'arrow-composable': {
        meta: {
            type: 'suggestion',
            docs: {
                description: 'Require exported composables to use arrow constants',
                recommended: true,
            },
            schema: [],
        },
        create(context) {
            const topLevelComposableFunctions = new Map();
            const topLevelComposableFunctionExpressions = new Map();
            const exportedComposableNames = new Set();

            function reportComposableNode(node) {
                context.report({
                    node: node.id,
                    message: 'Exported composables should use arrow constants.',
                });
            }

            return {
                FunctionDeclaration(node) {
                    const parent = node.parent;
                    if (
                        !isComposableFunctionDeclaration(node)
                        || (
                            parent?.type !== 'ExportNamedDeclaration'
                            && parent?.type !== 'ExportDefaultDeclaration'
                            && parent?.type !== 'Program'
                        )
                    ) {
                        return;
                    }

                    if (parent.type === 'Program') {
                        topLevelComposableFunctions.set(node.id.name, node);
                        return;
                    }

                    if (parent.type === 'ExportDefaultDeclaration') {
                        reportComposableNode(node);
                        return;
                    }

                    if (parent.declaration !== node) {
                        return;
                    }

                    reportComposableNode(node);
                },
                VariableDeclarator(node) {
                    if (!isComposableFunctionExpressionVariable(node)) {
                        return;
                    }

                    const variableDeclaration = node.parent;
                    const parent = variableDeclaration?.parent;
                    if (parent?.type === 'Program') {
                        topLevelComposableFunctionExpressions.set(node.id.name, node);
                        return;
                    }

                    if (parent?.type === 'ExportNamedDeclaration') {
                        reportComposableNode(node);
                    }
                },
                ExportNamedDeclaration(node) {
                    if (node.source || node.exportKind === 'type') {
                        return;
                    }

                    for (const specifier of node.specifiers) {
                        if (specifier.exportKind === 'type') {
                            continue;
                        }

                        const localName = specifier.local?.name;
                        if (localName && /^use[A-Z]/u.test(localName)) {
                            exportedComposableNames.add(localName);
                        }
                    }
                },
                ExportDefaultDeclaration(node) {
                    const localName = node.declaration?.type === 'Identifier'
                        ? node.declaration.name
                        : null;
                    if (localName && /^use[A-Z]/u.test(localName)) {
                        exportedComposableNames.add(localName);
                    }
                },
                'Program:exit'() {
                    for (const name of exportedComposableNames) {
                        const functionDeclaration = topLevelComposableFunctions.get(name);
                        if (functionDeclaration) {
                            reportComposableNode(functionDeclaration);
                        }

                        const functionExpression = topLevelComposableFunctionExpressions.get(name);
                        if (functionExpression) {
                            reportComposableNode(functionExpression);
                        }
                    }
                },
            };
        },
    },
    'vue-define-emits-tuple': {
        meta: {
            type: 'suggestion',
            docs: {
                description: 'Require tuple-style defineEmits type literals',
                recommended: true,
            },
            fixable: 'code',
            schema: [],
        },
        create(context) {
            const sourceCode = context.sourceCode;

            function convertMember(member, seenEventNames) {
                if (
                    member.type !== 'TSCallSignatureDeclaration'
                    || member.typeParameters
                    || member.params.length === 0
                    || !hasVoidReturnType(member)
                ) {
                    return null;
                }

                const eventParam = getDefineEmitsEventParam(member);
                const eventName = getDefineEmitsEventName(eventParam);
                if (
                    !eventName
                    || eventParam !== member.params[0]
                    || eventParam.optional
                    || seenEventNames.has(eventName)
                ) {
                    return null;
                }

                const tupleParams = member.params.slice(member.params.indexOf(eventParam) + 1);
                if (!tupleParams.every(isFixableTupleParam)) {
                    return null;
                }

                seenEventNames.add(eventName);
                const tupleText = tupleParams.length === 0
                    ? '[]'
                    : `[${tupleParams.map(param => sourceCode.getText(param)).join(', ')}]`;
                return `${formatPropertyKey(eventName)}: ${tupleText};`;
            }

            function convertTypeLiteral(typeLiteral) {
                if (
                    !typeLiteral
                    || typeLiteral.type !== 'TSTypeLiteral'
                    || typeLiteral.members.length === 0
                ) {
                    return null;
                }

                if (hasCommentsInside(sourceCode, typeLiteral)) {
                    return null;
                }

                const seenEventNames = new Set();
                const members = typeLiteral.members.map(member => convertMember(member, seenEventNames));
                if (members.some(member => member === null)) {
                    return null;
                }

                const multiline = typeLiteral.loc.start.line !== typeLiteral.loc.end.line || members.length > 1;
                if (!multiline) {
                    return `{${members[0]}}`;
                }

                const baseIndent = getLineIndent(sourceCode, typeLiteral);
                const innerIndent = `${baseIndent}    `;
                return `{\n${members.map(member => `${innerIndent}${member}`).join('\n')}\n${baseIndent}}`;
            }

            return {CallExpression(node) {
                if (node.callee?.type !== 'Identifier' || node.callee.name !== 'defineEmits') {
                    return;
                }

                const typeArguments = getTypeParameterInstantiation(node);
                const typeLiteral = typeArguments?.params?.[0];
                if (!typeLiteral || typeLiteral.type !== 'TSTypeLiteral') {
                    return;
                }

                const replacement = convertTypeLiteral(typeLiteral);
                if (replacement) {
                    context.report({
                        node: typeLiteral,
                        message: 'Use tuple-style defineEmits type literals.',
                        fix(fixer) {
                            return fixer.replaceText(typeLiteral, replacement);
                        },
                    });
                    return;
                }

                for (const member of typeLiteral.members) {
                    if (!isReportableDefineEmitsSignature(member)) {
                        continue;
                    }

                    context.report({
                        node: member,
                        message: 'Use tuple-style defineEmits type literals.',
                    });
                }
            }};
        },
    },
    'vue-boolean-prop-shorthand': {
        meta: {
            type: 'suggestion',
            docs: {
                description:
                        'Enforce boolean prop shorthand in Vue templates (e.g., is-draggable instead of :is-draggable="true")',
                recommended: true,
            },
            fixable: 'code',
            schema: [],
        },
        create(context) {
            const parserServices =
                context.parserServices ||
                    context.sourceCode?.parserServices;

            if (
                !parserServices ||
                    !parserServices.defineTemplateBodyVisitor
            ) {
                return {};
            }

            function getAttributeName(node) {
                if (!node.directive) {
                    return node.key.rawName;
                }

                if (
                    (node.key.name.name === 'bind' ||
                            node.key.name.name === 'model') &&
                        node.key.argument &&
                        node.key.argument.type === 'VIdentifier'
                ) {
                    return node.key.argument.rawName;
                }

                return null;
            }

            function shouldConvertToShortForm(node) {
                const isLiteralTrue =
                    node.directive &&
                        node.value?.expression?.type === 'Literal' &&
                        node.value.expression.value === true &&
                        Boolean(node.key.argument);

                return isLiteralTrue;
            }

            return parserServices.defineTemplateBodyVisitor({VAttribute(node) {
                const name = getAttributeName(node);
                if (name === null) {
                    return;
                }

                if (shouldConvertToShortForm(node)) {
                    const directiveKey = node.key;
                    if (
                        directiveKey.argument &&
                                directiveKey.argument.type === 'VIdentifier'
                    ) {
                        context.report({
                            node,
                            message: `Use shorthand '${directiveKey.argument.rawName}' instead of ':${directiveKey.argument.rawName}="true"'`,
                            fix(fixer) {
                                return fixer.replaceText(
                                    node,
                                    directiveKey.argument.rawName,
                                );
                            },
                        });
                    }
                }
            }});
        },
    },
    'brace-return-after-if': {
        meta: {
            type: 'layout',
            docs: {
                description:
                        'Require braces around return statements after if conditions',
                recommended: true,
            },
            fixable: 'code',
            schema: [],
        },
        create(context) {
            const sourceCode = context.sourceCode;

            return {IfStatement(node) {
                if (
                    node.consequent.type === 'ReturnStatement' ||
                            (node.consequent.type === 'BlockStatement' &&
                                node.consequent.body.length === 1 &&
                                node.consequent.body[0].type ===
                                    'ReturnStatement' &&
                                sourceCode.getText(node.consequent).split('\n')
                                    .length < 3)
                ) {
                    if (node.consequent.type === 'ReturnStatement') {
                        context.report({
                            node: node.consequent,
                            message:
                                        'Return statement after if condition must be wrapped in braces on 3 lines',
                            fix: createThreeLineReturnBlockFix(
                                sourceCode,
                                node.consequent,
                                node.consequent,
                            ),
                        });
                    } else if (
                        node.consequent.type === 'BlockStatement' &&
                                node.consequent.body.length === 1 &&
                                node.consequent.body[0].type ===
                                    'ReturnStatement'
                    ) {
                        const blockText = sourceCode.getText(
                            node.consequent,
                        );
                        const lines = blockText.split('\n');

                        if (lines.length < 3) {
                            context.report({
                                node: node.consequent,
                                message:
                                            'Return statement in braces after if condition must occupy exactly 3 lines',
                                fix: createThreeLineReturnBlockFix(
                                    sourceCode,
                                    node.consequent,
                                    node.consequent.body[0],
                                ),
                            });
                        }
                    }
                }
            }};
        },
    },
    'no-scss-ampersand-concatenation': {
        meta: {
            type: 'problem',
            docs: {
                description: 'Disallow SCSS ampersand concatenation (&- pattern) which is not CSS-compatible',
                recommended: true,
            },
            schema: [],
        },
        create(context) {
            const parserServices = context.parserServices || context.sourceCode?.parserServices;

            if (!parserServices || !parserServices.defineDocumentVisitor) {
                return {};
            }

            return parserServices.defineDocumentVisitor({'VElement[name="style"]'(node) {
                if (!node.children || node.children.length === 0) {
                    return;
                }

                const styleContent = node.children
                    .filter(child => child.type === 'VText')
                    .map(child => ({
                        text: child.value,
                        loc: child.loc,
                    }));

                for (const {
                    text,
                    loc,
                } of styleContent) {
                    const lines = text.split('\n');

                    for (let i = 0; i < lines.length; i++) {
                        const line = lines[i];
                        const regex = /&[-_]+(?![^{]*\{[^}]*:[^}]*\})/g;
                        let match;

                        while ((match = regex.exec(line)) !== null) {
                            const column = match.index;
                            context.report({
                                message: `Avoid SCSS ampersand concatenation '${match[0]}'. Use explicit class selectors instead (e.g., '.block--modifier' instead of '&--modifier')`,
                                loc: {
                                    start: {
                                        line: loc.start.line + i,
                                        column: i === 0 ? loc.start.column + column : column,
                                    },
                                    end: {
                                        line: loc.start.line + i,
                                        column: i === 0 ? loc.start.column + column + match[0].length : column + match[0].length,
                                    },
                                },
                            });
                        }
                    }
                }
            }});
        },
    },
    'nuxt-ui-semantic-utilities': {
        meta: {
            type: 'suggestion',
            docs: {
                description: 'Prefer Nuxt UI semantic utility classes over raw CSS variable utilities',
                recommended: true,
            },
            fixable: 'code',
            schema: [],
        },
        create(context) {
            const services = getTemplateBodyServices(context);
            if (!services) {
                return {};
            }
            const {
                parserServices,
                sourceCode,
            } = services;
            const replacements = [
                [
                    'text-(--ui-text-dimmed)',
                    'text-dimmed',
                ],
                [
                    'text-[color:var(--ui-text-dimmed)]',
                    'text-dimmed',
                ],
                [
                    'text-(--ui-text-muted)',
                    'text-muted',
                ],
                [
                    'text-[color:var(--ui-text-muted)]',
                    'text-muted',
                ],
                [
                    'text-(--ui-text-toned)',
                    'text-toned',
                ],
                [
                    'text-[color:var(--ui-text-toned)]',
                    'text-toned',
                ],
                [
                    'text-(--ui-text)',
                    'text-default',
                ],
                [
                    'text-[color:var(--ui-text)]',
                    'text-default',
                ],
                [
                    'text-(--ui-text-highlighted)',
                    'text-highlighted',
                ],
                [
                    'text-[color:var(--ui-text-highlighted)]',
                    'text-highlighted',
                ],
                [
                    'text-(--ui-text-inverted)',
                    'text-inverted',
                ],
                [
                    'text-[color:var(--ui-text-inverted)]',
                    'text-inverted',
                ],
                [
                    'bg-(--ui-bg)',
                    'bg-default',
                ],
                [
                    'bg-[color:var(--ui-bg)]',
                    'bg-default',
                ],
                [
                    'bg-(--ui-bg-muted)',
                    'bg-muted',
                ],
                [
                    'bg-[color:var(--ui-bg-muted)]',
                    'bg-muted',
                ],
                [
                    'bg-(--ui-bg-elevated)',
                    'bg-elevated',
                ],
                [
                    'bg-[color:var(--ui-bg-elevated)]',
                    'bg-elevated',
                ],
                [
                    'bg-(--ui-bg-accented)',
                    'bg-accented',
                ],
                [
                    'bg-[color:var(--ui-bg-accented)]',
                    'bg-accented',
                ],
                [
                    'bg-(--ui-bg-inverted)',
                    'bg-inverted',
                ],
                [
                    'bg-[color:var(--ui-bg-inverted)]',
                    'bg-inverted',
                ],
                [
                    'border-(--ui-border)',
                    'border-default',
                ],
                [
                    'border-[color:var(--ui-border)]',
                    'border-default',
                ],
                [
                    'border-(--ui-border-muted)',
                    'border-muted',
                ],
                [
                    'border-[color:var(--ui-border-muted)]',
                    'border-muted',
                ],
                [
                    'border-(--ui-border-accented)',
                    'border-accented',
                ],
                [
                    'border-[color:var(--ui-border-accented)]',
                    'border-accented',
                ],
                [
                    'border-(--ui-border-inverted)',
                    'border-inverted',
                ],
                [
                    'border-[color:var(--ui-border-inverted)]',
                    'border-inverted',
                ],
            ];

            function replaceTokens(value) {
                let next = value;
                const matches = [];

                for (const [
                    from,
                    to,
                ] of replacements) {
                    if (next.includes(from)) {
                        next = next.split(from).join(to);
                        matches.push([
                            from,
                            to,
                        ]);
                    }
                }

                if (matches.length === 0) {
                    return null;
                }

                return {
                    value: next,
                    matches,
                };
            }

            function reportLiteral(node, rawValue, result) {
                if (!result) {
                    return;
                }

                const message = result.matches
                    .map(([
                        from,
                        to,
                    ]) => `'${from}' -> '${to}'`)
                    .join(', ');

                context.report({
                    node,
                    message: `Use Nuxt UI semantic utilities: ${message}`,
                    fix: createClassLiteralFix(sourceCode, node, result.value),
                });
            }

            return parserServices.defineTemplateBodyVisitor(
                createClassAttributeVisitor((node, literalValue) => {
                    const result = replaceTokens(literalValue);
                    reportLiteral(node, literalValue, result);
                }),
            );
        },
    },
    'tailwind-class-shorthand': {
        meta: {
            type: 'suggestion',
            docs: {
                description: 'Enforce Tailwind utility consistency and layout-token usage',
                recommended: true,
            },
            fixable: 'code',
            schema: [],
        },
        create(context) {
            const services = getTemplateBodyServices(context);
            if (!services) {
                return {};
            }
            const {
                parserServices,
                sourceCode,
            } = services;

            const names = [
                'pt',
                'pb',
                'pl',
                'pr',
                'mt',
                'mb',
                'ml',
                'mr',
                'px',
                'py',
                'mx',
                'my',
                'p',
                'm',
                'gap-x',
                'gap-y',
                'gap',
                'space-x',
                'space-y',
                'space',
                'border-t',
                'border-b',
                'border-l',
                'border-r',
                'border-x',
                'border-y',
                'border',
            ];

            const spacingUtilities = new Set([
                'p',
                'px',
                'py',
                'pt',
                'pb',
                'pl',
                'pr',
                'm',
                'mx',
                'my',
                'mt',
                'mb',
                'ml',
                'mr',
                'gap',
                'gap-x',
                'gap-y',
                'space-x',
                'space-y',
                'space',
                'w',
                'h',
                'min-w',
                'max-w',
                'min-h',
                'max-h',
                'inset',
                'inset-x',
                'inset-y',
                'top',
                'right',
                'bottom',
                'left',
                'translate-x',
                'translate-y',
            ]);

            const borderWidthMap = new Map([
                [
                    0,
                    '0',
                ],
                [
                    1,
                    '',
                ],
                [
                    2,
                    '2',
                ],
                [
                    4,
                    '4',
                ],
                [
                    8,
                    '8',
                ],
            ]);

            function parseArbitraryToken(token) {
                const parts = token.split(':');
                let base = parts.pop();
                const prefix = parts.join(':');

                if (!base) {
                    return null;
                }

                let negative = false;
                if (base.startsWith('-')) {
                    negative = true;
                    base = base.slice(1);
                }

                const match = base.match(/^([a-z-]+)-\[(.+)\]$/);
                if (!match) {
                    return null;
                }

                return {
                    token,
                    prefix,
                    name: match[1],
                    negative,
                    value: match[2],
                };
            }

            function parseNumericValue(value) {
                if (!value) {
                    return null;
                }

                let nextValue = value.trim();
                let negative = false;

                if (nextValue.startsWith('-')) {
                    negative = true;
                    nextValue = nextValue.slice(1);
                }

                const match = nextValue.match(/^([0-9]*\.?[0-9]+)(px|rem)?$/);
                if (!match) {
                    return null;
                }

                return {
                    number: Number(match[1]),
                    unit: match[2] ?? null,
                    negative,
                };
            }

            function formatScale(value) {
                const rounded = Math.round(value * 1000) / 1000;
                const text = String(rounded);
                if (!text.includes('.')) {
                    return text;
                }
                return text.replace(/\.0+$/, '').replace(/(\.\d*[1-9])0+$/, '$1');
            }

            function convertSpacingValue(value) {
                const parsed = parseNumericValue(value);
                if (!parsed) {
                    return null;
                }

                const multiplier = parsed.unit === 'rem'
                    ? 4
                    : parsed.unit === 'px'
                        ? 1 / 4
                        : null;

                if (!multiplier) {
                    return null;
                }

                const scale = parsed.number * multiplier;
                return {
                    scale: formatScale(scale),
                    negative: parsed.negative,
                };
            }

            function convertBorderWidth(value) {
                const parsed = parseNumericValue(value);
                if (!parsed || parsed.unit === 'rem') {
                    return null;
                }

                const pxValue = parsed.unit === 'px' || parsed.unit === null
                    ? parsed.number
                    : null;

                if (pxValue === null) {
                    return null;
                }

                if (!borderWidthMap.has(pxValue)) {
                    return null;
                }

                return {
                    suffix: borderWidthMap.get(pxValue),
                    negative: parsed.negative,
                };
            }

            function convertArbitraryTokens(tokens) {
                const replacements = [];
                const next = tokens.map((token) => {
                    const parsed = parseArbitraryToken(token);
                    if (!parsed) {
                        return token;
                    }

                    if (spacingUtilities.has(parsed.name)) {
                        const converted = convertSpacingValue(parsed.value);
                        if (!converted) {
                            return token;
                        }

                        const negative = parsed.negative || converted.negative;
                        const replacement = buildToken(
                            parsed.prefix,
                            negative,
                            parsed.name,
                            converted.scale,
                        );
                        replacements.push(`'${token}' -> '${replacement}'`);
                        return replacement;
                    }

                    if (parsed.name.startsWith('border')) {
                        const converted = convertBorderWidth(parsed.value);
                        if (!converted) {
                            return token;
                        }

                        const replacement = buildToken(
                            parsed.prefix,
                            parsed.negative || converted.negative,
                            parsed.name,
                            converted.suffix || null,
                        );
                        replacements.push(`'${token}' -> '${replacement}'`);
                        return replacement;
                    }

                    return token;
                });

                return {
                    tokens: next,
                    replacements,
                };
            }

            function parseToken(token) {
                const parts = token.split(':');
                const base = parts.pop();
                const prefix = parts.join(':');

                if (!base) {
                    return null;
                }

                for (const name of names) {
                    if (base === name) {
                        return {
                            token,
                            prefix,
                            name,
                            negative: false,
                            value: null,
                        };
                    }

                    const regex = new RegExp(`^(-)?${name}-(.+)$`);
                    const match = base.match(regex);
                    if (match) {
                        return {
                            token,
                            prefix,
                            name,
                            negative: match[1] === '-',
                            value: match[2],
                        };
                    }
                }

                return null;
            }

            function buildToken(prefix, negative, name, value) {
                const base = value === null
                    ? `${negative ? '-' : ''}${name}`
                    : `${negative ? '-' : ''}${name}-${value}`;
                return prefix ? `${prefix}:${base}` : base;
            }

            function isBorderSizeValue(value) {
                if (value === null) {
                    return true;
                }
                if (value === 'px') {
                    return true;
                }
                if (/^\d+(\.\d+)?$/.test(value)) {
                    return true;
                }
                if (value.startsWith('[') && value.endsWith(']')) {
                    return /(\d|px|rem|em|%)\b/.test(value);
                }
                return false;
            }

            function findConflicts(tokens) {
                const seen = new Map();
                const conflicts = [];

                for (const token of tokens) {
                    const parsed = parseToken(token);
                    if (!parsed) {
                        continue;
                    }

                    if (parsed.name.startsWith('border') && !isBorderSizeValue(parsed.value)) {
                        continue;
                    }

                    const key = `${parsed.prefix}|${parsed.name}|${parsed.negative}`;
                    const valueKey = parsed.value === null ? 'DEFAULT' : parsed.value;

                    if (seen.has(key)) {
                        const existing = seen.get(key);
                        if (existing.value !== valueKey) {
                            conflicts.push({
                                name: parsed.name,
                                prefix: parsed.prefix,
                                values: [
                                    existing.value,
                                    valueKey,
                                ],
                                tokens: [
                                    existing.token,
                                    token,
                                ],
                            });
                        }
                        continue;
                    }

                    seen.set(key, {
                        value: valueKey,
                        token,
                    });
                }

                return conflicts;
            }

            function simplifyClassString(value) {
                const tokens = value.trim().split(/\s+/).filter(Boolean);
                const arbitrary = convertArbitraryTokens(tokens);
                const conflicts = findConflicts(arbitrary.tokens);
                const rawLayoutTokens = arbitrary.tokens.filter(token =>
                    /^(?:[a-z-]+:)*-?[a-z-]+-\[\s*-?\d[^\]\n]*\]$/u.test(token),
                );
                const replacements = arbitrary.replacements;
                const changed = replacements.length > 0;

                if (!changed && conflicts.length === 0 && rawLayoutTokens.length === 0) {
                    return null;
                }

                return {
                    value: arbitrary.tokens.join(' '),
                    replacements,
                    conflicts,
                    rawLayoutTokens,
                };
            }

            function reportLiteral(node, rawValue, result) {
                if (!result) {
                    return;
                }

                const parts = [];
                if (result.replacements.length > 0) {
                    parts.push(result.replacements.join(', '));
                }
                if (parts.length > 0) {
                    const message = parts.join('; ');

                    context.report({
                        node,
                        message,
                        fix: createClassLiteralFix(sourceCode, node, result.value),
                    });
                }

                if (result.conflicts && result.conflicts.length > 0) {
                    const conflictMessages = result.conflicts.map((conflict) => {
                        const label = conflict.prefix
                            ? `${conflict.prefix}:${conflict.name}`
                            : conflict.name;
                        return `${label} -> ${conflict.tokens.join(' vs ')}`;
                    });

                    context.report({
                        node,
                        message: `Conflicting Tailwind utilities: ${conflictMessages.join('; ')}`,
                    });
                }

                if (result.rawLayoutTokens.length > 0) {
                    context.report({
                        node,
                        message: `Use layout tokens instead of arbitrary numeric Tailwind utilities: ${result.rawLayoutTokens.join(', ')}`,
                    });
                }
            }

            return parserServices.defineTemplateBodyVisitor(
                createClassAttributeVisitor((node, literalValue) => {
                    const result = simplifyClassString(literalValue);
                    reportLiteral(node, literalValue, result);
                }),
            );
        },
    },
    'app-tooltip-only': {
        meta: {
            type: 'problem',
            docs: {
                description: 'Require AppTooltip instead of raw UTooltip or native title tooltips',
                recommended: true,
            },
            schema: [],
        },
        create(context) {
            const services = getTemplateBodyServices(context);
            if (!services) {
                return {};
            }

            function getElementName(node) {
                return node.rawName ?? node.name;
            }

            function isNativeHtmlElementName(name) {
                return typeof name === 'string' && /^[a-z][\d_a-z-]*$/u.test(name);
            }

            return services.parserServices.defineTemplateBodyVisitor({
                VElement(node) {
                    if (getElementName(node) === 'UTooltip') {
                        context.report({
                            node: node.startTag,
                            message: 'Use AppTooltip instead of UTooltip so tooltip usefulness is centralized.',
                        });
                    }
                },
                VAttribute(node) {
                    const parentElement = node.parent?.parent;
                    const parentName = parentElement ? getElementName(parentElement) : null;
                    const argumentName = node.key?.argument?.type === 'VIdentifier'
                        ? node.key.argument.name
                        : null;
                    const attributeName = node.directive
                        ? argumentName
                        : node.key?.name;

                    if (
                        attributeName === 'title'
                        && isNativeHtmlElementName(parentName)
                    ) {
                        context.report({
                            node,
                            message: 'Do not use native title tooltips. Use AppTooltip for useful tooltips, or aria-label for accessibility-only labels.',
                        });
                    }
                },
            });
        },
    },
}};
