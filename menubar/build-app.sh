#!/usr/bin/env bash
# Build the ControlBoard menubar app bundle into dist/ControlBoard.app
set -euo pipefail
cd "$(dirname "$0")"

swift build -c release

APP="dist/ControlBoard.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"

cp .build/release/CBMenubar "$APP/Contents/MacOS/CBMenubar"

cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleIdentifier</key>
	<string>ai.controlboard.menubar</string>
	<key>CFBundleName</key>
	<string>ControlBoard</string>
	<key>CFBundleExecutable</key>
	<string>CBMenubar</string>
	<key>CFBundlePackageType</key>
	<string>APPL</string>
	<key>CFBundleInfoDictionaryVersion</key>
	<string>6.0</string>
	<key>CFBundleShortVersionString</key>
	<string>1.1.0</string>
	<key>CFBundleVersion</key>
	<string>1.1.0</string>
	<key>LSMinimumSystemVersion</key>
	<string>13.0</string>
	<key>LSUIElement</key>
	<true/>
	<key>NSPrincipalClass</key>
	<string>NSApplication</string>
	<key>NSHighResolutionCapable</key>
	<true/>
</dict>
</plist>
PLIST

codesign --force -s - "$APP"
codesign --verify --strict "$APP"
echo "Built and signed: $APP"
