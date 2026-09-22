/**
 * Frigate Events Card - A simple Lovelace card for displaying recent Frigate events
 */
import { LitElement, html, css, PropertyValues, TemplateResult, CSSResult } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { ref } from 'lit/directives/ref.js';
import { HomeAssistant, LovelaceCardConfig, LovelaceLayoutOptions } from './ha/types';
import { FrigateBoundingBox, FrigateEvent, FrigateEventChange, FrigatePathPoint } from './frigate/types';
import { getEvents, getRecordings, getEventSnapshotURL, getEventThumbnailURL, subscribeToEvents, getEventClipURL, getEventHlsURL, getVodClipURL, getVodHlsURL, deleteEvent } from './frigate/api';
import Hls from 'hls.js';

const CARD_VERSION = '2.4.50';

// How often to poll for new events as a fallback (in ms)
// This handles cases where WebSocket subscriptions silently die
const FALLBACK_POLL_INTERVAL = 10000; // 10 seconds
const HOVER_CROP_DEFAULT_SMOOTHING = 1.0; // 0.0 is jerky, 1.0 is smoothest
const HOVER_CROP_MARGIN_PERCENT = 0.20; // 20% margin on each side of the container

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
  go2rtc_url?: string;              // Optional direct go2rtc URL (e.g. 'http://192.168.1.211:1984')
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
  @state() private _events: FrigateEvent[] = [];
  @state() private _selectedEvent?: FrigateEvent;
  @state() private _loading = true;
  @state() private _error?: string;
  @state() private _hoveredEventId?: string;
  @state() private _liveViewError?: string;   // Set when live feed fails gracefully
  @state() private _isLiveMuted = true;
  @state() private _maskManagerSelectedCamera = 'all';
  @state() private _localPendingMasks: any[] = [];

  private _unsubscribe?: () => void;
  private _pollInterval?: number;
  private _boundVisibilityHandler?: () => void;
  private _boundKeyDownHandler?: (e: KeyboardEvent) => void;
  private _modalContainer?: HTMLDivElement;
  private _maskManagerContainer?: HTMLDivElement;
  private _maskManagerTimer?: ReturnType<typeof setInterval>;
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
  private _timelineWindowDurationSec = 3600; // default 1 hour
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
    // active masks changed.
    if (changedProps.has('hass') && changedProps.size === 1) {
      const oldHass = changedProps.get('hass') as HomeAssistant | undefined;
      if (oldHass !== undefined) {
        if (this.hass && !this._unsubscribe) {
          this._subscribeToEvents();
        }
        const oldMasks = oldHass?.states?.['sensor.frigate_active_masks'];
        const newMasks = this.hass?.states?.['sensor.frigate_active_masks'];
        if (oldMasks !== newMasks) {
          if (this._maskManagerContainer) {
            this._renderMaskManagerContent(this._maskManagerContainer);
          }
          return true;
        }
        return false;
      }
    }
    return true;
  }

  protected async firstUpdated(): Promise<void> {
    await this._loadEvents();
    await this._subscribeToEvents();
    this._setupVisibilityHandler();
    this._setupPolling();
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
    const container = e.currentTarget as HTMLElement;
    const videoEl = this._liveVideoEl || container.querySelector('video');

    // Check if element or document is currently fullscreen
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fsDoc = document as any;
    const isFullscreen = !!(
      fsDoc.fullscreenElement ||
      fsDoc.webkitFullscreenElement ||
      fsDoc.mozFullScreenElement ||
      fsDoc.msFullscreenElement
    );

    if (isFullscreen) {
      if (document.exitFullscreen) {
        document.exitFullscreen().catch(() => {});
      } else if (fsDoc.webkitExitFullscreen) {
        fsDoc.webkitExitFullscreen();
      } else if (fsDoc.mozCancelFullScreen) {
        fsDoc.mozCancelFullScreen();
      } else if (fsDoc.msExitFullscreen) {
        fsDoc.msExitFullscreen();
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

  private async _loadEvents(): Promise<void> {
    if (!this.hass || !this._config) return;

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

      /* ─── Mask Manager Modal Styles ─── */
      .frigate-mask-manager-modal .frigate-events-modal-content {
        min-width: min(580px, 94vw);
        max-width: 640px;
        max-height: 85vh;
        border: 1px solid rgba(255, 255, 255, 0.12);
        box-shadow: 0 20px 40px rgba(0, 0, 0, 0.7);
        background: #181818;
      }

      .mask-manager-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 16px 20px;
        border-bottom: 1px solid rgba(255, 255, 255, 0.1);
        background: rgba(26, 26, 26, 0.98);
      }

      .mask-manager-header-left {
        display: flex;
        align-items: center;
        gap: 10px;
      }

      .mask-manager-title {
        font-size: 16px;
        font-weight: 600;
        color: #ffffff;
        display: flex;
        align-items: center;
        gap: 8px;
      }

      .mask-manager-count-badge {
        font-size: 11px;
        padding: 2px 8px;
        border-radius: 10px;
        background: rgba(59, 130, 246, 0.2);
        color: #93c5fd;
        border: 1px solid rgba(59, 130, 246, 0.35);
        font-weight: 600;
      }

      .mask-manager-header-actions {
        display: flex;
        align-items: center;
        gap: 8px;
      }

      .mask-manager-body {
        padding: 16px 20px;
        overflow-y: auto;
        max-height: calc(85vh - 75px);
        display: flex;
        flex-direction: column;
        gap: 12px;
        box-sizing: border-box;
      }

      .mask-filter-tabs {
        display: flex;
        gap: 6px;
        overflow-x: auto;
        padding-bottom: 4px;
        border-bottom: 1px solid rgba(255, 255, 255, 0.08);
      }

      .mask-filter-tab {
        padding: 4px 10px;
        border-radius: 6px;
        font-size: 12px;
        font-weight: 500;
        color: #aaa;
        background: transparent;
        border: 1px solid rgba(255, 255, 255, 0.12);
        cursor: pointer;
        transition: all 0.15s;
        font-family: inherit;
        white-space: nowrap;
      }

      .mask-filter-tab:hover {
        background: rgba(255, 255, 255, 0.08);
        color: #fff;
      }

      .mask-filter-tab.active {
        background: rgba(59, 130, 246, 0.25);
        color: #93c5fd;
        border-color: #3b82f6;
      }

      .mask-cards-list {
        display: flex;
        flex-direction: column;
        gap: 10px;
      }

      .mask-card {
        background: rgba(255, 255, 255, 0.04);
        border: 1px solid rgba(255, 255, 255, 0.1);
        border-radius: 10px;
        padding: 14px;
        display: flex;
        flex-direction: column;
        gap: 10px;
        transition: border-color 0.15s;
      }

      .mask-card:hover {
        border-color: rgba(96, 165, 250, 0.4);
      }

      .mask-card-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        flex-wrap: wrap;
      }

      .mask-card-title-col {
        display: flex;
        align-items: center;
        gap: 8px;
      }

      .mask-card-main-row {
        display: flex;
        gap: 12px;
        align-items: stretch;
      }

      .mask-visual-preview {
        position: relative;
        width: 120px;
        min-width: 120px;
        aspect-ratio: 16 / 9;
        height: auto;
        border-radius: 6px;
        overflow: hidden;
        background: radial-gradient(circle at center, #1e293b 0%, #0f172a 100%);
        border: none;
        flex-shrink: 0;
        display: flex;
        align-items: center;
        justify-content: center;
      }

      .mask-preview-thumb {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
        object-fit: cover;
        display: block;
        z-index: 1;
      }

      .mask-preview-minimap {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
        z-index: 2;
        pointer-events: none;
      }

      .mask-preview-minimap svg {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
      }

      .minimap-poly {
        fill: rgba(59, 130, 246, 0.45);
        stroke: #60a5fa;
        stroke-width: 2.5px;
        vector-effect: non-scaling-stroke;
        filter: drop-shadow(0 0 3px rgba(59, 130, 246, 0.8));
      }

      .mask-card.pending-restart .minimap-poly {
        fill: rgba(245, 158, 11, 0.3);
        stroke: #fbbf24;
        stroke-dasharray: 4 2;
      }

      .minimap-pos-tag {
        position: absolute;
        bottom: 3px;
        left: 4px;
        font-size: 9px;
        font-weight: 600;
        color: #93c5fd;
        background: rgba(15, 23, 42, 0.9);
        border: 1px solid rgba(96, 165, 250, 0.4);
        padding: 1px 5px;
        border-radius: 3px;
        z-index: 3;
        line-height: 1.2;
        backdrop-filter: blur(2px);
      }

      .mask-card-info {
        flex: 1;
        min-width: 0;
        display: flex;
        flex-direction: column;
        justify-content: space-between;
        gap: 6px;
      }

      .mask-object-pill {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        padding: 2px 7px;
        border-radius: 4px;
        font-size: 11px;
        font-weight: 600;
        background: rgba(59, 130, 246, 0.2);
        color: #93c5fd;
        border: 1px solid rgba(59, 130, 246, 0.4);
        text-transform: capitalize;
      }

      .mask-camera-pill {
        font-size: 12px;
        font-weight: 600;
        color: #fff;
        background: rgba(255, 255, 255, 0.12);
        padding: 3px 8px;
        border-radius: 4px;
        text-transform: capitalize;
      }

      .mask-id-pill {
        font-size: 11px;
        font-family: monospace;
        color: #94a3b8;
        background: rgba(0, 0, 0, 0.35);
        padding: 3px 6px;
        border-radius: 4px;
      }

      .mask-card-time-badge {
        display: flex;
        align-items: center;
        gap: 5px;
        font-size: 12px;
        font-weight: 600;
        color: #38bdf8;
        background: rgba(56, 189, 248, 0.15);
        padding: 3px 8px;
        border-radius: 4px;
      }

      .mask-card-time-badge.expiring {
        color: #fbbf24;
        background: rgba(251, 191, 36, 0.15);
      }

      .mask-card-details {
        display: flex;
        flex-direction: column;
        gap: 4px;
        font-size: 12px;
        color: #aaa;
        background: rgba(0, 0, 0, 0.25);
        padding: 6px 8px;
        border-radius: 6px;
      }

      .mask-detail-row {
        display: flex;
        gap: 8px;
        align-items: center;
      }

      .mask-detail-row .detail-label {
        color: #888;
        font-size: 11px;
      }

      .mask-detail-row .detail-value {
        color: #ddd;
        font-size: 12px;
      }

      .mask-detail-row .detail-value.mono {
        font-family: monospace;
        font-size: 11px;
        color: #94a3b8;
        word-break: break-all;
      }

      .mask-card-actions {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        flex-wrap: wrap;
        padding-top: 2px;
      }

      .mask-duration-selector {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
      }

      .mask-duration-selector .duration-title {
        font-size: 11px;
        color: #888;
        font-weight: 500;
      }

      .mask-duration-chips {
        display: flex;
        flex-wrap: wrap;
        gap: 4px;
        align-items: center;
      }

      .mask-duration-chip {
        padding: 3px 7px;
        border-radius: 4px;
        font-size: 11px;
        font-weight: 500;
        background: rgba(255, 255, 255, 0.08);
        color: #ddd;
        border: 1px solid rgba(255, 255, 255, 0.12);
        cursor: pointer;
        transition: all 0.15s;
        font-family: inherit;
      }

      .mask-duration-chip:hover {
        background: rgba(255, 255, 255, 0.18);
        color: #fff;
      }

      .mask-duration-chip.active {
        background: rgba(59, 130, 246, 0.3);
        color: #93c5fd;
        border-color: #60a5fa;
        font-weight: 600;
      }

      .mask-remove-btn {
        display: flex;
        align-items: center;
        gap: 5px;
        padding: 5px 10px;
        border-radius: 6px;
        font-size: 12px;
        font-weight: 600;
        color: #cbd5e1;
        background: rgba(255, 255, 255, 0.08);
        border: 1px solid rgba(255, 255, 255, 0.18);
        cursor: pointer;
        transition: all 0.15s;
        font-family: inherit;
        margin-left: auto;
      }

      .mask-remove-btn:hover {
        background: rgba(255, 255, 255, 0.18);
        color: #ffffff;
        border-color: rgba(255, 255, 255, 0.28);
      }

      .mask-empty-state,
      .mask-manager-empty {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        text-align: center;
        padding: 36px 20px;
        gap: 10px;
        color: #888;
      }

      .mask-empty-state svg,
      .mask-manager-empty svg {
        width: 44px;
        height: 44px;
        fill: #475569;
        flex-shrink: 0;
      }

      .mask-empty-state h3,
      .mask-empty-state h4,
      .mask-manager-empty h3,
      .mask-manager-empty h4 {
        margin: 0;
        font-size: 15px;
        color: #cbd5e1;
        font-weight: 600;
      }

      .mask-empty-state p,
      .mask-manager-empty p {
        margin: 0;
        font-size: 13px;
        max-width: 380px;
        line-height: 1.5;
        color: #71717a;
      }

      .mask-manager-header-restart-btn {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 4px 9px;
        border-radius: 6px;
        font-size: 11px;
        font-weight: 500;
        color: #cbd5e1;
        background: rgba(255, 255, 255, 0.08);
        border: 1px solid rgba(255, 255, 255, 0.15);
        cursor: pointer;
        transition: all 0.15s;
        font-family: inherit;
      }

      .mask-manager-header-restart-btn:hover {
        background: rgba(255, 255, 255, 0.15);
        color: #fff;
        border-color: rgba(255, 255, 255, 0.25);
      }

      .mask-manager-header-restart-btn svg {
        width: 13px;
        height: 13px;
        fill: currentColor;
      }

      .pending-masks-section {
        margin-top: 10px;
        padding-top: 10px;
        border-top: 1px solid rgba(255, 255, 255, 0.08);
        display: flex;
        flex-direction: column;
        gap: 8px;
      }

      .pending-section-title {
        display: flex;
        align-items: center;
        justify-content: space-between;
        font-size: 11px;
        font-weight: 600;
        color: #64748b;
        text-transform: uppercase;
        letter-spacing: 0.5px;
      }

      .mask-section-dismiss-all-btn {
        background: transparent;
        border: none;
        color: #60a5fa;
        font-size: 10px;
        font-weight: 500;
        cursor: pointer;
        padding: 2px 6px;
        border-radius: 4px;
        text-transform: none;
        transition: all 0.15s;
      }

      .mask-section-dismiss-all-btn:hover {
        background: rgba(96, 165, 250, 0.15);
        color: #93c5fd;
      }

      .mask-card.pending-restart {
        opacity: 0.75;
        border-style: dashed;
      }

      .mask-card-time-badge.pending {
        background: rgba(255, 255, 255, 0.08);
        color: #94a3b8;
      }

      .mask-card-pending-actions {
        display: flex;
        align-items: center;
        gap: 6px;
        margin-left: auto;
      }

      .mask-pending-dismiss-action {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        padding: 4px 8px;
        border-radius: 5px;
        font-size: 11px;
        font-weight: 500;
        color: #94a3b8;
        background: rgba(255, 255, 255, 0.04);
        border: 1px solid rgba(255, 255, 255, 0.1);
        cursor: pointer;
        transition: all 0.15s;
        font-family: inherit;
      }

      .mask-pending-dismiss-action:hover {
        background: rgba(239, 68, 68, 0.15);
        color: #f87171;
        border-color: rgba(239, 68, 68, 0.3);
      }

      .mask-pending-dismiss-action svg {
        width: 12px;
        height: 12px;
        fill: currentColor;
      }

      .mask-pending-restart-action {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        padding: 4px 8px;
        border-radius: 5px;
        font-size: 11px;
        font-weight: 500;
        color: #94a3b8;
        background: rgba(255, 255, 255, 0.06);
        border: 1px solid rgba(255, 255, 255, 0.12);
        cursor: pointer;
        transition: all 0.15s;
        font-family: inherit;
      }

      .mask-pending-restart-action:hover {
        background: rgba(255, 255, 255, 0.12);
        color: #e2e8f0;
      }

      .mask-pending-restart-action svg {
        width: 12px;
        height: 12px;
        fill: currentColor;
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

      /* ─── Timeline Modal Styles ─── */
      .frigate-timeline-modal .frigate-events-modal-content {
        width: min(860px, 95vw);
        min-width: min(860px, 95vw);
        max-width: 900px;
        max-height: 92vh;
        border: 1px solid rgba(255, 255, 255, 0.12);
        box-shadow: 0 24px 48px rgba(0, 0, 0, 0.8);
        background: #161616;
        display: flex;
        flex-direction: column;
      }

      .timeline-modal-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 14px 20px;
        border-bottom: 1px solid rgba(255, 255, 255, 0.1);
        background: rgba(24, 24, 24, 0.98);
      }

      .timeline-modal-header-left {
        display: flex;
        align-items: center;
        gap: 10px;
      }

      .timeline-modal-title {
        font-size: 16px;
        font-weight: 600;
        color: #ffffff;
        display: flex;
        align-items: center;
        gap: 8px;
        margin: 0;
      }

      .timeline-modal-title svg {
        width: 18px;
        height: 18px;
        fill: #60a5fa;
      }

      .timeline-camera-badge {
        font-size: 11px;
        padding: 2px 8px;
        border-radius: 10px;
        background: rgba(59, 130, 246, 0.2);
        color: #93c5fd;
        border: 1px solid rgba(59, 130, 246, 0.35);
        font-weight: 600;
      }

      .timeline-modal-body {
        padding: 16px 20px;
        overflow-y: auto;
        display: flex;
        flex-direction: column;
        gap: 14px;
        box-sizing: border-box;
      }

      .timeline-camera-tabs {
        display: flex;
        gap: 6px;
        overflow-x: auto;
        padding-bottom: 4px;
        border-bottom: 1px solid rgba(255, 255, 255, 0.08);
      }

      .timeline-camera-tab {
        padding: 5px 12px;
        border-radius: 6px;
        font-size: 12px;
        font-weight: 500;
        color: #aaa;
        background: transparent;
        border: 1px solid rgba(255, 255, 255, 0.12);
        cursor: pointer;
        transition: all 0.15s;
        font-family: inherit;
        white-space: nowrap;
      }

      .timeline-camera-tab:hover {
        background: rgba(255, 255, 255, 0.08);
        color: #fff;
      }

      .timeline-camera-tab.active {
        background: rgba(59, 130, 246, 0.25);
        color: #93c5fd;
        border-color: #3b82f6;
      }

      /* Time & Window Controls Row */
      .timeline-controls-bar {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        background: rgba(255, 255, 255, 0.03);
        padding: 10px 14px;
        border-radius: 8px;
        border: 1px solid rgba(255, 255, 255, 0.06);
      }

      .timeline-datetime-group {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
      }

      .timeline-datetime-label {
        font-size: 12px;
        font-weight: 500;
        color: #94a3b8;
      }

      .timeline-datetime-input {
        background: rgba(0, 0, 0, 0.4);
        border: 1px solid rgba(255, 255, 255, 0.15);
        color: #ffffff;
        padding: 5px 10px;
        border-radius: 6px;
        font-size: 12px;
        font-family: inherit;
        outline: none;
        transition: border-color 0.15s;
      }

      .timeline-datetime-input:focus {
        border-color: #3b82f6;
      }

      .timeline-quick-jumps {
        display: flex;
        align-items: center;
        gap: 4px;
        flex-wrap: wrap;
      }

      .timeline-quick-btn {
        padding: 3px 8px;
        font-size: 11px;
        font-weight: 500;
        border-radius: 4px;
        background: rgba(255, 255, 255, 0.06);
        color: #cbd5e1;
        border: 1px solid rgba(255, 255, 255, 0.08);
        cursor: pointer;
        transition: all 0.15s;
        font-family: inherit;
      }

      .timeline-quick-btn:hover {
        background: rgba(255, 255, 255, 0.12);
        color: #ffffff;
      }

      .timeline-window-group {
        display: flex;
        align-items: center;
        gap: 6px;
      }

      .timeline-window-pills {
        display: flex;
        gap: 4px;
      }

      .timeline-window-pill {
        padding: 3px 8px;
        font-size: 11px;
        font-weight: 500;
        border-radius: 4px;
        background: transparent;
        color: #94a3b8;
        border: 1px solid rgba(255, 255, 255, 0.1);
        cursor: pointer;
        transition: all 0.15s;
        font-family: inherit;
      }

      .timeline-window-pill.active {
        background: rgba(59, 130, 246, 0.25);
        color: #93c5fd;
        border-color: #3b82f6;
      }

      /* Video Player Container */
      .timeline-player-container {
        position: relative;
        width: 100%;
        aspect-ratio: 16 / 9;
        background: #000000;
        border-radius: 10px;
        overflow: hidden;
        display: flex;
        align-items: center;
        justify-content: center;
        box-shadow: inset 0 0 20px rgba(0, 0, 0, 0.6);
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
        gap: 10px;
        background: rgba(0, 0, 0, 0.6);
        color: #94a3b8;
        font-size: 13px;
        z-index: 5;
        pointer-events: none;
        transition: opacity 0.15s ease;
      }

      .timeline-player-loading.subtle {
        background: transparent;
      }

      .timeline-spinner {
        width: 32px;
        height: 32px;
        border: 3px solid rgba(255, 255, 255, 0.1);
        border-top-color: #3b82f6;
        border-radius: 50%;
        animation: timeline-spin 0.8s linear infinite;
      }

      @keyframes timeline-spin {
        to { transform: rotate(360deg); }
      }

      .timeline-mute-btn {
        position: absolute;
        top: 10px;
        right: 10px;
        z-index: 10;
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

      .timeline-mute-btn.top-left {
        left: 10px;
        right: auto;
      }

      .timeline-mute-btn.top-right {
        right: 10px;
        left: auto;
      }

      .timeline-player-container:hover .timeline-mute-btn {
        opacity: 0.85;
      }

      .timeline-mute-btn:hover {
        opacity: 1 !important;
        background: rgba(0, 0, 0, 0.8);
        transform: scale(1.08);
      }

      .timeline-mute-btn:active {
        transform: scale(0.95);
      }

      .timeline-mute-btn svg {
        width: 18px;
        height: 18px;
        fill: currentColor;
      }

      /* Scrubber Track Area */
      .timeline-scrubber-wrapper {
        display: flex;
        flex-direction: column;
        gap: 6px;
        background: rgba(255, 255, 255, 0.03);
        padding: 12px 14px;
        border-radius: 8px;
        border: 1px solid rgba(255, 255, 255, 0.06);
      }

      .timeline-track-container {
        position: relative;
        height: 36px;
        background: rgba(255, 255, 255, 0.08);
        border-radius: 6px;
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
        top: 2px;
        bottom: 2px;
        background: rgba(59, 130, 246, 0.7);
        border-radius: 3px;
        cursor: pointer;
        pointer-events: auto;
        transition: transform 0.15s, background 0.15s;
        z-index: 2;
      }

      .timeline-event-marker:hover {
        background: #60a5fa;
        transform: scaleY(1.1);
        z-index: 4;
      }

      .timeline-event-marker.person { background: rgba(59, 130, 246, 0.8); }
      .timeline-event-marker.car { background: rgba(245, 158, 11, 0.8); }
      .timeline-event-marker.dog, .timeline-event-marker.cat { background: rgba(16, 185, 129, 0.8); }

      .timeline-playhead {
        position: absolute;
        top: 0;
        bottom: 0;
        width: 3px;
        background: #ef4444;
        box-shadow: 0 0 8px #ef4444;
        z-index: 5;
        pointer-events: none;
        transform: translateX(-50%);
      }

      .timeline-playhead::after {
        content: '';
        position: absolute;
        top: 0;
        left: 50%;
        transform: translateX(-50%);
        width: 9px;
        height: 9px;
        background: #ef4444;
        border-radius: 50%;
      }

      .timeline-track-labels {
        display: flex;
        justify-content: space-between;
        font-size: 11px;
        color: #94a3b8;
        font-family: monospace;
      }

      /* Transport & Speed Row */
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
        gap: 6px;
      }

      .timeline-transport-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        background: rgba(255, 255, 255, 0.06);
        border: 1px solid rgba(255, 255, 255, 0.1);
        color: #ffffff;
        padding: 6px 10px;
        border-radius: 6px;
        font-size: 12px;
        font-weight: 500;
        cursor: pointer;
        transition: all 0.15s;
        font-family: inherit;
      }

      .timeline-transport-btn:hover {
        background: rgba(255, 255, 255, 0.15);
      }

      .timeline-transport-btn.play-btn {
        background: #3b82f6;
        border-color: #2563eb;
        padding: 6px 14px;
      }

      .timeline-transport-btn.play-btn:hover {
        background: #2563eb;
      }

      .timeline-transport-btn svg {
        width: 14px;
        height: 14px;
        fill: currentColor;
        pointer-events: none;
      }

      .timeline-speed-controls {
        display: inline-flex;
        align-items: center;
        gap: 2px;
        background: rgba(255, 255, 255, 0.05);
        border: 1px solid rgba(255, 255, 255, 0.1);
        border-radius: 6px;
        padding: 2px;
      }

      .timeline-stepper-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 22px;
        height: 22px;
        background: transparent;
        color: #94a3b8;
        border: none;
        border-radius: 4px;
        cursor: pointer;
        font-size: 14px;
        font-weight: 700;
        line-height: 1;
        transition: all 0.15s;
        user-select: none;
      }

      .timeline-stepper-btn:hover:not(:disabled) {
        background: rgba(255, 255, 255, 0.12);
        color: #ffffff;
      }

      .timeline-stepper-btn:disabled {
        opacity: 0.3;
        cursor: not-allowed;
      }

      .timeline-speed-display {
        font-size: 11px;
        font-weight: 700;
        min-width: 38px;
        text-align: center;
        color: #93c5fd;
        padding: 2px 4px;
        border-radius: 4px;
        cursor: pointer;
        user-select: none;
        transition: all 0.15s;
      }

      .timeline-speed-display:hover {
        background: rgba(59, 130, 246, 0.2);
        color: #60a5fa;
      }

      .timeline-time-badge {
        font-size: 12px;
        font-family: monospace;
        color: #e2e8f0;
        background: rgba(0, 0, 0, 0.3);
        padding: 4px 8px;
        border-radius: 4px;
        border: 1px solid rgba(255, 255, 255, 0.06);
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
    const modalImgUrl = event.has_snapshot !== false ? snapshotUrl : thumbnailUrl;
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
                 <source src="${clipUrl}" type="video/mp4">
                 <source src="${hlsUrl}" type="application/x-mpegURL">
               </video>`
            : `<img src="${modalImgUrl}" alt="${event.label}" onerror="if(!this.dataset.fallback){this.dataset.fallback='1';this.src='${thumbnailUrl}';}" />`
          }          ${nextBtnHtml}
          <button class="frigate-events-modal-close" title="Close">
            <svg viewBox="0 0 24 24"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
          </button>
        </div>
        <div class="frigate-events-modal-info">
          <div class="frigate-events-modal-info-top">
            <div class="frigate-events-modal-info-left">
              <div class="frigate-events-modal-label">
                ${this._capitalize(event.label)}
              </div>
              ${showCameraName
                ? `<div class="frigate-events-modal-camera">
                     ${this._formatCameraName(event.camera)}
                   </div>`
                : ''
              }
              ${showAccuracy && scoreText ? `<div class="frigate-events-modal-score">${scoreText}</div>` : ''}
            </div>
            
            <div class="frigate-events-modal-info-right">
              <div class="frigate-events-modal-time">${rightLine1}</div>
              ${showZones && zones ? `<div class="frigate-events-modal-zones">${zones}</div>` : ''}
              ${showDuration ? `<div class="frigate-events-modal-duration">${duration}</div>` : ''}
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
                 <div class="frigate-events-modal-description">${event.description || event.data?.description}</div>
               </div>`
            : ''
          }
        </div>
      </div>
    `;

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
    const activeMasks = (this.hass.states?.['sensor.frigate_active_masks']?.attributes?.masks as any[]) || [];
    const isCurrentlyActive: boolean = Boolean(
      Array.isArray(activeMasks) && activeMasks.some((m: any) => m.mask_id === maskId)
    );

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
          detail: { message: `Temporary mask removed for ${event.camera}` },
          bubbles: true,
          composed: true,
        }));
        return false;
      } else {
        // Add mask
        this._localPendingMasks = [];
        const durationHours = this._getMaskDurationHours();
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
        this.dispatchEvent(new CustomEvent('hass-notification', {
          detail: { message: `Temporary mask applied for ${event.camera}` },
          bubbles: true,
          composed: true,
        }));
        return true;
      }
    } catch (err) {
      console.error('Failed to toggle temporary mask:', err);
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

      const durationText = durationHours === 1
        ? '1 hour'
        : durationHours < 24
        ? `${durationHours} hours`
        : durationHours === 24
        ? '24 hours (1 day)'
        : durationHours === 48
        ? '48 hours (2 days)'
        : durationHours % 24 === 0
        ? `${durationHours / 24} days`
        : `${durationHours} hours`;

      this.dispatchEvent(new CustomEvent('hass-notification', {
        detail: { message: `Temporary mask updated to ${durationText} for ${event.camera}` },
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
    const activeMasks = (this.hass?.states?.['sensor.frigate_active_masks']?.attributes?.masks as any[]) || [];
    const currentMask = Array.isArray(activeMasks) ? activeMasks.find((m: any) => m.mask_id === maskId || m.event_id === event.id || String(m.mask_id) === String(maskId)) : undefined;
    const isMaskActive: boolean = Boolean(currentMask);

    let activeDurationHours = 24;
    let timeRemainingStr = '';
    if (currentMask) {
      if (typeof currentMask.duration_hours === 'number' && currentMask.duration_hours > 0) {
        activeDurationHours = currentMask.duration_hours;
      }
      if (currentMask.expires_at) {
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
    ];
    const isCustomDuration = isMaskActive && !durationPresets.some(p => Math.abs(p.hours - activeDurationHours) < 0.01);

    const activeDurationText = activeDurationHours === 1
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
      (this.hass?.services?.['frigate_temp_mask'] || this.hass?.services?.['shell_command']?.['frigate_add_temp_mask'] || this.hass?.states?.['sensor.frigate_active_masks'])
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

  private _formatMaskRemainingTime(expiresAt?: string): string {
    if (!expiresAt) return '';
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
      (this.hass?.services?.['frigate_temp_mask'] || this.hass?.services?.['shell_command']?.['frigate_add_temp_mask'] || this.hass?.states?.['sensor.frigate_active_masks'])
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
      return;
    }

    const container = document.createElement('div');
    container.className = 'frigate-events-modal frigate-mask-manager-modal';
    this._maskManagerContainer = container;

    this._renderMaskManagerContent(container);

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

  private _removeMaskManagerModal(): void {
    if (this._maskManagerContainer && this._maskManagerContainer.parentNode) {
      this._maskManagerContainer.parentNode.removeChild(this._maskManagerContainer);
      this._maskManagerContainer = undefined;
    }
    if (this._maskManagerTimer) {
      clearInterval(this._maskManagerTimer);
      this._maskManagerTimer = undefined;
    }
  }

  private _updateMaskManagerTimers(container: HTMLElement): void {
    const activeMasks = (this.hass?.states?.['sensor.frigate_active_masks']?.attributes?.masks as any[]) || [];
    if (!Array.isArray(activeMasks)) return;
    const map = new Map<string, any>();
    activeMasks.forEach(m => map.set(m.mask_id, m));

    container.querySelectorAll('[data-timer-mask-id]').forEach(el => {
      const maskId = el.getAttribute('data-timer-mask-id');
      const mask = maskId ? map.get(maskId) : undefined;
      if (mask && mask.expires_at) {
        const text = this._formatMaskRemainingTime(mask.expires_at);
        const span = el.querySelector('.timer-text');
        if (span) span.textContent = text;
      }
    });
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
    const rawMasks = (this.hass?.states?.['sensor.frigate_active_masks']?.attributes?.masks as any[]) || [];
    const activeMasks = Array.isArray(rawMasks) ? rawMasks : [];
    const totalCount = activeMasks.length;

    const rawPending = (this.hass?.states?.['sensor.frigate_active_masks']?.attributes?.pending_restart_masks as any[]) || [];
    const backendPending = Array.isArray(rawPending) ? rawPending : [];

    const sensorAttrs = this.hass?.states?.['sensor.frigate_active_masks']?.attributes;
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

    const durationPresets = [
      { hours: 1, label: '1h' },
      { hours: 4, label: '4h' },
      { hours: 8, label: '8h' },
      { hours: 12, label: '12h' },
      { hours: 24, label: '24h' },
      { hours: 48, label: '48h' },
      { hours: 72, label: '72h' },
      { hours: 168, label: '7d' },
    ];

    container.innerHTML = `
      <div class="frigate-events-modal-backdrop" data-action="close"></div>
      <div class="frigate-events-modal-content">
        <div class="mask-manager-header">
          <div class="mask-manager-header-left">
            <h2 class="mask-manager-title">Temporary False-Positive Masks</h2>
            <span class="mask-manager-count-badge">${totalCount} active</span>
          </div>
          <div class="mask-manager-header-actions">
            <button class="frigate-events-modal-close" data-action="close" title="Close">
              <svg viewBox="0 0 24 24"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
            </button>
          </div>
        </div>

        <div class="mask-manager-body">
          ${cameras.length > 1 ? `
            <div class="mask-filter-tabs">
              <button class="mask-filter-tab ${filterCamera === 'all' ? 'active' : ''}" data-camera-filter="all">
                All Cameras (${activeMasks.length + pendingMasks.length})
              </button>
              ${cameras.map(cam => {
                const count = activeMasks.filter((m: any) => m.camera === cam).length +
                              pendingMasks.filter((m: any) => m.camera === cam).length;
                return `
                  <button class="mask-filter-tab ${filterCamera === cam ? 'active' : ''}" data-camera-filter="${cam}">
                    ${this._formatCameraName(cam)} (${count})
                  </button>
                `;
              }).join('')}
            </div>
          ` : ''}

          ${filteredMasks.length === 0 && filteredPending.length === 0 ? `
            <div class="mask-empty-state">
              <svg viewBox="0 0 24 24"><path d="M2,2H8V4H16V2H22V8H20V16H22V22H16V20H8V22H2V16H4V8H2V2M4,4V6H6V4H4M18,4V6H20V4H18M20,18V20H18V18H20M4,18V20H6V18H4M8,6V8H6V16H8V18H16V16H18V8H16V6H8M9,9H15V15H9V9Z"/></svg>
              <h4>No Active Temporary Masks</h4>
              <p>Apply temporary false-positive masks by right-clicking any event thumbnail below or from actionable notifications.</p>
            </div>
          ` : ''}

          ${filteredMasks.length > 0 ? `
            <div class="mask-cards-list">
              ${filteredMasks.map((mask: any) => {
                const currentDurationHours = typeof mask.duration_hours === 'number' ? mask.duration_hours : 24;
                const isCustom = !durationPresets.some(p => Math.abs(p.hours - currentDurationHours) < 0.01);
                const remainingText = this._formatMaskRemainingTime(mask.expires_at);

                const clientId = this._config?.frigate_client_id || 'frigate';
                const maskId = String(mask.mask_id || '');
                const eventId = String(mask.event_id || maskId);

                // Find matching event from card events cache
                const matchedEvent = this._events?.find(e =>
                  e.id === eventId ||
                  e.id.startsWith(maskId) ||
                  maskId.startsWith(e.id)
                );

                const objectLabel = (matchedEvent?.label || mask.label || 'Detected Object').toUpperCase();
                const scoreText = matchedEvent?.top_score ? ` (${Math.round(matchedEvent.top_score * 100)}%)` : '';
                const timeText = matchedEvent?.start_time ? this._formatTime(matchedEvent.start_time) : '';
                const cameraName = mask.camera || matchedEvent?.camera || '';
                const rawTs = matchedEvent?.start_time || (eventId.includes('.') ? parseFloat(eventId.split('-')[0]) : 0);
                const eventTs = rawTs ? Math.floor(rawTs) : 0;

                const frigateBase = this._config?.frigate_url ? this._config.frigate_url.replace(/\/+$/, '') : 'http://192.168.1.211:5000';
                const directRecordingUrl = (cameraName && eventTs)
                  ? `${frigateBase}/api/${encodeURIComponent(cameraName)}/recordings/${eventTs}/snapshot.png`
                  : '';
                const haProxyUrl = (cameraName && eventTs)
                  ? `/api/frigate_temp_mask/recording_snapshot/${encodeURIComponent(cameraName)}/${eventTs}`
                  : '';
                const fallbackSnapshotUrl = getEventSnapshotURL(clientId, matchedEvent ? matchedEvent.id : eventId, {
                  bbox: false,
                  crop: false
                });

                const primaryUrl = directRecordingUrl || haProxyUrl || fallbackSnapshotUrl;

                // Compute polygon geometry & minimap coordinates
                const geo = this._getMaskPreviewGeometry(mask, matchedEvent);

                return `
                  <div class="mask-card" data-mask-id="${mask.mask_id}">
                    <div class="mask-card-main-row">
                      <div class="mask-visual-preview">
                        ${primaryUrl ? `
                          <img
                            src="${primaryUrl}"
                            class="mask-preview-thumb"
                            alt="${objectLabel}"
                            loading="lazy"
                            data-crop-x="${geo.cropRegion ? geo.cropRegion.x : ''}"
                            data-crop-y="${geo.cropRegion ? geo.cropRegion.y : ''}"
                            data-crop-w="${geo.cropRegion ? geo.cropRegion.w : ''}"
                            data-crop-h="${geo.cropRegion ? geo.cropRegion.h : ''}"
                            data-ha-proxy="${haProxyUrl}"
                            data-fallback-url="${fallbackSnapshotUrl}"
                            onload="((img) => {
                              var ar = img.naturalWidth / (img.naturalHeight || 1);
                              if (ar < 1.45 && img.dataset.cropX) {
                                var x = Math.max(0, Math.min(100, parseFloat(img.dataset.cropX) * 100));
                                var y = Math.max(0, Math.min(100, parseFloat(img.dataset.cropY) * 100));
                                var w = Math.max(12, Math.min(100 - x, parseFloat(img.dataset.cropW) * 100));
                                var h = Math.max(12, Math.min(100 - y, parseFloat(img.dataset.cropH) * 100));
                                img.style.left = x + '%';
                                img.style.top = y + '%';
                                img.style.width = w + '%';
                                img.style.height = h + '%';
                                img.style.borderRadius = '3px';
                                img.style.boxShadow = '0 0 6px rgba(0,0,0,0.7)';
                              } else {
                                img.style.left = '0';
                                img.style.top = '0';
                                img.style.width = '100%';
                                img.style.height = '100%';
                                img.style.borderRadius = '0';
                                img.style.boxShadow = 'none';
                              }
                            })(this)"
                            onerror="((img) => {
                              if (!img.dataset.triedHa && img.dataset.haProxy && img.src !== img.dataset.haProxy) {
                                img.dataset.triedHa = 'true';
                                img.src = img.dataset.haProxy;
                              } else if (!img.dataset.triedFallback && img.dataset.fallbackUrl && img.src !== img.dataset.fallbackUrl) {
                                img.dataset.triedFallback = 'true';
                                img.src = img.dataset.fallbackUrl;
                              } else {
                                img.style.display = 'none';
                              }
                            })(this)"
                          />
                        ` : ''}
                        <div class="mask-preview-minimap">
                          <svg viewBox="0 0 ${geo.viewBoxW} ${geo.viewBoxH}" preserveAspectRatio="none">
                            ${geo.polyPts ? `<polygon points="${geo.polyPts}" class="minimap-poly" vector-effect="non-scaling-stroke" />` : ''}
                          </svg>
                        </div>
                      </div>

                      <div class="mask-card-info">
                        <div class="mask-card-header">
                          <div class="mask-card-title-col">
                            <span class="mask-object-pill">${objectLabel}${scoreText}</span>
                            <span class="mask-camera-pill">${this._formatCameraName(mask.camera || 'Camera')}</span>
                            <span class="mask-id-pill">#${mask.mask_id}</span>
                          </div>
                          <div class="mask-card-time-badge" data-timer-mask-id="${mask.mask_id}">
                            <svg viewBox="0 0 24 24" style="width: 13px; height: 13px; fill: currentColor;"><path d="M12,20A8,8 0 0,0 20,12A8,8 0 0,0 12,4A8,8 0 0,0 4,12A8,8 0 0,0 12,20M12,2A10,10 0 0,1 22,12A10,10 0 0,1 12,2C6.47,22 2,17.5 2,12A10,10 0 0,1 12,2M12.5,7V12.25L17,14.92L16.25,16.15L11,13 V7H12.5Z"/></svg>
                            <span class="timer-text">${remainingText}</span>
                          </div>
                        </div>

                        <div class="mask-card-details">
                          <div class="mask-detail-row">
                            <span class="detail-label">Location:</span>
                            <span class="detail-value">${geo.posName} on camera ${geo.maskW > 0 ? `(${Math.round(geo.maskW)} × ${Math.round(geo.maskH)} px)` : ''}</span>
                          </div>
                          ${timeText ? `
                          <div class="mask-detail-row">
                            <span class="detail-label">Detected:</span>
                            <span class="detail-value">${timeText}</span>
                          </div>
                          ` : ''}
                        </div>
                      </div>
                    </div>

                    <div class="mask-card-actions">
                      <div class="mask-duration-selector">
                        <span class="duration-title">Duration:</span>
                        <div class="mask-duration-chips">
                          ${durationPresets.map(p => {
                            const isSelected = Math.abs(p.hours - currentDurationHours) < 0.01;
                            return `
                              <button class="mask-duration-chip ${isSelected ? 'active' : ''}" data-action="set-duration" data-mask-id="${mask.mask_id}" data-camera="${mask.camera || ''}" data-hours="${p.hours}" data-poly="${mask.polygon || ''}" data-label="${mask.label || ''}">
                                ${p.label}
                              </button>
                            `;
                          }).join('')}
                          <button class="mask-duration-chip ${isCustom ? 'active' : ''}" data-action="custom-duration" data-mask-id="${mask.mask_id}" data-camera="${mask.camera || ''}" data-poly="${mask.polygon || ''}" data-label="${mask.label || ''}">
                            ${isCustom ? `Custom (${currentDurationHours}h)` : 'Custom...'}
                          </button>
                        </div>
                      </div>
                      <button class="mask-remove-btn" data-action="remove-mask" data-mask-id="${mask.mask_id}" data-camera="${mask.camera || ''}">
                        <svg viewBox="0 0 24 24" style="width: 14px; height: 14px; fill: currentColor;"><path d="M19,4H15.5L14.5,3H9.5L8.5,4H5V6H19M6,19A2,2 0 0,0 8,21H16A2,2 0 0,0 18,19V7H6V19Z"/></svg>
                        <span>Remove</span>
                      </button>
                    </div>
                  </div>
                `;
              }).join('')}
            </div>
          ` : ''}

          ${filteredPending.length > 0 ? `
            <div class="pending-masks-section">
              <div class="pending-section-title">
                <span>Removed</span>
                ${filteredPending.length > 1 ? `
                  <button class="mask-section-dismiss-all-btn" data-action="dismiss-all-pending" title="Dismiss all pending restart notifications">
                    Dismiss All
                  </button>
                ` : ''}
              </div>
              <div class="mask-cards-list">
                ${filteredPending.map((mask: any) => {
                  const clientId = this._config?.frigate_client_id || 'frigate';
                  const maskId = String(mask.mask_id || '');
                  const eventId = String(mask.event_id || maskId);
                  const matchedEvent = this._events?.find(e => e.id === eventId || e.id.startsWith(maskId) || maskId.startsWith(e.id));
                  const objectLabel = (matchedEvent?.label || mask.label || 'Detected Object').toUpperCase();
                  
                  const cameraName = mask.camera || matchedEvent?.camera || '';
                  const rawTs = matchedEvent?.start_time || (eventId.includes('.') ? parseFloat(eventId.split('-')[0]) : 0);
                  const eventTs = rawTs ? Math.floor(rawTs) : 0;

                  const frigateBase = this._config?.frigate_url ? this._config.frigate_url.replace(/\/+$/, '') : 'http://192.168.1.211:5000';
                  const directRecordingUrl = (cameraName && eventTs)
                    ? `${frigateBase}/api/${encodeURIComponent(cameraName)}/recordings/${eventTs}/snapshot.png`
                    : '';
                  const haProxyUrl = (cameraName && eventTs)
                    ? `/api/frigate_temp_mask/recording_snapshot/${encodeURIComponent(cameraName)}/${eventTs}`
                    : '';
                  const fallbackSnapshotUrl = getEventSnapshotURL(clientId, matchedEvent ? matchedEvent.id : eventId, { bbox: false, crop: false });
                  const primaryUrl = directRecordingUrl || haProxyUrl || fallbackSnapshotUrl;
                  const geo = this._getMaskPreviewGeometry(mask, matchedEvent);

                  return `
                    <div class="mask-card pending-restart" data-mask-id="${mask.mask_id}">
                      <div class="mask-card-main-row">
                        <div class="mask-visual-preview">
                          ${primaryUrl ? `
                            <img
                              src="${primaryUrl}"
                              class="mask-preview-thumb"
                              alt="${objectLabel}"
                              loading="lazy"
                              data-crop-x="${geo.cropRegion ? geo.cropRegion.x : ''}"
                              data-crop-y="${geo.cropRegion ? geo.cropRegion.y : ''}"
                              data-crop-w="${geo.cropRegion ? geo.cropRegion.w : ''}"
                              data-crop-h="${geo.cropRegion ? geo.cropRegion.h : ''}"
                              data-ha-proxy="${haProxyUrl}"
                              data-fallback-url="${fallbackSnapshotUrl}"
                              onload="((img) => {
                                var ar = img.naturalWidth / (img.naturalHeight || 1);
                                if (ar < 1.45 && img.dataset.cropX) {
                                  var x = Math.max(0, Math.min(100, parseFloat(img.dataset.cropX) * 100));
                                  var y = Math.max(0, Math.min(100, parseFloat(img.dataset.cropY) * 100));
                                  var w = Math.max(12, Math.min(100 - x, parseFloat(img.dataset.cropW) * 100));
                                  var h = Math.max(12, Math.min(100 - y, parseFloat(img.dataset.cropH) * 100));
                                  img.style.left = x + '%';
                                  img.style.top = y + '%';
                                  img.style.width = w + '%';
                                  img.style.height = h + '%';
                                  img.style.borderRadius = '3px';
                                  img.style.boxShadow = '0 0 6px rgba(0,0,0,0.7)';
                                } else {
                                  img.style.left = '0';
                                  img.style.top = '0';
                                  img.style.width = '100%';
                                  img.style.height = '100%';
                                  img.style.borderRadius = '0';
                                  img.style.boxShadow = 'none';
                                }
                              })(this)"
                              onerror="((img) => {
                                if (!img.dataset.triedHa && img.dataset.haProxy && img.src !== img.dataset.haProxy) {
                                  img.dataset.triedHa = 'true';
                                  img.src = img.dataset.haProxy;
                                } else if (!img.dataset.triedFallback && img.dataset.fallbackUrl && img.src !== img.dataset.fallbackUrl) {
                                  img.dataset.triedFallback = 'true';
                                  img.src = img.dataset.fallbackUrl;
                                } else {
                                  img.style.display = 'none';
                                }
                              })(this)"
                            />
                          ` : ''}
                          <div class="mask-preview-minimap">
                            <svg viewBox="0 0 ${geo.viewBoxW} ${geo.viewBoxH}" preserveAspectRatio="none">
                              ${geo.polyPts ? `<polygon points="${geo.polyPts}" class="minimap-poly" vector-effect="non-scaling-stroke" />` : ''}
                            </svg>
                          </div>
                        </div>
                        <div class="mask-card-info">
                          <div class="mask-card-header">
                            <div class="mask-card-title-col">
                              <span class="mask-object-pill">${objectLabel}</span>
                              <span class="mask-camera-pill">${this._formatCameraName(mask.camera || 'Camera')}</span>
                              <span class="mask-id-pill">#${mask.mask_id}</span>
                            </div>
                          </div>
                          <div class="mask-card-details">
                            <div class="mask-detail-row">
                              <span class="detail-label">Status:</span>
                              <span class="detail-value" style="color: #94a3b8; font-size: 11px;">Removed</span>
                            </div>
                          </div>
                        </div>
                      </div>
                      <div class="mask-card-actions mask-card-pending-actions">
                        <button class="mask-pending-dismiss-action" data-action="dismiss-pending" data-mask-id="${mask.mask_id}" title="Dismiss">
                          <svg viewBox="0 0 24 24"><path d="M19,6.41L17.59,5L12,10.59L6.41,5L5,6.41L10.59,12L5,17.59L6.41,19L12,13.41L17.59,19L19,17.59L13.41,12L19,6.41Z"/></svg>
                          <span>Dismiss</span>
                        </button>
                      </div>
                    </div>
                  `;
                }).join('')}
              </div>
            </div>
          ` : ''}
        </div>
      </div>
    `;

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
  }

  private async _executeRestartFrigate(): Promise<void> {
    if (!this.hass) return;
    this._localPendingMasks = [];
    try {
      if (this.hass.callService) {
        try {
          await this.hass.callService('frigate_temp_mask', 'restart', {});
        } catch {
          try {
            await this.hass.callService('frigate', 'restart', {});
          } catch {
            await this.hass.callService('homeassistant', 'restart', {});
          }
        }
      }
      this.dispatchEvent(new CustomEvent('hass-notification', {
        detail: { message: 'Frigate detector process restarting to apply configuration changes...' },
        bubbles: true,
        composed: true,
      }));
      this.requestUpdate();
      this._removeMaskManagerModal();
    } catch (err) {
      console.error('Failed to restart Frigate:', err);
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
      const sensorAttrs = this.hass?.states?.['sensor.frigate_active_masks']?.attributes;
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

      // Post-call: re-check supports_dynamic_toggle. The backend fetches and caches
      // the Frigate version during remove_mask, so the sensor may now report true
      // even if it was false at click time. Clear the pending entry if so.
      const postAttrs = this.hass?.states?.['sensor.frigate_active_masks']?.attributes;
      if (postAttrs?.supports_dynamic_toggle === true) {
        this._localPendingMasks = this._localPendingMasks.filter(m => String(m.mask_id) !== String(maskId));
      }

      this.dispatchEvent(new CustomEvent('hass-notification', {
        detail: { message: `Temporary mask #${maskId} removed ${camera ? `for ${camera}` : ''}` },
        bubbles: true,
        composed: true,
      }));
      this.requestUpdate();
      if (this._maskManagerContainer) {
        setTimeout(() => {
          if (this._maskManagerContainer) this._renderMaskManagerContent(this._maskManagerContainer);
        }, 300);
        // Second pass: by 600ms HA state has definitely propagated.
        // If supports_dynamic_toggle is true (0.18+), ensure no pending entry lingers.
        setTimeout(() => {
          const lateAttrs = this.hass?.states?.['sensor.frigate_active_masks']?.attributes;
          if (lateAttrs?.supports_dynamic_toggle === true) {
            this._localPendingMasks = this._localPendingMasks.filter(m => String(m.mask_id) !== String(maskId));
            if (this._maskManagerContainer) this._renderMaskManagerContent(this._maskManagerContainer);
          }
        }, 600);
      }
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
      this.dispatchEvent(new CustomEvent('hass-notification', {
        detail: { message: 'All temporary masks pruned from Frigate' },
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
      if (this.hass.callService) {
        try {
          await this.hass.callService('frigate_temp_mask', 'add_mask', {
            mask_id: maskId,
            camera: camera,
            duration_hours: durationHours,
            polygon: polygon,
            label: label,
          });
        } catch {
          await this.hass.callService('shell_command', 'frigate_add_temp_mask', {
            mask_id: maskId,
            camera: camera,
          });
        }
      }
      const durationText = durationHours === 1
        ? '1 hour'
        : durationHours < 24
        ? `${durationHours} hours`
        : durationHours === 24
        ? '24 hours (1 day)'
        : durationHours === 48
        ? '48 hours (2 days)'
        : durationHours % 24 === 0
        ? `${durationHours / 24} days`
        : `${durationHours} hours`;

      this.dispatchEvent(new CustomEvent('hass-notification', {
        detail: { message: `Temporary mask #${maskId} updated to ${durationText}` },
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

  private async _showTimelineModal(initialCamera?: string, initialTimestamp?: number, initialEvent?: FrigateEvent): Promise<void> {
    this._closeContextMenu();
    this._injectModalStyles();

    // Determine initial camera
    const availableCameras = this._getAvailableCameras();
    const camera = initialCamera || this._timelineCamera || (availableCameras.length > 0 ? availableCameras[0] : (this._config?.camera || ''));
    this._timelineCamera = camera;

    // Determine initial time window
    const duration = this._timelineWindowDurationSec || ((this._config?.timeline_default_window_hours || 1) * 3600);
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
    container.className = 'frigate-events-modal frigate-timeline-modal';
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

    // If play is triggered while sitting at the end of the window, roll into the next block
    if (v.currentTime >= maxSeek) {
      const now = Math.floor(Date.now() / 1000);
      if (this._timelineEndTs < now) {
        this._advanceToNextTimelineWindow();
        return;
      }
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
    // If we've reached or passed real-time, stop playback
    if (this._timelineEndTs >= now) {
      this._clearTimelineSpeedInterval();
      if (this._timelineVideoEl) {
        this._timelineVideoEl.pause();
      }
      this._updateTimelinePlayheadUI();
      return;
    }

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

    try {
      const windowDuration = this._timelineWindowDurationSec || (this._timelineEndTs - this._timelineStartTs) || 3600;
      let nextStart = this._timelineEndTs;
      let nextEnd = nextStart + windowDuration;
      if (nextEnd > now) {
        nextEnd = now;
      }

      // Stop if less than 5 seconds remaining up to real-time now
      if (nextEnd - nextStart < 5) {
        this._isAdvancingTimeline = false;
        if (this._timelineAdvanceTimeout) {
          clearTimeout(this._timelineAdvanceTimeout);
          this._timelineAdvanceTimeout = undefined;
        }
        if (this._timelineVideoEl) {
          this._timelineVideoEl.pause();
        }
        this._updateTimelinePlayheadUI();
        return;
      }

      this._timelineStartTs = nextStart;
      this._timelineEndTs = nextEnd;

      const container = this._timelineContainer;
      if (!container) return;

      this._updateTimelineWindowUI();
      // Load next video stream immediately and silently in auto-advance mode (parallel, no lag)
      this._loadTimelineVideo(this._timelineStartTs, true);

      // Fetch event markers and check recordings concurrently in background
      this._fetchTimelineEvents().then(async () => {
        this._updateTimelineScrubberEvents();
        // If this window had a recording gap (0 recordings), look ahead and leap to next available footage
        if (this._timelineRecordings.length === 0 && this.hass && this._timelineCamera) {
          try {
            const clientId = this._config?.frigate_client_id || 'frigate';
            const futureRecs = await getRecordings(this.hass, clientId, this._timelineCamera, nextEnd, now);
            if (Array.isArray(futureRecs) && futureRecs.length > 0) {
              futureRecs.sort((a, b) => a.start_time - b.start_time);
              const nextRecStart = futureRecs[0].start_time;
              this._timelineStartTs = nextRecStart;
              this._timelineEndTs = Math.min(now, Math.floor(nextRecStart + windowDuration));
              this._updateTimelineWindowUI();
              this._loadTimelineVideo(this._timelineStartTs, true);
              this._fetchTimelineEvents().then(() => this._updateTimelineScrubberEvents());
            }
          } catch (e) {
            console.debug('Failed to check recordings ahead:', e);
          }
        }
      });
    } catch (err) {
      console.warn('Failed to auto-advance timeline window:', err);
      this._isAdvancingTimeline = false;
    }
  }

  private _syncTimelineSpeedStepperUI(container?: HTMLElement): void {
    const root = container || this._timelineContainer;
    if (!root) return;
    const currentIndex = TIMELINE_PLAYBACK_SPEEDS.indexOf(this._timelinePlaybackRate);
    const speedDisplay = root.querySelector('[data-timeline-speed-display]') as HTMLElement | null;
    if (speedDisplay) {
      speedDisplay.textContent = `${this._timelinePlaybackRate}x`;
    }
    const downBtn = root.querySelector('[data-action="speed-down"]') as HTMLButtonElement | null;
    if (downBtn) {
      downBtn.disabled = currentIndex <= 0;
    }
    const upBtn = root.querySelector('[data-action="speed-up"]') as HTMLButtonElement | null;
    if (upBtn) {
      upBtn.disabled = currentIndex >= TIMELINE_PLAYBACK_SPEEDS.length - 1;
    }
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
    try {
      const clientId = this._config?.frigate_client_id || 'frigate';
      const [events, recordings] = await Promise.all([
        getEvents(this.hass, {
          instance_id: clientId,
          cameras: [this._timelineCamera],
          after: this._timelineStartTs,
          before: this._timelineEndTs,
          limit: 100,
        }),
        getRecordings(this.hass, clientId, this._timelineCamera, this._timelineStartTs, this._timelineEndTs).catch(() => []),
      ]);
      this._timelineEvents = Array.isArray(events) ? events : [];
      this._timelineRecordings = Array.isArray(recordings) ? recordings.sort((a, b) => a.start_time - b.start_time) : [];
    } catch (e) {
      console.warn('Failed to fetch events for timeline window:', e);
      this._timelineEvents = [];
      this._timelineRecordings = [];
    }
  }

  private _wallClockToVideoOffset(targetTs: number): number {
    if (!this._timelineRecordings.length) {
      return Math.max(0, targetTs - this._timelineStartTs);
    }
    let videoSeconds = 0;
    for (const rec of this._timelineRecordings) {
      const recStart = Math.max(this._timelineStartTs, rec.start_time);
      const recEnd = Math.min(this._timelineEndTs, rec.end_time);
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
    if (!this._timelineRecordings.length) {
      return this._timelineStartTs + videoOffset;
    }
    let accumulated = 0;
    for (const rec of this._timelineRecordings) {
      const recStart = Math.max(this._timelineStartTs, rec.start_time);
      const recEnd = Math.min(this._timelineEndTs, rec.end_time);
      if (recEnd <= recStart) continue;

      const dur = recEnd - recStart;
      if (accumulated + dur >= videoOffset) {
        return recStart + (videoOffset - accumulated);
      }
      accumulated += dur;
    }
    return this._timelineRecordings.length > 0
      ? Math.min(this._timelineEndTs, this._timelineRecordings[this._timelineRecordings.length - 1].end_time)
      : (this._timelineStartTs + videoOffset);
  }

  private _loadTimelineVideo(seekTargetTs?: number, isAutoAdvance = false): void {
    if (!this._timelineContainer || !this._timelineCamera) return;

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
    const hlsUrl = getVodHlsURL(clientId, this._timelineCamera, this._timelineStartTs, this._timelineEndTs, frigateUrl);
    const mp4Url = getVodClipURL(clientId, this._timelineCamera, this._timelineStartTs, this._timelineEndTs, frigateUrl);

    const initialOffset = (seekTargetTs && seekTargetTs >= this._timelineStartTs && seekTargetTs <= this._timelineEndTs)
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

    console.log('Frigate Events Card: VOD requested:', { slot, hlsUrl, mp4Url, start: this._timelineStartTs, end: this._timelineEndTs });

    const fallbackToMp4 = () => {
      console.warn('Frigate Events Card: HLS failed or unsupported, trying MP4 clip:', mp4Url);
      video.onerror = (e) => {
        this._isAdvancingTimeline = false;
        if (this._timelineLoadingTimeout) {
          clearTimeout(this._timelineLoadingTimeout);
          this._timelineLoadingTimeout = undefined;
        }
        if (loadingEl) {
          loadingEl.classList.remove('subtle');
        }
        console.error('Frigate Events Card: MP4 playback failed:', e, mp4Url);
        if (loadingEl) {
          loadingEl.innerHTML = `
            <div style="display:flex; flex-direction:column; align-items:center; gap:8px; text-align:center; padding:16px;">
              <span>No continuous footage stream available for this time window.</span>
              <span style="font-size:11px; opacity:0.6;">Tested URLs: <a href="${hlsUrl}" target="_blank" style="color:var(--primary-color, #03a9f4);">HLS</a> | <a href="${mp4Url}" target="_blank" style="color:var(--primary-color, #03a9f4);">MP4</a></span>
            </div>
          `;
        }
      };
      video.src = mp4Url;
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
      hls.loadSource(hlsUrl);
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
      video.src = hlsUrl;
      video.load();
    } else {
      fallbackToMp4();
    }

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

    const currentBadge = this._timelineContainer.querySelector('[data-timeline-current-time]') as HTMLElement | null;
    if (currentBadge) {
      const curDate = new Date(currentTs * 1000);
      currentBadge.textContent = curDate.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' });
    }

    const playPauseBtn = this._timelineContainer.querySelector('[data-action="toggle-play"]') as HTMLElement | null;
    if (playPauseBtn) {
      const isPaused = this._timelinePlaybackRate > 16
        ? !this._timelineSpeedInterval
        : video.paused;
      const stateStr = isPaused ? 'paused' : 'playing';
      if (playPauseBtn.getAttribute('data-play-state') !== stateStr) {
        playPauseBtn.setAttribute('data-play-state', stateStr);
        playPauseBtn.setAttribute('title', isPaused ? 'Play' : 'Pause');
        playPauseBtn.innerHTML = isPaused
          ? `<svg viewBox="0 0 24 24"><path d="M8,5.14V19.14L19,12.14L8,5.14Z"/></svg>`
          : `<svg viewBox="0 0 24 24"><path d="M14,19H18V5H14M6,19H10V5H6V19Z"/></svg>`;
      }
    }
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
      const labelClass = (ev.label || 'event').toLowerCase();
      const timeStr = this._formatTime(start);
      const title = `${(ev.label || 'Event').toUpperCase()} at ${timeStr}`;

      return `
        <div
          class="timeline-event-marker ${labelClass}"
          data-event-id="${ev.id}"
          data-event-start="${start}"
          title="${title}"
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
    const showMuteBtn = this._config?.timeline_show_mute !== false;
    const mutePosition = this._config?.live_view_mute_position === 'top-left' ? 'top-left' : 'top-right';

    container.innerHTML = `
      <div class="frigate-events-modal-content">
        <div class="timeline-modal-header">
          <div class="timeline-modal-header-left">
            <h3 class="timeline-modal-title">
              <svg viewBox="0 0 24 24"><path d="M12,20A8,8 0 0,0 20,12A8,8 0 0,0 12,4A8,8 0 0,0 4,12A8,8 0 0,0 12,20M12,2A10,10 0 0,1 22,12A10,10 0 0,1 12,2C6.47,2 2,6.48 2,12A10,10 0 0,1 12,2M12.5,7V12.25L17,14.92L16.25,16.15L11,13V7H12.5Z"/></svg>
              <span>Timeline</span>
            </h3>
            <span class="timeline-camera-badge">${this._formatCameraName(currentCamera)}</span>
          </div>
          <button class="frigate-events-modal-close" data-action="close" title="Close">
            <svg viewBox="0 0 24 24"><path d="M19,6.41L17.59,5L12,10.59L6.41,5L5,6.41L10.59,12L5,17.59L6.41,19L12,13.41L17.59,19L19,17.59L13.41,12L19,6.41Z"/></svg>
          </button>
        </div>

        <div class="timeline-modal-body">
          ${availableCameras.length > 1 ? `
            <div class="timeline-camera-tabs">
              ${availableCameras.map(cam => `
                <button class="timeline-camera-tab ${cam === currentCamera ? 'active' : ''}" data-camera="${cam}">
                  ${this._formatCameraName(cam)}
                </button>
              `).join('')}
            </div>
          ` : ''}

          <!-- Controls: DateTime picker, Quick jumps, Window duration -->
          <div class="timeline-controls-bar">
            <div class="timeline-datetime-group">
              <span class="timeline-datetime-label">Start Time:</span>
              <input type="datetime-local" class="timeline-datetime-input" value="${dtValue}" />
              <div class="timeline-quick-jumps">
                <button class="timeline-quick-btn" data-jump="now">Now</button>
                <button class="timeline-quick-btn" data-jump="-15m">-15m</button>
                <button class="timeline-quick-btn" data-jump="-1h">-1h</button>
                <button class="timeline-quick-btn" data-jump="-3h">-3h</button>
                <button class="timeline-quick-btn" data-jump="-12h">-12h</button>
                <button class="timeline-quick-btn" data-jump="day-start">Start of Day</button>
              </div>
            </div>

            <div class="timeline-window-group">
              <span class="timeline-datetime-label">Window:</span>
              <div class="timeline-window-pills">
                <button class="timeline-window-pill ${windowMinutes === 15 ? 'active' : ''}" data-window="15">15m</button>
                <button class="timeline-window-pill ${windowMinutes === 30 ? 'active' : ''}" data-window="30">30m</button>
                <button class="timeline-window-pill ${windowMinutes === 60 ? 'active' : ''}" data-window="60">1h</button>
                <button class="timeline-window-pill ${windowMinutes === 120 ? 'active' : ''}" data-window="120">2h</button>
                <button class="timeline-window-pill ${windowMinutes === 180 ? 'active' : ''}" data-window="180">3h</button>
              </div>
            </div>
          </div>

          <!-- Video Player -->
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

          <!-- Scrubber Track -->
          <div class="timeline-scrubber-wrapper">
            <div class="timeline-track-container">
              <div class="timeline-events-layer"></div>
              <div class="timeline-playhead"></div>
            </div>
            <div class="timeline-track-labels">
              <span>${startDate.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}</span>
              <span class="timeline-time-badge" data-timeline-current-time>--:--:--</span>
              <span>${endDate.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}</span>
            </div>
          </div>

          <!-- Transport & Speed Controls -->
          <div class="timeline-transport-bar">
            <div class="timeline-transport-controls">
              <button class="timeline-transport-btn" data-skip="-300" title="Back 5 minutes">-5m</button>
              <button class="timeline-transport-btn" data-skip="-60" title="Back 1 minute">-1m</button>
              <button class="timeline-transport-btn" data-skip="-30" title="Back 30 seconds">-30s</button>
              <button class="timeline-transport-btn play-btn" data-action="toggle-play" title="Play / Pause">
                <svg viewBox="0 0 24 24"><path d="M8,5.14V19.14L19,12.14L8,5.14Z"/></svg>
              </button>
              <button class="timeline-transport-btn" data-skip="30" title="Forward 30 seconds">+30s</button>
              <button class="timeline-transport-btn" data-skip="60" title="Forward 1 minute">+1m</button>
              <button class="timeline-transport-btn" data-skip="300" title="Forward 5 minutes">+5m</button>
            </div>

            <div class="timeline-speed-controls">
              <button class="timeline-stepper-btn" data-action="speed-down" title="Decrease speed (min 0.5x)">−</button>
              <span class="timeline-speed-display" data-timeline-speed-display title="Click to reset to 1x">${this._timelinePlaybackRate}x</span>
              <button class="timeline-stepper-btn" data-action="speed-up" title="Increase speed (max 4096x)">+</button>
            </div>
          </div>
        </div>
      </div>
    `;

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

    // Close button
    container.querySelector('[data-action="close"]')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this._removeTimelineModal();
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

    // Play / Pause button
    const playPauseBtn = container.querySelector('[data-action="toggle-play"]');
    playPauseBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      this._toggleTimelinePlayPause();
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

    container.querySelector('[data-action="speed-down"]')?.addEventListener('click', (e) => {
      e.stopPropagation();
      const currentIndex = TIMELINE_PLAYBACK_SPEEDS.indexOf(this._timelinePlaybackRate);
      if (currentIndex > 0) {
        this._applyTimelinePlaybackRate(TIMELINE_PLAYBACK_SPEEDS[currentIndex - 1]);
      }
    });

    container.querySelector('[data-action="speed-up"]')?.addEventListener('click', (e) => {
      e.stopPropagation();
      const currentIndex = TIMELINE_PLAYBACK_SPEEDS.indexOf(this._timelinePlaybackRate);
      if (currentIndex >= 0 && currentIndex < TIMELINE_PLAYBACK_SPEEDS.length - 1) {
        this._applyTimelinePlaybackRate(TIMELINE_PLAYBACK_SPEEDS[currentIndex + 1]);
      }
    });

    container.querySelector('[data-timeline-speed-display]')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this._applyTimelinePlaybackRate(1);
    });

    // Scrubber track click / drag scrubbing
    const track = container.querySelector('.timeline-track-container') as HTMLElement | null;
    if (track) {
      const handleSeek = (clientX: number) => {
        const rect = track.getBoundingClientRect();
        if (rect.width <= 0) return;
        const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
        const duration = this._timelineEndTs - this._timelineStartTs;
        if (duration <= 0) return;

        const targetTs = this._timelineStartTs + (ratio * duration);
        const targetOffset = this._wallClockToVideoOffset(targetTs);
        if (this._timelineVideoEl) {
          const maxSeek = (Number.isFinite(this._timelineVideoEl.duration) && this._timelineVideoEl.duration > 0)
            ? Math.max(0, this._timelineVideoEl.duration - 0.5)
            : targetOffset;
          this._timelineVideoEl.currentTime = Math.max(0, Math.min(targetOffset, maxSeek));
        }

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
        handleSeek(e.clientX);
      });
    }
  }

  private async _executeDeleteEvent(event: FrigateEvent): Promise<void> {
    const clientId = this._config?.frigate_client_id || 'frigate';
    const success = await deleteEvent(
      clientId,
      event.id,
      this._config?.frigate_url,
      this._config?.go2rtc_url,
      this.hass
    );

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
      (this.hass?.services?.['frigate_temp_mask'] || this.hass?.states?.['sensor.frigate_active_masks']));
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
          ${this._config.debug ? html`<div class="debug-version">v${CARD_VERSION}</div>` : ''}
          ${this._config.live_view ? this._renderLiveView() : ''}
          ${this._loading && this._events.length === 0
            ? html`<div class="loading"></div>`
            : this._error && this._events.length === 0
              ? html``
              : html`
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
      return html`
        <div class="live-view-container" style="aspect-ratio: ${aspectRatio};">
          <div class="live-view-error">
            <span>Live feed unavailable</span>
            <span class="live-view-error-detail">${this._liveViewError}</span>
          </div>
        </div>
      `;
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
    const initialUrl = event.has_snapshot !== false ? snapshotUrl : thumbnailUrl;

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
          src="${initialUrl}"
          alt="${event.label}"
          loading="lazy"
          @error=${(e: Event) => {
            const img = e.target as HTMLImageElement;
            if (img && !img.dataset.fallback) {
              img.dataset.fallback = '1';
              img.src = thumbnailUrl;
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
