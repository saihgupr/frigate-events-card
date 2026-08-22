/**
 * Frigate event types
 */

/** Frigate event API format: [x, y, width, height], normally normalized to 0–1. */
export type FrigateBoundingBox = [number, number, number, number];
export type FrigatePathPoint = [[number, number], number];

export interface FrigateSnapshotData {
    box?: FrigateBoundingBox;
    region?: FrigateBoundingBox;
}

export interface FrigateEventData {
    box?: FrigateBoundingBox;
    region?: FrigateBoundingBox;
    path_data?: FrigatePathPoint[];
    snapshot?: FrigateSnapshotData | null;
    top_score?: number | null;
    score?: number | null;
    description?: string | null;
}

export interface FrigateEvent {
    id: string;
    camera: string;
    label: string;
    sub_label: string | null;
    start_time: number;
    end_time: number | null;
    top_score: number | null;
    has_clip: boolean;
    has_snapshot: boolean;
    zones: string[];
    retain_indefinitely?: boolean;
    box?: FrigateBoundingBox;
    region?: FrigateBoundingBox;
    data?: FrigateEventData | null;
    description?: string | null;
}

export interface FrigateEventChange {
    before: {
        camera: string;
        label: string;
        current_zones: string[];
        has_clip: boolean;
        has_snapshot: boolean;
    };
    after: {
        camera: string;
        label: string;
        current_zones: string[];
        has_clip: boolean;
        has_snapshot: boolean;
    };
    type: 'new' | 'update' | 'end';
}

export interface NativeFrigateEventQuery {
    instance_id?: string;
    cameras?: string[];
    labels?: string[];
    zones?: string[];
    after?: number;
    before?: number;
    limit?: number;
    has_clip?: boolean;
    has_snapshot?: boolean;
    favorites?: boolean;
}
