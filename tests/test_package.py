"""Regressions that must stop a broken or mistagged release."""

import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
import zipfile

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("packager", ROOT / "scripts/package.py")
packager = importlib.util.module_from_spec(spec)
spec.loader.exec_module(packager)


class PackageFailureTests(unittest.TestCase):
    def test_wrong_release_tag_does_not_produce_artifacts(self):
        with tempfile.TemporaryDirectory() as temp:
            result = subprocess.run(
                [sys.executable, str(ROOT / "scripts/package.py"),
                 "--release-tag", "v999.999.999", "--out-dir", temp],
                capture_output=True, text=True,
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("Release tag must equal", result.stderr)
            self.assertEqual(list(Path(temp).iterdir()), [])

    def test_missing_runtime_module_is_rejected(self):
        metadata = json.loads((ROOT / "metadata.json").read_text())
        with tempfile.TemporaryDirectory() as temp:
            stage = Path(temp)
            for relative in packager.sources():
                target = stage / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(ROOT / relative, target)
            # A real transitive dependency of extension.js: checking only entry
            # points would allow this broken package through.
            (stage / "dbus-parser.js").unlink()
            with self.assertRaisesRegex(ValueError, "Unresolved local import"):
                packager.validate(stage, metadata)

    def test_archive_with_missing_files_is_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            bundle = Path(temp) / "broken.zip"
            with zipfile.ZipFile(bundle, "w") as archive:
                archive.writestr("extension.js", "")
            with self.assertRaisesRegex(ValueError, "Unexpected ZIP contents"):
                packager.verify_bundle(bundle, {"extension.js", "prefs.js"}, {})

    def test_archive_with_path_traversal_is_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            bundle = Path(temp) / "unsafe.zip"
            with zipfile.ZipFile(bundle, "w") as archive:
                archive.writestr("../outside", "")
            with self.assertRaisesRegex(ValueError, "Unsafe ZIP path"):
                packager.verify_bundle(bundle, {"../outside"}, {})


if __name__ == "__main__":
    unittest.main()
