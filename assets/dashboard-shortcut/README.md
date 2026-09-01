## Optional Dashboard shortcut icon

`radar.png` is the dark radar artwork with genuine alpha outside
the rounded tile. `AppIcon.icns` contains 16–1024 pixel renditions, generated with
macOS system tools. End users use the bundled icon; no image generator, compiler,
Swift, Xcode, or third-party Dock utility is required.

Developer-only regeneration:

```bash
bash assets/dashboard-shortcut/generate-icon.sh
```

The shortcut manager applies the icon to the managed `.webloc` using AppKit.
The icon is embedded as a custom file icon, so clicks do not depend on an asset
inside an old Pilot version. Ordinary install/upgrade does not install a shortcut.

### Artwork provenance

Created with the built-in image generation tool. The production pass extracted
the icon from the preview backdrop without changing its design.
