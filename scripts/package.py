#!/usr/bin/env python3
"""Validate and pack GSpotify Lab without installing or modifying the source tree."""

import argparse
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import zipfile

ROOT = Path(__file__).resolve().parents[1]
IMPORT = re.compile(r"(?:\bfrom\s*|\bimport\s*(?:\(\s*)?)[\"'](\.[^\"']+)[\"']")
VERSION = re.compile(r"(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)")


def run(*args, **kwargs):
    subprocess.run(args, check=True, **kwargs)


def sources():
    files = {Path(name) for name in ("metadata.json", "stylesheet.css", "LICENSE")}
    files.update(path.relative_to(ROOT) for path in ROOT.glob("*.js"))
    for folder in ("preferences", "icons", "schemas"):
        files.update(path.relative_to(ROOT) for path in (ROOT / folder).rglob("*")
                     if path.is_file() and path.name != "gschemas.compiled")
    return sorted(files)


def validate(directory, metadata):
    version = metadata.get("version-name", "")
    if not VERSION.fullmatch(version):
        raise ValueError("metadata.version-name must be a stable MAJOR.MINOR.PATCH version")
    if type(metadata.get("version")) is not int or metadata["version"] < 1:
        raise ValueError("metadata.version must be a positive integer")
    required = ["extension.js", "prefs.js", "LICENSE", "stylesheet.css",
                "spotdl-path.js", "icons/spotify-symbolic.svg",
                "icons/heart-outline-thin-symbolic.svg",
                f"schemas/{metadata['settings-schema']}.gschema.xml"]
    for name in required:
        if not (directory / name).is_file():
            raise ValueError(f"Missing runtime file: {name}")
    for path in directory.rglob("*.js"):
        source = path.read_text()
        run("node", "--input-type=module", "--check", input=source, text=True)
        for target in IMPORT.findall(source):
            resolved = (path.parent / target).resolve()
            if not resolved.is_relative_to(directory.resolve()) or not resolved.is_file():
                raise ValueError(f"Unresolved local import in {path.name}: {target}")
    run("glib-compile-schemas", "--strict", str(directory / "schemas"))


def verify_bundle(bundle, expected, metadata):
    with zipfile.ZipFile(bundle) as archive:
        if archive.testzip():
            raise ValueError("ZIP integrity check failed")
        names = archive.namelist()
        if len(names) != len(set(names)):
            raise ValueError("ZIP contains duplicate paths")
        actual = {name for name in names if not name.endswith("/")}
        if actual != expected:
            raise ValueError(f"Unexpected ZIP contents: missing={expected - actual}, extra={actual - expected}")
        for name in names:
            if Path(name).is_absolute() or ".." in Path(name).parts:
                raise ValueError(f"Unsafe ZIP path: {name}")
        with tempfile.TemporaryDirectory(prefix="gspotify-lab-verify-") as temp:
            directory = Path(temp)
            archive.extractall(directory)
            if json.loads((directory / "metadata.json").read_text()) != metadata:
                raise ValueError("Packaged metadata differs from source")
            for name in expected - {"schemas/gschemas.compiled"}:
                if (directory / name).read_bytes() != (ROOT / name).read_bytes():
                    raise ValueError(f"Packaged file differs from source: {name}")
            validate(directory, metadata)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="Validate without creating a ZIP")
    parser.add_argument("--release-tag", help="Require a tag matching metadata.version-name")
    parser.add_argument("--out-dir", type=Path, default=ROOT / "dist")
    args = parser.parse_args()
    for tool in ("node", "glib-compile-schemas", "gnome-extensions"):
        if not shutil.which(tool):
            raise ValueError(f"Required build tool missing: {tool}")
    metadata = json.loads((ROOT / "metadata.json").read_text())
    if args.release_tag is not None and args.release_tag != f"v{metadata['version-name']}":
        raise ValueError("Release tag must equal v + metadata.version-name")
    files = sources()
    with tempfile.TemporaryDirectory(prefix="gspotify-lab-pack-") as temp:
        stage = Path(temp) / "source"
        packed = Path(temp) / "packed"
        stage.mkdir()
        packed.mkdir()
        for relative in files:
            target = stage / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / relative, target)
        validate(stage, metadata)
        if args.check:
            print("Source, imports, JavaScript syntax and schemas validated.")
            return
        command = ["gnome-extensions", "pack", str(stage), "--out-dir", str(packed)]
        for relative in files:
            if len(relative.parts) == 1 and str(relative) not in {
                "extension.js", "prefs.js", "stylesheet.css", "metadata.json"
            }:
                command.append(f"--extra-source={relative}")
        # Pass directories as a whole: individual extra-source paths are flattened.
        command.extend(["--extra-source=preferences", "--extra-source=icons"])
        run(*command)
        bundles = list(packed.glob("*.zip"))
        if len(bundles) != 1:
            raise ValueError("Expected exactly one extension bundle")
        # Some pack versions include only the XML. Ship compiled schemas too so
        # a downloaded bundle is ready for per-user installation on those hosts.
        with zipfile.ZipFile(bundles[0], "a", compression=zipfile.ZIP_DEFLATED) as archive:
            if "schemas/gschemas.compiled" not in archive.namelist():
                archive.write(stage / "schemas/gschemas.compiled", "schemas/gschemas.compiled")
        expected = {str(path) for path in files} | {"schemas/gschemas.compiled"}
        verify_bundle(bundles[0], expected, metadata)
        args.out_dir.mkdir(parents=True, exist_ok=True)
        name = f"gspotify-lab-v{metadata['version-name']}.shell-extension.zip"
        output = args.out_dir / name
        shutil.copyfile(bundles[0], output)
        checksum = hashlib.sha256(output.read_bytes()).hexdigest()
        output.with_suffix(output.suffix + ".sha256").write_text(f"{checksum}  {name}\n")
        print(f"Validated bundle: {output}")


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, subprocess.CalledProcessError, zipfile.BadZipFile) as error:
        sys.exit(f"Packaging failed: {error}")
