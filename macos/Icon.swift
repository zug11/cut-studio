import AppKit

let destination = CommandLine.arguments[1]
try FileManager.default.createDirectory(atPath: destination, withIntermediateDirectories: true)
func drawIcon(_ size: Int, filename: String) throws {
  let image = NSBitmapImageRep(
    bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size, bitsPerSample: 8, samplesPerPixel: 4,
    hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
  NSGraphicsContext.saveGraphicsState()
  NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: image)
  let scale = CGFloat(size) / 1024
  let transform = NSAffineTransform()
  transform.scale(by: scale)
  transform.concat()
  let tile = NSBezierPath(
    roundedRect: NSRect(x: 38, y: 38, width: 948, height: 948), xRadius: 210, yRadius: 210)
  NSGradient(
    starting: NSColor(calibratedRed: 0.14, green: 0.18, blue: 0.20, alpha: 1),
    ending: NSColor(calibratedRed: 0.06, green: 0.08, blue: 0.10, alpha: 1))!.draw(
      in: tile, angle: -70)
  NSColor(calibratedWhite: 1, alpha: 0.09).setStroke()
  tile.lineWidth = 2
  tile.stroke()
  let green = NSColor(calibratedRed: 0.66, green: 0.84, blue: 0.72, alpha: 1)
  let warm = NSColor(calibratedRed: 0.81, green: 0.68, blue: 0.48, alpha: 1)
  for (index, y) in [625.0, 463.0, 301.0].enumerated() {
    let left = NSBezierPath(
      roundedRect: NSRect(x: 208, y: y, width: 220, height: 100), xRadius: 21, yRadius: 21)
    (index == 2 ? warm.withAlphaComponent(0.74) : green.withAlphaComponent(index == 0 ? 0.9 : 0.58))
      .setFill()
    left.fill()
    let right = NSBezierPath(
      roundedRect: NSRect(x: 590, y: y, width: 226, height: 100), xRadius: 21, yRadius: 21)
    (index == 2 ? warm.withAlphaComponent(0.36) : green.withAlphaComponent(index == 0 ? 0.43 : 0.8))
      .setFill()
    right.fill()
  }
  let slash = NSBezierPath()
  slash.move(to: NSPoint(x: 563, y: 818))
  slash.line(to: NSPoint(x: 665, y: 818))
  slash.line(to: NSPoint(x: 455, y: 211))
  slash.line(to: NSPoint(x: 353, y: 211))
  slash.close()
  NSColor(calibratedRed: 0.88, green: 0.94, blue: 0.87, alpha: 1).setFill()
  slash.fill()
  NSGraphicsContext.restoreGraphicsState()
  try image.representation(using: .png, properties: [:])!.write(
    to: URL(fileURLWithPath: destination).appendingPathComponent(filename))
}
for size in [16, 32, 128, 256, 512] {
  try drawIcon(size, filename: "icon_\(size)x\(size).png")
  try drawIcon(size * 2, filename: "icon_\(size)x\(size)@2x.png")
}
