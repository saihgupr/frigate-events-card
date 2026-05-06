# Changelog

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
