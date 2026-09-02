import { readFileSync, writeFileSync } from "node:fs";

const propertiesPath = new URL("../gradle.properties", import.meta.url);
const properties = readFileSync(propertiesPath, "utf8");
const versionLine = /^pluginVersion[ \t]*=[ \t]*(\d+)\.(\d+)\.(\d+)[ \t]*$/m;
const match = properties.match(versionLine);

if (!match) {
  throw new Error("gradle.properties must contain pluginVersion = <major>.<minor>.<patch>");
}

const currentVersion = `${match[1]}.${match[2]}.${match[3]}`;
const nextVersion = `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
const updated = properties.replace(versionLine, `pluginVersion = ${nextVersion}`);

writeFileSync(propertiesPath, updated);

// The frontend bundle has no release of its own; its manifest version just mirrors the plugin's so
// the two never drift apart again. Edited textually to keep the file's formatting and key order.
const packagePath = new URL("../frontend/package.json", import.meta.url);
const packageJson = readFileSync(packagePath, "utf8");
const packageVersionLine = /^(\s*"version":\s*")\d+\.\d+\.\d+(",?)$/m;
if (!packageVersionLine.test(packageJson)) {
  throw new Error('frontend/package.json must contain a "version" field');
}
writeFileSync(packagePath, packageJson.replace(packageVersionLine, `$1${nextVersion}$2`));

console.log(`MilkJ version: ${currentVersion} -> ${nextVersion}`);
