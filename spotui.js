import St from "gi://St";
import Clutter from "gi://Clutter";
import Gio from "gi://Gio";
import GLib from "gi://GLib";
import GdkPixbuf from "gi://GdkPixbuf";
import Pango from "gi://Pango";

import { toggleSpotifyWindow, logWarn, logInfo } from "./utils.js";
import { toggleLike, isTrackLiked } from "./spotify-helper.js";
import { getValidAccessToken } from "./spotify-auth.js";

export class SpotifyUI {
  constructor(indicator, extension, onColorUpdate = null) {
    this._indicator = indicator;
    this._extension = extension;
    this._settings = extension._settings;
    this._onColorUpdate = onColorUpdate;
    this._currentColors = null;
    this._readableTextColor = null;
    this._currentArtworkUrl = null;
    this._isPlaying = false;
    this._progressTimeout = null;
    this._lastUpdateTime = null;
    this._currentPosition = 0;
    this._duration = 0;
    this._shuffleState = false;
    this._currentTrackId = null;
    this._isLiked = false;
    this._isSpotifyConnected = false;

    this.useFixedWidth = extension._settings.get_boolean("use-fixed-width");
    this.fixedWidth = extension._settings.get_int("ui-width");

    this._widthChangedId = this._settings.connect("changed::ui-width", () => {
      this._onWidthSettingsChanged();
    });

    this._useFixedWidthChangedId = this._settings.connect(
      "changed::use-fixed-width",
      () => {
        this._onWidthSettingsChanged();
      },
    );

    this._buildUI();
  }

  _buildUI() {
    this.container = new St.BoxLayout({
      style_class: "spotify-card",
      orientation: Clutter.Orientation.VERTICAL,
      width: this._getCardWidth(),
      x_expand: false,
      y_expand: false,
    });

    this.container.connect("destroy", () => this.destroy());
    this._buildHeader();
    this._buildPlaybackControls();
    this._buildProgressBar();

    this._separator = new St.Widget({
      style_class: "spotify-separator",
      x_expand: true,
      y_expand: false,
    });
    this.container.add_child(this._separator);

    this._buildAdditionalControls();
  }

  _buildHeader() {
    this._headerBox = new St.BoxLayout({
      style_class: "spotify-header",
      orientation: Clutter.Orientation.HORIZONTAL,
      x_align: Clutter.ActorAlign.FILL,
      x_expand: true,
    });

    this._buildArtworkSection();
    this._buildInfoSection();

    this.container.add_child(this._headerBox);
  }

  _buildArtworkSection() {
    this._artwork = new St.Bin({
      style_class: "spotify-artwork",
      width: 96,
      height: 96,
    });
    this._headerBox.add_child(this._artwork);
  }

  _buildPlaybackControls() {
    this._playbackControls = new St.BoxLayout({
      style_class: "spotify-playback-controls",
      x_align: Clutter.ActorAlign.CENTER,
      y_align: Clutter.ActorAlign.CENTER,
    });
    this._buildPrevButton();
    this._playIcon = new St.Icon({
      icon_name: "media-playback-start-symbolic",
      icon_size: 24,
    });
    this._playButton = new St.Button({
      x_align: Clutter.ActorAlign.CENTER,
      y_align: Clutter.ActorAlign.CENTER,
      style_class: "spotify-button spotify-play-button",
      accessible_name: "Play",
      child: this._playIcon,
    });
    this._playButton.connect("clicked", () => this._onPlayPause());
    this._playbackControls.add_child(this._playButton);
    this._buildNextButton();
    this.container.add_child(this._playbackControls);
  }

  _buildPrevButton() {
    this._prevButton = new St.Button({
      x_align: Clutter.ActorAlign.CENTER,
      y_align: Clutter.ActorAlign.CENTER,
      style_class: "spotify-button",
      child: new St.Icon({
        icon_name: "media-skip-backward-symbolic",
        icon_size: 16,
      }),
    });
    this._prevButton.connect("clicked", () => this._control("previous"));
    this._prevButton.accessible_name = "Previous track";
    this._playbackControls.add_child(this._prevButton);
  }

  _buildInfoSection() {
    const infoBoxWidth = this._getCardWidth() - 96 - 18 - 36;
    this._infoBox = new St.BoxLayout({
      style_class: "spotify-info-box",
      orientation: Clutter.Orientation.VERTICAL,
      width: infoBoxWidth,
      x_expand: true,
      x_align: Clutter.ActorAlign.FILL,
      y_align: Clutter.ActorAlign.CENTER,
      reactive: true,
      track_hover: true,
    });

    this._infoBox.add_child(new St.Label({
      style_class: "spotify-source",
      text: "SPOTIFY",
    }));
    this._titleLabel = new St.Label({
      style_class: "spotify-title",
      text: "No track playing",
      x_expand: true,
      x_align: Clutter.ActorAlign.FILL,
    });

    this._titleLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
    this._titleLabel.clutter_text.line_wrap = false;
    this._infoBox.add_child(this._titleLabel);

    this._artistLabel = new St.Label({
      style_class: "spotify-artist",
      text: "",
      x_expand: true,
      x_align: Clutter.ActorAlign.FILL,
    });
    this._artistLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
    this._artistLabel.clutter_text.line_wrap = false;
    this._infoBox.add_child(this._artistLabel);

    this._infoBoxClickId = this._infoBox.connect("button-press-event", () => {
      if (this._currentMetadata?.url) {
        const clipboard = St.Clipboard.get_default();
        clipboard.set_text(
          St.ClipboardType.CLIPBOARD,
          this._currentMetadata.url,
        );
        this._extension.sendOSDMessage(
          "Copied Spotify URL for " + this._currentMetadata.title,
          "edit-copy-symbolic",
        );
      } else {
        this._extension.sendOSDMessage("URL Not Found", "edit-copy-symbolic");
      }
      return Clutter.EVENT_STOP;
    });

    this._headerBox.add_child(this._infoBox);
  }

  _buildNextButton() {
    this._nextButton = new St.Button({
      x_align: Clutter.ActorAlign.CENTER,
      y_align: Clutter.ActorAlign.CENTER,
      style_class: "spotify-button",
      child: new St.Icon({
        icon_name: "media-skip-forward-symbolic",
        icon_size: 16,
      }),
    });
    this._nextButton.connect("clicked", () => this._control("next"));
    this._nextButton.accessible_name = "Next track";
    this._playbackControls.add_child(this._nextButton);
  }

  _buildProgressBar() {
    this._progressBox = new St.BoxLayout({
      style_class: "spotify-progress-section",
      orientation: Clutter.Orientation.VERTICAL,
      x_expand: true,
    });
    this._progressBarContainer = new St.Widget({
      style_class: "spotify-progress-bar",
      x_expand: true,
      reactive: true,
    });

    this._progressTrack = new St.Widget({ style_class: "spotify-progress-track" });
    this._progressTrack.set_position(0, 5);
    this._progressBarContainer.add_child(this._progressTrack);
    this._progressFilled = new St.Widget({
      style_class: "spotify-progress-filled",
      height: 4,
    });
    this._progressFilled.set_position(0, 5);
    this._progressBarContainer.add_child(this._progressFilled);

    this._progressHandle = new St.Widget({
      style_class: "spotify-progress-handle",
      style:
        "width: 10px; height: 10px; border-radius: 20px; background-color: white;",
      reactive: true,
    });
    this._progressHandle.set_position(-5, 2);
    this._progressBarContainer.add_child(this._progressHandle);

    this._isDragging = false;

    this._progressBarContainer.connect("button-press-event", (actor, event) => {
      this._isDragging = true;
      this._dragStartPosition = this._currentPosition;
      this._stopProgressUpdate();
      this._updateFromEvent(actor, event);
      return Clutter.EVENT_STOP;
    });

    this._progressBarContainer.connect("motion-event", (actor, event) => {
      if (!this._isDragging) return Clutter.EVENT_PROPAGATE;
      this._updateFromEvent(actor, event);
      return Clutter.EVENT_STOP;
    });

    this._progressBarContainer.connect(
      "button-release-event",
      (actor, event) => {
        if (this._isDragging) {
          const newPosition = this._calculateProgressPosition(actor, event);
          this._currentPosition = newPosition;
          this._lastUpdateTime = GLib.get_monotonic_time() / 1000;
          this._isSeeking = true;

          try {
            if (this._mprisTrackId) {
              this._indicator._dbus.setPosition(
                this._mprisTrackId,
                newPosition,
              );
            } else {
              const deltaMs = newPosition - this._currentPosition;
              this._indicator._dbus.seek(deltaMs);
            }
          } catch (e) {
            logWarn("Failed to set position via DBus:", e);
          }
          this._isDragging = false;

          if (this._seekClearTimeout)
            GLib.Source.remove(this._seekClearTimeout);
          this._seekClearTimeout = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            1500,
            () => {
              this._isSeeking = false;
              this._seekClearTimeout = null;
              return GLib.SOURCE_REMOVE;
            },
          );

          if (this._isPlaying) this._startProgressUpdate();
        }
        return Clutter.EVENT_STOP;
      },
    );

    this._progressBox.add_child(this._progressBarContainer);
    const times = new St.BoxLayout({ style_class: "spotify-progress-times" });
    this._elapsedLabel = new St.Label({ text: "0:00" });
    this._durationLabel = new St.Label({ text: "0:00" });
    times.add_child(this._elapsedLabel);
    times.add_child(new St.Widget({ x_expand: true }));
    times.add_child(this._durationLabel);
    this._progressBox.add_child(times);
    this.container.add_child(this._progressBox);
    this._progressWidthChangedId = this._progressBarContainer.connect(
      "notify::width", () => this._updateProgressBar(),
    );
  }

  _calculateProgressPosition(actor, event) {
    if (this._duration <= 0) return 0;

    const [eventX] = event.get_coords();
    const [actorX] = actor.get_transformed_position();
    const barWidth = actor.width;
    const clickX = eventX - actorX;

    const progress = Math.max(0, Math.min(1, clickX / barWidth));
    return Math.floor(progress * this._duration);
  }

  _updateFromEvent(actor, event) {
    const newPosition = this._calculateProgressPosition(actor, event);
    this._currentPosition = newPosition;
    this._updateProgressBar();
  }

  _onProgressBarDragged(actor, event) {
    if (this._duration <= 0) return;

    const newPosition = this._calculateProgressPosition(actor, event);

    // update ui
    this._currentPosition = newPosition;
    this._updateProgressBar();
  }

  _buildAdditionalControls() {
    this._additionalControls = new St.BoxLayout({
      style_class: "spotify-additional-controls",
      orientation: Clutter.Orientation.HORIZONTAL,
      x_align: Clutter.ActorAlign.FILL,
    });

    this.container.add_child(this._additionalControls);

    this._controls = {
      shuffle: this._buildShuffleButton(),
      spotify: this._buildSpotifyToggleButton(),
      spacer: this._buildSpacerLabel(),
      download: this._buildDownloadButton(),
      settings: this._buildSettingsButton(),
      like: this._buildLikeButton(),
      close: this._buildCloseButton(),
    };

    this._rebuildAdditionalControls();

    this._controlsOrderChangedId = this._settings.connect(
      "changed::additional-controls-order",
      () => {
        this._rebuildAdditionalControls();
      },
    );
  }

  _rebuildAdditionalControls() {
    this._additionalControls.remove_all_children();

    const order = this._settings.get_strv("additional-controls-order") || [
      "settings",
      "download",
      "spacer",
      "spotify",
      "close",
    ];

    for (const key of order) {
      const actor = this._controls[key];
      if (actor) {
        this._additionalControls.add_child(actor);
      }
    }
  }

  _buildSpacerLabel() {
    this._spacerLabel = new St.Label({
      text: "",
      style_class: "spotify-spacer-label",
      x_align: Clutter.ActorAlign.CENTER,
      y_align: Clutter.ActorAlign.CENTER,
      x_expand: true,
    });

    return this._spacerLabel;
  }

  _buildShuffleButton() {
    this._shuffleButton = new St.Button({
      x_align: Clutter.ActorAlign.CENTER,
      y_align: Clutter.ActorAlign.CENTER,
      style_class: "spotify-button-secondary",
      child: new St.Icon({
        icon_name: "media-playlist-shuffle-symbolic",
        icon_size: 16,
      }),
    });

    this._shuffleButton.connect("clicked", () => this._updateShuffleState());
    return this._shuffleButton;
  }

  _buildSpotifyToggleButton() {
    this._spotifyToggleButton = new St.Button({
      x_align: Clutter.ActorAlign.CENTER,
      y_align: Clutter.ActorAlign.CENTER,
      style_class: "spotify-button-secondary",
      child: new St.Icon({
        icon_name: "view-reveal-symbolic",
        icon_size: 16,
      }),
    });

    this._spotifyToggleButton.connect("clicked", () => toggleSpotifyWindow());
    return this._spotifyToggleButton;
  }

  _buildCloseButton() {
    this._closeButton = new St.Button({
      x_align: Clutter.ActorAlign.CENTER,
      y_align: Clutter.ActorAlign.CENTER,
      style_class: "spotify-close-button",
      child: new St.Icon({
        icon_name: "process-stop-symbolic",
        icon_size: 16,
      }),
    });
    this._closeButton.connect("clicked", () => toggleSpotifyWindow("close"));
    return this._closeButton;
  }

  _buildSettingsButton() {
    this._settingsButton = new St.Button({
      x_align: Clutter.ActorAlign.CENTER,
      y_align: Clutter.ActorAlign.CENTER,
      style_class: "spotify-button-secondary",
      child: new St.Icon({
        icon_name: "preferences-system-symbolic",
        icon_size: 16,
      }),
    });

    this._settingsButton.connect("clicked", () => {
      this._indicator.menu._getTopMenu().close();
      this._extension.openPreferences();
    });

    return this._settingsButton;
  }

  _buildDownloadButton() {
    this._downloadButton = new St.Button({
      x_align: Clutter.ActorAlign.CENTER,
      y_align: Clutter.ActorAlign.CENTER,
      style_class: "spotify-button-secondary",
      child: new St.Icon({
        icon_name: "folder-download-symbolic",
        icon_size: 16,
      }),
    });
    this._downloadButton.connect("clicked", () => {
      this._extension.downloadTrack();
    });

    return this._downloadButton;
  }

  _buildLikeButton() {
    this._likeButton = new St.Button({
      x_align: Clutter.ActorAlign.CENTER,
      y_align: Clutter.ActorAlign.CENTER,
      style_class: "spotify-button-secondary",
      child: new St.Icon({
        gicon: Gio.Icon.new_for_string(
          `${this._extension.path}/icons/heart-outline-thin-symbolic.svg`,
        ),
        icon_size: 20,
      }),
    });

    this._likeButton.connect("clicked", () => {
      this._onLikeButtonClicked();
    });
    return this._likeButton;
  }

  async _checkSpotifyConnection() {
    try {
      const accessToken = await getValidAccessToken();
      this._isSpotifyConnected = accessToken && accessToken.length > 0;
    } catch (e) {
      this._isSpotifyConnected = false;
    }
  }

  async _onLikeButtonClicked() {
    logInfo("Spotify Connection Status:", this._isSpotifyConnected);
    if (!this._isSpotifyConnected) {
      this._extension.sendOSDMessage(
        "Connect Spotify account from extension's setting to like songs",
        "dialog-warning-symbolic",
      );
    }

    if (!this._currentTrackId) {
      this._extension.sendOSDMessage(
        "No track playing",
        "dialog-error-symbolic",
      );
      return;
    }

    try {
      this._likeButton.reactive = false;
      const newLikedState = await toggleLike(this._currentTrackId);
      this._isLiked = newLikedState;

      this._updateLikeButtonIcon();
      const message = newLikedState
        ? "Added to Liked Songs"
        : "Removed from Liked Songs";
      const icon = newLikedState
        ? "emote-love-symbolic"
        : "list-remove-symbolic";
      this._extension.sendOSDMessage(message, icon);
    } catch (e) {
      logWarn("Failed to toggle like state:", e);
      this._extension.sendOSDMessage(
        "Access token may have expired. Reconnect in settings",
        "dialog-error-symbolic",
      );
    } finally {
      this._likeButton.reactive = true;
    }
  }

  _updateLikeButtonIcon() {
    if (!this._likeButton) return;
    const iconPath = this._isLiked
      ? "emote-love-symbolic"
      : `${this._extension.path}/icons/heart-outline-thin-symbolic.svg`;

    this._likeButton.child.gicon = Gio.Icon.new_for_string(iconPath);

    if (this._readableTextColor) {
      this._likeButton.style = `color: ${this._readableTextColor};`;
    }
  }

  _extractTrackIdFromUrl(url) {
    if (!url) return null;

    if (url.startsWith("spotify:track:")) {
      return url.split(":")[2];
    }

    const match = url.match(/spotify\.com\/track\/([a-zA-Z0-9]+)/);
    return match ? match[1] : null;
  }

  _onPlayPause() {
    this._control("playpause");
  }

  _syncPlayButton() {
    this._playIcon.icon_name = this._isPlaying
      ? "media-playback-pause-symbolic"
      : "media-playback-start-symbolic";
    this._playButton.accessible_name = this._isPlaying ? "Pause" : "Play";
  }

  _control(action) {
    if (this._extension?.control) {
      this._extension.control(action);
    }
  }

  async update(metadata) {
    if (!metadata?.success) return;

    await this._checkSpotifyConnection();
    this._currentMetadata = metadata;

    this._updateText(metadata);
    this._updateProgress(metadata);
    this._updatePlayState(metadata);
    this._updateArtwork(metadata);
    this._shuffleState = metadata.shuffle;
    this._updateShuffleButton();

    if (metadata.url) {
      const trackId = this._extractTrackIdFromUrl(metadata.url);
      this._mprisTrackId =
        metadata.trackId || "/org/mpris/MediaPlayer2/TrackList/NoTrack";
      if (trackId && trackId !== this._currentTrackId) {
        this._currentTrackId = trackId;
        await this._checkLikeStatus();
        this._updateLikeButtonIcon();
      }
    } else {
      this._currentTrackId = null;
      this._isLiked = false;
      this._updateLikeButtonIcon();
    }
  }

  async _checkLikeStatus() {
    if (!this._currentTrackId) {
      return false;
    }

    if (!this._isSpotifyConnected) {
      this._isLiked = false;
      this._updateLikeButtonIcon();
      return false;
    }

    try {
      this._isLiked = await isTrackLiked(this._currentTrackId);
      this._updateLikeButtonIcon();
      return this._isLiked;
    } catch (e) {
      logWarn("Failed to check like status:", e);

      this._isSpotifyConnected = false;
      this._isLiked = false;
      this._updateLikeButtonIcon();
      return false;
    }
  }

  _updateShuffleState() {
    this._shuffleState = this._indicator._dbus.toggleShuffle();

    this._updateShuffleButton();
  }

  _updateShuffleButton() {
    if (this._shuffleState) {
      this._shuffleButton.add_style_pseudo_class("active");
    } else {
      this._shuffleButton.remove_style_pseudo_class("active");
    }
  }

  _updateText(metadata) {
    if (!metadata.title) {
      this._titleLabel.text = "Spotify";
      this._artistLabel.text = "Unknown Artist";
      return;
    }
    this._titleLabel.text = metadata.title;
    this._artistLabel.text = metadata.artist || "Unknown Artist";
  }

  _updateProgress(metadata) {
    const position = metadata.position_ms || 0;
    const duration = metadata.duration_ms || 0;

    this._duration = duration;

    if (!this._isSeeking) {
      this._currentPosition = position;
      this._lastUpdateTime = GLib.get_monotonic_time() / 1000;
    }

    this._updateProgressBar();

    if (this._isPlaying) {
      this._startProgressUpdate();
    }
  }

  _formatTime(milliseconds) {
    const seconds = Math.max(0, Math.floor(milliseconds / 1000));
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  }

  _updateProgressBar() {
    const position = Math.max(0, Math.min(this._currentPosition, this._duration));
    const progress = this._duration > 0 ? position / this._duration : 0;
    const barWidth = this._progressBarContainer.width;
    const filledWidth = Math.floor(progress * barWidth);
    this._progressTrack.width = barWidth;
    this._progressFilled.width = filledWidth;
    this._progressHandle.set_position(filledWidth - 5, 2);
    this._elapsedLabel.text = this._formatTime(position);
    this._durationLabel.text = this._formatTime(this._duration);
  }

  _startProgressUpdate() {
    this._stopProgressUpdate();

    this._progressTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
      if (!this._isPlaying) {
        this._progressTimeout = null;
        return GLib.SOURCE_REMOVE;
      }

      const currentTime = GLib.get_monotonic_time() / 1000;
      const elapsed = currentTime - this._lastUpdateTime;

      this._currentPosition += elapsed;
      this._lastUpdateTime = currentTime;

      if (this._currentPosition >= this._duration) {
        this._currentPosition = this._duration;
        this._updateProgressBar();
        this._progressTimeout = null;
        return GLib.SOURCE_REMOVE;
      }

      this._updateProgressBar();
      return GLib.SOURCE_CONTINUE;
    });
  }

  _stopProgressUpdate() {
    if (this._progressTimeout) {
      GLib.Source.remove(this._progressTimeout);
      this._progressTimeout = null;
    }
  }

  _updatePlayState(metadata) {
    const wasPlaying = this._isPlaying;
    this._isPlaying = metadata.isPlaying || false;
    this._syncPlayButton();

    if (this._isPlaying && !wasPlaying) {
      this._lastUpdateTime = GLib.get_monotonic_time() / 1000;
      this._startProgressUpdate();
    } else if (!this._isPlaying && wasPlaying) {
      this._stopProgressUpdate();
    }
  }

  _updateArtwork(metadata) {
    if (
      metadata.artworkUrl &&
      metadata.artworkUrl !== this._currentArtworkUrl
    ) {
      this._currentArtworkUrl = metadata.artworkUrl;
      this._loadArtwork(metadata.artworkUrl);
    } else if (!metadata.artworkUrl) {
      this._artwork.style = "border-radius: 10px; background-color: #333333;";
    }
  }

  _loadArtwork(url) {
    try {
      if (url.startsWith("file://")) {
        this._loadLocalArtwork(url);
      } else if (url.startsWith("http://") || url.startsWith("https://")) {
        this._loadArtworkFromUrl(url);
      }
    } catch (e) {
      logWarn("Failed to load artwork");
      this._setFallbackArtwork();
    }
  }

  _loadLocalArtwork(url) {
    const file = Gio.File.new_for_uri(url);
    file.load_contents_async(null, (src, res) => {
      try {
        const [success, bytes] = src.load_contents_finish(res);
        if (!success) throw new Error("Failed to load file");
        this._setArtworkFromBytes(bytes);
      } catch (e) {
        logWarn("Failed to load local artwork");
        this._setFallbackArtwork();
      }
    });
  }

  _loadArtworkFromUrl(url) {
    const file = Gio.File.new_for_uri(url);
    file.load_contents_async(null, (src, res) => {
      try {
        const [success, bytes] = src.load_contents_finish(res);
        if (!success) throw new Error("Failed to load contents from URL");
        this._setArtworkFromBytes(bytes);
      } catch (e) {
        logWarn("Failed to load artwork from URL");
        this._setFallbackArtwork();
      }
    });
  }

  _setArtworkFromBytes(bytes) {
    try {
      const tempDir = GLib.get_tmp_dir();
      const tempFile = GLib.build_filenamev([
        tempDir,
        "gnome-spotify-artwork.jpg",
      ]);

      const file = Gio.File.new_for_path(tempFile);
      const stream = file.replace(null, false, Gio.FileCreateFlags.NONE, null);

      stream.write_bytes(GLib.Bytes.new(bytes), null);
      stream.close(null);

      const fileUri = file.get_uri();
      this._artwork.style = `background-image: url("${fileUri}");`;

      if (this._settings.get_boolean("artwork-themed-ui")) {
        const colorData = this._getColorPaletteFromBytes(bytes);
        if (colorData) {
          this._currentColors = colorData;
          this._applyArtworkColor(
            colorData.main,
            colorData.accent,
            colorData.theme,
          );
        }
      }
    } catch (e) {
      logWarn("Failed to set artwork from bytes");
      this._setFallbackArtwork();
    }
  }

  _setFallbackArtwork() {
    this._artwork.style = "border-radius: 10px; background-color: #333333;";
  }

  _getColorPaletteFromBytes(bytes) {
    try {
      const stream = Gio.MemoryInputStream.new_from_bytes(
        GLib.Bytes.new(bytes),
      );
      const pixbuf = GdkPixbuf.Pixbuf.new_from_stream_at_scale(
        stream,
        16,
        16,
        true,
        null,
      );

      if (!pixbuf) return null;

      const pixels = pixbuf.get_pixels();
      const hasAlpha = pixbuf.get_has_alpha();
      const rowstride = pixbuf.get_rowstride();
      const width = pixbuf.get_width();
      const height = pixbuf.get_height();

      let r = 0,
        g = 0,
        b = 0;
      let count = 0;

      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const offset = y * rowstride + x * (hasAlpha ? 4 : 3);
          r += pixels[offset];
          g += pixels[offset + 1];
          b += pixels[offset + 2];
          count++;
        }
      }

      if (count > 0) {
        const mainColor = {
          r: Math.round(r / count),
          g: Math.round(g / count),
          b: Math.round(b / count),
        };

        const accentColor = this._getAccentColor(mainColor);

        return {
          main: mainColor,
          accent: accentColor,
          theme: this._getThemeColor(mainColor, accentColor),
        };
      }
    } catch (e) {
      logWarn("Failed to get color palette");
    }
    return null;
  }

  _getAccentColor(color) {
    return {
      r: 255 - color.r,
      g: 255 - color.g,
      b: 255 - color.b,
    };
  }

  _getThemeColor(main, accent, ratio = 0.3) {
    if (!main || !accent) return null;

    return {
      r: Math.floor(main.r * (1 - ratio) + accent.r * ratio),
      g: Math.floor(main.g * (1 - ratio) + accent.g * ratio),
      b: Math.floor(main.b * (1 - ratio) + accent.b * ratio),
    };
  }

  _applyArtworkColor(dominantColor, _accentColor, _themeColor) {
    // A darker album tint keeps text and controls legible across covers.
    const top = Object.fromEntries(Object.entries(dominantColor).map(
      ([channel, value]) => [channel, Math.round(value * 0.48 + 12)],
    ));
    const bottom = Object.fromEntries(Object.entries(top).map(
      ([channel, value]) => [channel, Math.round(value * 0.55)],
    ));
    const rgb = color => `rgb(${color.r}, ${color.g}, ${color.b})`;
    this.container.style = `background-gradient-direction: vertical;
      background-gradient-start: ${rgb(top)};
      background-gradient-end: ${rgb(bottom)};`;
    this._readableTextColor = "#FFFFFF";
    this._progressFilled.style = "background-color: #FFFFFF;";
    if (this._onColorUpdate) this._onColorUpdate(bottom);
  }

  _getCardWidth() {
    return this.useFixedWidth ? Math.max(320, Math.min(600, this.fixedWidth)) : 360;
  }

  _onWidthSettingsChanged() {
    this.useFixedWidth = this._settings.get_boolean("use-fixed-width");
    this.fixedWidth = this._settings.get_int("ui-width");
    this.container.width = this._getCardWidth();
    this._infoBox.width = this._getCardWidth() - 96 - 18 - 36;
    this._updateProgressBar();
  }

  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    this._stopProgressUpdate();
    if (this._progressWidthChangedId) {
      this._progressBarContainer.disconnect(this._progressWidthChangedId);
      this._progressWidthChangedId = null;
    }

    if (this._infoBoxClickId) {
      this._infoBox.disconnect(this._infoBoxClickId);
      this._infoBoxClickId = null;
    }

    if (this._seekClearTimeout) {
      GLib.Source.remove(this._seekClearTimeout);
      this._seekClearTimeout = null;
    }

    if (this._controlsOrderChangedId) {
      this._settings.disconnect(this._controlsOrderChangedId);
      this._controlsOrderChangedId = null;
    }

    if (this._widthChangedId) {
      this._settings.disconnect(this._widthChangedId);
      this._widthChangedId = null;
    }

    if (this._useFixedWidthChangedId) {
      this._settings.disconnect(this._useFixedWidthChangedId);
      this._useFixedWidthChangedId = null;
    }
  }
}
