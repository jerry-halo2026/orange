# orangeflim workspace instructions

Operator: Ethan. Read docs/README.md and docs/discovery/14_新会话启动与开发交付流程.md before work. Current authority: 09, PRD, 13, 00; contracts only in 07.
Use the original OpenFilm desktop/Studio v0.3.0 base. Do not create another shell, demonstration website, editor, project format or mutable timeline. Preserve original licenses and provenance.
The existing .NET Fission source is in workers/fission. It is imported, not runtime-validated: original paths can still write to the old repository. Do not start Web/doctor/stress/Bench/media before explicit path isolation and relevant approval.
Follow first principles: facts before assumptions; clarify only missing decisions that materially change the design; choose the shortest reversible validation path; investigate root causes; report only decision-relevant information.
Keep docs/ as the maintained development source; docs/history is non-executable evidence. Never edit the original D-drive index/archive or unrelated worktrees as a convenience.
dev is the permanent development integration line. After phase-one testing and independent review, integrate into dev; subsequent tasks branch from a verified dev commit. main/tag require Ethan's confirmation. Do not force-push, rewrite refs or blindly merge old independent demo history.
Use approved identity. Each change needs bounded scope, dependency/contract references, isolated resources, actual tests and non-author review. C89 permits dynamic ready-task concurrency, not overlapping writers or unlimited agents; reviews take the next available slot and integration is serial.
Cloud commits are allowed only for audited source and sanitized docs to the verified Orange repo. They do not authorize publishing secrets/data or deleting worktrees. Archive recoverable work before cleanup with native tools.
Zhishang is the business material source. Read-only connectivity and paid model testing up to CNY50 are allowed under the documented scope; do not widen account filters, upload private media/transcripts, or assume an installed Harness is ready. No unverifiable spending.
Never print or commit credentials, the private API text, raw account tokens, user media, runtime configuration or outputs. No production changes, cloud business writes, model installation or release without specific approval.
