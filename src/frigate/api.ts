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
    return `/api/frigate/${encodeURIComponent(clientId)}/thumbnail/${encodeURIComponent(eventId)}`;
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
 */
export async function deleteEvent(
    clientId: string,
    eventId: string,
    frigateUrl?: string,
    hass?: HomeAssistant
): Promise<boolean> {
    try {
        // 1. If explicit direct Frigate URL is configured, try direct API
        if (frigateUrl) {
            try {
                const baseUrl = frigateUrl.replace(/\/$/, '');
                const res = await fetch(`${baseUrl}/api/events/${encodeURIComponent(eventId)}`, {
                    method: 'DELETE',
                });
                if (res.ok) return true;
            } catch (e) {
                console.debug('Direct Frigate API delete failed, trying backend proxies:', e);
            }
        }

        // 2. Try frigate_temp_mask proxy view endpoint (DELETE then POST)
        try {
            const proxyRes = await fetch(`/api/frigate_temp_mask/events/${encodeURIComponent(eventId)}`, {
                method: 'DELETE',
            });
            if (proxyRes.ok) return true;
            if (proxyRes.status === 405) {
                const postRes = await fetch(`/api/frigate_temp_mask/events/${encodeURIComponent(eventId)}`, {
                    method: 'POST',
                });
                if (postRes.ok) return true;
            }
        } catch (e) {
            console.debug('frigate_temp_mask HTTP proxy delete failed:', e);
        }

        // 3. Try Home Assistant service call via frigate_temp_mask
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

        // 4. Try standard Frigate integration proxy URL
        try {
            const haProxyRes = await fetch(`/api/frigate/${encodeURIComponent(clientId)}/events/${encodeURIComponent(eventId)}`, {
                method: 'DELETE',
            });
            if (haProxyRes.ok) return true;
        } catch (e) {
            console.debug('Standard Frigate proxy delete failed:', e);
        }

        return false;
    } catch (e) {
        console.error('Failed to delete Frigate event:', e);
        return false;
    }
}

