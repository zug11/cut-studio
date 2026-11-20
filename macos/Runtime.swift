import AppKit
import Darwin
import Foundation

struct InstalledTools {
  let node: URL
  let searchPath: String

  static func detect() throws -> InstalledTools {
    let environment = ProcessInfo.processInfo.environment
    let home = FileManager.default.homeDirectoryForCurrentUser.path
    var folders = ["/opt/homebrew/bin", "/usr/local/bin", "\(home)/.volta/bin"]
    folders += (environment["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin").split(separator: ":").map(
      String.init)
    let nvm = URL(fileURLWithPath: "\(home)/.nvm/versions/node", isDirectory: true)
    if let versions = try? FileManager.default.contentsOfDirectory(
      at: nvm, includingPropertiesForKeys: nil)
    {
      folders += versions.sorted {
        $0.lastPathComponent.compare($1.lastPathComponent, options: .numeric) == .orderedDescending
      }.map { $0.appendingPathComponent("bin").path }
    }
    var seen = Set<String>()
    folders = folders.filter { !$0.isEmpty && seen.insert($0).inserted }
    func executable(_ name: String) -> URL? {
      folders.map { URL(fileURLWithPath: $0).appendingPathComponent(name) }.first {
        FileManager.default.isExecutableFile(atPath: $0.path)
      }
    }
    guard let node = executable("node") else {
      throw RuntimeFailure(
        "Node.js 22 or later is required. Install Node.js from nodejs.org, then reopen CUT Studio.\n\nIf you use Homebrew: brew install node ffmpeg"
      )
    }
    let version = Process()
    version.executableURL = node
    version.arguments = ["-p", "process.versions.node"]
    let output = Pipe()
    version.standardOutput = output
    version.standardError = Pipe()
    try version.run()
    version.waitUntilExit()
    let string =
      String(data: output.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
    guard version.terminationStatus == 0,
      let major = Int(
        string.trimmingCharacters(in: .whitespacesAndNewlines).split(separator: ".").first ?? ""),
      major >= 22
    else {
      throw RuntimeFailure(
        "CUT Studio requires Node.js 22 or later. The installed Node.js version is \(string.trimmingCharacters(in: .whitespacesAndNewlines)). Update Node.js and reopen the app."
      )
    }
    guard executable("ffmpeg") != nil, executable("ffprobe") != nil else {
      throw RuntimeFailure(
        "FFmpeg and FFprobe are required to preview and render your films. Install a full FFmpeg build from ffmpeg.org, then reopen CUT Studio.\n\nIf you use Homebrew: brew install ffmpeg\n\nAll video and audio processing stays on this Mac."
      )
    }
    return InstalledTools(node: node, searchPath: folders.joined(separator: ":"))
  }
}

struct RuntimeFailure: LocalizedError {
  let message: String
  init(_ message: String) { self.message = message }
  var errorDescription: String? { message }
}

@MainActor
final class LocalEngine {
  private var process: Process?
  private var outputPipe: Pipe?
  private var errorPipe: Pipe?
  private var output = ""
  private var errors = ""
  private var generation = 0
  private var timeout: DispatchWorkItem?
  private(set) var origin: URL?
  var onReady: ((URL) -> Void)?
  var onFailure: ((String) -> Void)?

  func start(project: URL, resources: URL, tools: InstalledTools) throws {
    generation += 1
    let ownGeneration = generation
    output = ""
    errors = ""
    origin = nil
    let child = Process()
    child.executableURL = tools.node
    child.arguments = [
      resources.appendingPathComponent("runtime/native-host.cjs").path, project.path,
    ]
    child.currentDirectoryURL = project
    var environment = ProcessInfo.processInfo.environment
    environment["PATH"] = tools.searchPath
    environment["CUT_NATIVE_APP"] = "1"
    environment["CUT_PARENT_PID"] = String(ProcessInfo.processInfo.processIdentifier)
    child.environment = environment
    let stdout = Pipe()
    let stderr = Pipe()
    child.standardOutput = stdout
    child.standardError = stderr
    outputPipe = stdout
    errorPipe = stderr
    process = child
    stdout.fileHandleForReading.readabilityHandler = { [weak self] handle in
      let data = handle.availableData
      if data.isEmpty {
        handle.readabilityHandler = nil
        return
      }
      guard !data.isEmpty, let text = String(data: data, encoding: .utf8) else { return }
      DispatchQueue.main.async { self?.received(text, error: false, generation: ownGeneration) }
    }
    stderr.fileHandleForReading.readabilityHandler = { [weak self] handle in
      let data = handle.availableData
      if data.isEmpty {
        handle.readabilityHandler = nil
        return
      }
      guard !data.isEmpty, let text = String(data: data, encoding: .utf8) else { return }
      DispatchQueue.main.async { self?.received(text, error: true, generation: ownGeneration) }
    }
    child.terminationHandler = { [weak self] task in
      DispatchQueue.main.async {
        guard let self, self.generation == ownGeneration, self.process === task else { return }
        self.timeout?.cancel()
        self.process = nil
        self.onFailure?(
          "The local editing engine stopped (code \(task.terminationStatus)).\n\n\(self.errors.suffix(3000))"
        )
      }
    }
    try child.run()
    let deadline = DispatchWorkItem { [weak self] in
      guard let self, self.generation == ownGeneration, self.origin == nil else { return }
      self.stop {}
      self.onFailure?("The local editing engine did not start.\n\n\(self.errors.suffix(3000))")
    }
    timeout = deadline
    DispatchQueue.main.asyncAfter(deadline: .now() + 25, execute: deadline)
  }

  private func received(_ text: String, error: Bool, generation ownGeneration: Int) {
    guard generation == ownGeneration else { return }
    if error {
      errors = String((errors + text).suffix(16000))
      return
    }
    output = String((output + text).suffix(16000))
    guard origin == nil,
      let range = output.range(of: #"http://127\.0\.0\.1:[0-9]+"#, options: .regularExpression),
      let url = URL(string: String(output[range]))
    else { return }
    origin = url
    timeout?.cancel()
    onReady?(url)
  }

  func stop(completion: @escaping () -> Void) {
    generation += 1
    timeout?.cancel()
    timeout = nil
    origin = nil
    let child = process
    process = nil
    outputPipe?.fileHandleForReading.readabilityHandler = nil
    errorPipe?.fileHandleForReading.readabilityHandler = nil
    outputPipe = nil
    errorPipe = nil
    guard let child, child.isRunning else {
      completion()
      return
    }
    child.terminationHandler = nil
    child.terminate()
    DispatchQueue.global(qos: .userInitiated).async {
      let deadline = Date().addingTimeInterval(5)
      while child.isRunning && Date() < deadline { Thread.sleep(forTimeInterval: 0.05) }
      if child.isRunning { kill(child.processIdentifier, SIGKILL) }
      child.waitUntilExit()
      DispatchQueue.main.async { completion() }
    }
  }
}
