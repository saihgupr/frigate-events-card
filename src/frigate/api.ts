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
    return `/api/frigate/${encodeURIComponent(clientId)}/notifications/${encodeURIComponent(eventId)}/thumbnail.jpg`;
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
            expires_ticks: expiresSeconds
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
 * Delete an event from Frigate
 * Tries multiple endpoints in order:
 * 1. Direct Frigate URL (if frigate_url is configured)
 * 2. Frigate URL derived from go2rtc_url (same host, port 5000)
 * 3. frigate_temp_mask HA proxy view (requires HA component loaded with new code)
 * 4. Standard Frigate HA integration proxy URL
 */
export async function deleteEvent(
    clientId: string,
    eventId: string,
    frigateUrl?: string,
    go2rtcUrl?: string,
    hass?: HomeAssistant
): Promise<boolean> {
    const encoded = encodeURIComponent(eventId);

    // 1. Try Home Assistant service call via frigate_temp_mask integration
    if (hass?.callService) {
        try {
            await hass.callService('frigate_temp_mask', 'delete_event', {
                event_id: eventId,
            });
            return true;
        } catch (e) {
            console.debug('frigate_temp_mask.delete_event service call failed:', e);
        }
    }

    // 2. Try frigate_temp_mask HA proxy HTTP view (DELETE then POST)
    try {
        const proxyRes = await fetch(`/api/frigate_temp_mask/events/${encoded}`, { method: 'DELETE' });
        if (proxyRes.ok) return true;
        if (proxyRes.status === 405) {
            const postRes = await fetch(`/api/frigate_temp_mask/events/${encoded}`, { method: 'POST' });
            if (postRes.ok) return true;
        }
    } catch (e) {
        console.debug('frigate_temp_mask HTTP proxy delete failed:', e);
    }

    // 3. Direct Frigate URL if explicitly configured
    if (frigateUrl) {
        try {
            const baseUrl = frigateUrl.replace(/\/$/, '');
            const res = await fetch(`${baseUrl}/api/events/${encoded}`, { method: 'DELETE' });
            if (res.ok) return true;
            console.debug(`Direct Frigate delete returned ${res.status}`);
        } catch (e) {
            console.debug('Direct Frigate API delete failed:', e);
        }
    }

    // 4. Derive Frigate URL from go2rtc URL (same host, default Frigate port 5000)
    if (go2rtcUrl && !frigateUrl) {
        try {
            const u = new URL(go2rtcUrl);
            const derivedBase = `${u.protocol}//${u.hostname}:5000`;
            const res = await fetch(`${derivedBase}/api/events/${encoded}`, { method: 'DELETE' });
            if (res.ok) return true;
            console.debug(`Derived Frigate delete (${derivedBase}) returned ${res.status}`);
        } catch (e) {
            console.debug('Derived Frigate URL delete failed:', e);
        }
    }

    // 5. Standard Frigate HA integration proxy URL
    try {
        const haProxyRes = await fetch(`/api/frigate/${encodeURIComponent(clientId)}/events/${encoded}`, { method: 'DELETE' });
        if (haProxyRes.ok) return true;
    } catch (e) {
        console.debug('Standard Frigate proxy delete failed:', e);
    }

    return false;
}
