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
console.log(`MilkJ version: ${currentVersion} -> ${nextVersion}`);
