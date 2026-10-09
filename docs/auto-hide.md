# Review and playback gallery controls

Frigate Events Plus keeps these controls opt-in so existing dashboards behave as before.

## Configuration

```yaml
type: custom:frigate-events-card
auto_hide_reviewed: true
auto_hide_watched: true
```

- `auto_hide_reviewed`: removes an event thumbnail from this card's gallery when Frigate reports that the associated review item is reviewed.
- `auto_hide_watched`: removes a thumbnail after the full clip in the details modal reaches the video's `ended` event. Hover previews do not count.
- `auto_hide_storage_key`: optional key for keeping browser playback history separate between cards that share the same instance and filters.

Reviewed-state lookup requires the companion `frigate_temp_mask` Home Assistant integration and a Frigate version that supports `GET /api/review/event/{event_id}`. Frigate stores review status per user. If the API is unavailable or unsupported, the card leaves the event visible.

Watched history is saved in the current browser profile's local storage and is not shared across devices. Clearing that browser's site data resets it.

These settings only change which thumbnails the card renders. They do not modify Frigate events, review records, clips, recordings, or snapshots.
