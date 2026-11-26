import St from "gi://St";
import Clutter from "gi://Clutter";
import Gio from "gi://Gio";
import GLib from "gi://GLib";
import GdkPixbuf from "gi://GdkPixbuf";
import Pango from "gi://Pango";
import Soup from "gi://Soup";

import { toggleSpotifyWindow, logWarn, logInfo } from "./utils.js";
import { toggleLike, isTrackLiked } from "./spotify-helper.js";
import { getValidAccessToken } from "./spotify-auth.js";
import {
  createImageContent,
  decodeArtwork,
  fitSize,
  isCancelled,
  resourceScale,
  themeScale,
} from "./artwork.js";

// Look of the blurred album-art card background (easy to tweak):
const BLUR_SIZE = 128; // source resolution before blurring (bigger = smoother)
const BLUR_RADIUS = 6; // box-blur radius; several passes approximate gaussian
const BLUR_PASSES = 3;
const COLOR_SATURATION = 1.3; // > 1 keeps album colors strong instead of pastel
const BACKGROUND_BRIGHTNESS_TOP = 0.95; // mild baked ramp; most of the
const BACKGROUND_BRIGHTNESS_BOTTOM = 0.85; // darkening comes from the scrim
const SCRIM_ALPHA_TOP = 0.15; // transparent→dark gradient painted OVER the
const SCRIM_ALPHA_BOTTOM = 0.4; // cover so white text stays readable
const MENU_TINT_FACTOR = 0.38; // dominant-color tint of the popup around card
const ARTWORK_SIZE = 96; // actor units, matches .gspotify-lab-artwork
const ARTWORK_RADIUS = 14; // CSS px, matches .gspotify-lab-artwork
const CARD_RADIUS = 24; // CSS px, matches .gspotify-lab-card

export class SpotifyUI {
  constructor(indicator, extension, onColorUpdate = null) {
    this._indicator = indicator;
    this._extension = extension;
    this._settings = extension._settings;
    this._onColorUpdate = onColorUpdate;
    this._currentColors = null;
    this._readableTextColor = null;
    this._currentArtworkUrl = null;
    // Each artwork request gets a token; late results of older requests are
    // dropped so fast track skips can never show a previous cover.
    this._artworkToken = 0;
    this._artworkCancellable = null;
    this._artworkPixbuf = null;
    this._showingFallbackArtwork = false;
    // Blurred backdrop pixels (small) and the size they were last rendered at.
    this._backdropSource = null;
    this._backdropRenderedSize = null;
    this._backdropIdleId = 0;

    // Remote artwork (new Spotify clients expose mpris:artUrl as https://
    // CDN links) is fetched with libsoup instead of Gio/gvfs, which is not
    // reliable from inside the gnome-shell process.
    this._artworkSession = new Soup.Session();
    this._artworkSession.timeout = 15;
    this._artworkSession.user_agent = "gnome-shell-gspotify-lab";
    this._isPlaying = false;
    this._progressTimeout = null;
    this._lastUpdateTime = null;
    this._currentPosition = 0;
    this._duration = 0;
    this._shuffleState = false;
    this._currentTrackId = null;
    this._isLiked = false;
    this._isSpotifyConnected = false;
    this._likeRevision = 0;
    this._likeBusy = false;
    this._destroyed = false;

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
    // The card sits on top of a backdrop actor that shows the blurred cover.
    // Pixels go straight to St.ImageContent: CSS background-image would be
    // decoded synchronously on the compositor thread (see artwork.js).
    this.container = new St.Widget({
      layout_manager: new Clutter.BinLayout(),
      width: this._getCardWidth(),
      x_expand: false,
      y_expand: false,
    });

    this._backdrop = new St.Widget({
      x_expand: true,
      y_expand: true,
      x_align: Clutter.ActorAlign.FILL,
      y_align: Clutter.ActorAlign.FILL,
    });
    // Stays visible (empty content paints nothing) so it is always allocated.
    this._backdrop.connect("notify::allocation", () =>
      this._queueBackdropRender(),
    );
    this._backdrop.connect("resource-scale-changed", () => {
      this._backdropRenderedSize = null;
      this._queueBackdropRender();
    });
    this.container.add_child(this._backdrop);

    this._card = new St.BoxLayout({
      style_class: "gspotify-lab-card",
      orientation: Clutter.Orientation.VERTICAL,
      x_expand: true,
      y_expand: true,
      x_align: Clutter.ActorAlign.FILL,
      y_align: Clutter.ActorAlign.FILL,
    });
    this.container.add_child(this._card);

    this.container.connect("destroy", () => this.destroy());
    this._buildHeader();
    this._buildPlaybackControls();
    this._buildProgressBar();

    this._separator = new St.Widget({
      style_class: "gspotify-lab-separator",
      x_expand: true,
      y_expand: false,
    });
    this._card.add_child(this._separator);

    this._buildAdditionalControls();
  }

  _buildHeader() {
    this._headerBox = new St.BoxLayout({
      style_class: "gspotify-lab-header",
      orientation: Clutter.Orientation.HORIZONTAL,
      x_align: Clutter.ActorAlign.FILL,
      x_expand: true,
    });

    this._buildArtworkSection();
    this._buildInfoSection();

    this._card.add_child(this._headerBox);
  }

  _buildArtworkSection() {
    this._artwork = new St.Bin({
      style_class: "gspotify-lab-artwork",
      width: ARTWORK_SIZE,
      height: ARTWORK_SIZE,
    });
    // The bin keeps the CSS placeholder/shadow; the cover is a child actor
    // so it paints above the bin's own background.
    this._artworkImage = new St.Widget({
      width: ARTWORK_SIZE,
      height: ARTWORK_SIZE,
      visible: false,
    });
    this._artworkImage.connect("resource-scale-changed", () =>
      this._renderArtworkImage(),
    );
    this._artwork.set_child(this._artworkImage);
    this._headerBox.add_child(this._artwork);
  }

  _buildPlaybackControls() {
    this._playbackControls = new St.BoxLayout({
      style_class: "gspotify-lab-playback-controls",
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
      style_class: "gspotify-lab-button gspotify-lab-play-button",
      accessible_name: "Play",
      child: this._playIcon,
    });
    this._playButton.connect("clicked", () => this._onPlayPause());
    this._playbackControls.add_child(this._playButton);
    this._buildNextButton();
    this._card.add_child(this._playbackControls);
  }

  _buildPrevButton() {
    this._prevButton = new St.Button({
      x_align: Clutter.ActorAlign.CENTER,
      y_align: Clutter.ActorAlign.CENTER,
      style_class: "gspotify-lab-button",
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
      style_class: "gspotify-lab-info-box",
      orientation: Clutter.Orientation.VERTICAL,
      width: infoBoxWidth,
      x_expand: true,
      x_align: Clutter.ActorAlign.FILL,
      y_align: Clutter.ActorAlign.CENTER,
      reactive: true,
      track_hover: true,
    });

    this._infoBox.add_child(
      new St.Label({
        style_class: "gspotify-lab-source",
        text: "SPOTIFY",
      }),
    );
    this._titleLabel = new St.Label({
      style_class: "gspotify-lab-title",
      text: "No track playing",
      x_expand: true,
      x_align: Clutter.ActorAlign.FILL,
    });

    this._titleLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
    this._titleLabel.clutter_text.line_wrap = false;
    this._infoBox.add_child(this._titleLabel);

    this._artistLabel = new St.Label({
      style_class: "gspotify-lab-artist",
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
      style_class: "gspotify-lab-button",
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
      style_class: "gspotify-lab-progress-section",
      orientation: Clutter.Orientation.VERTICAL,
      x_expand: true,
    });
    this._progressBarContainer = new St.Widget({
      style_class: "gspotify-lab-progress-bar",
      x_expand: true,
      reactive: true,
    });

    this._progressTrack = new St.Widget({
      style_class: "gspotify-lab-progress-track",
    });
    this._progressTrack.set_position(0, 5);
    this._progressBarContainer.add_child(this._progressTrack);
    this._progressFilled = new St.Widget({
      style_class: "gspotify-lab-progress-filled",
      height: 4,
    });
    this._progressFilled.set_position(0, 5);
    this._progressBarContainer.add_child(this._progressFilled);

    this._progressHandle = new St.Widget({
      style_class: "gspotify-lab-progress-handle",
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
    const times = new St.BoxLayout({ style_class: "gspotify-lab-progress-times" });
    this._elapsedLabel = new St.Label({ text: "0:00" });
    this._durationLabel = new St.Label({ text: "0:00" });
    times.add_child(this._elapsedLabel);
    times.add_child(new St.Widget({ x_expand: true }));
    times.add_child(this._durationLabel);
    this._progressBox.add_child(times);
    this._card.add_child(this._progressBox);
    this._progressWidthChangedId = this._progressBarContainer.connect(
      "notify::width",
      () => this._updateProgressBar(),
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
      style_class: "gspotify-lab-additional-controls",
      orientation: Clutter.Orientation.HORIZONTAL,
      x_align: Clutter.ActorAlign.FILL,
    });

    this._card.add_child(this._additionalControls);

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
      style_class: "gspotify-lab-spacer-label",
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
      style_class: "gspotify-lab-button-secondary",
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
      style_class: "gspotify-lab-button-secondary",
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
      style_class: "gspotify-lab-close-button",
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
      style_class: "gspotify-lab-button-secondary",
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
      style_class: "gspotify-lab-button-secondary",
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
      style_class: "gspotify-lab-button-secondary",
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

  _likeErrorMessage(error) {
    switch (error.code) {
      case "not-authenticated":
      case "missing-client-id":
        return "Connect Spotify in extension settings to like songs";
      case "refresh-failed":
        return "Spotify authentication could not be renewed. Check connection in settings";
      case "unauthorized":
        return "Spotify rejected authentication (401). Reconnect in settings";
      case "forbidden":
        return "Spotify denied library access (403). Check app access and library permissions";
      case "rate-limited":
        return "Spotify request limit reached (429). Try again later";
      case "network":
        return "Could not reach Spotify. Check your connection";
      default:
        return "Could not update Liked Songs. Try again later";
    }
  }

  async _onLikeButtonClicked() {
    if (this._destroyed || this._likeBusy) return;
    const trackId = this._currentTrackId;
    if (!trackId) {
      this._extension.sendOSDMessage("No track playing", "dialog-error-symbolic");
      return;
    }
    const revision = ++this._likeRevision;
    this._likeBusy = true;
    this._likeButton.reactive = false;
    try {
      // The helper checks current credentials; a cached connection flag may be stale.
      const newLikedState = await toggleLike(trackId);
      if (this._destroyed || revision !== this._likeRevision) return;
      this._isSpotifyConnected = true;
      this._isLiked = newLikedState;
      this._updateLikeButtonIcon();
      this._extension.sendOSDMessage(
        newLikedState ? "Added to Liked Songs" : "Removed from Liked Songs",
        newLikedState ? "emote-love-symbolic" : "list-remove-symbolic",
      );
    } catch (e) {
      if (this._destroyed || revision !== this._likeRevision) return;
      logWarn("Failed to toggle like state:", e.code || "unknown", e.status || "");
      this._extension.sendOSDMessage(this._likeErrorMessage(e), "dialog-error-symbolic");
    } finally {
      this._likeBusy = false;
      if (!this._destroyed) this._likeButton.reactive = true;
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

    if (this._destroyed) return;
    this._currentMetadata = metadata;

    // Render the card first so track data, progress and artwork appear
    // immediately. Account status only affects the like button and is
    // refreshed (off the critical path) on track changes below.
    this._updateText(metadata);
    this._updateProgress(metadata);
    this._updatePlayState(metadata);
    this._updateArtwork(metadata);
    this._shuffleState = metadata.shuffle;
    this._updateShuffleButton();

    const trackId = this._extractTrackIdFromUrl(metadata.url);
    const trackChanged = trackId !== this._currentTrackId;
    this._mprisTrackId = metadata.trackId || "/org/mpris/MediaPlayer2/TrackList/NoTrack";
    if (trackChanged) {
      this._currentTrackId = trackId;
      this._likeRevision++;
    }
    if (!trackId) {
      this._isLiked = false;
      this._updateLikeButtonIcon();
      return;
    }
    const revision = this._likeRevision;
    const wasConnected = this._isSpotifyConnected;
    await this._checkSpotifyConnection();
    if (this._destroyed || revision !== this._likeRevision) return;
    if (trackChanged || (!this._likeBusy && !wasConnected && this._isSpotifyConnected)) {
      await this._checkLikeStatus();
    }
  }

  async _checkLikeStatus() {
    if (this._destroyed || !this._currentTrackId) return;
    const trackId = this._currentTrackId;
    const revision = ++this._likeRevision;
    try {
      const liked = await isTrackLiked(trackId);
      if (this._destroyed || revision !== this._likeRevision) return;
      this._isLiked = liked;
      this._updateLikeButtonIcon();
      return liked;
    } catch (e) {
      // An unavailable status is unknown, never evidence that a track is unliked.
      if (!this._destroyed && revision === this._likeRevision) {
        logWarn("Failed to check like status:", e.code || "unknown", e.status || "");
      }
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
    const position = Math.max(
      0,
      Math.min(this._currentPosition, this._duration),
    );
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
    } else if (!metadata.artworkUrl && !this._showingFallbackArtwork) {
      // update() runs on every MPRIS signal; only act on the transition.
      this._currentArtworkUrl = null;
      this._cancelArtworkLoad();
      this._setFallbackArtwork();
    }
  }

  _cancelArtworkLoad() {
    this._artworkToken++;
    this._artworkCancellable?.cancel();
    this._artworkCancellable = null;
  }

  _isStaleArtwork(token) {
    return this._destroyed || token !== this._artworkToken;
  }

  // Fetch, decode and show artwork without blocking the compositor thread:
  // network/file reads and decoding are asynchronous, and nothing is
  // written to or deleted from disk.
  _loadArtwork(url) {
    this._cancelArtworkLoad();
    const token = this._artworkToken;
    const cancellable = new Gio.Cancellable();
    this._artworkCancellable = cancellable;

    this._fetchArtwork(url, cancellable)
      .then((bytes) =>
        this._isStaleArtwork(token) ? null : decodeArtwork(bytes, cancellable),
      )
      .then((pixbuf) => {
        if (!pixbuf || this._isStaleArtwork(token)) return;
        this._artworkCancellable = null;
        this._showArtwork(pixbuf);
      })
      .catch((e) => {
        if (isCancelled(e) || this._isStaleArtwork(token)) return;
        logWarn("Failed to load artwork:", e.message || e, url);
        this._setFallbackArtwork();
      });
  }

  _fetchArtwork(url, cancellable) {
    if (url.startsWith("file://"))
      return this._fetchLocalArtwork(url, cancellable);
    if (url.startsWith("http://") || url.startsWith("https://"))
      return this._fetchRemoteArtwork(url, cancellable);
    return Promise.reject(new Error("Unsupported artwork URL scheme"));
  }

  _fetchLocalArtwork(url, cancellable) {
    return new Promise((resolve, reject) => {
      Gio.File.new_for_uri(url).load_bytes_async(cancellable, (file, res) => {
        try {
          const [bytes] = file.load_bytes_finish(res);
          resolve(bytes);
        } catch (e) {
          reject(e);
        }
      });
    });
  }

  // Remote artwork (new Spotify clients expose mpris:artUrl as https:// CDN
  // links) is fetched with libsoup instead of Gio/gvfs.
  _fetchRemoteArtwork(url, cancellable) {
    return new Promise((resolve, reject) => {
      const session = this._artworkSession;
      const msg = session ? Soup.Message.new("GET", url) : null;
      if (!msg) {
        reject(new Error("Cannot request artwork URL"));
        return;
      }
      session.send_and_read_async(
        msg,
        GLib.PRIORITY_DEFAULT,
        cancellable,
        (_session, result) => {
          try {
            const bytes = session.send_and_read_finish(result);
            const status = msg.get_status();
            if (status < 200 || status >= 300)
              throw new Error(`HTTP ${status}`);
            if (!bytes || bytes.get_size() === 0)
              throw new Error("Empty response body");
            resolve(bytes);
          } catch (e) {
            reject(e);
          }
        },
      );
    });
  }

  _showArtwork(pixbuf) {
    this._artworkPixbuf = pixbuf;
    this._showingFallbackArtwork = false;
    this._artwork.style = null;
    this._renderArtworkImage();

    if (this._settings.get_boolean("artwork-themed-ui"))
      this._applyArtworkTheme(pixbuf);
    else this._clearCardBackground();
  }

  _renderArtworkImage() {
    if (!this._artworkPixbuf || this._destroyed) return;
    try {
      const scale = resourceScale(this._artworkImage);
      const size = Math.ceil(ARTWORK_SIZE * scale);
      const radius = ARTWORK_RADIUS * themeScale() * scale;
      this._artworkImage.content = createImageContent(
        this._squareCrop(this._artworkPixbuf),
        size,
        size,
        radius,
      );
      this._artworkImage.show();
    } catch (e) {
      logWarn("Failed to display artwork:", e.message || e);
      this._setFallbackArtwork();
    }
  }

  // Same framing as CSS `background-size: cover` on a square box.
  _squareCrop(pixbuf) {
    const width = pixbuf.get_width();
    const height = pixbuf.get_height();
    if (width === height) return pixbuf;
    const side = Math.min(width, height);
    return pixbuf.new_subpixbuf(
      Math.floor((width - side) / 2),
      Math.floor((height - side) / 2),
      side,
      side,
    );
  }

  _applyArtworkTheme(pixbuf) {
    const [width, height] = fitSize(
      pixbuf.get_width(),
      pixbuf.get_height(),
      BLUR_SIZE,
    );
    const small = pixbuf.scale_simple(
      width,
      height,
      GdkPixbuf.InterpType.BILINEAR,
    );
    const colorData = small ? this._getColorPalette(small) : null;
    if (!colorData) {
      this._clearCardBackground();
      return;
    }

    this._currentColors = colorData;
    this._backdropSource = this._createBlurredBackground(small);
    this._backdropRenderedSize = null;
    // Keep the previous backdrop until the new one is rendered (no flash).
    if (!this._backdropSource) this._backdrop.content = null;
    this._applyArtworkColor(
      colorData.main,
      colorData.accent,
      colorData.theme,
      this._backdropSource !== null,
    );
    this._queueBackdropRender();
  }

  // The backdrop is rendered at the card's real pixel size so the rounded
  // corners stay crisp. Rendering is deferred to an idle callback because it
  // is triggered from allocation changes.
  _queueBackdropRender() {
    if (this._backdropIdleId || this._destroyed || !this._backdropSource)
      return;
    this._backdropIdleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
      this._backdropIdleId = 0;
      this._renderBackdrop();
      return GLib.SOURCE_REMOVE;
    });
  }

  _renderBackdrop() {
    if (this._destroyed || !this._backdropSource) return;
    const box = this._backdrop.get_allocation_box();
    const scale = resourceScale(this._backdrop);
    const width = Math.ceil(box.get_width() * scale);
    const height = Math.ceil(box.get_height() * scale);
    // Not allocated yet: notify::allocation queues another render.
    if (width <= 0 || height <= 0) return;

    const sizeKey = `${width}x${height}`;
    if (this._backdropRenderedSize === sizeKey) return;

    try {
      this._backdrop.content = createImageContent(
        this._backdropSource,
        width,
        height,
        CARD_RADIUS * themeScale() * scale,
      );
      this._backdropRenderedSize = sizeKey;
    } catch (e) {
      logWarn("Failed to display artwork background:", e.message || e);
      this._clearCardBackground();
    }
  }

  _getColorPalette(pixbuf) {
    try {
      const pixels = pixbuf.get_pixels();
      const channels = pixbuf.get_n_channels();
      const rowstride = pixbuf.get_rowstride();
      const width = pixbuf.get_width();
      const height = pixbuf.get_height();

      let r = 0,
        g = 0,
        b = 0;
      let count = 0;

      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const offset = y * rowstride + x * channels;
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

  // Separable box blur over a packed RGB/RGBA buffer: one horizontal pass
  // into dst plus one vertical pass back into src. _createBlurredBackground
  // ping-pongs the two buffers BLUR_PASSES times to approximate a gaussian.
  _boxBlurPass(src, dst, width, height, channels, radius, horizontal) {
    const windowSize = radius * 2 + 1;
    const outer = horizontal ? height : width;
    const inner = horizontal ? width : height;
    const strideOuter = horizontal ? width * channels : channels;
    const strideInner = horizontal ? channels : width * channels;

    for (let o = 0; o < outer; o++) {
      const base = o * strideOuter;
      for (let c = 0; c < channels; c++) {
        let sum = 0;
        for (let i = -radius; i <= radius; i++) {
          const idx = Math.min(inner - 1, Math.max(0, i));
          sum += src[base + idx * strideInner + c];
        }
        for (let i = 0; i < inner; i++) {
          dst[base + i * strideInner + c] = sum / windowSize;
          const out = Math.max(0, i - radius);
          const inn = Math.min(inner - 1, i + radius + 1);
          sum +=
            src[base + inn * strideInner + c] -
            src[base + out * strideInner + c];
        }
      }
    }
  }

  _tuneColorChannel(value, average, brightness) {
    const saturated = average + (value - average) * COLOR_SATURATION;
    return Math.max(0, Math.min(255, Math.round(saturated * brightness)));
  }

  _createBlurredBackground(pixbuf) {
    try {
      const width = pixbuf.get_width();
      const height = pixbuf.get_height();
      const channels = pixbuf.get_n_channels();
      const hasAlpha = pixbuf.get_has_alpha();
      const rowstride = pixbuf.get_rowstride();
      const pixels = pixbuf.get_pixels();

      // Copy into a tightly packed buffer (rowstride can carry padding).
      const data = new Uint8Array(width * height * channels);
      for (let y = 0; y < height; y++) {
        const srcRow = y * rowstride;
        const dstRow = y * width * channels;
        for (let x = 0; x < width * channels; x++) {
          data[dstRow + x] = pixels[srcRow + x];
        }
      }

      // A real blur rather than a pixelated upscale of a tiny thumbnail.
      const tmp = new Uint8Array(data.length);
      for (let pass = 0; pass < BLUR_PASSES; pass++) {
        this._boxBlurPass(
          data,
          tmp,
          width,
          height,
          channels,
          BLUR_RADIUS,
          true,
        );
        this._boxBlurPass(
          tmp,
          data,
          width,
          height,
          channels,
          BLUR_RADIUS,
          false,
        );
      }

      // Keep the album colors loud: saturation boost plus a gentle vertical
      // brightness ramp (brighter up top, darker where the controls sit).
      // The transparent→dark scrim that keeps white text readable is baked
      // in too (it used to be a CSS gradient painted over the image).
      for (let y = 0; y < height; y++) {
        const t = height > 1 ? y / (height - 1) : 0;
        const brightness =
          BACKGROUND_BRIGHTNESS_TOP +
          (BACKGROUND_BRIGHTNESS_BOTTOM - BACKGROUND_BRIGHTNESS_TOP) * t;
        const scrim =
          1 - (SCRIM_ALPHA_TOP + (SCRIM_ALPHA_BOTTOM - SCRIM_ALPHA_TOP) * t);
        for (let x = 0; x < width; x++) {
          const i = (y * width + x) * channels;
          const r = data[i];
          const g = data[i + 1];
          const b = data[i + 2];
          const avg = (r + g + b) / 3;
          data[i] = Math.round(this._tuneColorChannel(r, avg, brightness) * scrim);
          data[i + 1] = Math.round(
            this._tuneColorChannel(g, avg, brightness) * scrim,
          );
          data[i + 2] = Math.round(
            this._tuneColorChannel(b, avg, brightness) * scrim,
          );
        }
      }

      // In-memory only: no PNG is written, so there is nothing to delete.
      return GdkPixbuf.Pixbuf.new_from_bytes(
        GLib.Bytes.new(data),
        pixbuf.get_colorspace(),
        hasAlpha,
        8,
        width,
        height,
        width * channels,
      );
    } catch (e) {
      logWarn("Failed to create blurred artwork background:", e.message || e);
      return null;
    }
  }

  _setFallbackArtwork() {
    this._showingFallbackArtwork = true;
    this._artworkPixbuf = null;
    this._artworkImage.content = null;
    this._artworkImage.hide();
    this._artwork.style = "border-radius: 10px; background-color: #333333;";
    this._clearCardBackground();
  }

  _clearCardBackground() {
    this._card.style = "";
    this._currentColors = null;
    this._backdropSource = null;
    this._backdropRenderedSize = null;
    this._backdrop.content = null;
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

  _applyArtworkColor(
    dominantColor,
    _accentColor,
    _themeColor,
    hasBackdrop = false,
  ) {
    const rgb = (color) => `rgb(${color.r}, ${color.g}, ${color.b})`;
    let style;

    if (hasBackdrop) {
      // The blurred cover (scrim included) is painted by this._backdrop
      // behind the card, like Spotify's own now-playing backdrop. The card's
      // stylesheet gradient is made transparent so it does not cover it.
      style = `background-color: transparent;
        background-gradient-start: transparent;
        background-gradient-end: transparent;`;
    } else {
      // Fallback when the blurred image could not be built: a gradient
      // tinted with the dominant album color.
      const top = Object.fromEntries(
        Object.entries(dominantColor).map(([channel, value]) => [
          channel,
          Math.round(value * 0.62 + 8),
        ]),
      );
      const bottom = Object.fromEntries(
        Object.entries(top).map(([channel, value]) => [
          channel,
          Math.round(value * 0.55),
        ]),
      );
      style = `background-gradient-direction: vertical;
        background-gradient-start: ${rgb(top)};
        background-gradient-end: ${rgb(bottom)};`;
    }

    this._card.style = style;
    this._readableTextColor = "#FFFFFF";
    this._progressFilled.style = "background-color: #FFFFFF;";

    const menuTint = {
      r: Math.round(dominantColor.r * MENU_TINT_FACTOR),
      g: Math.round(dominantColor.g * MENU_TINT_FACTOR),
      b: Math.round(dominantColor.b * MENU_TINT_FACTOR),
    };
    if (this._onColorUpdate) this._onColorUpdate(menuTint);
  }

  _getCardWidth() {
    return this.useFixedWidth
      ? Math.max(320, Math.min(600, this.fixedWidth))
      : 360;
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
    this._likeRevision++;
    this._stopProgressUpdate();
    this._cancelArtworkLoad();
    if (this._backdropIdleId) {
      GLib.Source.remove(this._backdropIdleId);
      this._backdropIdleId = 0;
    }
    this._artworkPixbuf = null;
    this._backdropSource = null;
    if (this._artworkSession) {
      this._artworkSession.abort();
      this._artworkSession = null;
    }
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
