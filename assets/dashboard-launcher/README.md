## Optional Dashboard shortcut icon

`radar-d4.png` is the approved D4 dark radar artwork with genuine alpha outside
the rounded tile. `AppIcon.icns` contains 16–1024 pixel renditions, generated with
macOS system tools. End users use the bundled icon; no image generator, compiler,
Swift, Xcode, or third-party Dock utility is required.

Developer-only regeneration:

```bash
bash assets/dashboard-launcher/generate-icon.sh
```

The shortcut manager applies the icon to the managed `.webloc` using AppKit.
The icon is embedded as a custom file icon, so clicks do not depend on an asset
inside an old Pilot version. Ordinary install/upgrade does not install a shortcut.

### Artwork provenance

Created with the built-in image generation tool from the user-approved D4
preview. The production pass only extracted the icon from the preview backdrop.
Final production prompt:

```text
Use case: background-extraction
Asset type: production macOS Dock shortcut icon, transparent PNG, 1024x1024 square.
Input images: Image 1 is the approved D4 icon and is the EDIT TARGET, not a loose style reference.
Primary request: Remove ONLY the pale light-grey backdrop OUTSIDE the dark rounded-square tile, giving genuinely transparent alpha outside the tile. This is a production cutout of the exact approved artwork, NOT a redesign.
Keep unchanged: the charcoal/navy rounded square; the inset beveled radar disk; the cyan/mint circular outline, two inner range rings, crosshair, three target blips, center hub, upper-right diagonal sweep beam and subtle fading sector; the existing shading, materials, color palette and composition.
Frame: centered complete tile with approximately 5 percent transparent margin on each edge, including at rounded corners. Straight-on view, same proportions.
Constraints: actual alpha transparency, no flat colored backdrop, no checkerboard pixels, no text, no labels, no new markings or border. Preserve the approved D4 design. Only extract the existing icon.
```
