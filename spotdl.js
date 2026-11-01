import Gio from "gi://Gio";
import GLib from "gi://GLib";

import { findSpotDL } from "./spotdl-path.js";
import { logInfo, logWarn } from "./utils.js";

export class SpotDLExecutor {
  constructor() {
    this.cancellable = new Gio.Cancellable();
  }

  downloadSong(metadata, onOutput, onComplete) {
    const args = [];

    if (metadata.output) {
      args.push("--output", metadata.output);
    }

    args.push("--simple-tui");

    if (metadata.url) {
      args.push(metadata.url);
    } else if (metadata.query) {
      args.push(metadata.query);
    }

    this._executeCommand(args, onOutput, onComplete);
  }

  executeCustomCommand(args, onOutput, onComplete) {
    this._executeCommand(args, onOutput, onComplete);
  }

  _executeCommand(args, onOutput, onComplete) {
    try {
      const executable = this.executablePath;
      if (!executable) throw new Error("SpotDL executable not found");
      const command = [executable, ...args];
      logInfo("Executing command", command);
      let proc = Gio.Subprocess.new(
        command,
        Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
      );

      this._readStream(proc.get_stdout_pipe(), "STDOUT", onOutput);

      this._readStream(proc.get_stderr_pipe(), "STDERR", onOutput);

      proc.wait_async(this.cancellable, (proc, result) => {
        try {
          proc.wait_finish(result);
          let exitCode = proc.get_exit_status();

          if (onComplete) {
            onComplete({
              success: exitCode === 0,
              exitCode: exitCode,
            });
          }
        } catch (e) {
          if (onComplete) {
            onComplete({
              success: false,
              error: e.message,
            });
          }
          logWarn(e, "Process wait failed");
        }
      });
    } catch (e) {
      if (onOutput) {
        onOutput({
          type: "ERROR",
          message: `Failed to start process: ${e.message}`,
        });
      }
      if (onComplete) {
        onComplete({ success: false, error: e.message });
      }
      logWarn(e, "Failed to execute command");
    }
  }

  _readStream(stream, type, onOutput) {
    if (!stream || !onOutput) return;

    let dataInputStream = new Gio.DataInputStream({
      base_stream: stream,
      close_base_stream: true,
    });

    this._readLineAsync(dataInputStream, type, onOutput);
  }

  _readLineAsync(dataInputStream, type, onOutput) {
    dataInputStream.read_line_async(
      GLib.PRIORITY_DEFAULT,
      this.cancellable,
      (stream, result) => {
        try {
          let [line] = stream.read_line_finish_utf8(result);

          if (line !== null) {
            onOutput({
              type: type,
              message: line,
            });

            this._readLineAsync(dataInputStream, type, onOutput);
          }
        } catch (e) {
          if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) {
            logWarn(e, "Error reading stream");
          }
        }
      },
    );
  }

  cancel() {
    this.cancellable.cancel();
    this.cancellable = new Gio.Cancellable();
  }

  get executablePath() {
    return findSpotDL();
  }

  checkSpotDLInstalled(callback) {
    callback(this.executablePath !== null);
  }

  destroy() {
    this.cancel();
  }
}
