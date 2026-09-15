import * as tsParser from '@typescript-eslint/parser';
import * as vueParser from 'vue-eslint-parser';

const FORMAT_LITERALS = Object.freeze([
    'pdf',
    'native-pdf',
    'pdfjs',
    'djvu',
    'image',
]);

const BINARY_COMPARISON_OPERATORS = Object.freeze([
    '==',
    '===',
    '!=',
    '!==',
]);

/**
 * @typedef {'==' | '===' | '!=' | '!==' | 'switch-case' | 'parse-error'} TFormatComparisonKind
 * @typedef {object} IFormatComparisonViolation
 * @property {string} sourcePath
 * @property {number} line
 * @property {number} column
 * @property {TFormatComparisonKind} comparisonKind
 * @property {string | null} discriminant
 * @property {string | null} formatLiteral
 * @property {string} message
 * @typedef {object} IFormatComparisonCheckOptions
 * @property {readonly string[]} [allowedPaths]
 * @typedef {{type: string, range: [number, number], [key: string]: any}} TAstNode
 */

/** @param {TAstNode | null | undefined} node @returns {boolean} */
const isFormatLiteral = node => (
    node?.type === 'Literal'
    && typeof node.value === 'string'
    && FORMAT_LITERALS.includes(node.value)
);

/** @param {TAstNode | null | undefined} node @returns {TAstNode | null | undefined} */
const unwrapExpression = node => {
    let expression = node;
    while (
        expression
        && [
            'ChainExpression',
            'TSAsExpression',
            'TSTypeAssertion',
            'TSNonNullExpression',
            'TSSatisfiesExpression',
        ].includes(expression.type)
    ) {
        expression = expression.expression;
    }
    return expression;
};

/** @param {string} name */
const isLiveDiscriminantName = name => (
    name === 'adapter'
    || name === 'document'
    || name === 'driver'
    || name === 'format'
    || name === 'sourceKind'
    || name === 'viewer'
    || /^(?:active|workspace)?(?:adapter|document|driver|viewer)(?:adapter|driver|viewer|id|type|kind|format|identifier|state)?$/i.test(name)
    || /^(?:document|driver|viewer)(?:id|type|kind|format|identifier|state)$/i.test(name)
);

/** @param {TAstNode | null | undefined} node @returns {string | null} */
const propertyName = node => {
    if (node?.type === 'Identifier') {
        return node.name;
    }
    if (node?.type === 'Literal' && typeof node.value === 'string') {
        return node.value;
    }
    return null;
};

/** @param {TAstNode | null | undefined} node @returns {string[]} */
const collectMemberNames = node => {
    const expression = unwrapExpression(node);
    if (!expression) {
        return [];
    }
    if (expression.type === 'Identifier') {
        return [expression.name];
    }
    if (expression.type !== 'MemberExpression') {
        return [];
    }
    return [
        ...collectMemberNames(expression.object),
        propertyName(expression.property),
    ].filter(name => name !== null);
};

/** @param {TAstNode | null | undefined} node @returns {TAstNode | null} */
const getDiscriminant = node => {
    const expression = unwrapExpression(node);
    if (!expression) {
        return null;
    }
    if (expression.type === 'Identifier') {
        return isLiveDiscriminantName(expression.name) ? expression : null;
    }
    if (expression.type !== 'MemberExpression') {
        return null;
    }
    return collectMemberNames(expression).some(isLiveDiscriminantName)
        ? node ?? null
        : null;
};

/** @param {string} sourceText @param {TAstNode | null} node */
const getNodeText = (sourceText, node) => (
    node?.range ? sourceText.slice(node.range[0], node.range[1]) : null
);

/** @param {string} sourceText @param {number} offset */
const getLocation = (sourceText, offset) => {
    const before = sourceText.slice(0, offset);
    const lineStart = before.lastIndexOf('\n') + 1;
    return {
        line: before.split('\n').length,
        column: offset - lineStart + 1,
    };
};

/** @param {string} sourcePath */
const normalizeSourcePath = sourcePath => sourcePath.replaceAll('\\', '/').replace(/^\.\//, '');

/**
 * @param {string} sourcePath @param {string} sourceText @param {TAstNode} node
 * @param {Pick<IFormatComparisonViolation, 'comparisonKind' | 'discriminant' | 'formatLiteral' | 'message'>} details
 * @returns {IFormatComparisonViolation}
 */
const createViolation = (sourcePath, sourceText, node, details) => {
    const location = getLocation(sourceText, node.range[0]);
    return {
        sourcePath: normalizeSourcePath(sourcePath),
        ...location,
        ...details,
    };
};

/** @param {unknown} node @param {(node: TAstNode) => void} visit */
const walk = (node, visit) => {
    if (!node || typeof node !== 'object') {
        return;
    }
    visit(/** @type {TAstNode} */ (node));
    for (const [
        key,
        value,
    ] of Object.entries(node)) {
        if (key === 'parent' || key === 'loc' || key === 'range' || key === 'tokens' || key === 'comments') {
            continue;
        }
        if (Array.isArray(value)) {
            value.forEach(child => walk(child, visit));
        } else {
            walk(value, visit);
        }
    }
};

/** @param {string} sourcePath @param {string} sourceText @returns {TAstNode} */
const parseSource = (sourcePath, sourceText) => {
    const options = {
        comment: false,
        ecmaVersion: /** @type {const} */ ('latest'),
        filePath: sourcePath,
        jsx: true,
        loc: true,
        range: true,
        sourceType: /** @type {const} */ ('module'),
    };
    return sourcePath.toLowerCase().endsWith('.vue')
        ? vueParser.parseForESLint(sourceText, {
            ...options,
            parser: tsParser,
        }).ast
        : tsParser.parseForESLint(sourceText, options).ast;
};

/** @param {string} sourcePath @param {string} sourceText @param {{lineNumber?: number, column?: number, message?: string}} error @returns {IFormatComparisonViolation} */
const createParseError = (sourcePath, sourceText, error) => {
    const line = error.lineNumber ?? 1;
    const column = error.column ?? 1;
    const lineStart = sourceText.split('\n').slice(0, line - 1).reduce(
        (offset, lineText) => offset + lineText.length + 1,
        0,
    );
    const location = getLocation(sourceText, lineStart + Math.max(column - 1, 0));
    return {
        sourcePath: normalizeSourcePath(sourcePath),
        ...location,
        comparisonKind: 'parse-error',
        discriminant: null,
        formatLiteral: null,
        message: `Unable to parse ${normalizeSourcePath(sourcePath)}: ${error.message}`,
    };
};

/** @param {string} sourcePath @param {readonly string[] | undefined} allowedPaths */
const isAllowedPath = (sourcePath, allowedPaths) => {
    const normalizedPath = normalizeSourcePath(sourcePath);
    return (allowedPaths ?? []).map(normalizeSourcePath).includes(normalizedPath);
};

/**
 * Finds format-dependent comparisons in one repository-relative source file.
 * The caller controls the file set by calling this function per file.
 *
 * @param {string} sourcePath
 * @param {string} sourceText
 * @param {IFormatComparisonCheckOptions} [options]
 * @returns {IFormatComparisonViolation[]}
 */
export const findFormatComparisonViolations = (sourcePath, sourceText, options = {}) => {
    let ast;
    try {
        ast = parseSource(sourcePath, sourceText);
    } catch (error) {
        return [createParseError(sourcePath, sourceText, /** @type {Error & {lineNumber?: number, column?: number}} */ (error))];
    }

    if (isAllowedPath(sourcePath, options.allowedPaths)) {
        return [];
    }

    /** @type {IFormatComparisonViolation[]} */
    const violations = [];
    walk(ast, node => {
        if (node.type === 'BinaryExpression' && BINARY_COMPARISON_OPERATORS.includes(node.operator)) {
            const leftIsLiteral = isFormatLiteral(node.left);
            const rightIsLiteral = isFormatLiteral(node.right);
            const discriminant = leftIsLiteral
                ? getDiscriminant(node.right)
                : rightIsLiteral
                    ? getDiscriminant(node.left)
                    : null;
            const literal = leftIsLiteral ? node.left : rightIsLiteral ? node.right : null;
            if (discriminant && literal) {
                violations.push(createViolation(sourcePath, sourceText, node, {
                    comparisonKind: node.operator,
                    discriminant: getNodeText(sourceText, discriminant),
                    formatLiteral: literal.value,
                    message: `Format comparison on ${getNodeText(sourceText, discriminant)} uses "${literal.value}".`,
                }));
            }
        }

        if (node.type === 'SwitchStatement' && getDiscriminant(node.discriminant)) {
            const discriminant = getDiscriminant(node.discriminant);
            for (const switchCase of node.cases) {
                if (!isFormatLiteral(switchCase.test)) {
                    continue;
                }
                violations.push(createViolation(sourcePath, sourceText, switchCase, {
                    comparisonKind: 'switch-case',
                    discriminant: getNodeText(sourceText, discriminant),
                    formatLiteral: switchCase.test.value,
                    message: `Format switch case on ${getNodeText(sourceText, discriminant)} uses "${switchCase.test.value}".`,
                }));
            }
        }
    });

    return violations.sort((left, right) => (
        left.line - right.line
        || left.column - right.column
        || left.comparisonKind.localeCompare(right.comparisonKind)
        || (left.formatLiteral ?? '').localeCompare(right.formatLiteral ?? '')
    ));
};

export {FORMAT_LITERALS};
