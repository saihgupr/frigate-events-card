/**
 * Frigate Events Card - Lovelace card for Frigate events, live WebRTC, timeline playback, and temporary masks
 */
import { LitElement, html, css, PropertyValues, TemplateResult, CSSResult } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { ref } from 'lit/directives/ref.js';
import { HomeAssistant, LovelaceCardConfig, LovelaceLayoutOptions } from './ha/types';
import { FrigateBoundingBox, FrigateEvent, FrigateEventChange, FrigatePathPoint } from './frigate/types';
import { getEvents, getRecordings, getEventSnapshotURL, getEventThumbnailURL, signPath, toRelativePath, getCachedSignedPath, subscribeToEvents, getEventClipURL, getEventHlsURL, getVodClipURL, getVodHlsURL, deleteEvent } from './frigate/api';
import Hls from 'hls.js';

const CARD_VERSION = '2.6.28';

// How often to poll for new events as a fallback (in ms)
// This handles cases where WebSocket subscriptions silently die
const FALLBACK_POLL_INTERVAL = 10000; // 10 seconds
const HOVER_CROP_DEFAULT_SMOOTHING = 1.0; // 0.0 is jerky, 1.0 is smoothest
const HOVER_CROP_MARGIN_PERCENT = 0.20; // 20% margin on each side of the container

// Frigate's nginx-vod-module is compiled with a hard limit of 1080 clips per
// playlist. Each clip is a recording segment (~10s), so a single VOD request
// with more than ~3h of footage returns HTTP 503. Keep each VOD chunk well
// below that limit and page through recordings for larger timeline windows.
const TIMELINE_VOD_MAX_CLIPS = 900;

const escapeHtml = (value: unknown): string => String(value ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// WebRTC live feed constants
// Events streamed back from HA's camera/webrtc_offer subscription
type HAWebRtcEvent =
  | { type: 'session'; session_id: string }
  | { type: 'answer'; answer: string }
  | { type: 'candidate'; candidate: RTCIceCandidateInit }
  | { type: 'error'; code: string; message: string };

// Google public STUN servers — used to help establish the peer connection.
// HA may also return STUN/TURN config via camera/webrtc_client_config, but
// these cover the common LAN + Nabu Casa remote access case without extra calls.
const WEBRTC_STUN_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

// Time (ms) to keep the peer connection alive after the card leaves the
// viewport, to avoid teardown/reconnect churn from minor scroll jitter.
const LIVE_VIEW_TEARDOWN_GRACE_MS = 10000;


type ObjectPositionPercent = { x: number; y: number };

interface FrigateEventsCardConfig extends LovelaceCardConfig {
  frigate_client_id?: string;
  frigate_url?: string;
  event_count?: number;
  cameras?: string[];
  camera?: string;
  labels?: string[];
  zones?: string[];
  show_label?: boolean;
  show_timestamp?: boolean;
  show_date?: boolean;
  show_accuracy?: boolean;
  show_duration?: boolean;
  show_description?: boolean;
  show_camera_name?: boolean;
  show_zones?: boolean;
  show_bounding_box?: boolean;
  title?: string;
  daily_clear_time?: string; // Format: "HH:MM" (24-hour), e.g., "04:00"
  video?: boolean;
  video_on_hover?: boolean;
  muted?: boolean;
  offset?: number;
  reverse?: boolean;
  video_start_skip_seconds?: number | Record<string, number>;
  video_start_padding?: number | Record<string, number>;
  video_end_skip_seconds?: number | Record<string, number>;
  debug?: boolean;
  testing?: boolean;
  tracking_pan_delay?: number | Record<string, number>;
  tracking_smoothing?: number;
  scroll?: boolean;
  scroll_limit?: number;
  show_scroll_arrows?: boolean;
  show_modal_navigation?: boolean;
  layout?: 'row' | 'grid';
  grid_columns?: number;
  grid_max_height?: string;
  // Live view options
  live_view?: boolean;              // default: false
  live_view_entity?: string;        // required if live_view: true — must be camera.*
  live_view_aspect_ratio?: string;  // CSS aspect-ratio value, e.g. '16 / 9' (default)
  show_mute?: boolean;              // default: false
  live_view_show_mute?: boolean;    // default: false (alias for show_mute)
  live_view_mute_position?: 'top-left' | 'top-right'; // default: 'top-right'
  go2rtc_url?: string;              // Optional direct go2rtc URL
  go2rtc_stream?: string;           // Optional stream name in go2rtc (defaults to camera entity basename)
  // Temporary false-positive masking options
  show_temp_mask?: boolean;         // default: true
  temp_mask_duration?: string;      // default: '24:00:00'
  // Timeline options
  show_timeline?: boolean;          // default: true
  timeline?: boolean;               // alias for show_timeline: default: true
  timeline_on_click?: boolean;      // default: true (when timeline is on and video is enabled)
  timeline_show_mute?: boolean;     // default: true
  timeline_default_window_hours?: number; // default: 1
  timeline_event_seek_offset?: number | Record<string, number>;    // default: 0 (seconds added/subtracted, e.g. -26 or { car: -26, person: -10 })
}

const DEFAULT_CONFIG: Partial<FrigateEventsCardConfig> = {
  frigate_client_id: 'frigate',
  event_count: 5,
  show_label: true,
  show_timestamp: true,
  show_date: false,
  show_accuracy: false,
  show_duration: false,
  show_description: true,
  show_camera_name: true,
  show_zones: true,
  show_bounding_box: true,
  show_modal_navigation: false,
  show_temp_mask: true,
  temp_mask_duration: '24:00:00',
  show_timeline: true,
  timeline: true,
  timeline_on_click: true,
  timeline_show_mute: true,
  timeline_default_window_hours: 1,
  timeline_event_seek_offset: 0,
  title: 'Frigate Events',
  video: true,
  video_on_hover: true,
  muted: true,
  show_mute: false,
  live_view_show_mute: false,
  live_view_mute_position: 'top-right',
  offset: 0,
  reverse: false,
  video_start_skip_seconds: 0,
  video_end_skip_seconds: 0,
  debug: false,
  testing: false,
  tracking_smoothing: HOVER_CROP_DEFAULT_SMOOTHING,
  scroll: true,
  scroll_limit: 20,
  show_scroll_arrows: false,
  layout: 'row',
  grid_max_height: '400px',
};

// Label to icon mapping
const LABEL_ICONS: Record<string, string> = {
  person: '🚶',
  car: '🚗',
  dog: '🐕',
  cat: '🐈',
  bird: '🐦',
  motorcycle: '🏍️',
  bicycle: '🚲',
  truck: '🚚',
  bus: '🚌',
  boat: '🚤',
};

// Playback speeds for continuous footage timeline
const TIMELINE_PLAYBACK_SPEEDS = [0.5, 1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048, 4096];


@customElement('frigate-events-card')
export class FrigateEventsCard extends LitElement {
  @property({ attribute: false }) public hass?: HomeAssistant;
  @state() private _config?: FrigateEventsCardConfig;
  /** Config exactly as authored, before DEFAULTS fill in mute flags. */
  private _userConfig?: FrigateEventsCardConfig;
  @state() private _events: FrigateEvent[] = [];
  @state() private _selectedEvent?: FrigateEvent;
  @state() private _loading = true;
  @state() private _error?: string;
  @state() private _hoveredEventId?: string;
  @state() private _liveViewError?: string;   // Set when live feed fails gracefully
  @state() private _isLiveMuted = true;
  @state() private _maskManagerSelectedCamera = 'all';
  // undefined = default (first mask expanded), '' = all collapsed, otherwise a mask id
  private _maskManagerExpandedId?: string;
  private _maskEditingId?: string;
  private _maskEditSavingIds = new Set<string>();
  @state() private _localPendingMasks: any[] = [];
  /** Hotkey override for the version badge: undefined = follow config.testing. */
  @state() private _showVersionOverride?: boolean;

  private _unsubscribe?: () => void;
  private _pollInterval?: number;
  private _boundVisibilityHandler?: () => void;
  private _boundKeyDownHandler?: (e: KeyboardEvent) => void;
  private _boundDebugVersionHandler?: (e: KeyboardEvent) => void;
  private _modalContainer?: HTMLDivElement;
  private _maskManagerContainer?: HTMLDivElement;
  private _maskManagerTimer?: ReturnType<typeof setInterval>;
  private _maskManagerSnapshotUrls = new Map<string, string>();
  private _maskManagerEventSnapshotUrls = new Map<string, string>();
  private _maskManagerSnapshotToken = 0;
  private _maskDurationOverrides = new Map<string, number>();
  private _hoverVideoCropPositions = new WeakMap<HTMLVideoElement, ObjectPositionPercent>();
  private static _stylesInjected = false;

  // Live view WebRTC state
  private _peerConnection?: RTCPeerConnection;
  private _liveViewSessionId?: string;
  private _liveViewUnsub?: () => void;
  private _intersectionObserver?: IntersectionObserver;
  private _intersectionGraceTimer?: number;
  private _disconnectTimer?: number;
  private _liveVideoEl: HTMLVideoElement | null = null;
  private _remoteStream?: MediaStream;
  private _contextMenuEl?: HTMLElement;
  private _isIntersecting = false;
  private _touchTimeout?: ReturnType<typeof setTimeout>;
  private _liveTouchTimeout?: ReturnType<typeof setTimeout>;
  private _touchStartX?: number;
  private _touchStartY?: number;
  private _liveTouchStartX?: number;
  private _liveTouchStartY?: number;
  private _didLongPress = false;
  private _boundFullscreenHandler?: () => void;
  private _boundFullscreenMouseMoveHandler?: () => void;
  private _cursorHideTimeout?: ReturnType<typeof setTimeout>;
  private _justExitedFullscreen = false;

  // Timeline modal state
  private _timelineContainer?: HTMLDivElement;
  private _timelineActiveVideo: 'a' | 'b' = 'a';
  private _timelineVideoA: HTMLVideoElement | null = null;
  private _timelineVideoB: HTMLVideoElement | null = null;
  private _timelineHlsA: Hls | null = null;
  private _timelineHlsB: Hls | null = null;

  private get _timelineVideoEl(): HTMLVideoElement | null {
    return this._timelineActiveVideo === 'a' ? this._timelineVideoA : this._timelineVideoB;
  }
  private _timelineCamera?: string;
  private _timelineStartTs = 0;
  private _timelineEndTs = 0;
  // The VOD stream only covers a chunk of the visible timeline window so that
  // long windows (e.g. 24h) never exceed Frigate's nginx-vod clip limit.
  private _timelineVodStartTs = 0;
  private _timelineVodEndTs = 0;
  private _timelineWindowDurationSec = 3600; // default 1 hour
  /** True once the user picks a window pill, so defaults stop overriding it. */
  private _timelineWindowUserChosen = false;
  private _timelinePlaybackRate = 1;
  private _timelineSpeedInterval?: number;
  private _isTimelineMuted = true;
  private _timelineEvents: FrigateEvent[] = [];
  private _timelineRecordings: Array<{ start_time: number; end_time: number }> = [];
  private _timelineTimeUpdateRaf?: number;
  private _timelineIsDragging = false;
  private _isAdvancingTimeline = false;
  private _timelineLoadingTimeout?: number;
  private _timelineAdvanceTimeout?: number;
  private _timelineSlotTransitionTimeout?: number;
  private _timelineWindowRequestId = 0;


  /**
   * Calculate the daily reset timestamp based on the configured time.
   * If current time is before the reset time, use yesterday's reset time.
   */
  private _getDailyResetTimestamp(): number | null {
    if (!this._config?.daily_clear_time) return null;

    const [hours, minutes] = this._config.daily_clear_time.split(':').map(Number);
    if (isNaN(hours) || isNaN(minutes)) return null;

    const now = new Date();
    const resetTime = new Date(now);
    resetTime.setHours(hours, minutes, 0, 0);

    // If we haven't reached today's reset time yet, use yesterday's reset time
    if (now < resetTime) {
      resetTime.setDate(resetTime.getDate() - 1);
    }

    return resetTime.getTime() / 1000; // Return as Unix timestamp (seconds)
  }

  static getConfigElement(): HTMLElement | null {
    return null; // No visual editor for now
  }

  static getStubConfig(): object {
    return {
      frigate_client_id: 'frigate',
      event_count: 5,
    };
  }

  public setConfig(config: FrigateEventsCardConfig): void {
    if (!config) {
      throw new Error('Invalid configuration');
    }
    this._userConfig = config;
    this._config = { ...DEFAULT_CONFIG, ...config };
    if (config.muted !== undefined) {
      this._isLiveMuted = config.muted !== false;
    }
  }

  public getCardSize(): number {
    return 3;
  }

  public getLayoutOptions(): LovelaceLayoutOptions {
    return {
      grid_columns: 4,
    };
  }

  protected shouldUpdate(changedProps: PropertyValues): boolean {
    // If hass is the only property that changed, and it was already defined previously,
    // check if we need to subscribe, but skip re-rendering the HTML DOM tree unless
    // active masks or Frigate online/offline state changed.
    if (changedProps.has('hass') && changedProps.size === 1) {
      const oldHass = changedProps.get('hass') as HomeAssistant | undefined;
      if (oldHass !== undefined) {
        if (this.hass && !this._unsubscribe) {
          this._subscribeToEvents();
        }
        const oldMasks = this._getTemporaryMaskSensor(oldHass?.states);
        const newMasks = this._getTemporaryMaskSensor(this.hass?.states);
        if (oldMasks !== newMasks) {
          if (this._maskManagerContainer) {
            this._renderMaskManagerContent(this._maskManagerContainer);
          }
          return true;
        }
        // Re-render when Frigate goes offline/online so the live box
        // hides/shows. Polling already skips fetches while offline.
        if (this._isFrigateOfflineFor(oldHass?.states) !== this._isFrigateOffline()) {
          return true;
        }
        return false;
      }
    }
    return true;
  }

  /** Resolve the integration sensor by its stable unique-id suffix. HA may prefix
   * the suggested object id with the integration/config-entry name. */
  private _getTemporaryMaskSensor(states: HomeAssistant['states'] | undefined): any {
    if (!states) return undefined;
    if (states['sensor.frigate_active_masks']) return states['sensor.frigate_active_masks'];
    const matches = Object.entries(states).filter(([entityId, state]: [string, any]) =>
      entityId.startsWith('sensor.') && entityId.endsWith('_frigate_active_masks') &&
      Array.isArray(state?.attributes?.masks)
    );
    return matches.length === 1 ? matches[0][1] : undefined;
  }

  protected async firstUpdated(): Promise<void> {
    await this._loadEvents();
    await this._subscribeToEvents();
    this._setupVisibilityHandler();
    this._setupPolling();
    this._setupDebugVersionToggle();
    this._setupLiveView();
    this._setupFullscreenListener();
  }

  protected updated(changedProps: PropertyValues): void {
    if (changedProps.has('hass') && this.hass && !this._unsubscribe) {
      this._subscribeToEvents();
    }
    // Restart live view when the entity or enabled state changes after initial setup.
    // oldConfig is undefined on first render (no prior value), so this only fires on
    // genuine re-configurations (e.g. YAML editor changes).
    if (changedProps.has('_config')) {
      const oldConfig = changedProps.get('_config') as FrigateEventsCardConfig | undefined;
      if (
        oldConfig !== undefined && (
          oldConfig.live_view !== this._config?.live_view ||
          oldConfig.live_view_entity !== this._config?.live_view_entity
        )
      ) {
        this._teardownWebRTC();
        this._intersectionObserver?.disconnect();
        this._intersectionObserver = undefined;
        this._liveViewError = undefined;
        this._setupLiveView();
      }
    }
  }

  connectedCallback(): void {
    super.connectedCallback();
    if (this.hasUpdated) {
      this._loadEvents();
      if (!this._unsubscribe) {
        this._subscribeToEvents();
      }
      if (!this._boundVisibilityHandler) {
        this._setupVisibilityHandler();
      }
      if (!this._pollInterval) {
        this._setupPolling();
      }
      if (!this._boundDebugVersionHandler) {
        this._setupDebugVersionToggle();
      }
      if (!this._intersectionObserver) {
        this._setupLiveView();
      }
      if (!this._boundFullscreenHandler) {
        this._setupFullscreenListener();
      }
    }
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this._cleanup();
  }

  private _cleanup(): void {
    if (this._unsubscribe) {
      this._unsubscribe();
      this._unsubscribe = undefined;
    }
    if (this._pollInterval) {
      clearInterval(this._pollInterval);
      this._pollInterval = undefined;
    }
    if (this._boundVisibilityHandler) {
      document.removeEventListener('visibilitychange', this._boundVisibilityHandler);
      this._boundVisibilityHandler = undefined;
    }
    if (this._boundDebugVersionHandler) {
      window.removeEventListener('keydown', this._boundDebugVersionHandler);
      this._boundDebugVersionHandler = undefined;
    }
    if (this._boundFullscreenHandler) {
      document.removeEventListener('fullscreenchange', this._boundFullscreenHandler);
      document.removeEventListener('webkitfullscreenchange', this._boundFullscreenHandler);
      this._liveVideoEl?.removeEventListener('webkitbeginfullscreen', this._boundFullscreenHandler);
      this._liveVideoEl?.removeEventListener('webkitendfullscreen', this._boundFullscreenHandler);
      this._liveVideoEl?.removeEventListener('fullscreenchange', this._boundFullscreenHandler);
      this._liveVideoEl?.removeEventListener('webkitfullscreenchange', this._boundFullscreenHandler);
      this._boundFullscreenHandler = undefined;
    }
    if (this._boundFullscreenMouseMoveHandler) {
      window.removeEventListener('mousemove', this._boundFullscreenMouseMoveHandler, { capture: true } as any);
      window.removeEventListener('pointermove', this._boundFullscreenMouseMoveHandler, { capture: true } as any);
      document.removeEventListener('mousemove', this._boundFullscreenMouseMoveHandler, { capture: true } as any);
      document.removeEventListener('pointermove', this._boundFullscreenMouseMoveHandler, { capture: true } as any);
      this._liveVideoEl?.removeEventListener('mousemove', this._boundFullscreenMouseMoveHandler, { capture: true } as any);
      this._liveVideoEl?.removeEventListener('pointermove', this._boundFullscreenMouseMoveHandler, { capture: true } as any);
      this._boundFullscreenMouseMoveHandler = undefined;
    }
    if (this._cursorHideTimeout) {
      clearTimeout(this._cursorHideTimeout);
      this._cursorHideTimeout = undefined;
    }
    document.documentElement.style.removeProperty('cursor');
    document.body.style.removeProperty('cursor');
    if (this._touchTimeout) {
      clearTimeout(this._touchTimeout);
      this._touchTimeout = undefined;
    }
    if (this._liveTouchTimeout) {
      clearTimeout(this._liveTouchTimeout);
      this._liveTouchTimeout = undefined;
    }
  }

  /**
   * Set up visibility change handler to refresh when page becomes visible.
   * This handles cases where TV browsers or mobile devices disconnect WebSockets
   * when the screen goes to sleep or the tab becomes inactive.
   */
  private _setupVisibilityHandler(): void {
    this._boundVisibilityHandler = () => {
      if (document.visibilityState === 'visible') {
        console.debug('Frigate Events Card: Page became visible, refreshing...');
        this._loadEvents();
        // Re-subscribe in case the WebSocket was disconnected
        if (this._unsubscribe) {
          this._unsubscribe();
          this._unsubscribe = undefined;
        }
        this._subscribeToEvents();

        // Resume live WebRTC stream if card is in viewport
        if (this._config?.live_view && this._isIntersecting && !this._peerConnection) {
          this._startWebRTC();
        }
      } else if (document.visibilityState === 'hidden') {
        // Halt WebRTC stream decoding immediately when tab/window is hidden or in background
        if (this._config?.live_view && this._peerConnection) {
          this._teardownWebRTC();
        }
      }
    };
    document.addEventListener('visibilitychange', this._boundVisibilityHandler);
  }

  /**
   * Set up periodic polling as a fallback for stale WebSocket connections.
   * This ensures the card stays updated even if the subscription silently dies.
   */
  private _setupPolling(): void {
    this._pollInterval = window.setInterval(() => {
      // Only poll if the page is visible
      if (document.visibilityState === 'visible') {
        this._loadEvents();
      }
    }, FALLBACK_POLL_INTERVAL);
  }

  /**
   * Ctrl+Opt+Cmd+D toggles the version badge without editing Lovelace
   * config. Uses e.code (not e.key) since Option modifies the character.
   * Persisted in localStorage so it survives refresh while testing.
   */
  private _setupDebugVersionToggle(): void {
    if (this._boundDebugVersionHandler) return;
    try {
      const stored = window.localStorage?.getItem('frigate-events-card-show-version');
      if (stored === '1') this._showVersionOverride = true;
      else if (stored === '0') this._showVersionOverride = false;
    } catch {
      // Ignore storage errors (private mode, etc.)
    }
    this._boundDebugVersionHandler = (e: KeyboardEvent) => {
      if (e.code === 'KeyD' && e.ctrlKey && e.altKey && e.metaKey) {
        // Only available when testing: true is in config, so the hotkey
        // passes through untouched for everyone else.
        if (this._config?.testing !== true) return;
        e.preventDefault();
        const current = this._showVersionOverride ?? false;
        this._showVersionOverride = !current;
        try {
          window.localStorage?.setItem(
            'frigate-events-card-show-version',
            this._showVersionOverride ? '1' : '0'
          );
        } catch {
          // Ignore storage errors
        }
      }
    };
    window.addEventListener('keydown', this._boundDebugVersionHandler);
  }

  /**
   * Set up an IntersectionObserver to gate the WebRTC connection to card visibility.
   * Opens the peer connection when ≥10% of the card is in the viewport,
   * and closes it (after LIVE_VIEW_TEARDOWN_GRACE_MS) when it leaves.
   */
  private _setupLiveView(): void {
    if (!this._config?.live_view) return;

    const entity = this._config.live_view_entity;
    if (!entity) {
      console.warn('Frigate Events Card: live_view is enabled but live_view_entity is not set.');
      this._liveViewError = 'live_view_entity is required when live_view is true';
      return;
    }
    if (!entity.startsWith('camera.')) {
      console.warn(`Frigate Events Card: live_view_entity "${entity}" must be a camera entity (must start with "camera.").`);
      this._liveViewError = `"${entity}" is not a camera entity`;
      return;
    }

    this._intersectionObserver = new IntersectionObserver(
      (entries) => {
        const isVisible = entries.some(e => e.isIntersecting);
        this._isIntersecting = isVisible;
        if (isVisible && document.visibilityState === 'visible') {
          // Cancel any pending teardown grace timer
          if (this._intersectionGraceTimer) {
            clearTimeout(this._intersectionGraceTimer);
            this._intersectionGraceTimer = undefined;
          }
          // Start WebRTC if not already running
          if (!this._peerConnection) {
            this._startWebRTC();
          }
        } else {
          // Delay teardown to absorb minor scroll jitter
          if (!this._intersectionGraceTimer) {
            this._intersectionGraceTimer = window.setTimeout(() => {
              this._intersectionGraceTimer = undefined;
              this._teardownWebRTC();
            }, LIVE_VIEW_TEARDOWN_GRACE_MS);
          }
        }
      },
      { threshold: 0.1 }
    );
    this._intersectionObserver.observe(this);
  }

  /**
   * Negotiate a WebRTC peer connection to the configured camera entity via
   * Home Assistant's camera/web_rtc_offer WebSocket subscription protocol.
   *
   * This is the same protocol used internally by ha-web-rtc-player, but
   * called directly so we don't depend on HA's internal Lit context providers.
   */
  private async _startWebRTC(allowAudio = true): Promise<void> {
    if (!this.hass || !this._config?.live_view_entity) return;
    const entity = this._config.live_view_entity;

    // Verify entity exists in HA state registry (if using HA WebSocket signaling)
    if (!this._config?.go2rtc_url && !this.hass.states[entity]) {
      console.warn(`Frigate Events Card: Camera entity "${entity}" not found in Home Assistant.`);
      this._liveViewError = `Entity "${entity}" not found`;
      return;
    }

    // WebRTC requires a secure context (HTTPS) in all modern browsers
    if (typeof RTCPeerConnection === 'undefined') {
      console.warn('Frigate Events Card: WebRTC is not supported in this context. HTTPS is required.');
      this._liveViewError = 'WebRTC unavailable — HTTPS required';
      return;
    }

    // If direct go2rtc URL is specified in config, use direct go2rtc WebRTC endpoint
    if (this._config.go2rtc_url) {
      const streamName = this._config.go2rtc_stream || entity.replace(/^camera\./, '');
      await this._startGo2rtcWebRTC(this._config.go2rtc_url, streamName);
      return;
    }

    try {
      // --- Peer connection setup ---
      const pc = new RTCPeerConnection({ iceServers: WEBRTC_STUN_SERVERS });
      this._peerConnection = pc;

      const remoteStream = new MediaStream();
      this._remoteStream = remoteStream;
      // Attach to the video element if it's already in the DOM
      const videoEl = this._liveVideoEl || (this.renderRoot?.querySelector('.live-view-video') as HTMLVideoElement | null);
      if (videoEl) {
        this._liveVideoEl = videoEl;
        videoEl.muted = this._isLiveMuted;
        if (videoEl.srcObject !== remoteStream) {
          videoEl.srcObject = remoteStream;
          videoEl.play().catch(() => {});
        }
      }

      pc.ontrack = (event) => {
        // Add each incoming track to the stream that's already attached to the <video>
        event.streams[0]?.getTracks().forEach(track => remoteStream.addTrack(track));
        const video = this._liveVideoEl || (this.renderRoot?.querySelector('.live-view-video') as HTMLVideoElement | null);
        if (video) {
          this._liveVideoEl = video;
          video.muted = this._isLiveMuted;
          if (video.srcObject !== remoteStream) {
            video.srcObject = remoteStream;
          }
          video.play().catch(() => {});
        }
      };

      // Signal willingness to receive video and audio (if supported)
      pc.addTransceiver('video', { direction: 'recvonly' });
      if (allowAudio) {
        pc.addTransceiver('audio', { direction: 'recvonly' });
      }

      // --- SDP offer ---
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      // Gather ICE candidates before sending the offer (complete gathering or 3s timeout).
      // This is a Vanilla ICE approach — simpler and works well on LAN.
      const sdpOffer = await new Promise<string>((resolve) => {
        if (pc.iceGatheringState === 'complete') {
          resolve(pc.localDescription!.sdp);
          return;
        }
        const onStateChange = () => {
          if (pc.iceGatheringState === 'complete') {
            resolve(pc.localDescription!.sdp);
          }
        };
        pc.onicegatheringstatechange = onStateChange;
        // 3-second fallback to support Trickle ICE if the camera needs it
        setTimeout(() => resolve(pc.localDescription?.sdp || offer.sdp!), 3000);
      });

      // --- Subscribe to HA's WebRTC offer/answer event stream ---
      this._liveViewUnsub = await this.hass.connection.subscribeMessage<HAWebRtcEvent>(
        async (event) => {
          // Guard against events arriving after teardown
          if (!this._peerConnection || this._peerConnection !== pc) return;

          switch (event.type) {
            case 'session':
              this._liveViewSessionId = event.session_id;
              break;

            case 'answer':
              try {
                await pc.setRemoteDescription(
                  new RTCSessionDescription({ type: 'answer', sdp: event.answer })
                );
                this._liveViewError = undefined; // Clear any prior error on success
              } catch (e) {
                console.error('Frigate Events Card: Failed to set WebRTC remote description:', e);
                this._liveViewError = 'Stream negotiation failed';
                this._teardownWebRTC();
              }
              break;

            case 'candidate':
              try {
                await pc.addIceCandidate(new RTCIceCandidate(event.candidate));
              } catch {
                // Non-fatal — ICE candidate errors can occur as connections transition
              }
              break;

            case 'error':
              console.warn(
                `Frigate Events Card: WebRTC stream error (${event.code}): ${event.message}`
              );
              this._teardownWebRTC();
              if (allowAudio) {
                console.info('Frigate Events Card: Retrying WebRTC with video-only...');
                this._startWebRTC(false);
                return;
              }
              this._liveViewError = event.message || 'Camera stream unavailable';
              break;
          }
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { type: 'camera/web_rtc_offer', entity_id: entity, offer: sdpOffer } as any
      );

      // --- Trickle ICE: send local candidates to HA as they're discovered ---
      pc.onicecandidate = ({ candidate }) => {
        if (candidate && this._liveViewSessionId && this.hass) {
          this.hass.callWS({
            type: 'camera/web_rtc_candidate',
            session_id: this._liveViewSessionId,
            candidate: candidate.toJSON(),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          } as any).catch(() => {});
        }
      };

      // --- Monitor for connection failure and 24/7 self-healing recovery ---
      this._setupWebRTCMonitoring(pc);

    } catch (e: any) {
      this._teardownWebRTC();
      if (allowAudio) {
        console.info('Frigate Events Card: Retrying WebRTC with video-only...');
        this._startWebRTC(false);
        return;
      }
      let msg = e?.message || (typeof e === 'object' ? JSON.stringify(e) : String(e));
      if (e?.code === 'unknown_command' || msg.toLowerCase().includes('unknown command')) {
        msg = 'HA WebRTC protocol (camera/web_rtc_offer) not supported for this entity. Fix WebRTC Camera integration in HA or set go2rtc_url in card config.';
      }
      console.error('Frigate Events Card: Failed to start WebRTC session:', msg);
      this._liveViewError = `Failed to start: ${msg}`;
    }
  }

  private async _startGo2rtcWebRTC(go2rtcUrl: string, streamName: string): Promise<void> {
    try {
      const pc = new RTCPeerConnection({ iceServers: WEBRTC_STUN_SERVERS });
      this._peerConnection = pc;

      const remoteStream = new MediaStream();
      this._remoteStream = remoteStream;
      const videoEl = this._liveVideoEl || (this.renderRoot?.querySelector('.live-view-video') as HTMLVideoElement | null);
      if (videoEl) {
        this._liveVideoEl = videoEl;
        videoEl.muted = this._isLiveMuted;
        if (videoEl.srcObject !== remoteStream) {
          videoEl.srcObject = remoteStream;
          videoEl.play().catch(() => {});
        }
      }

      pc.ontrack = (event) => {
        event.streams[0]?.getTracks().forEach((track) => remoteStream.addTrack(track));
        const video = this._liveVideoEl || (this.renderRoot?.querySelector('.live-view-video') as HTMLVideoElement | null);
        if (video) {
          this._liveVideoEl = video;
          video.muted = this._isLiveMuted;
          if (video.srcObject !== remoteStream) {
            video.srcObject = remoteStream;
          }
          video.play().catch(() => {});
        }
      };

      pc.addTransceiver('video', { direction: 'recvonly' });
      pc.addTransceiver('audio', { direction: 'recvonly' });

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      const sdpOffer = await new Promise<string>((resolve) => {
        if (pc.iceGatheringState === 'complete') {
          resolve(pc.localDescription!.sdp);
          return;
        }
        const onStateChange = () => {
          if (pc.iceGatheringState === 'complete') {
            resolve(pc.localDescription!.sdp);
          }
        };
        pc.onicegatheringstatechange = onStateChange;
        setTimeout(() => resolve(pc.localDescription?.sdp || offer.sdp!), 3000);
      });

      const cleanUrl = go2rtcUrl.replace(/\/+$/, '');
      const res = await fetch(`${cleanUrl}/api/webrtc?src=${encodeURIComponent(streamName)}`, {
        method: 'POST',
        body: sdpOffer,
      });

      if (!res.ok) {
        throw new Error(`go2rtc returned HTTP ${res.status}: ${res.statusText}`);
      }

      const text = await res.text();
      let answerSdp = text;
      try {
        const json = JSON.parse(text);
        if (json.sdp) answerSdp = json.sdp;
        else if (json.error) throw new Error(json.error);
      } catch (e: any) {
        if (e.message && !e.message.includes('JSON') && !e.message.includes('Unexpected token')) throw e;
      }

      await pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: answerSdp }));
      this._liveViewError = undefined;

      // --- Monitor for connection failure and 24/7 self-healing recovery ---
      this._setupWebRTCMonitoring(pc);
    } catch (e: any) {
      const msg = e?.message || String(e);
      console.error('Frigate Events Card: Failed direct go2rtc WebRTC session:', msg);
      this._liveViewError = `Failed go2rtc stream: ${msg}`;
      this._teardownWebRTC();
    }
  }

  /**
   * Close the WebRTC peer connection and free all associated resources.
   * Sends the close_webrtc_session command to HA so the server-side
   * session is also released. Safe to call multiple times.
   */
  private _teardownWebRTC(): void {
    if (this._disconnectTimer) {
      clearTimeout(this._disconnectTimer);
      this._disconnectTimer = undefined;
    }

    if (this._peerConnection) {
      this._peerConnection.ontrack = null;
      this._peerConnection.onicecandidate = null;
      this._peerConnection.onconnectionstatechange = null;
      this._peerConnection.oniceconnectionstatechange = null;
      this._peerConnection.onicegatheringstatechange = null;
      this._peerConnection.close();
      this._peerConnection = undefined;
    }

    if (this._liveViewUnsub) {
      this._liveViewUnsub();
      this._liveViewUnsub = undefined;
    }

    // Tell HA to release the server-side WebRTC session
    if (this._liveViewSessionId && this.hass) {
      this.hass.callWS({
        type: 'camera/close_webrtc_session',
        session_id: this._liveViewSessionId,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any).catch(() => {});
      this._liveViewSessionId = undefined;
    }

    // Detach the stream from the video element and stop all tracks
    if (this._liveVideoEl) {
      try {
        this._liveVideoEl.pause();
      } catch (_) {}
      this._liveVideoEl.srcObject = null;
    }
    if (this._remoteStream) {
      this._remoteStream.getTracks().forEach((track) => track.stop());
      this._remoteStream = undefined;
    }
  }

  /**
   * Handle clicking the live view video to toggle fullscreen.
   */
  private _handleLiveViewClick(e: Event): void {
    if (this._didLongPress) {
      this._didLongPress = false;
      return;
    }
    if (this._justExitedFullscreen) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    const container = e.currentTarget as HTMLElement;
    const videoEl = this._liveVideoEl || container.querySelector('video');

    // Check if element or document is currently fullscreen
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fsDoc = document as any;
    const isFullscreen = this._isFullscreen();

    if (isFullscreen) {
      e.preventDefault();
      e.stopPropagation();
      this._justExitedFullscreen = true;
      setTimeout(() => {
        this._justExitedFullscreen = false;
      }, 600);

      if (document.exitFullscreen) {
        document.exitFullscreen().catch(() => {});
      } else if (fsDoc.webkitExitFullscreen) {
        fsDoc.webkitExitFullscreen();
      } else if (fsDoc.mozCancelFullScreen) {
        fsDoc.mozCancelFullScreen();
      } else if (fsDoc.msExitFullscreen) {
        fsDoc.msExitFullscreen();
      } else if ((videoEl as any)?.webkitExitFullscreen) {
        (videoEl as any).webkitExitFullscreen();
      }

      if (videoEl && videoEl.paused) {
        videoEl.play().catch(() => {});
      }
      return;
    }

    if (videoEl) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const v = videoEl as any;
      videoEl.classList.add('fullscreen-active');
      videoEl.style.setProperty('pointer-events', 'auto', 'important');
      this._resetCursorHideTimer(container, videoEl);

      if (v.requestFullscreen) {
        v.requestFullscreen().catch(() => {
          if (v.webkitEnterFullscreen) {
            v.webkitEnterFullscreen();
          } else if (container && container.requestFullscreen) {
            container.requestFullscreen().catch(() => {});
          }
        });
      } else if (v.webkitEnterFullscreen) {
        v.webkitEnterFullscreen();
      } else if (v.webkitRequestFullscreen) {
        v.webkitRequestFullscreen();
      } else if (container && container.requestFullscreen) {
        container.requestFullscreen().catch(() => {});
      }
    } else if (container && container.requestFullscreen) {
      container.requestFullscreen().catch(() => {});
    }
  }

  /**
   * Check if live view video or container is currently displayed in fullscreen.
   */
  private _isFullscreen(): boolean {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fsDoc = document as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const shadowDoc = this.shadowRoot as any;
    const container = this.renderRoot?.querySelector('.live-view-container') as HTMLElement | null;
    const videoEl = this._liveVideoEl || container?.querySelector('video');
    const safeMatches = (el: Element | null | undefined, sel: string): boolean => {
      try {
        return !!el?.matches?.(sel);
      } catch {
        return false;
      }
    };
    return !!(
      fsDoc.fullscreenElement ||
      fsDoc.webkitFullscreenElement ||
      fsDoc.mozFullScreenElement ||
      fsDoc.msFullscreenElement ||
      shadowDoc?.fullscreenElement ||
      shadowDoc?.webkitFullscreenElement ||
      (videoEl as any)?.webkitDisplayingFullscreen ||
      safeMatches(videoEl, ':fullscreen') ||
      safeMatches(videoEl, ':-webkit-full-screen') ||
      safeMatches(container, ':fullscreen') ||
      safeMatches(container, ':-webkit-full-screen')
    );
  }

  /**
   * Listen for document fullscreenchange and mouse movement to auto-hide cursor during fullscreen playback.
   */
  private _setupFullscreenListener(): void {
    if (this._boundFullscreenHandler) return;
    this._boundFullscreenHandler = () => this._handleFullscreenChange();
    this._boundFullscreenMouseMoveHandler = () => this._handleFullscreenMouseMove();

    document.addEventListener('fullscreenchange', this._boundFullscreenHandler);
    document.addEventListener('webkitfullscreenchange', this._boundFullscreenHandler);
    window.addEventListener('mousemove', this._boundFullscreenMouseMoveHandler, { capture: true, passive: true });
    window.addEventListener('pointermove', this._boundFullscreenMouseMoveHandler, { capture: true, passive: true });
    document.addEventListener('mousemove', this._boundFullscreenMouseMoveHandler, { capture: true, passive: true });
    document.addEventListener('pointermove', this._boundFullscreenMouseMoveHandler, { capture: true, passive: true });

    if (this._liveVideoEl) {
      this._liveVideoEl.addEventListener('webkitbeginfullscreen', this._boundFullscreenHandler);
      this._liveVideoEl.addEventListener('webkitendfullscreen', this._boundFullscreenHandler);
      this._liveVideoEl.addEventListener('fullscreenchange', this._boundFullscreenHandler);
      this._liveVideoEl.addEventListener('webkitfullscreenchange', this._boundFullscreenHandler);
      this._liveVideoEl.addEventListener('mousemove', this._boundFullscreenMouseMoveHandler, { capture: true, passive: true });
      this._liveVideoEl.addEventListener('pointermove', this._boundFullscreenMouseMoveHandler, { capture: true, passive: true });
    }
  }

  private _handleFullscreenChange(): void {
    const isFs = this._isFullscreen();
    const container = this.renderRoot?.querySelector('.live-view-container') as HTMLElement | null;
    const videoEl = this._liveVideoEl || container?.querySelector('video');

    if (!isFs) {
      if (this._cursorHideTimeout) {
        clearTimeout(this._cursorHideTimeout);
        this._cursorHideTimeout = undefined;
      }
      container?.classList.remove('hide-cursor');
      videoEl?.classList.remove('hide-cursor');
      videoEl?.classList.remove('fullscreen-active');
      container?.style.removeProperty('cursor');
      videoEl?.style.removeProperty('cursor');
      videoEl?.style.removeProperty('pointer-events');
      document.documentElement.style.removeProperty('cursor');
      document.body.style.removeProperty('cursor');

      if (videoEl) {
        if (this._remoteStream && videoEl.srcObject !== this._remoteStream) {
          videoEl.srcObject = this._remoteStream;
        }
        if (videoEl.paused) {
          videoEl.play().catch(() => {});
        }
        setTimeout(() => {
          if (videoEl && this._remoteStream && videoEl.srcObject !== this._remoteStream) {
            videoEl.srcObject = this._remoteStream;
          }
          if (videoEl?.paused) {
            videoEl.play().catch(() => {});
          }
        }, 150);
      }
    } else {
      videoEl?.classList.add('fullscreen-active');
      videoEl?.style.setProperty('pointer-events', 'auto', 'important');
      this._resetCursorHideTimer(container, videoEl);
    }
  }

  private _handleFullscreenMouseMove(): void {
    if (!this._isFullscreen()) return;
    const container = this.renderRoot?.querySelector('.live-view-container') as HTMLElement | null;
    const videoEl = this._liveVideoEl || container?.querySelector('video');

    container?.classList.remove('hide-cursor');
    videoEl?.classList.remove('hide-cursor');
    container?.style.removeProperty('cursor');
    videoEl?.style.removeProperty('cursor');
    document.documentElement.style.removeProperty('cursor');
    document.body.style.removeProperty('cursor');

    this._resetCursorHideTimer(container, videoEl);
  }

  private _resetCursorHideTimer(container?: HTMLElement | null, videoEl?: HTMLVideoElement | null): void {
    if (this._cursorHideTimeout) {
      clearTimeout(this._cursorHideTimeout);
    }
    this._cursorHideTimeout = setTimeout(() => {
      if (this._isFullscreen()) {
        const c = container || (this.renderRoot?.querySelector('.live-view-container') as HTMLElement | null);
        const v = videoEl || this._liveVideoEl || c?.querySelector('video');
        c?.classList.add('hide-cursor');
        v?.classList.add('hide-cursor');
        c?.style.setProperty('cursor', 'none', 'important');
        v?.style.setProperty('cursor', 'none', 'important');
        document.documentElement.style.setProperty('cursor', 'none', 'important');
        document.body.style.setProperty('cursor', 'none', 'important');
      }
    }, 2500);
  }

  /**
   * Monitor WebRTC peer connection and ICE state.
   * Handles immediate recovery on failure, and 10s self-healing grace period
   * on network disconnection (e.g. Wi-Fi blips, router reboots, Frigate restarts).
   */
  private _setupWebRTCMonitoring(pc: RTCPeerConnection): void {
    const handleStateChange = () => {
      const connState = pc.connectionState;
      const iceState = pc.iceConnectionState;
      console.debug(`Frigate Events Card: WebRTC state → connection: ${connState}, ice: ${iceState}`);

      if (connState === 'connected' || iceState === 'connected' || iceState === 'completed') {
        if (this._disconnectTimer) {
          clearTimeout(this._disconnectTimer);
          this._disconnectTimer = undefined;
        }
      } else if (connState === 'failed' || iceState === 'failed') {
        if (this._disconnectTimer) {
          clearTimeout(this._disconnectTimer);
          this._disconnectTimer = undefined;
        }
        console.warn('Frigate Events Card: WebRTC connection failed; auto-reconnecting in 5s.');
        this._teardownWebRTC();
        window.setTimeout(() => {
          if (this._intersectionObserver && !this._peerConnection) {
            this._startWebRTC();
          }
        }, 5000);
      } else if (connState === 'disconnected' || iceState === 'disconnected') {
        if (!this._disconnectTimer) {
          console.warn('Frigate Events Card: WebRTC stream disconnected; starting 10s self-healing timer...');
          this._disconnectTimer = window.setTimeout(() => {
            this._disconnectTimer = undefined;
            if (
              this._peerConnection === pc &&
              (pc.connectionState === 'disconnected' || pc.iceConnectionState === 'disconnected')
            ) {
              console.warn(
                'Frigate Events Card: WebRTC stream remained disconnected for 10s. Triggering self-healing restart.'
              );
              this._teardownWebRTC();
              this._startWebRTC();
            }
          }, 10000);
        }
      }
    };

    pc.onconnectionstatechange = handleStateChange;
    pc.oniceconnectionstatechange = handleStateChange;
  }

  /**
   * True when the Frigate integration reports the server as unreachable.
   * While offline we freeze the gallery on the last known events so the
   * boxes don't flash in/out on every poll + retry.
   */
  private _isFrigateOfflineFor(states: any): boolean {
    if (!states) return false;
    const clientId = this._config?.frigate_client_id || 'frigate';
    const candidates = [
      'sensor.frigate_status',
      `sensor.${clientId}_status`,
    ];
    for (const entityId of candidates) {
      const s = states[entityId];
      if (!s) continue;
      const state = String(s.state ?? '').toLowerCase();
      if (state === 'unavailable' || state === 'unknown' || state === 'none' || state === '') {
        return true;
      }
      // Any other state (e.g. 'running') means online.
      return false;
    }
    return false;
  }

  private _isFrigateOffline(): boolean {
    return this._isFrigateOfflineFor(this.hass?.states as any);
  }

  private async _loadEvents(): Promise<void> {
    if (!this.hass || !this._config) return;

    // Freeze gallery while Frigate is off: keep last events, skip poll flashing.
    if (this._events.length > 0 && this._isFrigateOffline()) {
      this._loading = false;
      return;
    }

    this._error = undefined;

    try {
      const isScroll = !!this._config.scroll;
      const visibleCount = this._config.event_count || 5;
      const scrollLimit = this._config.scroll_limit || 20;
      const limit = isScroll ? scrollLimit : visibleCount;
      const offset = this._config.offset || 0;
      const fetchLimit = limit + offset;

      const events = await getEvents(this.hass, {
        instance_id: this._config.frigate_client_id,
        cameras: this._config.cameras,
        labels: this._config.labels,
        zones: this._config.zones,
        limit: fetchLimit,
        has_snapshot: true,
      });

      // Backend can return [] during the shutdown window before sensor.frigate_status
      // flips to unavailable — keep cached events so boxes don't vanish.
      if (events.length === 0 && this._events.length > 0 && this._isFrigateOffline()) {
        return;
      }

      this._events = events.sort((a, b) => (b.start_time || 0) - (a.start_time || 0));
    } catch (e: any) {
      console.warn('Temporary connection issue loading Frigate events:', e);
      const msg = e?.message || (typeof e === 'object' ? JSON.stringify(e) : String(e));
      this._error = `Failed to load events: ${msg}`;
      // Automatically retry in 4 seconds in case Home Assistant or Frigate is starting up
      setTimeout(() => {
        if (this._error && this.isConnected) {
          this._loadEvents();
        }
      }, 4000);
    } finally {
      this._loading = false;
    }
  }

  private async _subscribeToEvents(): Promise<void> {
    if (!this.hass || !this._config || this._unsubscribe) return;

    try {
      this._unsubscribe = await subscribeToEvents(
        this.hass,
        this._config.frigate_client_id || 'frigate',
        (change: FrigateEventChange) => {
          // Check if this event matches our filters
          if (!this._matchesFilters(change)) return;

          // Reload events on new detection
          if (change.type === 'new' || change.type === 'end') {
            this._loadEvents();
          }
        }
      );
    } catch (e) {
      console.warn('Failed to subscribe to Frigate events:', e);
    }
  }

  private _matchesFilters(change: FrigateEventChange): boolean {
    const config = this._config;
    if (!config) return true;

    const after = change.after;

    // Check camera filter
    if (config.cameras?.length && !config.cameras.includes(after.camera)) {
      return false;
    }

    // Check label filter
    if (config.labels?.length && !config.labels.includes(after.label)) {
      return false;
    }

    // Check zone filter
    if (config.zones?.length) {
      const hasMatchingZone = config.zones.some(z => after.current_zones.includes(z));
      if (!hasMatchingZone) return false;
    }

    return true;
  }

  private _handleRefresh(): void {
    this._loadEvents();
  }

  private _isTimelineEnabled(): boolean {
    if (this._config?.show_timeline === false) return false;
    if (this._config?.timeline === false) return false;
    return true;
  }

  private _shouldOpenTimelineOnEventClick(): boolean {
    if (!this._isTimelineEnabled()) return false;
    if (this._config?.timeline_on_click === false) return false;
    // only if video playing is enabled, instead of picture
    if (this._config?.video === false) return false;
    return true;
  }

  private _handleEventClick(event: FrigateEvent): void {
    if (this._didLongPress) {
      this._didLongPress = false;
      return;
    }
    if (this._shouldOpenTimelineOnEventClick()) {
      this._showTimelineModal(event.camera, event.start_time, event);
      return;
    }
    this._selectedEvent = event;
    this._showModal();
  }

  private _handleModalClose(): void {
    this._selectedEvent = undefined;
    this._removeModal();
  }

  private _injectModalStyles(): void {
    const styleId = 'frigate-events-card-modal-styles';
    let style = document.getElementById(styleId) as HTMLStyleElement | null;
    if (!style) {
      style = document.createElement('style');
      style.id = styleId;
      document.head.appendChild(style);
    }

    style.textContent = `
      .frigate-events-modal {
        position: fixed;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        background: rgba(0, 0, 0, 0.85);
        z-index: 9999;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: max(16px, env(safe-area-inset-top, 16px)) max(16px, env(safe-area-inset-right, 16px)) max(16px, env(safe-area-inset-bottom, 16px)) max(16px, env(safe-area-inset-left, 16px));
        box-sizing: border-box;
        backdrop-filter: blur(5px);
        -webkit-backdrop-filter: blur(5px);
        overflow-y: auto;
        -webkit-overflow-scrolling: touch;
        animation: frigate-modal-fade-in 0.2s forwards;
      }

      @keyframes frigate-modal-fade-in {
        from { opacity: 0; }
        to { opacity: 1; }
      }

      .frigate-events-modal-content {
        position: relative;
        width: fit-content;
        min-width: 0;
        max-width: min(92vw, 850px);
        max-height: calc(100dvh - max(24px, env(safe-area-inset-top, 12px) + env(safe-area-inset-bottom, 12px)));
        margin: auto;
        background: var(--card-background-color, #1c1c1c);
        border-radius: 12px;
        overflow: hidden;
        box-shadow: 0 8px 30px rgba(0, 0, 0, 0.7);
        display: flex;
        flex-direction: column;
        animation: frigate-modal-slide-up 0.2s forwards;
      }

      @keyframes frigate-modal-slide-up {
        from { transform: translateY(20px); opacity: 0; }
        to { transform: translateY(0); opacity: 1; }
      }

      .frigate-events-modal-image-container {
        position: relative;
        display: flex;
        justify-content: center;
        align-items: center;
        background: #1c1c1c;
        width: fit-content;
        max-width: 100%;
        margin: 0 auto;
        overflow: hidden;
      }

      .frigate-events-modal-image-container img,
      .frigate-events-modal-image-container video {
        display: block;
        width: auto;
        height: auto;
        max-width: min(92vw, 850px);
        max-height: 60dvh;
        object-fit: contain;
        background-color: #1c1c1c;
      }

      .frigate-events-modal-close {
        position: absolute;
        top: 10px;
        right: 10px;
        background: rgba(0, 0, 0, 0.65);
        color: #ffffff;
        width: 30px;
        height: 30px;
        border-radius: 50%;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 0;
        cursor: pointer;
        transition: background 0.2s, transform 0.15s;
        border: none;
        outline: none;
        z-index: 10;
        box-sizing: border-box;
      }

      .frigate-events-modal-close svg {
        width: 16px;
        height: 16px;
        fill: currentColor;
        display: block;
        pointer-events: none;
        transform: translateY(0.75px);
      }

      .frigate-events-modal-close:hover {
        background: rgba(0, 0, 0, 0.9);
        transform: scale(1.06);
      }

      .frigate-events-modal-nav {
        position: absolute;
        top: 50%;
        transform: translateY(-50%);
        background: rgba(0, 0, 0, 0.5);
        color: white;
        width: 40px;
        height: 40px;
        border-radius: 50%;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 20px;
        cursor: pointer;
        transition: background 0.2s, opacity 0.2s;
        backdrop-filter: blur(4px);
        border: none;
        font-family: inherit;
        z-index: 10;
        user-select: none;
        line-height: 1;
      }

      .frigate-events-modal-nav svg {
        width: 22px;
        height: 22px;
        fill: currentColor;
        display: block;
      }

      .frigate-events-modal-nav:hover {
        background: rgba(0, 0, 0, 0.8);
      }

      .frigate-events-modal-nav.prev {
        left: 10px;
      }

      .frigate-events-modal-nav.next {
        right: 10px;
      }

      .frigate-events-modal-info {
        padding: 16px;
        background: var(--card-background-color, #1c1c1c);
        display: flex;
        flex-direction: column;
        gap: 12px;
        width: 0;
        min-width: 100%;
        box-sizing: border-box;
      }

      .frigate-events-modal-info-top {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        gap: 16px;
        width: 100%;
      }

      .frigate-events-modal-info-left {
        display: flex;
        flex-direction: column;
        gap: 4px;
        min-width: 0;
        flex: 1;
      }

      .frigate-events-modal-info-center {
        display: flex;
        flex: 2;
        align-items: center;
        justify-content: center;
        text-align: center;
        min-width: 0;
        padding: 0 16px;
        align-self: center;
      }

      .frigate-events-modal-info-right {
        display: flex;
        flex-direction: column;
        align-items: flex-end;
        gap: 4px;
        flex: 1;
        flex-shrink: 0;
        text-align: right;
      }

      .frigate-events-modal-label {
        font-size: 20px;
        font-weight: 600;
        color: var(--primary-text-color, #fff);
        line-height: 1.2;
      }

      .frigate-events-modal-camera {
        font-size: 13px;
        color: var(--secondary-text-color, #aaa);
        line-height: 1.2;
      }

      .frigate-events-modal-time {
        font-size: 20px;
        font-weight: 500;
        color: var(--primary-text-color, #fff);
        line-height: 1.2;
      }

      .frigate-events-modal-zones {
        font-size: 13px;
        color: var(--secondary-text-color, #aaa);
        line-height: 1.2;
      }

      .frigate-events-modal-duration {
        font-size: 13px;
        color: var(--secondary-text-color, #aaa);
        line-height: 1.2;
      }

      .frigate-events-modal-score {
        font-size: 13px;
        color: var(--secondary-text-color, #aaa);
        line-height: 1.2;
      }

      .frigate-events-modal-description-row {
        border-top: 1px solid var(--divider-color, rgba(255, 255, 255, 0.15));
        padding-top: 12px;
        margin-top: 4px;
        width: 100%;
        max-height: 90px;
        overflow-y: auto;
      }

      .frigate-events-modal-description-row::-webkit-scrollbar {
        width: 6px;
      }
      .frigate-events-modal-description-row::-webkit-scrollbar-track {
        background: transparent;
      }
      .frigate-events-modal-description-row::-webkit-scrollbar-thumb {
        background-color: rgba(255, 255, 255, 0.15);
        border-radius: 3px;
      }
      .frigate-events-modal-description-row::-webkit-scrollbar-thumb:hover {
        background-color: rgba(255, 255, 255, 0.35);
      }

      .frigate-events-modal-description {
        font-size: 13px;
        line-height: 1.5;
        color: var(--primary-text-color, #e0e0e0);
        font-style: italic;
        white-space: pre-wrap;
      }

      /* ─── Mobile Portrait (< 600px width) ─── */
      @media (max-width: 600px) {
        .frigate-events-modal {
          padding: max(10px, env(safe-area-inset-top, 10px)) max(10px, env(safe-area-inset-right, 10px)) max(10px, env(safe-area-inset-bottom, 10px)) max(10px, env(safe-area-inset-left, 10px));
        }

        .frigate-events-modal-content {
          min-width: 0 !important;
          width: 100% !important;
          max-width: 100% !important;
          max-height: calc(100vh - max(20px, env(safe-area-inset-top, 10px) + env(safe-area-inset-bottom, 10px)));
          border-radius: 10px;
        }

        .frigate-events-modal-image-container img,
        .frigate-events-modal-image-container video {
          max-height: 50vh;
          width: 100%;
          object-fit: contain;
        }

        .frigate-events-modal-info {
          padding: 12px;
          gap: 8px;
        }

        .frigate-events-modal-label {
          font-size: 17px;
        }

        .frigate-events-modal-time {
          font-size: 16px;
        }

        .frigate-events-modal-camera,
        .frigate-events-modal-zones,
        .frigate-events-modal-duration,
        .frigate-events-modal-score,
        .frigate-events-modal-description {
          font-size: 12px;
        }
      }

      /* ─── Mobile Landscape (max-height <= 550px) ─── */
      @media (max-height: 550px) {
        .frigate-events-modal {
          align-items: center !important;
          justify-content: center !important;
          padding: max(8px, env(safe-area-inset-top, 8px)) max(16px, env(safe-area-inset-right, 16px)) max(8px, env(safe-area-inset-bottom, 8px)) max(16px, env(safe-area-inset-left, 16px)) !important;
        }

        .frigate-events-modal-content {
          margin: auto !important;
          min-width: 0 !important;
          width: fit-content !important;
          max-width: min(94vw, 850px) !important;
          max-height: calc(100dvh - max(16px, env(safe-area-inset-top, 8px) + env(safe-area-inset-bottom, 8px))) !important;
          overflow-y: auto;
          box-shadow: 0 8px 30px rgba(0, 0, 0, 0.7);
        }

        .frigate-events-modal-image-container {
          width: fit-content !important;
          margin: 0 auto !important;
        }

        .frigate-events-modal-image-container img,
        .frigate-events-modal-image-container video {
          max-height: 68dvh !important;
          width: auto !important;
          max-width: min(94vw, 850px) !important;
          object-fit: contain;
          display: block;
        }

        .frigate-events-modal-info {
          padding: 6px 12px;
          gap: 4px;
          width: 100%;
        }

        .frigate-events-modal-label,
        .frigate-events-modal-time {
          font-size: 14px;
        }

        .frigate-events-modal-camera,
        .frigate-events-modal-zones,
        .frigate-events-modal-duration,
        .frigate-events-modal-score,
        .frigate-events-modal-description {
          font-size: 11px;
        }

        .frigate-events-modal-description-row {
          max-height: 40px;
          padding-top: 4px;
          margin-top: 2px;
        }

        .frigate-events-modal-close {
          top: 6px;
          right: 6px;
          width: 26px;
          height: 26px;
        }

        .frigate-events-modal-close svg {
          width: 14px;
          height: 14px;
        }

        .frigate-events-modal-nav {
          width: 32px;
          height: 32px;
        }
      }

      .frigate-events-context-menu {
        position: fixed;
        z-index: 10000;
        background: rgba(28, 28, 28, 0.96);
        border: 1px solid rgba(255, 255, 255, 0.16);
        border-radius: 10px;
        padding: 6px;
        min-width: 190px;
        box-shadow: 0 10px 30px rgba(0, 0, 0, 0.6);
        backdrop-filter: blur(12px);
        display: flex;
        flex-direction: column;
        gap: 2px;
        animation: frigate-menu-pop 0.15s ease-out forwards;
        user-select: none;
        font-family: inherit;
        box-sizing: border-box;
      }

      @keyframes frigate-menu-pop {
        from { opacity: 0; transform: scale(0.95); }
        to { opacity: 1; transform: scale(1); }
      }

      .frigate-events-context-item {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 8px 12px;
        color: var(--primary-text-color, #ffffff);
        font-size: 13px;
        font-weight: 500;
        border-radius: 6px;
        cursor: pointer;
        transition: background 0.15s, color 0.15s;
        border: none;
        background: transparent;
        width: 100%;
        text-align: left;
        box-sizing: border-box;
        font-family: inherit;
      }

      .frigate-events-context-item:hover {
        background: rgba(255, 255, 255, 0.12);
      }

      .frigate-events-context-item svg {
        width: 16px;
        height: 16px;
        fill: currentColor;
        flex-shrink: 0;
        display: block;
      }

      .frigate-events-context-item.danger {
        color: #fca5a5;
      }

      .frigate-events-context-item.danger:hover {
        background: rgba(239, 68, 68, 0.2);
        color: #f87171;
      }

      .frigate-events-context-item.masked {
        color: #93c5fd;
      }

      .frigate-events-context-item.masked:hover {
        background: rgba(59, 130, 246, 0.2);
        color: #60a5fa;
      }

      .frigate-events-context-separator {
        height: 1px;
        background: rgba(255, 255, 255, 0.12);
        margin: 4px 0;
      }

      .frigate-events-context-item-wrapper {
        position: relative;
        width: 100%;
      }

      .submenu-arrow {
        width: 14px !important;
        height: 14px !important;
        margin-left: auto;
        opacity: 0.6;
        flex-shrink: 0;
      }

      .frigate-events-submenu {
        position: absolute;
        top: 0;
        left: calc(100% + 4px);
        background: rgba(28, 28, 28, 0.98);
        border: 1px solid rgba(255, 255, 255, 0.16);
        border-radius: 10px;
        padding: 6px;
        min-width: 160px;
        box-shadow: 0 10px 30px rgba(0, 0, 0, 0.6);
        backdrop-filter: blur(12px);
        display: none;
        flex-direction: column;
        gap: 2px;
        animation: frigate-menu-pop 0.15s ease-out forwards;
        user-select: none;
        z-index: 10002;
        box-sizing: border-box;
      }

      .frigate-events-context-item-wrapper:hover .frigate-events-submenu,
      .frigate-events-context-item-wrapper.open .frigate-events-submenu {
        display: flex;
      }

      .frigate-events-submenu.align-left {
        left: auto;
        right: calc(100% + 4px);
      }

      .frigate-events-submenu.align-top {
        top: auto;
        bottom: 0;
      }

      .frigate-events-context-item .duration-label-container {
        display: flex;
        flex-direction: column;
        gap: 1px;
        line-height: 1.2;
      }

      .frigate-events-context-item .duration-subtitle {
        font-size: 11px;
        opacity: 0.65;
        font-weight: normal;
      }

      .frigate-events-context-item.selected {
        color: #93c5fd;
        font-weight: 600;
      }

      .frigate-events-context-item .check-icon {
        width: 14px !important;
        height: 14px !important;
        fill: #60a5fa;
        margin-left: auto;
        flex-shrink: 0;
      }

      /* ─── Mask Manager ───
         Quiet surface that inherits the Home Assistant theme. Spacing follows a 4/8px scale. */
      .frigate-mask-manager-modal {
        --mm-text: var(--primary-text-color, #f2f2f7);
        --mm-text-2: var(--secondary-text-color, #9a9aa2);
        --mm-line: var(--divider-color, rgba(255, 255, 255, 0.12));
        --mm-accent: var(--primary-color, #0a84ff);
        --mm-warn: #ff9f0a;
        --mm-danger: var(--error-color, #ff453a);
        --mm-fill: color-mix(in srgb, var(--mm-text) 7%, transparent);
        --mm-fill-hover: color-mix(in srgb, var(--mm-text) 12%, transparent);
      }

      .frigate-mask-manager-modal .frigate-events-modal-content {
        width: min(560px, 94vw);
        min-width: 0;
        max-width: 560px;
        height: auto;
        max-height: min(720px, calc(100dvh - 32px));
        border: 1px solid var(--mm-line);
        border-radius: 16px;
        box-shadow: 0 24px 48px rgba(0, 0, 0, 0.5);
        background: var(--card-background-color, #1c1c1e);
        color: var(--mm-text);
      }

      .frigate-mask-manager-modal .frigate-events-modal-close {
        top: 12px;
        right: 12px;
        width: 32px;
        height: 32px;
        background: var(--mm-fill);
        color: var(--mm-text-2);
      }

      .frigate-mask-manager-modal .frigate-events-modal-close:hover {
        background: var(--mm-fill-hover);
        color: var(--mm-text);
        transform: none;
      }

      .mask-manager-header {
        display: flex;
        align-items: baseline;
        gap: 8px;
        flex-shrink: 0;
        padding: 20px 56px 12px 24px;
      }

      .mask-manager-title {
        margin: 0;
        font-size: 20px;
        font-weight: 600;
        letter-spacing: -0.01em;
        color: var(--mm-text);
      }

      .mask-manager-count {
        font-size: 13px;
        color: var(--mm-text-2);
      }

      .mask-filter-tabs {
        display: flex;
        gap: 4px;
        flex-shrink: 0;
        padding: 0 16px;
        overflow-x: auto;
        scrollbar-width: none;
        border-bottom: 1px solid var(--mm-line);
      }

      .mask-filter-tabs::-webkit-scrollbar {
        display: none;
      }

      .mask-filter-tab {
        position: relative;
        padding: 8px 8px 12px;
        font-size: 13px;
        font-weight: 500;
        font-family: inherit;
        color: var(--mm-text-2);
        background: none;
        border: none;
        white-space: nowrap;
        cursor: pointer;
        transition: color 0.15s ease;
      }

      .mask-filter-tab:hover {
        color: var(--mm-text);
      }

      .mask-filter-tab.active {
        color: var(--mm-text);
      }

      .mask-filter-tab.active::after {
        content: '';
        position: absolute;
        left: 8px;
        right: 8px;
        bottom: -1px;
        height: 2px;
        border-radius: 2px;
        background: var(--mm-accent);
      }

      .mask-filter-count {
        margin-left: 2px;
        font-weight: 400;
        color: var(--mm-text-2);
      }

      .mask-manager-body {
        flex: 1;
        min-height: 0;
        overflow-y: auto;
        overscroll-behavior: contain;
        padding: 8px 8px 16px;
        box-sizing: border-box;
      }

      .mask-list {
        display: flex;
        flex-direction: column;
      }

      .mask-row {
        border-radius: 12px;
        transition: background 0.15s ease;
      }

      .mask-row + .mask-row {
        margin-top: 2px;
      }

      .mask-row.expanded {
        background: var(--mm-fill);
      }

      .mask-row-head {
        display: flex;
        align-items: center;
        gap: 12px;
        width: 100%;
        min-height: 84px;
        padding: 8px 12px;
        box-sizing: border-box;
        font-family: inherit;
        text-align: left;
        color: inherit;
        background: none;
        border: none;
        border-radius: 12px;
      }

      button.mask-row-head {
        cursor: pointer;
      }

      button.mask-row-head:hover {
        background: var(--mm-fill);
      }

      .mask-row.expanded button.mask-row-head:hover {
        background: none;
      }

      .mask-row-head:focus-visible,
      .mask-seg-btn:focus-visible,
      .mask-chip:focus-visible,
      .mask-remove-btn:focus-visible,
      .mask-edit-btn:focus-visible,
      .mask-edit-save:focus-visible,
      .mask-edit-cancel:focus-visible,
      .mask-edit-size-btn:focus-visible,
      .mask-text-btn:focus-visible,
      .mask-filter-tab:focus-visible {
        outline: 2px solid var(--mm-accent);
        outline-offset: 2px;
      }

      .mask-thumb,
      .mask-frame {
        position: relative;
        overflow: hidden;
        background: var(--mm-fill);
      }

      .mask-thumb {
        flex: 0 0 120px;
        width: 120px;
        aspect-ratio: 16 / 9;
        border-radius: 8px;
      }

      .mask-row.expanded .mask-thumb {
        display: none;
      }

      .mask-frame {
        aspect-ratio: 16 / 9;
        border-radius: 8px;
        margin: 0 12px;
      }

      .mask-preview-thumb,
      .mask-preview-minimap {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
      }

      .mask-preview-thumb {
        object-fit: cover;
        display: block;
      }

      .mask-preview-minimap {
        pointer-events: none;
      }

      .minimap-poly {
        fill: rgba(255, 255, 255, 0.14);
        stroke: rgba(255, 255, 255, 0.9);
        stroke-width: 1.5px;
        vector-effect: non-scaling-stroke;
      }

      .mask-row-text {
        flex: 1;
        min-width: 0;
        display: flex;
        flex-direction: column;
        gap: 2px;
      }

      .mask-row-title {
        font-size: 15px;
        font-weight: 600;
        line-height: 20px;
        color: var(--mm-text);
        text-transform: capitalize;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .mask-row-sub {
        font-size: 13px;
        line-height: 16px;
        color: var(--mm-text-2);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .mask-row-time {
        flex-shrink: 0;
        font-size: 13px;
        font-variant-numeric: tabular-nums;
        color: var(--mm-text-2);
      }

      .mask-row-time.expiring {
        color: var(--mm-warn);
      }

      .mask-row-chevron {
        flex: 0 0 20px;
        width: 20px;
        height: 20px;
        fill: var(--mm-text-2);
        transition: transform 0.15s ease;
      }

      .mask-row.expanded .mask-row-chevron {
        transform: rotate(90deg);
      }

      .mask-row-detail {
        display: none;
        padding: 0 0 12px;
      }

      .mask-row.expanded .mask-row-detail {
        display: block;
      }

      .mask-meta {
        margin: 8px 12px 0;
        font-size: 12px;
        line-height: 16px;
        color: var(--mm-text-2);
      }

      .mask-controls {
        display: flex;
        align-items: flex-end;
        justify-content: space-between;
        flex-wrap: wrap;
        gap: 12px;
        margin: 12px 12px 0;
      }

      .mask-duration {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }

      .mask-control-label {
        font-size: 12px;
        line-height: 16px;
        color: var(--mm-text-2);
      }

      .mask-segmented {
        display: inline-flex;
        padding: 2px;
        gap: 2px;
        border-radius: 8px;
        background: var(--mm-fill);
      }

      .mask-seg-btn {
        min-width: 44px;
        min-height: 32px;
        padding: 0 12px;
        font-size: 13px;
        font-weight: 500;
        font-family: inherit;
        color: var(--mm-text-2);
        background: none;
        border: none;
        border-radius: 6px;
        cursor: pointer;
        transition: background 0.15s ease, color 0.15s ease;
      }

      .mask-seg-btn:hover {
        color: var(--mm-text);
      }

      .mask-seg-btn.active {
        color: var(--mm-text);
        background: var(--card-background-color, #1c1c1e);
        box-shadow: 0 1px 2px rgba(0, 0, 0, 0.35), 0 0 0 0.5px var(--mm-line);
      }

      .mask-more {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        margin: 12px 12px 0;
      }

      .mask-more[hidden] {
        display: none;
      }

      .mask-chip {
        min-height: 32px;
        padding: 0 12px;
        font-size: 13px;
        font-weight: 500;
        font-family: inherit;
        color: var(--mm-text-2);
        background: none;
        border: 1px solid var(--mm-line);
        border-radius: 16px;
        cursor: pointer;
        transition: background 0.15s ease, color 0.15s ease;
      }

      .mask-chip:hover {
        color: var(--mm-text);
        background: var(--mm-fill);
      }

      .mask-chip.active {
        color: var(--mm-text);
        border-color: var(--mm-accent);
      }

      .mask-remove-btn,
      .mask-text-btn {
        min-height: 32px;
        padding: 0 8px;
        font-size: 13px;
        font-weight: 500;
        font-family: inherit;
        background: none;
        border: none;
        border-radius: 6px;
        cursor: pointer;
        transition: background 0.15s ease;
      }

      .mask-remove-btn {
        color: var(--mm-danger);
      }

      .mask-remove-btn:hover {
        background: color-mix(in srgb, var(--mm-danger) 14%, transparent);
      }

      .mask-text-btn {
        color: var(--mm-accent);
      }

      .mask-text-btn:hover {
        background: color-mix(in srgb, var(--mm-accent) 14%, transparent);
      }

      .mask-edit-btn {
        min-height: 32px;
        padding: 0 8px;
        font-size: 13px;
        font-weight: 500;
        font-family: inherit;
        color: var(--mm-accent);
        background: none;
        border: none;
        border-radius: 6px;
        cursor: pointer;
        transition: background 0.15s ease;
      }

      .mask-edit-btn:hover {
        background: color-mix(in srgb, var(--mm-accent) 14%, transparent);
      }

      .mask-row-actions {
        display: flex;
        align-items: center;
        gap: 4px;
      }

      .mask-edit-panel {
        margin: 12px 12px 0;
        padding: 12px;
        border: 1px solid var(--mm-line);
        border-radius: 10px;
        background: color-mix(in srgb, var(--mm-text) 4%, transparent);
      }

      .mask-edit-preview {
        position: relative;
        aspect-ratio: 16 / 9;
        border-radius: 8px;
        overflow: hidden;
        background: var(--mm-fill);
        touch-action: none;
      }

      .mask-edit-preview img {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
        object-fit: cover;
        display: block;
        pointer-events: none;
      }

      .mask-edit-preview svg {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
      }

      .mask-edit-poly {
        fill: rgba(10, 132, 255, 0.18);
        stroke: var(--mm-accent);
        stroke-width: 2px;
        vector-effect: non-scaling-stroke;
      }

      .mask-edit-handle {
        fill: #fff;
        stroke: var(--mm-accent);
        stroke-width: 2px;
        vector-effect: non-scaling-stroke;
        cursor: grab;
        touch-action: none;
      }

      .mask-edit-handle:active {
        cursor: grabbing;
      }

      .mask-edit-meta {
        margin-top: 8px;
        font-size: 12px;
        line-height: 16px;
        color: var(--mm-text-2);
      }

      .mask-edit-row {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        margin-top: 8px;
      }

      .mask-edit-size-btn {
        min-height: 32px;
        padding: 0 12px;
        font-size: 13px;
        font-weight: 500;
        font-family: inherit;
        color: var(--mm-text);
        background: var(--mm-fill);
        border: none;
        border-radius: 8px;
        cursor: pointer;
      }

      .mask-edit-size-btn:hover {
        background: var(--mm-fill-hover);
      }

      .mask-edit-label-row {
        display: flex;
        flex-direction: column;
        gap: 4px;
        margin-top: 12px;
      }

      .mask-edit-input {
        min-height: 36px;
        padding: 0 12px;
        font-size: 14px;
        font-family: inherit;
        color: var(--mm-text);
        background: var(--mm-fill);
        border: 1px solid var(--mm-line);
        border-radius: 8px;
        outline: none;
      }

      .mask-edit-input:focus {
        border-color: var(--mm-accent);
      }

      .mask-edit-actions {
        display: flex;
        justify-content: flex-end;
        gap: 8px;
        margin-top: 12px;
      }

      .mask-edit-cancel {
        min-height: 32px;
        padding: 0 14px;
        font-size: 13px;
        font-weight: 500;
        font-family: inherit;
        color: var(--mm-text-2);
        background: none;
        border: none;
        border-radius: 8px;
        cursor: pointer;
      }

      .mask-edit-cancel:hover {
        background: var(--mm-fill);
        color: var(--mm-text);
      }

      .mask-edit-save {
        min-height: 32px;
        padding: 0 16px;
        font-size: 13px;
        font-weight: 600;
        font-family: inherit;
        color: #fff;
        background: var(--mm-accent);
        border: none;
        border-radius: 8px;
        cursor: pointer;
      }

      .mask-edit-save:hover {
        filter: brightness(1.1);
      }

      .mask-edit-save:disabled {
        opacity: 0.5;
        cursor: default;
      }

      .mask-pending-section {
        margin-top: 16px;
        padding-top: 8px;
        border-top: 1px solid var(--mm-line);
      }

      .mask-section-heading {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 8px 12px 4px;
        font-size: 12px;
        font-weight: 500;
        color: var(--mm-text-2);
      }

      .mask-row.pending .mask-thumb {
        opacity: 0.5;
      }

      .mask-row.pending .minimap-poly {
        stroke-dasharray: 4 3;
      }

      .mask-empty-state {
        display: flex;
        flex-direction: column;
        align-items: center;
        text-align: center;
        padding: 48px 24px;
        gap: 8px;
      }

      .mask-empty-state h4 {
        margin: 0;
        font-size: 17px;
        font-weight: 600;
        color: var(--mm-text);
      }

      .mask-empty-state p {
        margin: 0;
        max-width: 320px;
        font-size: 13px;
        line-height: 20px;
        color: var(--mm-text-2);
      }

      @media (pointer: coarse) {
        .mask-seg-btn,
        .mask-chip,
        .mask-remove-btn,
        .mask-edit-btn,
        .mask-edit-save,
        .mask-edit-cancel,
        .mask-edit-size-btn,
        .mask-text-btn {
          min-height: 44px;
        }
        .mask-edit-input {
          min-height: 44px;
        }
      }

      @media (max-width: 420px) {
        .mask-thumb {
          flex-basis: 96px;
          width: 96px;
        }
      }

      @media (prefers-reduced-motion: reduce) {
        .mask-row,
        .mask-row-chevron,
        .mask-seg-btn,
        .mask-chip {
          transition: none;
        }
      }

      /* ─── Event Modal Timeline Action Button ─── */
      .frigate-events-modal-timeline-btn {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        background: rgba(59, 130, 246, 0.18);
        border: 1px solid rgba(59, 130, 246, 0.4);
        color: #93c5fd;
        border-radius: 6px;
        padding: 4px 10px;
        font-size: 12px;
        font-weight: 500;
        cursor: pointer;
        transition: all 0.15s ease;
        margin-top: 4px;
        font-family: inherit;
      }
      .frigate-events-modal-timeline-btn:hover {
        background: rgba(59, 130, 246, 0.3);
        color: #ffffff;
        border-color: #60a5fa;
        transform: translateY(-1px);
      }
      .frigate-events-modal-timeline-btn svg {
        width: 14px;
        height: 14px;
        fill: currentColor;
      }

      /* ─── Timeline ───
         Same quiet surface as the mask manager: inherits the Home Assistant theme, 4/8px spacing.
         The only saturated colors are data: event markers and the playhead. */
      .frigate-timeline-modal {
        --tl-text: var(--primary-text-color, #f2f2f7);
        --tl-text-2: var(--secondary-text-color, #9a9aa2);
        --tl-line: var(--divider-color, rgba(255, 255, 255, 0.12));
        --tl-accent: var(--primary-color, #0a84ff);
        --tl-warn: #ff9f0a;
        --tl-ok: #30d158;
        --tl-playhead: #ff453a;
        /* Solid fallback first: engines without color-mix (older iPadOS /
           WebViews) dropped the declaration, leaving the scrubber track and
           ghost buttons fully transparent. */
        --tl-fill: rgba(128, 128, 128, 0.13);
        --tl-fill: color-mix(in srgb, var(--tl-text) 7%, transparent);
        --tl-fill-hover: rgba(128, 128, 128, 0.2);
        --tl-fill-hover: color-mix(in srgb, var(--tl-text) 12%, transparent);
      }

      .frigate-timeline-modal .frigate-events-modal-content {
        width: min(860px, 95vw);
        min-width: 0;
        max-width: 860px;
        max-height: min(92vh, calc(100dvh - 32px));
        border: 1px solid var(--tl-line);
        border-radius: 16px;
        box-shadow: 0 24px 48px rgba(0, 0, 0, 0.5);
        background: var(--card-background-color, #1c1c1e);
        color: var(--tl-text);
        display: flex;
        flex-direction: column;
      }

      .frigate-timeline-modal .frigate-events-modal-close {
        top: 12px;
        right: 12px;
        width: 32px;
        height: 32px;
        background: var(--tl-fill);
        color: var(--tl-text-2);
      }

      .frigate-timeline-modal .frigate-events-modal-close:hover {
        background: var(--tl-fill-hover);
        color: var(--tl-text);
        transform: none;
      }

      .timeline-modal-header {
        display: flex;
        align-items: baseline;
        gap: 8px;
        flex-shrink: 0;
        padding: 20px 56px 12px 24px;
      }

      .timeline-modal-title {
        margin: 0;
        font-size: 20px;
        font-weight: 600;
        letter-spacing: -0.01em;
        color: var(--tl-text);
      }

      .timeline-camera-badge {
        font-size: 13px;
        color: var(--tl-text-2);
      }

      .timeline-modal-body {
        flex: 1;
        min-height: 0;
        overflow-y: auto;
        overscroll-behavior: contain;
        display: flex;
        flex-direction: column;
        gap: 16px;
        padding: 16px 24px 24px;
        box-sizing: border-box;
      }

      .timeline-camera-tabs {
        display: flex;
        gap: 4px;
        flex-shrink: 0;
        margin: -16px -24px 0;
        padding: 0 16px;
        overflow-x: auto;
        scrollbar-width: none;
        border-bottom: 1px solid var(--tl-line);
      }

      .timeline-camera-tabs::-webkit-scrollbar {
        display: none;
      }

      .timeline-camera-tab {
        position: relative;
        padding: 8px 8px 12px;
        font-size: 13px;
        font-weight: 500;
        font-family: inherit;
        color: var(--tl-text-2);
        background: none;
        border: none;
        white-space: nowrap;
        cursor: pointer;
        transition: color 0.15s ease;
      }

      .timeline-camera-tab:hover,
      .timeline-camera-tab.active {
        color: var(--tl-text);
      }

      .timeline-camera-tab.active::after {
        content: '';
        position: absolute;
        left: 8px;
        right: 8px;
        bottom: -1px;
        height: 2px;
        border-radius: 2px;
        background: var(--tl-accent);
      }

      .timeline-camera-tabs + .timeline-controls-bar {
        margin-top: 0;
      }

      .timeline-camera-tab:focus-visible,
      .timeline-quick-btn:focus-visible,
      .timeline-window-pill:focus-visible,
      .timeline-transport-btn:focus-visible,
      .timeline-stepper-btn:focus-visible,
      .timeline-speed-display:focus-visible,
      .timeline-datetime-input:focus-visible,
      .timeline-mute-btn:focus-visible {
        outline: 2px solid var(--tl-accent);
        outline-offset: 2px;
      }

      /* Time & window controls */
      .timeline-controls-bar {
        display: flex;
        flex-wrap: wrap;
        align-items: flex-end;
        justify-content: space-between;
        gap: 12px 24px;
      }

      .timeline-datetime-group {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
      }

      .timeline-datetime-label {
        font-size: 13px;
        color: var(--tl-text-2);
      }

      .timeline-datetime-input {
        background: var(--tl-fill);
        border: 1px solid transparent;
        color: var(--tl-text);
        color-scheme: dark light;
        height: 32px;
        padding: 0 10px;
        border-radius: 8px;
        font-size: 13px;
        font-family: inherit;
        box-sizing: border-box;
        transition: background 0.15s ease;
      }

      .timeline-datetime-input:hover {
        background: var(--tl-fill-hover);
      }

      .timeline-datetime-input:focus {
        outline: none;
        border-color: var(--tl-accent);
      }

      .timeline-quick-jumps,
      .timeline-window-pills {
        display: inline-flex;
        align-items: center;
        flex-wrap: wrap;
        gap: 2px;
        padding: 2px;
        border-radius: 10px;
        background: var(--tl-fill);
      }

      .timeline-quick-btn,
      .timeline-window-pill {
        height: 28px;
        padding: 0 10px;
        font-size: 13px;
        font-weight: 500;
        font-family: inherit;
        border-radius: 8px;
        background: none;
        color: var(--tl-text-2);
        border: none;
        cursor: pointer;
        white-space: nowrap;
        transition: background 0.15s ease, color 0.15s ease;
      }

      .timeline-quick-btn:hover,
      .timeline-window-pill:hover {
        background: var(--tl-fill-hover);
        color: var(--tl-text);
      }

      .timeline-window-pill.active {
        background: var(--tl-accent);
        color: #ffffff;
        font-weight: 600;
        box-shadow: 0 1px 3px rgba(0, 0, 0, 0.35);
      }

      /* Hover must not wash out the selected pill. */
      .timeline-window-pill.active:hover {
        background: var(--tl-accent);
        color: #ffffff;
      }

      .timeline-window-group {
        display: flex;
        align-items: center;
        gap: 8px;
      }

      /* Video player */
      .timeline-player-container {
        position: relative;
        width: 100%;
        aspect-ratio: 16 / 9;
        background: #000000;
        border-radius: 12px;
        overflow: hidden;
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
      }

      .timeline-video {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
        object-fit: contain;
        pointer-events: none;
        transition: opacity 0.12s ease;
      }

      .timeline-video.active {
        z-index: 2;
        opacity: 1;
      }

      .timeline-video.incoming {
        z-index: 3;
        opacity: 1;
      }

      .timeline-video.standby {
        z-index: 1;
        opacity: 0;
      }

      .timeline-player-loading {
        position: absolute;
        inset: 0;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 12px;
        background: rgba(0, 0, 0, 0.6);
        color: rgba(255, 255, 255, 0.72);
        font-size: 13px;
        z-index: 5;
        pointer-events: none;
        transition: opacity 0.15s ease;
      }

      .timeline-player-loading.subtle {
        background: transparent;
      }

      .timeline-spinner {
        width: 28px;
        height: 28px;
        border: 2px solid rgba(255, 255, 255, 0.15);
        border-top-color: #ffffff;
        border-radius: 50%;
        animation: timeline-spin 0.8s linear infinite;
      }

      @keyframes timeline-spin {
        to { transform: rotate(360deg); }
      }

      @media (prefers-reduced-motion: reduce) {
        .timeline-spinner { animation-duration: 2.4s; }
      }

      /* Scrubber */
      .timeline-scrubber-wrapper {
        display: flex;
        flex-direction: column;
        gap: 8px;
      }

      .timeline-track-container {
        position: relative;
        height: 40px;
        /* Plain grey, no colour functions: the track must always be visible,
           and this matches the desktop bar on both dark and light themes. */
        background: rgba(128, 128, 128, 0.16);
        border-radius: 10px;
        cursor: pointer;
        user-select: none;
        touch-action: none;
        overflow: hidden;
      }

      .timeline-events-layer {
        position: absolute;
        inset: 0;
        pointer-events: none;
      }

      .timeline-event-marker {
        position: absolute;
        top: 6px;
        bottom: 6px;
        min-width: 3px;
        background: var(--tl-accent);
        opacity: 0.85;
        border-radius: 3px;
        cursor: pointer;
        pointer-events: auto;
        transition: opacity 0.15s ease, top 0.15s ease, bottom 0.15s ease;
        z-index: 2;
      }

      .timeline-event-marker:hover {
        opacity: 1;
        top: 3px;
        bottom: 3px;
        z-index: 4;
      }

      .timeline-event-marker.person { background: var(--tl-accent); }
      .timeline-event-marker.car { background: var(--tl-warn); }
      .timeline-event-marker.dog, .timeline-event-marker.cat { background: var(--tl-ok); }

      .timeline-playhead {
        position: absolute;
        top: 0;
        bottom: 0;
        width: 2px;
        background: var(--tl-playhead);
        z-index: 5;
        pointer-events: none;
        transform: translateX(-50%);
      }

      .timeline-playhead::after {
        content: '';
        position: absolute;
        top: -1px;
        left: 50%;
        transform: translateX(-50%);
        width: 8px;
        height: 8px;
        background: var(--tl-playhead);
        border-radius: 50%;
      }

      .timeline-track-labels {
        display: flex;
        align-items: center;
        justify-content: space-between;
        font-size: 12px;
        color: var(--tl-text-2);
        font-variant-numeric: tabular-nums;
      }

      .timeline-time-badge {
        font-size: 13px;
        font-weight: 600;
        color: var(--tl-text);
        font-variant-numeric: tabular-nums;
      }

      /* Transport & speed */
      .timeline-transport-bar {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
      }

      .timeline-transport-controls {
        display: flex;
        align-items: center;
        gap: 4px;
      }

      .timeline-transport-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-width: 44px;
        height: 36px;
        background: none;
        border: none;
        color: var(--tl-text-2);
        padding: 0 10px;
        border-radius: 10px;
        font-size: 13px;
        font-weight: 500;
        font-family: inherit;
        font-variant-numeric: tabular-nums;
        cursor: pointer;
        transition: background 0.15s ease, color 0.15s ease;
      }

      .timeline-transport-btn:hover {
        background: var(--tl-fill-hover);
        color: var(--tl-text);
      }

      .timeline-transport-btn.play-btn {
        width: 44px;
        height: 44px;
        min-width: 0;
        padding: 0;
        margin: 0 4px;
        border-radius: 50%;
        background: var(--tl-accent);
        color: #ffffff;
      }

      .timeline-transport-btn.play-btn:hover {
        background: color-mix(in srgb, var(--tl-accent) 85%, #000);
        color: #ffffff;
      }

      .timeline-transport-btn svg {
        width: 18px;
        height: 18px;
        fill: currentColor;
        pointer-events: none;
      }

      .timeline-speed-controls {
        display: inline-flex;
        align-items: center;
        gap: 2px;
        background: var(--tl-fill);
        border-radius: 10px;
        padding: 2px;
      }

      .timeline-stepper-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 28px;
        height: 28px;
        background: none;
        color: var(--tl-text-2);
        border: none;
        border-radius: 8px;
        cursor: pointer;
        font-size: 16px;
        font-weight: 500;
        line-height: 1;
        transition: background 0.15s ease, color 0.15s ease;
        user-select: none;
      }

      .timeline-stepper-btn:hover:not(:disabled) {
        background: var(--tl-fill-hover);
        color: var(--tl-text);
      }

      .timeline-stepper-btn:disabled {
        opacity: 0.3;
        cursor: not-allowed;
      }

      .timeline-speed-display {
        font-size: 13px;
        font-weight: 600;
        min-width: 48px;
        text-align: center;
        color: var(--tl-text);
        font-variant-numeric: tabular-nums;
        padding: 4px;
        border-radius: 8px;
        cursor: pointer;
        user-select: none;
        transition: background 0.15s ease;
      }

      .timeline-speed-display:hover {
        background: var(--tl-fill-hover);
      }

      @media (max-width: 560px) {
        .timeline-modal-body { padding: 12px 16px 20px; gap: 12px; }
        .timeline-camera-tabs { margin: -12px -16px 0; }
        .timeline-transport-bar { justify-content: center; }
      }

      /* Timeline mute button base. The modal lives on document.body outside the
         card's shadow root, so it cannot rely on the card stylesheet: without
         this the button is position:static (and a grid row of its own inside
         the compact player). Scoped to the timeline modal so it cannot collide
         with the card/live-view mute styling. Size/placement overrides below
         (compact 44px, TV variables, landscape offsets) all beat this base. */
      .frigate-timeline-modal .timeline-mute-btn {
        position: absolute;
        top: 10px;
        right: 10px;
        z-index: 5;
        display: flex;
        align-items: center;
        justify-content: center;
        width: 34px;
        height: 34px;
        padding: 0;
        border: none;
        border-radius: 50%;
        background: rgba(0, 0, 0, 0.55);
        color: #ffffff;
        cursor: pointer;
        backdrop-filter: blur(4px);
        -webkit-backdrop-filter: blur(4px);
        transition: background 0.2s ease, opacity 0.2s ease;
      }

      .frigate-timeline-modal .timeline-mute-btn.top-left {
        left: 10px;
        right: auto;
      }

      .frigate-timeline-modal .timeline-mute-btn.top-right {
        right: 10px;
        left: auto;
      }

      .frigate-timeline-modal .timeline-mute-btn svg {
        width: 18px;
        height: 18px;
        fill: currentColor;
      }

      /* ─── Timeline compact (phone / tablet) + TV layouts ───
         Strictly scoped under .is-compact / .is-tv. Base (desktop) selectors above are untouched. */
      .frigate-timeline-modal.is-compact,
      .frigate-timeline-modal.is-tv {
        padding: 0 !important;
        align-items: stretch !important;
        justify-content: stretch !important;
        overflow: hidden !important;
        -webkit-overflow-scrolling: auto;
      }

      /* TV metrics are viewport-relative: TVBro reports ~960x540 logical for a
         1920x1080 panel, so fixed px chrome would render at double size. */
      .frigate-timeline-modal.is-tv {
        --tl-tv-icon: clamp(26px, 3.6vh, 40px);
        --tl-tv-topbar-h: clamp(44px, 6vh, 64px);
        --tl-tv-topbar-pad: clamp(6px, 1.2vh, 14px);
        --tl-tv-btn: clamp(32px, 4.6vh, 48px);
        --tl-tv-track: clamp(34px, 5.5vh, 56px);
        --tl-tv-marker: calc(var(--tl-tv-track) * 0.14);
        --tl-tv-labels: clamp(12px, 1.6vh, 15px);
        --tl-tv-badge: clamp(15px, 2.2vh, 20px);
        --tl-tv-btn-h: clamp(36px, 4.6vh, 48px);
        --tl-tv-play: clamp(46px, 6vh, 60px);
        --tl-tv-stepper: clamp(30px, 3.6vh, 40px);
        --tl-tv-bar-pad: clamp(4px, 1vh, 12px);
        --tl-tv-scrim-top: clamp(10px, 2.4vh, 24px);
      }

      .frigate-timeline-modal.is-compact .frigate-events-modal-content,
      .frigate-timeline-modal.is-tv .frigate-events-modal-content {
        position: absolute !important;
        inset: 0 !important;
        width: auto !important;
        height: auto !important;
        min-width: 0 !important;
        max-width: none !important;
        max-height: none !important;
        margin: 0 !important;
        border: none !important;
        border-radius: 0 !important;
        box-shadow: none !important;
        overflow: hidden !important;
        display: flex !important;
        flex-direction: column !important;
        background: var(--card-background-color, #1c1c1e);
      }

      /* Slim top row: scrollable camera tabs left, gear + close right. */
      .frigate-timeline-modal.is-compact .timeline-compact-topbar,
      .frigate-timeline-modal.is-tv .timeline-compact-topbar {
        display: flex !important;
        align-items: center;
        gap: 8px;
        flex-shrink: 0;
        padding-top: max(8px, env(safe-area-inset-top, 0px));
        padding-right: max(8px, env(safe-area-inset-right, 0px));
        padding-bottom: 8px;
        padding-left: max(12px, env(safe-area-inset-left, 0px));
        border-bottom: 1px solid var(--tl-line);
        background: var(--card-background-color, #1c1c1e);
        min-height: 48px;
        box-sizing: border-box;
      }

      /* Single camera: show the camera name on the left instead of an empty spacer. */
      .frigate-timeline-modal.is-compact .timeline-compact-camera-name,
      .frigate-timeline-modal.is-tv .timeline-compact-camera-name {
        flex: 1 1 auto;
        min-width: 0;
        display: flex;
        align-items: center;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .frigate-timeline-modal.is-compact .timeline-compact-camera-name .timeline-camera-badge,
      .frigate-timeline-modal.is-tv .timeline-compact-camera-name .timeline-camera-badge {
        font-size: 14px;
        font-weight: 600;
        color: var(--tl-text);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .frigate-timeline-modal.is-compact .timeline-compact-topbar .timeline-camera-tabs,
      .frigate-timeline-modal.is-tv .timeline-compact-topbar .timeline-camera-tabs {
        display: flex;
        flex: 1 1 auto;
        min-width: 0;
        gap: 2px;
        margin: 0;
        padding: 0;
        border-bottom: none;
        overflow-x: auto;
        overflow-y: hidden;
        scrollbar-width: none;
        -webkit-overflow-scrolling: touch;
      }

      .frigate-timeline-modal.is-compact .timeline-compact-topbar .timeline-camera-tabs::-webkit-scrollbar,
      .frigate-timeline-modal.is-tv .timeline-compact-topbar .timeline-camera-tabs::-webkit-scrollbar {
        display: none;
      }

      .frigate-timeline-modal.is-compact .timeline-compact-topbar .timeline-camera-tab,
      .frigate-timeline-modal.is-tv .timeline-compact-topbar .timeline-camera-tab {
        min-height: 40px;
        padding: 8px 10px;
        font-size: 14px;
        flex-shrink: 0;
      }

      .frigate-timeline-modal.is-compact .timeline-compact-actions,
      .frigate-timeline-modal.is-tv .timeline-compact-actions {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-shrink: 0;
      }

      .frigate-timeline-modal.is-compact .timeline-settings-btn,
      .frigate-timeline-modal.is-tv .timeline-settings-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 40px;
        height: 40px;
        border-radius: 12px;
        border: 1px solid transparent;
        background: var(--tl-fill);
        color: var(--tl-text);
        cursor: pointer;
        padding: 0;
        flex-shrink: 0;
      }

      .frigate-timeline-modal.is-compact .timeline-settings-btn svg,
      .frigate-timeline-modal.is-tv .timeline-settings-btn svg {
        width: 20px;
        height: 20px;
        fill: currentColor;
        pointer-events: none;
      }

      .frigate-timeline-modal.is-compact .timeline-compact-topbar .frigate-events-modal-close,
      .frigate-timeline-modal.is-tv .timeline-compact-topbar .frigate-events-modal-close {
        position: static;
        top: auto;
        right: auto;
        width: 40px;
        height: 40px;
        flex-shrink: 0;
        background: var(--tl-fill);
        color: var(--tl-text);
      }

      /* Keep title + badge in the DOM for JS compat, but visually hidden in compact/TV. */
      .frigate-timeline-modal.is-compact .timeline-modal-header.timeline-compact-proxy,
      .frigate-timeline-modal.is-tv .timeline-modal-header.timeline-compact-proxy {
        position: absolute;
        width: 1px;
        height: 1px;
        margin: 0;
        padding: 0;
        overflow: hidden;
        clip: rect(0 0 0 0);
        -webkit-clip-path: inset(50%);
        clip-path: inset(50%);
        white-space: nowrap;
        border: 0;
      }

      /* Body is a fixed-height flex column with no page scroll. */
      .frigate-timeline-modal.is-compact .timeline-modal-body,
      .frigate-timeline-modal.is-tv .timeline-modal-body {
        flex: 1 1 auto;
        min-height: 0;
        overflow: hidden;
        overscroll-behavior: contain;
        display: flex;
        flex-direction: column;
        gap: 0;
        padding: 0;
      }

      /* Video is the dominant element: grows into all leftover height, never cropped. */
      .frigate-timeline-modal.is-compact .timeline-player-container,
      .frigate-timeline-modal.is-tv .timeline-player-container {
        flex: 1 1 auto;
        min-height: 0;
        width: 100%;
        aspect-ratio: auto;
        border-radius: 0;
        background: #000000;
      }

      .frigate-timeline-modal.is-compact .timeline-video,
      .frigate-timeline-modal.is-tv .timeline-video {
        object-fit: contain;
      }

      .frigate-timeline-modal.is-compact .timeline-mute-btn,
      .frigate-timeline-modal.is-tv .timeline-mute-btn {
        opacity: 1;
        width: 44px;
        height: 44px;
      }

      .frigate-timeline-modal.is-compact .timeline-mute-btn svg,
      .frigate-timeline-modal.is-tv .timeline-mute-btn svg {
        width: 20px;
        height: 20px;
      }

      /* Scrubber sits directly under the video, visually attached to it. */
      .frigate-timeline-modal.is-compact .timeline-scrubber-wrapper,
      .frigate-timeline-modal.is-tv .timeline-scrubber-wrapper {
        flex-shrink: 0;
        gap: 6px;
        padding: 10px 12px 6px;
        background: var(--card-background-color, #1c1c1e);
        border-top: 1px solid var(--tl-line);
      }

      .frigate-timeline-modal.is-compact .timeline-track-container,
      .frigate-timeline-modal.is-tv .timeline-track-container {
        height: 52px;
        border-radius: 12px;
        touch-action: none;
        -webkit-touch-callout: none;
      }

      .frigate-timeline-modal.is-compact .timeline-event-marker,
      .frigate-timeline-modal.is-tv .timeline-event-marker {
        top: 8px;
        bottom: 8px;
        min-width: 4px;
        border-radius: 4px;
      }

      .frigate-timeline-modal.is-compact .timeline-playhead,
      .frigate-timeline-modal.is-tv .timeline-playhead {
        width: 3px;
      }

      .frigate-timeline-modal.is-compact .timeline-playhead::after,
      .frigate-timeline-modal.is-tv .timeline-playhead::after {
        width: 12px;
        height: 12px;
        top: -2px;
      }

      .frigate-timeline-modal.is-compact .timeline-track-labels,
      .frigate-timeline-modal.is-tv .timeline-track-labels {
        font-size: 13px;
      }

      .frigate-timeline-modal.is-compact .timeline-time-badge,
      .frigate-timeline-modal.is-tv .timeline-time-badge {
        font-size: 16px;
        font-variant-numeric: tabular-nums;
      }

      /* Transport row: large targets, play button dominant. */
      .frigate-timeline-modal.is-compact .timeline-transport-bar,
      .frigate-timeline-modal.is-tv .timeline-transport-bar {
        flex-shrink: 0;
        flex-wrap: wrap;
        align-items: center;
        justify-content: center;
        gap: 8px;
        padding: 8px 12px max(12px, env(safe-area-inset-bottom, 12px));
      }

      .frigate-timeline-modal.is-compact .timeline-transport-controls,
      .frigate-timeline-modal.is-tv .timeline-transport-controls {
        gap: 6px;
        flex-wrap: wrap;
        justify-content: center;
      }

      .frigate-timeline-modal.is-compact .timeline-transport-btn,
      .frigate-timeline-modal.is-tv .timeline-transport-btn {
        min-width: 42px;
        height: 46px;
        padding: 0 8px;
        font-size: 14px;
        border-radius: 12px;
      }

      .frigate-timeline-modal.is-compact .timeline-transport-btn.play-btn,
      .frigate-timeline-modal.is-tv .timeline-transport-btn.play-btn {
        width: 54px;
        height: 54px;
        margin: 0 6px;
      }

      .frigate-timeline-modal.is-compact .timeline-transport-btn[data-skip="-300"],
      .frigate-timeline-modal.is-compact .timeline-transport-btn[data-skip="300"],
      .frigate-timeline-modal.is-tv .timeline-transport-btn[data-skip="-300"],
      .frigate-timeline-modal.is-tv .timeline-transport-btn[data-skip="300"] {
        display: none;
      }

      .frigate-timeline-modal.is-compact .timeline-speed-controls,
      .frigate-timeline-modal.is-tv .timeline-speed-controls {
        padding: 4px;
      }

      .frigate-timeline-modal.is-compact .timeline-stepper-btn,
      .frigate-timeline-modal.is-tv .timeline-stepper-btn {
        width: 40px;
        height: 34px;
        font-size: 18px;
      }

      .frigate-timeline-modal.is-compact .timeline-speed-display,
      .frigate-timeline-modal.is-tv .timeline-speed-display {
        min-width: 56px;
        min-height: 40px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        font-size: 14px;
      }

      /* Compact: transport lives in the settings sheet (Playback section), laid
         out as a comfortable touch row that wraps to two rows if needed. */
      .frigate-timeline-modal.is-compact .timeline-settings-sheet {
        display: flex;
        flex-direction: column;
        gap: 16px;
      }

      .frigate-timeline-modal.is-compact .timeline-sheet-section {
        display: flex;
        flex-direction: column;
        gap: 10px;
        min-width: 0;
      }

      .frigate-timeline-modal.is-compact .timeline-sheet-heading {
        font-size: 12px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        color: var(--tl-text-2);
      }

      .frigate-timeline-modal.is-compact .timeline-settings-sheet .timeline-transport-bar {
        align-items: center;
        justify-content: center;
        gap: 12px;
        padding: 0;
        overflow: visible;
      }

      .frigate-timeline-modal.is-compact .timeline-settings-sheet .timeline-transport-controls {
        flex-wrap: wrap;
        justify-content: center;
        gap: 6px;
        flex-shrink: 0;
      }

      .frigate-timeline-modal.is-compact .timeline-settings-sheet .timeline-transport-btn {
        min-width: 48px;
        height: 48px;
        padding: 0 12px;
      }

      .frigate-timeline-modal.is-compact .timeline-settings-sheet .timeline-transport-btn.play-btn {
        width: 56px;
        height: 56px;
        margin: 0 6px;
      }

      .frigate-timeline-modal.is-compact .timeline-settings-sheet .timeline-speed-controls {
        align-self: center;
        justify-content: center;
        max-width: 110px;
        flex-shrink: 0;
        gap: 2px;
        padding: 2px;
      }

      .frigate-timeline-modal.is-compact .timeline-settings-sheet .timeline-stepper-btn {
        width: 30px;
        height: 34px;
      }

      .frigate-timeline-modal.is-compact .timeline-settings-sheet .timeline-speed-display {
        min-width: 32px;
        min-height: 34px;
        font-size: 13px;
      }

      /* Compact popup card (phone portrait default; tablets too): a floating card
         sized to its content — header + footage at the camera's real aspect +
         scrubber deck — speaking the desktop timeline language (card surface,
         1px hairline border, desktop shadow, solid header and deck). The video
         fills the card width edge-to-edge and is never cropped, so there is no
         top/bottom letterbox. Transport lives only in the settings sheet
         Playback section; tapping the video toggles play/pause. */
      .frigate-timeline-modal.is-compact {
        padding: max(10px, env(safe-area-inset-top, 0px)) max(10px, env(safe-area-inset-right, 0px)) max(10px, env(safe-area-inset-bottom, 0px)) max(10px, env(safe-area-inset-left, 0px)) !important;
        align-items: center !important;
        justify-content: center !important;
      }

      .frigate-timeline-modal.is-compact .frigate-events-modal-content {
        position: relative !important;
        inset: auto !important;
        width: 100% !important;
        height: auto !important;
        min-width: 0 !important;
        max-width: 100% !important;
        max-height: 100% !important;
        margin: auto !important;
        border: 1px solid var(--tl-line) !important;
        border-radius: 20px !important;
        box-shadow: 0 24px 48px rgba(0, 0, 0, 0.5) !important;
        overflow: hidden !important;
        display: flex !important;
        flex-direction: column !important;
        background: var(--card-background-color, #1c1c1e);
        /* No entry-transform fill: the viewport-anchored sheet/backdrop below
           must not be contained by this card. */
        animation: none !important;
      }

      /* Solid header row on the card surface with a bottom hairline. */
      .frigate-timeline-modal.is-compact .timeline-compact-topbar {
        position: static !important;
        height: auto !important;
        min-height: 56px !important;
        padding: 6px 8px 6px 12px !important;
        border-bottom: 1px solid var(--tl-line) !important;
        background: var(--card-background-color, #1c1c1e) !important;
        z-index: auto !important;
      }

      .frigate-timeline-modal.is-compact .timeline-compact-topbar .timeline-camera-tab {
        min-height: 44px !important;
        padding: 8px 10px 12px !important;
        font-size: 13px !important;
        color: var(--tl-text-2) !important;
      }

      /* Scrollable tabs read as scrollable: a subtle right-edge fade. It is
         invisible when tabs fit (empty trailing space shows nothing) and moot
         for a single camera (no tabs strip is rendered there). */
      .frigate-timeline-modal.is-compact .timeline-compact-topbar .timeline-camera-tabs {
        -webkit-mask-image: linear-gradient(to right, #000000 calc(100% - 24px), transparent 100%) !important;
        mask-image: linear-gradient(to right, #000000 calc(100% - 24px), transparent 100%) !important;
      }

      .frigate-timeline-modal.is-compact .timeline-compact-topbar .timeline-camera-tab.active {
        color: var(--tl-text) !important;
      }

      .frigate-timeline-modal.is-compact .timeline-compact-camera-name .timeline-camera-badge {
        color: var(--tl-text) !important;
      }

      .frigate-timeline-modal.is-compact .timeline-settings-btn,
      .frigate-timeline-modal.is-compact .timeline-compact-topbar .frigate-events-modal-close {
        width: 44px !important;
        height: 44px !important;
      }

      /* In-flow body: the player sizes itself from the footage's intrinsic
         ratio, so the card height follows the video with no letterbox bars.
         If the footage is unusually tall, the video-level dvh cap clamps it
         and contain letterboxes instead of cropping. */
      .frigate-timeline-modal.is-compact .timeline-modal-body {
        position: static !important;
        inset: auto !important;
        flex: 1 1 auto !important;
        min-height: 0 !important;
        gap: 0 !important;
        padding: 0 !important;
        overflow: hidden !important;
      }

      .frigate-timeline-modal.is-compact .timeline-player-container {
        position: relative !important;
        inset: auto !important;
        flex: 0 0 auto !important;
        min-height: 0 !important;
        width: 100% !important;
        display: grid !important;
        grid-template-columns: 1fr !important;
        overflow: hidden !important;
        border-radius: 0 !important;
        /* Card surface, not black: the popup reads like the desktop card even
           if the footage does not fill its box edge to edge. */
        background: var(--card-background-color, #1c1c1e) !important;
      }

      .frigate-timeline-modal.is-compact .timeline-video {
        grid-area: 1 / 1 !important;
        position: static !important;
        inset: auto !important;
        width: 100% !important;
        height: auto !important;
        max-height: calc(100dvh - 190px - env(safe-area-inset-top, 0px) - env(safe-area-inset-bottom, 0px)) !important;
        object-fit: contain !important;
      }

      .frigate-timeline-modal.is-compact .timeline-mute-btn {
        /* Out of flow unconditionally: as a grid item it adds a black row. */
        position: absolute !important;
        width: 44px !important;
        height: 44px !important;
        opacity: 1 !important;
      }

      .frigate-timeline-modal.is-compact .timeline-mute-btn:not(.top-left) {
        top: 10px !important;
        right: 10px !important;
      }

      .frigate-timeline-modal.is-compact .timeline-mute-btn.top-left {
        top: 10px !important;
        left: 10px !important;
      }

      /* Bottom control deck on the card surface with a top hairline. */
      .frigate-timeline-modal.is-compact .timeline-scrubber-wrapper {
        position: static !important;
        z-index: auto !important;
        margin-top: 0 !important;
        flex-shrink: 0 !important;
        padding: 10px 12px max(10px, env(safe-area-inset-bottom, 10px)) !important;
        gap: 6px !important;
        background: var(--card-background-color, #1c1c1e) !important;
        border-top: 1px solid var(--tl-line) !important;
      }

      .frigate-timeline-modal.is-compact .timeline-track-container {
        height: 44px !important;
        border-radius: 10px !important;
        /* Same track colour as desktop; pinned so nothing can wash it out. */
        background: rgba(128, 128, 128, 0.16) !important;
      }

      .frigate-timeline-modal.is-compact .timeline-event-marker {
        top: 6px !important;
        bottom: 6px !important;
        min-width: 3px !important;
        border-radius: 3px !important;
      }

      .frigate-timeline-modal.is-compact .timeline-playhead {
        width: 2px !important;
      }

      .frigate-timeline-modal.is-compact .timeline-playhead::after {
        width: 8px !important;
        height: 8px !important;
        top: -1px !important;
      }

      .frigate-timeline-modal.is-compact .timeline-track-labels {
        font-size: 12px !important;
        line-height: 1.2 !important;
        color: var(--tl-text-2) !important;
      }

      .frigate-timeline-modal.is-compact .timeline-time-badge {
        font-size: 13px !important;
        font-weight: 600 !important;
        color: var(--tl-text) !important;
      }

      /* Compact: no on-stage transport — skips, play/pause and speed live in
         the settings sheet Playback section. The body markup stays in place
         for TV (same transport, hidden here by CSS only); tapping the video
         toggles play/pause on compact. */
      .frigate-timeline-modal.is-compact .timeline-modal-body > .timeline-transport-bar {
        display: none !important;
      }

      /* Time controls live in a bottom sheet behind the gear button. */
      .frigate-timeline-modal.is-compact .timeline-settings-backdrop,
      .frigate-timeline-modal.is-tv .timeline-settings-backdrop {
        position: absolute;
        inset: 0;
        background: rgba(0, 0, 0, 0.5);
        opacity: 0;
        visibility: hidden;
        pointer-events: none;
        transition: opacity 0.2s ease, visibility 0s linear 0.25s;
        z-index: 15;
      }

      .frigate-timeline-modal.is-compact.settings-open .timeline-settings-backdrop,
      .frigate-timeline-modal.is-tv.settings-open .timeline-settings-backdrop {
        opacity: 1;
        visibility: visible;
        pointer-events: auto;
        transition: opacity 0.2s ease;
      }

      .frigate-timeline-modal.is-compact .timeline-settings-sheet,
      .frigate-timeline-modal.is-tv .timeline-settings-sheet {
        position: absolute;
        left: 0;
        right: 0;
        bottom: 0;
        z-index: 20;
        background: var(--card-background-color, #1c1c1e);
        border-top: 1px solid var(--tl-line);
        border-radius: 16px 16px 0 0;
        box-shadow: 0 -12px 32px rgba(0, 0, 0, 0.5);
        padding: 8px 16px max(16px, env(safe-area-inset-bottom, 16px));
        box-sizing: border-box;
        max-height: 70vh;
        max-height: 70dvh;
        overflow-y: auto;
        -webkit-overflow-scrolling: touch;
        transform: translateY(105%);
        visibility: hidden;
        transition: transform 0.22s ease, visibility 0s linear 0.25s;
      }

      .frigate-timeline-modal.is-compact.settings-open .timeline-settings-sheet,
      .frigate-timeline-modal.is-tv.settings-open .timeline-settings-sheet {
        transform: translateY(0);
        visibility: visible;
        transition: transform 0.22s ease;
      }

      /* Portrait compact: the card is content-sized and short, so the sheet
         and its backdrop anchor to the viewport instead of the card. */
      .frigate-timeline-modal.is-compact .timeline-settings-backdrop {
        position: fixed !important;
        inset: 0 !important;
      }

      .frigate-timeline-modal.is-compact .timeline-settings-sheet {
        position: fixed !important;
        left: 0 !important;
        right: 0 !important;
        bottom: 0 !important;
      }

      .frigate-timeline-modal.is-compact .timeline-settings-handle,
      .frigate-timeline-modal.is-tv .timeline-settings-handle {
        width: 40px;
        height: 4px;
        border-radius: 4px;
        background: var(--tl-line);
        margin: 4px auto 12px;
      }

      .frigate-timeline-modal.is-compact .timeline-settings-sheet .timeline-controls-bar,
      .frigate-timeline-modal.is-tv .timeline-settings-sheet .timeline-controls-bar {
        flex-direction: column;
        align-items: stretch;
        gap: 16px;
      }

      .frigate-timeline-modal.is-compact .timeline-settings-sheet .timeline-datetime-group,
      .frigate-timeline-modal.is-tv .timeline-settings-sheet .timeline-datetime-group {
        flex-direction: column;
        align-items: stretch;
        gap: 10px;
      }

      .frigate-timeline-modal.is-compact .timeline-settings-sheet .timeline-datetime-input,
      .frigate-timeline-modal.is-tv .timeline-settings-sheet .timeline-datetime-input {
        width: 100%;
        height: 44px;
        font-size: 16px;
      }

      .frigate-timeline-modal.is-compact .timeline-settings-sheet .timeline-quick-jumps,
      .frigate-timeline-modal.is-compact .timeline-settings-sheet .timeline-window-pills,
      .frigate-timeline-modal.is-tv .timeline-settings-sheet .timeline-quick-jumps,
      .frigate-timeline-modal.is-tv .timeline-settings-sheet .timeline-window-pills {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
      }

      .frigate-timeline-modal.is-compact .timeline-settings-sheet .timeline-quick-btn,
      .frigate-timeline-modal.is-compact .timeline-settings-sheet .timeline-window-pill,
      .frigate-timeline-modal.is-tv .timeline-settings-sheet .timeline-quick-btn,
      .frigate-timeline-modal.is-tv .timeline-settings-sheet .timeline-window-pill {
        height: 44px;
        padding: 0 14px;
        font-size: 14px;
        flex: 1 1 auto;
      }

      .frigate-timeline-modal.is-compact .timeline-settings-sheet .timeline-window-group,
      .frigate-timeline-modal.is-tv .timeline-settings-sheet .timeline-window-group {
        flex-direction: column;
        align-items: stretch;
        gap: 10px;
      }

      /* Landscape phones: keep the popup card framing (inset + radius + border
         + shadow) but float the chrome over scrims so footage keeps its
         height. Transport lives in the settings sheet (hidden on stage for all
         compact layouts). iPad landscape and TV are untouched. */
      @media (orientation: landscape) and (max-height: 500px) {
        .frigate-timeline-modal.is-compact .frigate-events-modal-content {
          position: absolute !important;
          inset: max(8px, env(safe-area-inset-top, 0px)) max(8px, env(safe-area-inset-right, 0px)) max(8px, env(safe-area-inset-bottom, 0px)) max(8px, env(safe-area-inset-left, 0px)) !important;
          width: auto !important;
          height: auto !important;
          min-width: 0 !important;
          max-width: none !important;
          max-height: none !important;
          margin: 0 !important;
          border-radius: 16px !important;
          animation: frigate-modal-slide-up 0.2s forwards !important;
        }
        .frigate-timeline-modal.is-compact .timeline-settings-backdrop {
          position: absolute !important;
        }
        .frigate-timeline-modal.is-compact .timeline-settings-sheet {
          position: absolute !important;
          left: 0 !important;
          right: 0 !important;
          bottom: 0 !important;
        }
        .frigate-timeline-modal.is-compact .timeline-modal-body {
          position: absolute !important;
          inset: 0 !important;
          flex: none !important;
        }
        .frigate-timeline-modal.is-compact .timeline-player-container {
          position: absolute !important;
          inset: 0 !important;
          flex: none !important;
          background: #000000 !important;
        }
        .frigate-timeline-modal.is-compact .timeline-video {
          grid-area: auto !important;
          position: absolute !important;
          inset: 0 !important;
          width: 100% !important;
          height: 100% !important;
          max-height: none !important;
        }
        .frigate-timeline-modal.is-compact .timeline-compact-topbar {
          position: absolute !important;
          top: 0 !important;
          left: 0 !important;
          right: 0 !important;
          z-index: 8 !important;
          min-height: 0 !important;
          height: calc(44px + env(safe-area-inset-top, 0px)) !important;
          padding-top: env(safe-area-inset-top, 0px) !important;
          padding-bottom: 0 !important;
          border-bottom: none !important;
          background: linear-gradient(to bottom, rgba(0, 0, 0, 0.75), rgba(0, 0, 0, 0)) !important;
        }
        .frigate-timeline-modal.is-compact .timeline-compact-topbar .timeline-camera-tab {
          min-height: 36px !important;
          padding: 6px 10px !important;
          color: rgba(255, 255, 255, 0.85) !important;
        }
        .frigate-timeline-modal.is-compact .timeline-compact-topbar .timeline-camera-tab.active {
          color: #ffffff !important;
        }
        .frigate-timeline-modal.is-compact .timeline-compact-topbar .timeline-camera-tabs {
          -webkit-mask-image: none !important;
          mask-image: none !important;
        }
        .frigate-timeline-modal.is-compact .timeline-compact-camera-name .timeline-camera-badge {
          color: #ffffff !important;
        }
        .frigate-timeline-modal.is-compact .timeline-mute-btn {
          width: 40px !important;
          height: 40px !important;
        }
        .frigate-timeline-modal.is-compact .timeline-mute-btn:not(.top-left) {
          top: calc(52px + env(safe-area-inset-top, 0px)) !important;
          right: 10px !important;
        }
        .frigate-timeline-modal.is-compact .timeline-mute-btn.top-left {
          top: calc(52px + env(safe-area-inset-top, 0px)) !important;
          left: 10px !important;
          right: auto !important;
        }
        .frigate-timeline-modal.is-compact .timeline-scrubber-wrapper {
          position: absolute !important;
          left: 0 !important;
          right: 0 !important;
          bottom: 0 !important;
          z-index: 7 !important;
          padding: 8px 12px 4px !important;
          padding-left: max(12px, env(safe-area-inset-left, 0px)) !important;
          padding-right: max(12px, env(safe-area-inset-right, 0px)) !important;
          padding-bottom: max(10px, env(safe-area-inset-bottom, 10px)) !important;
          gap: 2px !important;
          background: linear-gradient(to top, rgba(0, 0, 0, 0.75), rgba(0, 0, 0, 0)) !important;
          border-top: none !important;
        }
        .frigate-timeline-modal.is-compact .timeline-track-container {
          height: 40px !important;
        }
        .frigate-timeline-modal.is-compact .timeline-event-marker {
          top: 5px !important;
          bottom: 5px !important;
        }
        .frigate-timeline-modal.is-compact .timeline-track-labels {
          color: rgba(255, 255, 255, 0.85) !important;
        }
        .frigate-timeline-modal.is-compact .timeline-time-badge {
          font-size: 14px !important;
          color: #ffffff !important;
        }
      }

      /* TV: scrubber always overlays the video bottom edge; transport stays beneath.
         Pull-back is derived from the viewport-relative heights above. */
      .frigate-timeline-modal.is-tv .timeline-scrubber-wrapper {
        margin-top: calc(-1 * (var(--tl-tv-scrim-top) + var(--tl-tv-track) + 6px + var(--tl-tv-badge) + 6px + var(--tl-tv-bar-pad)));
        padding: var(--tl-tv-scrim-top) 16px var(--tl-tv-bar-pad);
        background: linear-gradient(to top, rgba(0, 0, 0, 0.9) 62%, rgba(0, 0, 0, 0));
        border-top: none;
        z-index: 6;
      }

      .frigate-timeline-modal.is-tv .timeline-track-container {
        height: var(--tl-tv-track);
      }

      .frigate-timeline-modal.is-tv .timeline-event-marker {
        top: var(--tl-tv-marker);
        bottom: var(--tl-tv-marker);
      }

      .frigate-timeline-modal.is-tv .timeline-track-labels {
        font-size: var(--tl-tv-labels);
        color: rgba(255, 255, 255, 0.9);
      }

      .frigate-timeline-modal.is-tv .timeline-time-badge {
        font-size: var(--tl-tv-badge);
        color: #ffffff;
      }

      /* TV: no hover reliance — always-visible focus rings, generous spacing. */
      .frigate-timeline-modal.is-tv .timeline-compact-topbar {
        min-height: var(--tl-tv-topbar-h);
        padding-top: max(var(--tl-tv-topbar-pad), env(safe-area-inset-top, 0px));
        padding-bottom: var(--tl-tv-topbar-pad);
        gap: var(--tl-tv-topbar-pad);
      }

      /* Single-camera name must not add height; the bar sizes to its content. */
      .frigate-timeline-modal.is-tv .timeline-compact-topbar > :not(.timeline-camera-tabs):not(.timeline-compact-actions) {
        min-height: 0;
        height: auto;
        align-self: center;
      }

      .frigate-timeline-modal.is-tv .timeline-mute-btn {
        opacity: 1;
        width: var(--tl-tv-btn);
        height: var(--tl-tv-btn);
      }

      .frigate-timeline-modal.is-tv .timeline-mute-btn svg {
        width: var(--tl-tv-icon);
        height: var(--tl-tv-icon);
      }

      .frigate-timeline-modal.is-tv .timeline-settings-btn,
      .frigate-timeline-modal.is-tv .timeline-compact-topbar .frigate-events-modal-close {
        width: var(--tl-tv-btn);
        height: var(--tl-tv-btn);
      }

      .frigate-timeline-modal.is-tv .timeline-settings-btn svg,
      .frigate-timeline-modal.is-tv .timeline-compact-topbar .frigate-events-modal-close svg {
        width: var(--tl-tv-icon);
        height: var(--tl-tv-icon);
      }

      .frigate-timeline-modal.is-tv .timeline-compact-topbar .timeline-camera-tab {
        min-height: var(--tl-tv-btn);
        min-width: var(--tl-tv-btn);
        font-size: var(--tl-tv-labels);
        padding: 8px 10px;
      }

      .frigate-timeline-modal.is-tv .timeline-transport-bar {
        flex-wrap: nowrap;
        gap: var(--tl-tv-bar-pad);
        padding: var(--tl-tv-bar-pad) 16px max(var(--tl-tv-bar-pad), env(safe-area-inset-bottom, 16px));
      }

      .frigate-timeline-modal.is-tv .timeline-transport-controls {
        flex-wrap: nowrap;
        gap: calc(var(--tl-tv-bar-pad) * 0.75);
      }

      .frigate-timeline-modal.is-tv .timeline-transport-btn {
        min-width: var(--tl-tv-btn);
        height: var(--tl-tv-btn-h);
        padding: 0 10px;
      }

      .frigate-timeline-modal.is-tv .timeline-transport-btn.play-btn {
        width: var(--tl-tv-play);
        height: var(--tl-tv-play);
        margin: 0 4px;
      }

      .frigate-timeline-modal.is-tv .timeline-transport-btn svg {
        width: var(--tl-tv-icon);
        height: var(--tl-tv-icon);
      }

      .frigate-timeline-modal.is-tv .timeline-stepper-btn {
        width: var(--tl-tv-stepper);
        height: var(--tl-tv-stepper);
      }

      .frigate-timeline-modal.is-tv .timeline-camera-tab:focus-visible,
      .frigate-timeline-modal.is-tv .timeline-quick-btn:focus-visible,
      .frigate-timeline-modal.is-tv .timeline-window-pill:focus-visible,
      .frigate-timeline-modal.is-tv .timeline-transport-btn:focus,
      .frigate-timeline-modal.is-tv .timeline-transport-btn:focus-visible,
      .frigate-timeline-modal.is-tv .timeline-stepper-btn:focus-visible,
      .frigate-timeline-modal.is-tv .timeline-speed-display:focus-visible,
      .frigate-timeline-modal.is-tv .timeline-datetime-input:focus-visible,
      .frigate-timeline-modal.is-tv .timeline-mute-btn:focus-visible,
      .frigate-timeline-modal.is-tv .timeline-settings-btn:focus-visible,
      .frigate-timeline-modal.is-tv .timeline-compact-topbar .frigate-events-modal-close:focus-visible,
      .frigate-timeline-modal.is-tv .timeline-track-container:focus-visible {
        outline: 3px solid #ffffff !important;
        outline-offset: 3px;
        box-shadow: 0 0 0 5px rgba(10, 132, 255, 0.65);
      }

      @media (prefers-reduced-motion: reduce) {
        .frigate-timeline-modal.is-compact .timeline-settings-sheet,
        .frigate-timeline-modal.is-tv .timeline-settings-sheet,
        .frigate-timeline-modal.is-compact .timeline-settings-backdrop,
        .frigate-timeline-modal.is-tv .timeline-settings-backdrop {
          transition: none;
        }
      }
    `;
    if (!style.parentNode) {
      document.head.appendChild(style);
    }
    FrigateEventsCard._stylesInjected = true;
  }

  private _getConfigValueForEvent(
    config: number | Record<string, number> | undefined,
    event: FrigateEvent,
    defaultValue: number
  ): number {
    if (config === undefined || config === null) return defaultValue;
    if (typeof config === 'number') return config;

    const label = event.label;
    const zones = event.zones || [];

    // Try specific label:zone or zone:label first
    for (const zone of zones) {
      const key1 = `${label}:${zone}`;
      if (config[key1] !== undefined) return config[key1];
      
      const key2 = `${zone}:${label}`;
      if (config[key2] !== undefined) return config[key2];
    }

    // Try label only
    if (config[label] !== undefined) return config[label];

    // Try zone only
    for (const zone of zones) {
      if (config[zone] !== undefined) return config[zone];
    }

    // Default
    if (config['default'] !== undefined) return config['default'];

    return defaultValue;
  }

  private _getVideoTimeParam(event: FrigateEvent): string {
    const skipSeconds = this._getConfigValueForEvent(
      this._config?.video_start_skip_seconds || this._config?.video_start_padding,
      event,
      0
    );
    return skipSeconds > 0 ? `#t=${skipSeconds}` : '';
  }

  private _getEventsToShow(): FrigateEvent[] {
    if (!this._config) return [];
    const isScroll = !!this._config.scroll;
    const visibleCount = this._config.event_count || 5;
    const scrollLimit = this._config.scroll_limit || 20;
    const limit = isScroll ? scrollLimit : visibleCount;

    let visibleEvents = this._events;
    const resetTimestamp = this._getDailyResetTimestamp();
    if (resetTimestamp !== null) {
      visibleEvents = this._events.filter(e => (e.start_time || 0) > resetTimestamp);
    }

    const offset = this._config.offset || 0;
    const eventsToShow = visibleEvents.slice(offset, offset + limit);
    return this._config.reverse ? [...eventsToShow].reverse() : eventsToShow;
  }

  private _navigateToEvent(direction: 'next' | 'prev'): void {
    if (!this._selectedEvent) return;
    const orderedEvents = this._getEventsToShow();
    const currentIndex = orderedEvents.findIndex(e => e.id === this._selectedEvent?.id);
    if (currentIndex === -1) return;

    let newIndex = currentIndex;
    if (direction === 'next') {
      newIndex = currentIndex + 1;
    } else if (direction === 'prev') {
      newIndex = currentIndex - 1;
    }

    if (newIndex >= 0 && newIndex < orderedEvents.length) {
      this._selectedEvent = orderedEvents[newIndex];
      this._showModal();
    }
  }

  private _handleKeyDown(e: KeyboardEvent): void {
    if (!this._selectedEvent) return;
    if (e.key === 'ArrowRight') {
      this._navigateToEvent('next');
    } else if (e.key === 'ArrowLeft') {
      this._navigateToEvent('prev');
    } else if (e.key === 'Escape') {
      this._handleModalClose();
    }
  }

  private _showModal(): void {
    if (!this._selectedEvent) return;

    console.log('Frigate Events Card: event clicked =', this._selectedEvent);

    this._injectModalStyles();
    
    const isUpdating = !!this._modalContainer;
    if (isUpdating && this._boundKeyDownHandler) {
      window.removeEventListener('keydown', this._boundKeyDownHandler);
      this._boundKeyDownHandler = undefined;
    }

    const event = this._selectedEvent;
    const clientId = this._config?.frigate_client_id || 'frigate';
    const snapshotUrl = getEventSnapshotURL(clientId, event.id, {
      bbox: this._config?.show_bounding_box !== false,
      timestamp: true,
      cacheBust: event.end_time || undefined
    });
    const thumbnailUrl = getEventThumbnailURL(clientId, event.id);
    const initialSnapshotUrl = getCachedSignedPath(snapshotUrl) || snapshotUrl;
    const initialThumbnailUrl = getCachedSignedPath(thumbnailUrl) || thumbnailUrl;
    const modalImgUrl = event.has_snapshot !== false ? initialSnapshotUrl : initialThumbnailUrl;
    const duration = this._formatDuration(event.start_time, event.end_time);
    const zones = this._formatZones(event.zones);

    if (!isUpdating) {
      // Create modal container
      this._modalContainer = document.createElement('div');
      this._modalContainer.className = 'frigate-events-modal';
      this._modalContainer.addEventListener('click', () => this._handleModalClose());
    }

    // Build modal content
    const showVideo = !!this._config?.video;
    const timeParam = this._getVideoTimeParam(event);
    const clipUrl = getEventClipURL(clientId, event.id) + timeParam;
    const hlsUrl = getEventHlsURL(clientId, event.id) + timeParam;

    const topScore = event.data?.top_score ?? event.top_score ?? event.data?.score;
    const scoreText = topScore !== undefined && topScore !== null
      ? `${Math.round(topScore * 100)}%`
      : '';

    const timeStr = this._formatTime(event.start_time);
    const dateStr = this._config?.show_date ? `${this._formatDate(event.start_time)} · ` : '';
    const rightLine1 = `${dateStr}${timeStr}`;

    const showDuration = !!this._config?.show_duration;
    const showAccuracy = !!this._config?.show_accuracy;
    const showDescription = this._config?.show_description !== false;
    const showCameraName = this._config?.show_camera_name !== false;
    const showZones = this._config?.show_zones !== false;

    // Check next/prev events
    const orderedEvents = this._getEventsToShow();
    const currentIndex = orderedEvents.findIndex(e => e.id === event.id);
    const hasPrev = currentIndex > 0;
    const hasNext = currentIndex !== -1 && currentIndex < orderedEvents.length - 1;

    const showNav = !!this._config?.show_modal_navigation;
    const prevBtnHtml = (showNav && hasPrev)
      ? `<button class="frigate-events-modal-nav prev" title="Previous event">
           <svg viewBox="0 0 24 24">
             <path d="M15,6L9,12L15,18Z" fill="currentColor"/>
           </svg>
         </button>`
      : '';
    const nextBtnHtml = (showNav && hasNext)
      ? `<button class="frigate-events-modal-nav next" title="Next event">
           <svg viewBox="0 0 24 24">
             <path d="M9,6L15,12L9,18Z" fill="currentColor"/>
           </svg>
         </button>`
      : '';
    const container = this._modalContainer;
    if (!container) return;

    // Build modal content html
    container.innerHTML = `
      <div class="frigate-events-modal-content">
        <div class="frigate-events-modal-image-container">
          ${prevBtnHtml}
          ${showVideo
            ? `<video autoplay ${this._config?.muted ? 'muted' : ''} controls playsinline>
                 <source src="${escapeHtml(clipUrl)}" type="video/mp4">
                 <source src="${escapeHtml(hlsUrl)}" type="application/x-mpegURL">
               </video>`
            : `<img src="${escapeHtml(modalImgUrl)}" alt="${escapeHtml(event.label)}" />`
          }          ${nextBtnHtml}
          <button class="frigate-events-modal-close" title="Close">
            <svg viewBox="0 0 24 24"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
          </button>
        </div>
        <div class="frigate-events-modal-info">
          <div class="frigate-events-modal-info-top">
            <div class="frigate-events-modal-info-left">
              <div class="frigate-events-modal-label">
                <span data-event-label></span>
              </div>
              ${showCameraName
                ? `<div class="frigate-events-modal-camera">
                     <span data-event-camera></span>
                   </div>`
                : ''
              }
              ${showAccuracy && scoreText ? `<div class="frigate-events-modal-score">${scoreText}</div>` : ''}
            </div>
            
            <div class="frigate-events-modal-info-right">
              <div class="frigate-events-modal-time">${escapeHtml(rightLine1)}</div>
              ${showZones && zones ? `<div class="frigate-events-modal-zones"><span data-event-zones></span></div>` : ''}
              ${showDuration ? `<div class="frigate-events-modal-duration">${escapeHtml(duration)}</div>` : ''}
              ${this._isTimelineEnabled() ? `
                <button class="frigate-events-modal-timeline-btn" data-action="open-timeline" title="View in Timeline">
                  <svg viewBox="0 0 24 24"><path d="M12,20A8,8 0 0,0 20,12A8,8 0 0,0 12,4A8,8 0 0,0 4,12A8,8 0 0,0 12,20M12,2A10,10 0 0,1 22,12A10,10 0 0,1 12,2C6.47,2 2,6.48 2,12A10,10 0 0,1 12,2M12.5,7V12.25L17,14.92L16.25,16.15L11,13V7H12.5Z"/></svg>
                  <span>Timeline</span>
                </button>
              ` : ''}
            </div>
          </div>
          ${showDescription && (event.description || event.data?.description)
            ? `<div class="frigate-events-modal-description-row">
                 <div class="frigate-events-modal-description" data-event-description></div>
               </div>`
            : ''
          }
        </div>
      </div>
    `;

    container.querySelector<HTMLElement>('[data-event-label]')!.textContent = this._capitalize(event.label);
    const cameraText = container.querySelector<HTMLElement>('[data-event-camera]');
    if (cameraText) cameraText.textContent = this._formatCameraName(event.camera);
    const zonesText = container.querySelector<HTMLElement>('[data-event-zones]');
    if (zonesText) zonesText.textContent = zones;
    const descriptionText = container.querySelector<HTMLElement>('[data-event-description]');
    if (descriptionText) descriptionText.textContent = event.description || event.data?.description || '';

    // Ensure video muted state is programmatically set to handle browser autoplay policies
    const videoEl = container.querySelector('video');
    if (videoEl) {
      videoEl.muted = this._config?.muted !== false;
    }

    // Stop propagation on content click
    const content = container.querySelector('.frigate-events-modal-content');
    content?.addEventListener('click', (e) => e.stopPropagation());

    // Close button handler
    const closeBtn = container.querySelector('.frigate-events-modal-close');
    closeBtn?.addEventListener('click', () => this._handleModalClose());

    // Timeline button handler
    const timelineBtn = container.querySelector('[data-action="open-timeline"]');
    timelineBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      this._handleModalClose();
      this._showTimelineModal(event.camera, event.start_time, event);
    });

    // Navigation button handlers
    if (showNav && hasPrev) {
      const prevBtn = container.querySelector('.frigate-events-modal-nav.prev');
      prevBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        this._navigateToEvent('prev');
      });
    }
    if (showNav && hasNext) {
      const nextBtn = container.querySelector('.frigate-events-modal-nav.next');
      nextBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        this._navigateToEvent('next');
      });
    }

    const modalImg = container.querySelector('.frigate-events-modal-image-container img') as HTMLImageElement;
    if (modalImg) {
      modalImg.addEventListener('error', async () => {
        if (this.hass && !modalImg.src.includes('authSig=')) {
          try {
            const signed = await signPath(this.hass, modalImg.src);
            const rel = toRelativePath(modalImg.src);
            if (signed && signed !== rel && signed !== modalImg.src) {
              modalImg.src = signed;
              return;
            }
          } catch {}
        }
        if (!modalImg.src.includes('thumbnail')) {
          let thumb = initialThumbnailUrl;
          if (this.hass && !thumb.includes('authSig=')) {
            try {
              thumb = await signPath(this.hass, thumbnailUrl);
            } catch {}
          }
          modalImg.src = thumb;
        }
      });
    }

    // Bind keydown listener
    this._boundKeyDownHandler = (e: KeyboardEvent) => this._handleKeyDown(e);
    window.addEventListener('keydown', this._boundKeyDownHandler);

    // Append to document body only if it's a new modal
    if (!isUpdating) {
      document.body.appendChild(container);
    }
  }

  private _removeModal(): void {
    if (this._modalContainer && this._modalContainer.parentNode) {
      this._modalContainer.parentNode.removeChild(this._modalContainer);
      this._modalContainer = undefined;
    }
    if (this._boundKeyDownHandler) {
      window.removeEventListener('keydown', this._boundKeyDownHandler);
      this._boundKeyDownHandler = undefined;
    }
  }

  private _getMaskDurationHours(): number {
    const raw = this._config?.temp_mask_duration;
    if (typeof raw === 'number' && !isNaN(raw) && raw > 0) return raw;
    if (typeof raw === 'string') {
      const parts = raw.split(':').map(Number);
      if (parts.length === 3 && !parts.some(isNaN)) {
        return parts[0] + parts[1] / 60 + parts[2] / 3600;
      }
      const parsed = parseFloat(raw);
      if (!isNaN(parsed) && parsed > 0) return parsed;
    }
    return 24;
  }

  private async _executeTempMaskToggle(event: FrigateEvent): Promise<boolean> {
    if (!this.hass) return false;
    const maskId = event.id.includes('-') ? event.id.split('-')[0] : event.id;
    const activeMasks = (this._getTemporaryMaskSensor(this.hass.states)?.attributes?.masks as any[]) || [];
    const isCurrentlyActive: boolean = Boolean(
      Array.isArray(activeMasks) && activeMasks.some((m: any) => m.mask_id === maskId)
    );
    const toggleDynamic = this._getTemporaryMaskSensor(this.hass.states)?.attributes?.supports_dynamic_toggle === true;

    try {
      if (isCurrentlyActive) {
        // Remove mask
        if (this.hass.callService) {
          try {
            await this.hass.callService('frigate_temp_mask', 'remove_mask', {
              mask_id: maskId,
            });
          } catch {
            await this.hass.callService('shell_command', 'frigate_remove_temp_mask', {
              mask_id: maskId,
            });
          }
        }
        this._localPendingMasks = [
          ...this._localPendingMasks.filter(m => String(m.mask_id) !== String(maskId)),
          { mask_id: maskId, camera: event.camera, label: event.label, event_id: event.id, removed_at: new Date().toISOString() }
        ];
        this.dispatchEvent(new CustomEvent('hass-notification', {
          detail: { message: toggleDynamic
            ? `Mask removed.`
            : `Mask removed. Frigate is restarting.` },
          bubbles: true,
          composed: true,
        }));
        return false;
      } else {
        // Add mask
        const durationHours = this._getMaskDurationHours();
        if (!this.hass.callService) throw new Error('Home Assistant service calls are unavailable');
        const eventBox = event.data?.box || event.data?.snapshot?.box || event.box;
        await this.hass.callService('frigate_temp_mask', 'add_mask', {
          camera: event.camera,
          event_id: event.id,
          mask_id: maskId,
          duration_hours: durationHours,
          label: event.label,
          ...(eventBox ? { box: eventBox.join(',') } : {}),
        });
        this._localPendingMasks = [];
        this.dispatchEvent(new CustomEvent('hass-notification', {
          detail: { message: toggleDynamic
            ? `Mask applied.`
            : `Mask applied. Frigate is restarting.` },
          bubbles: true,
          composed: true,
        }));
        return true;
      }
    } catch (err) {
      console.error('Failed to toggle temporary mask:', err);
      if (!isCurrentlyActive) {
        this.dispatchEvent(new CustomEvent('hass-notification', {
          detail: { message: `Could not add the mask.` },
          bubbles: true,
          composed: true,
        }));
      }
      return isCurrentlyActive;
    }
  }

  private async _executeChangeMaskDuration(event: FrigateEvent, durationHours: number): Promise<void> {
    if (!this.hass) return;
    const maskId = event.id.includes('-') ? event.id.split('-')[0] : event.id;
    try {
      if (this.hass.callService) {
        try {
          await this.hass.callService('frigate_temp_mask', 'add_mask', {
            camera: event.camera,
            event_id: event.id,
            mask_id: maskId,
            duration_hours: durationHours,
            label: event.label,
          });
        } catch {
          await this.hass.callService('shell_command', 'frigate_add_temp_mask', {
            camera: event.camera,
            event_id: event.id,
            mask_id: maskId,
          });
        }
      }
      this._maskDurationOverrides.set(String(maskId), durationHours <= 0 ? -1 : durationHours);

      const durationText = this._formatMaskDurationChoice(durationHours);

      this.dispatchEvent(new CustomEvent('hass-notification', {
        detail: { message: `Mask duration: ${durationText}.` },
        bubbles: true,
        composed: true,
      }));
    } catch (err) {
      console.error('Failed to change temporary mask duration:', err);
    }
  }

  private _handleContextMenu(e: MouseEvent, event: FrigateEvent): void {
    e.preventDefault();
    e.stopPropagation();
    if (this._touchTimeout) {
      clearTimeout(this._touchTimeout);
      this._touchTimeout = undefined;
    }
    this._openContextMenu(e.clientX, e.clientY, event);
  }

  private _handleTouchStart(e: TouchEvent, event: FrigateEvent): void {
    if (e.touches.length !== 1) return;
    const touch = e.touches[0];
    const clientX = touch.clientX;
    const clientY = touch.clientY;
    this._touchStartX = clientX;
    this._touchStartY = clientY;
    this._didLongPress = false;

    if (this._touchTimeout) {
      clearTimeout(this._touchTimeout);
    }

    this._touchTimeout = setTimeout(() => {
      this._didLongPress = true;
      this._openContextMenu(clientX, clientY, event);
    }, 450);
  }

  private _handleTouchMove(e: TouchEvent): void {
    if (!this._touchTimeout || this._touchStartX === undefined || this._touchStartY === undefined) return;
    const touch = e.touches[0];
    if (!touch) return;
    const deltaX = Math.abs(touch.clientX - this._touchStartX);
    const deltaY = Math.abs(touch.clientY - this._touchStartY);
    if (deltaX > 10 || deltaY > 10) {
      clearTimeout(this._touchTimeout);
      this._touchTimeout = undefined;
    }
  }

  private _handleTouchEnd(): void {
    if (this._touchTimeout) {
      clearTimeout(this._touchTimeout);
      this._touchTimeout = undefined;
    }
    if (this._didLongPress) {
      setTimeout(() => {
        this._didLongPress = false;
      }, 350);
    }
  }

  private _openContextMenu(x: number, y: number, event: FrigateEvent): void {
    this._closeContextMenu();
    this._injectModalStyles();

    const maskId = event.id.includes('-') ? event.id.split('-')[0] : event.id;
    const activeMasks = (this._getTemporaryMaskSensor(this.hass?.states)?.attributes?.masks as any[]) || [];
    const currentMask = Array.isArray(activeMasks) ? activeMasks.find((m: any) => m.mask_id === maskId || m.event_id === event.id || String(m.mask_id) === String(maskId)) : undefined;
    const isMaskActive: boolean = Boolean(currentMask);

    let activeDurationHours = 24;
    let timeRemainingStr = '';
    if (currentMask) {
      activeDurationHours = this._getCurrentMaskDurationHours(currentMask);
      if (activeDurationHours <= 0 || !currentMask.expires_at) {
        // No-expiry masks: activeDurationText already shows '∞', so leave
        // timeRemainingStr empty to avoid a doubled "∞ · ∞" subtitle.
        timeRemainingStr = '';
      } else if (currentMask.expires_at) {
        const expMs = new Date(currentMask.expires_at).getTime();
        const nowMs = Date.now();
        const diffMs = expMs - nowMs;
        if (diffMs > 0) {
          const diffHrs = Math.floor(diffMs / 3600000);
          const diffMins = Math.floor((diffMs % 3600000) / 60000);
          timeRemainingStr = diffHrs > 0 ? `${diffHrs}h ${diffMins}m left` : `${diffMins}m left`;
        }
      }
    }

    const durationPresets = [
      { hours: 1, label: '1 Hour' },
      { hours: 4, label: '4 Hours' },
      { hours: 8, label: '8 Hours' },
      { hours: 12, label: '12 Hours' },
      { hours: 24, label: '24 Hours (1 Day)' },
      { hours: 48, label: '48 Hours (2 Days)' },
      { hours: 168, label: '7 Days' },
      { hours: -1, label: '∞ Infinity' },
    ];
    const isCustomDuration = isMaskActive && !durationPresets.some(p => Math.abs(p.hours - activeDurationHours) < 0.01);

    const activeDurationText = activeDurationHours <= 0
      ? '∞'
      : activeDurationHours === 1
      ? '1h'
      : activeDurationHours === 24
      ? '24h'
      : activeDurationHours === 48
      ? '48h'
      : activeDurationHours === 168
      ? '7d'
      : `${activeDurationHours}h`;

    const hasTempMaskIntegration = !!(
      this._config?.show_temp_mask !== false &&
      (this.hass?.services?.['frigate_temp_mask'] || this.hass?.services?.['shell_command']?.['frigate_add_temp_mask'] || this._getTemporaryMaskSensor(this.hass?.states))
    );

    const menu = document.createElement('div');
    menu.className = 'frigate-events-context-menu';

    menu.innerHTML = `
      <button class="frigate-events-context-item" data-action="view">
        <svg viewBox="0 0 24 24"><path d="M12,9A3,3 0 0,0 9,12A3,3 0 0,0 12,15A3,3 0 0,0 15,12A3,3 0 0,0 12,9M12,17A5,5 0 0,1 7,12A5,5 0 0,1 12,7A5,5 0 0,1 17,12A5,5 0 0,1 12,7M12,4.5C7,4.5 2.73,7.61 1,12C2.73,16.39 7,19.5 12,19.5C17,19.5 21.27,16.39 23,12C21.27,7.61 17,4.5 12,4.5Z"/></svg>
        <span>View Details</span>
      </button>
      ${this._isTimelineEnabled() ? `
      <button class="frigate-events-context-item" data-action="view-timeline">
        <svg viewBox="0 0 24 24"><path d="M12,20A8,8 0 0,0 20,12A8,8 0 0,0 12,4A8,8 0 0,0 4,12A8,8 0 0,0 12,20M12,2A10,10 0 0,1 22,12A10,10 0 0,1 12,2C6.47,2 2,6.48 2,12A10,10 0 0,1 12,2M12.5,7V12.25L17,14.92L16.25,16.15L11,13V7H12.5Z"/></svg>
        <span>View in Timeline</span>
      </button>
      ` : ''}
      <button class="frigate-events-context-item" data-action="open-mask-manager">
        <svg viewBox="0 0 24 24"><path d="M2,2H8V4H16V2H22V8H20V16H22V22H16V20H8V22H2V16H4V8H2V2M4,4V6H6V4H4M18,4V6H20V4H18M20,18V20H18V18H20M4,18V20H6V18H4M8,6V8H6V16H8V18H16V16H18V8H16V6H8M9,9H15V15H9V9Z"/></svg>
        <span>Manage Temp Masks</span>
      </button>
      ${hasTempMaskIntegration ? `
      <div class="frigate-events-context-separator"></div>
      ${isMaskActive ? `
      <div class="frigate-events-context-item-wrapper has-submenu">
        <button class="frigate-events-context-item masked" data-action="change-duration-trigger">
          <svg viewBox="0 0 24 24"><path d="M12,20A8,8 0 0,0 20,12A8,8 0 0,0 12,4A8,8 0 0,0 4,12A8,8 0 0,0 12,20M12,2A10,10 0 0,1 22,12A10,10 0 0,1 12,2C6.47,22 2,17.5 2,12A10,10 0 0,1 12,2M12.5,7V12.25L17,14.92L16.25,16.15L11,13V7H12.5Z"/></svg>
          <div class="duration-label-container">
            <span>Change Duration</span>
            <span class="duration-subtitle">Set: ${activeDurationText}${timeRemainingStr ? ` · ${timeRemainingStr}` : ''}</span>
          </div>
          <svg class="submenu-arrow" viewBox="0 0 24 24"><path d="M8.59,16.58L13.17,12L8.59,7.41L10,6L16,12L10,18L8.59,16.58Z"/></svg>
        </button>
        <div class="frigate-events-submenu">
          ${durationPresets.map(p => {
            const isSelected = Math.abs(p.hours - activeDurationHours) < 0.01;
            return `
              <button class="frigate-events-context-item ${isSelected ? 'selected' : ''}" data-duration="${p.hours}">
                <span>${p.label}</span>
                ${isSelected ? `
                  <svg class="check-icon" viewBox="0 0 24 24">
                    <path d="M21,7L9,19L3.5,13.5L4.91,12.09L9,16.17L19.59,5.59L21,7Z"/>
                  </svg>
                ` : ''}
              </button>
            `;
          }).join('')}
          <button class="frigate-events-context-item ${isCustomDuration ? 'selected' : ''}" data-duration="custom">
            <span>${isCustomDuration ? `Custom (${activeDurationHours}h)` : 'Custom...'}</span>
            ${isCustomDuration ? `
              <svg class="check-icon" viewBox="0 0 24 24">
                <path d="M21,7L9,19L3.5,13.5L4.91,12.09L9,16.17L19.59,5.59L21,7Z"/>
              </svg>
            ` : ''}
          </button>
        </div>
      </div>
      <button class="frigate-events-context-item masked" data-action="mask">
        <svg viewBox="0 0 24 24"><path d="M12 2C6.5 2 2 6.5 2 12S6.5 22 12 22 22 17.5 22 12 17.5 2 12 2M12 4C16.4 4 20 7.6 20 12C20 13.8 19.4 15.5 18.3 16.9L7.1 5.7C8.5 4.6 10.2 4 12 4M5.7 7.1L16.9 18.3C15.5 19.4 13.8 20 12 20C7.6 20 4 16.4 4 12C4 10.2 4.6 8.5 5.7 7.1Z"/></svg>
        <span>Remove Mask</span>
      </button>
      ` : `
      <button class="frigate-events-context-item" data-action="mask">
        <svg viewBox="0 0 24 24"><path d="M2,2H8V4H16V2H22V8H20V16H22V22H16V20H8V22H2V16H4V8H2V2M4,4V6H6V4H4M18,4V6H20V4H18M20,18V20H18V18H20M4,18V20H6V18H4M8,6V8H6V16H8V18H16V16H18V8H16V6H8M9,9H15V15H9V9Z"/></svg>
        <span>Temporary Mask</span>
      </button>
      `}
      ` : ''}
      <div class="frigate-events-context-separator"></div>
      <button class="frigate-events-context-item danger" data-action="delete">
        <svg viewBox="0 0 24 24"><path d="M19,4H15.5L14.5,3H9.5L8.5,4H5V6H19M6,19A2,2 0 0,0 8,21H16A2,2 0 0,0 18,19V7H6V19Z"/></svg>
        <span>Delete Event</span>
      </button>
    `;

    document.body.appendChild(menu);
    const rect = menu.getBoundingClientRect();
    let posX = x;
    let posY = y;
    if (posX + rect.width > window.innerWidth - 10) {
      posX = window.innerWidth - rect.width - 10;
    }
    if (posY + rect.height > window.innerHeight - 10) {
      posY = window.innerHeight - rect.height - 10;
    }
    menu.style.left = `${Math.max(10, posX)}px`;
    menu.style.top = `${Math.max(10, posY)}px`;

    const wrapper = menu.querySelector('.frigate-events-context-item-wrapper.has-submenu');
    const submenu = menu.querySelector('.frigate-events-submenu') as HTMLElement;
    if (submenu) {
      if (posX + rect.width + 170 > window.innerWidth) {
        submenu.classList.add('align-left');
      }
      if (posY + 260 > window.innerHeight) {
        submenu.classList.add('align-top');
      }
    }

    menu.querySelector('[data-action="view"]')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this._closeContextMenu();
      this._selectedEvent = event;
      this._showModal();
    });

    menu.querySelector('[data-action="view-timeline"]')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this._closeContextMenu();
      this._showTimelineModal(event.camera, event.start_time, event);
    });

    menu.querySelector('[data-action="open-mask-manager"]')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this._closeContextMenu();
      this._showMaskManagerModal();
    });

    if (hasTempMaskIntegration) {
      const triggerBtn = menu.querySelector('[data-action="change-duration-trigger"]');
      if (triggerBtn && wrapper) {
        triggerBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          wrapper.classList.toggle('open');
        });
      }

      menu.querySelectorAll('[data-duration]').forEach((btn) => {
        btn.addEventListener('click', async (e) => {
          e.stopPropagation();
          const durationAttr = (btn as HTMLElement).getAttribute('data-duration');
          this._closeContextMenu();

          let hours = 24;
          if (durationAttr === 'custom') {
            const input = window.prompt('Enter temporary mask duration in hours:', '24');
            if (!input) return;
            const parsed = parseFloat(input.trim());
            if (isNaN(parsed) || parsed <= 0) {
              return;
            }
            hours = parsed;
          } else if (durationAttr) {
            hours = parseFloat(durationAttr);
          }

          await this._executeChangeMaskDuration(event, hours);
        });
      });

      menu.querySelector('[data-action="mask"]')?.addEventListener('click', async (e) => {
        e.stopPropagation();
        this._closeContextMenu();
        await this._executeTempMaskToggle(event);
      });
    }

    menu.querySelector('[data-action="delete"]')?.addEventListener('click', async (e) => {
      e.stopPropagation();
      this._closeContextMenu();
      await this._executeDeleteEvent(event);
    });

    const onDocClick = (ev: MouseEvent) => {
      if (!menu.contains(ev.target as Node)) {
        this._closeContextMenu();
        window.removeEventListener('click', onDocClick);
      }
    };
    setTimeout(() => window.addEventListener('click', onDocClick), 10);

    this._contextMenuEl = menu;
  }

  private _closeContextMenu(): void {
    if (this._contextMenuEl && this._contextMenuEl.parentNode) {
      this._contextMenuEl.parentNode.removeChild(this._contextMenuEl);
      this._contextMenuEl = undefined;
    }
  }

  private _formatMaskDurationChoice(durationHours: number): string {
    if (durationHours <= 0) return 'no expiry';
    if (durationHours === 1) return '1 hour';
    if (durationHours < 24) return `${durationHours} hours`;
    if (durationHours % 24 === 0) {
      const days = durationHours / 24;
      return days === 1 ? '1 day' : `${days} days`;
    }
    return `${durationHours} hours`;
  }

  private _formatMaskRemainingTime(expiresAt?: string | null, durationHours?: number): string {
    if (durationHours !== undefined && durationHours <= 0) return '∞';
    if (!expiresAt) return '∞';
    const expMs = new Date(expiresAt).getTime();
    const nowMs = Date.now();
    const diffMs = expMs - nowMs;
    if (diffMs <= 0) return 'Expired';
    const diffHrs = Math.floor(diffMs / 3600000);
    const diffMins = Math.floor((diffMs % 3600000) / 60000);
    const diffSecs = Math.floor((diffMs % 60000) / 1000);
    if (diffHrs > 0) {
      return `${diffHrs}h ${diffMins}m left`;
    }
    if (diffMins > 0) {
      return `${diffMins}m ${diffSecs}s left`;
    }
    return `${diffSecs}s left`;
  }

  private _openLiveViewContextMenu(x: number, y: number): void {
    this._closeContextMenu();
    this._injectModalStyles();

    const liveCam = this._config?.camera || (this._getAvailableCameras()[0] || '');
    const hasTempMaskIntegration = !!(
      this._config?.show_temp_mask !== false &&
      (this.hass?.services?.['frigate_temp_mask'] || this.hass?.services?.['shell_command']?.['frigate_add_temp_mask'] || this._getTemporaryMaskSensor(this.hass?.states))
    );

    const menu = document.createElement('div');
    menu.className = 'frigate-events-context-menu';

    menu.innerHTML = `
      ${this._isTimelineEnabled() ? `
      <button class="frigate-events-context-item" data-action="live-timeline">
        <svg viewBox="0 0 24 24"><path d="M12,20A8,8 0 0,0 20,12A8,8 0 0,0 12,4A8,8 0 0,0 4,12A8,8 0 0,0 12,20M12,2A10,10 0 0,1 22,12A10,10 0 0,1 12,2C6.47,2 2,6.48 2,12A10,10 0 0,1 12,2M12.5,7V12.25L17,14.92L16.25,16.15L11,13V7H12.5Z"/></svg>
        <span>View in Timeline</span>
      </button>
      ` : ''}
      ${hasTempMaskIntegration ? `
      <button class="frigate-events-context-item" data-action="open-mask-manager">
        <svg viewBox="0 0 24 24"><path d="M2,2H8V4H16V2H22V8H20V16H22V22H16V20H8V22H2V16H4V8H2V2M4,4V6H6V4H4M18,4V6H20V4H18M20,18V20H18V18H20M4,18V20H6V18H4M8,6V8H6V16H8V18H16V16H18V8H16V6H8M9,9H15V15H9V9Z"/></svg>
        <span>Manage Temp Masks</span>
      </button>
      ` : ''}
    `;

    document.body.appendChild(menu);
    const rect = menu.getBoundingClientRect();
    let posX = x;
    let posY = y;
    if (posX + rect.width > window.innerWidth - 10) {
      posX = window.innerWidth - rect.width - 10;
    }
    if (posY + rect.height > window.innerHeight - 10) {
      posY = window.innerHeight - rect.height - 10;
    }
    menu.style.left = `${Math.max(10, posX)}px`;
    menu.style.top = `${Math.max(10, posY)}px`;

    menu.querySelector('[data-action="live-timeline"]')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this._closeContextMenu();
      this._showTimelineModal(liveCam);
    });

    menu.querySelector('[data-action="open-mask-manager"]')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this._closeContextMenu();
      this._showMaskManagerModal();
    });

    const onDocClick = (ev: MouseEvent) => {
      if (!menu.contains(ev.target as Node)) {
        this._closeContextMenu();
        window.removeEventListener('click', onDocClick);
      }
    };
    setTimeout(() => window.addEventListener('click', onDocClick), 10);

    this._contextMenuEl = menu;
  }

  private _handleLiveViewContextMenu(e: MouseEvent): void {
    e.preventDefault();
    e.stopPropagation();
    if (this._liveTouchTimeout) {
      clearTimeout(this._liveTouchTimeout);
      this._liveTouchTimeout = undefined;
    }
    this._openLiveViewContextMenu(e.clientX, e.clientY);
  }

  private _handleLiveViewTouchStart(e: TouchEvent): void {
    if (e.touches.length !== 1) return;
    const touch = e.touches[0];
    const clientX = touch.clientX;
    const clientY = touch.clientY;
    this._liveTouchStartX = clientX;
    this._liveTouchStartY = clientY;
    this._didLongPress = false;

    if (this._liveTouchTimeout) {
      clearTimeout(this._liveTouchTimeout);
    }
    this._liveTouchTimeout = setTimeout(() => {
      this._didLongPress = true;
      this._openLiveViewContextMenu(clientX, clientY);
    }, 450);
  }

  private _handleLiveViewTouchMove(e: TouchEvent): void {
    if (!this._liveTouchTimeout || this._liveTouchStartX === undefined || this._liveTouchStartY === undefined) return;
    const touch = e.touches[0];
    if (!touch) return;
    const deltaX = Math.abs(touch.clientX - this._liveTouchStartX);
    const deltaY = Math.abs(touch.clientY - this._liveTouchStartY);
    if (deltaX > 10 || deltaY > 10) {
      clearTimeout(this._liveTouchTimeout);
      this._liveTouchTimeout = undefined;
    }
  }

  private _handleLiveViewTouchEnd(): void {
    if (this._liveTouchTimeout) {
      clearTimeout(this._liveTouchTimeout);
      this._liveTouchTimeout = undefined;
    }
    if (this._didLongPress) {
      setTimeout(() => {
        this._didLongPress = false;
      }, 350);
    }
  }

  private _matchesCamera(entityOrCam1?: string, entityOrCam2?: string): boolean {
    if (!entityOrCam1 || !entityOrCam2) return true;
    const clean1 = entityOrCam1.toLowerCase().replace(/^camera\./, '').replace(/_(live|sub|detect|fluent|high|low|hd|sd|main|stream|rtsp)$/, '').replace(/[-_]/g, '');
    const clean2 = entityOrCam2.toLowerCase().replace(/^camera\./, '').replace(/_(live|sub|detect|fluent|high|low|hd|sd|main|stream|rtsp)$/, '').replace(/[-_]/g, '');
    return clean1 === clean2 || clean1.includes(clean2) || clean2.includes(clean1);
  }

  private _showMaskManagerModal(): void {
    this._closeContextMenu();
    this._injectModalStyles();

    // Trigger background sync with Frigate status/uptime
    try {
      if (this.hass?.callService) {
        this.hass.callService('frigate_temp_mask', 'sync', {});
      }
    } catch {}

    if (this._maskManagerContainer) {
      this._renderMaskManagerContent(this._maskManagerContainer);
      void this._refreshMaskManagerSnapshots();
      return;
    }

    const container = document.createElement('div');
    container.className = 'frigate-events-modal frigate-mask-manager-modal';
    this._maskManagerContainer = container;

    this._renderMaskManagerContent(container);
    void this._refreshMaskManagerSnapshots();

    container.addEventListener('click', (e) => {
      if (e.target === container) {
        this._removeMaskManagerModal();
      }
    });

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        this._removeMaskManagerModal();
        window.removeEventListener('keydown', onKeyDown);
      }
    };
    window.addEventListener('keydown', onKeyDown);

    if (this._maskManagerTimer) {
      clearInterval(this._maskManagerTimer);
    }
    this._maskManagerTimer = setInterval(() => {
      if (this._maskManagerContainer) {
        this._updateMaskManagerTimers(this._maskManagerContainer);
      }
    }, 1000);

    document.body.appendChild(container);
  }

  private _findCameraEntityId(cameraName: string): string | null {
    const states = this.hass?.states;
    if (!states || !cameraName) return null;

    const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '');
    const target = normalize(cameraName);
    if (!target) return null;

    const liveEntity = this._config?.live_view_entity;
    if (liveEntity && liveEntity.startsWith('camera.') && states[liveEntity]) {
      const liveObjectId = normalize(liveEntity.slice('camera.'.length));
      if (liveObjectId === target || liveObjectId.endsWith(target) || target.endsWith(liveObjectId)) {
        return liveEntity;
      }
    }

    const cameraIds = Object.keys(states).filter((id) => id.startsWith('camera.'));
    let suffixMatch: string | null = null;
    let fuzzyMatch: string | null = null;

    for (const id of cameraIds) {
      const objectId = normalize(id.slice('camera.'.length));
      const attrs = states[id]?.attributes || {};
      const attrNames = ['camera_name', 'frigate_camera_name', 'friendly_name']
        .map((key) => attrs[key])
        .filter((value): value is string => typeof value === 'string')
        .map(normalize);

      if (objectId === target || attrNames.includes(target)) {
        return id;
      }
      if (!suffixMatch && (objectId.endsWith(target) || attrNames.some((name) => name.endsWith(target)))) {
        suffixMatch = id;
      }
      if (!fuzzyMatch && (objectId.includes(target) || attrNames.some((name) => name.includes(target)))) {
        fuzzyMatch = id;
      }
    }

    return suffixMatch || fuzzyMatch;
  }

  private async _refreshMaskManagerSnapshots(): Promise<void> {
    const sensor = this._getTemporaryMaskSensor(this.hass?.states);
    const activeMasks = Array.isArray(sensor?.attributes?.masks) ? sensor.attributes.masks : [];
    const pendingMasks = Array.isArray(sensor?.attributes?.pending_restart_masks) ? sensor.attributes.pending_restart_masks : [];
    const cameras = Array.from(new Set(
      [...activeMasks, ...pendingMasks]
        .map((mask: any) => mask?.camera)
        .filter((camera: unknown): camera is string => typeof camera === 'string' && camera.length > 0)
    ));
    if (cameras.length === 0) return;

    const token = ++this._maskManagerSnapshotToken;
    const cacheBust = Date.now();
    const results = await Promise.all(cameras.map(async (camera) => {
      let url = '';
      const entityId = this._findCameraEntityId(camera);

      if (entityId && this.hass) {
        const proxyPath = `/api/camera_proxy/${entityId}?t=${cacheBust}`;
        try {
          url = await signPath(this.hass, proxyPath);
        } catch {
          url = proxyPath;
        }
      }

      if (!url && this._config?.frigate_url) {
        const base = this._config.frigate_url.replace(/\/+$/, '');
        url = `${base}/api/${encodeURIComponent(camera)}/latest.jpg?t=${cacheBust}`;
      }

      return [camera, url] as const;
    }));

    const clientId = this._config?.frigate_client_id || 'frigate';
    const eventSnapshotResults = await Promise.all([...activeMasks, ...pendingMasks].map(async (mask: any) => {
      const maskId = String(mask?.mask_id || '');
      const eventId = String(mask?.event_id || maskId);
      if (!maskId || !eventId) return null;

      const snapshotPath = getEventSnapshotURL(clientId, eventId, { bbox: false, crop: false });
      let signedPath = snapshotPath;
      if (this.hass) {
        try {
          signedPath = await signPath(this.hass, snapshotPath);
        } catch {
          signedPath = snapshotPath;
        }
      }
      return [maskId, signedPath] as const;
    }));

    if (token !== this._maskManagerSnapshotToken) return;

    results.forEach(([camera, url]) => {
      if (url) {
        this._maskManagerSnapshotUrls.set(camera, url);
      } else {
        this._maskManagerSnapshotUrls.delete(camera);
      }
    });

    this._maskManagerEventSnapshotUrls.clear();
    eventSnapshotResults.forEach((result) => {
      if (result) this._maskManagerEventSnapshotUrls.set(result[0], result[1]);
    });

    if (this._maskManagerContainer) {
      this._renderMaskManagerContent(this._maskManagerContainer);
    }
  }

  private _removeMaskManagerModal(): void {
    if (this._maskManagerContainer && this._maskManagerContainer.parentNode) {
      this._maskManagerContainer.parentNode.removeChild(this._maskManagerContainer);
      this._maskManagerContainer = undefined;
      this._maskManagerExpandedId = undefined;
      this._maskEditingId = undefined;
    }
    if (this._maskManagerTimer) {
      clearInterval(this._maskManagerTimer);
      this._maskManagerTimer = undefined;
    }
  }

  private _updateMaskManagerTimers(container: HTMLElement): void {
    const activeMasks = (this._getTemporaryMaskSensor(this.hass?.states)?.attributes?.masks as any[]) || [];
    if (!Array.isArray(activeMasks)) return;
    const map = new Map<string, any>();
    activeMasks.forEach(m => map.set(m.mask_id, m));

    container.querySelectorAll('[data-timer-mask-id]').forEach(el => {
      const maskId = el.getAttribute('data-timer-mask-id');
      const mask = maskId ? map.get(maskId) : undefined;
      if (mask) {
        const remaining = this._formatMaskRemainingTime(mask.expires_at, mask.duration_hours);
        const span = el.querySelector('.timer-text');
        if (span) span.textContent = remaining === '∞' ? 'No expiry' : remaining;
        const hasExpiry = typeof mask.duration_hours === 'number' ? mask.duration_hours > 0 : true;
        const msLeft = (hasExpiry && mask.expires_at) ? new Date(mask.expires_at).getTime() - Date.now() : Infinity;
        el.classList.toggle('expiring', msLeft < 3600000);
      }
    });
  }

  private _parseMaskPolygonNormalized(mask: any): { pts: Array<{ x: number; y: number }>; viewBoxW: number; viewBoxH: number } {
    let viewBoxW = 1920;
    let viewBoxH = 1080;
    if (typeof mask?.width === 'number' && typeof mask?.height === 'number' && mask.width > 0 && mask.height > 0) {
      viewBoxW = mask.width;
      viewBoxH = mask.height;
    }
    const polyStr = mask?.polygon;
    if (!polyStr || typeof polyStr !== 'string') return { pts: [], viewBoxW, viewBoxH };
    const nums = polyStr.split(',').map((s: string) => parseFloat(s.trim())).filter((n: number) => !isNaN(n));
    if (nums.length < 6) return { pts: [], viewBoxW, viewBoxH };
    const isNormalized = nums.every((n: number) => n <= 1.0);
    if (!isNormalized && (!mask?.width || !mask?.height)) {
      let maxCoord = 0;
      for (const n of nums) {
        if (n > maxCoord) maxCoord = n;
      }
      if (maxCoord > 2560) {
        viewBoxW = 3840; viewBoxH = 2160;
      } else if (maxCoord > 1920) {
        viewBoxW = 2560; viewBoxH = 1440;
      }
    }
    const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));
    const pts: Array<{ x: number; y: number }> = [];
    for (let i = 0; i + 1 < nums.length; i += 2) {
      if (isNormalized) {
        pts.push({ x: clamp01(nums[i]), y: clamp01(nums[i + 1]) });
      } else {
        pts.push({ x: clamp01(nums[i] / viewBoxW), y: clamp01(nums[i + 1] / viewBoxH) });
      }
    }
    return { pts, viewBoxW, viewBoxH };
  }

  private _formatNormalizedPolygon(pts: Array<{ x: number; y: number }>): string {
    return pts.map(p => `${Math.round(p.x * 1000) / 1000},${Math.round(p.y * 1000) / 1000}`).join(',');
  }

  private _scaleNormalizedPolygon(pts: Array<{ x: number; y: number }>, factor: number): Array<{ x: number; y: number }> {
    if (pts.length === 0) return pts;
    let cx = 0, cy = 0;
    for (const p of pts) {
      cx += p.x;
      cy += p.y;
    }
    cx /= pts.length;
    cy /= pts.length;
    return pts.map(p => ({
      x: Math.min(1, Math.max(0, cx + (p.x - cx) * factor)),
      y: Math.min(1, Math.max(0, cy + (p.y - cy) * factor)),
    }));
  }

  private _getMaskPreviewGeometry(mask: any, matchedEvent?: any): {
    polyPts: string;
    posName: string;
    maskW: number;
    maskH: number;
    viewBoxW: number;
    viewBoxH: number;
    cropRegion: { x: number; y: number; w: number; h: number } | null;
  } {
    let posName = 'Center';
    let polyPts = '';
    let maskW = 0, maskH = 0;
    let viewBoxW = 1920;
    let viewBoxH = 1080;
    let cropRegion: { x: number; y: number; w: number; h: number } | null = null;

    if (typeof mask?.width === 'number' && typeof mask?.height === 'number' && mask.width > 0 && mask.height > 0) {
      viewBoxW = mask.width;
      viewBoxH = mask.height;
    }

    const polyStr = mask.polygon || matchedEvent?.polygon;
    if (polyStr) {
      const nums = polyStr.split(',').map((s: string) => parseFloat(s.trim())).filter((n: number) => !isNaN(n));
      if (nums.length >= 6) {
        const isNormalized = nums.every((n: number) => n <= 1.0);
        if (!isNormalized && (!mask?.width || !mask?.height)) {
          let maxCoord = 0;
          for (const n of nums) {
            if (n > maxCoord) maxCoord = n;
          }
          if (maxCoord > 2560) {
            viewBoxW = 3840; viewBoxH = 2160;
          } else if (maxCoord > 1920) {
            viewBoxW = 2560; viewBoxH = 1440;
          }
        }

        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        const pts: string[] = [];
        for (let i = 0; i < nums.length; i += 2) {
          let px = nums[i];
          let py = nums[i + 1] ?? 0;
          if (isNormalized) {
            px = px * viewBoxW;
            py = py * viewBoxH;
          }
          pts.push(`${px},${py}`);
          if (px < minX) minX = px;
          if (py < minY) minY = py;
          if (px > maxX) maxX = px;
          if (py > maxY) maxY = py;
        }
        polyPts = pts.join(' ');
        maskW = maxX - minX;
        maskH = maxY - minY;

        const centerX = (minX + maxX) / 2;
        const centerY = (minY + maxY) / 2;
        const normCenterX = centerX / viewBoxW;
        const normCenterY = centerY / viewBoxH;

        const vert = normCenterY < 0.35 ? 'Top' : (normCenterY > 0.65 ? 'Bottom' : 'Middle');
        const horiz = normCenterX < 0.35 ? 'Left' : (normCenterX > 0.65 ? 'Right' : 'Center');
        posName = vert === 'Middle' && horiz === 'Center' ? 'Center' : `${vert}-${horiz}`;

        cropRegion = {
          x: minX / viewBoxW,
          y: minY / viewBoxH,
          w: maskW / viewBoxW,
          h: maskH / viewBoxH,
        };
      }
    } else {
      const rawBox = mask.box || matchedEvent?.data?.box || (Array.isArray(matchedEvent?.box) ? matchedEvent?.box : null);
      if (rawBox && Array.isArray(rawBox) && rawBox.length === 4) {
        // Frigate event boxes are [x, y, width, height].
        const [x, y, boxWidth, boxHeight] = rawBox;

        const isNorm = rawBox.every((n: number) => n <= 1.0);
        const scaleW = isNorm ? viewBoxW : 1;
        const scaleH = isNorm ? viewBoxH : 1;
        const x1_px = x * scaleW;
        const y1_px = y * scaleH;
        const x2_px = (x + boxWidth) * scaleW;
        const y2_px = (y + boxHeight) * scaleH;
        polyPts = `${x1_px},${y1_px} ${x2_px},${y1_px} ${x2_px},${y2_px} ${x1_px},${y2_px}`;
        maskW = x2_px - x1_px;
        maskH = y2_px - y1_px;
        const centerX = (x1_px + x2_px) / 2;
        const centerY = (y1_px + y2_px) / 2;
        const normCenterX = centerX / viewBoxW;
        const normCenterY = centerY / viewBoxH;
        const vert = normCenterY < 0.35 ? 'Top' : (normCenterY > 0.65 ? 'Bottom' : 'Middle');
        const horiz = normCenterX < 0.35 ? 'Left' : (normCenterX > 0.65 ? 'Right' : 'Center');
        posName = vert === 'Middle' && horiz === 'Center' ? 'Center' : `${vert}-${horiz}`;

        cropRegion = {
          x: isNorm ? x : x / viewBoxW,
          y: isNorm ? y : y / viewBoxH,
          w: isNorm ? boxWidth : boxWidth / viewBoxW,
          h: isNorm ? boxHeight : boxHeight / viewBoxH,
        };
      }
    }

    // Fallback crop region from matched event if available
    const eventRegion = matchedEvent?.data?.region || matchedEvent?.data?.box;
    if (eventRegion && Array.isArray(eventRegion) && eventRegion.length === 4 && !cropRegion) {
      const [x, y, width, height] = eventRegion;
      const isNorm = eventRegion.every((n: number) => n <= 1.0);
      cropRegion = {
        x: isNorm ? x : x / viewBoxW,
        y: isNorm ? y : y / viewBoxH,
        w: Math.max(0.05, isNorm ? width : width / viewBoxW),
        h: Math.max(0.05, isNorm ? height : height / viewBoxH),
      };
    }

    return { polyPts, posName, maskW, maskH, viewBoxW, viewBoxH, cropRegion };
  }

  private _renderMaskManagerContent(container: HTMLElement): void {
    const rawMasks = (this._getTemporaryMaskSensor(this.hass?.states)?.attributes?.masks as any[]) || [];
    const activeMasks = Array.isArray(rawMasks) ? rawMasks : [];
    const totalCount = activeMasks.length;

    const rawPending = (this._getTemporaryMaskSensor(this.hass?.states)?.attributes?.pending_restart_masks as any[]) || [];
    const backendPending = Array.isArray(rawPending) ? rawPending : [];

    const sensorAttrs = this._getTemporaryMaskSensor(this.hass?.states)?.attributes;
    const supportsDynamic = sensorAttrs?.supports_dynamic_toggle === true;

    // Combine local pending and backend pending
    const pendingMap = new Map<string, any>();
    if (!supportsDynamic) {
      this._localPendingMasks.forEach(m => pendingMap.set(String(m.mask_id), m));
      backendPending.forEach(m => pendingMap.set(String(m.mask_id), m));
    }

    // Remove any that are currently in activeMasks
    activeMasks.forEach(m => pendingMap.delete(String(m.mask_id)));
    const pendingMasks = Array.from(pendingMap.values());

    // Get unique cameras from active and pending
    const allCams = [...activeMasks.map((m: any) => m.camera), ...pendingMasks.map((m: any) => m.camera)].filter(Boolean);
    const cameras = Array.from(new Set(allCams));
    const filterCamera = this._maskManagerSelectedCamera || 'all';

    const filteredMasks = filterCamera === 'all'
      ? activeMasks
      : activeMasks.filter((m: any) => m.camera === filterCamera);

    const filteredPending = filterCamera === 'all'
      ? pendingMasks
      : pendingMasks.filter((m: any) => m.camera === filterCamera);

    const primaryPresets = [
      { hours: 1, label: '1h' },
      { hours: 8, label: '8h' },
      { hours: 24, label: '24h' },
      { hours: 168, label: '7d' },
    ];
    const morePresets = [
      { hours: 4, label: '4h' },
      { hours: 12, label: '12h' },
      { hours: 48, label: '48h' },
      { hours: 72, label: '72h' },
      { hours: -1, label: 'No expiry' },
    ];
    const allPresets = [...primaryPresets, ...morePresets];

    // Keep the list scroll position across re-renders (timers, duration changes, snapshots).
    const previousScroll = container.querySelector<HTMLElement>('.mask-manager-body')?.scrollTop ?? 0;

    // Expanded row: the user's last choice; with no choice yet, expand the
    // lone mask but collapse all when there are several.
    const expandedId = (this._maskManagerExpandedId === '' ||
      (this._maskManagerExpandedId !== undefined && filteredMasks.some((m: any) => String(m.mask_id) === this._maskManagerExpandedId)))
      ? this._maskManagerExpandedId
      : (filteredMasks.length > 1 ? '' : (filteredMasks[0] ? String(filteredMasks[0].mask_id) : ''));

    const buildViewModel = (mask: any) => {
      const clientId = this._config?.frigate_client_id || 'frigate';
      const maskId = String(mask.mask_id || '');
      const eventId = String(mask.event_id || maskId);
      const matchedEvent = this._events?.find(e =>
        e.id === eventId ||
        e.id.startsWith(maskId) ||
        maskId.startsWith(e.id)
      );

      const label = String(matchedEvent?.label || mask.label || 'Object');
      const cameraName = mask.camera || matchedEvent?.camera || '';
      const timeText = matchedEvent?.start_time ? this._formatTime(matchedEvent.start_time) : '';
      const rawTs = matchedEvent?.start_time || (eventId.includes('.') ? parseFloat(eventId.split('-')[0]) : 0);
      const eventTs = rawTs ? Math.floor(rawTs) : 0;

      const frigateBase = this._config?.frigate_url ? this._config.frigate_url.replace(/\/+$/, '') : '';
      const directRecordingUrl = (frigateBase && cameraName && eventTs)
        ? `${frigateBase}/api/${encodeURIComponent(cameraName)}/recordings/${eventTs}/snapshot.png`
        : '';
      const fallbackSnapshotUrl = getEventSnapshotURL(clientId, matchedEvent ? matchedEvent.id : eventId, {
        bbox: false,
        crop: false
      });
      const eventSnapshotUrl = this._maskManagerEventSnapshotUrls.get(maskId) || fallbackSnapshotUrl;
      const primaryUrl = eventSnapshotUrl || directRecordingUrl;
      const liveSnapshotUrl = cameraName ? (this._maskManagerSnapshotUrls.get(cameraName) || '') : '';
      const displayUrl = liveSnapshotUrl || primaryUrl;
      const imageFallbackUrl = liveSnapshotUrl
        ? primaryUrl
        : (directRecordingUrl && directRecordingUrl !== primaryUrl ? directRecordingUrl : '');
      const geo = this._getMaskPreviewGeometry(mask, matchedEvent);

      const title = `${label} · ${this._formatCameraName(mask.camera || 'Camera')}`;
      const subParts = [
        timeText ? `Detected ${timeText}` : '',
        geo.posName ? `${geo.posName} of frame` : '',
      ].filter(Boolean);

      return { maskId, title, sub: subParts.join(' · '), displayUrl, imageFallbackUrl, geo };
    };

    const buildPreview = (vm: ReturnType<typeof buildViewModel>): string => `
      ${vm.displayUrl ? `
        <img
          src="${escapeHtml(vm.displayUrl)}"
          class="mask-preview-thumb"
          alt=""
          loading="lazy"
          data-fallback-url="${escapeHtml(vm.imageFallbackUrl)}"
          onerror="((img) => {
            if (!img.dataset.triedFallback && img.dataset.fallbackUrl) {
              img.dataset.triedFallback = 'true';
              img.src = img.dataset.fallbackUrl;
            } else {
              img.style.display = 'none';
            }
          })(this)"
        />
      ` : ''}
      <svg class="mask-preview-minimap" viewBox="0 0 ${vm.geo.viewBoxW} ${vm.geo.viewBoxH}" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
        ${vm.geo.polyPts ? `<polygon points="${escapeHtml(vm.geo.polyPts)}" class="minimap-poly" vector-effect="non-scaling-stroke" />` : ''}
      </svg>
    `;

    const chevronSvg = '<svg class="mask-row-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="M8.59 16.59 13.17 12 8.59 7.41 10 6l6 6-6 6z"/></svg>';

    const buildEditPanel = (mask: any, vm: ReturnType<typeof buildViewModel>): string => {
      const parsed = this._parseMaskPolygonNormalized(mask);
      if (parsed.pts.length === 0) return '';
      const vw = parsed.viewBoxW;
      const vh = parsed.viewBoxH;
      const normPoly = this._formatNormalizedPolygon(parsed.pts);
      const dispPts = parsed.pts.map(p => `${p.x * vw},${p.y * vh}`).join(' ');
      const handleR = Math.max(14, Math.round(Math.max(vw, vh) * 0.012));
      const eventId = escapeHtml(mask.event_id || vm.maskId);
      const handles = parsed.pts.map((p, i) =>
        `<circle class="mask-edit-handle" data-edit-handle="${i}" cx="${p.x * vw}" cy="${p.y * vh}" r="${handleR}" />`
      ).join('');
      const minX = Math.min(...parsed.pts.map(p => p.x));
      const maxX = Math.max(...parsed.pts.map(p => p.x));
      const minY = Math.min(...parsed.pts.map(p => p.y));
      const maxY = Math.max(...parsed.pts.map(p => p.y));
      const coversText = `Covers ${Math.round((maxX - minX) * vw)} × ${Math.round((maxY - minY) * vh)} px`;
      return `
        <div class="mask-edit-panel" data-edit-panel="${escapeHtml(vm.maskId)}" data-norm-poly="${escapeHtml(normPoly)}" data-orig-poly="${escapeHtml(normPoly)}" data-viewbox-w="${vw}" data-viewbox-h="${vh}" data-label="${escapeHtml(mask.label || '')}">
          <div class="mask-edit-preview" data-edit-preview>
            ${vm.displayUrl ? `<img src="${escapeHtml(vm.displayUrl)}" alt="" loading="lazy" data-fallback-url="${escapeHtml(vm.imageFallbackUrl)}" onerror="((img) => {
              if (!img.dataset.triedFallback && img.dataset.fallbackUrl) {
                img.dataset.triedFallback = 'true';
                img.src = img.dataset.fallbackUrl;
              } else {
                img.style.display = 'none';
              }
            })(this)" />` : ''}
            <svg data-edit-svg viewBox="0 0 ${vw} ${vh}" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
              <polygon points="${escapeHtml(dispPts)}" class="mask-edit-poly" data-edit-poly vector-effect="non-scaling-stroke" />
              ${handles}
            </svg>
          </div>
          <div class="mask-edit-meta"><span data-edit-covers>${escapeHtml(coversText)}</span></div>
          <div class="mask-edit-row" role="group" aria-label="Adjust mask size">
            <button type="button" class="mask-edit-size-btn" data-action="edit-shrink" data-mask-id="${escapeHtml(vm.maskId)}">Shrink −10%</button>
            <button type="button" class="mask-edit-size-btn" data-action="edit-expand" data-mask-id="${escapeHtml(vm.maskId)}">Expand +10%</button>
            <button type="button" class="mask-edit-size-btn" data-action="edit-reset" data-mask-id="${escapeHtml(vm.maskId)}">Reset</button>
          </div>
          <div class="mask-edit-label-row">
            <span class="mask-control-label">Label</span>
            <input type="text" class="mask-edit-input" data-edit-label maxlength="64" aria-label="Mask label" />
          </div>
          <div class="mask-edit-actions">
            <button type="button" class="mask-edit-cancel" data-action="edit-cancel" data-mask-id="${escapeHtml(vm.maskId)}">Cancel</button>
            <button type="button" class="mask-edit-save" data-action="edit-save" data-mask-id="${escapeHtml(vm.maskId)}" data-camera="${escapeHtml(mask.camera || '')}" data-event-id="${eventId}">Save</button>
          </div>
        </div>
      `;
    };

    const buildActiveRow = (mask: any): string => {
      const vm = buildViewModel(mask);
      const maskId = escapeHtml(vm.maskId);
      const camera = escapeHtml(mask.camera || '');
      const poly = escapeHtml(mask.polygon || '');
      const maskLabel = escapeHtml(mask.label || '');
      const currentDurationHours = this._getCurrentMaskDurationHours(mask);
      const remaining = this._formatMaskRemainingTime(mask.expires_at, currentDurationHours);
      const remainingText = remaining === '∞' ? 'No expiry' : remaining;
      const msLeft = (currentDurationHours <= 0 || !mask.expires_at)
        ? Infinity
        : new Date(mask.expires_at).getTime() - Date.now();
      const expiring = msLeft < 3600000;
      const isExpanded = vm.maskId === expandedId;

      const selectedPreset = allPresets.find(p => Math.abs(p.hours - currentDurationHours) < 0.01);
      const selectedIsPrimary = !!selectedPreset && primaryPresets.includes(selectedPreset);
      const moreLabel = selectedIsPrimary ? 'More' : (selectedPreset ? selectedPreset.label : `${currentDurationHours}h`);

      const durationButton = (p: { hours: number; label: string }, cls: string) => `
        <button type="button" class="${cls} ${Math.abs(p.hours - currentDurationHours) < 0.01 ? 'active' : ''}" data-action="set-duration" data-mask-id="${maskId}" data-camera="${camera}" data-hours="${p.hours}" data-poly="${poly}" data-label="${maskLabel}">${p.label}</button>
      `;

      // While editing, the editor replaces the static preview and controls
      // so it becomes the main view. Cancel/Save live inside the panel.
      const editPanel = this._maskEditingId === vm.maskId ? buildEditPanel(mask, vm) : '';
      const showEditor = editPanel !== '';

      const detailBody = `
            <div class="mask-frame">${buildPreview(vm)}</div>
            ${vm.geo.maskW > 0 ? `<div class="mask-meta">Covers ${Math.round(vm.geo.maskW)} × ${Math.round(vm.geo.maskH)} px</div>` : ''}
            <div class="mask-controls">
              <div class="mask-duration" role="group" aria-label="Keep this mask for">
                <span class="mask-control-label">Keep for</span>
                <div class="mask-segmented">
                  ${primaryPresets.map(p => durationButton(p, 'mask-seg-btn')).join('')}
                  <button type="button" class="mask-seg-btn ${selectedIsPrimary ? '' : 'active'}" data-action="toggle-more" aria-expanded="false">${escapeHtml(moreLabel)}</button>
                </div>
              </div>
              <div class="mask-row-actions">
                <button type="button" class="mask-edit-btn" data-action="edit-mask" data-mask-id="${maskId}" data-camera="${camera}">${this._maskEditingId === vm.maskId ? 'Close editor' : 'Edit'}</button>
                <button type="button" class="mask-remove-btn" data-action="remove-mask" data-mask-id="${maskId}" data-camera="${camera}">Remove mask</button>
              </div>
            </div>
            <div class="mask-more" hidden>
              ${morePresets.map(p => durationButton(p, 'mask-chip')).join('')}
              <button type="button" class="mask-chip ${(!selectedPreset) ? 'active' : ''}" data-action="custom-duration" data-mask-id="${maskId}" data-camera="${camera}" data-poly="${poly}" data-label="${maskLabel}">${selectedPreset ? 'Custom…' : `Custom (${currentDurationHours}h)`}</button>
            </div>
      `;

      return `
        <div class="mask-row ${isExpanded ? 'expanded' : ''}" data-mask-id="${maskId}">
          <button type="button" class="mask-row-head" data-action="toggle-mask" data-mask-id="${maskId}" aria-expanded="${isExpanded}">
            <span class="mask-thumb">${buildPreview(vm)}</span>
            <span class="mask-row-text">
              <span class="mask-row-title" title="Mask ${maskId}" data-safe-text="${escapeHtml(vm.title)}"></span>
              <span class="mask-row-sub" data-safe-text="${escapeHtml(vm.sub)}"></span>
            </span>
            <span class="mask-row-time ${expiring ? 'expiring' : ''}" data-timer-mask-id="${maskId}"><span class="timer-text">${escapeHtml(remainingText)}</span></span>
            ${chevronSvg}
          </button>
          <div class="mask-row-detail">
            ${showEditor ? editPanel : detailBody}
          </div>
        </div>
      `;
    };

    const buildPendingRow = (mask: any): string => {
      const vm = buildViewModel(mask);
      const maskId = escapeHtml(vm.maskId);
      return `
        <div class="mask-row pending" data-mask-id="${maskId}">
          <div class="mask-row-head">
            <span class="mask-thumb">${buildPreview(vm)}</span>
            <span class="mask-row-text">
              <span class="mask-row-title" title="Mask ${maskId}" data-safe-text="${escapeHtml(vm.title)}"></span>
              <span class="mask-row-sub">Removal applies after Frigate restarts</span>
            </span>
            <button type="button" class="mask-text-btn" data-action="dismiss-pending" data-mask-id="${maskId}">Dismiss</button>
          </div>
        </div>
      `;
    };

    container.innerHTML = `
      <div class="frigate-events-modal-backdrop" data-action="close"></div>
      <div class="frigate-events-modal-content" role="dialog" aria-modal="true" aria-label="Temporary masks">
        <div class="mask-manager-header">
          <h2 class="mask-manager-title">Temporary masks</h2>
          <span class="mask-manager-count">${totalCount} active</span>
          <button class="frigate-events-modal-close" data-action="close" title="Close" aria-label="Close">
            <svg viewBox="0 0 24 24"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
          </button>
        </div>

        ${cameras.length > 1 ? `
          <div class="mask-filter-tabs" role="tablist">
            <button type="button" role="tab" aria-selected="${filterCamera === 'all'}" class="mask-filter-tab ${filterCamera === 'all' ? 'active' : ''}" data-camera-filter="all">
              All <span class="mask-filter-count">${activeMasks.length + pendingMasks.length}</span>
            </button>
            ${cameras.map(cam => {
              const count = activeMasks.filter((m: any) => m.camera === cam).length +
                            pendingMasks.filter((m: any) => m.camera === cam).length;
              return `
                <button type="button" role="tab" aria-selected="${filterCamera === cam}" class="mask-filter-tab ${filterCamera === cam ? 'active' : ''}" data-camera-filter="${escapeHtml(cam)}">
                  <span data-safe-text="${escapeHtml(this._formatCameraName(cam))}"></span> <span class="mask-filter-count">${count}</span>
                </button>
              `;
            }).join('')}
          </div>
        ` : ''}

        <div class="mask-manager-body">
          ${filteredMasks.length === 0 && filteredPending.length === 0 ? `
            <div class="mask-empty-state">
              <h4>Nothing is being ignored</h4>
              <p>Right-click an event thumbnail to ignore a recurring false detection, or use the action button on a mobile notification.</p>
            </div>
          ` : ''}

          ${filteredMasks.length > 0 ? `
            <div class="mask-list">
              ${filteredMasks.map(buildActiveRow).join('')}
            </div>
          ` : ''}

          ${filteredPending.length > 0 ? `
            <div class="mask-pending-section">
              <div class="mask-section-heading">
                <span>Waiting for Frigate restart</span>
                ${filteredPending.length > 1 ? `<button type="button" class="mask-text-btn" data-action="dismiss-all-pending">Dismiss all</button>` : ''}
              </div>
              <div class="mask-list">
                ${filteredPending.map(buildPendingRow).join('')}
              </div>
            </div>
          ` : ''}
        </div>
      </div>
    `;

    const nextBody = container.querySelector<HTMLElement>('.mask-manager-body');
    if (nextBody) nextBody.scrollTop = previousScroll;

    container.querySelectorAll<HTMLElement>('[data-safe-text]').forEach((element) => {
      element.textContent = element.getAttribute('data-safe-text') || '';
      element.removeAttribute('data-safe-text');
    });

    // Attach listeners
    const content = container.querySelector('.mask-manager-content');
    content?.addEventListener('click', (e) => e.stopPropagation());

    container.querySelectorAll('[data-action="close"]').forEach(el => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        this._removeMaskManagerModal();
      });
    });

    container.querySelectorAll('[data-action="restart-frigate"]').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        await this._executeRestartFrigate();
      });
    });

    container.querySelectorAll('[data-action="dismiss-pending"]').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const maskId = (btn as HTMLElement).getAttribute('data-mask-id');
        if (maskId) {
          await this._executeDismissPendingMask(maskId);
        }
      });
    });

    container.querySelectorAll('[data-action="dismiss-all-pending"]').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        await this._executeDismissPendingMask();
      });
    });

    container.querySelectorAll('[data-camera-filter]').forEach(tab => {
      tab.addEventListener('click', (e) => {
        e.stopPropagation();
        this._maskManagerSelectedCamera = (tab as HTMLElement).getAttribute('data-camera-filter') || 'all';
        this._renderMaskManagerContent(container);
      });
    });

    container.querySelectorAll('[data-action="toggle-mask"]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const row = (btn as HTMLElement).closest('.mask-row');
        if (!row) return;
        const willExpand = !row.classList.contains('expanded');
        container.querySelectorAll('.mask-row.expanded').forEach(r => {
          r.classList.remove('expanded');
          r.querySelector('[data-action="toggle-mask"]')?.setAttribute('aria-expanded', 'false');
        });
        if (willExpand) {
          row.classList.add('expanded');
          btn.setAttribute('aria-expanded', 'true');
          row.scrollIntoView({ block: 'nearest' });
        }
        this._maskManagerExpandedId = willExpand ? ((btn as HTMLElement).getAttribute('data-mask-id') || '') : '';
      });
    });

    container.querySelectorAll('[data-action="toggle-more"]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const more = (btn as HTMLElement).closest('.mask-row-detail')?.querySelector<HTMLElement>('.mask-more');
        if (!more) return;
        more.hidden = !more.hidden;
        btn.setAttribute('aria-expanded', String(!more.hidden));
      });
    });

    container.querySelectorAll('[data-action="set-duration"]').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const maskId = (btn as HTMLElement).getAttribute('data-mask-id');
        const camera = (btn as HTMLElement).getAttribute('data-camera') || '';
        const hours = parseFloat((btn as HTMLElement).getAttribute('data-hours') || '24');
        const polygon = (btn as HTMLElement).getAttribute('data-poly') || undefined;
        const label = (btn as HTMLElement).getAttribute('data-label') || undefined;
        if (maskId) {
          await this._executeChangeMaskDurationById(maskId, camera, hours, polygon, label);
        }
      });
    });

    container.querySelectorAll('[data-action="custom-duration"]').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const maskId = (btn as HTMLElement).getAttribute('data-mask-id');
        const camera = (btn as HTMLElement).getAttribute('data-camera') || '';
        const polygon = (btn as HTMLElement).getAttribute('data-poly') || undefined;
        const label = (btn as HTMLElement).getAttribute('data-label') || undefined;
        const input = window.prompt('Enter temporary mask duration in hours:', '24');
        if (!input) return;
        const parsed = parseFloat(input.trim());
        if (isNaN(parsed) || parsed <= 0) return;
        if (maskId) {
          await this._executeChangeMaskDurationById(maskId, camera, parsed, polygon, label);
        }
      });
    });

    container.querySelectorAll('[data-action="remove-mask"]').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const maskId = (btn as HTMLElement).getAttribute('data-mask-id');
        const camera = (btn as HTMLElement).getAttribute('data-camera') || '';
        if (maskId) {
          await this._executeRemoveMask(maskId, camera);
        }
      });
    });

    // ── Inline geometry editor ──
    const findEditPanel = (maskId: string): HTMLElement | null => {
      let found: HTMLElement | null = null;
      container.querySelectorAll('[data-edit-panel]').forEach(panel => {
        if ((panel as HTMLElement).getAttribute('data-edit-panel') === maskId) {
          found = panel as HTMLElement;
        }
      });
      return found;
    };
    const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));
    const parsePanelPoly = (panel: HTMLElement): Array<{ x: number; y: number }> => {
      const raw = panel.getAttribute('data-norm-poly') || '';
      const nums = raw.split(',').map(s => parseFloat(s.trim())).filter(n => !isNaN(n));
      const pts: Array<{ x: number; y: number }> = [];
      for (let i = 0; i + 1 < nums.length; i += 2) {
        pts.push({ x: clamp01(nums[i]), y: clamp01(nums[i + 1]) });
      }
      return pts;
    };
    const panelViewBox = (panel: HTMLElement): { w: number; h: number } => ({
      w: parseFloat(panel.getAttribute('data-viewbox-w') || '1920') || 1920,
      h: parseFloat(panel.getAttribute('data-viewbox-h') || '1080') || 1080,
    });
    const paintPanel = (panel: HTMLElement): void => {
      const pts = parsePanelPoly(panel);
      const { w, h } = panelViewBox(panel);
      const polyEl = panel.querySelector('[data-edit-poly]');
      if (polyEl) {
        polyEl.setAttribute('points', pts.map(p => `${p.x * w},${p.y * h}`).join(' '));
      }
      pts.forEach((p, i) => {
        const handle = panel.querySelector(`[data-edit-handle="${i}"]`);
        if (handle) {
          handle.setAttribute('cx', String(p.x * w));
          handle.setAttribute('cy', String(p.y * h));
        }
      });
      const covers = panel.querySelector('[data-edit-covers]');
      if (covers && pts.length > 0) {
        const xs = pts.map(p => p.x);
        const ys = pts.map(p => p.y);
        const cw = Math.round((Math.max(...xs) - Math.min(...xs)) * w);
        const ch = Math.round((Math.max(...ys) - Math.min(...ys)) * h);
        covers.textContent = `Covers ${cw} × ${ch} px`;
      }
    };
    const clientToNorm = (svg: SVGSVGElement, clientX: number, clientY: number, w: number, h: number): { x: number; y: number } | null => {
      try {
        const ctm = svg.getScreenCTM();
        if (ctm) {
          const pt = new DOMPoint(clientX, clientY).matrixTransform(ctm.inverse());
          return { x: clamp01(pt.x / w), y: clamp01(pt.y / h) };
        }
      } catch {
        // Fall through to bounding-rect approximation below.
      }
      const rect = svg.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return null;
      return { x: clamp01((clientX - rect.left) / rect.width), y: clamp01((clientY - rect.top) / rect.height) };
    };

    container.querySelectorAll('[data-action="edit-mask"]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const maskId = (btn as HTMLElement).getAttribute('data-mask-id');
        if (!maskId) return;
        this._maskEditingId = this._maskEditingId === maskId ? undefined : maskId;
        this._renderMaskManagerContent(container);
      });
    });

    container.querySelectorAll('[data-edit-panel]').forEach(panelEl => {
      const panel = panelEl as HTMLElement;
      panel.addEventListener('click', (e) => e.stopPropagation());
      panel.addEventListener('pointerdown', (e) => e.stopPropagation());
      const labelInput = panel.querySelector('[data-edit-label]') as HTMLInputElement | null;
      if (labelInput && !labelInput.value) {
        labelInput.value = panel.getAttribute('data-label') || '';
      }
      const svg = panel.querySelector('[data-edit-svg]') as SVGSVGElement | null;
      if (svg) {
        panel.querySelectorAll('[data-edit-handle]').forEach(handleEl => {
          const handle = handleEl as Element;
          const idx = parseInt((handle as HTMLElement).getAttribute('data-edit-handle') || '-1', 10);
          if (isNaN(idx) || idx < 0) return;
          handle.addEventListener('pointerdown', (ev) => {
            ev.stopPropagation();
            ev.preventDefault();
            const evt = ev as PointerEvent;
            try {
              handle.setPointerCapture(evt.pointerId);
            } catch {
              // Pointer capture unavailable; drag still works via move/up listeners.
            }
            const onMove = (me: Event): void => {
              const { w, h } = panelViewBox(panel);
              const norm = clientToNorm(svg, (me as PointerEvent).clientX, (me as PointerEvent).clientY, w, h);
              if (!norm) return;
              const pts = parsePanelPoly(panel);
              if (idx >= pts.length) return;
              pts[idx] = norm;
              panel.setAttribute('data-norm-poly', this._formatNormalizedPolygon(pts));
              paintPanel(panel);
            };
            const onUp = (): void => {
              handle.removeEventListener('pointermove', onMove);
              handle.removeEventListener('pointerup', onUp);
              handle.removeEventListener('pointercancel', onUp);
            };
            handle.addEventListener('pointermove', onMove);
            handle.addEventListener('pointerup', onUp);
            handle.addEventListener('pointercancel', onUp);
          });
        });
      }
    });

    container.querySelectorAll('[data-action="edit-expand"]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const maskId = (btn as HTMLElement).getAttribute('data-mask-id') || '';
        const panel = findEditPanel(maskId);
        if (!panel) return;
        panel.setAttribute('data-norm-poly', this._formatNormalizedPolygon(this._scaleNormalizedPolygon(parsePanelPoly(panel), 1.1)));
        paintPanel(panel);
      });
    });

    container.querySelectorAll('[data-action="edit-shrink"]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const maskId = (btn as HTMLElement).getAttribute('data-mask-id') || '';
        const panel = findEditPanel(maskId);
        if (!panel) return;
        panel.setAttribute('data-norm-poly', this._formatNormalizedPolygon(this._scaleNormalizedPolygon(parsePanelPoly(panel), 0.9)));
        paintPanel(panel);
      });
    });

    container.querySelectorAll('[data-action="edit-reset"]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const maskId = (btn as HTMLElement).getAttribute('data-mask-id') || '';
        const panel = findEditPanel(maskId);
        if (!panel) return;
        panel.setAttribute('data-norm-poly', panel.getAttribute('data-orig-poly') || '');
        paintPanel(panel);
      });
    });

    container.querySelectorAll('[data-action="edit-cancel"]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this._maskEditingId = undefined;
        this._renderMaskManagerContent(container);
      });
    });

    container.querySelectorAll('[data-action="edit-save"]').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const maskId = (btn as HTMLElement).getAttribute('data-mask-id') || '';
        const camera = (btn as HTMLElement).getAttribute('data-camera') || '';
        const eventId = (btn as HTMLElement).getAttribute('data-event-id') || maskId;
        const panel = findEditPanel(maskId);
        if (!maskId || !panel) return;
        const labelInput = panel.querySelector('[data-edit-label]') as HTMLInputElement | null;
        const newLabel = (labelInput?.value || '').trim();
        const newPolygon = panel.getAttribute('data-norm-poly') || '';
        if (!newPolygon) return;
        const activeMasks = (this._getTemporaryMaskSensor(this.hass?.states)?.attributes?.masks as any[]) || [];
        const existing = activeMasks.find((m: any) => String(m.mask_id) === String(maskId));
        const durationHours = existing ? this._getCurrentMaskDurationHours(existing) : 24;
        await this._executeEditMask(maskId, camera, eventId, newPolygon, newLabel, durationHours);
      });
    });

    container.onkeydown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && this._maskEditingId) {
        e.stopPropagation();
        this._maskEditingId = undefined;
        this._renderMaskManagerContent(container);
      }
    };
  }

  private async _executeRestartFrigate(): Promise<void> {
    if (!this.hass) return;
    try {
      if (!this.hass.callService) throw new Error('Home Assistant service calls are unavailable');
      await this.hass.callService('frigate_temp_mask', 'restart', {});
      this._localPendingMasks = [];
      this.dispatchEvent(new CustomEvent('hass-notification', {
        detail: { message: 'Frigate is restarting.' },
        bubbles: true,
        composed: true,
      }));
      this.requestUpdate();
      this._removeMaskManagerModal();
    } catch (err) {
      console.error('Failed to restart Frigate:', err);
      this.dispatchEvent(new CustomEvent('hass-notification', {
        detail: { message: 'Unable to restart Frigate. Install and configure the Frigate Temporary Mask integration.' },
        bubbles: true,
        composed: true,
      }));
    }
  }

  private async _executeDismissPendingMask(maskId?: string): Promise<void> {
    if (!this.hass) return;
    if (maskId) {
      this._localPendingMasks = this._localPendingMasks.filter(m => String(m.mask_id) !== String(maskId));
    } else {
      this._localPendingMasks = [];
    }
    try {
      if (this.hass.callService) {
        await this.hass.callService('frigate_temp_mask', 'dismiss_pending', maskId ? { mask_id: maskId } : {});
      }
      this.requestUpdate();
      if (this._maskManagerContainer) {
        this._renderMaskManagerContent(this._maskManagerContainer);
      }
    } catch (err) {
      console.error('Failed to dismiss pending mask:', err);
    }
  }

  private async _executeRemoveMask(maskId: string, camera?: string): Promise<void> {
    if (!this.hass) return;
    try {
      const sensorAttrs = this._getTemporaryMaskSensor(this.hass?.states)?.attributes;
      const activeMasks = (sensorAttrs?.masks as any[]) || [];
      const supportsDynamic = sensorAttrs?.supports_dynamic_toggle === true;
      const existing = activeMasks.find((m: any) => String(m.mask_id) === String(maskId));

      // In Frigate 0.18+, removal is instant without detector restart, so do not queue as pending restart
      if (supportsDynamic) {
        this._localPendingMasks = this._localPendingMasks.filter(m => String(m.mask_id) !== String(maskId));
      } else {
        this._localPendingMasks = [
          ...this._localPendingMasks.filter(m => String(m.mask_id) !== String(maskId)),
          existing ? { ...existing, removed_at: new Date().toISOString() } : { mask_id: maskId, camera: camera || 'Camera', removed_at: new Date().toISOString() }
        ];
      }

      if (this.hass.callService) {
        try {
          await this.hass.callService('frigate_temp_mask', 'remove_mask', {
            mask_id: maskId,
          });
        } catch {
          await this.hass.callService('shell_command', 'frigate_remove_temp_mask', {
            mask_id: maskId,
          });
        }
      }
      this._maskDurationOverrides.delete(String(maskId));

      // Post-call: re-check supports_dynamic_toggle. The backend fetches and caches
      // the Frigate version during remove_mask, so the sensor may now report true
      // even if it was false at click time. Clear the pending entry if so.
      const postAttrs = this._getTemporaryMaskSensor(this.hass?.states)?.attributes;
      if (postAttrs?.supports_dynamic_toggle === true) {
        this._localPendingMasks = this._localPendingMasks.filter(m => String(m.mask_id) !== String(maskId));
      }

      const removeDynamic = postAttrs?.supports_dynamic_toggle === true;
      this.dispatchEvent(new CustomEvent('hass-notification', {
        detail: { message: removeDynamic
          ? `Mask removed.`
          : `Mask removed. Frigate is restarting.` },
        bubbles: true,
        composed: true,
      }));
      this.requestUpdate();
      // Close the manager: on pre-0.18 Frigate the delete restarts the
      // detector, so previews would just go grey until it is back.
      this._removeMaskManagerModal();
    } catch (err) {
      console.error('Failed to remove mask:', err);
    }
  }

  private async _executePruneAllMasks(): Promise<void> {
    if (!this.hass) return;
    try {
      if (this.hass.callService) {
        try {
          await this.hass.callService('frigate_temp_mask', 'prune_all', {});
        } catch {
          await this.hass.callService('shell_command', 'frigate_prune_all_temp_masks', {});
        }
      }
      const pruneDynamic = this._getTemporaryMaskSensor(this.hass?.states)?.attributes?.supports_dynamic_toggle === true;
      this.dispatchEvent(new CustomEvent('hass-notification', {
        detail: { message: pruneDynamic
          ? 'All masks removed.'
          : 'All masks removed. Frigate is restarting.' },
        bubbles: true,
        composed: true,
      }));
      this.requestUpdate();
      if (this._maskManagerContainer) {
        setTimeout(() => {
          if (this._maskManagerContainer) this._renderMaskManagerContent(this._maskManagerContainer);
        }, 300);
      }
    } catch (err) {
      console.error('Failed to prune all masks:', err);
    }
  }

  private async _executeChangeMaskDurationById(
    maskId: string,
    camera: string,
    durationHours: number,
    polygon?: string,
    label?: string
  ): Promise<void> {
    if (!this.hass) return;
    try {
      if (!this.hass.callService) throw new Error('Home Assistant service calls are unavailable');
      await this.hass.callService('frigate_temp_mask', 'set_duration', {
        mask_id: maskId,
        duration_hours: durationHours,
      });
      this._maskDurationOverrides.set(String(maskId), durationHours <= 0 ? -1 : durationHours);
      const durationText = this._formatMaskDurationChoice(durationHours);

      this.dispatchEvent(new CustomEvent('hass-notification', {
        detail: { message: `Mask duration: ${durationText}.` },
        bubbles: true,
        composed: true,
      }));
      this.requestUpdate();
      if (this._maskManagerContainer) {
        setTimeout(() => {
          if (this._maskManagerContainer) this._renderMaskManagerContent(this._maskManagerContainer);
        }, 300);
      }
    } catch (err) {
      console.error('Failed to update mask duration:', err);
    }
  }

  private async _executeEditMask(
    maskId: string,
    camera: string,
    eventId: string,
    newPolygon: string,
    newLabel: string,
    durationHours: number
  ): Promise<void> {
    if (!this.hass) return;
    const key = String(maskId);
    if (this._maskEditSavingIds.has(key)) return;
    this._maskEditSavingIds.add(key);
    const findSaveBtn = (): HTMLButtonElement | null => {
      let found: HTMLButtonElement | null = null;
      this._maskManagerContainer?.querySelectorAll('[data-action="edit-save"]').forEach(btn => {
        if ((btn as HTMLElement).getAttribute('data-mask-id') === key) {
          found = btn as HTMLButtonElement;
        }
      });
      return found;
    };
    const saveBtn = findSaveBtn();
    if (saveBtn) saveBtn.disabled = true;
    try {
      if (!this.hass.callService) throw new Error('Home Assistant service calls are unavailable');
      const payload = {
        camera,
        event_id: eventId || key,
        mask_id: key,
        polygon: newPolygon,
        label: newLabel,
        duration_hours: durationHours,
      };
      try {
        await this.hass.callService('frigate_temp_mask', 'add_mask', payload);
      } catch {
        await this.hass.callService('shell_command', 'frigate_add_temp_mask', payload);
      }
      this._maskEditingId = undefined;
      const sensorAttrs = this._getTemporaryMaskSensor(this.hass?.states)?.attributes;
      const needsRestart = sensorAttrs?.supports_dynamic_toggle !== true;
      this.dispatchEvent(new CustomEvent('hass-notification', {
        detail: { message: needsRestart
          ? 'Mask updated. Frigate is restarting.'
          : 'Mask updated.' },
        bubbles: true,
        composed: true,
      }));
      this.requestUpdate();
      this._removeMaskManagerModal();
    } catch (err) {
      console.error('Failed to edit mask:', err);
      const btn = findSaveBtn();
      if (btn) btn.disabled = false;
      this.dispatchEvent(new CustomEvent('hass-notification', {
        detail: { message: 'Could not update the mask.' },
        bubbles: true,
        composed: true,
      }));
      return;
    } finally {
      this._maskEditSavingIds.delete(key);
    }
  }

  private _getCurrentMaskDurationHours(mask: any): number {
    const maskId = String(mask.mask_id ?? '');
    const stateDuration = typeof mask.duration_hours === 'number' ? mask.duration_hours : 24;
    const override = this._maskDurationOverrides.get(maskId);
    if (override === undefined) return stateDuration;
    if (stateDuration === override) {
      this._maskDurationOverrides.delete(maskId);
      return stateDuration;
    }
    return override;
  }

  /* ─────────────────────────────────────────────────────────────
     Continuous Footage Timeline Scrubber & Player Modal (Frigate 0.13)
     ───────────────────────────────────────────────────────────── */

  private _getEventSeekOffset(event?: FrigateEvent): number {
    const raw = this._config?.timeline_event_seek_offset;
    if (raw === undefined || raw === null) return 0;
    if (typeof raw === 'number') return raw;
    if (typeof raw === 'string' && !isNaN(Number(raw))) return Number(raw);
    if (typeof raw === 'object' && event) {
      const val = this._getConfigValueForEvent(raw as Record<string, number>, event, 0);
      return typeof val === 'number' ? val : (Number(val) || 0);
    }
    return 0;
  }

  private _getTimelineLayoutMode(): 'desktop' | 'compact' | 'tv' {
    try {
      const w = (typeof window !== 'undefined' ? window : undefined) as any;
      if (!w) return 'desktop';
      const nav = w.navigator as Navigator | undefined;
      const ua = String((nav as any)?.userAgent || w.navigator?.userAgent || '');
      const platform = String((nav as any)?.platform || '');
      const maxTouchPoints = Number((nav as any)?.maxTouchPoints || 0);
      const matchMediaFn = typeof w.matchMedia === 'function' ? w.matchMedia.bind(w) : undefined;

      // TV user agents / environments win first.
      if (/TV|AndroidTV|BRAVIA|AFT|webOS|Tizen|CrKey|Leanback|tvbro/i.test(ua)) return 'tv';

      // No-hover + no-pointer environment on a large screen is treated as TV
      // (e.g. a set-top box or TV browser without touch).
      try {
        const noHover = matchMediaFn ? matchMediaFn('(hover: none)').matches : false;
        const coarse = matchMediaFn ? matchMediaFn('(pointer: coarse)').matches : false;
        const fine = matchMediaFn ? matchMediaFn('(pointer: fine)').matches : false;
        const wide = matchMediaFn
          ? matchMediaFn('(min-width: 821px)').matches
          : (typeof w.innerWidth === 'number' ? w.innerWidth > 820 : false);
        if (noHover && !coarse && !fine && wide) return 'tv';
      } catch (_) {}

      // iPhone / iPad / iPod, including iPadOS masquerading as Mac (fast paths).
      if (/iPhone|iPad|iPod/i.test(ua)) return 'compact';
      if (platform === 'MacIntel' && maxTouchPoints > 1) return 'compact';
      // Android phones and tablets (Android TV was already handled above).
      if (/Android/i.test(ua)) return 'compact';

      // Touch is authoritative: any device that reports a touch digitizer or a
      // coarse pointer anywhere gets the mobile layout. Tablets report hover/fine
      // as soon as a trackpad or mouse is attached (iPad + Magic Keyboard), so
      // hover/pointer type must not be allowed to demote them back to desktop.
      try {
        const touchPoints = Number((nav as any)?.maxTouchPoints || 0);
        const touch = touchPoints > 0
          || (typeof w !== 'undefined' && 'ontouchstart' in w)
          || (typeof w !== 'undefined' && 'onmsgesturechange' in w);
        const anyCoarse = matchMediaFn ? matchMediaFn('(any-pointer: coarse)').matches : false;
        if (touch || anyCoarse) return 'compact';
      } catch (_) {}

      try {
        if (matchMediaFn) {
          const coarsePointer = matchMediaFn('(pointer: coarse)').matches;
          const noHover = matchMediaFn('(hover: none)').matches;
          if (coarsePointer && noHover) return 'compact';
          if (matchMediaFn('(max-width: 820px)').matches) return 'compact';
        }
      } catch (_) {}
      if (typeof w.innerWidth === 'number' && w.innerWidth <= 820) return 'compact';
    } catch (_) {
      return 'desktop';
    }
    return 'desktop';
  }

  private _timelineCameraTabsMarkup(availableCameras: string[], currentCamera: string): string {
    if (availableCameras.length <= 1) return '';
    return `
      <div class="timeline-camera-tabs">
        ${availableCameras.map(cam => `
          <button class="timeline-camera-tab ${cam === currentCamera ? 'active' : ''}" data-camera="${escapeHtml(cam)}">
            <span data-safe-text="${escapeHtml(this._formatCameraName(cam))}"></span>
          </button>
        `).join('')}
      </div>
    `;
  }

  private _timelineControlsMarkup(dtValue: string, windowMinutes: number, withHeadings = false): string {
    const timeGroup = `
      <div class="timeline-datetime-group">
        <span class="timeline-datetime-label">Start time</span>
        <input type="datetime-local" class="timeline-datetime-input" value="${dtValue}" />
        <div class="timeline-quick-jumps">
          <button class="timeline-quick-btn" data-jump="now">Now</button>
          <button class="timeline-quick-btn" data-jump="-15m">-15m</button>
          <button class="timeline-quick-btn" data-jump="-1h">-1h</button>
          <button class="timeline-quick-btn" data-jump="-3h">-3h</button>
          <button class="timeline-quick-btn" data-jump="-12h">-12h</button>
          <button class="timeline-quick-btn" data-jump="day-start">Start of day</button>
        </div>
      </div>
    `;
    const windowGroup = `
      <div class="timeline-window-group">
        <span class="timeline-datetime-label">Window</span>
        <div class="timeline-window-pills">
          <button class="timeline-window-pill ${windowMinutes === 15 ? 'active' : ''}" data-window="15">15m</button>
          <button class="timeline-window-pill ${windowMinutes === 30 ? 'active' : ''}" data-window="30">30m</button>
          <button class="timeline-window-pill ${windowMinutes === 60 ? 'active' : ''}" data-window="60">1h</button>
          <button class="timeline-window-pill ${windowMinutes === 180 ? 'active' : ''}" data-window="180">3h</button>
          <button class="timeline-window-pill ${windowMinutes === 1440 ? 'active' : ''}" data-window="1440">24h</button>
        </div>
      </div>
    `;
    if (!withHeadings) {
      return `
      <div class="timeline-controls-bar">
        ${timeGroup}

        ${windowGroup}
      </div>
    `;
    }
    return `
      <div class="timeline-controls-bar">
        <div class="timeline-sheet-section">
          <div class="timeline-sheet-heading">Time</div>
          ${timeGroup}
        </div>

        <div class="timeline-sheet-section">
          <div class="timeline-sheet-heading">Window</div>
          ${windowGroup}
        </div>
      </div>
    `;
  }

  private _timelinePlayerMarkup(): string {
    // Honour an explicit opt-out of mute controls anywhere in the config:
    // timeline_show_mute (timeline-specific) or show_mute / live_view_show_mute
    // (the card-wide mute toggles). An explicit timeline value wins.
    const raw = this._userConfig;
    const cardMute = raw?.show_mute ?? raw?.live_view_show_mute;
    const showMuteBtn = raw?.timeline_show_mute !== undefined
      ? raw.timeline_show_mute !== false
      : cardMute !== false;
    const mutePosition = this._config?.live_view_mute_position === 'top-left' ? 'top-left' : 'top-right';
    return `
      <div class="timeline-player-container">
        <video class="timeline-video timeline-video-a active" playsinline webkit-playsinline></video>
        <video class="timeline-video timeline-video-b standby" playsinline webkit-playsinline></video>
        <div class="timeline-player-loading">
          <div class="timeline-spinner"></div>
          <span>Buffering continuous footage...</span>
        </div>
        ${showMuteBtn ? `
          <button
            class="timeline-mute-btn ${mutePosition}"
            data-action="toggle-timeline-mute"
            title="${this._isTimelineMuted ? 'Unmute' : 'Mute'}"
            aria-label="${this._isTimelineMuted ? 'Unmute' : 'Mute'}"
          >
            ${this._isTimelineMuted
              ? `<svg viewBox="0 0 24 24"><path d="M3,9H7L12,4V20L7,15H3V9M16.59,12L14,9.41L15.41,8L18,10.59L20.59,8L22,9.41L19.41,12L22,14.59L20.59,16L18,13.41L15.41,16L14,14.59L16.59,12Z"/></svg>`
              : `<svg viewBox="0 0 24 24"><path d="M14,3.23V5.29C16.89,6.15 19,8.83 19,12C19,15.17 16.89,17.84 14,18.7V20.77C18,19.86 21,16.28 21,12C21,7.72 18,4.14 14,3.23M16.5,12C16.5,10.23 15.5,8.71 14,7.97V16.01C15.5,15.29 16.5,13.77 16.5,12M3,9V15H7L12,20V4L7,9H3Z"/></svg>`
            }
          </button>
        ` : ''}
      </div>
    `;
  }

  private _timelineScrubberMarkup(startDate: Date, endDate: Date, enhancedA11y = false): string {
    const a11y = enhancedA11y
      ? ` tabindex="0" role="slider" aria-label="Timeline scrubber" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"`
      : '';
    return `
      <div class="timeline-scrubber-wrapper">
        <div class="timeline-track-container"${a11y}>
          <div class="timeline-events-layer"></div>
          <div class="timeline-playhead"></div>
        </div>
        <div class="timeline-track-labels">
          <span>${startDate.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}</span>
          <span class="timeline-time-badge" data-timeline-current-time>--:--:--</span>
          <span>${endDate.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}</span>
        </div>
      </div>
    `;
  }

  private _timelineTransportMarkup(trimmed = false): string {
    const skips = trimmed
      ? `
          <button class="timeline-transport-btn" data-skip="-60" title="Back 1 minute">-1m</button>
          <button class="timeline-transport-btn" data-skip="-30" title="Back 30 seconds">-30s</button>
      `
      : `
          <button class="timeline-transport-btn" data-skip="-300" title="Back 5 minutes">-5m</button>
          <button class="timeline-transport-btn" data-skip="-60" title="Back 1 minute">-1m</button>
          <button class="timeline-transport-btn" data-skip="-30" title="Back 30 seconds">-30s</button>
      `;
    const skipsAfter = trimmed
      ? `
          <button class="timeline-transport-btn" data-skip="30" title="Forward 30 seconds">+30s</button>
          <button class="timeline-transport-btn" data-skip="60" title="Forward 1 minute">+1m</button>
      `
      : `
          <button class="timeline-transport-btn" data-skip="30" title="Forward 30 seconds">+30s</button>
          <button class="timeline-transport-btn" data-skip="60" title="Forward 1 minute">+1m</button>
          <button class="timeline-transport-btn" data-skip="300" title="Forward 5 minutes">+5m</button>
      `;
    return `
      <div class="timeline-transport-bar">
        <div class="timeline-transport-controls">
          ${skips}
          <button class="timeline-transport-btn play-btn" data-action="toggle-play" title="Play / Pause">
            <svg viewBox="0 0 24 24"><path d="M8,5.14V19.14L19,12.14L8,5.14Z"/></svg>
          </button>
          ${skipsAfter}
        </div>

        <div class="timeline-speed-controls">
          <button class="timeline-stepper-btn" data-action="speed-down" title="Decrease speed (min 0.5x)">−</button>
          <span class="timeline-speed-display" data-timeline-speed-display title="Click to reset to 1x">${this._timelinePlaybackRate}x</span>
          <button class="timeline-stepper-btn" data-action="speed-up" title="Increase speed (max 4096x)">+</button>
        </div>
      </div>
    `;
  }

  private async _showTimelineModal(initialCamera?: string, initialTimestamp?: number, initialEvent?: FrigateEvent): Promise<void> {
    this._closeContextMenu();
    this._injectModalStyles();

    // Determine initial camera
    const availableCameras = this._getAvailableCameras();
    const camera = initialCamera || this._timelineCamera || (availableCameras.length > 0 ? availableCameras[0] : (this._config?.camera || ''));
    this._timelineCamera = camera;

    // Determine initial time window. Opening straight from an event on a phone
    // or tablet defaults to 15 minutes so the event fills the scrubber; the
    // desktop/TV default stays as configured. A window the user picked by hand
    // is always kept.
    const layoutMode = this._getTimelineLayoutMode();
    const openedFromEvent = Boolean(initialEvent || (initialTimestamp && initialTimestamp > 0));
    const configuredDuration = this._timelineWindowDurationSec
      || ((this._config?.timeline_default_window_hours || 1) * 3600);
    const duration = (layoutMode === 'compact' && openedFromEvent && !this._timelineWindowUserChosen)
      ? 15 * 60
      : configuredDuration;
    this._timelineWindowDurationSec = duration;

    let seekOffset = this._getEventSeekOffset(initialEvent);

    const baseEventTs = (initialEvent && initialEvent.start_time)
      ? initialEvent.start_time
      : (initialTimestamp && initialTimestamp > 0 ? initialTimestamp : (Date.now() / 1000));
    const baseTargetTs = baseEventTs;
    let targetSeekTs = initialTimestamp && initialTimestamp > 0 ? (baseTargetTs + seekOffset) : baseTargetTs;

    // Center the event in window or place it near the end
    const now = Math.floor(Date.now() / 1000);
    if (initialTimestamp && initialTimestamp > 0) {
      let start = Math.floor(baseTargetTs - duration / 2);
      if (start + duration > now) {
        start = Math.max(0, now - duration);
      }
      this._timelineStartTs = Math.max(0, start);
      this._timelineEndTs = Math.floor(this._timelineStartTs + duration);
    } else {
      this._timelineEndTs = Math.floor(baseTargetTs);
      this._timelineStartTs = Math.max(0, Math.floor(this._timelineEndTs - duration));
    }

    if (this._timelineContainer) {
      this._updateTimelineWindowUI();
      await this._fetchTimelineEvents();
      if (!initialEvent && initialTimestamp && initialTimestamp > 0) {
        const matched = this._timelineEvents.find(e => Math.abs((e.start_time || 0) - initialTimestamp) < 2);
        if (matched) {
          seekOffset = this._getEventSeekOffset(matched);
          const base = matched.start_time || initialTimestamp;
          targetSeekTs = base + seekOffset;
        }
      }
      this._updateTimelineScrubberEvents();
      this._loadTimelineVideo(targetSeekTs);
      return;
    }

    const container = document.createElement('div');
    // TV renders the same compact card as iPad/phone now; `timelineLayout`
    // still marks the device for focus handling.
    container.className = 'frigate-events-modal frigate-timeline-modal'
      + (layoutMode === 'desktop' ? '' : ' is-compact');
    container.dataset.timelineLayout = layoutMode;
    this._timelineContainer = container;
    this._isTimelineMuted = this._config?.muted !== false;

    this._renderTimelineContent(container);

    container.addEventListener('click', (e) => {
      if (e.target === container) {
        this._removeTimelineModal();
      }
    });

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        const c = this._timelineContainer;
        if (c && c.classList.contains('settings-open')) {
          c.classList.remove('settings-open');
          const settingsBtn = c.querySelector('[data-action="toggle-settings"]') as HTMLElement | null;
          settingsBtn?.setAttribute('aria-expanded', 'false');
          e.stopPropagation();
          return;
        }
        this._removeTimelineModal();
        window.removeEventListener('keydown', onKeyDown);
      } else if (e.code === 'Space' || e.key === ' ') {
        const target = e.target as HTMLElement | null;
        if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
          return;
        }
        e.preventDefault();
        this._toggleTimelinePlayPause();
      }
    };
    window.addEventListener('keydown', onKeyDown);

    document.body.appendChild(container);
    if (layoutMode === 'tv') {
      // On-stage transport is hidden by the compact layout, so anchor the
      // D-pad on the scrubber (arrows seek, Enter/Space toggles playback).
      const track = container.querySelector('.timeline-track-container[role="slider"]') as HTMLElement | null;
      track?.focus({ preventScroll: true });
    }

    // Initial fetch of events & video load
    await this._fetchTimelineEvents();
    if (!initialEvent && initialTimestamp && initialTimestamp > 0) {
      const matched = this._timelineEvents.find(e => Math.abs((e.start_time || 0) - initialTimestamp) < 2);
      if (matched) {
        seekOffset = this._getEventSeekOffset(matched);
        const base = matched.start_time || initialTimestamp;
        targetSeekTs = base + seekOffset;
      }
    }
    this._updateTimelineScrubberEvents();
    this._loadTimelineVideo(targetSeekTs);
  }

  private _clearTimelineSpeedInterval(): void {
    if (this._timelineSpeedInterval) {
      clearInterval(this._timelineSpeedInterval);
      this._timelineSpeedInterval = undefined;
    }
  }

  private _toggleTimelineMute(): void {
    this._isTimelineMuted = !this._isTimelineMuted;
    if (this._timelinePlaybackRate <= 16) {
      if (this._timelineVideoA) this._timelineVideoA.muted = this._isTimelineMuted;
      if (this._timelineVideoB) this._timelineVideoB.muted = this._isTimelineMuted;
    }
    const muteBtn = this._timelineContainer?.querySelector('[data-action="toggle-timeline-mute"]');
    if (muteBtn) {
      muteBtn.setAttribute('title', this._isTimelineMuted ? 'Unmute' : 'Mute');
      muteBtn.setAttribute('aria-label', this._isTimelineMuted ? 'Unmute' : 'Mute');
      muteBtn.innerHTML = this._isTimelineMuted
        ? `<svg viewBox="0 0 24 24"><path d="M3,9H7L12,4V20L7,15H3V9M16.59,12L14,9.41L15.41,8L18,10.59L20.59,8L22,9.41L19.41,12L22,14.59L20.59,16L18,13.41L15.41,16L14,14.59L16.59,12Z"/></svg>`
        : `<svg viewBox="0 0 24 24"><path d="M14,3.23V5.29C16.89,6.15 19,8.83 19,12C19,15.17 16.89,17.84 14,18.7V20.77C18,19.86 21,16.28 21,12C21,7.72 18,4.14 14,3.23M16.5,12C16.5,10.23 15.5,8.71 14,7.97V16.01C15.5,15.29 16.5,13.77 16.5,12M3,9V15H7L12,20V4L7,9H3Z"/></svg>`;
    }
  }

  private _toggleTimelinePlayPause(): void {
    if (!this._timelineVideoEl || this._isAdvancingTimeline) return;
    const v = this._timelineVideoEl;
    const duration = this._timelineEndTs - this._timelineStartTs;
    const maxSeek = (Number.isFinite(v.duration) && v.duration > 0)
      ? Math.max(0, v.duration - 0.5)
      : duration;

    // If play is triggered while sitting at the end of the loaded VOD chunk,
    // page to the next chunk (or next window) instead of doing nothing.
    if (v.currentTime >= maxSeek && v.paused) {
      this._advanceToNextTimelineWindow();
      return;
    }

    if (this._timelinePlaybackRate > 16) {
      if (this._timelineSpeedInterval) {
        this._clearTimelineSpeedInterval();
      } else {
        this._applyTimelinePlaybackRate(this._timelinePlaybackRate);
      }
    } else {
      if (v.paused) {
        v.play().catch(() => {});
      } else {
        v.pause();
      }
    }
    this._updateTimelinePlayheadUI();
  }

  private async _advanceToNextTimelineWindow(): Promise<void> {
    if (this._isAdvancingTimeline || !this._timelineContainer || !this._timelineCamera) return;

    const now = Math.floor(Date.now() / 1000);
    this._isAdvancingTimeline = true;
    this._clearTimelineSpeedInterval();

    if (this._timelineAdvanceTimeout) {
      clearTimeout(this._timelineAdvanceTimeout);
    }
    // Safety watchdog: clear advancing flag if loading hangs or fails after 8 seconds
    this._timelineAdvanceTimeout = window.setTimeout(() => {
      if (this._isAdvancingTimeline) {
        console.warn('Frigate Events Card: Timeline advance watchdog timed out');
        this._isAdvancingTimeline = false;
      }
    }, 8000);

    const clearAdvance = () => {
      this._isAdvancingTimeline = false;
      if (this._timelineAdvanceTimeout) {
        clearTimeout(this._timelineAdvanceTimeout);
        this._timelineAdvanceTimeout = undefined;
      }
    };
    const stopAdvance = () => {
      clearAdvance();
      if (this._timelineVideoEl) {
        this._timelineVideoEl.pause();
      }
      this._updateTimelinePlayheadUI();
    };

    try {
      // Page within the visible window first. Long windows (e.g. 24h) are split
      // into VOD chunks, so there may be more footage without moving the window.
      if (this._timelineVodEndTs > 0 && this._timelineVodEndTs < this._timelineEndTs) {
        const nextRec = this._timelineRecordings.find(
          rec => rec.end_time > this._timelineVodEndTs + 0.5 && rec.start_time >= this._timelineVodEndTs - 0.5
        );
        if (nextRec) {
          this._loadTimelineVideo(Math.max(this._timelineVodStartTs, nextRec.start_time), true);
          return;
        }
      }

      // No more footage in this window; stop once we reach real-time.
      if (this._timelineEndTs >= now) {
        stopAdvance();
        return;
      }

      const windowDuration = this._timelineWindowDurationSec || (this._timelineEndTs - this._timelineStartTs) || 3600;
      const nextStart = this._timelineEndTs;
      const nextEnd = Math.min(now, nextStart + windowDuration);

      // Stop if less than 5 seconds remaining up to real-time now
      if (nextEnd - nextStart < 5) {
        stopAdvance();
        return;
      }

      this._timelineStartTs = nextStart;
      this._timelineEndTs = nextEnd;
      this._timelineVodStartTs = 0;
      this._timelineVodEndTs = 0;
      const requestId = ++this._timelineWindowRequestId;

      const container = this._timelineContainer;
      if (!container) {
        clearAdvance();
        return;
      }

      this._updateTimelineWindowUI();
      // Fetch recordings for the new window before loading, since the VOD chunk
      // is chosen from the available footage (and gaps are skipped).
      await this._fetchTimelineEvents();
      if (requestId !== this._timelineWindowRequestId ||
          this._timelineStartTs !== nextStart || this._timelineEndTs !== nextEnd) {
        clearAdvance();
        return;
      }
      this._updateTimelineScrubberEvents();

      // If this window had a recording gap (0 recordings), look ahead and leap to next available footage
      if (this._timelineRecordings.length === 0 && this.hass && this._timelineCamera) {
        try {
          const clientId = this._config?.frigate_client_id || 'frigate';
          const futureRecs = await getRecordings(this.hass, clientId, this._timelineCamera, nextEnd, now);
          if (requestId !== this._timelineWindowRequestId ||
              this._timelineStartTs !== nextStart || this._timelineEndTs !== nextEnd) {
            clearAdvance();
            return;
          }
          if (Array.isArray(futureRecs) && futureRecs.length > 0) {
            futureRecs.sort((a, b) => a.start_time - b.start_time);
            const nextRecStart = futureRecs[0].start_time;
            this._timelineStartTs = nextRecStart;
            this._timelineEndTs = Math.min(now, Math.floor(nextRecStart + windowDuration));
            this._updateTimelineWindowUI();
            await this._fetchTimelineEvents();
            if (requestId !== this._timelineWindowRequestId ||
                this._timelineStartTs !== nextRecStart) {
              clearAdvance();
              return;
            }
            this._updateTimelineScrubberEvents();
          } else {
            // Nothing to play; stop gracefully instead of showing an error.
            stopAdvance();
            return;
          }
        } catch (e) {
          console.debug('Failed to check recordings ahead:', e);
        }
      }

      // Start at the first recording in the new window, skipping any leading gap.
      let loadSeek = this._timelineStartTs;
      if (this._timelineRecordings.length > 0) {
        const first = this._timelineRecordings.find(rec => rec.end_time > this._timelineStartTs);
        loadSeek = first
          ? Math.max(this._timelineStartTs, first.start_time)
          : this._timelineRecordings[this._timelineRecordings.length - 1].start_time;
      }
      this._loadTimelineVideo(loadSeek, true);
    } catch (err) {
      console.warn('Failed to auto-advance timeline window:', err);
      clearAdvance();
    }
  }

  private _syncTimelineSpeedStepperUI(container?: HTMLElement): void {
    const root = container || this._timelineContainer;
    if (!root) return;
    const currentIndex = TIMELINE_PLAYBACK_SPEEDS.indexOf(this._timelinePlaybackRate);
    const speedDisplays = root.querySelectorAll('[data-timeline-speed-display]');
    speedDisplays.forEach(speedDisplay => {
      (speedDisplay as HTMLElement).textContent = `${this._timelinePlaybackRate}x`;
    });
    const downBtns = root.querySelectorAll('[data-action="speed-down"]');
    downBtns.forEach(downBtn => {
      (downBtn as HTMLButtonElement).disabled = currentIndex <= 0;
    });
    const upBtns = root.querySelectorAll('[data-action="speed-up"]');
    upBtns.forEach(upBtn => {
      (upBtn as HTMLButtonElement).disabled = currentIndex >= TIMELINE_PLAYBACK_SPEEDS.length - 1;
    });
  }

  private _applyTimelinePlaybackRate(rate: number): void {
    this._timelinePlaybackRate = rate;
    this._syncTimelineSpeedStepperUI();
    const video = this._timelineVideoEl;
    if (!video) return;

    if (rate <= 16) {
      this._clearTimelineSpeedInterval();
      video.playbackRate = rate;
      video.muted = this._isTimelineMuted;
      if (video.paused) {
        video.play().catch(() => {});
      }
    } else {
      // Speeds > 16x: Browser playbackRate limit workaround via stepping interval
      video.playbackRate = 1;
      video.muted = true;
      video.pause();
      this._clearTimelineSpeedInterval();

      // Step every 100ms
      const stepDelta = (rate * 100) / 1000;
      this._timelineSpeedInterval = window.setInterval(() => {
        if (!this._timelineVideoEl) {
          this._clearTimelineSpeedInterval();
          return;
        }
        const v = this._timelineVideoEl;
        const duration = this._timelineEndTs - this._timelineStartTs;
        const maxSeek = (Number.isFinite(v.duration) && v.duration > 0)
          ? Math.max(0, v.duration - 0.5)
          : duration;
        if (v.currentTime >= maxSeek) {
          this._clearTimelineSpeedInterval();
          this._updateTimelinePlayheadUI();
          this._advanceToNextTimelineWindow();
          return;
        }
        v.currentTime = Math.min(maxSeek, v.currentTime + stepDelta);
        this._updateTimelinePlayheadUI();
      }, 100);
    }
    this._updateTimelinePlayheadUI();
  }

  private _removeTimelineModal(): void {
    this._isAdvancingTimeline = false;
    this._clearTimelineSpeedInterval();
    if (this._timelineLoadingTimeout) {
      clearTimeout(this._timelineLoadingTimeout);
      this._timelineLoadingTimeout = undefined;
    }
    if (this._timelineAdvanceTimeout) {
      clearTimeout(this._timelineAdvanceTimeout);
      this._timelineAdvanceTimeout = undefined;
    }
    if (this._timelineSlotTransitionTimeout) {
      clearTimeout(this._timelineSlotTransitionTimeout);
      this._timelineSlotTransitionTimeout = undefined;
    }
    if (this._timelineTimeUpdateRaf) {
      cancelAnimationFrame(this._timelineTimeUpdateRaf);
      this._timelineTimeUpdateRaf = undefined;
    }
    if (this._timelineHlsA) {
      this._timelineHlsA.destroy();
      this._timelineHlsA = null;
    }
    if (this._timelineHlsB) {
      this._timelineHlsB.destroy();
      this._timelineHlsB = null;
    }
    if (this._timelineVideoA) {
      try {
        this._timelineVideoA.pause();
        this._timelineVideoA.removeAttribute('src');
        this._timelineVideoA.load();
      } catch (_) {}
      this._timelineVideoA = null;
    }
    if (this._timelineVideoB) {
      try {
        this._timelineVideoB.pause();
        this._timelineVideoB.removeAttribute('src');
        this._timelineVideoB.load();
      } catch (_) {}
      this._timelineVideoB = null;
    }
    if (this._timelineContainer && this._timelineContainer.parentNode) {
      this._timelineContainer.parentNode.removeChild(this._timelineContainer);
      this._timelineContainer = undefined;
    }
  }

  private _getAvailableCameras(): string[] {
    const cams = new Set<string>();
    if (this._config?.camera) cams.add(this._config.camera);
    if (Array.isArray(this._config?.cameras)) {
      this._config.cameras.forEach(c => cams.add(c));
    }
    if (Array.isArray(this._events)) {
      this._events.forEach(e => {
        if (e.camera) cams.add(e.camera);
      });
    }
    return Array.from(cams);
  }

  private async _fetchTimelineEvents(): Promise<void> {
    if (!this.hass || !this._timelineCamera) return;
    const camera = this._timelineCamera;
    const startTs = this._timelineStartTs;
    const endTs = this._timelineEndTs;
    try {
      const clientId = this._config?.frigate_client_id || 'frigate';
      const [events, recordings] = await Promise.all([
        getEvents(this.hass, {
          instance_id: clientId,
          cameras: [camera],
          after: startTs,
          before: endTs,
          limit: 500,
        }),
        getRecordings(this.hass, clientId, camera, startTs, endTs).catch(() => []),
      ]);
      if (camera !== this._timelineCamera || startTs !== this._timelineStartTs || endTs !== this._timelineEndTs) return;
      this._timelineEvents = Array.isArray(events) ? events : [];
      this._timelineRecordings = Array.isArray(recordings) ? recordings.sort((a, b) => a.start_time - b.start_time) : [];
    } catch (e) {
      if (camera !== this._timelineCamera || startTs !== this._timelineStartTs || endTs !== this._timelineEndTs) return;
      console.warn('Failed to fetch events for timeline window:', e);
      this._timelineEvents = [];
      this._timelineRecordings = [];
    }
  }

  /**
   * Resolve the chunk of recordings the video element should load for the
   * visible timeline window. Frigate's nginx-vod module rejects playlists with
   * more than 1080 clips, so long windows (e.g. 24h) must be paged in chunks.
   *
   * Returns the VOD chunk bounds and the closest wall-clock seek position that
   * actually has footage, skipping gaps such as overnight periods.
   */
  private _resolveTimelineVodWindow(seekTargetTs?: number, isAutoAdvance = false): { startTs: number; endTs: number; seekTs: number } {
    const windowStart = this._timelineStartTs;
    const windowEnd = this._timelineEndTs;
    const recordings = this._timelineRecordings.filter(
      rec => rec.end_time > windowStart && rec.start_time < windowEnd
    );

    if (!recordings.length) {
      return {
        startTs: windowStart,
        endTs: windowEnd,
        seekTs: seekTargetTs ?? windowStart,
      };
    }

    const requestedSeek = Math.max(windowStart, Math.min(windowEnd, seekTargetTs ?? windowStart));

    // Find the recording covering the requested time, the next one after a
    // gap, or the last one when the requested time is past all recordings.
    let targetIdx = recordings.findIndex(rec => rec.end_time > requestedSeek);
    let seekTs = requestedSeek;
    if (targetIdx === -1) {
      targetIdx = recordings.length - 1;
      seekTs = recordings[targetIdx].start_time;
    } else if (requestedSeek < recordings[targetIdx].start_time) {
      seekTs = recordings[targetIdx].start_time;
    }

    // Include some footage before the target so small backwards scrubs do not
    // immediately trigger another chunk load. Auto-advance must not backtrack,
    // otherwise it would replay the tail of the previous chunk.
    const backtrack = isAutoAdvance ? 0 : Math.floor(TIMELINE_VOD_MAX_CLIPS / 4);
    const startIdx = Math.max(0, targetIdx - backtrack);
    const endIdx = Math.min(recordings.length, startIdx + TIMELINE_VOD_MAX_CLIPS);
    const chunk = recordings.slice(startIdx, endIdx);

    const startTs = Math.max(windowStart, Math.floor(chunk[0].start_time));
    const endTs = Math.min(windowEnd, Math.ceil(chunk[chunk.length - 1].end_time));

    return {
      startTs,
      endTs,
      seekTs: Math.max(startTs, Math.min(endTs, seekTs)),
    };
  }

  private _wallClockToVideoOffset(targetTs: number): number {
    const vodStart = this._timelineVodStartTs || this._timelineStartTs;
    const vodEnd = this._timelineVodEndTs || this._timelineEndTs;
    if (!this._timelineRecordings.length) {
      return Math.max(0, targetTs - vodStart);
    }
    let videoSeconds = 0;
    for (const rec of this._timelineRecordings) {
      const recStart = Math.max(vodStart, rec.start_time);
      const recEnd = Math.min(vodEnd, rec.end_time);
      if (recEnd <= recStart) continue;

      if (recEnd <= targetTs) {
        videoSeconds += (recEnd - recStart);
      } else if (recStart < targetTs) {
        videoSeconds += Math.max(0, targetTs - recStart);
        return videoSeconds;
      } else {
        return videoSeconds;
      }
    }
    return videoSeconds;
  }

  private _videoOffsetToWallClock(videoOffset: number): number {
    const vodStart = this._timelineVodStartTs || this._timelineStartTs;
    const vodEnd = this._timelineVodEndTs || this._timelineEndTs;
    if (!this._timelineRecordings.length) {
      return vodStart + videoOffset;
    }
    let accumulated = 0;
    let lastEnd = vodStart;
    for (const rec of this._timelineRecordings) {
      const recStart = Math.max(vodStart, rec.start_time);
      const recEnd = Math.min(vodEnd, rec.end_time);
      if (recEnd <= recStart) continue;
      lastEnd = recEnd;

      const dur = recEnd - recStart;
      if (accumulated + dur >= videoOffset) {
        return recStart + (videoOffset - accumulated);
      }
      accumulated += dur;
    }
    return lastEnd;
  }

  private _loadTimelineVideo(seekTargetTs?: number, isAutoAdvance = false): void {
    if (!this._timelineContainer || !this._timelineCamera) return;
    if (!isAutoAdvance) this._timelineWindowRequestId++;

    // Long windows are split into VOD chunks so Frigate's nginx-vod clip limit
    // is never exceeded. Snap the seek target into the chunk that has footage.
    const vodWindow = this._resolveTimelineVodWindow(seekTargetTs, isAutoAdvance);
    this._timelineVodStartTs = vodWindow.startTs;
    this._timelineVodEndTs = vodWindow.endTs;
    seekTargetTs = vodWindow.seekTs;

    // In auto-advance, load the incoming footage into the standby video slot
    const slot = isAutoAdvance
      ? (this._timelineActiveVideo === 'a' ? 'b' : 'a')
      : this._timelineActiveVideo;

    const video = slot === 'a' ? this._timelineVideoA : this._timelineVideoB;
    if (!video) return;

    // Destroy any existing HLS on the target slot
    if (slot === 'a') {
      if (this._timelineHlsA) {
        this._timelineHlsA.destroy();
        this._timelineHlsA = null;
      }
    } else {
      if (this._timelineHlsB) {
        this._timelineHlsB.destroy();
        this._timelineHlsB = null;
      }
    }

    // Completely reset the target video element so it is pristine (no leftover seek/frames from prior cycles)
    try {
      video.pause();
      video.removeAttribute('src');
      video.load();
      video.currentTime = 0;
    } catch (_) {}

    // Detach all previous listeners on this slot
    video.onloadeddata = null;
    video.oncanplay = null;
    video.onplay = null;
    video.onplaying = null;
    video.onpause = null;
    video.onended = null;
    video.onerror = null;

    if (!isAutoAdvance) {
      this._clearTimelineSpeedInterval();
    }

    if (this._timelinePlaybackRate <= 16) {
      video.playbackRate = this._timelinePlaybackRate;
      video.muted = this._isTimelineMuted;
    } else {
      video.playbackRate = 1;
      video.muted = true;
    }

    if (this._timelineLoadingTimeout) {
      clearTimeout(this._timelineLoadingTimeout);
      this._timelineLoadingTimeout = undefined;
    }

    const loadingEl = this._timelineContainer.querySelector('.timeline-player-loading') as HTMLElement | null;
    if (loadingEl) {
      if (!isAutoAdvance) {
        loadingEl.classList.remove('subtle');
        loadingEl.style.display = 'flex';
        loadingEl.innerHTML = `<div class="timeline-spinner"></div><span>Buffering continuous footage...</span>`;
      } else {
        // Auto-advancing: completely silent. Outgoing video holds frame until incoming video is ready.
        loadingEl.style.display = 'none';
        loadingEl.classList.add('subtle');
      }
    }

    const clientId = this._config?.frigate_client_id || 'frigate';
    const frigateUrl = this._config?.frigate_url;
    const hlsUrl = getVodHlsURL(clientId, this._timelineCamera, this._timelineVodStartTs, this._timelineVodEndTs, frigateUrl);
    const mp4Url = getVodClipURL(clientId, this._timelineCamera, this._timelineVodStartTs, this._timelineVodEndTs, frigateUrl);

    const initialOffset = (seekTargetTs && seekTargetTs >= this._timelineVodStartTs && seekTargetTs <= this._timelineVodEndTs)
      ? this._wallClockToVideoOffset(seekTargetTs)
      : 0;

    // Immediately reflect initial playhead position on track
    if (seekTargetTs) {
      const windowDuration = this._timelineEndTs - this._timelineStartTs;
      if (windowDuration > 0) {
        const pct = Math.max(0, Math.min(100, ((seekTargetTs - this._timelineStartTs) / windowDuration) * 100));
        const playhead = this._timelineContainer.querySelector('.timeline-playhead') as HTMLElement | null;
        if (playhead) {
          playhead.style.left = `${pct}%`;
        }
        const currentBadge = this._timelineContainer.querySelector('[data-timeline-current-time]') as HTMLElement | null;
        if (currentBadge) {
          const curDate = new Date(seekTargetTs * 1000);
          currentBadge.textContent = curDate.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' });
        }
      }
    }

    let isActivated = false;
    const activateAndPlay = () => {
      if (isActivated) return;
      if (video.readyState < 2) return; // Wait until current frame data is actually decoded
      isActivated = true;

      if (this._timelineLoadingTimeout) {
        clearTimeout(this._timelineLoadingTimeout);
        this._timelineLoadingTimeout = undefined;
      }
      if (this._timelineAdvanceTimeout) {
        clearTimeout(this._timelineAdvanceTimeout);
        this._timelineAdvanceTimeout = undefined;
      }
      if (loadingEl) {
        loadingEl.style.display = 'none';
        loadingEl.classList.remove('subtle');
      }

      if (slot !== this._timelineActiveVideo) {
        const oldSlot = this._timelineActiveVideo;
        const oldVideo = oldSlot === 'a' ? this._timelineVideoA : this._timelineVideoB;

        // Bring new video on top immediately with incoming state (z-index: 3, opacity: 1)
        video.classList.remove('standby');
        video.classList.add('incoming');
        this._timelineActiveVideo = slot;

        // Seek if needed before or right as it becomes active
        if (initialOffset > 0) {
          let offset = initialOffset;
          if (Number.isFinite(video.duration) && video.duration > 0) {
            offset = Math.min(offset, Math.max(0, video.duration - 0.5));
          }
          video.currentTime = offset;
        }

        // Start playback on the newly active slot
        this._applyTimelinePlaybackRate(this._timelinePlaybackRate);

        // Smooth cross-dissolve: let incoming video render for 200ms on top,
        // then retire the old video to standby and cleanly destroy its stream.
        if (this._timelineSlotTransitionTimeout) {
          clearTimeout(this._timelineSlotTransitionTimeout);
        }
        this._timelineSlotTransitionTimeout = window.setTimeout(() => {
          if (this._timelineActiveVideo === slot) {
            video.classList.remove('incoming');
            video.classList.add('active');

            if (oldVideo) {
              oldVideo.classList.remove('active', 'incoming');
              oldVideo.classList.add('standby');
              oldVideo.pause();
              try {
                oldVideo.removeAttribute('src');
                oldVideo.load();
                oldVideo.currentTime = 0;
              } catch (_) {}
            }
            if (oldSlot === 'a' && this._timelineHlsA) {
              this._timelineHlsA.destroy();
              this._timelineHlsA = null;
            } else if (oldSlot === 'b' && this._timelineHlsB) {
              this._timelineHlsB.destroy();
              this._timelineHlsB = null;
            }
          }
          this._isAdvancingTimeline = false;
        }, 200);
      } else {
        // Direct seek / initial load in the same slot
        video.classList.remove('standby', 'incoming');
        video.classList.add('active');
        if (initialOffset > 0) {
          let offset = initialOffset;
          if (Number.isFinite(video.duration) && video.duration > 0) {
            offset = Math.min(offset, Math.max(0, video.duration - 0.5));
          }
          video.currentTime = offset;
        }
        this._applyTimelinePlaybackRate(this._timelinePlaybackRate);
        this._isAdvancingTimeline = false;
      }
    };

    video.onloadeddata = activateAndPlay;
    video.oncanplay = activateAndPlay;
    video.onplay = () => {
      this._updateTimelinePlayheadUI();
    };
    video.onplaying = () => {
      activateAndPlay();
      this._updateTimelinePlayheadUI();
    };
    video.onpause = () => {
      if (this._timelineActiveVideo === slot && this._timelinePlaybackRate <= 16) {
        this._clearTimelineSpeedInterval();
      }
      this._updateTimelinePlayheadUI();
    };

    video.onended = () => {
      if (this._timelineActiveVideo === slot && !this._isAdvancingTimeline) {
        this._clearTimelineSpeedInterval();
        video.pause();
        if (Number.isFinite(video.duration) && video.duration > 0) {
          video.currentTime = Math.max(0, video.duration - 0.1);
        }
        this._updateTimelinePlayheadUI();
        this._advanceToNextTimelineWindow();
      }
    };

    console.log('Frigate Events Card: VOD requested:', { slot, hlsUrl, mp4Url, start: this._timelineVodStartTs, end: this._timelineVodEndTs });

    // Signed paths (authSig) are required by the Frigate integration's VOD views.
    // hls.js can send a Bearer header, but native HLS (iOS Safari / HA companion app)
    // and direct <video> MP4 fallbacks cannot, so sign the URLs up front.
    // Only sign HA-proxied URLs; a direct Frigate URL must not be rewritten to a relative path.
    const requestId = this._timelineWindowRequestId;
    const vodStart = this._timelineVodStartTs;
    const vodEnd = this._timelineVodEndTs;
    const isStale = () =>
      requestId !== this._timelineWindowRequestId ||
      vodStart !== this._timelineVodStartTs ||
      vodEnd !== this._timelineVodEndTs;

    const startStream = async () => {
      let signedHlsUrl = hlsUrl;
      let signedMp4Url = mp4Url;
      const hass = this.hass;
      if (hass && !frigateUrl) {
        try {
          [signedHlsUrl, signedMp4Url] = await Promise.all([
            signPath(hass, hlsUrl),
            signPath(hass, mp4Url),
          ]);
        } catch (e) {
          console.warn('Frigate Events Card: Failed to sign VOD URLs:', e);
        }
      }
      if (isStale()) return;

      const fallbackToMp4 = () => {
        console.warn('Frigate Events Card: HLS failed or unsupported, trying MP4 clip:', signedMp4Url);
        video.onerror = (e) => {
          this._isAdvancingTimeline = false;
          if (this._timelineLoadingTimeout) {
            clearTimeout(this._timelineLoadingTimeout);
            this._timelineLoadingTimeout = undefined;
          }
          if (this._timelineAdvanceTimeout) {
            clearTimeout(this._timelineAdvanceTimeout);
            this._timelineAdvanceTimeout = undefined;
          }
          if (loadingEl) {
            loadingEl.classList.remove('subtle');
          }
          console.error('Frigate Events Card: MP4 playback failed:', e, signedMp4Url);
          if (loadingEl) {
            loadingEl.innerHTML = `
              <div style="display:flex; flex-direction:column; align-items:center; gap:8px; text-align:center; padding:16px;">
                <span>No continuous footage stream available for this time window.</span>
                <span style="font-size:11px; opacity:0.6;">Tested URLs: <a href="${escapeHtml(signedHlsUrl)}" target="_blank" style="color:var(--primary-color, #03a9f4);">HLS</a> | <a href="${escapeHtml(signedMp4Url)}" target="_blank" style="color:var(--primary-color, #03a9f4);">MP4</a></span>
              </div>
            `;
          }
        };
        video.src = signedMp4Url;
        video.load();
      };

      // If Hls.js is supported (Chrome, Edge, Firefox, modern browsers)
      if (Hls.isSupported()) {
        const token = (this.hass as any)?.auth?.data?.access_token;
        const hls = new Hls({
          startPosition: initialOffset >= 0 ? initialOffset : -1,
          enableWorker: true,
          lowLatencyMode: false,
          xhrSetup: (xhr: XMLHttpRequest, url: string) => {
            if (token && !url.includes('authSig=')) {
              xhr.setRequestHeader('Authorization', `Bearer ${token}`);
            }
          },
        });
        if (slot === 'a') {
          this._timelineHlsA = hls;
        } else {
          this._timelineHlsB = hls;
        }
        hls.loadSource(signedHlsUrl);
        hls.attachMedia(video);

        hls.on(Hls.Events.ERROR, (_event, data) => {
          console.warn('Frigate Events Card: Hls.js error event:', data.type, data.details, data.fatal);
          if (data.fatal) {
            hls.destroy();
            if (slot === 'a') this._timelineHlsA = null;
            else this._timelineHlsB = null;
            fallbackToMp4();
          }
        });
      } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
        video.onerror = () => {
          fallbackToMp4();
        };
        video.src = signedHlsUrl;
        video.load();
      } else {
        fallbackToMp4();
      }
    };

    void startStream();

    this._startTimelineTimeUpdates();
  }

  private _startTimelineTimeUpdates(): void {
    if (this._timelineTimeUpdateRaf) {
      cancelAnimationFrame(this._timelineTimeUpdateRaf);
    }
    const tick = () => {
      if (!this._timelineContainer || !this._timelineVideoEl) return;
      if (!this._timelineIsDragging && !this._isAdvancingTimeline) {
        this._updateTimelinePlayheadUI();
        const v = this._timelineVideoEl;
        if (
          this._timelinePlaybackRate <= 16 &&
          !v.paused &&
          Number.isFinite(v.duration) &&
          v.duration > 0 &&
          v.currentTime >= Math.max(0, v.duration - 0.3)
        ) {
          this._advanceToNextTimelineWindow();
        }
      }
      this._timelineTimeUpdateRaf = requestAnimationFrame(tick);
    };
    this._timelineTimeUpdateRaf = requestAnimationFrame(tick);
  }

  private _updateTimelinePlayheadUI(): void {
    if (!this._timelineContainer || !this._timelineVideoEl) return;
    const video = this._timelineVideoEl;
    const duration = this._timelineEndTs - this._timelineStartTs;
    if (duration <= 0) return;

    const currentOffset = video.currentTime || 0;
    const currentTs = this._videoOffsetToWallClock(currentOffset);
    const pct = Math.max(0, Math.min(100, ((currentTs - this._timelineStartTs) / duration) * 100));

    const playhead = this._timelineContainer.querySelector('.timeline-playhead') as HTMLElement | null;
    if (playhead) {
      playhead.style.left = `${pct}%`;
    }

    const track = this._timelineContainer.querySelector('.timeline-track-container[role="slider"]') as HTMLElement | null;
    if (track) {
      track.setAttribute('aria-valuenow', String(Math.round(pct)));
      track.setAttribute('aria-valuetext', new Date(currentTs * 1000).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' }));
    }

    const currentBadge = this._timelineContainer.querySelector('[data-timeline-current-time]') as HTMLElement | null;
    if (currentBadge) {
      const curDate = new Date(currentTs * 1000);
      currentBadge.textContent = curDate.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' });
    }

    const playPauseBtns = this._timelineContainer.querySelectorAll('[data-action="toggle-play"]');
    playPauseBtns.forEach(playPauseBtn => {
      const btn = playPauseBtn as HTMLElement;
      const isPaused = this._timelinePlaybackRate > 16
        ? !this._timelineSpeedInterval
        : video.paused;
      const stateStr = isPaused ? 'paused' : 'playing';
      if (btn.getAttribute('data-play-state') !== stateStr) {
        btn.setAttribute('data-play-state', stateStr);
        btn.setAttribute('title', isPaused ? 'Play' : 'Pause');
        btn.innerHTML = isPaused
          ? `<svg viewBox="0 0 24 24"><path d="M8,5.14V19.14L19,12.14L8,5.14Z"/></svg>`
          : `<svg viewBox="0 0 24 24"><path d="M14,19H18V5H14M6,19H10V5H6V19Z"/></svg>`;
      }
    });
  }

  private _updateTimelineScrubberEvents(): void {
    if (!this._timelineContainer) return;
    const eventsLayer = this._timelineContainer.querySelector('.timeline-events-layer');
    if (!eventsLayer) return;

    const windowDuration = this._timelineEndTs - this._timelineStartTs;
    if (windowDuration <= 0) return;

    eventsLayer.innerHTML = this._timelineEvents.map(ev => {
      const start = ev.start_time || 0;
      const end = ev.end_time || (start + 30);
      const startPct = Math.max(0, Math.min(100, ((start - this._timelineStartTs) / windowDuration) * 100));
      const endPct = Math.max(0, Math.min(100, ((end - this._timelineStartTs) / windowDuration) * 100));
      const widthPct = Math.max(0.6, endPct - startPct);
      const labelClass = escapeHtml((ev.label || 'event').toLowerCase());
      const timeStr = this._formatTime(start);
      const title = `${(ev.label || 'Event').toUpperCase()} at ${timeStr}`;

      return `
        <div
          class="timeline-event-marker ${labelClass}"
          data-event-id="${escapeHtml(ev.id)}"
          data-event-start="${start}"
          title="${escapeHtml(title)}"
          style="left: ${startPct}%; width: ${widthPct}%;"
        ></div>
      `;
    }).join('');

    // Attach marker click handlers
    eventsLayer.querySelectorAll<HTMLElement>('.timeline-event-marker').forEach(marker => {
      const handleMarkerClick = (e: Event) => {
        e.stopPropagation();
        const eventId = (marker as HTMLElement).getAttribute('data-event-id');
        const ev = this._timelineEvents.find(item => item.id === eventId);
        const start = (ev && ev.start_time) ? ev.start_time : parseFloat((marker as HTMLElement).getAttribute('data-event-start') || '0');
        const baseTs = start;
        const seekOffset = this._getEventSeekOffset(ev);
        if (baseTs > 0 && this._timelineVideoEl) {
          const targetTs = Math.max(this._timelineStartTs, Math.min(this._timelineEndTs, baseTs + seekOffset));

          // The event may be outside the currently loaded VOD chunk; load a new
          // chunk around it instead of clamping the seek to the chunk edge.
          if (targetTs < this._timelineVodStartTs || targetTs > this._timelineVodEndTs) {
            this._loadTimelineVideo(targetTs);
            return;
          }

          const targetOffset = this._wallClockToVideoOffset(targetTs);
          const maxSeek = (Number.isFinite(this._timelineVideoEl.duration) && this._timelineVideoEl.duration > 0)
            ? Math.max(0, this._timelineVideoEl.duration - 0.5)
            : targetOffset;
          const offset = Math.max(0, Math.min(maxSeek, targetOffset));
          this._timelineVideoEl.currentTime = offset;
          this._timelineVideoEl.play().catch(() => {});

          // Immediately reflect position visually on track even before video timeupdate fires
          const windowDuration = this._timelineEndTs - this._timelineStartTs;
          if (windowDuration > 0 && this._timelineContainer) {
            const pct = Math.max(0, Math.min(100, ((targetTs - this._timelineStartTs) / windowDuration) * 100));
            const playhead = this._timelineContainer.querySelector('.timeline-playhead') as HTMLElement | null;
            if (playhead) {
              playhead.style.left = `${pct}%`;
            }
            const currentBadge = this._timelineContainer.querySelector('[data-timeline-current-time]') as HTMLElement | null;
            if (currentBadge) {
              const curDate = new Date(targetTs * 1000);
              currentBadge.textContent = curDate.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' });
            }
          }
          this._updateTimelinePlayheadUI();
        }
      };

      marker.addEventListener('pointerdown', (e: PointerEvent) => {
        e.stopPropagation();
      });
      marker.addEventListener('pointerup', (e: PointerEvent) => {
        e.stopPropagation();
      });
      marker.addEventListener('click', (e: MouseEvent) => {
        handleMarkerClick(e);
      });
    });
  }

  private _updateTimelineWindowUI(): void {
    if (!this._timelineContainer) return;
    const container = this._timelineContainer;
    const startDate = new Date(this._timelineStartTs * 1000);
    const endDate = new Date(this._timelineEndTs * 1000);

    // Format ISO string for datetime-local input (YYYY-MM-DDTHH:mm)
    const pad = (n: number) => String(n).padStart(2, '0');
    const dtValue = `${startDate.getFullYear()}-${pad(startDate.getMonth() + 1)}-${pad(startDate.getDate())}T${pad(startDate.getHours())}:${pad(startDate.getMinutes())}`;

    const dtInput = container.querySelector('.timeline-datetime-input') as HTMLInputElement | null;
    if (dtInput && dtInput.value !== dtValue) {
      dtInput.value = dtValue;
    }

    const labels = container.querySelectorAll('.timeline-track-labels > span');
    if (labels.length >= 3) {
      labels[0].textContent = startDate.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
      labels[2].textContent = endDate.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    }

    const windowMinutes = Math.round(this._timelineWindowDurationSec / 60);
    container.querySelectorAll('.timeline-window-pill').forEach(pill => {
      const mins = parseInt(pill.getAttribute('data-window') || '60', 10);
      if (mins === windowMinutes) {
        pill.classList.add('active');
      } else {
        pill.classList.remove('active');
      }
    });

    this._updateTimelinePlayheadUI();
  }

  private _renderTimelineContent(container: HTMLElement): void {
    const availableCameras = this._getAvailableCameras();
    const currentCamera = this._timelineCamera || (availableCameras[0] || 'Camera');
    const startDate = new Date(this._timelineStartTs * 1000);
    const endDate = new Date(this._timelineEndTs * 1000);

    // Format ISO string for datetime-local input (YYYY-MM-DDTHH:mm)
    const pad = (n: number) => String(n).padStart(2, '0');
    const dtValue = `${startDate.getFullYear()}-${pad(startDate.getMonth() + 1)}-${pad(startDate.getDate())}T${pad(startDate.getHours())}:${pad(startDate.getMinutes())}`;

    const windowMinutes = Math.round(this._timelineWindowDurationSec / 60);
    const layoutMode: 'desktop' | 'compact' | 'tv' = container.classList.contains('is-tv')
      ? 'tv'
      : container.classList.contains('is-compact')
        ? 'compact'
        : 'desktop';
    const isCompactLayout = layoutMode === 'compact' || layoutMode === 'tv';

    if (!isCompactLayout) {
      container.innerHTML = `
      <div class="frigate-events-modal-content" role="dialog" aria-modal="true" aria-label="Timeline">
        <div class="timeline-modal-header">
          <h2 class="timeline-modal-title">Timeline</h2>
          <span class="timeline-camera-badge" data-safe-text="${escapeHtml(this._formatCameraName(currentCamera))}"></span>
          <button class="frigate-events-modal-close" data-action="close" title="Close" aria-label="Close">
            <svg viewBox="0 0 24 24"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
          </button>
        </div>

        <div class="timeline-modal-body">
          ${this._timelineCameraTabsMarkup(availableCameras, currentCamera)}

          <!-- Controls: DateTime picker, Quick jumps, Window duration -->
          ${this._timelineControlsMarkup(dtValue, windowMinutes)}

          <!-- Video Player -->
          ${this._timelinePlayerMarkup()}

          <!-- Scrubber Track -->
          ${this._timelineScrubberMarkup(startDate, endDate, false)}

          <!-- Transport & Speed Controls -->
          ${this._timelineTransportMarkup(false)}
        </div>
      </div>
    `;
    } else {
      const tabsMarkup = this._timelineCameraTabsMarkup(availableCameras, currentCamera);
      const isTvLayout = layoutMode === 'tv';
      // Compact (phones, tablets and TV): transport lives only in the settings
      // sheet Playback section. The body transport markup below is hidden by CSS.
      const compactSheetInner = `<div class="timeline-sheet-section"><div class="timeline-sheet-heading">Playback</div>${this._timelineTransportMarkup(true)}</div>${this._timelineControlsMarkup(dtValue, windowMinutes, true)}`;
      container.innerHTML = `
      <div class="frigate-events-modal-content" role="dialog" aria-modal="true" aria-label="Timeline">
        <div class="timeline-compact-topbar">
          ${tabsMarkup || `<span class="timeline-compact-camera-name"><span class="timeline-camera-badge" data-safe-text="${escapeHtml(this._formatCameraName(currentCamera))}"></span></span>`}
          <div class="timeline-compact-actions">
            <button class="timeline-settings-btn" data-action="toggle-settings" title="Time & window settings" aria-label="Time and window settings" aria-expanded="false">
              <svg viewBox="0 0 24 24"><path d="M19.14,12.94C19.18,12.64 19.2,12.33 19.2,12C19.2,11.68 19.18,11.36 19.14,11.06L21.16,9.48C21.34,9.34 21.39,9.07 21.27,8.87L19.27,5.41C19.16,5.22 18.92,5.15 18.7,5.24L16.32,6.2C15.82,5.82 15.28,5.5 14.7,5.25L14.34,2.74C14.31,2.5 14.1,2.32 13.86,2.32H10.14C9.9,2.32 9.69,2.5 9.66,2.74L9.3,5.25C8.72,5.5 8.18,5.82 7.68,6.2L5.3,5.24C5.08,5.15 4.84,5.22 4.73,5.41L2.73,8.87C2.61,9.07 2.66,9.34 2.84,9.48L4.86,11.06C4.82,11.36 4.8,11.68 4.8,12C4.8,12.33 4.82,12.64 4.86,12.94L2.84,14.52C2.66,14.66 2.61,14.93 2.73,15.13L4.73,18.59C4.84,18.78 5.08,18.85 5.3,18.76L7.68,17.8C8.18,18.18 8.72,18.5 9.3,18.75L9.66,21.26C9.69,21.5 9.9,21.68 10.14,21.68H13.86C14.1,21.68 14.31,21.5 14.34,21.26L14.7,18.75C15.28,18.5 15.82,18.18 16.32,17.8L18.7,18.76C18.92,18.85 19.16,18.78 19.27,18.59L21.27,15.13C21.39,14.93 21.34,14.66 21.16,14.52L19.14,12.94M12,15.6C10.02,15.6 8.4,13.98 8.4,12C8.4,10.02 10.02,8.4 12,8.4C13.98,8.4 15.6,10.02 15.6,12C15.6,13.98 13.98,15.6 12,15.6Z"/></svg>
            </button>
            <button class="frigate-events-modal-close" data-action="close" title="Close" aria-label="Close">
              <svg viewBox="0 0 24 24"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
            </button>
          </div>
        </div>

        <div class="timeline-modal-header timeline-compact-proxy">
          <h2 class="timeline-modal-title">Timeline</h2>
          <span class="timeline-camera-badge" data-safe-text="${escapeHtml(this._formatCameraName(currentCamera))}"></span>
        </div>

        <div class="timeline-modal-body">
          <!-- Video Player -->
          ${this._timelinePlayerMarkup()}

          <!-- Scrubber Track -->
          ${this._timelineScrubberMarkup(startDate, endDate, true)}
          <!-- Transport & Speed Controls (TV on-stage; hidden for compact via CSS, served by the settings sheet) -->
          ${this._timelineTransportMarkup(true)}
        </div>

        <div class="timeline-settings-backdrop" data-action="close-settings"></div>
        <div class="timeline-settings-sheet" role="dialog" aria-label="Timeline settings">
          <div class="timeline-settings-handle"></div>
          ${isTvLayout ? this._timelineControlsMarkup(dtValue, windowMinutes) : compactSheetInner}
        </div>
      </div>
    `;
    }

    container.querySelectorAll<HTMLElement>('[data-safe-text]').forEach((element) => {
      element.textContent = element.getAttribute('data-safe-text') || '';
      element.removeAttribute('data-safe-text');
    });

    // Attach Event Listeners
    this._timelineVideoA = container.querySelector('video.timeline-video-a');
    this._timelineVideoB = container.querySelector('video.timeline-video-b');
    if (this._timelineVideoA) this._timelineVideoA.muted = this._isTimelineMuted;
    if (this._timelineVideoB) this._timelineVideoB.muted = this._isTimelineMuted;
    this._timelineActiveVideo = 'a';

    const muteBtn = container.querySelector('[data-action="toggle-timeline-mute"]');
    muteBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      this._toggleTimelineMute();
    });
    muteBtn?.addEventListener('pointerdown', (e) => e.stopPropagation());
    muteBtn?.addEventListener('touchstart', (e) => e.stopPropagation());
    muteBtn?.addEventListener('touchend', (e) => e.stopPropagation());

    const content = container.querySelector('.frigate-events-modal-content');
    content?.addEventListener('click', (e) => e.stopPropagation());

    // Close buttons (desktop has one in the header, compact/TV has one in the topbar)
    container.querySelectorAll('[data-action="close"]').forEach(closeBtn => {
      closeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this._removeTimelineModal();
      });
    });

    // Compact/TV settings sheet toggle (gear button) + backdrop tap to close.
    const settingsBtn = container.querySelector('[data-action="toggle-settings"]') as HTMLElement | null;
    const closeSettings = () => {
      container.classList.remove('settings-open');
      settingsBtn?.setAttribute('aria-expanded', 'false');
    };
    const openSettings = () => {
      container.classList.add('settings-open');
      settingsBtn?.setAttribute('aria-expanded', 'true');
    };
    settingsBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      if (container.classList.contains('settings-open')) {
        closeSettings();
      } else {
        openSettings();
      }
    });
    container.querySelector('[data-action="close-settings"]')?.addEventListener('click', (e) => {
      e.stopPropagation();
      closeSettings();
    });

    // Camera tabs
    container.querySelectorAll('.timeline-camera-tab').forEach(tab => {
      tab.addEventListener('click', async (e) => {
        e.stopPropagation();
        this._isAdvancingTimeline = false;
        const cam = (tab as HTMLElement).getAttribute('data-camera');
        if (cam && cam !== this._timelineCamera) {
          this._timelineCamera = cam;
          container.querySelectorAll('.timeline-camera-tab').forEach(t => {
            t.classList.toggle('active', t.getAttribute('data-camera') === cam);
          });
          const badge = container.querySelector('.timeline-camera-badge');
          if (badge) {
            badge.textContent = this._formatCameraName(cam);
          }
          this._updateTimelineWindowUI();
          await this._fetchTimelineEvents();
          this._updateTimelineScrubberEvents();
          this._loadTimelineVideo(this._timelineStartTs);
        }
      });
    });

    // Datetime change
    const dtInput = container.querySelector('.timeline-datetime-input') as HTMLInputElement | null;
    dtInput?.addEventListener('change', async () => {
      if (!dtInput.value) return;
      this._isAdvancingTimeline = false;
      const parsed = new Date(dtInput.value).getTime() / 1000;
      if (!isNaN(parsed) && parsed > 0) {
        this._timelineStartTs = Math.floor(parsed);
        this._timelineEndTs = Math.floor(this._timelineStartTs + this._timelineWindowDurationSec);
        this._updateTimelineWindowUI();
        await this._fetchTimelineEvents();
        this._updateTimelineScrubberEvents();
        this._loadTimelineVideo(this._timelineStartTs);
      }
    });

    // Quick jump buttons
    container.querySelectorAll('[data-jump]').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        this._isAdvancingTimeline = false;
        const jump = (btn as HTMLElement).getAttribute('data-jump');
        const now = Math.floor(Date.now() / 1000);

        if (jump === 'now') {
          // Snap window to end at now
          this._timelineEndTs = now;
          this._timelineStartTs = Math.max(0, this._timelineEndTs - this._timelineWindowDurationSec);
        } else if (jump === 'day-start') {
          // Find the beginning of the currently viewed day (based on current timeline start)
          const refDate = new Date(this._timelineStartTs * 1000);
          const startOfDay = new Date(refDate.getFullYear(), refDate.getMonth(), refDate.getDate(), 0, 0, 0, 0);
          const endOfDay = new Date(refDate.getFullYear(), refDate.getMonth(), refDate.getDate(), 23, 59, 59, 999);
          const dayStartTs = Math.floor(startOfDay.getTime() / 1000);
          const dayEndTs = Math.floor(endOfDay.getTime() / 1000);

          let targetTs = dayStartTs;
          if (this.hass && this._timelineCamera) {
            try {
              const clientId = this._config?.frigate_client_id || 'frigate';
              const dayRecordings = await getRecordings(this.hass, clientId, this._timelineCamera, dayStartTs, dayEndTs);
              if (Array.isArray(dayRecordings) && dayRecordings.length > 0) {
                dayRecordings.sort((a, b) => a.start_time - b.start_time);
                targetTs = dayRecordings[0].start_time;
              }
            } catch (err) {
              console.debug('Failed to fetch recordings for day-start jump:', err);
            }
          }

          this._timelineStartTs = targetTs;
          this._timelineEndTs = Math.floor(this._timelineStartTs + this._timelineWindowDurationSec);
        } else {
          // Relative shifts backward from current window start time
          let deltaSec = 3600;
          if (jump === '-15m') deltaSec = 900;
          else if (jump === '-1h') deltaSec = 3600;
          else if (jump === '-3h') deltaSec = 10800;
          else if (jump === '-12h') deltaSec = 43200;

          this._timelineStartTs = Math.max(0, this._timelineStartTs - deltaSec);
          this._timelineEndTs = Math.floor(this._timelineStartTs + this._timelineWindowDurationSec);
        }

        this._updateTimelineWindowUI();
        await this._fetchTimelineEvents();
        this._updateTimelineScrubberEvents();
        this._loadTimelineVideo(jump === 'now' ? now : this._timelineStartTs);
      });
    });

    // Window duration pills
    container.querySelectorAll('.timeline-window-pill').forEach(pill => {
      pill.addEventListener('click', async (e) => {
        e.stopPropagation();
        this._isAdvancingTimeline = false;
        const mins = parseInt((pill as HTMLElement).getAttribute('data-window') || '60', 10);
        const currentWallClock = this._videoOffsetToWallClock(this._timelineVideoEl?.currentTime || 0);
        this._timelineWindowDurationSec = mins * 60;
        this._timelineWindowUserChosen = true;

        // Keep currentWallClock centered in new window duration, constrained by now
        const now = Math.floor(Date.now() / 1000);
        let newStart = Math.floor(currentWallClock - this._timelineWindowDurationSec / 2);
        if (newStart + this._timelineWindowDurationSec > now) {
          newStart = Math.max(0, now - this._timelineWindowDurationSec);
        }
        this._timelineStartTs = Math.max(0, newStart);
        this._timelineEndTs = Math.floor(this._timelineStartTs + this._timelineWindowDurationSec);

        this._updateTimelineWindowUI();
        await this._fetchTimelineEvents();
        this._updateTimelineScrubberEvents();
        this._loadTimelineVideo(currentWallClock);
      });
    });

    // Video click to play/pause
    const playerContainer = container.querySelector('.timeline-player-container');
    playerContainer?.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('.timeline-mute-btn')) return;
      e.stopPropagation();
      this._toggleTimelinePlayPause();
    });

    // Play / Pause buttons (on-stage + settings sheet copies)
    container.querySelectorAll('[data-action="toggle-play"]').forEach(playPauseBtn => {
      playPauseBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this._toggleTimelinePlayPause();
      });
    });

    // Skip buttons
    container.querySelectorAll('[data-skip]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!this._timelineVideoEl) return;
        const delta = parseFloat((btn as HTMLElement).getAttribute('data-skip') || '0');
        const duration = this._timelineEndTs - this._timelineStartTs;
        const maxSeek = (Number.isFinite(this._timelineVideoEl.duration) && this._timelineVideoEl.duration > 0)
          ? Math.max(0, this._timelineVideoEl.duration - 0.5)
          : duration;
        this._timelineVideoEl.currentTime = Math.max(0, Math.min(maxSeek, this._timelineVideoEl.currentTime + delta));
        this._updateTimelinePlayheadUI();
      });
    });

    // Stepper Speed controls
    this._syncTimelineSpeedStepperUI(container);

    container.querySelectorAll('[data-action="speed-down"]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const currentIndex = TIMELINE_PLAYBACK_SPEEDS.indexOf(this._timelinePlaybackRate);
        if (currentIndex > 0) {
          this._applyTimelinePlaybackRate(TIMELINE_PLAYBACK_SPEEDS[currentIndex - 1]);
        }
      });
    });

    container.querySelectorAll('[data-action="speed-up"]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const currentIndex = TIMELINE_PLAYBACK_SPEEDS.indexOf(this._timelinePlaybackRate);
        if (currentIndex >= 0 && currentIndex < TIMELINE_PLAYBACK_SPEEDS.length - 1) {
          this._applyTimelinePlaybackRate(TIMELINE_PLAYBACK_SPEEDS[currentIndex + 1]);
        }
      });
    });

    container.querySelectorAll('[data-timeline-speed-display]').forEach(display => {
      display.addEventListener('click', (e) => {
        e.stopPropagation();
        this._applyTimelinePlaybackRate(1);
      });
    });

    // Scrubber track click / drag scrubbing
    const track = container.querySelector('.timeline-track-container') as HTMLElement | null;
    if (track) {
      let lastCommitAt = 0;

      const getTargetTs = (clientX: number): number | null => {
        const rect = track.getBoundingClientRect();
        if (rect.width <= 0) return null;
        const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
        const duration = this._timelineEndTs - this._timelineStartTs;
        if (duration <= 0) return null;
        return this._timelineStartTs + (ratio * duration);
      };

      const handleSeek = (clientX: number, commit = false) => {
        const targetTs = getTargetTs(clientX);
        if (targetTs === null) return;

        const windowDuration = this._timelineEndTs - this._timelineStartTs;
        const ratio = Math.max(0, Math.min(1, (targetTs - this._timelineStartTs) / windowDuration));

        // Immediately reflect position visually on track even before video timeupdate fires
        const playhead = container.querySelector('.timeline-playhead') as HTMLElement | null;
        if (playhead) {
          playhead.style.left = `${ratio * 100}%`;
        }
        const currentBadge = container.querySelector('[data-timeline-current-time]') as HTMLElement | null;
        if (currentBadge) {
          const curDate = new Date(targetTs * 1000);
          currentBadge.textContent = curDate.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' });
        }

        // Seeking outside the loaded VOD chunk requires loading a new chunk.
        if (targetTs < this._timelineVodStartTs || targetTs > this._timelineVodEndTs) {
          if (commit) {
            lastCommitAt = Date.now();
            this._loadTimelineVideo(targetTs);
          }
          return;
        }

        const targetOffset = this._wallClockToVideoOffset(targetTs);
        if (this._timelineVideoEl) {
          const maxSeek = (Number.isFinite(this._timelineVideoEl.duration) && this._timelineVideoEl.duration > 0)
            ? Math.max(0, this._timelineVideoEl.duration - 0.5)
            : targetOffset;
          this._timelineVideoEl.currentTime = Math.max(0, Math.min(targetOffset, maxSeek));
        }
      };

      track.addEventListener('pointerdown', (e: PointerEvent) => {
        if ((e.target as HTMLElement)?.closest('.timeline-event-marker')) return;
        e.preventDefault();
        e.stopPropagation();
        this._timelineIsDragging = true;
        try {
          track.setPointerCapture(e.pointerId);
        } catch (_) {}
        handleSeek(e.clientX);

        const onMove = (ev: PointerEvent) => {
          if (this._timelineIsDragging) {
            handleSeek(ev.clientX);
          }
        };

        const onUp = (ev: PointerEvent) => {
          this._timelineIsDragging = false;
          try {
            track.releasePointerCapture(ev.pointerId);
          } catch (_) {}
          track.removeEventListener('pointermove', onMove);
          track.removeEventListener('pointerup', onUp);
          track.removeEventListener('pointercancel', onUp);
          handleSeek(ev.clientX, true);
          // Sync final playhead UI after drag release
          this._updateTimelinePlayheadUI();
        };

        track.addEventListener('pointermove', onMove);
        track.addEventListener('pointerup', onUp);
        track.addEventListener('pointercancel', onUp);
      });

      track.addEventListener('click', (e: MouseEvent) => {
        if ((e.target as HTMLElement)?.closest('.timeline-event-marker')) return;
        e.stopPropagation();
        // Avoid reloading twice when pointerup already committed the seek.
        if (Date.now() - lastCommitAt < 400) return;
        handleSeek(e.clientX, true);
      });

      // Compact/TV keyboard support on the scrubber track (D-pad + arrows).
      // Scoped to non-desktop layouts so desktop keyboard behavior is untouched.
      if (isCompactLayout) {
        const seekBySeconds = (deltaSec: number) => {
          if (!this._timelineVideoEl) return;
          const duration = this._timelineEndTs - this._timelineStartTs;
          const maxSeek = (Number.isFinite(this._timelineVideoEl.duration) && this._timelineVideoEl.duration > 0)
            ? Math.max(0, this._timelineVideoEl.duration - 0.5)
            : duration;
          this._timelineVideoEl.currentTime = Math.max(0, Math.min(maxSeek, this._timelineVideoEl.currentTime + deltaSec));
          this._updateTimelinePlayheadUI();
        };
        const jumpToEdge = (edge: 'start' | 'end') => {
          const targetTs = edge === 'start' ? this._timelineStartTs : this._timelineEndTs;
          if (targetTs < this._timelineVodStartTs || targetTs > this._timelineVodEndTs) {
            this._loadTimelineVideo(targetTs);
            return;
          }
          const targetOffset = this._wallClockToVideoOffset(targetTs);
          if (this._timelineVideoEl) {
            this._timelineVideoEl.currentTime = Math.max(0, targetOffset);
            this._updateTimelinePlayheadUI();
          }
        };
        track.addEventListener('keydown', (e: KeyboardEvent) => {
          if (e.key === 'ArrowLeft') {
            e.preventDefault();
            e.stopPropagation();
            seekBySeconds(-10);
          } else if (e.key === 'ArrowRight') {
            e.preventDefault();
            e.stopPropagation();
            seekBySeconds(10);
          } else if (e.key === 'Home') {
            e.preventDefault();
            e.stopPropagation();
            jumpToEdge('start');
          } else if (e.key === 'End') {
            e.preventDefault();
            e.stopPropagation();
            jumpToEdge('end');
          } else if (e.key === 'Enter' || e.key === ' ') {
            // Keep existing Space behavior (play/pause) but make Enter work too for D-pads.
            e.preventDefault();
            e.stopPropagation();
            this._toggleTimelinePlayPause();
          }
        });
      }
    }

    // Compact/TV: close the settings sheet on selection or backdrop tap.
    if (isCompactLayout) {
      container.querySelectorAll('.timeline-settings-sheet [data-jump]').forEach(btn => {
        btn.addEventListener('click', () => {
          container.classList.remove('settings-open');
          settingsBtn?.setAttribute('aria-expanded', 'false');
        });
      });
      container.querySelectorAll('.timeline-settings-sheet .timeline-window-pill').forEach(pill => {
        pill.addEventListener('click', () => {
          container.classList.remove('settings-open');
          settingsBtn?.setAttribute('aria-expanded', 'false');
        });
      });
      const sheetDtInput = container.querySelector('.timeline-settings-sheet .timeline-datetime-input') as HTMLInputElement | null;
      sheetDtInput?.addEventListener('change', () => {
        container.classList.remove('settings-open');
        settingsBtn?.setAttribute('aria-expanded', 'false');
      });
    }
  }

  private async _executeDeleteEvent(event: FrigateEvent): Promise<void> {
    const success = await deleteEvent(event.id, this.hass);

    if (success) {
      // Remove from local events array immediately
      this._events = this._events.filter(e => e.id !== event.id);
      this.requestUpdate();

      if (this._selectedEvent && this._selectedEvent.id === event.id) {
        this._handleModalClose();
      }
    }

    this.dispatchEvent(new CustomEvent('hass-notification', {
      detail: { message: success ? `Event deleted` : `Failed to delete event from Frigate` },
      bubbles: true,
      composed: true,
    }));
  }

  private _formatTime(timestamp: number): string {
    const date = new Date(timestamp * 1000);
    // Let browser locale determine 12/24 hour format, using numeric hour to avoid leading zeros
    return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' }).toUpperCase();
  }

  private _formatDate(timestamp: number): string {
    const date = new Date(timestamp * 1000);
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  }

  private _formatDuration(startTime: number, endTime: number | null): string {
    if (!endTime) return 'Ongoing';
    const durationSeconds = Math.round(endTime - startTime);
    if (durationSeconds < 60) {
      return `${durationSeconds}s`;
    }
    const minutes = Math.floor(durationSeconds / 60);
    const seconds = durationSeconds % 60;
    return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  }

  private _formatZones(zones: string[]): string {
    if (!zones || zones.length === 0) return '';
    return zones.map(zone =>
      zone.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
    ).join(', ');
  }

  private _isValidBoundingBox(box: unknown): box is FrigateBoundingBox {
    return Array.isArray(box) &&
      box.length === 4 &&
      box.every(value => typeof value === 'number' && Number.isFinite(value)) &&
      box[2] > 0 &&
      box[3] > 0;
  }

  private _isNormalizedBox(box: FrigateBoundingBox): boolean {
    return box.every(value => value >= 0 && value <= 1);
  }

  private _getEventBoundingBoxCandidate(event: FrigateEvent): { source: string; box: FrigateBoundingBox } | undefined {
    const candidates: { source: string; box: unknown }[] = [
      { source: 'data.snapshot.box', box: event.data?.snapshot?.box },
      { source: 'data.box', box: event.data?.box },
      { source: 'box', box: event.box },
      { source: 'data.snapshot.region', box: event.data?.snapshot?.region },
      { source: 'data.region', box: event.data?.region },
      { source: 'region', box: event.region },
    ];

    return candidates.find(candidate => this._isValidBoundingBox(candidate.box)) as { source: string; box: FrigateBoundingBox } | undefined;
  }

  private _getEventBoundingBox(event: FrigateEvent): FrigateBoundingBox | undefined {
    return this._getEventBoundingBoxCandidate(event)?.box;
  }

  private _getBoxCenter(box: FrigateBoundingBox, videoWidth: number, videoHeight: number): { x: number; y: number } {
    const [x, y, width, height] = box;

    if (this._isNormalizedBox(box)) {
      return {
        x: (x + width / 2) * videoWidth,
        y: (y + height / 2) * videoHeight,
      };
    }

    return {
      x: x + width / 2,
      y: y + height / 2,
    };
  }

  private _getValidPathData(event: FrigateEvent): FrigatePathPoint[] {
    return (event.data?.path_data || []).filter(point =>
      Array.isArray(point) &&
      point.length === 2 &&
      Array.isArray(point[0]) &&
      point[0].length === 2 &&
      point[0].every(value => typeof value === 'number' && Number.isFinite(value)) &&
      typeof point[1] === 'number' &&
      Number.isFinite(point[1])
    );
  }

  private _getInterpolatedPathPoint(event: FrigateEvent, video: HTMLVideoElement, playbackTime: number): { x: number; y: number } | undefined {
    const pathData = this._getValidPathData(event);
    if (!pathData.length) return undefined;

    const firstPoint = pathData[0];
    const lastPoint = pathData[pathData.length - 1];

    if (playbackTime <= firstPoint[1]) {
      return {
        x: firstPoint[0][0] * video.videoWidth,
        y: firstPoint[0][1] * video.videoHeight,
      };
    }

    if (playbackTime >= lastPoint[1]) {
      return {
        x: lastPoint[0][0] * video.videoWidth,
        y: lastPoint[0][1] * video.videoHeight,
      };
    }

    for (let i = 1; i < pathData.length; i++) {
      const previousPoint = pathData[i - 1];
      const nextPoint = pathData[i];

      if (playbackTime > nextPoint[1]) continue;

      const span = nextPoint[1] - previousPoint[1];
      const progress = span > 0 ? (playbackTime - previousPoint[1]) / span : 0;
      const easedProgress = progress * progress * (3 - (2 * progress));
      const x = previousPoint[0][0] + ((nextPoint[0][0] - previousPoint[0][0]) * easedProgress);
      const y = previousPoint[0][1] + ((nextPoint[0][1] - previousPoint[0][1]) * easedProgress);

      return {
        x: x * video.videoWidth,
        y: y * video.videoHeight,
      };
    }

    return {
      x: lastPoint[0][0] * video.videoWidth,
      y: lastPoint[0][1] * video.videoHeight,
    };
  }

  private _getSmoothedPathPoint(event: FrigateEvent, video: HTMLVideoElement): { x: number; y: number } | undefined {
    if (!event.start_time) return undefined;

    const skipSeconds = this._getConfigValueForEvent(this._config?.video_start_skip_seconds || this._config?.video_start_padding, event, 0);
    const timeOffset = this._getTrackingTimeOffset(event);
    const playbackTime = event.start_time + (video.currentTime - skipSeconds) - timeOffset;

    const userSmoothing = this._config?.tracking_smoothing ?? HOVER_CROP_DEFAULT_SMOOTHING;
    
    // If smoothing is 0, just return the exact point
    if (userSmoothing <= 0.01) {
      return this._getInterpolatedPathPoint(event, video, playbackTime);
    }

    // Map tracking_smoothing (0.0 to 1.0) to a time window (e.g. 0 to 2.0 seconds)
    // 0.5 smoothing = 1.0 second window, which averages keyframes 0.5s ahead and behind
    const windowDuration = userSmoothing * 2.0; 
    const halfWindow = windowDuration / 2;
    
    // Sample multiple points across the window to compute an average
    const sampleCount = 10;
    let totalX = 0;
    let totalY = 0;
    let validSamples = 0;

    for (let i = 0; i <= sampleCount; i++) {
      const sampleTime = (playbackTime - halfWindow) + (windowDuration * (i / sampleCount));
      const point = this._getInterpolatedPathPoint(event, video, sampleTime);
      if (point) {
        totalX += point.x;
        totalY += point.y;
        validSamples++;
      }
    }

    if (validSamples === 0) return undefined;

    return {
      x: totalX / validSamples,
      y: totalY / validSamples
    };
  }

  private _calculateObjectPositionPercentForPoint(
    point: { x: number; y: number },
    video: HTMLVideoElement,
    current?: ObjectPositionPercent
  ): ObjectPositionPercent | undefined {
    const videoWidth = video.videoWidth;
    const videoHeight = video.videoHeight;
    const containerWidth = video.clientWidth;
    const containerHeight = video.clientHeight;

    if (!videoWidth || !videoHeight || !containerWidth || !containerHeight) {
      return undefined;
    }

    const scale = Math.max(containerWidth / videoWidth, containerHeight / videoHeight);
    const renderedWidth = videoWidth * scale;
    const renderedHeight = videoHeight * scale;
    const clamp = (value: number): number => Math.min(100, Math.max(0, value));

    const positionForAxis = (
      containerSize: number,
      renderedSize: number,
      objectCenter: number,
      currentPos?: number
    ): number => {
      // If the video fits exactly or is smaller than the container, center it
      if (renderedSize <= containerSize + 0.5) {
        return 50;
      }

      const slack = renderedSize - containerSize;
      const margin = containerSize * HOVER_CROP_MARGIN_PERCENT;
      const centerInRendered = objectCenter * scale;

      // If we have a current position, check if it's "safe" (object within comfort zone)
      if (currentPos !== undefined) {
        // Range of P that keeps object within [margin, containerSize - margin]
        const pMin = ((centerInRendered - containerSize + margin) / slack) * 100;
        const pMax = ((centerInRendered - margin) / slack) * 100;

        // If current position is already safe, don't move
        if (currentPos >= pMin && currentPos <= pMax) {
          return currentPos;
        }

        // If not safe, move to the nearest edge of the safe zone
        return clamp(Math.min(Math.max(currentPos, pMin), pMax));
      }

      // Default: Center the object
      const perfectPosition = ((centerInRendered - (containerSize / 2)) / slack) * 100;
      return clamp(perfectPosition);
    };

    const x = positionForAxis(containerWidth, renderedWidth, point.x, current?.x);
    const y = positionForAxis(containerHeight, renderedHeight, point.y, current?.y);

    return { x, y };
  }

  private _formatObjectPosition(position: ObjectPositionPercent): string {
    return `${position.x.toFixed(2)}% ${position.y.toFixed(2)}%`;
  }

  private _calculateObjectPositionPercent(
    box: FrigateBoundingBox,
    video: HTMLVideoElement,
    current?: ObjectPositionPercent
  ): ObjectPositionPercent | undefined {
    if (!video.videoWidth || !video.videoHeight) return undefined;

    return this._calculateObjectPositionPercentForPoint(
      this._getBoxCenter(box, video.videoWidth, video.videoHeight),
      video,
      current
    );
  }

  private _getTrackingTimeOffset(frigateEvent: FrigateEvent): number {
    return this._getConfigValueForEvent(this._config?.tracking_pan_delay, frigateEvent, 0) / 1000;
  }

  private _updateHoverVideoObjectPosition(video: HTMLVideoElement, frigateEvent: FrigateEvent): string {
    const pathPoint = this._getSmoothedPathPoint(frigateEvent, video);
    const boxCandidate = this._getEventBoundingBoxCandidate(frigateEvent);
    const current = this._hoverVideoCropPositions.get(video);
    const timeOffset = this._getTrackingTimeOffset(frigateEvent);

    const objectPosition = pathPoint
      ? this._calculateObjectPositionPercentForPoint(pathPoint, video, current)
      : boxCandidate
        ? this._calculateObjectPositionPercent(boxCandidate.box, video, current)
        : undefined;

    if (!objectPosition) {
      this._hoverVideoCropPositions.delete(video);
      video.style.objectPosition = '50% 50%';
      return 'center';
    }

    // Apply a fast follow-ease to prevent a hard 1-frame snap when tracking begins
    const smoothing = 0.15;
    const smoothed = current
      ? {
          x: current.x + ((objectPosition.x - current.x) * smoothing),
          y: current.y + ((objectPosition.y - current.y) * smoothing),
        }
      : objectPosition;

    this._hoverVideoCropPositions.set(video, smoothed);
    video.style.objectPosition = this._formatObjectPosition(smoothed);
    
    let source = pathPoint ? 'data.path_data' : boxCandidate?.source ?? 'center';
    if (timeOffset !== 0) {
      source += ` (${timeOffset > 0 ? '+' : ''}${timeOffset}s delay)`;
    }

    if (this._config?.debug && pathPoint) {
      const pathData = this._getValidPathData(frigateEvent);
      if (pathData.length) {
        const start = pathData[0][1] - (frigateEvent.start_time || 0);
        const end = pathData[pathData.length - 1][1] - (frigateEvent.start_time || 0);
        const skipSeconds = this._getConfigValueForEvent(this._config?.video_start_skip_seconds || this._config?.video_start_padding, frigateEvent, 0);
        // Correct relative tracking time: (V - skip) - offset
        const currentRel = (video.currentTime - skipSeconds) - timeOffset;
        source += ` [V:${video.currentTime.toFixed(1)}s, P:${currentRel.toFixed(1)}s, Range:${start.toFixed(1)}-${end.toFixed(1)}s]`;
      }
    }

    return source;
  }

  private _startHoverVideoTracking(video: HTMLVideoElement, frigateEvent: FrigateEvent): void {
    const update = (): void => {
      if (!video.isConnected || this._hoveredEventId !== frigateEvent.id) return;

      this._updateHoverVideoObjectPosition(video, frigateEvent);
      requestAnimationFrame(update);
    };

    requestAnimationFrame(update);
  }

  private _handleHoverVideoMetadata(event: Event, frigateEvent: FrigateEvent): void {
    const video = event.currentTarget;
    if (!(video instanceof HTMLVideoElement)) return;

    const cropSource = this._updateHoverVideoObjectPosition(video, frigateEvent);

    if (this._config?.debug) {
      const boxCandidate = this._getEventBoundingBoxCandidate(frigateEvent);
      console.debug('Frigate Events Card: hover crop debug', {
        eventId: frigateEvent.id,
        camera: frigateEvent.camera,
        label: frigateEvent.label,
        cropSource,
        chosenBoxSource: boxCandidate?.source ?? null,
        chosenBox: boxCandidate?.box ?? null,
        pathDataPoints: this._getValidPathData(frigateEvent).length,
        candidateBoxes: {
          dataSnapshotBox: frigateEvent.data?.snapshot?.box,
          dataBox: frigateEvent.data?.box,
          box: frigateEvent.box,
          dataSnapshotRegion: frigateEvent.data?.snapshot?.region,
          dataRegion: frigateEvent.data?.region,
          region: frigateEvent.region,
        },
        objectPosition: video.style.objectPosition,
        videoSize: {
          width: video.videoWidth,
          height: video.videoHeight,
        },
        tileSize: {
          width: video.clientWidth,
          height: video.clientHeight,
        },
        event: frigateEvent,
      });
    }

    this._startHoverVideoTracking(video, frigateEvent);
  }

  private _handleVideoTimeUpdate(event: Event, frigateEvent: FrigateEvent): void {
    const video = event.currentTarget as HTMLVideoElement;
    const skipSeconds = this._getConfigValueForEvent(this._config?.video_start_skip_seconds || this._config?.video_start_padding, frigateEvent, 0);
    const endSkipSeconds = this._getConfigValueForEvent(this._config?.video_end_skip_seconds, frigateEvent, 0);

    if (!video.duration || !isFinite(video.duration)) return;

    if (endSkipSeconds > 0) {
      const endTime = Math.max(skipSeconds, video.duration - endSkipSeconds);
      if (video.currentTime >= endTime - 0.1) {
        video.currentTime = skipSeconds;
        video.play().catch(() => {});
      }
    } else if (skipSeconds > 0) {
      if (video.currentTime < skipSeconds && video.currentTime < 1) {
        video.currentTime = skipSeconds;
      }
    }
  }

  private _getLabelIcon(label: string): string {
    return LABEL_ICONS[label.toLowerCase()] || '📷';
  }

  protected render(): TemplateResult {
    if (!this._config) {
      return html`<ha-card>No configuration</ha-card>`;
    }

    const isGrid = this._config.layout === 'grid';
    const isScroll = !isGrid && !!this._config.scroll;
    const showScrollArrows = isScroll && !!this._config.show_scroll_arrows;
    const visibleCount = this._config.event_count || 5;
    const scrollLimit = this._config.scroll_limit || 20;
    const limit = this._config.scroll ? scrollLimit : visibleCount;

    // Filter events based on daily clear time
    let visibleEvents = this._events;
    const resetTimestamp = this._getDailyResetTimestamp();
    if (resetTimestamp !== null) {
      visibleEvents = this._events.filter(e => (e.start_time || 0) > resetTimestamp);
    }

    // Limit to event count and calculate placeholders
    const offset = this._config.offset || 0;
    const eventsToShow = visibleEvents.slice(offset, offset + limit);
    let placeholderCount = Math.max(0, (isScroll ? visibleCount : limit) - eventsToShow.length);
    if (isGrid && this._config.grid_columns && placeholderCount > 0) {
      const totalWithPlaceholders = eventsToShow.length + placeholderCount;
      const roundedTotal = Math.ceil(totalWithPlaceholders / this._config.grid_columns) * this._config.grid_columns;
      placeholderCount = roundedTotal - eventsToShow.length;
    }

    let renderedEvents = eventsToShow.map(event => this._renderEvent(event));
    const hasTempMask = !!(this._config?.show_temp_mask !== false &&
      (this.hass?.services?.['frigate_temp_mask'] || this._getTemporaryMaskSensor(this.hass?.states)));
    const hasTimeline = this._isTimelineEnabled();
    let renderedPlaceholders = Array(placeholderCount).fill(0).map(() =>
      html`<div
        class="placeholder"
        title="No events found. Check that snapshots: enabled: true in Frigate."
        @contextmenu=${(e: MouseEvent) => {
          e.preventDefault();
          e.stopPropagation();
          if (hasTimeline && hasTempMask) {
            this._openLiveViewContextMenu(e.clientX, e.clientY);
          } else if (hasTimeline) {
            this._showTimelineModal();
          } else if (hasTempMask) {
            this._showMaskManagerModal();
          }
        }}
        @touchstart=${(e: TouchEvent) => {
          if (e.touches.length !== 1) return;
          const touch = e.touches[0];
          const cx = touch.clientX;
          const cy = touch.clientY;
          this._liveTouchTimeout = setTimeout(() => {
            if (hasTimeline && hasTempMask) {
              this._openLiveViewContextMenu(cx, cy);
            } else if (hasTimeline) {
              this._showTimelineModal();
            } else if (hasTempMask) {
              this._showMaskManagerModal();
            }
          }, 500);
        }}
        @touchend=${() => { if (this._liveTouchTimeout) { clearTimeout(this._liveTouchTimeout); this._liveTouchTimeout = undefined; } }}
        @touchcancel=${() => { if (this._liveTouchTimeout) { clearTimeout(this._liveTouchTimeout); this._liveTouchTimeout = undefined; } }}
      ></div>`
    );
    
    let allItems = [...renderedEvents, ...renderedPlaceholders];
    if (this._config.reverse) {
      allItems.reverse();
    }

    const eventsClasses = [
      'events',
      isGrid ? 'grid' : '',
      isGrid && this._config.scroll ? 'scrollable-y' : '',
      !isGrid && this._config.scroll ? 'scrollable' : ''
    ].filter(Boolean).join(' ');

    const gridColumns = this._config.grid_columns;
    const gridTemplateColumns = gridColumns
      ? `repeat(${gridColumns}, 1fr)`
      : `repeat(auto-fill, minmax(120px, 1fr))`;
    const gridMaxHeight = this._config.grid_max_height || '400px';

    const eventsStyle = isGrid
      ? `grid-template-columns: ${gridTemplateColumns}; --grid-max-height: ${gridMaxHeight};`
      : `--visible-count: ${visibleCount}; --event-count: ${limit};`;

    return html`
      <ha-card>
        <div class="content">
          ${(this._config?.testing === true ? (this._showVersionOverride ?? false) : !!this._config?.debug) ? html`<div class="debug-version">v${CARD_VERSION}</div>` : ''}
          ${this._config.live_view ? this._renderLiveView() : ''}
          ${html`
                  <div class="events-container">
                    ${showScrollArrows ? html`
                      <button class="scroll-btn prev" @click=${() => this._scroll('left')} aria-label="Previous">
                        <svg viewBox="0 0 24 24">
                          <path d="M15,6L9,12L15,18Z" fill="currentColor"/>
                        </svg>
                      </button>
                      <button class="scroll-btn next" @click=${() => this._scroll('right')} aria-label="Next">
                        <svg viewBox="0 0 24 24">
                          <path d="M9,6L15,12L9,18Z" fill="currentColor"/>
                        </svg>
                      </button>
                    ` : ''}
                    <div class="${eventsClasses}" style="${eventsStyle}">
                      ${allItems}
                    </div>
                  </div>
                `}
        </div>
      </ha-card>
    `;
  }

  private _handleLiveVideoRef = (el: Element | undefined): void => {
    const videoEl = (el as HTMLVideoElement) ?? null;
    this._liveVideoEl = videoEl;
    if (videoEl) {
      videoEl.muted = this._isLiveMuted;
      if (this._boundFullscreenHandler) {
        videoEl.addEventListener('webkitbeginfullscreen', this._boundFullscreenHandler);
        videoEl.addEventListener('webkitendfullscreen', this._boundFullscreenHandler);
        videoEl.addEventListener('fullscreenchange', this._boundFullscreenHandler);
        videoEl.addEventListener('webkitfullscreenchange', this._boundFullscreenHandler);
      }
      if (this._boundFullscreenMouseMoveHandler) {
        videoEl.addEventListener('mousemove', this._boundFullscreenMouseMoveHandler, { capture: true, passive: true });
        videoEl.addEventListener('pointermove', this._boundFullscreenMouseMoveHandler, { capture: true, passive: true });
      }
      videoEl.addEventListener('pause', () => {
        if (this._remoteStream && videoEl.paused) {
          videoEl.play().catch(() => {});
        }
      });
    }
    if (videoEl && this._remoteStream && videoEl.srcObject !== this._remoteStream) {
      videoEl.srcObject = this._remoteStream;
      videoEl.play().catch(() => {});
    }
  };

  private _handleLiveMuteToggle(e: Event): void {
    e.stopPropagation();
    this._isLiveMuted = !this._isLiveMuted;
    if (this._liveVideoEl) {
      this._liveVideoEl.muted = this._isLiveMuted;
      if (!this._isLiveMuted && this._liveVideoEl.paused) {
        this._liveVideoEl.play().catch(() => {});
      }
    }
  }

  /**
   * Render the live WebRTC video feed above the event gallery.
   * The ref() callback attaches incoming media streams to the <video>
   * element as soon as it enters the DOM.
   */
  private _renderLiveView(): TemplateResult {
    const aspectRatio = this._config?.live_view_aspect_ratio || '16 / 9';

    if (this._liveViewError) {
      // While Frigate is off (intentional overnight shutdown), any live
      // error is expected shutdown noise — fall through to the normal video
      // box with no error text. When online, all errors still show since
      // they're helpful when debugging/setup.
      const isShutdownNoise = this._isFrigateOffline();
      if (!isShutdownNoise) {
      return html`
        <div class="live-view-container" style="aspect-ratio: ${aspectRatio};">
          <div class="live-view-error">
            <span>Live feed unavailable</span>
            <span class="live-view-error-detail">${this._liveViewError}</span>
          </div>
        </div>
      `;
      }
    }

    const showMuteBtn = Boolean(this._config?.show_mute || this._config?.live_view_show_mute);
    const mutePosition = this._config?.live_view_mute_position === 'top-left' ? 'top-left' : 'top-right';

    return html`
      <div
        class="live-view-container"
        style="aspect-ratio: ${aspectRatio};"
        @click=${(e: Event) => this._handleLiveViewClick(e)}
        @contextmenu=${(e: MouseEvent) => this._handleLiveViewContextMenu(e)}
        @touchstart=${(e: TouchEvent) => this._handleLiveViewTouchStart(e)}
        @touchmove=${(e: TouchEvent) => this._handleLiveViewTouchMove(e)}
        @touchend=${() => this._handleLiveViewTouchEnd()}
        @touchcancel=${() => this._handleLiveViewTouchEnd()}
      >
        <video
          class="live-view-video"
          autoplay
          .muted=${this._isLiveMuted}
          ?muted=${this._isLiveMuted}
          playsinline
          webkit-playsinline
          disablepictureinpicture
          disableremoteplayback
          poster="data:image/png;base64,iVBORw0KGgoAAAANSU5EUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="
          @click=${(e: Event) => {
            e.preventDefault();
          }}
          @pause=${(e: Event) => {
            const v = e.target as HTMLVideoElement;
            if (v && this._remoteStream && v.paused) {
              v.play().catch(() => {});
            }
          }}
          ${ref(this._handleLiveVideoRef)}
        ></video>
        ${showMuteBtn
          ? html`
              <button
                class="live-view-mute-btn ${mutePosition}"
                title="${this._isLiveMuted ? 'Unmute' : 'Mute'}"
                aria-label="${this._isLiveMuted ? 'Unmute' : 'Mute'}"
                @click=${(e: MouseEvent) => this._handleLiveMuteToggle(e)}
                @pointerdown=${(e: Event) => e.stopPropagation()}
                @touchstart=${(e: TouchEvent) => e.stopPropagation()}
                @touchend=${(e: TouchEvent) => e.stopPropagation()}
              >
                ${this._isLiveMuted
                  ? html`<svg viewBox="0 0 24 24"><path d="M3,9H7L12,4V20L7,15H3V9M16.59,12L14,9.41L15.41,8L18,10.59L20.59,8L22,9.41L19.41,12L22,14.59L20.59,16L18,13.41L15.41,16L14,14.59L16.59,12Z"/></svg>`
                  : html`<svg viewBox="0 0 24 24"><path d="M14,3.23V5.29C16.89,6.15 19,8.83 19,12C19,15.17 16.89,17.84 14,18.7V20.77C18,19.86 21,16.28 21,12C21,7.72 18,4.14 14,3.23M16.5,12C16.5,10.23 15.5,8.71 14,7.97V16.01C15.5,15.29 16.5,13.77 16.5,12M3,9V15H7L12,20V4L7,9H3Z"/></svg>`
                }
              </button>
            `
          : ''}
      </div>
    `;
  }
  private _renderEvent(event: FrigateEvent): TemplateResult {
    const clientId = this._config?.frigate_client_id || 'frigate';
    const snapshotUrl = getEventSnapshotURL(clientId, event.id, {
      bbox: this._config?.show_bounding_box !== false,
      crop: true,
      cacheBust: event.end_time || undefined
    });

    const isHovered = this._hoveredEventId === event.id;
    const playVideoOnHover = !!this._config?.video_on_hover;
    const timeParam = this._getVideoTimeParam(event);
    const clipUrl = getEventClipURL(clientId, event.id) + timeParam;
    const hlsUrl = getEventHlsURL(clientId, event.id) + timeParam;

    const thumbnailUrl = getEventThumbnailURL(clientId, event.id);
    const initialSnapshotUrl = getCachedSignedPath(snapshotUrl) || snapshotUrl;
    const initialThumbnailUrl = getCachedSignedPath(thumbnailUrl) || thumbnailUrl;
    const initialImgUrl = event.has_snapshot !== false ? initialSnapshotUrl : initialThumbnailUrl;

    return html`
      <div class="event"
        @click=${() => this._handleEventClick(event)}
        @contextmenu=${(e: MouseEvent) => this._handleContextMenu(e, event)}
        @touchstart=${(e: TouchEvent) => this._handleTouchStart(e, event)}
        @touchmove=${(e: TouchEvent) => this._handleTouchMove(e)}
        @touchend=${() => this._handleTouchEnd()}
        @touchcancel=${() => this._handleTouchEnd()}
        @mouseenter=${() => { if (playVideoOnHover) this._hoveredEventId = event.id; }}
        @mouseleave=${() => { if (playVideoOnHover) this._hoveredEventId = undefined; }}
        style="position: relative;"
      >
        <img
          src="${initialImgUrl}"
          alt="${event.label}"
          loading="lazy"
          @error=${async (e: Event) => {
            const img = e.target as HTMLImageElement;
            if (!img) return;

            // If not signed yet, attempt to sign the failed URL via HA WebSocket
            if (this.hass && !img.src.includes('authSig=')) {
              try {
                const signed = await signPath(this.hass, img.src);
                const rel = toRelativePath(img.src);
                if (signed && signed !== rel && signed !== img.src) {
                  img.src = signed;
                  return;
                }
              } catch {
                // Ignore signing errors
              }
            }

            // If snapshot failed (even after signed or if signing unavailable), fall back to thumbnail
            if (!img.src.includes('thumbnail')) {
              let thumb = initialThumbnailUrl;
              if (this.hass && !thumb.includes('authSig=')) {
                try {
                  thumb = await signPath(this.hass, thumbnailUrl);
                } catch {
                  // Ignore signing errors
                }
              }
              img.src = thumb;
              return;
            }
          }}
        />
        ${playVideoOnHover && isHovered
          ? html`<video
                   autoplay
                   muted
                   .muted=${true}
                   loop
                   playsinline
                   @loadedmetadata=${(ev: Event) => this._handleHoverVideoMetadata(ev, event)}
                   @timeupdate=${(ev: Event) => this._handleVideoTimeUpdate(ev, event)}
                   style="position: absolute; top: 0; left: 0; z-index: 2; width: 100%; height: 100%; object-fit: cover; pointer-events: none;"
                 >
                   <source src="${clipUrl}" type="video/mp4">
                   <source src="${hlsUrl}" type="application/x-mpegURL">
                 </video>`          : ''
        }
      </div>
    `;
  }


  private _scroll(direction: 'left' | 'right'): void {
    const container = this.renderRoot.querySelector('.events');
    if (!container) return;
    const scrollAmount = container.clientWidth * 0.8;
    container.scrollBy({
      left: direction === 'left' ? -scrollAmount : scrollAmount,
      behavior: 'smooth'
    });
  }

  private _capitalize(str: string): string {
    return str.charAt(0).toUpperCase() + str.slice(1);
  }

  private _formatCameraName(name: string): string {
    return name.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  }

  static get styles(): CSSResult {
    return css`
      :host {
        display: block;
      }

      ha-card {
        overflow: hidden;
        background: transparent;
        box-shadow: none;
        width: 100%;
      }

      .content {
        padding: 0;
      }

      .loading {
        min-height: 80px;
      }

      .events-container {
        position: relative;
        width: 100%;
      }

      .scroll-btn {
        position: absolute;
        top: 50%;
        transform: translateY(-50%);
        z-index: 10;
        width: 32px;
        height: 32px;
        border-radius: 50%;
        background: rgba(0, 0, 0, 0.5);
        color: white;
        border: none;
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        opacity: 0;
        transition: opacity 0.3s, background-color 0.2s, transform 0.2s;
        backdrop-filter: blur(4px);
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
      }

      .scroll-btn.prev {
        left: 8px;
      }

      .scroll-btn.next {
        right: 8px;
      }

      .scroll-btn svg {
        width: 18px;
        height: 18px;
        fill: currentColor;
        display: block;
      }

      .events-container:hover .scroll-btn {
        opacity: 1;
      }

      .scroll-btn:hover {
        background: rgba(0, 0, 0, 0.8);
        transform: translateY(-50%) scale(1.1);
      }

      .scroll-btn:active {
        transform: translateY(-50%) scale(0.95);
      }

      .events {
        display: grid;
        grid-template-columns: repeat(var(--visible-count, 5), 1fr);
        gap: 9px;
        align-items: start;
      }

      .events.scrollable {
        display: flex;
        flex-wrap: nowrap;
        overflow-x: auto;
        overflow-y: hidden;
        scroll-snap-type: x mandatory;
        -webkit-overflow-scrolling: touch;
        scroll-behavior: smooth;
        grid-template-columns: none;
        -ms-overflow-style: none;
        scrollbar-width: none;
        align-items: start;
      }

      .events.scrollable::-webkit-scrollbar {
        display: none;
      }

      .events.scrollable .event,
      .events.scrollable .placeholder {
        flex: 0 0 calc((100% - (var(--visible-count, 5) - 1) * 9px) / var(--visible-count, 5));
        scroll-snap-align: start;
        box-sizing: border-box;
      }

      .events.grid {
        display: grid;
        grid-template-columns: var(--grid-template-columns, repeat(auto-fill, minmax(120px, 1fr)));
        gap: 9px;
        align-items: start;
      }

      .events.grid.scrollable-y {
        max-height: var(--grid-max-height, 400px);
        overflow-y: auto;
        overflow-x: hidden;
        padding-right: 4px;
      }

      .events.grid.scrollable-y::-webkit-scrollbar {
        width: 6px;
      }

      .events.grid.scrollable-y::-webkit-scrollbar-track {
        background: transparent;
      }

      .events.grid.scrollable-y::-webkit-scrollbar-thumb {
        background: rgba(255, 255, 255, 0.2);
        border-radius: 3px;
      }

      .events.grid.scrollable-y::-webkit-scrollbar-thumb:hover {
        background: rgba(255, 255, 255, 0.4);
      }

      .event {
        aspect-ratio: 1 / 1;
        cursor: pointer;
        border-radius: 12px;
        overflow: hidden;
        background: var(--secondary-background-color);
        transition: transform 0.2s, opacity 0.2s;
        -webkit-touch-callout: none !important;
        -webkit-user-select: none !important;
        user-select: none !important;
        touch-action: pan-x pan-y;
      }

      .event:hover {
        transform: scale(1.02);
        opacity: 0.9;
      }

      .event:active {
        transform: scale(0.98);
      }

      .placeholder {
        aspect-ratio: 1 / 1;
        border-radius: 12px;
        background: #1c1c1c;
        -webkit-touch-callout: none !important;
        -webkit-user-select: none !important;
        user-select: none !important;
        touch-action: pan-x pan-y;
      }

      .event img,
      .event video {
        width: 100%;
        height: 100%;
        object-fit: cover;
        display: block;
        -webkit-touch-callout: none !important;
        -webkit-user-select: none !important;
        -webkit-user-drag: none !important;
        user-select: none !important;
        pointer-events: none !important;
      }
      
      .debug-version {
        font-size: 10px;
        color: var(--secondary-text-color, #aaa);
        padding: 2px 8px;
        text-align: right;
        font-family: monospace;
        opacity: 0.8;
      }

      /* ─── Live view ────────────────────────────────────────── */

      .live-view-container {
        width: 100%;
        aspect-ratio: 16 / 9;
        background: #1c1c1c;
        border-radius: 12px;
        overflow: hidden;
        margin-bottom: 8px;
        position: relative;
        cursor: pointer;
        -webkit-touch-callout: none !important;
        -webkit-user-select: none !important;
        user-select: none !important;
        touch-action: manipulation;
      }

      .live-view-video {
        width: 100%;
        height: 100%;
        object-fit: contain;
        display: block;
        background-color: #1c1c1c;
        transform: translateZ(0);
        will-change: transform;
        -webkit-touch-callout: none !important;
        -webkit-user-select: none !important;
        user-select: none !important;
        pointer-events: none !important;
      }

      .live-view-container:fullscreen,
      .live-view-container:-webkit-full-screen {
        width: 100vw;
        height: 100vh;
        aspect-ratio: unset !important;
        border-radius: 0;
        margin-bottom: 0;
        background: #000;
      }

      .live-view-container:fullscreen .live-view-video,
      .live-view-container:-webkit-full-screen .live-view-video {
        width: 100%;
        height: 100%;
        object-fit: contain;
      }

      .live-view-video.fullscreen-active,
      .live-view-video:fullscreen,
      .live-view-video:-webkit-full-screen {
        pointer-events: auto !important;
        width: 100vw !important;
        height: 100vh !important;
        object-fit: contain !important;
      }

      .hide-cursor,
      .hide-cursor *,
      .live-view-container.hide-cursor,
      .live-view-video.hide-cursor,
      video.hide-cursor {
        cursor: none !important;
      }

      /* Hide WebKit / Blink default media controls and play button overlays on TV browsers */
      .live-view-video::-webkit-media-controls,
      .live-view-video::-webkit-media-controls-start-playback-button,
      .live-view-video::-webkit-media-controls-play-button,
      .live-view-video::-webkit-media-controls-overlay-play-button,
      .live-view-video::-webkit-media-controls-enclosure {
        display: none !important;
        -webkit-appearance: none !important;
      }

      .live-view-error {
        position: absolute;
        inset: 0;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 6px;
        color: var(--secondary-text-color, #aaa);
        font-size: 13px;
      }

      .live-view-error-detail {
        font-size: 11px;
        opacity: 0.7;
        max-width: 80%;
        text-align: center;
      }

      .live-view-mute-btn,
      .timeline-mute-btn {
        position: absolute;
        top: 10px;
        right: 10px;
        z-index: 5;
        width: 34px;
        height: 34px;
        border-radius: 50%;
        background: rgba(0, 0, 0, 0.55);
        backdrop-filter: blur(4px);
        -webkit-backdrop-filter: blur(4px);
        border: none;
        color: #ffffff;
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        padding: 0;
        opacity: 0;
        pointer-events: auto;
        transition: opacity 0.2s ease, background 0.2s ease, transform 0.15s ease;
      }

      .live-view-mute-btn.top-left,
      .timeline-mute-btn.top-left {
        left: 10px;
        right: auto;
      }

      .live-view-mute-btn.top-right,
      .timeline-mute-btn.top-right {
        right: 10px;
        left: auto;
      }

      .live-view-container:hover .live-view-mute-btn,
      .timeline-player-container:hover .timeline-mute-btn {
        opacity: 0.85;
      }

      .live-view-mute-btn:hover,
      .timeline-mute-btn:hover {
        opacity: 1 !important;
        background: rgba(0, 0, 0, 0.8);
        transform: scale(1.08);
      }

      .live-view-mute-btn:active,
      .timeline-mute-btn:active {
        transform: scale(0.95);
      }

      .live-view-mute-btn svg,
      .timeline-mute-btn svg {
        width: 18px;
        height: 18px;
        fill: currentColor;
      }

    `;
  }
}

// Register the card with Home Assistant
declare global {
  interface HTMLElementTagNameMap {
    'frigate-events-card': FrigateEventsCard;
  }
}

// Card registration for HA
(window as any).customCards = (window as any).customCards || [];
(window as any).customCards.push({
  type: 'frigate-events-card',
  name: 'Frigate Events Card',
  description: 'A simple card for displaying recent Frigate detection events',
  preview: true,
  documentationURL: 'https://github.com/saihgupr/frigate-events-card',
});

console.info(
  `%c FRIGATE-EVENTS-CARD v${CARD_VERSION} %c Loaded `,
  'color: white; background: #3b82f6; font-weight: bold;',
  'color: #3b82f6; background: white;'
);
