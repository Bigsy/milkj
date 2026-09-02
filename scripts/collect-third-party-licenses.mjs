// Regenerates src/main/resources/third-party/BUNDLED-LICENSES.md from the frontend bundle.
//
// The npm dependency tree that ends up inside the plugin jar is decided by Vite's tree shaking,
// not by frontend/package.json, so the authoritative list of redistributed code is the set of
// node_modules paths mentioned by the built source maps. Run this after a frontend build
// (`make licenses`); it refuses to write anything if it cannot state a package's license, which is
// the signal to check that package by hand and add it to KNOWN_GAPS below.
//
// Limitation: only `*.js.map` is scanned, because Vite emits no CSS source maps for a production
// build. Every package contributing CSS, fonts or wasm today also contributes JavaScript (the sole
// CSS import is `@milkdown/crepe`, the KaTeX fonts come from `katex`, the wasm from `harper.js`), so
// nothing is missed; importing stylesheets from a package with no bundled JS would hide it.

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const repoRoot = new URL("../", import.meta.url);
const assetsDir = fileURLToPath(new URL("src/main/resources/web/assets/", repoRoot));
const pnpmDir = fileURLToPath(new URL("frontend/node_modules/.pnpm/", repoRoot));
const outputPath = new URL("src/main/resources/third-party/BUNDLED-LICENSES.md", repoRoot);

// pnpm stores each resolution as `<name with / as +>@<version>[_<peer suffix>]`; npm versions
// never contain `_`, so the peer suffix is safe to cut off.
const bundledPath = /node_modules\/\.pnpm\/([^/]+)\/node_modules\/((?:@[^/]+\/)?[^/]+)\//g;
const licenseFileName = /^(licen[cs]e|copying)(\.(md|txt))?$/i;
// npm allows `owner/repo` bare and `<host>:owner/repo` for these hosts.
const repositoryShorthand = /^(?:(github|gitlab|bitbucket):)?([\w.-]+\/[\w.-]+)$/;
const shorthandHosts = { github: "github.com", gitlab: "gitlab.com", bitbucket: "bitbucket.org" };
// A license id that names a file or reserves all rights does not attribute anything, so it is a gap.
const unstatedLicense = /^(UNKNOWN|UNLICENSED|SEE LICEN[CS]E IN\b)/i;

// Packages whose published metadata cannot state their license on its own. Each entry is a
// deliberate, checked-by-hand decision, so an unlisted gap fails the run. `license` is only for a
// package whose manifest states nothing at all; a stale or redundant entry is reported.
const KNOWN_GAPS = {
  "khroma@2.1.0": {
    license: "MIT",
    note: "The manifest omits a `license` field; the id above is from the package's own `license` file, quoted in full below.",
  },
  "remark-math@6.0.0": {
    note: "remarkjs publishes one license text at its monorepo root rather than per package, so none ships here; see the project link above.",
  },
};

function byCodePoint(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function readSourceMapPaths() {
  const maps = readdirSync(assetsDir).filter((name) => name.endsWith(".js.map"));
  if (maps.length === 0) {
    throw new Error(`No source maps in ${assetsDir}; run \`cd frontend && pnpm run build\` first`);
  }
  const paths = new Set();
  for (const name of maps) {
    const { sources } = JSON.parse(readFileSync(`${assetsDir}${name}`, "utf8"));
    for (const source of sources ?? []) {
      paths.add(source);
    }
  }
  return paths;
}

// Keyed by `<name>@<version>`: mermaid and Milkdown pull in duplicate majors of d3 and KaTeX,
// and every copy is really in the jar, so every copy is listed.
function collectPackages(paths) {
  const packages = new Map();
  for (const path of paths) {
    for (const [, resolution, name] of path.matchAll(bundledPath)) {
      // A path reaching a package through another package's resolution directory (which is what
      // `resolve.preserveSymlinks` would produce) would otherwise be filed under a wrong version
      // and merged with the real entry, dropping a package from the list without a word.
      const prefix = `${name.replaceAll("/", "+")}@`;
      if (!resolution.startsWith(prefix)) {
        throw new Error(`Cannot read a version for ${name} from .pnpm/${resolution}`);
      }
      const version = resolution.slice(prefix.length).split("_")[0];
      packages.set(`${name}@${version}`, { name, version, resolution });
    }
  }
  return [...packages.values()].sort(
    (a, b) => byCodePoint(a.name, b.name) || byCodePoint(a.version, b.version),
  );
}

// `repository` is either a string -- often one of npm's shorthands rather than a URL -- or an object.
function describeProject(manifest) {
  if (manifest.homepage) {
    return manifest.homepage;
  }
  const repository = manifest.repository;
  const url = typeof repository === "string" ? repository : repository?.url;
  if (!url) {
    return null;
  }
  const shorthand = url.match(repositoryShorthand);
  if (shorthand) {
    return `https://${shorthandHosts[shorthand[1] ?? "github"]}/${shorthand[2]}`;
  }
  return url
    .replace(/^git\+/, "")
    .replace(/^git@([^:]+):/, "https://$1/")
    .replace(/^git:\/\//, "https://")
    .replace(/\.git$/, "");
}

function describeLicense(manifest) {
  if (typeof manifest.license === "string") {
    return manifest.license;
  }
  if (typeof manifest.license?.type === "string") {
    return manifest.license.type;
  }
  // `licenses: [...]` is the deprecated pre-npm-2 spelling; khroma still uses nothing at all.
  const legacy = manifest.licenses
    ?.map((entry) => (typeof entry === "string" ? entry : entry?.type))
    .filter((entry) => typeof entry === "string");
  return legacy?.length ? legacy.join(" OR ") : "UNKNOWN";
}

// Reading the directory rather than probing fixed names keeps this working on a case-sensitive
// filesystem: @iconify/utils ships `license.txt`, which only a case-insensitive volume matches
// against a hardcoded `LICENSE.txt`.
function readLicenseText(dir) {
  for (const name of readdirSync(dir).filter((name) => licenseFileName.test(name)).sort()) {
    try {
      return readFileSync(`${dir}${name}`, "utf8").trimEnd();
    } catch {
      // A directory or an unreadable file named like a license: try the next candidate.
    }
  }
  return null;
}

function readPackage({ name, version, resolution }) {
  const dir = `${pnpmDir}${resolution}/node_modules/${name}/`;
  const manifest = JSON.parse(readFileSync(`${dir}package.json`, "utf8"));
  const gap = KNOWN_GAPS[`${name}@${version}`];
  const declared = describeLicense(manifest);
  const text = readLicenseText(dir);
  return {
    key: `${name}@${version}`,
    name,
    version,
    // The override applies only where the manifest says nothing, so a package that grows a real
    // `license` field cannot silently keep a hand-written id that disagrees with it.
    license: unstatedLicense.test(declared) && gap?.license ? gap.license : declared,
    declared,
    project: describeProject(manifest),
    note: gap?.note ?? null,
    text,
    gap,
  };
}

function render(packages) {
  const counts = new Map();
  for (const pkg of packages) {
    counts.set(pkg.license, (counts.get(pkg.license) ?? 0) + 1);
  }
  const summary = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || byCodePoint(a[0], b[0]))
    .map(([license, count]) => `- ${license}: ${count}`);

  const lines = [
    "# Bundled npm dependency licenses",
    "",
    "MilkJ's editor UI is a Vite bundle that ships inside the plugin jar under `web/`. This file is",
    "generated by `scripts/collect-third-party-licenses.mjs` from the bundle's own source maps, so it",
    "lists every npm package whose code is actually redistributed, with the license text as published.",
    "",
    `${packages.length} packages, by license:`,
    "",
    ...summary,
    "",
    "Libraries called out in `THIRD_PARTY_NOTICES.md` (Harper, diff-match-patch, DOMPurify) also appear",
    "here; their full license texts are shipped alongside this file.",
    "",
    "## Packages",
    "",
  ];
  for (const pkg of packages) {
    lines.push(`### ${pkg.name} ${pkg.version}`, "");
    lines.push(`- License: ${pkg.license}`);
    if (pkg.project) {
      lines.push(`- Project: ${pkg.project}`);
    }
    lines.push("");
    if (pkg.note) {
      lines.push(pkg.note, "");
    }
    if (pkg.text) {
      lines.push("```", pkg.text, "```", "");
    }
  }
  return lines.join("\n");
}

const packages = collectPackages(readSourceMapPaths()).map(readPackage);
const problems = [];

for (const pkg of packages) {
  if (unstatedLicense.test(pkg.license)) {
    problems.push(`${pkg.key}: no license id in the manifest (${pkg.declared})`);
  }
  if (!pkg.text && !pkg.gap) {
    problems.push(`${pkg.key}: no license file is published with the package`);
  }
  if (pkg.gap?.license && !unstatedLicense.test(pkg.declared)) {
    problems.push(`${pkg.key}: KNOWN_GAPS pins "${pkg.gap.license}" but the manifest now says "${pkg.declared}"`);
  }
}

const bundled = new Set(packages.map((pkg) => pkg.key));
for (const key of Object.keys(KNOWN_GAPS)) {
  if (!bundled.has(key)) {
    problems.push(`${key}: a stale KNOWN_GAPS entry -- that version is no longer bundled`);
  }
}

if (problems.length > 0) {
  console.error(`Left ${fileURLToPath(outputPath)} untouched; ${problems.length} package(s) need attention:`);
  for (const problem of problems) {
    console.error(`  ${problem}`);
  }
  console.error("Check each by hand, then update KNOWN_GAPS in this script.");
  process.exit(1);
}

writeFileSync(outputPath, render(packages));
console.log(`Wrote ${fileURLToPath(outputPath)} (${packages.length} packages)`);
