import GLib from "gi://GLib";

// Desktop sessions may not inherit the shell's PATH additions for uv/pipx tools.
export function findSpotDL() {
  const fromPath = GLib.find_program_in_path("spotdl");
  if (fromPath) return fromPath;

  const directories = [
    GLib.getenv("UV_TOOL_BIN_DIR"),
    GLib.getenv("XDG_BIN_HOME"),
    GLib.build_filenamev([GLib.get_user_data_dir(), "..", "bin"]),
    GLib.build_filenamev([GLib.get_home_dir(), ".local", "bin"]),
  ];
  for (const directory of directories) {
    if (!directory || !GLib.path_is_absolute(directory)) continue;
    const candidate = GLib.canonicalize_filename(
      GLib.build_filenamev([directory, "spotdl"]), null,
    );
    const executable = GLib.find_program_in_path(candidate);
    if (executable) return executable;
  }
  return null;
}
