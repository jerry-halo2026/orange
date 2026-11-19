// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

export {
  PromptEditor,
  type PromptEditorHandle,
  type PromptEditorProps,
  type PromptEditorState,
} from './PromptEditor';
export { PILL_ICON, PromptPill, PromptPillHoverContext, PromptPillRevealContext, PromptWithPills, type PromptPillCard, type PromptPillHover } from './PromptPill';
export { type MentionMenuConfig } from './MentionMenuPlugin';
export {
  buildMentionMenu,
  matchMentionTrigger,
  MENTION_MENU_LIMIT,
  type MentionEntry,
  type MentionItem,
  type MentionProvider,
} from './mention-menu';
export {
  activatedSkillIds,
  collectPromptReferences,
  fileReferenceId,
  fileReferencePath,
  promptReferenceToken,
  resolvePromptReferences,
  skillReferenceId,
  skillReferencePackage,
  splitPromptReferenceText,
  stripPromptReferenceTokens,
  type PromptReference,
  type PromptReferenceKind,
  type PromptTextSegment,
} from './prompt-text';
