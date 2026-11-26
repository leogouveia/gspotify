// Album-art decoding and display helpers that never touch the filesystem.
//
// Why this module exists: with gdk-pixbuf >= 2.43 built against glycin, every
// GdkPixbufLoader (new_from_stream*, and St's CSS `background-image` decoding)
// writes the image to /tmp/gdk-pixbuf-glycin-tmp.XXXXXX and deletes it with a
// synchronous g_file_delete(). Under GVfs that delete performs a synchronous
// D-Bus round trip to gvfsd-metadata (GetTreeFromDevice, 25 s default
// timeout) on the calling thread. Inside gnome-shell that is the compositor
// thread, so a stuck gvfsd-metadata froze the whole screen. The `_async`
// GdkPixbuf variant does not help: it feeds the loader from the main loop.
//
// Here artwork is decoded with glycin's own API (Gly, from bytes, async; no
// temporary files) and displayed as raw pixels through St.ImageContent.

import GLib from "gi://GLib";
import Gio from "gi://Gio";
import GdkPixbuf from "gi://GdkPixbuf";
import Cogl from "gi://Cogl";
import St from "gi://St";

let glyModule;

// Gly 2 ships with glycin 2.x (GNOME 49+ era). Older systems fall back to
// GdkPixbuf, which there predates glycin and therefore uses no temp files.
async function getGly() {
  if (glyModule === undefined) {
    try {
      glyModule = (await import("gi://Gly?version=2")).default;
    } catch (_e) {
      glyModule = null;
    }
  }
  return glyModule;
}

function glyCall(object, method, cancellable) {
  return new Promise((resolve, reject) => {
    object[`${method}_async`](cancellable, (source, result) => {
      try {
        resolve(source[`${method}_finish`](result));
      } catch (e) {
        reject(e);
      }
    });
  });
}

async function decodeWithGly(Gly, bytes, cancellable) {
  const loader = Gly.Loader.new_for_bytes(bytes);
  loader.set_accepted_memory_formats(Gly.MemoryFormatSelection.R8G8B8A8);
  const image = await glyCall(loader, "load", cancellable);
  const frame = await glyCall(image, "next_frame", cancellable);
  if (frame.get_memory_format() !== Gly.MemoryFormat.R8G8B8A8)
    throw new Error(`Unexpected memory format ${frame.get_memory_format()}`);

  return GdkPixbuf.Pixbuf.new_from_bytes(
    frame.get_buf_bytes(),
    GdkPixbuf.Colorspace.RGB,
    true,
    8,
    frame.get_width(),
    frame.get_height(),
    frame.get_stride(),
  );
}

function decodeWithGdkPixbuf(bytes, cancellable) {
  return new Promise((resolve, reject) => {
    const stream = Gio.MemoryInputStream.new_from_bytes(bytes);
    GdkPixbuf.Pixbuf.new_from_stream_async(stream, cancellable, (_src, res) => {
      try {
        resolve(GdkPixbuf.Pixbuf.new_from_stream_finish(res));
      } catch (e) {
        reject(e);
      }
    });
  });
}

/**
 * Decode encoded image bytes (JPEG/PNG/...) into an RGBA GdkPixbuf.
 *
 * @param {GLib.Bytes|Uint8Array} data encoded image
 * @param {Gio.Cancellable|null} cancellable
 * @returns {Promise<GdkPixbuf.Pixbuf>} pixbuf with an alpha channel
 */
export async function decodeArtwork(data, cancellable = null) {
  const bytes = data instanceof GLib.Bytes ? data : new GLib.Bytes(data);
  const Gly = await getGly();
  let pixbuf = null;
  if (Gly) {
    try {
      pixbuf = await decodeWithGly(Gly, bytes, cancellable);
    } catch (e) {
      // Keep the cover working if glycin cannot run here; GdkPixbuf is the
      // pre-existing behaviour, only used as a last resort.
      if (isCancelled(e)) throw e;
    }
  }
  pixbuf ??= await decodeWithGdkPixbuf(bytes, cancellable);
  return pixbuf.get_has_alpha() ? pixbuf : pixbuf.add_alpha(false, 0, 0, 0);
}

export function isCancelled(error) {
  return error?.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED) ?? false;
}

/** Largest size with the same aspect ratio that fits in a max×max box. */
export function fitSize(width, height, max) {
  if (width <= 0 || height <= 0) return [max, max];
  const factor = Math.min(max / width, max / height);
  return [
    Math.max(1, Math.round(width * factor)),
    Math.max(1, Math.round(height * factor)),
  ];
}

/**
 * Multiply the alpha of a non-premultiplied RGBA buffer so its corners are
 * rounded with an anti-aliased edge. Only the four corner squares are touched.
 */
export function roundCorners(data, width, height, stride, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  if (r <= 0) return data;
  const size = Math.ceil(r);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = r - (x + 0.5);
      const dy = r - (y + 0.5);
      if (dx <= 0 || dy <= 0) continue;
      const coverage = Math.max(0, Math.min(1, r - Math.hypot(dx, dy) + 0.5));
      if (coverage >= 1) continue;

      for (const [cx, cy] of [
        [x, y],
        [width - 1 - x, y],
        [x, height - 1 - y],
        [width - 1 - x, height - 1 - y],
      ]) {
        const i = cy * stride + cx * 4 + 3;
        data[i] = Math.round(data[i] * coverage);
      }
    }
  }
  return data;
}

/**
 * Scale a pixbuf to width×height, round its corners and return a new
 * St.ImageContent holding the pixels.
 */
export function createImageContent(pixbuf, width, height, radius) {
  const scaled =
    pixbuf.get_width() === width && pixbuf.get_height() === height
      ? pixbuf
      : pixbuf.scale_simple(width, height, GdkPixbuf.InterpType.BILINEAR);
  const stride = scaled.get_rowstride();
  const pixels = roundCorners(scaled.get_pixels(), width, height, stride, radius);

  const content = St.ImageContent.new_with_preferred_size(width, height);
  setContentBytes(content, new GLib.Bytes(pixels), width, height, stride);
  return content;
}

// St.ImageContent.set_bytes() gained a leading CoglContext in GNOME 48.
function setContentBytes(content, bytes, width, height, stride) {
  const format = Cogl.PixelFormat.RGBA_8888;
  const coglContext = global.stage?.context
    ?.get_backend?.()
    ?.get_cogl_context?.();

  if (coglContext) {
    try {
      content.set_bytes(coglContext, bytes, format, width, height, stride);
      return;
    } catch (e) {
      if (!(e instanceof TypeError)) throw e;
    }
  }
  content.set_bytes(bytes, format, width, height, stride);
}

/** Device pixels per actor unit (> 1 with fractional/HiDPI stage views). */
export function resourceScale(actor) {
  return Math.max(1, actor?.get_resource_scale?.() ?? 1);
}

/** Actor units per CSS px (St multiplies stylesheet lengths by this). */
export function themeScale() {
  return Math.max(
    1,
    St.ThemeContext.get_for_stage(global.stage)?.scale_factor ?? 1,
  );
}
