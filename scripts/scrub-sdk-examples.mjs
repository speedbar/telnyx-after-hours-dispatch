#!/usr/bin/env node
// Why this exists: Telnyx's server-side secret scanner rejects
// `telnyx-edge ship` with HTTP 422 ("looks like a secret", generic-api-key)
// because of example values (example UUIDs and tskey-auth-... example keys)
// inside the bundled `telnyx` SDK that @telnyx/edge-runtime depends on.
// Scrubbing those example values lets `telnyx-edge ship` pass the scanner.
// See docs/bug-journal.md BUG-001.
//
// Plain Node ESM, no dependencies, Node 18+, macOS and Linux.
// Runs at postinstall (never fails the install) and on demand:
//   node scripts/scrub-sdk-examples.mjs          scrub, print summary
//   node scripts/scrub-sdk-examples.mjs --check  verify clean, exit 1 on any remaining match

import { promises as fs } from "node:fs";
import path from "node:path";

// --- Patterns (named constants) -------------------------------------------
// (a) Any UUID that starts with `182bd5e5-` becomes `EXAMPLE`.
const UUID_PREFIX_PATTERN =
  /182bd5e5-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g;
// (b) Any UUID inside quotes right after `token_group_id` followed by `:` or `=`
//     becomes `EXAMPLE`.
const TOKEN_GROUP_ID_PATTERN =
  /(token_group_id\s*[:=]\s*["'])[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}(["'])/g;
// (c) `tskey-auth-` followed by [A-Za-z0-9_-]+ becomes `tskey-auth-EXAMPLE`.
// The lookahead excludes the literal placeholder itself so that a scrubbed
// file is a fixed point: normal mode is idempotent and --check reports clean.
const TSKEY_AUTH_PATTERN = /tskey-auth-(?!EXAMPLE\b)[A-Za-z0-9_-]+/g;

const REPLACEMENTS = [
  { pattern: UUID_PREFIX_PATTERN, replace: () => "EXAMPLE" },
  {
    pattern: TOKEN_GROUP_ID_PATTERN,
    replace: (match, prefix, quote) => `${prefix}EXAMPLE${quote}`,
  },
  { pattern: TSKEY_AUTH_PATTERN, replace: () => "tskey-auth-EXAMPLE" },
];

const CHECK_PATTERNS = REPLACEMENTS.map((r) => r.pattern);

const FILE_EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".ts", ".mts", ".cts"]);

const NODE_MODULES = path.resolve("node_modules");

// --- Filesystem walk -------------------------------------------------------

async function isTelnyxSdkDir(dir) {
  try {
    const pkg = JSON.parse(await fs.readFile(path.join(dir, "package.json"), "utf8"));
    return pkg.name === "telnyx";
  } catch {
    return false;
  }
}

// Every directory named `telnyx` under node_modules (top level and nested)
// whose package.json name is "telnyx". Symlinks are never followed.
async function findTelnyxDirs() {
  const found = [];
  async function walk(dir) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink() || !entry.isDirectory()) continue;
      const full = path.join(dir, entry.name);
      if (entry.name === "telnyx" && (await isTelnyxSdkDir(full))) {
        found.push(full);
        continue; // do not look for more SDK copies inside the SDK itself
      }
      await walk(full);
    }
  }
  await walk(NODE_MODULES);
  return found;
}

async function collectFiles(dir, out) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await collectFiles(full, out);
    } else if (entry.isFile() && FILE_EXTENSIONS.has(path.extname(entry.name))) {
      out.push(full);
    }
  }
}

// --- Scrub / check ---------------------------------------------------------

function scrubContent(content) {
  let replacements = 0;
  for (const { pattern, replace } of REPLACEMENTS) {
    content = content.replace(pattern, (...args) => {
      replacements += 1;
      return replace(...args);
    });
  }
  return { content, replacements };
}

function matchingLineNumbers(content) {
  const lines = content.split("\n");
  const hits = new Set();
  for (let i = 0; i < lines.length; i += 1) {
    for (const pattern of CHECK_PATTERNS) {
      pattern.lastIndex = 0;
      if (pattern.test(lines[i])) {
        hits.add(i + 1);
      }
    }
  }
  return [...hits].sort((a, b) => a - b);
}

function rel(file) {
  return path.relative(process.cwd(), file);
}

async function main() {
  const checkMode = process.argv.includes("--check");

  let telnyxDirs;
  try {
    telnyxDirs = await findTelnyxDirs();
  } catch (err) {
    console.warn(`scrub-sdk-examples: warning: ${err.message}`);
    return 0;
  }

  if (telnyxDirs.length === 0) {
    console.log("telnyx SDK not found, nothing to scrub");
    return 0;
  }

  const files = [];
  for (const dir of telnyxDirs) {
    await collectFiles(dir, files);
  }

  if (checkMode) {
    let dirty = 0;
    for (const file of files) {
      let content;
      try {
        content = await fs.readFile(file, "utf8");
      } catch (err) {
        console.warn(`scrub-sdk-examples: warning: ${rel(file)}: ${err.message}`);
        continue;
      }
      for (const line of matchingLineNumbers(content)) {
        // Never print the matched value, only the location.
        console.log(`${rel(file)}:${line}`);
        dirty += 1;
      }
    }
    if (dirty > 0) return 1;
    console.log("clean");
    return 0;
  }

  let filesChanged = 0;
  let totalReplacements = 0;
  const changedPaths = [];
  for (const file of files) {
    try {
      const original = await fs.readFile(file, "utf8");
      const { content, replacements } = scrubContent(original);
      if (content !== original) {
        await fs.writeFile(file, content);
        filesChanged += 1;
        totalReplacements += replacements;
        changedPaths.push(rel(file));
      }
    } catch (err) {
      console.warn(`scrub-sdk-examples: warning: ${rel(file)}: ${err.message}`);
    }
  }

  console.log(
    `scrub-sdk-examples: ${filesChanged} file(s) changed, ${totalReplacements} replacement(s)`,
  );
  for (const p of changedPaths) {
    console.log(`  ${p}`);
  }
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    // Must never break `npm install`.
    console.warn(`scrub-sdk-examples: warning: ${err.message}`);
    process.exit(0);
  });
