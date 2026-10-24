// Colors come only from the palette in src/lib/styles/tokens.css; everything else uses its tokens.
const NO_COLOR_LITERALS = {
  'color-no-hex': true,
  'color-named': 'never',
  'function-disallowed-list': [
    'rgb',
    'rgba',
    'hsl',
    'hsla',
    'hwb',
    'lab',
    'lch',
    'oklab',
    'oklch',
    'color',
  ],
};

/** @type {import('stylelint').Config} */
export default {
  rules: NO_COLOR_LITERALS,
  overrides: [
    { files: ['**/*.svelte'], customSyntax: 'postcss-html' },
    {
      files: ['src/lib/styles/tokens.css'],
      rules: Object.fromEntries(Object.keys(NO_COLOR_LITERALS).map((rule) => [rule, null])),
    },
  ],
};
