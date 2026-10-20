// Messages uses legacy typedstream archives for attributedBody on modern macOS.
// Run in a separate process so malformed archives cannot crash the bridge.
import Foundation
import AppKit

let input = FileHandle.standardInput.readDataToEndOfFile()
guard input.count <= 2 * 1024 * 1024,
      let data = Data(base64Encoded: input) else { exit(1) }
do {
    guard let value = NSUnarchiver.unarchiveObject(with: data) as? NSAttributedString else { exit(1) }
    let output = try JSONSerialization.data(withJSONObject: ["text": value.string])
    FileHandle.standardOutput.write(output)
} catch { exit(1) }
