const vscode = require('vscode');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs/promises');
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn, label) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await fn()) return;
    await wait(100);
  }
  throw new Error(`Timed out: ${label}`);
}
exports.run = async function () {
  const root = path.resolve(__dirname, '../..');
  const extension = vscode.extensions.getExtension('cut-studio.cut-studio');
  assert.ok(extension, 'extension discovered');
  await extension.activate();
  assert.equal(extension.isActive, true);
  const commands = await vscode.commands.getCommands(true);
  for (const id of [
    'cut.openPreview',
    'cut.check',
    'cut.timeline',
    'cut.preview',
    'cut.render',
    'cut.renderRange',
    'cut.exportPremiere',
    'cut.exportXml'
  ])
    assert.ok(commands.includes(id), `registered ${id}`);
  const document = await vscode.workspace.openTextDocument(path.join(root, 'examples/signal.cut'));
  await vscode.window.showTextDocument(document, vscode.ViewColumn.One);
  assert.equal(document.languageId, 'cut');
  await vscode.commands.executeCommand('cut.openPreview');
  await vscode.commands.executeCommand('cut.timeline');
  await wait(1000);
  assert.equal(
    vscode.languages
      .getDiagnostics(document.uri)
      .filter((d) => d.severity === vscode.DiagnosticSeverity.Error).length,
    0,
    'sample has no editor errors'
  );
  const file = path.join(root, 'examples', '.smoke.cut');
  try {
    await fs.writeFile(
      file,
      'film "Missing" { fps 24\n track video "Main" { clip "media/missing-file.mp4" from 0s to 1s at 0s } }'
    );
    const broken = await vscode.workspace.openTextDocument(file);
    await vscode.window.showTextDocument(broken, vscode.ViewColumn.One);
    await until(
      () =>
        vscode.languages
          .getDiagnostics(broken.uri)
          .some(
            (d) =>
              d.severity === vscode.DiagnosticSeverity.Error &&
              /missing|not found|exist|ENOENT/i.test(d.message)
          ),
      'missing asset diagnostics'
    );
    const edit = new vscode.WorkspaceEdit();
    edit.replace(
      broken.uri,
      new vscode.Range(broken.positionAt(0), broken.positionAt(broken.getText().length)),
      'film "Recovered" { fps 24\n track video "Main" { clip "media/dawn.mp4" from 0s to 1s at 0s } }'
    );
    await vscode.workspace.applyEdit(edit);
    await until(
      () =>
        !vscode.languages
          .getDiagnostics(broken.uri)
          .some((d) => d.severity === vscode.DiagnosticSeverity.Error),
      'diagnostics clear after unsaved code edit'
    );
    const completion = await vscode.commands.executeCommand(
      'vscode.executeCompletionItemProvider',
      broken.uri,
      new vscode.Position(0, 19)
    );
    assert.ok(completion && completion.items.length > 0, 'CUT completions available');
    const layeredSource = 'film "Layers" { fps 24\n track video "Top" layer 3 { clip "media/dawn.mp4" { in 0s out 1s at 0s layer 1 } } }';
    const layerEdit = new vscode.WorkspaceEdit();
    layerEdit.replace(broken.uri, new vscode.Range(broken.positionAt(0), broken.positionAt(broken.getText().length)), layeredSource);
    await vscode.workspace.applyEdit(layerEdit);
    await until(() => !vscode.languages.getDiagnostics(broken.uri).some(d => d.severity === vscode.DiagnosticSeverity.Error), 'explicit track and clip layers accepted');
    const layerCompletion = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', broken.uri, broken.positionAt(layeredSource.indexOf('layer 1') + 4));
    assert.ok(layerCompletion.items.some(item => (typeof item.label === 'string' ? item.label : item.label.label) === 'layer'), 'clip layer completion available');
    const invalidLayer = new vscode.WorkspaceEdit();
    const layerOffset = broken.getText().indexOf('layer 1') + 6;
    invalidLayer.replace(broken.uri, new vscode.Range(broken.positionAt(layerOffset), broken.positionAt(layerOffset + 1)), '0');
    await vscode.workspace.applyEdit(invalidLayer);
    await until(() => vscode.languages.getDiagnostics(broken.uri).some(d => d.code === 'invalid-layer'), 'invalid layer diagnostic available');
    await vscode.window.showTextDocument(document, vscode.ViewColumn.One);
    await vscode.commands.executeCommand('cut.openPreview');
    console.log(
      'CUT VSCODE SMOKE: activation, language, commands, monitor, timeline, media diagnostics, unsaved edit recovery, completions PASSED'
    );
  } finally {
    await fs.rm(file, { force: true });
  }
};
