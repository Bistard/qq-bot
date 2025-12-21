const js = require('@eslint/js');
const tsPlugin = require('@typescript-eslint/eslint-plugin');
const tsParser = require('@typescript-eslint/parser');
const globals = require('globals');

module.exports = [
	{
		ignores: ['dist/**', 'node_modules/**'],
	},
	{
		...js.configs.recommended,
		languageOptions: {
			...js.configs.recommended.languageOptions,
			ecmaVersion: 'latest',
			sourceType: 'module',
			globals: {
				...globals.node,
				...(js.configs.recommended.languageOptions?.globals ?? {}),
			},
		},
		rules: {
			...js.configs.recommended.rules,
			semi: ['error', 'always'],
			quotes: ['error', 'single', { avoidEscape: true, allowTemplateLiterals: true }],
		},
	},
	{
		files: ['**/*.ts', '**/*.tsx'],
		languageOptions: {
			parser: tsParser,
			parserOptions: {
				project: './tsconfig.json',
				tsconfigRootDir: __dirname,
				sourceType: 'module',
			},
		},
		plugins: {
			'@typescript-eslint': tsPlugin,
		},
		rules: {
			...tsPlugin.configs.recommended.rules,
			'no-undef': 'off',
		},
	},
];
