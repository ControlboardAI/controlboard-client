# ControlBoard menubar app

Native macOS menubar app for [ControlBoard](https://controlboard.ai). Swift + AppKit via SwiftPM — no Xcode project, no third-party dependencies.

The status item title shows live board status (`CB ▸<running> ●<queued>`, or `CB —` when unreachable), refreshed every 30s. The menu lists running tasks, the up-next queue, inbox proposals awaiting approval, per-agent usage, and the installed `cb` client version with a one-click native updater.

## Auth

Reads the API key from `~/.config/controlboard/config.json` (default agent's key, then legacy top-level `key`, then the `CONTROLBOARD_API_KEY` env var). `CONTROLBOARD_URL` overrides the base URL.

## Build

```sh
swift build -c release          # plain binary at .build/release/CBMenubar
bash build-app.sh               # dist/ControlBoard.app (ad-hoc signed, LSUIElement)
```

## Run

```sh
open dist/ControlBoard.app      # menubar app (no Dock icon)
.build/release/CBMenubar --print   # headless one-shot dump of what the menu would show
```
