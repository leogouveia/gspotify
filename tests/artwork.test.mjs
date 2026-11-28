// Run: node --experimental-vm-modules tests/artwork.test.mjs
// GI services are replaced by fakes: no Shell, GPU, network or filesystem.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

class Bytes {
  constructor(data) { this.data = data; }
  get_size() { return this.data?.length ?? 0; }
}

class Cancellable {
  constructor() { this.cancelled = false; }
  cancel() { this.cancelled = true; }
}

function forbiddenFile() {
  throw new Error('artwork code must not touch the filesystem');
}

function fakePixbuf(width, height) {
  return {
    width, height,
    get_width: () => width, get_height: () => height,
    get_has_alpha: () => true, get_n_channels: () => 4,
    get_rowstride: () => width * 4,
    get_pixels: () => new Uint8Array(width * height * 4).fill(200),
    get_colorspace: () => 0,
    scale_simple: (w, h) => fakePixbuf(w, h),
    new_subpixbuf: (_x, _y, w, h) => fakePixbuf(w, h),
    add_alpha: () => fakePixbuf(width, height),
  };
}

async function loadModule(entry, mocks) {
  const context = vm.createContext({ TextEncoder, TextDecoder, console, Promise });
  const modules = new Map();
  async function load(name) {
    if (modules.has(name)) return modules.get(name);
    let mod;
    if (mocks[name] || name.startsWith('gi://') || name.startsWith('resource://')) {
      const values = mocks[name] || { default: {} };
      mod = new vm.SyntheticModule(Object.keys(values), function () {
        for (const [key, value] of Object.entries(values)) this.setExport(key, value);
      }, { context });
    } else {
      const source = await readFile(new URL(`../${name.slice(2)}`, import.meta.url), 'utf8');
      mod = new vm.SourceTextModule(source, {
        context, identifier: name,
        importModuleDynamically: async spec => {
          if (spec in mocks && mocks[spec] === null) throw new Error(`No ${spec}`);
          const dyn = await load(spec);
          if (dyn.status === 'unlinked') await dyn.link(load);
          if (dyn.status === 'linked') await dyn.evaluate();
          return dyn;
        },
      });
    }
    modules.set(name, mod);
    await mod.link(load);
    return mod;
  }
  const mod = await load(entry);
  await mod.evaluate();
  return mod.namespace;
}

function giMocks(extra = {}) {
  return {
    'gi://GLib': { default: { Bytes, PRIORITY_DEFAULT: 0, PRIORITY_DEFAULT_IDLE: 200,
      idle_add: () => 1, Source: { remove() {} }, get_monotonic_time: () => 0 } },
    'gi://Gio': { default: {
      Cancellable,
      IOErrorEnum: { CANCELLED: 19 },
      File: { new_for_path: forbiddenFile, new_for_uri: forbiddenFile },
      MemoryInputStream: { new_from_bytes: data => ({ data }) },
    } },
    'gi://Cogl': { default: { PixelFormat: { RGBA_8888: 'RGBA_8888' } } },
    'gi://St': { default: {} },
    ...extra,
  };
}

test('fitSize keeps the aspect ratio inside the box', async () => {
  const { fitSize } = await loadModule('./artwork.js', giMocks({ 'gi://GdkPixbuf': { default: {} } }));
  assert.deepEqual([...fitSize(640, 640, 128)], [128, 128]);
  assert.deepEqual([...fitSize(1280, 640, 128)], [128, 64]);
  assert.deepEqual([...fitSize(0, 10, 128)], [128, 128]);
});

test('roundCorners clears the corner, keeps the middle and anti-aliases the edge', async () => {
  const { roundCorners } = await loadModule('./artwork.js', giMocks({ 'gi://GdkPixbuf': { default: {} } }));
  const w = 40, h = 30, stride = w * 4;
  const data = roundCorners(new Uint8Array(w * h * 4).fill(255), w, h, stride, 10);
  const alpha = (x, y) => data[y * stride + x * 4 + 3];
  for (const [x, y] of [[0, 0], [w - 1, 0], [0, h - 1], [w - 1, h - 1]])
    assert.equal(alpha(x, y), 0, `corner ${x},${y}`);
  assert.equal(alpha(20, 15), 255, 'centre untouched');
  assert.equal(alpha(20, 0), 255, 'straight edge untouched');
  assert.equal(alpha(2, 2), 0, 'fully outside the arc');
  const edge = alpha(2, 3);
  assert.ok(edge > 0 && edge < 255, `anti-aliased edge, got ${edge}`);
  assert.equal(data[0], 255, 'colour channels untouched');
});

test('decodeArtwork uses Gly from bytes and returns an RGBA pixbuf', async () => {
  const calls = [];
  const frame = {
    get_memory_format: () => 5, get_buf_bytes: () => new Bytes(new Uint8Array(16)),
    get_width: () => 2, get_height: () => 2, get_stride: () => 8,
  };
  const Gly = {
    MemoryFormat: { R8G8B8A8: 5 }, MemoryFormatSelection: { R8G8B8A8: 1 },
    Loader: { new_for_bytes: bytes => {
      calls.push(['new_for_bytes', bytes]);
      return {
        set_accepted_memory_formats: f => calls.push(['formats', f]),
        load_async: (_c, cb) => cb({ load_finish: () => ({
          next_frame_async: (_c2, cb2) => cb2({ next_frame_finish: () => frame }),
        }) }),
      };
    } },
  };
  const GdkPixbuf = {
    Colorspace: { RGB: 0 },
    Pixbuf: {
      new_from_bytes: (...args) => { calls.push(['new_from_bytes', ...args]); return fakePixbuf(2, 2); },
      new_from_stream_async: () => assert.fail('GdkPixbuf loader must not be used when Gly exists'),
    },
  };
  const { decodeArtwork } = await loadModule('./artwork.js',
    giMocks({ 'gi://GdkPixbuf': { default: GdkPixbuf }, 'gi://Gly?version=2': { default: Gly } }));
  const pixbuf = await decodeArtwork(new Uint8Array([1, 2, 3]));
  assert.equal(pixbuf.get_width(), 2);
  assert.equal(calls[0][0], 'new_for_bytes');
  assert.deepEqual(calls[1], ['formats', 1]);
  const [, , colorspace, hasAlpha, bits, width, height, stride] = calls[2];
  assert.deepEqual([colorspace, hasAlpha, bits, width, height, stride], [0, true, 8, 2, 2, 8]);
});

test('decodeArtwork falls back to GdkPixbuf when Gly is unavailable', async () => {
  let used = false;
  const GdkPixbuf = { Pixbuf: {
    new_from_stream_async: (_s, _c, cb) => { used = true; cb(null, 'res'); },
    new_from_stream_finish: () => fakePixbuf(4, 4),
  } };
  const { decodeArtwork } = await loadModule('./artwork.js',
    giMocks({ 'gi://GdkPixbuf': { default: GdkPixbuf }, 'gi://Gly?version=2': null }));
  const pixbuf = await decodeArtwork(new Uint8Array([1]));
  assert.ok(used);
  assert.equal(pixbuf.get_width(), 4);
});

async function uiHarness() {
  const shown = [], fallbacks = [], fetches = [];
  const artworkMock = {
    decodeArtwork: async bytes => fakePixbuf(bytes.get_size(), bytes.get_size()),
    isCancelled: e => e?.cancelled === true,
    fitSize: (w, h, m) => [Math.min(w, m), Math.min(h, m)],
    createImageContent: () => ({}),
    resourceScale: () => 1, themeScale: () => 1,
  };
  const ns = await loadModule('./spotui.js', giMocks({
    'gi://GdkPixbuf': { default: {} },
    './artwork.js': artworkMock,
    './utils.js': { logInfo() {}, logWarn() {}, logError() {}, toggleSpotifyWindow() {} },
    './spotify-helper.js': { toggleLike() {}, isTrackLiked() {} },
    './spotify-auth.js': { getValidAccessToken() {} },
  }));
  const ui = Object.create(ns.SpotifyUI.prototype);
  Object.assign(ui, {
    _destroyed: false, _artworkToken: 0, _artworkCancellable: null,
    _currentArtworkUrl: null,
    _fetchArtwork(url, cancellable) {
      return new Promise((resolve, reject) => fetches.push({ url, cancellable, resolve, reject }));
    },
    _showArtwork(pixbuf) { shown.push(pixbuf.get_width()); },
    _setFallbackArtwork() { fallbacks.push(true); },
  });
  return { ui, shown, fallbacks, fetches };
}

const tick = () => new Promise(resolve => setImmediate(resolve));

test('a late result from a previous track never replaces the current cover', async () => {
  const { ui, shown, fetches } = await uiHarness();
  ui._updateArtwork({ artworkUrl: 'https://a' });
  ui._updateArtwork({ artworkUrl: 'https://b' });
  assert.equal(fetches.length, 2);
  assert.ok(fetches[0].cancellable.cancelled, 'previous request cancelled');
  fetches[1].resolve(new Bytes(new Uint8Array(7)));
  fetches[0].resolve(new Bytes(new Uint8Array(3)));
  await tick(); await tick();
  assert.deepEqual(shown, [7]);
});

test('cancelled or stale failures do not reset the artwork', async () => {
  const { ui, fallbacks, fetches } = await uiHarness();
  ui._updateArtwork({ artworkUrl: 'https://a' });
  ui._updateArtwork({ artworkUrl: 'https://b' });
  fetches[0].reject({ cancelled: true });
  await tick();
  assert.equal(fallbacks.length, 0);
  fetches[1].reject(new Error('HTTP 404'));
  await tick(); await tick();
  assert.equal(fallbacks.length, 1, 'real failure of the current request falls back');
});

test('the same URL is not fetched twice and a missing URL cancels the load', async () => {
  const { ui, fallbacks, fetches } = await uiHarness();
  ui._updateArtwork({ artworkUrl: 'https://a' });
  ui._updateArtwork({ artworkUrl: 'https://a' });
  assert.equal(fetches.length, 1);
  ui._updateArtwork({ artworkUrl: '' });
  assert.ok(fetches[0].cancellable.cancelled);
  assert.equal(fallbacks.length, 1);
  ui._updateArtwork({ artworkUrl: 'https://a' });
  assert.equal(fetches.length, 2, 'returning URL is loaded again');
});

test('nothing is shown after the UI is destroyed', async () => {
  const { ui, shown, fetches } = await uiHarness();
  ui._updateArtwork({ artworkUrl: 'https://a' });
  ui._destroyed = true;
  ui._cancelArtworkLoad();
  assert.ok(fetches[0].cancellable.cancelled);
  fetches[0].resolve(new Bytes(new Uint8Array(5)));
  await tick(); await tick();
  assert.deepEqual(shown, []);
});

test('decodeArtwork falls back to GdkPixbuf if Gly fails, but not if cancelled', async () => {
  let fallbacks = 0;
  const failing = cancelled => ({
    MemoryFormat: { R8G8B8A8: 5 }, MemoryFormatSelection: { R8G8B8A8: 1 },
    Loader: { new_for_bytes: () => ({
      set_accepted_memory_formats() {},
      load_async: (_c, cb) => cb({ load_finish: () => { throw cancelled ? { cancelled: true, matches: () => true } : new Error('sandbox'); } }),
    }) },
  });
  const GdkPixbuf = { Pixbuf: {
    new_from_stream_async: (_s, _c, cb) => { fallbacks++; cb(null, 'res'); },
    new_from_stream_finish: () => fakePixbuf(3, 3),
  } };
  let mod = await loadModule('./artwork.js',
    giMocks({ 'gi://GdkPixbuf': { default: GdkPixbuf }, 'gi://Gly?version=2': { default: failing(false) } }));
  assert.equal((await mod.decodeArtwork(new Uint8Array([1]))).get_width(), 3);
  assert.equal(fallbacks, 1);
  mod = await loadModule('./artwork.js',
    giMocks({ 'gi://GdkPixbuf': { default: GdkPixbuf }, 'gi://Gly?version=2': { default: failing(true) } }));
  await assert.rejects(mod.decodeArtwork(new Uint8Array([1])));
  assert.equal(fallbacks, 1, 'cancellation is not retried');
});

test('a missing artwork URL resets the card only once', async () => {
  const { ui, fallbacks } = await uiHarness();
  ui._setFallbackArtwork = function () { this._showingFallbackArtwork = true; fallbacks.push(true); };
  for (let i = 0; i < 5; i++) ui._updateArtwork({ artworkUrl: '' });
  assert.equal(fallbacks.length, 1);
});
