// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

/**
 * @orange/shared: what OrangeFilm's clients share.
 *
 *   contract / turn / video   a turn of the chat, what it made and the events a client sees
 *   agent-activity            how an agent's tool calls read in the chat
 *   prompt-reference          the pills a message points at
 *   title                     title width limits
 *
 * Also `@orange/shared/markdown` (Markdown parsing).
 */
export * from './modality';
export * from './contract';
export * from './agent-activity';
export * from './prompt-reference';
export * from './turn';
export * from './video';
export * from './title';
