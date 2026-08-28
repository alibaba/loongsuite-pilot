import AppKit

// Developer-only vector artwork generator. The installer copies AppIcon.icns;
// end users do not need Swift or Xcode.
guard CommandLine.arguments.count == 2 else {
    fatalError("Usage: swift generate-icon.swift /path/to/AppIcon.iconset")
}
let output = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)

func roundedRect(_ rect: NSRect, radius: CGFloat) -> NSBezierPath {
    NSBezierPath(roundedRect: rect, xRadius: radius, yRadius: radius)
}

for points in [16, 32, 128, 256, 512] {
    for scale in [1, 2] {
        let pixels = points * scale
        let bitmap = NSBitmapImageRep(
            bitmapDataPlanes: nil, pixelsWide: pixels, pixelsHigh: pixels,
            bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true,
            isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0
        )!
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
        NSGraphicsContext.current!.cgContext.scaleBy(x: CGFloat(pixels) / 1024, y: CGFloat(pixels) / 1024)
        let background = roundedRect(NSRect(x: 64, y: 64, width: 896, height: 896), radius: 200)
        NSGradient(
            starting: NSColor(srgbRed: 0.06, green: 0.17, blue: 0.40, alpha: 1),
            ending: NSColor(srgbRed: 0.08, green: 0.48, blue: 0.89, alpha: 1)
        )!.draw(in: background, angle: 65)

        let window = roundedRect(NSRect(x: 226, y: 270, width: 572, height: 486), radius: 54)
        NSColor.white.setStroke()
        window.lineWidth = 32
        window.stroke()
        let divider = NSBezierPath()
        divider.move(to: NSPoint(x: 236, y: 642))
        divider.line(to: NSPoint(x: 788, y: 642))
        divider.lineWidth = 24
        divider.stroke()
        NSColor.white.withAlphaComponent(0.90).setFill()
        for x in [286, 330, 374] {
            NSBezierPath(ovalIn: NSRect(x: x, y: 688, width: 18, height: 18)).fill()
        }

        let graph = NSBezierPath()
        graph.move(to: NSPoint(x: 317, y: 374))
        graph.line(to: NSPoint(x: 438, y: 482))
        graph.line(to: NSPoint(x: 538, y: 418))
        graph.line(to: NSPoint(x: 697, y: 557))
        graph.lineWidth = 39
        graph.lineCapStyle = .round
        graph.lineJoinStyle = .round
        NSColor(srgbRed: 0.43, green: 0.94, blue: 0.87, alpha: 1).setStroke()
        graph.stroke()
        let arrow = NSBezierPath()
        arrow.move(to: NSPoint(x: 602, y: 557))
        arrow.line(to: NSPoint(x: 697, y: 557))
        arrow.line(to: NSPoint(x: 697, y: 462))
        arrow.lineWidth = 39
        arrow.lineCapStyle = .round
        arrow.lineJoinStyle = .round
        arrow.stroke()
        NSGraphicsContext.restoreGraphicsState()
        let suffix = scale == 2 ? "@2x" : ""
        let file = output.appendingPathComponent("icon_\(points)x\(points)\(suffix).png")
        try bitmap.representation(using: .png, properties: [:])!.write(to: file)
    }
}
