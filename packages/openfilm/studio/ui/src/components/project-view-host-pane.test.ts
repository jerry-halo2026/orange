// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * The assets pane of the workspace, held as a source contract (the view is too large to render in a test).
 *
 * In a packaged Studio the host owns the assets drawer (`hostPanel.assets`). Since the workspace port the pane is not
 * switched by a toggle of its own in the viewer pane bar: its visibility is the saved workspace's
 * (`libraryDock` + `assets`), drawn by one `WorkspaceLibraryPane`, and while the library docks in the host's chat
 * column the pane that shows is the host's drawer (`hostAssets.open`). Every write goes through the workspace
 * (`applyHostWorkspace`, `openLibrary`), so the host's drawer and the saved layout cannot disagree, and the layout menu
 * carries no second assets switch beside them.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const source = readFileSync(new URL('./ProjectView.tsx', import.meta.url), 'utf8');
const pane = readFileSync(new URL('./WorkspaceLibraryPane.tsx', import.meta.url), 'utf8');
const workspaces = readFileSync(new URL('../lib/workspaces.ts', import.meta.url), 'utf8');

test('host mode: the pane that shows is the host\'s drawer, and one write keeps it and the layout in step', () => {
  assert.match(source, /const hostAssets = hostPanel\?\.assets \?\? null;/, 'the host\'s drawer is what the view reads');
  assert.match(source, /const independentLibrary = workspacePrefs\.libraryDock !== 'chat' \|\| !hostAssets;/,
    'docked in the host\'s chat column, the library is the host\'s');
  assert.match(source, /const libraryOpen = independentLibrary \? assetsPaneOpen : Boolean\(hostAssets\?\.open\);/,
    'what shows is the host\'s open state, read as it is, not a copy of it');
  assert.match(source, /const openLibrary = \(open: boolean\) => \{ updateWorkspace\(\{ assets: open \}\); hostAssets\?\.setOpen\(open\); \};/,
    'one control writes the workspace and asks the host in the same breath: the two cannot disagree');
  assert.equal((source.match(/hostAssets\?\.setOpen\(open\)/g) ?? []).length, 1, 'exactly one such control: no second entry point');
});

test('the viewer pane bar carries no assets toggle of its own: the layout menu is the visible way', () => {
  const barStart = source.indexOf('<div className={PANE_BAR}>');
  const barEnd = source.indexOf('<input ref={relinkInputRef', barStart);
  assert.ok(barStart > 0 && barEnd > barStart, 'the viewer pane bar, and what follows it');
  const bar = source.slice(barStart, barEnd);
  assert.doesNotMatch(bar, /assetsPane\./, 'no assets wording in the bar: the pane is not switched from here');
  assert.doesNotMatch(bar, /hostAssets/, 'and not the host\'s drawer either');
  const layersToggle = bar.indexOf("t(layersShown ? 'layers.hidePane' : 'layers.showPane')");
  const inspectorToggle = bar.indexOf("t(inspectorOpen ? 'inspector.hide' : 'inspector.show')");
  assert.ok(layersToggle > 0, 'the layers toggle is still the bar\'s first control');
  assert.ok(layersToggle < inspectorToggle, 'layers first, the inspector last: the bar keeps its order');
  assert.ok(!source.includes('data-action="host-assets-toggle"'), 'the toggle the pane bar used to draw is not back');
  /* the person still has a visible way to open it, and it is the workspace's: a preset that says `assets: true` */
  assert.match(workspaces, /\{ id: 'library', layout: \{ \.\.\.defaultWorkspace\(mode\), libraryDock: 'bottom', assets: true,/,
    'a preset the layout menu offers still opens the pane');
});

test('non-host mode: the pane is the saved workspace\'s, and Home closes it through the same write', () => {
  assert.match(source, /const assetsPaneOpen = workspacePrefs\.assets;/, 'the pane\'s own state is the saved layout\'s');
  assert.match(source, /onResize=\{updateWorkspace\}/, 'a resize is written to the layout, not kept beside it');
  assert.match(source, /setLibraryTrial\(null\);openLibrary\(false\);/, 'Home closes the pane the same way, host or not');
});

test('the layout menu carries no second assets switch: it is handed the layout itself', () => {
  assert.match(source, /value=\{workspaceLayout\} onChange=\{applyWorkspace\} onReset=\{resetWorkspace\}/,
    'the menu is handed the layout, what to do with a change, and what the default is');
  assert.match(source, /hasChat=\{Boolean\(hostPanel\)\}/, 'the menu is told whether there is a chat panel to draw');
  assert.doesNotMatch(source, /hostDrawsAssets=/, 'the host-owned-drawer flag is gone: the layout\'s own `assets` carries it');
  assert.doesNotMatch(source, /onAssets=/, 'no assets switch of its own');
  assert.equal((source.match(/<ProjectLayoutMenu /g) ?? []).length, 1, 'one menu, one flag');
  assert.match(source, /if \(native\?\.assets\?\.open !== next\.assets\) hostAssets\?\.setOpen\(next\.assets\);/,
    'a layout change reaches the host\'s drawer');
});

test('the assets pane itself stays the host\'s when it exists: one pane, closed means hidden and inert', () => {
  assert.match(source, /open=\{libraryOpen\}/, 'the workspace library is open on what the view says is shown');
  assert.equal((source.match(/<WorkspaceLibraryPane /g) ?? []).length, 1, 'one library pane, not two');
  assert.match(source, /dock=\{independentLibrary \? dockGeometry\.dock : 'chat'\}/, 'in host mode it is drawn in the host\'s chat column');
  assert.match(pane, /hidden=\{!open\} inert=\{!open\}/, 'closed is hidden and inert, not unmounted: the pane keeps its state');
});
