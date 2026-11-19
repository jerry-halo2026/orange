// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * 退出登录, in the window's top-right corner — small on purpose.
 *
 * The first version was one wide button pinned at `right:150px; top:6px`, which is exactly where Studio's top bar keeps
 * the 剪辑/画布 switch: it covered the switch and took every press meant for it. This is a 20×20 corner button (`⋯`);
 * the sign-out lives in the 120px panel it opens, and the panel folds on a press anywhere else or on Escape.
 */
import { useEffect, useRef, useState } from 'react';

export type AccountExitProps = {
  /** The one action: the session's own sign-out route, posted by the shell. */
  readonly onSignOut: () => void;
};

export function AccountExit({ onSignOut }: AccountExitProps) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  /* Open: a press outside the corner (or Escape) folds it. The press is taken in the capture phase so the panel closes
     even when what was pressed stops its own propagation. */
  useEffect(() => {
    if (!open) return;
    const away = (event: Event) => {
      const at = event.target;
      if (at instanceof Node && box.current?.contains(at)) return;
      setOpen(false);
    };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', away, true);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('pointerdown', away, true);
      document.removeEventListener('keydown', key);
    };
  }, [open]);
  return <div
    className="orange-account"
    ref={box}
    onBlur={event => { const next = event.relatedTarget; if (!(next instanceof Node) || !event.currentTarget.contains(next)) setOpen(false); }}
  >
    <button
      type="button"
      className="orange-account-trigger"
      aria-label="退出登录"
      title="退出登录"
      aria-haspopup="menu"
      aria-expanded={open}
      onClick={() => setOpen(value => !value)}
    >⋯</button>
    {open && <div className="orange-account-panel" role="menu" aria-label="账号">
      <button type="button" role="menuitem" className="orange-account-exit" onClick={onSignOut}>退出登录</button>
    </div>}
  </div>;
}
