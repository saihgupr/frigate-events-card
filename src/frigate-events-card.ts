/**
 * Frigate Events Card - A simple Lovelace card for displaying recent Frigate events
 */
import { LitElement, html, css, PropertyValues, TemplateResult, CSSResult } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { ref } from 'lit/directives/ref.js';
import { HomeAssistant, LovelaceCardConfig, LovelaceLayoutOptions } from './ha/types';
import { FrigateBoundingBox, FrigateEvent, FrigateEventChange, FrigatePathPoint } from './frigate/types';
import { getEvents, getEventSnapshotURL, getEventThumbnailURL, subscribeToEvents, getEventClipURL, getEventHlsURL } from './frigate/api';

const CARD_VERSION = '2.3.1';

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

  private _unsubscribe?: () => void;
  private _pollInterval?: number;
  private _boundVisibilityHandler?: () => void;
  private _boundKeyDownHandler?: (e: KeyboardEvent) => void;
  private _modalContainer?: HTMLDivElement;
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
    } catch (e) {
      console.error('Failed to load Frigate events:', e);
      this._error = 'Failed to load events';
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
    let renderedPlaceholders = Array(placeholderCount).fill(0).map(() => html`<div class="placeholder"></div>`);
    
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
          ${this._loading
        ? html`<div class="loading"></div>`
        : this._error
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
            <span>⚠ Live feed unavailable</span>
            <span class="live-view-error-detail">${this._liveViewError}</span>
          </div>
        </div>
      `;
    }

    return html`
      <div
        class="live-view-container"
        style="aspect-ratio: ${aspectRatio};"
        @click=${(e: Event) => this._handleLiveViewClick(e)}
        title="Click for fullscreen"
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
          ${ref((el: Element | undefined) => {
            const videoEl = (el as HTMLVideoElement) ?? null;
            this._liveVideoEl = videoEl;
            // ONLY set srcObject if it has changed to avoid resetting video decoder on re-render
            if (videoEl && this._remoteStream && videoEl.srcObject !== this._remoteStream) {
              videoEl.srcObject = this._remoteStream;
              videoEl.play().catch(() => {});
            }
          })}
        ></video>
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
        opacity: 0.7;
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
