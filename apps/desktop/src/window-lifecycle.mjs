/** Keep the macOS window available for Dock activation without ending Studio or agent sessions. */
export function keepWindowOnClose(win, { mac, isQuitting, save, requestQuit, canClose = () => false }) {
  let leavingFullScreen = false;
  function cancelClose() {
    leavingFullScreen = false;
    win.removeListener('leave-full-screen', hide);
  }
  function hide() {
    cancelClose();
    if (!win.isDestroyed() && !isQuitting()) win.hide();
  }
  win.on('close', (event) => {
    save();
    // A controlled desktop keeps its window alive until the single quit path confirms preservation.
    if (requestQuit && (!mac || isQuitting()) && !canClose()) {
      event.preventDefault(); requestQuit(); return;
    }
    if (mac && !isQuitting()) {
      event.preventDefault();
      if (leavingFullScreen) return;
      if (!win.isFullScreen()) { win.hide(); return; }
      /* Hiding a native full-screen window leaves its Space black. Its exit is asynchronous on macOS. */
      leavingFullScreen = true;
      win.once('leave-full-screen', hide);
      win.setFullScreen(false);
    } else cancelClose();
  });
  /* Dock activation while full screen is leaving keeps the window open. */
  return cancelClose;
}

/** An empty projects page closes its window only on macOS. */
export function closeTabOrWindow(win, { mac, activeId, closeTab }) {
  if (activeId) void closeTab(activeId);
  else if (mac) win?.close();
}

/** Mark Quit before window close can run, even before Studio has started or after startup failed. */
export function quitAfterStudio(event, { quitting, markQuitting, studio, closeAgents, quit, confirmQuit, onFailure = () => {} }) {
  if (quitting) { if (confirmQuit) event.preventDefault(); return; }
  markQuitting();
  if (!studio && !confirmQuit) { closeAgents(); return; }
  event.preventDefault();
  // Seal main/Agent admission synchronously, but a failed Agent cannot prevent
  // the original utility stop from sealing its authoritative controller too.
  let agents, utility;
  try { agents=Promise.resolve(closeAgents()); } catch(error) { agents=Promise.reject(error); }
  try { utility=Promise.resolve(studio?.quit()); } catch(error) { utility=Promise.reject(error); }
  return Promise.allSettled([agents,utility]).then(results=>{
    const failed=results.find(result=>result.status==='rejected');
    if(failed)return onFailure(failed.reason);
    confirmQuit?.();quit();
  });
}
