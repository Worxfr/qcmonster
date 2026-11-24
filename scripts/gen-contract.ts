// Genere shared/contract/generated/{types.ts,schemas.ts} depuis openapi.yaml. Ne pas editer les fichiers generes.
import { readFileSync, writeFileSync } from 'node:fs';
import { parse } from 'yaml';
import $RefParser from '@apidevtools/json-schema-ref-parser';
import { jsonSchemaToZod } from 'json-schema-to-zod';
import openapiTS, { astToString } from 'openapi-typescript';

const SRC = 'shared/contract/openapi.yaml';
const OUT = 'shared/contract/generated';
const HEADER = '// GENERE par scripts/gen-contract.ts depuis shared/contract/openapi.yaml. NE PAS EDITER.\n';

const spec = parse(readFileSync(SRC, 'utf8'));
const deref = (await $RefParser.dereference(structuredClone(spec))) as { components: { schemas: Record<string, object> } };

let zod = `${HEADER}import { z } from 'zod';\n\n`;
for (const name of Object.keys(spec.components.schemas)) {
  const code = jsonSchemaToZod(deref.components.schemas[name] as never, { module: 'none', type: false });
  zod += `export const ${name}Schema = ${code};\n\n`;
}
writeFileSync(`${OUT}/schemas.ts`, zod);

const ast = await openapiTS(new URL(`file://${process.cwd()}/${SRC}`));
writeFileSync(`${OUT}/types.ts`, HEADER + astToString(ast));
console.log('contrat genere');
