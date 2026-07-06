// scripts/compileConfigs.mjs
//
// Build-time codegen. The Cloudflare Workers runtime (workerd) forbids
// `new Function`/`eval` entirely - at request time AND at module load. So the
// config `expr` strings cannot be compiled in the Worker. Instead we emit a TS
// module where every expr is a real arrow-function literal; esbuild/tsc compile
// them ahead of time and bundle them into the Worker.
//
// Source of truth stays the JSON under configs/<key>/. Run this before tsc
// (wired into `npm run build`). Output: src/generated/compiledConfigs.ts
//
//   node scripts/compileConfigs.mjs

import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, sep } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const configsDir = join(root, "configs");
const outDir = join(root, "src", "generated");
const outFile = join(outDir, "compiledConfigs.ts");

// Every compiled field/intermediate/transform is called by configEngine as
// `(ctx, params)` - a typed context object plus the def's optional `params`.
// Two authoring forms compile differently:
//   - a `.ts` exprFile/transformFile is a real module (see configs/**/expr): it
//     is imported and referenced directly (fully type-checked at build).
//   - an inline `expr`/`transform` string (or a legacy `.js` file) is inlined
//     verbatim, wrapped by a destructuring adapter that unpacks the context so
//     the old bare-identifier bindings (`root`, `$`, `sum`, ...) still resolve.
const FIELD_BINDINGS = "data, root, $, players, member, sum, avg, ref, input";
// Transform bindings; the context object is `_c` because one binding is itself
// named `ctx` (the transformContext section label).
const TRANSFORM_BINDINGS = "value, raw, ref, fields, arg, ctx";

const inlineFieldFn = (expr) =>
  `(ctx) => { const { ${FIELD_BINDINGS} } = ctx; return (${expr}); }`;
const inlineTransformFn = (expr) =>
  `(_c) => { const { ${TRANSFORM_BINDINGS} } = _c; return (${expr}); }`;
const rootFn = (expr) => `(data) => (${expr})`;

// Imports emitted for `.ts` expr/transform modules, deduped by absolute path so
// a module backing several defs (e.g. the parameterized skillGem) is imported
// once and reused. Populated as bundles compile, prepended to the output.
const importsByPath = new Map();
const importLines = [];
function moduleRef(dirPath, file) {
  const abs = join(dirPath, file);
  let sym = importsByPath.get(abs);
  if (!sym) {
    sym = `E${importsByPath.size}`;
    let rel = relative(outDir, abs).split(sep).join("/");
    if (!rel.startsWith(".")) rel = "./" + rel;
    importLines.push(`import ${sym} from ${JSON.stringify(rel)};`);
    importsByPath.set(abs, sym);
  }
  return sym;
}

// Read an inline `expr` or a legacy `.js` exprFile as raw text (trailing
// semicolon/whitespace stripped so the adapter's `return (...)` stays valid).
function readExpr(def, dirPath, what) {
  if (def.exprFile) {
    const text = readFileSync(join(dirPath, def.exprFile), "utf8");
    return text.replace(/\s*;?\s*$/, "");
  }
  if (typeof def.expr === "string") return def.expr;
  throw new Error(
    `${what} '${def.id ?? "?"}' has neither 'expr' nor 'exprFile'`,
  );
}

// The `fn:` literal for a field/intermediate def: a direct import reference for
// a `.ts` module, else the inlined+adapted expression text.
function fieldFn(def, dirPath, what) {
  if (def.exprFile && def.exprFile.endsWith(".ts"))
    return moduleRef(dirPath, def.exprFile);
  return inlineFieldFn(readExpr(def, dirPath, what));
}

// Names of every data/<name>.json actually referenced, so REFS inlines each
// table exactly once instead of per-source. Populated as refLiteral runs.
const usedRefs = new Set();

// Reference datasets a source may pull in from data/<name>.json, exposed to
// expressions as ref["<name>"]. Rather than inline the (often large) table per
// source, point `ref` at the shared REFS singleton by name - a table used by N
// sources is then emitted once, not N times, so the generated artifact scales
// with distinct tables rather than bundle count.
function refLiteral(src) {
  const names = src.refData ?? [];
  if (names.length === 0) return "{}";
  for (const n of names) usedRefs.add(n);
  const entries = names.map(
    (name) => `${JSON.stringify(name)}: REFS[${JSON.stringify(name)}]`,
  );
  return `{ ${entries.join(", ")} }`;
}

// The shared REFS map: each used table inlined once. Sorted for stable output
// diffs. Must be called AFTER the bundles are built so usedRefs is complete.
function refsLiteral() {
  if (usedRefs.size === 0) return "{}";
  const entries = [...usedRefs].sort().map((name) => {
    const json = readFileSync(join(root, "data", `${name}.json`), "utf8");
    return `  ${JSON.stringify(name)}: ${json.trim()}`;
  });
  return `{\n${entries.join(",\n")}\n}`;
}

function compiledSource(src, dirPath) {
  const intermediates = (src.intermediates ?? []).map(
    (i) =>
      `        { id: ${JSON.stringify(i.id)}, scope: ${JSON.stringify(i.scope ?? null)}, params: ${JSON.stringify(i.params ?? null)}, fn: ${fieldFn(i, dirPath, "intermediate")} }`,
  );
  const fields = src.fields.map(
    (f) =>
      `        { id: ${JSON.stringify(f.id)}, params: ${JSON.stringify(f.params ?? null)}, fn: ${fieldFn(f, dirPath, "field")} }`,
  );
  const fallbacks = (src.rootPathFallbacks ?? []).map(rootFn).join(", ");
  const urlTemplate = src.urlTemplate
    ? JSON.stringify(src.urlTemplate)
    : "undefined";
  return `      {
        source: ${JSON.stringify(src.source)},
        version: ${JSON.stringify(src.version ?? null)},
        urlTemplate: ${urlTemplate},
        ref: ${refLiteral(src)},
        rootFn: ${rootFn(src.rootPath)},
        rootFallbackFns: [${fallbacks}],
        intermediates: [
${intermediates.join(",\n")}
        ],
        fields: [
${fields.join(",\n")}
        ],
      }`;
}

// Recursively collect every .json file under `configs`. A datasource lives in
// its own subfolder (spreadsheet/, snapshot/, log/, loadout/) holding its config
// JSON plus an `expr/` subfolder of typed modules; `expr` dirs hold only .ts, so
// they're skipped. Configs are grouped into bundles by their `key` (NOT by
// directory), so a datasource may have several version variants (same key +
// source, different `version`) authored as separate files. exprFile/transformFile
// paths in a config are resolved relative to that config's OWN directory.
function findJsonFiles(dirPath) {
  const out = [];
  for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (entry.name === "expr") continue;
      out.push(...findJsonFiles(join(dirPath, entry.name)));
    } else if (entry.name.endsWith(".json")) {
      out.push(join(dirPath, entry.name));
    }
  }
  return out;
}

// `entries` = every { data, dir } config JSON sharing one `key`. The one with
// `cells` is the sheet; the rest are datasource variants (possibly several per
// `source` kind - the runtime selects by data version, see src/version.ts).
function compileBundle(key, entries) {
  let sheet = null;
  let sheetDir = null;
  const sources = [];
  for (const { data, dir } of entries) {
    if (Array.isArray(data.cells)) {
      sheet = data;
      sheetDir = dir;
    } else if (data.source) {
      sources.push({ data, dir });
    }
  }
  if (!sheet) return null;

  const sourcesSrc = sources
    .map((s) => compiledSource(s.data, s.dir))
    .join(",\n");

  // Compile sheet-side cell transforms (CellBinding.transform / transformFile)
  // into a { "<cell>": fn } map, and bundle the sheet's own refData (read by
  // transforms as `ref`). Both live on the sheet so the datasources stay
  // canonical; a transform reshapes a field's raw value per-spreadsheet.
  const transformEntries = (sheet.cells ?? [])
    .filter((c) => c.transform || c.transformFile)
    .map((c) => {
      let fn;
      if (c.transformFile && c.transformFile.endsWith(".ts")) {
        fn = moduleRef(sheetDir, c.transformFile);
      } else {
        const expr = c.transformFile
          ? readFileSync(join(sheetDir, c.transformFile), "utf8").replace(
              /\s*;?\s*$/,
              "",
            )
          : c.transform;
        fn = inlineTransformFn(expr);
      }
      return `      ${JSON.stringify(c.cell)}: ${fn}`;
    });
  const cellTransforms = transformEntries.length
    ? `{\n${transformEntries.join(",\n")}\n    }`
    : "{}";

  return `  ${JSON.stringify(sheet.key)}: {
    key: ${JSON.stringify(sheet.key)},
    sheet: ${JSON.stringify(sheet)},
    sheetRef: ${refLiteral(sheet)},
    cellTransforms: ${cellTransforms},
    sources: [
${sourcesSrc}
    ],
  }`;
}

// Read every config JSON under configs/, group by `key`, compile one bundle per
// key. (Bundles are no longer one-per-directory: a datasource's files live in
// per-source folders, and all four share the bundle key.)
const byKey = new Map();
for (const file of findJsonFiles(configsDir)) {
  const data = JSON.parse(readFileSync(file, "utf8"));
  if (!data.key) continue;
  if (!byKey.has(data.key)) byKey.set(data.key, []);
  byKey.get(data.key).push({ data, dir: dirname(file) });
}
const bundleEntries = [...byKey.entries()]
  .map(([key, entries]) => compileBundle(key, entries))
  .filter(Boolean);

const out = `// AUTO-GENERATED by scripts/compileConfigs.mjs - DO NOT EDIT.
// Source of truth is the JSON under configs/<key>/. Regenerate via
// \`node scripts/compileConfigs.mjs\` (runs automatically in \`npm run build\`).
// @ts-nocheck
/* eslint-disable */
import type { CompiledBundle } from "../configEngine";
${importLines.join("\n")}

// Reference datasets (data/<name>.json) inlined ONCE and shared by every source
// / sheet that lists them in refData, via REFS[name]. Avoids duplicating large
// tables (skills, gems, ...) per compiled bundle.
const REFS: Record<string, unknown> = ${refsLiteral()};

export const COMPILED_BUNDLES: Record<string, CompiledBundle> = {
${bundleEntries.join(",\n")}
};
`;

mkdirSync(outDir, { recursive: true });
writeFileSync(outFile, out, "utf8");
console.log(`Wrote ${outFile} (${bundleEntries.length} bundle(s))`);
