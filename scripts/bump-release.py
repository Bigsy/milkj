"""Prepare the next patch release; run from the repository root."""
import re
import subprocess
from pathlib import Path

def prepare_release():
    properties = Path("gradle.properties")
    plugin = Path("src/main/resources/META-INF/plugin.xml")
    text = properties.read_text()
    package = Path("frontend/package.json")
    package_text = package.read_text()
    package_version = re.search(r'^(\s*"version":\s*")\d+\.\d+\.\d+("[,]?)$', package_text, re.M)
    if not package_version:
        raise SystemExit('frontend/package.json must contain a numeric version')
    match = re.search(r"^pluginVersion\s*=\s*(\d+)\.(\d+)\.(\d+)\s*$", text, re.M)
    if not match:
        raise SystemExit("pluginVersion must be a numeric major.minor.patch version")
    major, minor, patch = map(int, match.groups())
    version = f"{major}.{minor}.{patch + 1}"
    if subprocess.run(["git", "rev-parse", "--verify", "--quiet", f"refs/tags/v{version}"],
                      stdout=subprocess.DEVNULL).returncode == 0:
        raise SystemExit(f"Tag v{version} already exists")
    xml = plugin.read_text()
    notes = re.search(r"(<change-notes><!\[CDATA\[\s*)<b>([^<]+)</b>", xml)
    if not notes:
        raise SystemExit("Expected a version heading at the start of plugin change-notes")
    if notes[2] in ("Unreleased", version):
        xml = xml[:notes.start(2)] + version + xml[notes.end(2):]
    else:
        heading = (f"<b>{version}</b>\n    <ul>\n"
                   "        <li>Maintenance release with the latest fixes and improvements.</li>\n"
                   "    </ul>\n    ")
        xml = xml[:notes.end(1)] + heading + xml[notes.end(1):]
    package_text = package_text[:package_version.start()] + package_version[1] + version + package_version[2] + package_text[package_version.end():]
    package.write_text(package_text)
    properties.write_text(text[:match.start()] + f"pluginVersion = {version}" + text[match.end():])
    plugin.write_text(xml)
    return version


if __name__ == "__main__":
    print(prepare_release())
