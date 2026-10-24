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
  plugins: ['stylelint-value-no-unknown-custom-properties'],
  rules: {
    ...NO_COLOR_LITERALS,
    // A typo in var() fails silently in the browser, so every token must be declared somewhere.
    'csstools/value-no-unknown-custom-properties': [
      true,
      { importFrom: ['src/lib/styles/tokens.css', 'src/app.css'] },
    ],
  },
  overrides: [
    { files: ['**/*.svelte'], customSyntax: 'postcss-html' },
    {
      files: ['src/lib/styles/tokens.css'],
      rules: Object.fromEntries(Object.keys(NO_COLOR_LITERALS).map((rule) => [rule, null])),
    },
  ],
};
