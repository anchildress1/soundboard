import adapter from '@sveltejs/adapter-node';

/** @type {import('@sveltejs/kit').Config} */
const config = {
  compilerOptions: {
    runes: true,
  },
  kit: {
    adapter: adapter(),
    // Lets tests under tests/ import route modules without deep relative paths.
    alias: { $routes: 'src/routes' },
  },
};

export default config;
