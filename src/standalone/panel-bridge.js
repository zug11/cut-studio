/* Same-origin bridge for the production monitor/timeline UI. Kept external for CSP. */
(() => {
  const role = document.body.dataset.role;
  const origin = new URL(document.baseURI).origin;
  window.acquireVsCodeApi = () => ({
    postMessage: (data) => parent.postMessage({ cutPanel: role, data }, origin),
    getState: () => undefined,
    setState: () => undefined
  });
})();
