import AppKit
import Darwin
import Foundation

struct AssistantConnectionSettings {
  let projectPath: String
  let launcherPath: String
  var arguments: [String] { ["--project", projectPath] }

  private func quote(_ value: String) -> String {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.withoutEscapingSlashes]
    return String(data: try! encoder.encode(value), encoding: .utf8)!
  }

  var codexTOML: String {
    """
    [mcp_servers.cut_studio]
    command = \(quote(launcherPath))
    args = [\(arguments.map(quote).joined(separator: ", "))]
    """ + "\n"
  }

  var standardJSON: String {
    let value: [String: Any] = [
      "mcpServers": [
        "cut_studio": ["command": launcherPath, "args": arguments] as [String: Any]
      ]
    ]
    let data = try! JSONSerialization.data(
      withJSONObject: value, options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes])
    return String(data: data, encoding: .utf8)! + "\n"
  }
}

enum CodexConnectionResult: Equatable {
  case added
  case alreadyConfigured(enabled: Bool)
  case differentExisting
  case failed(String)
}

struct CodexMCPConnector {
  static func findExecutable(environment: [String: String] = ProcessInfo.processInfo.environment)
    -> URL?
  {
    let home = FileManager.default.homeDirectoryForCurrentUser.path
    let folders =
      (environment["PATH"] ?? "").split(separator: ":").map(String.init)
      + ["/opt/homebrew/bin", "/usr/local/bin", "\(home)/.local/bin", "\(home)/.npm-global/bin"]
    var candidates = folders.map { URL(fileURLWithPath: $0).appendingPathComponent("codex") }
    for applications in ["/Applications", "\(home)/Applications"] {
      for app in ["ChatGPT.app", "Codex.app"] {
        for relative in [
          "Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex",
          "Contents/Resources/codex", "Contents/MacOS/codex",
        ] {
          candidates.append(
            URL(fileURLWithPath: applications).appendingPathComponent(app)
              .appendingPathComponent(relative))
        }
      }
    }
    return candidates.first { FileManager.default.isExecutableFile(atPath: $0.path) }
  }

  static func add(
    settings: AssistantConnectionSettings, executable: URL,
    environment: [String: String] = ProcessInfo.processInfo.environment
  ) -> CodexConnectionResult {
    guard FileManager.default.isExecutableFile(atPath: settings.launcherPath) else {
      return .failed(
        "The bundled connection launcher is missing. Reinstall the complete CUT Studio app.")
    }
    let existing: CommandResult
    do {
      existing = try run(
        executable, ["mcp", "get", "cut_studio", "--json"], environment: environment)
    } catch {
      return .failed(
        "Codex could not read its MCP settings. Use Copy Configuration or check Codex’s settings.")
    }
    if existing.status == 0 {
      return inspect(existing.output, settings: settings)
    }
    // A parse error, permission error or other CLI failure must never be treated as absence.
    guard existing.status == 1,
      existing.error.trimmingCharacters(in: .whitespacesAndNewlines)
        == "Error: No MCP server named 'cut_studio' found."
    else {
      return .failed(
        "Codex could not confirm whether cut_studio already exists. Its settings were left unchanged. Use Copy Configuration or check Codex’s MCP settings."
      )
    }
    do {
      let result = try run(
        executable,
        ["mcp", "add", "cut_studio", "--", settings.launcherPath] + settings.arguments,
        environment: environment)
      guard result.status == 0 else {
        return .failed(
          "Codex could not add the connection. Use Copy Configuration or check Codex’s MCP settings."
        )
      }
      let confirmed = try run(
        executable, ["mcp", "get", "cut_studio", "--json"], environment: environment)
      guard confirmed.status == 0 else {
        return .failed(
          "Codex did not confirm the new connection. Check its MCP settings before trying again.")
      }
      if case .alreadyConfigured = inspect(confirmed.output, settings: settings) { return .added }
      return .failed(
        "Codex returned different connection settings. Review them in Codex’s MCP settings.")
    } catch {
      return .failed(
        "Codex could not finish adding the connection. Use Copy Configuration or check its MCP settings."
      )
    }
  }

  private static func inspect(_ output: String, settings: AssistantConnectionSettings)
    -> CodexConnectionResult
  {
    guard let data = output.data(using: .utf8),
      let entry = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      let transport = entry["transport"] as? [String: Any],
      let type = transport["type"] as? String
    else {
      return .failed(
        "Codex returned unreadable connection settings. Its configuration was left unchanged.")
    }
    guard type == "stdio", transport["command"] as? String == settings.launcherPath,
      transport["args"] as? [String] == settings.arguments
    else { return .differentExisting }
    return .alreadyConfigured(enabled: entry["enabled"] as? Bool ?? true)
  }

  private struct CommandResult {
    let status: Int32
    let output: String
    let error: String
  }

  private static func run(_ executable: URL, _ arguments: [String], environment: [String: String])
    throws -> CommandResult
  {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(
      "cut-codex-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(
      at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    defer { try? FileManager.default.removeItem(at: directory) }
    let output = directory.appendingPathComponent("stdout")
    let error = directory.appendingPathComponent("stderr")
    FileManager.default.createFile(
      atPath: output.path, contents: nil, attributes: [.posixPermissions: 0o600])
    FileManager.default.createFile(
      atPath: error.path, contents: nil, attributes: [.posixPermissions: 0o600])
    let stdout = try FileHandle(forWritingTo: output)
    let stderr = try FileHandle(forWritingTo: error)
    defer {
      try? stdout.close()
      try? stderr.close()
    }
    let process = Process()
    process.executableURL = executable
    process.arguments = arguments
    process.currentDirectoryURL = directory
    var configured = environment
    configured["PATH"] =
      "/opt/homebrew/bin:/usr/local/bin:" + (environment["PATH"] ?? "/usr/bin:/bin")
    process.environment = configured
    process.standardInput = FileHandle.nullDevice
    process.standardOutput = stdout
    process.standardError = stderr
    try process.run()
    let deadline = Date().addingTimeInterval(15)
    while process.isRunning && Date() < deadline { Thread.sleep(forTimeInterval: 0.03) }
    if process.isRunning {
      process.terminate()
      Thread.sleep(forTimeInterval: 0.15)
      if process.isRunning { kill(process.processIdentifier, SIGKILL) }
      process.waitUntilExit()
      throw RuntimeFailure("Codex did not respond in time.")
    }
    process.waitUntilExit()
    return CommandResult(
      status: process.terminationStatus,
      output: String(data: try Data(contentsOf: output).prefix(262144), encoding: .utf8) ?? "",
      error: String(data: try Data(contentsOf: error).prefix(16384), encoding: .utf8) ?? "")
  }
}

@MainActor
final class AssistantConnectionWindow: NSWindowController {
  private var settings: AssistantConnectionSettings
  private let projectLabel = NSTextField(wrappingLabelWithString: "")
  private let commandField = NSTextField(string: "")
  private let argumentField = NSTextField(string: "")
  private let codeView = NSTextView()
  private let status = NSTextField(labelWithString: "")
  private let instructions = NSTextField(wrappingLabelWithString: "")
  private let addToCodex = NSButton()
  private let codexExecutable = CodexMCPConnector.findExecutable()
  private let format = NSSegmentedControl(
    labels: ["Codex · TOML", "Other clients · JSON"], trackingMode: .selectOne,
    target: nil, action: nil)

  init(project: URL, launcher: URL) {
    settings = AssistantConnectionSettings(projectPath: project.path, launcherPath: launcher.path)
    let panel = NSPanel(
      contentRect: NSRect(x: 0, y: 0, width: 790, height: 690),
      styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
    panel.title = "Connect an AI Assistant"
    panel.minSize = NSSize(width: 700, height: 620)
    panel.isReleasedWhenClosed = false
    panel.appearance = NSAppearance(named: .darkAqua)
    super.init(window: panel)
    buildContent(panel)
    update(project: project, launcher: launcher)
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

  func present(relativeTo parent: NSWindow?) {
    guard let window else { return }
    if !window.isVisible {
      if let parent {
        window.setFrameOrigin(
          NSPoint(
            x: parent.frame.midX - window.frame.width / 2,
            y: parent.frame.midY - window.frame.height / 2))
      } else {
        window.center()
      }
    }
    showWindow(nil)
    window.makeKeyAndOrderFront(nil)
  }

  func update(project: URL, launcher: URL) {
    settings = AssistantConnectionSettings(projectPath: project.path, launcherPath: launcher.path)
    projectLabel.stringValue = project.path
    commandField.stringValue = launcher.path
    argumentField.stringValue = settings.arguments.joined(separator: "\n")
    status.stringValue = "Settings are ready to copy."
    drawConfiguration()
  }

  private func buildContent(_ panel: NSWindow) {
    let stack = NSStackView()
    stack.orientation = .vertical
    stack.alignment = .leading
    stack.spacing = 13
    stack.translatesAutoresizingMaskIntoConstraints = false
    panel.contentView!.addSubview(stack)
    NSLayoutConstraint.activate([
      stack.leadingAnchor.constraint(equalTo: panel.contentView!.leadingAnchor, constant: 24),
      stack.trailingAnchor.constraint(equalTo: panel.contentView!.trailingAnchor, constant: -24),
      stack.topAnchor.constraint(equalTo: panel.contentView!.topAnchor, constant: 22),
      stack.bottomAnchor.constraint(equalTo: panel.contentView!.bottomAnchor, constant: -20),
    ])
    func fullWidth(_ view: NSView) {
      stack.addArrangedSubview(view)
      view.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
    }
    let heading = NSTextField(labelWithString: "Connect CUT Studio to your assistant")
    heading.font = .systemFont(ofSize: 20, weight: .semibold)
    fullWidth(heading)
    let description = NSTextField(
      wrappingLabelWithString:
        "Add a local MCP connection so your assistant can work with the CUT films and media in this project."
    )
    description.textColor = .secondaryLabelColor
    description.font = .systemFont(ofSize: 12)
    fullWidth(description)
    let projectHeading = NSTextField(labelWithString: "PROJECT")
    projectHeading.font = .systemFont(ofSize: 10, weight: .semibold)
    projectHeading.textColor = .secondaryLabelColor
    fullWidth(projectHeading)
    projectLabel.font = .monospacedSystemFont(ofSize: 11, weight: .regular)
    projectLabel.isSelectable = true
    fullWidth(projectLabel)

    let fieldGrid = NSGridView()
    fieldGrid.rowSpacing = 8
    fieldGrid.columnSpacing = 12
    func fieldRow(_ title: String, field: NSTextField, selector: Selector, buttonTitle: String) {
      let label = NSTextField(labelWithString: title)
      label.textColor = .secondaryLabelColor
      label.font = .systemFont(ofSize: 11)
      field.isEditable = false
      field.isSelectable = true
      field.font = .monospacedSystemFont(ofSize: 11, weight: .regular)
      field.lineBreakMode = .byTruncatingMiddle
      field.usesSingleLineMode = false
      field.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
      let copy = NSButton(title: buttonTitle, target: self, action: selector)
      copy.bezelStyle = .rounded
      fieldGrid.addRow(with: [label, field, copy])
    }
    fieldRow("Command", field: commandField, selector: #selector(copyCommand), buttonTitle: "Copy")
    fieldRow(
      "Arguments", field: argumentField, selector: #selector(copyArguments), buttonTitle: "Copy")
    argumentField.heightAnchor.constraint(equalToConstant: 43).isActive = true
    fieldGrid.column(at: 0).width = 75
    fieldGrid.column(at: 2).width = 66
    fullWidth(fieldGrid)
    let manual = NSTextField(
      wrappingLabelWithString:
        "Manual setup: name cut_studio, transport STDIO. Add --project and the project path as two separate arguments."
    )
    manual.font = .systemFont(ofSize: 11)
    manual.textColor = .secondaryLabelColor
    fullWidth(manual)

    format.target = self
    format.action = #selector(changeFormat)
    format.selectedSegment = 0
    fullWidth(format)
    let scroll = NSScrollView()
    scroll.hasVerticalScroller = true
    scroll.hasHorizontalScroller = true
    scroll.borderType = .bezelBorder
    scroll.autohidesScrollers = true
    codeView.isEditable = false
    codeView.isSelectable = true
    codeView.isRichText = false
    codeView.font = .monospacedSystemFont(ofSize: 11.5, weight: .regular)
    codeView.textContainerInset = NSSize(width: 10, height: 12)
    codeView.backgroundColor = NSColor(calibratedWhite: 0.075, alpha: 1)
    codeView.textColor = .labelColor
    codeView.isHorizontallyResizable = true
    codeView.isVerticallyResizable = true
    codeView.autoresizingMask = [.width]
    codeView.textContainer?.widthTracksTextView = false
    codeView.textContainer?.containerSize = NSSize(
      width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
    scroll.documentView = codeView
    fullWidth(scroll)
    scroll.heightAnchor.constraint(greaterThanOrEqualToConstant: 155).isActive = true
    scroll.setContentHuggingPriority(.defaultLow, for: .vertical)
    instructions.font = .systemFont(ofSize: 11)
    instructions.textColor = .secondaryLabelColor
    fullWidth(instructions)

    let footer = NSStackView()
    footer.orientation = .horizontal
    footer.spacing = 10
    status.font = .systemFont(ofSize: 11)
    status.textColor = .secondaryLabelColor
    status.lineBreakMode = .byTruncatingTail
    status.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
    let spacer = NSView()
    spacer.setContentHuggingPriority(.defaultLow, for: .horizontal)
    let done = NSButton(title: "Done", target: self, action: #selector(done))
    done.bezelStyle = .rounded
    done.keyEquivalent = "\u{1b}"
    let copy = NSButton(
      title: "Copy Configuration", target: self, action: #selector(copyConfiguration))
    copy.bezelStyle = .rounded
    copy.keyEquivalent = "\r"
    addToCodex.title = "Add to Codex"
    addToCodex.target = self
    addToCodex.action = #selector(connectCodex)
    addToCodex.bezelStyle = .rounded
    addToCodex.isEnabled = codexExecutable != nil
    addToCodex.toolTip =
      codexExecutable == nil
      ? "Codex was not found on this Mac. Use the copyable settings instead."
      : "Add this project through Codex’s official local command-line client."
    for item in [status, spacer, done, addToCodex, copy] { footer.addArrangedSubview(item) }
    fullWidth(footer)
  }

  @objc private func changeFormat() { drawConfiguration() }
  @objc private func connectCodex() {
    guard let codexExecutable else { return }
    let requested = settings
    addToCodex.isEnabled = false
    status.stringValue = "Adding to Codex…"
    DispatchQueue.global(qos: .userInitiated).async { [weak self] in
      let result = CodexMCPConnector.add(settings: requested, executable: codexExecutable)
      DispatchQueue.main.async { [weak self] in
        guard let self else { return }
        self.addToCodex.isEnabled = true
        switch result {
        case .added:
          self.status.stringValue =
            self.settings.projectPath == requested.projectPath
            ? "Added. Restart the connection in Codex."
            : "The previous project was added to Codex."
        case .alreadyConfigured(let enabled):
          self.status.stringValue =
            enabled
            ? "Already configured in Codex."
            : "Already added. Enable it in Codex’s MCP settings."
        case .differentExisting:
          self.status.stringValue = "Existing Codex connection kept unchanged."
          let alert = NSAlert()
          alert.messageText = "Codex already has a different CUT Studio connection"
          alert.informativeText =
            "The cut_studio entry points to a different project or app. It was left unchanged. To keep both, copy these settings and use a different server name in Codex’s MCP settings."
          alert.addButton(withTitle: "OK")
          alert.runModal()
        case .failed(let message):
          self.status.stringValue = "Use Copy Configuration to connect manually."
          let alert = NSAlert()
          alert.messageText = "Could not add the Codex connection"
          alert.informativeText = message
          alert.addButton(withTitle: "OK")
          alert.runModal()
        }
      }
    }
  }
  @objc private func done() { close() }
  @objc private func copyCommand() { copy(settings.launcherPath, message: "Command copied.") }
  @objc private func copyArguments() {
    copy(settings.arguments.joined(separator: "\n"), message: "Two argument values copied.")
  }
  @objc private func copyConfiguration() {
    copy(
      format.selectedSegment == 0 ? settings.codexTOML : settings.standardJSON,
      message: format.selectedSegment == 0 ? "Codex configuration copied." : "MCP JSON copied.")
  }

  private func drawConfiguration() {
    codeView.string = format.selectedSegment == 0 ? settings.codexTOML : settings.standardJSON
    codeView.scrollToBeginningOfDocument(nil)
    instructions.stringValue =
      format.selectedSegment == 0
      ? "Use the fields above in Codex’s MCP server settings, or merge this TOML block into ~/.codex/config.toml. Save the server and restart its connection."
      : "Merge the cut_studio entry into your MCP client’s JSON settings, keeping other server entries. The assistant starts this local connection when needed."
  }

  private func copy(_ text: String, message: String) {
    NSPasteboard.general.clearContents()
    status.stringValue =
      NSPasteboard.general.setString(text, forType: .string)
      ? message : "Could not copy. Select the text and press ⌘C."
  }
}
