# Frigate Events Card

A simple Lovelace card for displaying recent Frigate detection events in a horizontal gallery

![Demo](https://raw.githubusercontent.com/saihgupr/frigate-events-card/main/images/snapshots/demo.gif)
![Screenshot](https://raw.githubusercontent.com/saihgupr/frigate-events-card/main/images/snapshots/screenshot_6.png)
![Screenshot](https://raw.githubusercontent.com/saihgupr/frigate-events-card/main/images/snapshots/screenshot_3.png)
![Screenshot](https://raw.githubusercontent.com/saihgupr/frigate-events-card/main/images/snapshots/screenshot_4.png)

## Features

- **Fast & Lightweight**: Minified and optimized for quick loading.
- **Live Updates**: Instantly shows new events via WebSocket.
- **Responsive**: Auto-adjusting grid layout that works great on mobile.
- **Rich Media**: High-quality snapshots with optional zooming.
- **Video Playback**: Natively stream MP4 and HLS (`.m3u8`) event clips directly in your browser.
- **Hover Previews**: Instantly play video clips when hovering over any event, with smooth auto-tracking that pans and follows the detected object throughout the clip.
- **Scrollable Gallery**: Optional horizontal scroll mode with arrow navigation and hidden scrollbar for a clean, native feel.
- **Customizable Layout**: Reverse the rendering order or offset the timeline to build the exact dashboard you want.
- **Daily Reset**: Optional automated clearing for a fresh daily view.
- **Interactive**: Detailed modal view with full event information.

## Installation

### HACS (Recommended)

This card can be easily installed via [HACS](https://hacs.xyz/) (Home Assistant Community Store) as a custom repository.

[![Open your Home Assistant instance and open a repository inside the Home Assistant Community Store.](https://my.home-assistant.io/badges/hacs_repository.svg)](https://my.home-assistant.io/redirect/hacs_repository/?owner=saihgupr&repository=frigate-events-card&category=plugin)

1. Open HACS in Home Assistant.
2. Click on the 3 dots in the top right corner and select **Custom repositories**.
3. Add the URL of this repository (`https://github.com/saihgupr/frigate-events-card`) and select **Dashboard** (or Lovelace) as the category.
4. Click **Add**, then close the modal.
5. You should now see "Frigate Events Card" in your HACS interface. Click on it and select **Download**.
6. When prompted, reload your browser cache.

### Manual Installation

1. Download `frigate-events-card.js` from the [latest release](https://github.com/saihgupr/frigate-events-card/releases)
2. Copy it to your Home Assistant `www/` folder
3. Add the resource in your Lovelace dashboard:
   ```yaml
   resources:
     - url: /local/frigate-events-card.js
       type: module
   ```
4. Add the card to your dashboard

## Usage

```yaml
type: custom:frigate-events-card
frigate_client_id: frigate
event_count: 5

# Optional filters
cameras:
  - wyze_camera
labels:
  - person
  - car
zones:
  - front_a
  - front_b

# Optional: Video playback settings
video: true
video_on_hover: true

# Optional: Video timing offsets (seconds or per-label/zone map)
video_start_skip_seconds: 1
video_end_skip_seconds: 2

# Optional: Tracking synchronization (milliseconds or per-label/zone map)
tracking_pan_delay:
  car: -1500
  person: -3000
  person:front_door: 500
  default: 0

# Optional: Tracking smoothness (0.0 to 1.0)
tracking_smoothing: 0.5

# Optional: Layout overrides
reverse: true
offset: 1

# Optional: Reset display daily at a specific time (24hr format)
daily_clear_time: "04:00"

# Optional: Debugging
debug: true
```

### Example: Scrollable Timeline

This example creates a horizontally scrollable gallery showing 6 thumbnails at a time, loading up to 40 total events.

```yaml
type: custom:frigate-events-card
frigate_client_id: frigate
event_count: 6
scroll: true
scroll_limit: 40
video_on_hover: true
```

### Example: Advanced Tracking Configuration

This example shows a real-world configuration for fine-tuning video clip endpoints and tracking synchronization based on detection labels.

```yaml
type: custom:frigate-events-card
video_end_skip_seconds:
  car: 3
  person: 6
  default: 2
tracking_pan_delay:
  car: -1500
  person: -3000
  default: 0
video: true
video_on_hover: true
```


## Configuration Options

### Basic Settings

The most common settings to get you started:

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `frigate_client_id` | string | `frigate` | Your Frigate instance ID |
| `title` | string | `Frigate Events` | Card title |
| `event_count` | number | `5` | Number of events to display. When `scroll` is enabled, this is the number of events visible at once in the viewport. |
| `cameras` | list | all | Filter to specific cameras |
| `labels` | list | all | Filter to specific labels (person, car, etc.) |
| `zones` | list | all | Filter to specific Frigate zones |
| `video` | boolean | `false` | Whether to play video clips instead of snapshots in the gallery and modal. |
| `video_on_hover` | boolean | `true` | Play video clips automatically when hovering over an event snapshot in the gallery. |
| `scroll` | boolean | `false` | Enable horizontal scrolling gallery. When enabled, `event_count` sets the visible thumbnail count at once. |

<details>
<summary><strong>Advanced Settings</strong> (Click to expand)</summary>

### Advanced Video & Tracking Settings
| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `video_start_skip_seconds` | number \| map | `0` | Number of seconds to skip from the beginning of video clips. Supports per-label/zone map. |
| `video_end_skip_seconds` | number \| map | `0` | Number of seconds to skip from the end of video clips. Supports per-label/zone map. |
| `tracking_pan_delay` | number \| map | `0` | Millisecond delay to synchronize video pan with object movement. Supports per-label/zone map (e.g., `person:front_door`). |
| `tracking_smoothing` | number | `1.0` | Smoothness of camera panning in hover previews (0.0 to 1.0). 1.0 uses a wide time window for a soft glide, 0.0 is an instant rigid snap. |

### Advanced Layout & Timeline Settings
| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `show_scroll_arrows` | boolean | `false` | Show previous/next navigation arrows over the scrollable gallery. Only applies when `scroll` is enabled. |
| `scroll_limit` | number | `20` | Total number of events to load in the scrollable timeline. |
| `reverse` | boolean | `false` | Reverses the rendering order of the timeline (events populate right-to-left instead of left-to-right). |
| `offset` | number | `0` | Number of recent events to skip/hide from the start of the list. Useful for excluding the newest event if it's already shown in another card. |
| `daily_clear_time` | string | none | Optional. Time to reset the display daily (24hr format, e.g., "04:00"). If set, events before this time are hidden and shown as grey placeholders. |

### Advanced Detail Modal & Debug Settings
| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `show_date` | boolean | `false` | Show the date in the event details modal popup. |
| `show_accuracy` | boolean | `false` | Show the detection accuracy score percentage in the details modal popup (placed below the camera name). |
| `show_duration` | boolean | `true` | Show the event duration (e.g., `9s` or `Ongoing`) in the details modal popup. |
| `debug` | boolean | `false` | Enable debug mode to display the current card version number above snapshots. |

</details>


## Requirements

- Home Assistant with [Frigate Integration](https://github.com/blakeblackshear/frigate-hass-integration) installed
- Frigate NVR with cameras configured

## Contributing

Contributions are welcome! Please submit all Pull Requests to the **develop** branch.

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/awesome-feature`)
3. Commit your changes and push to your fork
4. Open a Pull Request to **develop**

## Support & Feedback

If you encounter any issues, bugs, or have feature requests, please [open an issue on GitHub](https://github.com/saihgupr/frigate-events-card/issues).

Frigate Events Card is open-source and free. If you find it useful, consider giving it a star ⭐ or making a donation to support development!

[![ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/saihgupr)
