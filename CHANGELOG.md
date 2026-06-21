# Changelog
 
## [2.1.53] - 2026-06-21
- Changed: Enabled video clip playback by default (`video: true`).

## [2.1.52] - 2026-06-21
- Changed: Enabled show_duration by default to `false` in details modal config.

## [2.1.51] - 2026-06-21
- Changed: Enabled horizontal gallery scroll mode by default (`scroll: true`).

## [2.1.50] - 2026-06-21
- Improved: Adjusted details modal font size for both object label and event time to match at `20px` (using the time element as the guide).

## [2.1.49] - 2026-06-21
- Improved: Adjusted event time font size to `24px` in the details modal, matching the object label's font size on the left.

## [2.1.48] - 2026-06-21
- Added: `show_camera_name` (default: `true`) and `show_zones` (default: `true`) configuration options to allow optionally hiding the camera name and physical zones (locations) in the details modal.

## [2.1.47] - 2026-06-21
- Improved: Matched line spacing of the left column (label, camera, and accuracy) in the details modal with the right column (time, zones, and duration) by removing margin-bottom and applying a uniform line-height of 1.2 across all metadata elements.

## [2.1.46] - 2026-06-21
- Added: `show_description` config option (default: `true`) to optionally toggle visibility of GenAI event descriptions in the details modal.
- Improved: Reorganized the Configuration Options in the README into clean Basic and collapsible Advanced settings to make the list less daunting for new users.

## [2.1.44] - 2026-06-21
- Changed: Moved the optional accuracy score (e.g. `96%`) to render on Line 3 in the left column (directly under `Wyze Camera`) instead of the right column.

## [2.1.43] - 2026-06-21
- Changed: Moved the AI-generated description to the center area of the bottom metadata bar (between left and right metadata blocks).
- Improved: Center-aligned the description text and styled it to automatically wrap to multiple lines for a highly integrated look.

## [2.1.42] - 2026-06-21
- Improved: Increased font sizes of the object label (`24px`) and event time (`20px`) inside details modal for better visual prominence.
- Added: `show_accuracy` option (default `false`) to toggle rendering of accuracy score; when enabled, score is shown on the right side below the duration line.
- Added: `show_duration` option (default `true`) to toggle rendering of event duration (e.g. `9s` or `Ongoing`) on the right side.

## [2.1.41] - 2026-06-21
- Changed: Moved the detection accuracy percentage to the camera line (e.g. `Wyze Camera · 96%`) for a cleaner top-level header.
- Improved: Positioned the duration (e.g. `9s`) to be displayed clearly below the locations line.

## [2.1.40] - 2026-06-21
- Changed: Completely redesigned the details modal metadata section with a clean, text-only minimal layout.
- Removed: Emojis, borders, and background chip elements to prevent an over-designed "AI look".
- Improved: Unified layout into two baseline-aligned rows, utilizing middle dot (`·`) dividers for secondary inline metadata (e.g. `9s · Front A, Front B`).

## [2.1.39] - 2026-06-21
- Improved: Redesigned the event details modal metadata panel layout using a clean, modern grid.
- Added: Rounded chip badges with modern border borders/backgrounds for Time, Date, and Duration metrics.
- Added: Integrated category icons (📹 for Camera, 📍 for Zones) to enhance readability and visual alignment.

## [2.1.38] - 2026-06-21
- Added: `show_date` option (default `false`) to toggle date visibility in details modal.
- Fixed: Extracted detection score from `data.top_score` and `data.score` objects to resolve missing accuracy percentages in modern Frigate versions.
- Improved: Enforced hour formatting without leading zeroes (e.g. `5:35:54 PM`) and capitalized AM/PM string in event details modal.

## [2.1.37] - 2026-06-21
- Added: Display event date, detection score badge, and AI-generated description (if available) inside the event details modal popup.

## [2.1.34] - 2026-06-09
- Fixed: Completely hid the scrollbar in scrollable gallery mode for all modern browsers.

## [2.1.33] - 2026-06-09
- Fixed: Resolved an issue in scroll mode where placeholder tiles (black boxes) would fill the entire scroll limit at the end of the scrollable list when using `daily_clear_time`.

## [2.1.32] - 2026-06-09
- Added: `show_scroll_arrows` config option (default: `false`) to control the visibility of navigation arrows in scroll mode.

## [2.1.31] - 2026-06-05
- Added: Horizontal scrolling gallery mode via new `scroll` and `scroll_limit` config options. When enabled, `event_count` controls the number of visible thumbnails and hover-triggered navigation arrows appear on desktop.
- Fixed: Scrollbar is now hidden on all browsers (WebKit and Firefox) in scroll mode for a clean, native-feeling gallery.
- Fixed: Placeholder tile count no longer overflows the visible viewport in scroll mode, preventing excessive blank/black tiles at the end of the timeline.
- Improved: Compatibility with Home Assistant's Sections view — the card now uses proper grid layout options and spans full width correctly.


## [2.1.26] - 2026-05-06
- Changed: `video_on_hover` is now enabled (`true`) by default.
- Documentation: Removed non-functional options `show_camera`, `show_label`, and `show_timestamp` from the README.

## [2.1.25] - 2026-05-06
- Added: Example configuration section in README for advanced tracking settings.

## [2.1.24] - 2026-05-06
- Changed: Renamed `video_skip_seconds` configuration to `video_start_skip_seconds` for clarity.

## [2.1.23] - 2026-05-06
- Changed: `tracking_smoothing` default value is now `1.0` (smoothest).

## [2.1.22] - 2026-05-06
- Refactored: Re-implemented `tracking_smoothing` with a true moving-average time window over raw Frigate keyframes to provide a stable, soft glide motion instead of a single-frame exponential moving average.

## [2.1.21] - 2026-05-06
- Changed: Mapped `tracking_smoothing` config value from an exponential scale to a 0.0 - 1.0 range, where 1.0 is smoothest and 0.0 is rigid.

## [2.1.20] - 2026-05-06
- Documentation: Updated README with latest configuration options including `tracking_pan_delay` and `tracking_smoothing`.
- Changed: `tracking_pan_delay` now uses milliseconds for finer control.

## [2.1.19] - 2026-05-05
- Fixed: Corrected tracking synchronization logic by accounting for `video_start_padding` and `video_start_skip_seconds`. Tracking data now aligns perfectly with video playback time.
- Fixed: Resolved an issue where hierarchical configuration values (e.g., `car`, `person:front_driveway`) were not being correctly applied to video skip settings.
- Added: Re-implemented `_getConfigValueForEvent` to provide robust, hierarchical configuration lookups across all event-specific settings.
- Debug: Fixed debug overlay timestamps to accurately show relative tracking offsets.

## [2.1.17] - 2026-05-05
- Renamed `video_position_offset_x` back to `tracking_pan_delay` to correctly reflect its purpose as a temporal delay for tracking synchronization.
- Removed unused spatial offset terminology in favor of temporal delay.

## [2.1.16] - 2026-05-05
- Enhanced tracking synchronization with reciprocal key support (e.g., `zone:label` as well as `label:zone`).
- Added `tracking_smoothing` configuration to fine-tune camera responsiveness.
- Improved debug overlay with real-time playback synchronization data.
- Increased default tracking smoothing for better responsiveness.

## [2.1.14] - 2026-05-05
- Replaced `tracking_pan_delays` with more flexible `video_position_offset_x` configuration.
- Supported hierarchical offsets: `label:zone`, `label`, `zone`, and `default`.
- Optimized "Lazy Tracking" comfort zone to 20% to further reduce jitter.

## [2.1.13] - 2026-05-05

### Added
- Feature: Added `tracking_pan_delays` configuration option. Allows specifying a delay in seconds before auto-tracking pans start for specific object types or zones (e.g. `front_driveway:car: 2`). This helps sync the pan with the video when Frigate's detection data is ahead of the video stream.
- Feature: Implemented "lazy tracking" for hover video crops. The view now stays static as long as the tracked object remains within a 20% comfort zone, reducing unnecessary camera movement and jitter.

## [2.0.2] - 2026-04-28

### Added
- Feature: Added `debug` configuration option to display the card version number above snapshots for troubleshooting.

## [2.0.1] - 2026-04-28

### Fixed
- Fixed: Chrome compatibility for hover animations by prioritizing MP4 sources and ensuring explicit muted properties.
- Fixed: Hover flicker issue in some browsers by adding `pointer-events: none` to the overlay video.
- Fixed: Special characters and spaces in camera names/ids are now correctly handled via URL encoding.
- Feature: Officially added `video_on_hover` to the configuration schema.

## [2.0.0] - 2026-04-27

### Added
- Feature: Made hover video playback its own separate configuration option (`video_on_hover: true`), allowing users to play videos on rollover independently of the main `video` setting.
- Feature: Added `reverse` option to configuration to render events right-to-left.
- Feature: Added `offset` option to configuration to skip the latest `<number>` events.
- Feature: Added proper support for viewing video clips from events natively within the browser, falling back between HLS streams (`.m3u8`) and direct MP4 clips depending on browser compatibility (e.g. Safari vs Chrome).

### Fixed
- Fixed Safari failing to play Frigate video clips due to strict byte-range request requirements by implementing an HLS (`master.m3u8`) fallback stream directly from the Frigate Integration.

### Removed
- Removed the debug version tag overlay from the top right corner of the card.
