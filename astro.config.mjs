// @ts-check
import { defineConfig } from 'astro/config';
import preact from '@astrojs/preact';

// GitHub Pages project site: https://parikshit7319.github.io/laissez/
// PUBLIC_ARTIFACT=1 builds a flat, relative-path copy for a hosted preview.
const artifact = process.env.PUBLIC_ARTIFACT === '1';

export default defineConfig({
  site: 'https://parikshit7319.github.io',
  base: artifact ? '/' : '/laissez',
  outDir: artifact ? './dist-preview' : './dist',
  trailingSlash: 'ignore',
  integrations: [preact()],
  build: { format: artifact ? 'file' : 'directory', inlineStylesheets: 'always', assets: 'assets' },
});
