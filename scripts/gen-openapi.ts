// Writes the merged OpenAPI document (hand-written spec plus zod-derived request bodies, router-declared
// operations and the pagination contract) to api/src/openapi.generated.json. The Worker serves the same
// merge from memory at GET /v1/openapi.json; the file exists for the docs build, diffs in review and tooling
// that wants a static document. Run with `npm run docs:openapi`.
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mergedSpec, BODY_SCHEMAS, PAGINATED } from '../api/src/openapi-gen';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'api', 'src', 'openapi.generated.json');
const doc = mergedSpec() as any;
const text = JSON.stringify(doc, null, 1) + '\n';
const before = existsSync(out) ? readFileSync(out, 'utf8') : null;
writeFileSync(out, text);
const ops = Object.values<Record<string, any>>(doc.paths).reduce((n, item) => n + Object.keys(item).length, 0);
console.log(`ok    ${ops} operations, ${Object.keys(BODY_SCHEMAS).length} request bodies from zod, ${PAGINATED.length} paginated lists`);
console.log(`ok    ${before === null ? 'wrote' : before === text ? 'unchanged' : 'updated'} api/src/openapi.generated.json (${(text.length / 1024).toFixed(0)} KB)`);
