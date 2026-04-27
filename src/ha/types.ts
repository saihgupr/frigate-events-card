/**
 * Simplified Home Assistant types for the Frigate Events Card
 */
import { MessageBase } from 'home-assistant-js-websocket';

export interface HomeAssistant {
    connection: {
        subscribeMessage<T>(
            callback: (message: T) => void,
            subscribeMessage: MessageBase
        ): Promise<() => void>;
    };
    config: {
        time_zone: string;
    };
    states: Record<string, { state: string; last_changed?: string; attributes?: Record<string, unknown> }>;
    callWS: <T>(msg: MessageBase) => Promise<T>;
    hassUrl: (path?: string) => string;
}

export interface LovelaceCardConfig {
    type: string;
    [key: string]: unknown;
}

export interface LovelaceCard extends HTMLElement {
    hass?: HomeAssistant;
    getCardSize(): number | Promise<number>;
    setConfig(config: LovelaceCardConfig): void;
}
