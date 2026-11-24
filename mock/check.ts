// Verifie que l'API simulee (npm run mock, port 4010) repond 2xx pour CHAQUE route du contrat.
// Usage: npm run mock & puis npm run mock:check. Les scripts CLI peuvent utiliser la console.
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';

const base = process.env.MOCK_URL ?? 'http://127.0.0.1:4010';
const spec = parse(readFileSync('shared/contract/openapi.yaml', 'utf8'));
let failed = 0;
for (const [path, item] of Object.entries<Record<string, { requestBody?: { content: { 'application/json': { example: unknown } } } }>>(spec.paths)) {
  for (const [method, op] of Object.entries(item)) {
    const url = base + path.replace(/\{[^}]+\}/g, 'x1');
    const body = op.requestBody?.content['application/json'].example;
    const res = await fetch(url, {
      method: method.toUpperCase(),
      headers: { authorization: 'Bearer test', ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const ok = res.status >= 200 && res.status < 300;
    if (!ok) failed++;
    console.log(`${ok ? 'OK  ' : 'FAIL'} ${res.status} ${method.toUpperCase()} ${path}`);
  }
}
if (failed) {
  console.error(`${failed} route(s) en echec`);
  process.exit(1);
}
