# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
