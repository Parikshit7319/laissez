// @ts-check
import { defineConfig } from 'astro/config';
import preact from '@astrojs/preact';
import sitemap from '@astrojs/sitemap';

// GitHub Pages project site: https://parikshit7319.github.io/laissez/
// PUBLIC_ARTIFACT=1 builds a flat, relative-path copy for a hosted preview.
const artifact = process.env.PUBLIC_ARTIFACT === '1';

export default defineConfig({
  site: 'https://parikshit7319.github.io',
  base: artifact ? '/' : '/laissez',
  outDir: artifact ? './dist-preview' : './dist',
  trailingSlash: 'ignore',
  integrations: [preact(), sitemap({ filter: (page) => !/\/(app|portal|consent|404)\/?$/.test(page) })],
  build: { format: artifact ? 'file' : 'directory', inlineStylesheets: 'always', assets: 'assets' },
});
