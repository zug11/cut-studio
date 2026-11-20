import AppKit
import UniformTypeIdentifiers
import WebKit

@main
@MainActor
struct CUTStudioMain {
  static func main() {
    let application = NSApplication.shared
    let delegate = AppDelegate()
    application.delegate = delegate
    application.setActivationPolicy(.regular)
    application.run()
    withExtendedLifetime(delegate) {}
  }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, WKNavigationDelegate,
  WKUIDelegate, WKScriptMessageHandler
{
  private var window: NSWindow!
  private var webView: WKWebView!
  private let engine = LocalEngine()
  private var tools: InstalledTools?
  private var project: URL?
  private var pendingOpen: URL?
  private var pendingFile: String?
  private var quitting = false
  private var checkingClose = false
  private var importing = false
  private var started = false
  private var editorReady = false
  private var projectRevision = 0
  private var assistantConnection: AssistantConnectionWindow?
  private var resources: URL { Bundle.main.resourceURL! }

  func applicationDidFinishLaunching(_ notification: Notification) {
    NSApp.appearance = NSAppearance(named: .darkAqua)
    buildMenu()
    createWindow()
    engine.onReady = { [weak self] origin in self?.loadEditor(origin: origin) }
    engine.onFailure = { [weak self] message in
      self?.showError("CUT Studio could not start", message)
    }
    started = true
    do {
      tools = try InstalledTools.detect()
      let sample = try seedSampleProject()
      if let pendingOpen {
        self.pendingOpen = nil
        openURL(pendingOpen, ask: false)
      } else if let previous = UserDefaults.standard.string(forKey: "projectRoot"),
        FileManager.default.fileExists(atPath: previous)
      {
        switchProject(
          URL(fileURLWithPath: previous),
          file: UserDefaults.standard.string(forKey: "activeFile") ?? "layers.cut", ask: false)
      } else {
        switchProject(sample, file: "light-study.cut", ask: false)
      }
    } catch { showDependencyError(error.localizedDescription) }
    window.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)
  }

  private var appVersion: String {
    Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0.2.0"
  }

  private func createWindow() {
    window = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 1380, height: 900),
      styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false
    )
    window.title = "CUT Studio"
    window.minSize = NSSize(width: 1024, height: 660)
    window.center()
    window.setFrameAutosaveName("CUTStudioMainWindow")
    window.delegate = self
    window.isReleasedWhenClosed = false
    window.backgroundColor = NSColor(calibratedRed: 0.08, green: 0.095, blue: 0.11, alpha: 1)
    let content = WKUserContentController()
    content.add(self, name: "cutStudio")
    content.addUserScript(
      WKUserScript(
        source: "window.__CUT_NATIVE__ = { version: 1 };", injectionTime: .atDocumentStart,
        forMainFrameOnly: true))
    let configuration = WKWebViewConfiguration()
    configuration.userContentController = content
    configuration.websiteDataStore = .nonPersistent()
    configuration.mediaTypesRequiringUserActionForPlayback = []
    configuration.applicationNameForUserAgent = "CUTStudio/" + appVersion
    webView = WKWebView(frame: window.contentView!.bounds, configuration: configuration)
    webView.autoresizingMask = [.width, .height]
    webView.navigationDelegate = self
    webView.uiDelegate = self
    if #available(macOS 13.3, *) { webView.isInspectable = true }
    window.contentView = webView
    showLoading()
  }

  private func showLoading() {
    editorReady = false
    webView.loadHTMLString(
      "<!doctype html><html><body style='margin:0;background:#15191d;color:#a9d7b7;font:14px -apple-system;display:grid;place-content:center;height:100vh'><div style='font-size:24px;letter-spacing:3px'>/ CUT STUDIO</div><p style='color:#8d98a1;font-size:12px;letter-spacing:0'>Preparing your local editing engine…</p></body></html>",
      baseURL: nil)
  }

  private func buildMenu() {
    let bar = NSMenu()
    func submenu(_ title: String) -> NSMenu {
      let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
      let menu = NSMenu(title: title)
      item.submenu = menu
      bar.addItem(item)
      return menu
    }
    func add(
      _ menu: NSMenu, _ title: String, _ action: Selector, _ key: String = "",
      _ modifiers: NSEvent.ModifierFlags = [.command]
    ) {
      let item = NSMenuItem(title: title, action: action, keyEquivalent: key)
      item.target = self
      item.keyEquivalentModifierMask = modifiers
      menu.addItem(item)
    }
    let app = submenu("CUT Studio")
    add(app, "About CUT Studio", #selector(about))
    add(app, "Connect an AI Assistant…", #selector(connectAssistant))
    app.addItem(.separator())
    add(app, "Hide CUT Studio", #selector(hideApp), "h")
    let hideOthers = NSMenuItem(
      title: "Hide Others", action: #selector(NSApplication.hideOtherApplications(_:)),
      keyEquivalent: "h")
    hideOthers.target = NSApp
    hideOthers.keyEquivalentModifierMask = [.command, .option]
    app.addItem(hideOthers)
    app.addItem(.separator())
    add(app, "Quit CUT Studio", #selector(quit), "q")
    let file = submenu("File")
    add(file, "New Film…", #selector(newFilm), "n")
    add(file, "Open Project…", #selector(openProject), "o")
    add(file, "Open CUT File…", #selector(openFile), "o", [.command, .shift])
    add(file, "Import Media…", #selector(importMedia), "i")
    file.addItem(.separator())
    add(file, "Save", #selector(save), "s")
    add(file, "Export…", #selector(exportFilm), "e", [.command, .shift])
    add(file, "Reveal Project in Finder", #selector(revealProject))
    file.addItem(.separator())
    add(file, "Close Window", #selector(closeWindow), "w")
    let edit = submenu("Edit")
    add(edit, "Undo", #selector(undo), "z")
    add(edit, "Redo", #selector(redo), "z", [.command, .shift])
    edit.addItem(.separator())
    for (title, action, key) in [
      ("Cut", "cut:", "x"), ("Copy", "copy:", "c"), ("Paste", "paste:", "v"),
      ("Select All", "selectAll:", "a"),
    ] {
      edit.addItem(NSMenuItem(title: title, action: Selector(action), keyEquivalent: key))
    }
    let view = submenu("View")
    add(view, "Reload Editor", #selector(reload), "r")
    let windows = submenu("Window")
    let minimize = NSMenuItem(
      title: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
    windows.addItem(minimize)
    windows.addItem(
      NSMenuItem(title: "Zoom", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: ""))
    NSApp.windowsMenu = windows
    NSApp.mainMenu = bar
  }

  @objc private func about() {
    NSApp.orderFrontStandardAboutPanel(options: [
      .applicationName: "CUT Studio", .applicationVersion: appVersion,
      .credits: NSAttributedString(
        string: "The code is the movie.\nA local film editor powered by CUT and FFmpeg."),
    ])
  }
  @objc private func hideApp() { NSApp.hide(nil) }
  @objc private func quit() { NSApp.terminate(nil) }
  @objc private func closeWindow() { window.performClose(nil) }
  @objc private func save() { invoke("save") }
  @objc private func exportFilm() { invoke("exportFilm") }
  @objc private func newFilm() { invoke("newFilm") }
  @objc private func undo() { invoke("undo") }
  @objc private func redo() { invoke("redo") }
  @objc private func connectAssistant() {
    guard let project else {
      showError(
        "Open a project first",
        "The assistant connection is scoped to the project selected in CUT Studio.")
      return
    }
    let launcher = resources.appendingPathComponent("runtime/cut-mcp")
    if let assistantConnection {
      assistantConnection.update(project: project, launcher: launcher)
    } else {
      assistantConnection = AssistantConnectionWindow(project: project, launcher: launcher)
    }
    assistantConnection?.present(relativeTo: window)
  }
  @objc private func revealProject() {
    if let project { NSWorkspace.shared.activateFileViewerSelecting([project]) }
  }

  private func invoke(_ method: String) {
    guard editorReady else { return }
    webView.callAsyncJavaScript(
      "if (window.cutNative && typeof window.cutNative[method] === 'function') return await window.cutNative[method](); return false;",
      arguments: ["method": method], in: nil, in: .page
    ) { [weak self] result in
      if case .failure(let error) = result {
        self?.showError("The editor could not complete that action", error.localizedDescription)
      }
    }
  }

  @objc private func openProject() {
    let panel = NSOpenPanel()
    panel.title = "Open CUT Project"
    panel.prompt = "Open Project"
    panel.canChooseDirectories = true
    panel.canChooseFiles = false
    panel.allowsMultipleSelection = false
    panel.beginSheetModal(for: window) { [weak self] response in
      if response == .OK, let url = panel.url { self?.openURL(url) }
    }
  }

  @objc private func openFile() {
    let panel = NSOpenPanel()
    panel.title = "Open CUT Film"
    panel.prompt = "Open Film"
    panel.canChooseDirectories = false
    panel.canChooseFiles = true
    panel.allowsMultipleSelection = false
    if let cut = UTType(filenameExtension: "cut") { panel.allowedContentTypes = [cut] }
    panel.beginSheetModal(for: window) { [weak self] response in
      if response == .OK, let url = panel.url { self?.openURL(url) }
    }
  }

  func application(_ application: NSApplication, open urls: [URL]) {
    guard let url = urls.first else { return }
    if started { openURL(url) } else { pendingOpen = url }
  }

  private func openURL(_ url: URL, ask: Bool = true) {
    let target = url.standardizedFileURL.resolvingSymlinksInPath()
    var directory: ObjCBool = false
    guard FileManager.default.fileExists(atPath: target.path, isDirectory: &directory) else {
      showError("Project not found", target.path)
      return
    }
    if directory.boolValue {
      switchProject(target, file: nil, ask: ask)
      return
    }
    guard target.pathExtension.lowercased() == "cut" else {
      showError(
        "Choose a CUT film or project folder", "Media can be added with File → Import Media…")
      return
    }
    if let project, isWithin(target, project) {
      let relative = String(target.path.dropFirst(project.path.count + 1))
      guard editorReady else {
        pendingFile = relative
        return
      }
      webView.callAsyncJavaScript(
        "if (window.cutNative?.openFile) return await window.cutNative.openFile(file); return false;",
        arguments: ["file": relative], in: nil, in: .page
      ) { _ in }
    } else {
      switchProject(target.deletingLastPathComponent(), file: target.lastPathComponent, ask: ask)
    }
  }

  private func switchProject(_ root: URL, file: String?, ask: Bool) {
    let proceed = { [weak self] in
      guard let self else { return }
      self.projectRevision += 1
      let revision = self.projectRevision
      self.showLoading()
      self.engine.stop {
        guard self.projectRevision == revision, !self.quitting, let tools = self.tools else {
          return
        }
        do {
          self.project = root.standardizedFileURL.resolvingSymlinksInPath()
          self.assistantConnection?.update(
            project: self.project!,
            launcher: self.resources.appendingPathComponent("runtime/cut-mcp"))
          self.pendingFile = file
          self.window.title = "CUT Studio — \(root.lastPathComponent)"
          self.window.representedURL = root
          self.window.isDocumentEdited = false
          UserDefaults.standard.set(self.project!.path, forKey: "projectRoot")
          try self.engine.start(project: self.project!, resources: self.resources, tools: tools)
        } catch { self.showError("Could not open the project", error.localizedDescription) }
      }
    }
    if ask { canLeave { if $0 { proceed() } } } else { proceed() }
  }

  private func loadEditor(origin: URL) {
    var components = URLComponents(url: origin, resolvingAgainstBaseURL: false)!
    var query = [URLQueryItem(name: "native", value: "1")]
    if let pendingFile { query.append(URLQueryItem(name: "file", value: pendingFile)) }
    components.queryItems = query
    webView.load(URLRequest(url: components.url!))
  }

  private func seedSampleProject() throws -> URL {
    let support = try FileManager.default.url(
      for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true
    ).appendingPathComponent("CUT Studio", isDirectory: true)
    let destination = support.appendingPathComponent("Sample Project", isDirectory: true)
    let sample = resources.appendingPathComponent("examples", isDirectory: true)
    try FileManager.default.createDirectory(at: destination, withIntermediateDirectories: true)
    if let enumerator = FileManager.default.enumerator(
      at: sample, includingPropertiesForKeys: [.isDirectoryKey], options: [.skipsHiddenFiles])
    {
      for case let source as URL in enumerator {
        let relative = String(source.path.dropFirst(sample.path.count + 1))
        let target = destination.appendingPathComponent(relative)
        if (try source.resourceValues(forKeys: [.isDirectoryKey])).isDirectory == true {
          try FileManager.default.createDirectory(at: target, withIntermediateDirectories: true)
        } else if !FileManager.default.fileExists(atPath: target.path) {
          try FileManager.default.copyItem(at: source, to: target)
        }
      }
    }
    return destination
  }

  private func canLeave(_ completion: @escaping (Bool) -> Void) {
    guard !importing else {
      showError(
        "Media is still being imported",
        "Wait for the import to finish before closing or switching projects.")
      completion(false)
      return
    }
    guard editorReady else {
      completion(true)
      return
    }
    guard !checkingClose else {
      completion(false)
      return
    }
    checkingClose = true
    webView.callAsyncJavaScript(
      "if (window.cutNative?.canClose) return await window.cutNative.canClose(); return true;",
      arguments: [:], in: nil, in: .page
    ) { [weak self] result in
      guard let self else {
        completion(false)
        return
      }
      self.checkingClose = false
      switch result {
      case .success(let value): completion((value as? Bool) ?? false)
      case .failure(let error):
        let alert = NSAlert()
        alert.messageText = "The editor did not respond"
        alert.informativeText = "Unsaved changes may be lost.\n\n\(error.localizedDescription)"
        alert.addButton(withTitle: "Cancel")
        alert.addButton(withTitle: "Leave Without Saving")
        completion(alert.runModal() == .alertSecondButtonReturn)
      }
    }
  }

  func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
    if quitting { return .terminateLater }
    quitting = true
    canLeave { [weak self] allowed in
      guard let self else {
        sender.reply(toApplicationShouldTerminate: true)
        return
      }
      if !allowed {
        self.quitting = false
        sender.reply(toApplicationShouldTerminate: false)
        return
      }
      self.engine.stop { sender.reply(toApplicationShouldTerminate: true) }
    }
    return .terminateLater
  }

  func windowShouldClose(_ sender: NSWindow) -> Bool {
    NSApp.terminate(nil)
    return false
  }
  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
  func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool
  {
    window.makeKeyAndOrderFront(nil)
    return true
  }
  @objc private func reload() {
    canLeave { [weak self] allowed in if allowed { self?.webView.reload() } }
  }

  nonisolated private func isWithin(_ file: URL, _ directory: URL) -> Bool {
    file.path == directory.path || file.path.hasPrefix(directory.path + "/")
  }

  func userContentController(
    _ userContentController: WKUserContentController, didReceive message: WKScriptMessage
  ) {
    guard message.frameInfo.isMainFrame, let body = message.body as? [String: Any],
      let action = body["action"] as? String
    else { return }
    switch action {
    case "importMedia": importMedia()
    case "reveal":
      guard let project, let relative = body["path"] as? String, !relative.hasPrefix("/") else {
        return
      }
      let target = project.appendingPathComponent(relative).standardizedFileURL
        .resolvingSymlinksInPath()
      if isWithin(target, project), FileManager.default.fileExists(atPath: target.path) {
        NSWorkspace.shared.activateFileViewerSelecting([target])
      }
    case "documentState":
      window.isDocumentEdited = body["dirty"] as? Bool ?? false
      if let relative = body["file"] as? String, !relative.isEmpty,
        !relative.hasPrefix("/"), let project,
        isWithin(project.appendingPathComponent(relative).standardizedFileURL, project)
      {
        UserDefaults.standard.set(relative, forKey: "activeFile")
      }
    default: break
    }
  }

  @objc private func importMedia() {
    guard let project, !importing else { return }
    let panel = NSOpenPanel()
    panel.title = "Import Media"
    panel.prompt = "Import"
    panel.canChooseDirectories = false
    panel.canChooseFiles = true
    panel.allowsMultipleSelection = true
    panel.allowedContentTypes = [.movie, .audio, .png, .jpeg, .webP] + ["srt", "vtt"].compactMap { UTType(filenameExtension: $0) }
    panel.beginSheetModal(for: window) { [weak self] response in
      guard let self, response == .OK, self.project == project else { return }
      self.importing = true
      let sources = panel.urls
      DispatchQueue.global(qos: .userInitiated).async {
        var failures: [String] = []
        let destination = project.appendingPathComponent("media", isDirectory: true)
        do {
          guard self.isWithin(destination.resolvingSymlinksInPath(), project) else {
            throw RuntimeFailure("The media folder points outside the project.")
          }
          try FileManager.default.createDirectory(
            at: destination, withIntermediateDirectories: true)
          guard self.isWithin(destination.resolvingSymlinksInPath(), project) else {
            throw RuntimeFailure("The media folder points outside the project.")
          }
          for source in sources {
            var suffix = 1
            while true {
              let name =
                suffix == 1
                ? source.lastPathComponent
                : source.deletingPathExtension().lastPathComponent + "-\(suffix)"
                  + (source.pathExtension.isEmpty ? "" : "." + source.pathExtension)
              let target = destination.appendingPathComponent(name)
              do {
                try FileManager.default.copyItem(at: source.resolvingSymlinksInPath(), to: target)
                break
              } catch {
                if (error as NSError).code == NSFileWriteFileExistsError && suffix < 10000 {
                  suffix += 1
                  continue
                }
                failures.append("\(source.lastPathComponent): \(error.localizedDescription)")
                break
              }
            }
          }
        } catch { failures.append(error.localizedDescription) }
        DispatchQueue.main.async {
          self.importing = false
          self.invoke("refreshFiles")
          if !failures.isEmpty {
            self.showError("Some media could not be imported", failures.joined(separator: "\n"))
          }
        }
      }
    }
  }

  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    editorReady = webView.url?.host == "127.0.0.1"
  }
  func webView(
    _ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!,
    withError error: Error
  ) {
    if (error as NSError).code != NSURLErrorCancelled {
      showError("Could not load the editor", error.localizedDescription)
    }
  }
  func webView(
    _ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
    decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
  ) {
    guard let url = navigationAction.request.url else {
      decisionHandler(.cancel)
      return
    }
    if url.scheme == "about"
      || (url.scheme == "blob" && navigationAction.targetFrame?.isMainFrame != true)
    {
      decisionHandler(.allow)
      return
    }
    if let origin = engine.origin, url.scheme == origin.scheme, url.host == origin.host,
      url.port == origin.port
    {
      decisionHandler(.allow)
      return
    }
    if navigationAction.navigationType == .linkActivated,
      ["https", "http"].contains(url.scheme ?? "")
    {
      NSWorkspace.shared.open(url)
    }
    decisionHandler(.cancel)
  }

  func webView(
    _ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
    initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void
  ) {
    let alert = NSAlert()
    alert.messageText = "CUT Studio"
    alert.informativeText = message
    alert.addButton(withTitle: "OK")
    alert.runModal()
    completionHandler()
  }
  func webView(
    _ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
    initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void
  ) {
    let alert = NSAlert()
    alert.messageText = "CUT Studio"
    alert.informativeText = message
    alert.addButton(withTitle: "Continue")
    alert.addButton(withTitle: "Cancel")
    completionHandler(alert.runModal() == .alertFirstButtonReturn)
  }
  func webView(
    _ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String,
    defaultText: String?, initiatedByFrame frame: WKFrameInfo,
    completionHandler: @escaping (String?) -> Void
  ) {
    let alert = NSAlert()
    alert.messageText = "CUT Studio"
    alert.informativeText = prompt
    alert.addButton(withTitle: "Continue")
    alert.addButton(withTitle: "Cancel")
    let input = NSTextField(string: defaultText ?? "")
    input.frame = NSRect(x: 0, y: 0, width: 380, height: 24)
    alert.accessoryView = input
    alert.window.initialFirstResponder = input
    completionHandler(alert.runModal() == .alertFirstButtonReturn ? input.stringValue : nil)
  }

  private func showError(_ title: String, _ message: String) {
    let alert = NSAlert()
    alert.alertStyle = .warning
    alert.messageText = title
    alert.informativeText = message
    alert.addButton(withTitle: "OK")
    alert.runModal()
  }
  private func showDependencyError(_ message: String) {
    let alert = NSAlert()
    alert.messageText = "Install CUT Studio’s local tools"
    alert.informativeText = message
    alert.addButton(withTitle: "OK")
    alert.addButton(withTitle: "Node.js Website")
    alert.addButton(withTitle: "FFmpeg Website")
    let choice = alert.runModal()
    if choice == .alertSecondButtonReturn {
      NSWorkspace.shared.open(URL(string: "https://nodejs.org/")!)
    }
    if choice == .alertThirdButtonReturn {
      NSWorkspace.shared.open(URL(string: "https://ffmpeg.org/download.html")!)
    }
  }
}
