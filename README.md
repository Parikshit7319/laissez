# Laissez

Compliant cross-border distribution and settlement for tokenized funds. A concept-stage product by Parikshit Ambhore.

Live site: https://parikshit7319.github.io/laissez/

## Run locally

```bash
npm install
npm run dev      # http://localhost:4321/laissez/
npm run build    # static output in dist/
```

## Where things live

- `src/pages/` one file per page
- `src/proto/` the prototype: `engine.ts` (policy resolver), `data.ts` (fictional entities, real thresholds), `Console.tsx` (UI)
- `src/data/sources.ts` every cited source; footnote numbers follow this list
- `src/styles/` design tokens and prototype styles

## Deploy

Pushing to `main` builds and deploys through GitHub Actions. In the repo settings, set Pages > Source to "GitHub Actions" once.

Prototype entities and data are fictional and simulated. Market data is as of October 1, 2026, with sources on the site.
