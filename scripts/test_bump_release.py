"""Verify release preparation without changing Git or publishing a plugin."""
import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('release', Path(__file__).with_name('bump-release.py'))
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


class ReleaseTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        original = Path.cwd()
        os.chdir(self.temp.name)
        self.addCleanup(self.temp.cleanup)
        self.addCleanup(os.chdir, original)
        Path('frontend').mkdir()
        Path('src/main/resources/META-INF').mkdir(parents=True)
        Path('gradle.properties').write_text('pluginVersion = 0.1.24\njavaVersion = 17\n')
        Path('frontend/package.json').write_text('{\n  "version": "0.1.24",\n  "private": true\n}\n')
        self.plugin = Path('src/main/resources/META-INF/plugin.xml')

    def prepare(self, heading='Unreleased', next_exists=False, old_exists=True):
        self.plugin.write_text(f'<idea-plugin><change-notes><![CDATA[\n<b>{heading}</b>\n<ul><li>Specific fix.</li></ul>\n]]></change-notes></idea-plugin>')
        results = [SimpleNamespace(returncode=0 if next_exists else 1), SimpleNamespace(returncode=0 if old_exists else 1)]
        with patch.object(release.subprocess, 'run', side_effect=results):
            return release.prepare_release()

    def test_unreleased_notes_and_both_versions(self):
        self.assertEqual(self.prepare(), '0.1.25')
        self.assertIn('<b>0.1.25</b>', self.plugin.read_text())
        self.assertNotIn('Maintenance release', self.plugin.read_text())
        self.assertIn('Specific fix.', self.plugin.read_text())
        self.assertEqual(Path('gradle.properties').read_text(), 'pluginVersion = 0.1.25\njavaVersion = 17\n')
        self.assertIn('"version": "0.1.25",', Path('frontend/package.json').read_text())

    def test_released_notes_preserved(self):
        self.prepare(heading='0.1.24')
        self.assertIn('Maintenance release', self.plugin.read_text())
        self.assertIn('<b>0.1.24</b>', self.plugin.read_text())

    def test_prepared_next_notes_not_duplicated(self):
        self.prepare(heading='0.1.25')
        self.assertEqual(self.plugin.read_text().count('<b>0.1.25</b>'), 1)
        self.assertNotIn('Maintenance release', self.plugin.read_text())

    def test_existing_tag_does_not_modify_versions(self):
        with self.assertRaisesRegex(SystemExit, 'already exists'):
            self.prepare(next_exists=True)
        self.assertIn('0.1.24', Path('gradle.properties').read_text())
        self.assertIn('0.1.24', Path('frontend/package.json').read_text())
        self.assertIn('<b>Unreleased</b>', self.plugin.read_text())

    def test_invalid_package_does_not_modify_version(self):
        Path('frontend/package.json').write_text('{}')
        with self.assertRaisesRegex(SystemExit, 'numeric version'):
            self.prepare()
        self.assertIn('0.1.24', Path('gradle.properties').read_text())


if __name__ == '__main__':
    unittest.main()
