/**
 * Frigate Events Card - A simple Lovelace card for displaying recent Frigate events
 */
import { LitElement, html, css, PropertyValues, TemplateResult, CSSResult } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { ref } from 'lit/directives/ref.js';
import { HomeAssistant, LovelaceCardConfig, LovelaceLayoutOptions } from './ha/types';
import { FrigateBoundingBox, FrigateEvent, FrigateEventChange, FrigatePathPoint } from './frigate/types';
import { getEvents, getEventSnapshotURL, getEventThumbnailURL, subscribeToEvents, getEventClipURL, getEventHlsURL, deleteEvent } from './frigate/api';

const CARD_VERSION = '2.3.18';

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
  event_count?: number;
  cameras?: string[];
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
  go2rtc_url?: string;              // Optional direct go2rtc URL (e.g. 'http://192.168.1.211:1984')
  go2rtc_stream?: string;           // Optional stream name in go2rtc (defaults to camera entity basename)
  // Temporary false-positive masking options
  show_temp_mask?: boolean;         // default: true
  temp_mask_duration?: string;      // default: '24:00:00'
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
  title: 'Frigate Events',
  video: true,
  video_on_hover: true,
  muted: true,
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
  @state() private _showLiveMaskOverlays = true;
  @state() private _maskManagerSelectedCamera = 'all';

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
  private _touchTimeout?: ReturnType<typeof setTimeout>;
  private _liveTouchTimeout?: ReturnType<typeof setTimeout>;

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
    // Tear down WebRTC peer connection and IntersectionObserver
    this._teardownWebRTC();
    if (this._intersectionGraceTimer) {
      clearTimeout(this._intersectionGraceTimer);
      this._intersectionGraceTimer = undefined;
    }
    this._intersectionObserver?.disconnect();
    this._intersectionObserver = undefined;
    this._removeModal();
    this._removeMaskManagerModal();
    this._closeContextMenu();
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
        if (isVisible) {
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
  private async _startWebRTC(): Promise<void> {
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
          if (video.srcObject !== remoteStream) {
            video.srcObject = remoteStream;
          }
          video.play().catch(() => {});
        }
      };

      // Signal willingness to receive video only.
      // Audio is intentionally omitted: go2rtc RTSP streams are typically video-only,
      // and including an audio m-line when the camera has no audio track can cause
      // HA/go2rtc to reject the SDP offer entirely.
      pc.addTransceiver('video', { direction: 'recvonly' });

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
              this._liveViewError = event.message || 'Camera stream unavailable';
              this._teardownWebRTC();
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
      let msg = e?.message || (typeof e === 'object' ? JSON.stringify(e) : String(e));
      if (e?.code === 'unknown_command' || msg.toLowerCase().includes('unknown command')) {
        msg = 'HA WebRTC protocol (camera/web_rtc_offer) not supported for this entity. Fix WebRTC Camera integration in HA or set go2rtc_url in card config.';
      }
      console.error('Frigate Events Card: Failed to start WebRTC session:', msg);
      this._liveViewError = `Failed to start: ${msg}`;
      this._teardownWebRTC();
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
          if (video.srcObject !== remoteStream) {
            video.srcObject = remoteStream;
          }
          video.play().catch(() => {});
        }
      };

      pc.addTransceiver('video', { direction: 'recvonly' });

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

  private _handleEventClick(event: FrigateEvent): void {
    this._selectedEvent = event;
    this._showModal();
  }

  private _handleModalClose(): void {
    this._selectedEvent = undefined;
    this._removeModal();
  }

  private _injectModalStyles(): void {
    if (FrigateEventsCard._stylesInjected) return;

    const styleId = 'frigate-events-card-modal-styles';
    if (document.getElementById(styleId)) {
      FrigateEventsCard._stylesInjected = true;
      return;
    }

    const style = document.createElement('style');
    style.id = styleId;
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
        padding: 20px;
        box-sizing: border-box;
        backdrop-filter: blur(5px);
        animation: frigate-modal-fade-in 0.2s forwards;
      }

      @keyframes frigate-modal-fade-in {
        from { opacity: 0; }
        to { opacity: 1; }
      }

      .frigate-events-modal-content {
        position: relative;
        width: fit-content;
        min-width: 450px;
        max-width: 90%;
        max-height: 90%;
        background: var(--card-background-color, #1c1c1c);
        border-radius: 12px;
        overflow: hidden;
        box-shadow: 0 4px 20px rgba(0, 0, 0, 0.5);
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
        background: #1c1c1c;
      }

      .frigate-events-modal-image-container img,
      .frigate-events-modal-image-container video {
        max-width: 100%;
        max-height: 55vh;
        width: auto;
        height: auto;
        display: block;
        background-color: #1c1c1c;
      }

      .frigate-events-modal-close {
        position: absolute;
        top: 10px;
        right: 10px;
        background: rgba(0, 0, 0, 0.5);
        color: white;
        width: 32px;
        height: 32px;
        border-radius: 50%;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 18px;
        cursor: pointer;
        transition: background 0.2s;
        backdrop-filter: blur(4px);
        border: none;
        font-family: inherit;
      }

      .frigate-events-modal-close:hover {
        background: rgba(0, 0, 0, 0.8);
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

      .mask-manager-prune-btn {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 6px 12px;
        border-radius: 6px;
        font-size: 12px;
        font-weight: 600;
        color: #fca5a5;
        background: rgba(239, 68, 68, 0.15);
        border: 1px solid rgba(239, 68, 68, 0.35);
        cursor: pointer;
        transition: background 0.15s, color 0.15s;
        font-family: inherit;
      }

      .mask-manager-prune-btn:hover {
        background: rgba(239, 68, 68, 0.3);
        color: #fecaca;
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
        padding: 8px 10px;
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
        color: #fca5a5;
        background: rgba(239, 68, 68, 0.15);
        border: 1px solid rgba(239, 68, 68, 0.3);
        cursor: pointer;
        transition: all 0.15s;
        font-family: inherit;
        margin-left: auto;
      }

      .mask-remove-btn:hover {
        background: rgba(239, 68, 68, 0.3);
        color: #f87171;
      }

      .mask-empty-state {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        text-align: center;
        padding: 36px 20px;
        gap: 10px;
        color: #888;
      }

      .mask-empty-state svg {
        width: 44px;
        height: 44px;
        fill: #475569;
      }

      .mask-empty-state h4 {
        margin: 0;
        font-size: 15px;
        color: #cbd5e1;
        font-weight: 600;
      }

      .mask-empty-state p {
        margin: 0;
        font-size: 13px;
        max-width: 380px;
        line-height: 1.5;
        color: #71717a;
      }
    `;
    document.head.appendChild(style);
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
            : `<img src="${snapshotUrl}" alt="${event.label}" />`
          }          ${nextBtnHtml}
          <button class="frigate-events-modal-close">x</button>
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
        this.dispatchEvent(new CustomEvent('hass-notification', {
          detail: { message: `Temporary mask removed for ${event.camera} (restart Frigate to apply)` },
          bubbles: true,
          composed: true,
        }));
        return false;
      } else {
        // Add mask
        const durationHours = this._getMaskDurationHours();
        if (this.hass.callService) {
          try {
            await this.hass.callService('frigate_temp_mask', 'add_mask', {
              camera: event.camera,
              event_id: event.id,
              mask_id: maskId,
              duration_hours: durationHours,
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
          detail: { message: `Temporary mask applied for ${event.camera} (${durationHours}h)` },
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
    this._openContextMenu(e.clientX, e.clientY, event);
  }

  private _handleTouchStart(e: TouchEvent, event: FrigateEvent): void {
    if (e.touches.length !== 1) return;
    const touch = e.touches[0];
    const clientX = touch.clientX;
    const clientY = touch.clientY;

    this._touchTimeout = setTimeout(() => {
      this._openContextMenu(clientX, clientY, event);
    }, 500);
  }

  private _handleTouchEnd(): void {
    if (this._touchTimeout) {
      clearTimeout(this._touchTimeout);
      this._touchTimeout = undefined;
    }
  }

  private _openContextMenu(x: number, y: number, event: FrigateEvent): void {
    this._closeContextMenu();
    this._injectModalStyles();

    const maskId = event.id.includes('-') ? event.id.split('-')[0] : event.id;
    const activeMasks = (this.hass?.states?.['sensor.frigate_active_masks']?.attributes?.masks as any[]) || [];
    const currentMask = Array.isArray(activeMasks) ? activeMasks.find((m: any) => m.mask_id === maskId) : undefined;
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
      <button class="frigate-events-context-item danger" data-action="mask">
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
      this._handleEventClick(event);
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

  private _handleLiveViewContextMenu(e: MouseEvent): void {
    e.preventDefault();
    e.stopPropagation();
    this._openLiveViewContextMenu(e.clientX, e.clientY);
  }

  private _handleLiveViewTouchStart(e: TouchEvent): void {
    if (e.touches.length !== 1) return;
    const touch = e.touches[0];
    const clientX = touch.clientX;
    const clientY = touch.clientY;

    this._liveTouchTimeout = setTimeout(() => {
      this._openLiveViewContextMenu(clientX, clientY);
    }, 500);
  }

  private _handleLiveViewTouchEnd(): void {
    if (this._liveTouchTimeout) {
      clearTimeout(this._liveTouchTimeout);
      this._liveTouchTimeout = undefined;
    }
  }

  private _openLiveViewContextMenu(x: number, y: number): void {
    this._closeContextMenu();
    this._injectModalStyles();

    const activeMasks = (this.hass?.states?.['sensor.frigate_active_masks']?.attributes?.masks as any[]) || [];
    const maskCount = Array.isArray(activeMasks) ? activeMasks.length : 0;

    const hasTempMaskIntegration = !!(
      this._config?.show_temp_mask !== false &&
      (this.hass?.services?.['frigate_temp_mask'] || this.hass?.services?.['shell_command']?.['frigate_add_temp_mask'] || this.hass?.states?.['sensor.frigate_active_masks'])
    );

    const menu = document.createElement('div');
    menu.className = 'frigate-events-context-menu live-view-context-menu';

    menu.innerHTML = `
      ${hasTempMaskIntegration ? `
      <button class="frigate-events-context-item masked" data-action="manage-masks">
        <svg viewBox="0 0 24 24"><path d="M12,1L3,5V11C3,16.55 6.84,21.74 12,23C17.16,21.74 21,16.55 21,11V5L12,1M12,5A6,6 0 0,1 18,11C18,14.41 15.46,18.22 12,19.82C8.54,18.22 6,14.41 6,11A6,6 0 0,1 12,5Z"/></svg>
        <div class="duration-label-container">
          <span>Manage Temporary Masks</span>
          <span class="duration-subtitle">${maskCount > 0 ? `${maskCount} active ${maskCount === 1 ? 'mask' : 'masks'}` : 'No active masks'}</span>
        </div>
      </button>
      <button class="frigate-events-context-item" data-action="toggle-overlay">
        <svg viewBox="0 0 24 24"><path d="M12,9A3,3 0 0,0 9,12A3,3 0 0,0 12,15A3,3 0 0,0 15,12A3,3 0 0,0 12,9M12,17A5,5 0 0,1 7,12A5,5 0 0,1 12,7A5,5 0 0,1 17,12A5,5 0 0,1 12,7M12,4.5C7,4.5 2.73,7.61 1,12C2.73,16.39 7,19.5 12,19.5C17,19.5 21.27,16.39 23,12C21.27,7.61 17,4.5 12,4.5Z"/></svg>
        <span>${this._showLiveMaskOverlays ? 'Hide Mask Overlays' : 'Show Mask Overlays'}</span>
      </button>
      ${maskCount > 0 ? `
      <button class="frigate-events-context-item danger" data-action="prune-all">
        <svg viewBox="0 0 24 24"><path d="M19.36,2.72L20.78,4.14L15.06,9.85C16.13,11.39 16.28,13.24 15.38,14.44L9.06,8.12C10.26,7.22 12.11,7.37 13.65,8.44L19.36,2.72M5.93,17.57C3.92,15.56 2.69,13.16 2.35,10.92L7.23,8.83L14.67,16.27L12.58,21.15C10.34,20.81 7.94,19.58 5.93,17.57Z"/></svg>
        <span>Prune All Masks</span>
      </button>
      ` : ''}
      <div class="frigate-events-context-separator"></div>
      ` : ''}
      <button class="frigate-events-context-item" data-action="fullscreen">
        <svg viewBox="0 0 24 24"><path d="M5,5H10V7H7V10H5V5M14,5H19V10H17V7H14V5M17,14H19V19H14V17H17V14M10,17V19H5V14H7V17H10Z"/></svg>
        <span>Toggle Fullscreen</span>
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

    menu.querySelector('[data-action="manage-masks"]')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this._closeContextMenu();
      this._showMaskManagerModal();
    });

    menu.querySelector('[data-action="toggle-overlay"]')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this._closeContextMenu();
      this._showLiveMaskOverlays = !this._showLiveMaskOverlays;
      this.requestUpdate();
    });

    menu.querySelector('[data-action="prune-all"]')?.addEventListener('click', async (e) => {
      e.stopPropagation();
      this._closeContextMenu();
      await this._executePruneAllMasks();
    });

    menu.querySelector('[data-action="fullscreen"]')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this._closeContextMenu();
      const container = this.renderRoot?.querySelector('.live-view-container') as HTMLElement | null;
      if (container) {
        this._handleLiveViewClick({ currentTarget: container } as any);
      }
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

  private _showMaskManagerModal(): void {
    this._closeContextMenu();
    this._injectModalStyles();

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

  private _renderMaskManagerContent(container: HTMLElement): void {
    const rawMasks = (this.hass?.states?.['sensor.frigate_active_masks']?.attributes?.masks as any[]) || [];
    const activeMasks = Array.isArray(rawMasks) ? rawMasks : [];
    const totalCount = activeMasks.length;

    // Get unique cameras
    const cameras = Array.from(new Set(activeMasks.map((m: any) => m.camera).filter(Boolean)));
    const filterCamera = this._maskManagerSelectedCamera || 'all';

    const filteredMasks = filterCamera === 'all'
      ? activeMasks
      : activeMasks.filter((m: any) => m.camera === filterCamera);

    const durationPresets = [
      { hours: 1, label: '1h' },
      { hours: 4, label: '4h' },
      { hours: 8, label: '8h' },
      { hours: 12, label: '12h' },
      { hours: 24, label: '24h' },
      { hours: 48, label: '48h' },
      { hours: 168, label: '7d' },
    ];

    container.innerHTML = `
      <div class="frigate-events-modal-content mask-manager-content">
        <div class="mask-manager-header">
          <div class="mask-manager-header-left">
            <div class="mask-manager-title">
              <svg viewBox="0 0 24 24" style="width: 20px; height: 20px; fill: #60a5fa;"><path d="M12,1L3,5V11C3,16.55 6.84,21.74 12,23C17.16,21.74 21,16.55 21,11V5L12,1M12,5A6,6 0 0,1 18,11C18,14.41 15.46,18.22 12,19.82C8.54,18.22 6,14.41 6,11A6,6 0 0,1 12,5Z"/></svg>
              <span>Temporary Masks</span>
            </div>
            <span class="mask-manager-count-badge">${totalCount} Active</span>
          </div>
          <div class="mask-manager-header-actions">
            ${totalCount > 0 ? `
              <button class="mask-manager-prune-btn" data-action="prune-all">
                <svg viewBox="0 0 24 24" style="width: 14px; height: 14px; fill: currentColor;"><path d="M19.36,2.72L20.78,4.14L15.06,9.85C16.13,11.39 16.28,13.24 15.38,14.44L9.06,8.12C10.26,7.22 12.11,7.37 13.65,8.44L19.36,2.72M5.93,17.57C3.92,15.56 2.69,13.16 2.35,10.92L7.23,8.83L14.67,16.27L12.58,21.15C10.34,20.81 7.94,19.58 5.93,17.57Z"/></svg>
                <span>Prune All</span>
              </button>
            ` : ''}
            <button class="frigate-events-modal-close" data-action="close">✕</button>
          </div>
        </div>

        <div class="mask-manager-body">
          ${cameras.length > 1 ? `
            <div class="mask-filter-tabs">
              <button class="mask-filter-tab ${filterCamera === 'all' ? 'active' : ''}" data-camera-filter="all">
                All Cameras (${totalCount})
              </button>
              ${cameras.map(c => `
                <button class="mask-filter-tab ${filterCamera === c ? 'active' : ''}" data-camera-filter="${c}">
                  ${this._formatCameraName(c)} (${activeMasks.filter((m: any) => m.camera === c).length})
                </button>
              `).join('')}
            </div>
          ` : ''}

          ${filteredMasks.length === 0 ? `
            <div class="mask-empty-state">
              <svg viewBox="0 0 24 24"><path d="M12,1L3,5V11C3,16.55 6.84,21.74 12,23C17.16,21.74 21,16.55 21,11V5L12,1M12,5A6,6 0 0,1 18,11C18,14.41 15.46,18.22 12,19.82C8.54,18.22 6,14.41 6,11A6,6 0 0,1 12,5Z"/></svg>
              <h4>No Active Temporary Masks</h4>
              <p>Apply temporary false-positive masks by right-clicking any event thumbnail below or from actionable notifications.</p>
            </div>
          ` : `
            <div class="mask-cards-list">
              ${filteredMasks.map((mask: any) => {
                const currentDurationHours = typeof mask.duration_hours === 'number' ? mask.duration_hours : 24;
                const isCustom = !durationPresets.some(p => Math.abs(p.hours - currentDurationHours) < 0.01);
                const remainingText = this._formatMaskRemainingTime(mask.expires_at);

                return `
                  <div class="mask-card" data-mask-id="${mask.mask_id}">
                    <div class="mask-card-header">
                      <div class="mask-card-title-col">
                        <span class="mask-camera-pill">${this._formatCameraName(mask.camera || 'Camera')}</span>
                        <span class="mask-id-pill">#${mask.mask_id}</span>
                      </div>
                      <div class="mask-card-time-badge" data-timer-mask-id="${mask.mask_id}">
                        <svg viewBox="0 0 24 24" style="width: 13px; height: 13px; fill: currentColor;"><path d="M12,20A8,8 0 0,0 20,12A8,8 0 0,0 12,4A8,8 0 0,0 4,12A8,8 0 0,0 12,20M12,2A10,10 0 0,1 22,12A10,10 0 0,1 12,2C6.47,22 2,17.5 2,12A10,10 0 0,1 12,2M12.5,7V12.25L17,14.92L16.25,16.15L11,13V7H12.5Z"/></svg>
                        <span class="timer-text">${remainingText}</span>
                      </div>
                    </div>
                    <div class="mask-card-details">
                      <div class="mask-detail-row">
                        <span class="detail-label">Duration:</span>
                        <span class="detail-value">${currentDurationHours} ${currentDurationHours === 1 ? 'hour' : 'hours'}</span>
                      </div>
                      ${mask.polygon ? `
                      <div class="mask-detail-row">
                        <span class="detail-label">Polygon:</span>
                        <span class="detail-value mono">${mask.polygon}</span>
                      </div>
                      ` : ''}
                    </div>
                    <div class="mask-card-actions">
                      <div class="mask-duration-selector">
                        <span class="duration-title">Duration:</span>
                        <div class="mask-duration-chips">
                          ${durationPresets.map(p => {
                            const isSelected = Math.abs(p.hours - currentDurationHours) < 0.01;
                            return `
                              <button class="mask-duration-chip ${isSelected ? 'active' : ''}" data-action="set-duration" data-mask-id="${mask.mask_id}" data-camera="${mask.camera || ''}" data-hours="${p.hours}" data-poly="${mask.polygon || ''}">
                                ${p.label}
                              </button>
                            `;
                          }).join('')}
                          <button class="mask-duration-chip ${isCustom ? 'active' : ''}" data-action="custom-duration" data-mask-id="${mask.mask_id}" data-camera="${mask.camera || ''}" data-poly="${mask.polygon || ''}">
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
          `}
        </div>
      </div>
    `;

    // Attach listeners
    const content = container.querySelector('.mask-manager-content');
    content?.addEventListener('click', (e) => e.stopPropagation());

    container.querySelector('[data-action="close"]')?.addEventListener('click', () => {
      this._removeMaskManagerModal();
    });

    container.querySelector('[data-action="prune-all"]')?.addEventListener('click', async () => {
      await this._executePruneAllMasks();
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
        if (maskId) {
          await this._executeChangeMaskDurationById(maskId, camera, hours, polygon);
        }
      });
    });

    container.querySelectorAll('[data-action="custom-duration"]').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const maskId = (btn as HTMLElement).getAttribute('data-mask-id');
        const camera = (btn as HTMLElement).getAttribute('data-camera') || '';
        const polygon = (btn as HTMLElement).getAttribute('data-poly') || undefined;
        const input = window.prompt('Enter temporary mask duration in hours:', '24');
        if (!input) return;
        const parsed = parseFloat(input.trim());
        if (isNaN(parsed) || parsed <= 0) return;
        if (maskId) {
          await this._executeChangeMaskDurationById(maskId, camera, parsed, polygon);
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

  private async _executeRemoveMask(maskId: string, camera?: string): Promise<void> {
    if (!this.hass) return;
    try {
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
    polygon?: string
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

  private async _executeDeleteEvent(event: FrigateEvent): Promise<void> {
    const clientId = this._config?.frigate_client_id || 'frigate';
    const success = await deleteEvent(clientId, event.id, this._config?.go2rtc_url);

    // Remove from local events array immediately
    this._events = this._events.filter(e => e.id !== event.id);
    this.requestUpdate();

    if (this._selectedEvent && this._selectedEvent.id === event.id) {
      this._handleModalClose();
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
      (
        (box[2] > box[0] && box[3] > box[1]) ||
        (box[2] > 0 && box[3] > 0)
      );
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
    const [a, b, c, d] = box;

    if (this._isNormalizedBox(box)) {
      const isCenterWidthHeight = a + (c / 2) > 1 || b + (d / 2) > 1;
      const normalizedX = isCenterWidthHeight ? a : a + (c / 2);
      const normalizedY = isCenterWidthHeight ? b : b + (d / 2);

      return {
        x: normalizedX * videoWidth,
        y: normalizedY * videoHeight,
      };
    }

    return {
      x: (a + c) / 2,
      y: (b + d) / 2,
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
    let renderedPlaceholders = Array(placeholderCount).fill(0).map(() => 
      html`<div class="placeholder" title="No events found. Check that snapshots: enabled: true in Frigate."></div>`
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
    if (videoEl && this._remoteStream && videoEl.srcObject !== this._remoteStream) {
      videoEl.srcObject = this._remoteStream;
      videoEl.play().catch(() => {});
    }
  };

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

    const liveEntity = this._config?.live_view_entity || '';
    const liveCamera = liveEntity.replace(/^camera\./, '').replace(/_(live|sub|detect)$/, '');
    const activeMasks = (this.hass?.states?.['sensor.frigate_active_masks']?.attributes?.masks as any[]) || [];
    const cameraMasks = Array.isArray(activeMasks)
      ? activeMasks.filter((m: any) => !liveCamera || m.camera === liveCamera || m.camera === liveEntity.replace(/^camera\./, ''))
      : [];

    let viewBoxW = 1920;
    let viewBoxH = 1080;
    if (cameraMasks.length > 0) {
      let maxCoordX = 0;
      let maxCoordY = 0;
      for (const m of cameraMasks) {
        if (!m.polygon) continue;
        const nums = m.polygon.split(',').map((s: string) => parseFloat(s.trim())).filter((n: number) => !isNaN(n));
        for (let i = 0; i < nums.length; i += 2) {
          if (nums[i] > maxCoordX) maxCoordX = nums[i];
          if ((nums[i + 1] ?? 0) > maxCoordY) maxCoordY = nums[i + 1];
        }
      }
      if (maxCoordX > 1920 || maxCoordY > 1080) {
        viewBoxW = maxCoordX > 2560 ? 3840 : 2560;
        viewBoxH = maxCoordX > 2560 ? 2160 : 1440;
      } else if (maxCoordX <= 1280 && maxCoordY <= 720 && maxCoordX > 0) {
        viewBoxW = 1280;
        viewBoxH = 720;
      }
    }

    return html`
      <div
        class="live-view-container"
        style="aspect-ratio: ${aspectRatio};"
        @click=${(e: Event) => this._handleLiveViewClick(e)}
        @contextmenu=${(e: MouseEvent) => this._handleLiveViewContextMenu(e)}
        @touchstart=${(e: TouchEvent) => this._handleLiveViewTouchStart(e)}
        @touchend=${() => this._handleLiveViewTouchEnd()}
        @touchcancel=${() => this._handleLiveViewTouchEnd()}
        title="Click for fullscreen · Right-click for temporary masks"
      >
        <video
          class="live-view-video"
          autoplay
          muted
          playsinline
          webkit-playsinline
          disablepictureinpicture
          disableremoteplayback
          poster="data:image/png;base64,iVBORw0KGgoAAAANSU5EUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="
          ${ref(this._handleLiveVideoRef)}
        ></video>

        ${this._showLiveMaskOverlays && cameraMasks.length > 0 ? html`
          <svg class="live-view-mask-overlay" viewBox="0 0 ${viewBoxW} ${viewBoxH}" preserveAspectRatio="none">
            ${cameraMasks.map((mask: any) => {
              if (!mask.polygon) return '';
              const nums = mask.polygon.split(',').map((s: string) => parseFloat(s.trim())).filter((n: number) => !isNaN(n));
              if (nums.length < 6) return '';
              let minX = Infinity, minY = Infinity;
              const pts: string[] = [];
              for (let i = 0; i < nums.length; i += 2) {
                const px = nums[i];
                const py = nums[i + 1] ?? 0;
                pts.push(`${px},${py}`);
                if (px < minX) minX = px;
                if (py < minY) minY = py;
              }
              const remainingText = this._formatMaskRemainingTime(mask.expires_at);
              const labelText = `🛡️ Mask · ${remainingText}`;
              const labelWidth = Math.max(130, labelText.length * 8);

              return html`
                <g class="live-mask-poly-group" @click=${(e: Event) => { e.stopPropagation(); this._showMaskManagerModal(); }}>
                  <polygon points="${pts.join(' ')}" class="live-mask-poly" />
                  <rect x="${Math.max(4, minX)}" y="${Math.max(4, minY - 26)}" width="${labelWidth}" height="22" rx="4" class="live-mask-label-bg" />
                  <text x="${Math.max(10, minX + 6)}" y="${Math.max(18, minY - 10)}" class="live-mask-label-text">${labelText}</text>
                </g>
              `;
            })}
          </svg>
        ` : ''}

        ${cameraMasks.length > 0 ? html`
          <div
            class="live-mask-indicator ${this._showLiveMaskOverlays ? 'overlay-on' : ''}"
            @click=${(e: Event) => {
              e.stopPropagation();
              this._showMaskManagerModal();
            }}
            title="Click to manage temporary masks (right-click for options)"
          >
            <svg viewBox="0 0 24 24"><path d="M12,1L3,5V11C3,16.55 6.84,21.74 12,23C17.16,21.74 21,16.55 21,11V5L12,1M12,5A6,6 0 0,1 18,11C18,14.41 15.46,18.22 12,19.82C8.54,18.22 6,14.41 6,11A6,6 0 0,1 12,5Z"/></svg>
            <span>${cameraMasks.length} ${cameraMasks.length === 1 ? 'Mask' : 'Masks'}</span>
          </div>
        ` : ''}
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

    return html`
      <div class="event"
        @click=${() => this._handleEventClick(event)}
        @contextmenu=${(e: MouseEvent) => this._handleContextMenu(e, event)}
        @touchstart=${(e: TouchEvent) => this._handleTouchStart(e, event)}
        @touchend=${() => this._handleTouchEnd()}
        @touchcancel=${() => this._handleTouchEnd()}
        @mouseenter=${() => { if (playVideoOnHover) this._hoveredEventId = event.id; }}
        @mouseleave=${() => { if (playVideoOnHover) this._hoveredEventId = undefined; }}
        style="position: relative;"
      >
        <img
          src="${snapshotUrl}"
          alt="${event.label}"
          loading="lazy"
          @error=${(e: Event) => {
            const img = e.target as HTMLImageElement;
            if (img && !img.src.includes('/thumbnail/')) {
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
      }

      .event img,
      .event video {
        width: 100%;
        height: 100%;
        object-fit: cover;
        display: block;
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

      .live-view-video {
        width: 100%;
        height: 100%;
        object-fit: contain;
        display: block;
        background-color: #1c1c1c;
        transform: translateZ(0);
        will-change: transform;
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

      .live-view-mask-overlay {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
        pointer-events: auto;
        z-index: 2;
      }

      .live-mask-poly-group {
        cursor: pointer;
      }

      .live-mask-poly {
        fill: rgba(59, 130, 246, 0.22);
        stroke: rgba(96, 165, 250, 0.85);
        stroke-width: 2;
        stroke-dasharray: 6 3;
        transition: fill 0.2s, stroke 0.2s, stroke-width 0.2s;
      }

      .live-mask-poly-group:hover .live-mask-poly {
        fill: rgba(59, 130, 246, 0.4);
        stroke: #93c5fd;
        stroke-width: 3;
      }

      .live-mask-label-bg {
        fill: rgba(15, 23, 42, 0.9);
        stroke: rgba(96, 165, 250, 0.6);
        stroke-width: 1;
      }

      .live-mask-label-text {
        fill: #f0f9ff;
        font-size: 11px;
        font-weight: 600;
        font-family: inherit;
        user-select: none;
      }

      .live-mask-indicator {
        position: absolute;
        top: 8px;
        left: 8px;
        z-index: 4;
        display: flex;
        align-items: center;
        gap: 5px;
        padding: 4px 9px;
        border-radius: 6px;
        font-size: 11px;
        font-weight: 600;
        color: #93c5fd;
        background: rgba(15, 23, 42, 0.85);
        border: 1px solid rgba(59, 130, 246, 0.5);
        backdrop-filter: blur(8px);
        cursor: pointer;
        transition: background 0.15s, transform 0.15s, border-color 0.15s;
        user-select: none;
      }

      .live-mask-indicator:hover {
        background: rgba(30, 58, 138, 0.95);
        transform: scale(1.03);
        border-color: #60a5fa;
      }

      .live-mask-indicator svg {
        width: 13px;
        height: 13px;
        fill: #60a5fa;
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
