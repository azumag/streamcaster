module.exports = {
    env: {
        node: true,
        es2021: true,
        jest: true
    },
    extends: ['eslint:recommended'],
    parserOptions: {
        ecmaVersion: 2021,
        sourceType: 'script'
    },
    rules: {
        indent: ['error', 4, { SwitchCase: 1 }],
        quotes: ['error', 'single', { allowTemplateLiterals: true }],
        semi: ['error', 'always'],
        curly: ['error', 'all']
    }
};
