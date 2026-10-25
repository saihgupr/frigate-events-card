/**
 * Frigate API client for Home Assistant
 */
import { HomeAssistant } from '../ha/types';
import { FrigateEvent, FrigateEventChange, NativeFrigateEventQuery } from './types';

/**
 * Get events from Frigate via Home Assistant WebSocket
 */
export async function getEvents(
    hass: HomeAssistant,
    params?: NativeFrigateEventQuery
): Promise<FrigateEvent[]> {
    const response = await hass.callWS<string>({
        type: 'frigate/events/get',
        ...params,
    });

    // Response comes as JSON string, parse it
    return JSON.parse(response) as FrigateEvent[];
}

/**
 * Get thumbnail URL for an event
 */
export function getEventThumbnailURL(clientId: string, eventId: string): string {
    const prefix = clientId ? `/api/frigate/${encodeURIComponent(clientId)}` : '/api/frigate';
    return `${prefix}/notifications/${encodeURIComponent(eventId)}/thumbnail.jpg`;
}

/**
 * In-memory cache for signed paths to avoid redundant WebSocket calls
 */
const signedPathCache = new Map<string, { signed: string; expiresAt: number }>();

/**
 * Extracts relative path and query string from an absolute or relative URL
 */
export function toRelativePath(urlOrPath: string): string {
    if (!urlOrPath) return '';
    try {
        if (urlOrPath.startsWith('http://') || urlOrPath.startsWith('https://')) {
            const parsed = new URL(urlOrPath);
            return parsed.pathname + parsed.search;
        }
    } catch {
        // Fall through
    }
    return urlOrPath;
}

/**
 * Check if a valid signed URL is already cached for the given path
 */
export function getCachedSignedPath(path: string): string | null {
    const cleanPath = toRelativePath(path);
    if (!cleanPath) return null;
    const cached = signedPathCache.get(cleanPath);
    if (cached && cached.expiresAt > Date.now() + 60000) {
        return cached.signed;
    }
    return null;
}

/**
 * Request Home Assistant to sign a media/API path with an authentication signature (authSig)
 */
export async function signPath(
    hass: HomeAssistant,
    path: string,
    expiresSeconds = 3600
): Promise<string> {
    const cleanPath = toRelativePath(path);
    if (!cleanPath || !hass?.callWS) return cleanPath || path;

    // If already signed, cache and return as is
    if (cleanPath.includes('authSig=')) {
        return cleanPath;
    }

    const cached = getCachedSignedPath(cleanPath);
    if (cached) {
        return cached;
    }

    try {
        const response = await hass.callWS<{ path: string }>({
            type: 'auth/sign_path',
            path: cleanPath,
            expires: expiresSeconds
        });
        if (response?.path) {
            signedPathCache.set(cleanPath, {
                signed: response.path,
                expiresAt: Date.now() + (expiresSeconds * 1000)
            });
            return response.path;
        }
        return cleanPath;
    } catch (err) {
        console.warn('[frigate-events-card] Failed to sign path:', cleanPath, err);
        return cleanPath;
    }
}

/**
 * Get snapshot URL for an event
 */
export function getEventSnapshotURL(
    clientId: string,
    eventId: string,
    options?: { bbox?: boolean; crop?: boolean; timestamp?: boolean; cacheBust?: string | number }
): string {
    const params = new URLSearchParams();
    if (options?.bbox !== undefined) params.set('bbox', options.bbox ? '1' : '0');
    if (options?.crop !== undefined) params.set('crop', options.crop ? '1' : '0');
    if (options?.timestamp) params.set('timestamp', '1');
    if (options?.cacheBust) params.set('h', String(options.cacheBust));

    const queryString = params.toString();
    return `/api/frigate/${encodeURIComponent(clientId)}/notifications/${encodeURIComponent(eventId)}/snapshot.jpg${queryString ? '?' + queryString : ''}`;
}

/**
 * Get video clip URL for an event
 */
export function getEventClipURL(clientId: string, eventId: string): string {
    return `/api/frigate/${encodeURIComponent(clientId)}/notifications/${encodeURIComponent(eventId)}/clip.mp4`;
}

/**
 * Get HLS playlist URL for an event (Safari/iOS fallback)
 */
export function getEventHlsURL(clientId: string, eventId: string): string {
    return `/api/frigate/${encodeURIComponent(clientId)}/notifications/${encodeURIComponent(eventId)}/master.m3u8`;
}

/**
 * Get continuous footage dynamic clip MP4 URL for a camera window (Frigate 0.13)
 */
export function getVodClipURL(clientId: string, camera: string, startTs: number, endTs: number, frigateUrl?: string): string {
    const start = Math.floor(startTs);
    const end = Math.floor(endTs);
    const encCam = encodeURIComponent(camera);
    const directBase = frigateUrl ? frigateUrl.replace(/\/$/, '') : '';
    if (directBase) {
        return `${directBase}/api/${encCam}/start/${start}/end/${end}/clip.mp4`;
    }
    // Standard HA Frigate integration proxy route:
    return `/api/frigate/${encodeURIComponent(clientId)}/recording/${encCam}/start/${start}/end/${end}`;
}

/**
 * Get continuous footage VOD HLS playlist URL for a camera window (Frigate 0.13)
 */
export function getVodHlsURL(clientId: string, camera: string, startTs: number, endTs: number, frigateUrl?: string): string {
    const start = Math.floor(startTs);
    const end = Math.floor(endTs);
    const encCam = encodeURIComponent(camera);
    const directBase = frigateUrl ? frigateUrl.replace(/\/$/, '') : '';
    if (directBase) {
        return `${directBase}/vod/${encCam}/start/${start}/end/${end}/index.m3u8`;
    }
    return `/api/frigate/${encodeURIComponent(clientId)}/vod/${encCam}/start/${start}/end/${end}/index.m3u8`;
}


/**
 * Subscribe to real-time Frigate events
 */
export async function subscribeToEvents(
    hass: HomeAssistant,
    instanceId: string,
    callback: (event: FrigateEventChange) => void
): Promise<() => void> {
    const unsubscribe = await hass.connection.subscribeMessage<string>(
        (data) => {
            try {
                const parsed = JSON.parse(data) as FrigateEventChange;
                callback(parsed);
            } catch (e) {
                console.warn('Failed to parse Frigate event:', e);
            }
        },
        { type: 'frigate/events/subscribe', instance_id: instanceId }
    );

    return unsubscribe;
}

/**
 * Delete an event through the admin-only Home Assistant service.
 */
export async function deleteEvent(
    eventId: string,
    hass?: HomeAssistant
): Promise<boolean> {
    if (!hass?.callService) return false;
    try {
        await hass.callService('frigate_temp_mask', 'delete_event', { event_id: eventId });
        return true;
    } catch (e) {
        console.debug('frigate_temp_mask.delete_event service call failed:', e);
        return false;
    }
}

/**
 * Get recordings for a camera via Home Assistant WebSocket
 */
export async function getRecordings(
    hass: HomeAssistant,
    instanceId: string,
    camera: string,
    after?: number,
    before?: number
): Promise<Array<{ start_time: number; end_time: number; id: string }>> {
    try {
        const response = await hass.callWS<string>({
            type: 'frigate/recordings/get',
            instance_id: instanceId,
            camera: camera,
            after: after ? Math.floor(after) : undefined,
            before: before ? Math.floor(before) : undefined,
        });
        const parsed = typeof response === 'string' ? JSON.parse(response) : response;
        return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
        console.debug('Failed to fetch recordings via WS:', e);
        return [];
    }
}
