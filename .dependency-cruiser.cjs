module.exports = {
    forbidden: [{
        name: 'no-circular-dependencies',
        severity: 'error',
        from: {path: '^(app|electron|landing|packages|scripts|server)/'},
        to: {circular: true},
    }],
    options: {
        doNotFollow: {path: '(^|/)node_modules/'},
        tsConfig: {fileName: 'tsconfig.json'},
    },
};
