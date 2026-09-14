#!/usr/bin/env node
// Regenerates catalyst/iac/project-template-<version>.json from the curated
// catalyst/iac/schema.catalyst.js. See catalyst/iac/README.md. Deterministic and
// idempotent: running it twice in a row produces byte-identical output.
//
// Usage:
//   node scripts/generate-iac-template.js                 # writes the committed template
//   node scripts/generate-iac-template.js --emit-columns   # also writes var/iac/columns/<table>.json
//   node scripts/generate-iac-template.js --out=<path>     # write the template elsewhere (tests)
//   node scripts/generate-iac-template.js --columns-dir=<path>  # override columns output dir
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TABLES } from '../catalyst/iac/schema.catalyst.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(__dirname);

export const TEMPLATE_NAME = 'EcoGreenMigration';
export const TEMPLATE_VERSION = '1.0.0';
export const TEMPLATE_PATH = `${ROOT}/catalyst/iac/project-template-${TEMPLATE_VERSION}.json`;
export const COLUMNS_DIR = `${ROOT}/var/iac/columns`;

/**
 * Build the Catalyst IaC template object: one `table` component per table
 * (no dependencies) followed by one `column` component per column, each
 * depending on its own table. Booleans in the template are real JSON booleans.
 */
export function buildTemplate() {
  const components = [];

  for (const table of TABLES) {
    components.push({
      type: 'table',
      name: table.name,
      properties: { table_name: table.name },
      dependsOn: [],
    });
  }

  for (const table of TABLES) {
    for (const c of table.columns) {
      const properties = {
        table_name: table.name,
        column_name: c.column_name,
        data_type: c.data_type,
        is_mandatory: !!c.is_mandatory,
      };
      if (c.max_length !== undefined) properties.max_length = c.max_length;
      if (c.is_unique) properties.is_unique = true;
      components.push({
        type: 'column',
        name: `${table.name}.${c.column_name}`,
        properties,
        dependsOn: [table.name],
      });
    }
  }

  return {
    name: TEMPLATE_NAME,
    version: TEMPLATE_VERSION,
    parameters: {},
    components: { Datastore: components },
  };
}

/**
 * Build the exact array body Create_Column expects for one table (used by the
 * lead applying additive columns to an existing project via MCP — see
 * catalyst/iac/README.md). Booleans are STRINGS ('true'/'false') here, matching
 * the Catalyst Create_Column API shape (distinct from the JSON-boolean template
 * above). `search_index_enabled`, `is_unique` and `max_length` are omitted for
 * `text` columns, which never carry them.
 */
export function buildColumnBody(table) {
  return table.columns.map((c) => {
    const body = {
      column_name: c.column_name,
      data_type: c.data_type,
      is_mandatory: c.is_mandatory ? 'true' : 'false',
    };
    if (c.data_type !== 'text') {
      if (c.max_length !== undefined) body.max_length = Number(c.max_length); // API schema: integer
      body.is_unique = c.is_unique ? 'true' : 'false';
      body.search_index_enabled = 'false';
    }
    body.audit_consent = 'false';
    return body;
  });
}

function serialize(obj) {
  return `${JSON.stringify(obj, null, 2)}\n`;
}

export function writeTemplate(outPath = TEMPLATE_PATH) {
  writeFileSync(outPath, serialize(buildTemplate()));
  return outPath;
}

export function writeColumnBodies(dir = COLUMNS_DIR) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const written = [];
  for (const table of TABLES) {
    const p = `${dir}/${table.name}.json`;
    writeFileSync(p, serialize(buildColumnBody(table)));
    written.push(p);
  }
  return written;
}

function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    const m = a.match(/^--([\w-]+)(?:=(.*))?$/);
    if (m) out[m[1]] = m[2] ?? true;
  }
  return out;
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isMainModule()) {
  const args = parseArgs(process.argv.slice(2));
  const outPath = args.out ?? TEMPLATE_PATH;
  writeTemplate(outPath);
  console.log(`Wrote ${outPath}`);
  if (args['emit-columns']) {
    const dir = args['columns-dir'] ?? COLUMNS_DIR;
    const written = writeColumnBodies(dir);
    console.log(`Wrote ${written.length} column bodies under ${dir}`);
  }
}
