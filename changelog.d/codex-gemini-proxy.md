### Added

- Add a local Gemini proxy setting for all of its accounts, model discovery and provider calls. Internal loopback connections stay direct. Other providers and system proxy settings stay unchanged.

### Fixed

- Apply changed Gemini proxy settings to new and resumed account processes without resetting conversations, account credentials or quota state. Unreadable proxy preferences block Gemini rather than silently connecting directly.
