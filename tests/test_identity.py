"""Check that Lab settings can be used beside the original without shared writes."""

import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


class IdentityTests(unittest.TestCase):
    def test_settings_are_independent_of_original(self):
        metadata = json.loads((ROOT / "metadata.json").read_text())
        self.assertNotEqual(metadata["uuid"], "gspotify@sogi.is-a.dev")
        self.assertNotEqual(metadata["settings-schema"], "org.gnome.shell.extensions.gspotify")
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp)
            for schema in (ROOT / "schemas").glob("*.gschema.xml"):
                shutil.copyfile(schema, directory / schema.name)
            # A representative upstream key at the original fixed schema path.
            (directory / "original.gschema.xml").write_text('''<schemalist>
              <schema id="org.gnome.shell.extensions.gspotify"
                      path="/org/gnome/shell/extensions/gspotify/">
                <key name="show-info-tip" type="b"><default>true</default></key>
              </schema>
            </schemalist>''')
            subprocess.run(["glib-compile-schemas", "--strict", temp], check=True)
            script = '''
                const Gio = imports.gi.Gio;
                const source = Gio.SettingsSchemaSource.new_from_directory(ARGV[0], null, false);
                const original = new Gio.Settings({settings_schema:
                    source.lookup('org.gnome.shell.extensions.gspotify', false)});
                const lab = new Gio.Settings({settings_schema: source.lookup(ARGV[1], false)});
                if (lab.path === original.path) throw new Error('Shared settings path');
                original.set_boolean('show-info-tip', true);
                lab.set_boolean('show-info-tip', false);
                if (!original.get_boolean('show-info-tip')) throw new Error('Lab changed original');
                original.set_boolean('show-info-tip', false);
                lab.set_boolean('show-info-tip', true);
                if (original.get_boolean('show-info-tip')) throw new Error('Lab changed original');
                if (lab.get_int('spotify-callback-port') === 9000)
                    throw new Error('Default callback conflicts with original');
            '''
            subprocess.run(["gjs", "-c", script, temp, metadata["settings-schema"]],
                           check=True, env={**os.environ, "GSETTINGS_BACKEND": "memory"})


if __name__ == "__main__":
    unittest.main()
