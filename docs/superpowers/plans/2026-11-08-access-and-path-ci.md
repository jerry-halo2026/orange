# Approved-N0 access policy and Windows path CI implementation slices

> For agentic workers: use superpowers:subagent-driven-development and test-driven-development. This refines approved phase-one T02.a/T01 verification only; no pilot scope reduction.

**Goal:** implement the signed identity rules in the original Studio's smallest internal policy, and obtain actual Windows evidence for the source-reviewed Fission pure path tests.
**Architecture:** two independent writers in the existing managed E2/E3 worktrees; root owns docs/07/cards/lock handoff and serial dependency assembly. No second application, editor, project format or transport DTO.
**Tech Stack:** existing native .mjs/JSDoc/Node built-in tests; original C# project and unchanged compiler shim in a standard Windows CI job.
**Spec:** approved 2026-11-08-identity-access-n0.md, docs07/09/16/17, original phase-one plan and the exact execution cards. D12 real Auth environment remains unconfirmed. This plan is proposed until independent policy review and immutable scoped admission.

## Global constraints
- Original Project/Clip IDs, film hash/rev and seconds/transcript milliseconds stay native; new monotonic milliseconds are internal authorization time only.
- No real Auth, account/config read, media, provider/model call, business cloud write, SDK install, production/main/tag/release. Product model calls remain zero and cumulative CNY50 is not reset.
- A policy decision is not real authentication, owner persistence, content hiding, safe saving, or N1. Actual consumers must later prove these boundaries.
- T05 original43run41pass2ENVfail0skip remains historical evidence, not a passing new head. Genuine symbolic-link assertions cannot be replaced with Linux/junction or skip.
- Source authors touch only card allowlists, no Git writes, no subagents, no shared docs/workspace/lock mutation; non-author spec and quality review precedes root commit/integration.

## Review Focus
1. Scalar evidence is not proof: no public verified flag or renderer-driven factory/mutator; future trusted call sites are explicitly unfinished.
2. Expiry cannot be renewed by requests, rebinding, mutation or backward clock; material expiry must not revoke unrelated first-party session state.
3. Metadata-only means metadata, not indefinite restricted/media access; absence is never an unlimited grant.
4. Switch completion is a trusted notification barrier, not evidence that this CPU module actually flushed files or retired previews/streams.
5. CI must execute original43cases on Windows, report actual compiler, and reject missing/skipped/duplicate/malformed results. A verifier or YAML file alone is no remote execution proof.

## Access
**Files:** only project-access.mjs and project-access.test.mjs under original packages/openfilm/studio/server in E2. Classify business-addition/K01 internal subset. No new package/transport/TS-C# schema or integration entry.

**Interfaces:** one export createProjectAccessPolicy(sessionEvidence,{monotonicNow}); frozen methods bindProject,decide,revoke,beginSwitch,completeSwitch,dispose, as fixed in rev3 card. Session evidence and trusted mutators are internal future service inputs, not credentials or renderer APIs. There is deliberately no verified:true, network flag, cache-login restore or TTL renewal input.

Session evidence is snapshotted once: exact nonempty environmentId/subjectId/instanceId, positive safe integer epoch, finite nonnegative establishedAtMs/expiresAtMs in this instance's monotonic domain, establishedAtMs <= initial now < expiresAtMs. Real trusted consumer later maps an online-verified lifetime once; this module cannot prove that source.

Project evidence is snapshotted once: environmentId,ownerSubjectId,original opaque projectId,ownership controlled|unknown,material exactly {kind:"metadata-only"} or {kind:"applicable",expiresAtMs}. The kind discriminator and expiresAtMs live directly in material; unknown keys, wrong discriminator and nested expiry/TTL are rejected. Applicable requires finite nonnegative expiresAtMs in the same domain. Unknown ownership/other owner/malformed/absent material refuses a handle. Same projectId binds idempotently only for identical evidence; owner/material/deadline changes refuse, including extending or shortening grants. First slice does not implement evidence refresh. Metadata-only permits only metadata, not restricted access.

Context is exact environmentId/subjectId/instanceId/epoch/projectId; session-only mutators omit projectId. Access is metadata|restricted. Unknown fields/types are rejected, not converted or used for owner/duration overrides. Opaque frozen handles are registered by object identity inside this policy; copying/forging/cross-policy reuse fails.

Decision output is frozen {allowed,reason,view,recovery}; view retain|lock-hide, recovery always retain. Only successful bind/begin adds handle. Fixed reasons: allowed,invalid-input,invalid-policy,identity-mismatch,unknown-project,ownership-unproven,owner-mismatch,material-required,expired,clock-anomaly,revoked,switching,switch-not-ready,retired,disposed. No input values/raw exceptions/identity/tokens/paths returned or logged.

Every active decision/transition samples the injected clock once: equal lastNow allowed; backward/negative/nonfinite/throw becomes sticky deny. Session cutoff sticky; per-project material cutoff min(session,material) denies that project without invalidating unrelated sessions/projects. Equality is expired, no grace. Matched trusted revoke stays denied/lock-hide; stale context cannot mutate the active policy. Disposed/retired/invalid policies never regain access. Invalid factory/hostile getters/proxy traps produce an inert deny policy, not leaked exception text.

beginSwitch under valid A enters a unique private barrier and blocks new normal accesses. The trusted consumer must first finish preservation/settle old operations; only then call completeSwitch with A's original context and same one-use handle while A and all bound applicable permissions remain valid. Success retires A, consumes barrier and only permits releasing A's barrier; it does NOT authenticate/authorize B or transfer A handles/data. Failure keeps barrier/B blocked. No preserved:true/force/late completion. dispose terminal and safe even for invalid policies.

- [ ] Write actual failing tests for all rev3 groups; missing module/import RED may establish absent capability, then behavioral RED before semantics. Preserve first failure, no implementation-first stubs.
- [ ] Implement only the minimal private snapshots/maps/phase/clock logic. No IO, timer, logger, network, global environment or mutable exposed state.
- [ ] Run new tests with full TAP counters and zero fail/skip/todo/cancel, native47 regression, scoped84 CPU regression; syntax and applicable native typecheck.
- [ ] Non-author exact-diff spec/quality review; root independent verification and local commit. At most pure-policy-ready, not full K01/N1/T03 or real safe-switch/online login proof.

## CI
**Files:** only root fission-path-policy.yml, scripts/fission-path-ci.mjs and its built-in test in E3. Source C# remains frozen. Classify engineering verification, task T01rev7, exclusive root CI writer.

**Workflow:** push only codex/t05-path-policy relevant paths plus optional manual trigger on same branch; one standard windows-2025 job <=12min, public Orange only. contents:read, no id-token/secrets/write/action artifact/cache upload. Checkout official verified v4 SHA11d5960a326750d5838078e36cf38b85af677262, github.sha, persist-credentials:false. No main/default-branch/config change required. Node preinstalled>=22.18; no dependencies for JS tests.

**Script:** inert on import; CLI calls runPathPolicyCi only after validatePathCiContext. Reject nonActions/nonWindows/otherrepo/otherbranch/invalidrun+attempt+SHA/workspace before mkdir/spawn. Owned .dev/fission-ci/run/attempt paths and ordinary ancestors checked. Build a clean allowlisted child environment, never spread process.env, and own all HOME/user/appdata/ProgramData/cache/temp/NuGet/CLIHOME. No inherited private feed/account/provider settings. Explicitly create and path-check the owned fixtures subdirectory, then set FISSION_PATH_POLICY_TEST_ROOT to it in the clean dotnet child environment; frozen Fixture requires this variable (source328-329), missing/empty never falls back.

Require preinstalled exact SDK10.0.403; no setup/install/download. Generate owned scratch global.json with rollForward disabled; use real installed dotnet.exe. Original csc shim selects its DOTNET_ROOT/sdk inventory, so make an owned tool inventory containing only a directory junction to that preinstalled SDK, not a new compiler/modified shim. PATH points to real installed dotnet; record and prove actual CLI SDK, compiler DLL/version/hash and installed runtime selection. Fail unknown/mismatched selection; do not disable analyzers/CET or edit original props/shim.

Root explicitly permits public NuGet dependency restore ONLY in this ephemeral GitHub job: own config clears all inherited sources, only https://api.nuget.org/v3/index.json, original4pinned direct packages and required transitive/framework assets. No SDK/workload/model/global tool download, credentials/private feeds or real data. Run original unit csproj restore then dotnet test --no-restore with exact FullyQualifiedName~EnginePathPolicyTests filter and TRX in own results; no solution/IntegrationTests/host/Web/media.

verifyPathPolicyTrx(xml) must securely reject DTD/custom/external/undeclared entities and malformed/ambiguous XML; correctly parse predefined XML and numeric character escapes in normal parameterized test names and require one complete summary: total=executed=passed=43; zero failures/errors/skip/notExecuted/inconclusive/aborted/timeout/inProgress/pending;43 unique valid results all Passed, expected original class and both genuine symbolic:true case names present. Reject duplicate/missing names/IDs, mismatched counters, zero/truncated plans and wrong class. Do not accept only process exit0 or file existence. XML parsing may use a minimal strict generated-TRX subset, but no permissive general XML regex acceptance.

Before execution pin C# canonical Git blobs d8a49daab3d30260f2de29a4fb266bfd37fff501681aac55e232bf54b90107ac /89dbaf2d6b71c0d4dad1077715f8393872b23838117d92ffa68caf46bf50cef5 and verify current file text differs at most CRLF. Record candidate commit and source hashes. Output only sanitized fixed summary, versions/hashes/test names/counters/exit codes; no raw env/config/TRX/error bodies or private logs. Keep local job logs/results in own scratch; no artifact/cache upload. If symlink privilege/SDK missing, fail and keep ENVblocked; no security-policy tweaks/substitution.

- [ ] TDD parser/context tests: valid43 and required methods; all invalid/counter/capability/unknown-context groups in rev7 fail first, then implement.
- [ ] Pure local Node tests and syntax/diff; import has no side effect; never run CI entry/local dotnet or trigger/push by author.
- [ ] Independent exact3file spec/quality review and root checks. Root alone audits every unpublished blob/history and verified public target before publishing approved source to named topic; no release/dev/main changes.
- [ ] Actual Windows CI on exact published commit: validate actual runner/SDK/compiler and43/43 no skip, then record real run URL and sanitized result. Parser selftests are not remote evidence. Even passing only proves pure path subset, not host wiring/media/fullT05/PG.

## Preflight / handoff
Access writes E2 native2files, no network/ports; CI writes E3 root3files, no local .NET. CPU shared, directory leases disjoint; root lock/workspace/07 single-writer, not part of either source card. CI card checks active access card, not a circular hash reference. Reuse managed worktrees by fast-forward from verified dev lineage plus declared42b5230 assembly and reviewed immutable cards; no manual worktree tools. Apply consumer proof scope only after independent review, commit approved cards, then run trusted external N5a84 separately for each exact tree/head before dispatch. No full T01/T02/T05 or pilot lifecycle is marked complete.
