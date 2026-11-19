// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/** A real chat message reading its project folder from the Studio API. */
import React from 'react';
import { createRoot } from 'react-dom/client';
import { Markdown } from '../chat/src/components/Markdown';
import { ChatProjectContext } from '../chat/src/lib/developer';
import { ProjectFolderContext, readStudioProject } from '../chat/src/lib/studio-film';
import '../shell/shell.css';
import '../chat/src/chat.css';

/**
 * The project, read again until it yields one. Every project read goes through the machine-wide project-control lock
 * (`studio/server/project-control-guard.mjs`), and another Studio on this machine — a second test suite beside this one,
 * a person's open app — holding it for a moment answers 409 `control-busy`. `readStudioProject` answers `null` for that
 * refusal, exactly as it does for a project without a folder, and this fixture's project always has one: so a null here
 * is a read to try again, not a page with no folder (`window.audioFolder` would then never be set and the test would
 * fail on a stranger's timing).
 */
function readFolder(tries = 40): Promise<string | null> {
  return readStudioProject((window as any).audioProject.id).then((folder) => {
    if (folder || tries <= 1) return folder;
    return new Promise((done) => setTimeout(done, 100)).then(() => readFolder(tries - 1));
  });
}

function Fixture() {
  const [folder, setFolder] = React.useState<string | null>(null);
  React.useEffect(() => { void readFolder().then(setFolder); }, []);
  (window as any).audioFolder = folder;
  return <ProjectFolderContext.Provider value={folder}>
    <ChatProjectContext.Provider value={(window as any).audioProject.path}>
      <div className="of-chat"><Markdown text={'[Voice A](assets/%E5%A3%B0%E9%9F%B3%20A.wav) [Large](assets/large.wav) [Missing](assets/missing.wav) [Parent](../outside.wav) [Encoded parent](%2e%2e/outside.wav) [Link](assets/link.wav) [Website](https://example.com/)'} /></div>
      <div id="of-chat-layer" className="of-chat" />
    </ChatProjectContext.Provider>
  </ProjectFolderContext.Provider>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
