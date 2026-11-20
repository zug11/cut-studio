import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';

/** The same static view code is used in VS Code and the browser QA harness. */
export function webviewHtml(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  role: 'monitor' | 'timeline'
): string {
  const nonce = randomBytes(24).toString('base64');
  const cacheKey = randomBytes(12).toString('hex');
  const css = webview
    .asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'studio.css'))
    .with({ query: `v=${cacheKey}` });
  const js = webview
    .asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'studio.js'))
    .with({ query: `v=${cacheKey}` });
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; media-src ${webview.cspSource} blob:; connect-src ${webview.cspSource};">
<title>CUT Studio ${role}</title><link href="${css}" rel="stylesheet"></head>
<body data-role="${role}"><main id="studio" aria-label="CUT Studio ${role}"></main><script nonce="${nonce}" src="${js}"></script></body></html>`;
}
