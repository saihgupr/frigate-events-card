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
 * Get snapshot URL for an event (with bounding box)
 */
export function getEventSnapshotURL(
    clientId: string,
    eventId: string,
    options?: { bbox?: boolean; crop?: boolean; timestamp?: boolean }
): string {
    const params = new URLSearchParams();
    if (options?.bbox) params.set('bbox', '1');
    if (options?.crop) params.set('crop', '1');
    if (options?.timestamp) params.set('timestamp', '1');

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
