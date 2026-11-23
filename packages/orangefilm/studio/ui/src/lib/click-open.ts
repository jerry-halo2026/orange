// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/** Toolbar popovers open only on an explicit click or key press. */
import React from 'react';

export function useClickOpen() {
  const [open, setOpen] = React.useState(false);
  const dismiss = React.useCallback(() => setOpen(false), []);
  const toggle = React.useCallback(() => setOpen(value => !value), []);
  return { open, setOpen, dismiss, toggle };
}
