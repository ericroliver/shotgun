/**
 * src/commands/spec.ts
 * `shogun spec` — OpenAPI spec query subcommand.
 *
 * Slices the live (or local) OpenAPI spec and emits a concise, token-efficient
 * view. All $ref chains are resolved inline — no raw "$ref" strings in output.
 */

import { loadConfig, loadEnv, fetchSpec } from '../loader.js';

// ---------------------------------------------------------------------------
// Public args interface (matches what index.ts parseArgs produces)
// ---------------------------------------------------------------------------

export interface SpecArgs {
  /** Optional positional: spec source override (full URL, relative URL, or local file) */
  specSource?: string;
  /** --env flag */
  env?: string;
  /** --endpoint filter (exact or substring match on the path key) */
  endpoint?: string;
  /** --method filter: GET, POST, PUT, PATCH, DELETE */
  method?: string;
  /** --tag filter: show all endpoints in this tag group */
  tag?: string;
  /** --schema: resolve and display a named component schema */
  schema?: string;
  /** --search: full-text search across summaries + descriptions */
  search?: string;
  /** --list: emit METHOD /path listing (default when no filter given) */
  list?: boolean;
  /** --format: pretty (default) | json | markdown */
  format?: 'pretty' | 'json' | 'markdown';
  /** cwd override (passed by --cwd in index.ts before dispatch) */
  cwd?: string;
}

// ---------------------------------------------------------------------------
// Minimal OpenAPI 3 types (only what we need)
// ---------------------------------------------------------------------------

interface OpenApiSpec {
  openapi?: string;
  info?: { title?: string; version?: string };
  paths?: Record<string, PathItem>;
  components?: {
    schemas?: Record<string, SchemaObject>;
  };
  tags?: Array<{ name: string; description?: string }>;
}

interface PathItem {
  get?: OperationObject;
  post?: OperationObject;
  put?: OperationObject;
  patch?: OperationObject;
  delete?: OperationObject;
  head?: OperationObject;
  options?: OperationObject;
  parameters?: ParameterObject[];
}

interface OperationObject {
  operationId?: string;
  summary?: string;
  description?: string;
  tags?: string[];
  parameters?: ParameterObject[];
  requestBody?: RequestBodyObject;
  responses?: Record<string, ResponseObject>;
}

interface ParameterObject {
  name: string;
  in: 'query' | 'path' | 'header' | 'cookie';
  required?: boolean;
  description?: string;
  schema?: SchemaObject | RefObject;
}

interface RequestBodyObject {
  required?: boolean;
  content?: Record<string, { schema?: SchemaObject | RefObject }>;
}

interface ResponseObject {
  description?: string;
  content?: Record<string, { schema?: SchemaObject | RefObject }>;
}

interface SchemaObject {
  type?: string;
  format?: string;
  nullable?: boolean;
  description?: string;
  required?: string[];
  properties?: Record<string, SchemaObject | RefObject>;
  items?: SchemaObject | RefObject;
  enum?: unknown[];
  allOf?: Array<SchemaObject | RefObject>;
  oneOf?: Array<SchemaObject | RefObject>;
  anyOf?: Array<SchemaObject | RefObject>;
  additionalProperties?: boolean | SchemaObject | RefObject;
  '$ref'?: string;
}

interface RefObject {
  '$ref': string;
}

function isRef(obj: unknown): obj is RefObject {
  return typeof obj === 'object' && obj !== null && '$ref' in obj;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function spec(args: SpecArgs): Promise<number> {
  const cwd = args.cwd ?? process.cwd();

  // Load config (best-effort — no error if missing)
  let config;
  try {
    config = loadConfig(cwd);
  } catch {
    config = { version: 1 as const };
  }

  // Load env if requested (or fall back to config default env)
  let env: Record<string, string> = {};
  const envName = args.env ?? config.defaults?.env;
  if (envName) {
    try {
      env = loadEnv(envName, config, cwd);
    } catch (err) {
      // If env load fails and we might need BASE_URL, surface the error later
      // when we actually try to resolve a relative spec source.
    }
  }

  // Fetch the spec
  let raw: string;
  try {
    const result = await fetchSpec(args.specSource, config, env, cwd);
    raw = result.raw;
  } catch (err) {
    console.error(`Error: ${(err as Error).message}`);
    return 1;
  }

  // Parse
  let openApi: OpenApiSpec;
  try {
    openApi = JSON.parse(raw) as OpenApiSpec;
  } catch {
    console.error('Error: Spec response is not valid JSON.');
    return 1;
  }

  const format = args.format ?? 'pretty';

  // Dispatch to the appropriate query handler
  if (args.schema) {
    return handleSchema(openApi, args.schema, format);
  }

  if (args.tag) {
    return handleTag(openApi, args.tag, format);
  }

  if (args.search) {
    return handleSearch(openApi, args.search, format);
  }

  if (args.endpoint) {
    return handleEndpoint(openApi, args.endpoint, args.method, format);
  }

  // Default: list
  return handleList(openApi, format);
}

// ---------------------------------------------------------------------------
// Query handlers
// ---------------------------------------------------------------------------

function handleList(openApi: OpenApiSpec, format: 'pretty' | 'json' | 'markdown'): number {
  const paths = openApi.paths ?? {};
  const entries: Array<{ method: string; path: string; summary: string }> = [];

  for (const [pathKey, pathItem] of Object.entries(paths)) {
    for (const method of HTTP_METHODS) {
      const op = pathItem[method as keyof PathItem] as OperationObject | undefined;
      if (op) {
        entries.push({ method: method.toUpperCase(), path: pathKey, summary: op.summary ?? '' });
      }
    }
  }

  if (format === 'json') {
    console.log(JSON.stringify(entries, null, 2));
    return 0;
  }

  if (format === 'markdown') {
    console.log(`## Endpoints (${entries.length} total)\n`);
    console.log('| Method | Path | Summary |');
    console.log('|--------|------|---------|');
    for (const e of entries) {
      console.log(`| ${e.method} | \`${e.path}\` | ${e.summary} |`);
    }
    return 0;
  }

  // pretty
  console.log(`Endpoints (${entries.length} total):`);
  for (const e of entries) {
    const padded = e.method.padEnd(7);
    const summary = e.summary ? `  ${e.summary}` : '';
    console.log(`  ${padded} ${e.path}${summary}`);
  }
  console.log('\nUse --tag, --endpoint, --method, --schema, or --search to drill in.');
  return 0;
}

function handleTag(openApi: OpenApiSpec, tagFilter: string, format: 'pretty' | 'json' | 'markdown'): number {
  const paths = openApi.paths ?? {};
  const tagLower = tagFilter.toLowerCase();

  const matches: Array<{ method: string; path: string; summary: string }> = [];

  for (const [pathKey, pathItem] of Object.entries(paths)) {
    for (const method of HTTP_METHODS) {
      const op = pathItem[method as keyof PathItem] as OperationObject | undefined;
      if (op && op.tags?.some(t => t.toLowerCase() === tagLower)) {
        matches.push({ method: method.toUpperCase(), path: pathKey, summary: op.summary ?? '' });
      }
    }
  }

  if (matches.length === 0) {
    console.error(`No endpoints found for tag: "${tagFilter}"`);
    return 1;
  }

  if (format === 'json') {
    console.log(JSON.stringify(matches, null, 2));
    return 0;
  }

  if (format === 'markdown') {
    console.log(`## ${tagFilter} (${matches.length} endpoints)\n`);
    console.log('| Method | Path | Summary |');
    console.log('|--------|------|---------|');
    for (const m of matches) {
      console.log(`| ${m.method} | \`${m.path}\` | ${m.summary} |`);
    }
    return 0;
  }

  // pretty
  console.log(`${tagFilter} (${matches.length} endpoints):`);
  for (const m of matches) {
    const padded = m.method.padEnd(7);
    const summary = m.summary ? `  ${m.summary}` : '';
    console.log(`  ${padded} ${m.path}${summary}`);
  }
  return 0;
}

function handleSearch(openApi: OpenApiSpec, keyword: string, format: 'pretty' | 'json' | 'markdown'): number {
  const paths = openApi.paths ?? {};
  const kw = keyword.toLowerCase();

  const matches: Array<{ method: string; path: string; summary: string; description?: string }> = [];

  for (const [pathKey, pathItem] of Object.entries(paths)) {
    for (const method of HTTP_METHODS) {
      const op = pathItem[method as keyof PathItem] as OperationObject | undefined;
      if (!op) continue;
      const haystack = [
        op.summary ?? '',
        op.description ?? '',
        op.operationId ?? '',
        pathKey,
      ].join(' ').toLowerCase();
      if (haystack.includes(kw)) {
        matches.push({
          method: method.toUpperCase(),
          path: pathKey,
          summary: op.summary ?? '',
          description: op.description,
        });
      }
    }
  }

  if (matches.length === 0) {
    console.error(`No endpoints found matching keyword: "${keyword}"`);
    return 1;
  }

  if (format === 'json') {
    console.log(JSON.stringify(matches, null, 2));
    return 0;
  }

  if (format === 'markdown') {
    console.log(`## Search: "${keyword}" (${matches.length} results)\n`);
    console.log('| Method | Path | Summary |');
    console.log('|--------|------|---------|');
    for (const m of matches) {
      console.log(`| ${m.method} | \`${m.path}\` | ${m.summary} |`);
    }
    return 0;
  }

  // pretty
  console.log(`Search: "${keyword}" — ${matches.length} result(s):`);
  for (const m of matches) {
    const padded = m.method.padEnd(7);
    const summary = m.summary ? `  ${m.summary}` : '';
    console.log(`  ${padded} ${m.path}${summary}`);
  }
  return 0;
}

function handleEndpoint(
  openApi: OpenApiSpec,
  endpointFilter: string,
  methodFilter: string | undefined,
  format: 'pretty' | 'json' | 'markdown',
): number {
  const paths = openApi.paths ?? {};

  // Find matching path keys (exact or substring)
  const matchingPaths = Object.keys(paths).filter(p =>
    p === endpointFilter || p.includes(endpointFilter),
  );

  if (matchingPaths.length === 0) {
    console.error(`No paths found matching: "${endpointFilter}"`);
    return 1;
  }

  const blocks: EndpointBlock[] = [];

  for (const pathKey of matchingPaths) {
    const pathItem = paths[pathKey]!;
    const pathLevelParams = pathItem.parameters ?? [];

    for (const method of HTTP_METHODS) {
      if (methodFilter && method !== methodFilter.toLowerCase()) continue;
      const op = pathItem[method as keyof PathItem] as OperationObject | undefined;
      if (!op) continue;

      blocks.push(buildEndpointBlock(method.toUpperCase(), pathKey, op, pathLevelParams, openApi));
    }
  }

  if (blocks.length === 0) {
    const methodHint = methodFilter ? ` with method ${methodFilter.toUpperCase()}` : '';
    console.error(`No operations found at "${endpointFilter}"${methodHint}`);
    return 1;
  }

  if (format === 'json') {
    console.log(JSON.stringify(blocks, null, 2));
    return 0;
  }

  if (format === 'markdown') {
    for (const block of blocks) {
      renderBlockMarkdown(block);
    }
    return 0;
  }

  // pretty
  const DIVIDER = '─'.repeat(56);
  for (let i = 0; i < blocks.length; i++) {
    if (i > 0) console.log('');
    console.log(DIVIDER);
    renderBlockPretty(blocks[i]!);
  }
  console.log(DIVIDER);
  return 0;
}

function handleSchema(
  openApi: OpenApiSpec,
  schemaName: string,
  format: 'pretty' | 'json' | 'markdown',
): number {
  const schemas = openApi.components?.schemas ?? {};
  const schemaDef = schemas[schemaName];

  if (!schemaDef) {
    const available = Object.keys(schemas).sort().slice(0, 20).join(', ');
    console.error(`Schema not found: "${schemaName}"\n  Available (first 20): ${available}`);
    return 1;
  }

  const resolved = resolveSchema(schemaDef, openApi, 0);

  if (format === 'json') {
    console.log(JSON.stringify(resolved, null, 2));
    return 0;
  }

  if (format === 'markdown') {
    console.log(`## Schema: ${schemaName}\n`);
    console.log('| Field | Type | Flags | Description |');
    console.log('|-------|------|-------|-------------|');
    renderSchemaFieldsMarkdown(resolved, []);
    return 0;
  }

  // pretty
  console.log(`Schema: ${schemaName}`);
  renderSchemaFieldsPretty(resolved, '  ', []);
  return 0;
}

// ---------------------------------------------------------------------------
// Block builder
// ---------------------------------------------------------------------------

interface EndpointBlock {
  method: string;
  path: string;
  tag?: string;
  summary?: string;
  description?: string;
  parameters: ResolvedParam[];
  requestBody?: ResolvedBody;
  responses: Array<{ status: string; description: string }>;
}

interface ResolvedParam {
  name: string;
  in: string;
  type: string;
  required: boolean;
  nullable: boolean;
  description?: string;
  enum?: unknown[];
}

interface ResolvedField {
  name: string;
  type: string;
  required: boolean;
  nullable: boolean;
  description?: string;
  enum?: unknown[];
  properties?: ResolvedField[];
}

interface ResolvedBody {
  contentType: string;
  schemaName?: string;
  fields: ResolvedField[];
}

function buildEndpointBlock(
  method: string,
  pathKey: string,
  op: OperationObject,
  pathLevelParams: ParameterObject[],
  openApi: OpenApiSpec,
): EndpointBlock {
  // Merge path-level and operation-level params (op wins on name collision)
  const allParamObjects = [...pathLevelParams, ...(op.parameters ?? [])];
  const seenNames = new Set<string>();
  const deduped: ParameterObject[] = [];
  for (const p of allParamObjects.reverse()) {
    if (!seenNames.has(p.name)) {
      seenNames.add(p.name);
      deduped.unshift(p);
    }
  }

  const parameters: ResolvedParam[] = deduped.map(p => {
    const schema = p.schema ? resolveSchemaShallow(p.schema, openApi) : undefined;
    return {
      name: p.name,
      in: p.in,
      type: schemaTypeString(schema),
      required: p.required ?? false,
      nullable: schema?.nullable ?? false,
      description: p.description,
      enum: schema?.enum,
    };
  });

  // Request body
  let requestBody: ResolvedBody | undefined;
  if (op.requestBody?.content) {
    const contentType = Object.keys(op.requestBody.content)[0] ?? 'application/json';
    const mediaSchema = op.requestBody.content[contentType]?.schema;
    if (mediaSchema) {
      const resolved = resolveSchema(mediaSchema, openApi, 0);
      const schemaName = isRef(mediaSchema)
        ? refName(mediaSchema['$ref'])
        : undefined;
      requestBody = {
        contentType,
        schemaName,
        fields: schemaToFields(resolved, openApi),
      };
    }
  }

  // Responses
  const responses = Object.entries(op.responses ?? {}).map(([status, resp]) => ({
    status,
    description: (resp as ResponseObject).description ?? '',
  }));

  return {
    method,
    path: pathKey,
    tag: op.tags?.[0],
    summary: op.summary,
    description: op.description,
    parameters,
    requestBody,
    responses,
  };
}

// ---------------------------------------------------------------------------
// Renderers — pretty
// ---------------------------------------------------------------------------

function renderBlockPretty(block: EndpointBlock): void {
  console.log(`${block.method} ${block.path}`);
  if (block.tag) console.log(`Tag:     ${block.tag}`);
  if (block.summary) console.log(`Summary: ${block.summary}`);
  if (block.description && block.description !== block.summary) {
    console.log(`\n${block.description}`);
  }

  // Group params by location
  const byIn: Record<string, ResolvedParam[]> = {};
  for (const p of block.parameters) {
    (byIn[p.in] = byIn[p.in] ?? []).push(p);
  }

  for (const [location, params] of Object.entries(byIn)) {
    console.log(`\nParameters (${location}):`);
    for (const p of params) {
      const flags = buildFlags(p.required, p.nullable);
      const enumHint = p.enum ? `  enum: [${p.enum.join(', ')}]` : '';
      const desc = p.description ? `  ${p.description}` : '';
      console.log(`  • ${p.name.padEnd(20)} ${p.type.padEnd(12)} ${flags}${desc}${enumHint}`);
    }
  }

  if (block.requestBody) {
    const rb = block.requestBody;
    const schemaHint = rb.schemaName ? `  ${rb.schemaName}` : '';
    console.log(`\nRequest Body (${rb.contentType}):${schemaHint}`);
    renderFieldsPretty(rb.fields, '  ');
  }

  if (block.responses.length > 0) {
    console.log('\nResponses:');
    for (const r of block.responses) {
      const desc = r.description ? `  ${r.description}` : '';
      console.log(`  ${r.status}${desc}`);
    }
  }
}

function renderFieldsPretty(fields: ResolvedField[], indent: string): void {
  for (const f of fields) {
    const flags = buildFlags(f.required, f.nullable);
    const enumHint = f.enum ? `  enum: [${f.enum.join(', ')}]` : '';
    const desc = f.description ? `  ${f.description}` : '';
    console.log(`${indent}• ${f.name.padEnd(20)} ${f.type.padEnd(12)} ${flags}${desc}${enumHint}`);
    if (f.properties && f.properties.length > 0) {
      renderFieldsPretty(f.properties, indent + '    ');
    }
  }
}

function renderSchemaFieldsPretty(resolved: SchemaObject, indent: string, required: string[]): void {
  const props = resolved.properties ?? {};
  const reqSet = new Set(resolved.required ?? required);
  for (const [name, propRaw] of Object.entries(props)) {
    const prop = propRaw as SchemaObject;
    const flags = buildFlags(reqSet.has(name), prop.nullable ?? false);
    const enumHint = prop.enum ? `  enum: [${prop.enum.join(', ')}]` : '';
    const desc = prop.description ? `  ${prop.description}` : '';
    const type = schemaTypeString(prop);
    console.log(`${indent}${name.padEnd(24)} ${type.padEnd(16)} ${flags}${desc}${enumHint}`);
    if (prop.properties) {
      renderSchemaFieldsPretty(prop, indent + '    ', prop.required ?? []);
    }
  }
}

// ---------------------------------------------------------------------------
// Renderers — markdown
// ---------------------------------------------------------------------------

function renderBlockMarkdown(block: EndpointBlock): void {
  console.log(`### ${block.method} \`${block.path}\`\n`);
  if (block.tag) console.log(`**Tag:** ${block.tag}  `);
  if (block.summary) console.log(`**Summary:** ${block.summary}  `);
  if (block.description && block.description !== block.summary) {
    console.log(`\n${block.description}\n`);
  }

  const byIn: Record<string, ResolvedParam[]> = {};
  for (const p of block.parameters) {
    (byIn[p.in] = byIn[p.in] ?? []).push(p);
  }

  for (const [location, params] of Object.entries(byIn)) {
    console.log(`\n#### Parameters (${location})\n`);
    console.log('| Name | Type | Required | Description |');
    console.log('|------|------|----------|-------------|');
    for (const p of params) {
      const req = p.required ? '✓' : '';
      const desc = p.description ?? '';
      const enumHint = p.enum ? `enum: [${p.enum.join(', ')}]` : '';
      console.log(`| \`${p.name}\` | ${p.type} | ${req} | ${desc}${enumHint} |`);
    }
  }

  if (block.requestBody) {
    const rb = block.requestBody;
    const schemaHint = rb.schemaName ? ` (${rb.schemaName})` : '';
    console.log(`\n#### Request Body \`${rb.contentType}\`${schemaHint}\n`);
    console.log('| Field | Type | Required | Description |');
    console.log('|-------|------|----------|-------------|');
    renderFieldsMarkdown(rb.fields);
  }

  if (block.responses.length > 0) {
    console.log('\n#### Responses\n');
    console.log('| Status | Description |');
    console.log('|--------|-------------|');
    for (const r of block.responses) {
      console.log(`| ${r.status} | ${r.description} |`);
    }
  }
  console.log('');
}

function renderFieldsMarkdown(fields: ResolvedField[]): void {
  for (const f of fields) {
    const req = f.required ? '✓' : '';
    const desc = f.description ?? '';
    const enumHint = f.enum ? ` enum: [${f.enum.join(', ')}]` : '';
    console.log(`| \`${f.name}\` | ${f.type} | ${req} | ${desc}${enumHint} |`);
  }
}

function renderSchemaFieldsMarkdown(resolved: SchemaObject, required: string[]): void {
  const props = resolved.properties ?? {};
  const reqSet = new Set(resolved.required ?? required);
  for (const [name, propRaw] of Object.entries(props)) {
    const prop = propRaw as SchemaObject;
    const req = reqSet.has(name) ? '✓' : '';
    const type = schemaTypeString(prop);
    const desc = prop.description ?? '';
    const enumHint = prop.enum ? ` enum: [${prop.enum.join(', ')}]` : '';
    console.log(`| \`${name}\` | ${type} | ${req} | ${desc}${enumHint} |`);
  }
}

// ---------------------------------------------------------------------------
// $ref resolution
// ---------------------------------------------------------------------------

const MAX_DEPTH = 2;

function resolveSchema(schemaOrRef: SchemaObject | RefObject, openApi: OpenApiSpec, depth: number): SchemaObject {
  if (isRef(schemaOrRef)) {
    const name = refName(schemaOrRef['$ref']);
    const schemas = openApi.components?.schemas ?? {};
    const target = schemas[name];
    if (!target) return { type: `$ref:${name}` } as SchemaObject;
    if (depth >= MAX_DEPTH) return { type: name } as SchemaObject;
    return resolveSchema(target, openApi, depth + 1);
  }

  if (depth >= MAX_DEPTH) return schemaOrRef;

  // Handle allOf / oneOf / anyOf by merging into first found
  const combined = schemaOrRef.allOf ?? schemaOrRef.oneOf ?? schemaOrRef.anyOf;
  if (combined && combined.length > 0) {
    const merged: SchemaObject = { type: 'object', properties: {}, required: [] };
    for (const part of combined) {
      const resolved = resolveSchema(part, openApi, depth);
      if (resolved.properties) {
        Object.assign(merged.properties!, resolved.properties);
      }
      if (resolved.required) {
        merged.required = [...(merged.required ?? []), ...resolved.required];
      }
    }
    return merged;
  }

  // Resolve inline property refs
  if (schemaOrRef.properties) {
    const resolvedProps: Record<string, SchemaObject | RefObject> = {};
    for (const [k, v] of Object.entries(schemaOrRef.properties)) {
      resolvedProps[k] = resolveSchema(v, openApi, depth + 1);
    }
    return { ...schemaOrRef, properties: resolvedProps };
  }

  return schemaOrRef;
}

function resolveSchemaShallow(schemaOrRef: SchemaObject | RefObject, openApi: OpenApiSpec): SchemaObject {
  if (isRef(schemaOrRef)) {
    const name = refName(schemaOrRef['$ref']);
    const schemas = openApi.components?.schemas ?? {};
    const target = schemas[name];
    if (!target) return { type: `$ref:${name}` } as SchemaObject;
    return isRef(target) ? resolveSchemaShallow(target, openApi) : target;
  }
  return schemaOrRef;
}

function schemaToFields(resolved: SchemaObject, openApi: OpenApiSpec): ResolvedField[] {
  const props = resolved.properties ?? {};
  const reqSet = new Set(resolved.required ?? []);
  const fields: ResolvedField[] = [];

  for (const [name, propRaw] of Object.entries(props)) {
    const prop = propRaw as SchemaObject;
    const nested = prop.properties
      ? schemaToFields(prop, openApi)
      : undefined;

    fields.push({
      name,
      type: schemaTypeString(prop),
      required: reqSet.has(name),
      nullable: prop.nullable ?? false,
      description: prop.description,
      enum: prop.enum,
      properties: nested,
    });
  }

  return fields;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'] as const;

function refName(ref: string): string {
  // "#/components/schemas/Foo" → "Foo"
  return ref.split('/').pop() ?? ref;
}

function schemaTypeString(schema: SchemaObject | undefined): string {
  if (!schema) return 'unknown';
  if (schema.type === 'array') {
    if (schema.items) {
      const itemsSchema = schema.items as SchemaObject;
      const itemType = itemsSchema.type ?? (isRef(itemsSchema) ? refName((itemsSchema as RefObject)['$ref']) : 'unknown');
      return `array<${itemType}>`;
    }
    return 'array';
  }
  if (schema.type === 'object' && schema.properties) {
    return 'object{...}';
  }
  if (schema.enum) {
    return schema.type ?? 'string';
  }
  return schema.type ?? 'object';
}

function buildFlags(required: boolean, nullable: boolean): string {
  const parts: string[] = [];
  if (required) parts.push('(required)');
  if (nullable) parts.push('(nullable)');
  return parts.join(' ').padEnd(22);
}
