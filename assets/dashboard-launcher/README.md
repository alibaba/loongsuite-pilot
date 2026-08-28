# macOS Dashboard launcher

The open-source installer uses `scripts/manage-dashboard-app.mjs` to generate
`~/Applications/LoongSuite Pilot Dashboard.app` locally using macOS system tools.
It stores installation paths, not a port or credentials. Every click runs
`loongsuite-pilot dashboard open` against that installation. The CLI resolves
the current runtime and reads `dashboard.port` using the collector's rules.

The app has no embedded browser, collector, background process, or auto-start
action. Its Retry button repeats the read/probe/open operation. An unavailable
Dashboard does not imply the collector is stopped. Another service (or another
Pilot data directory) on the configured port is never opened automatically.

`AppIcon.icns` is generated from the included vector drawing; Swift is only a
developer dependency for regenerating it, never an installation dependency:

```bash
icon_work=$(mktemp -d)
swift assets/dashboard-launcher/generate-icon.swift "$icon_work/AppIcon.iconset"
iconutil -c icns "$icon_work/AppIcon.iconset" -o assets/dashboard-launcher/AppIcon.icns
```

Keep osacompile's applet metadata when changing the builder. In particular,
`LSRequiresCarbon` and `CFBundleAllowMixedLocalizations` are required by the
system applet stub on tested macOS versions. Finish resource edits before
ad-hoc signing and verify the signature after a real launch.

This is a locally generated shortcut, not a notarized standalone download.
Do not publish a generated, per-user app as a portable GitHub Release asset:
it references that user's Pilot installation. Distributing a standalone app
would require a separate packaging, signing, and notarization workflow.

Developer verification (the second command opens two local test pages):

```bash
npm run build
PILOT_DASHBOARD_NATIVE_E2E=1 npx vitest run tests/integration/dashboard-launcher-macos.test.mjs
```
