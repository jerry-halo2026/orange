# Native Worker CI fidelity and safe failure evidence

## Authority and intent
Root engineering choice inside Ethan's approved native verification scope; no change to product/trial scope or new external allocation. The actual 1bbc runtime28 failed first at worker-tests/TAP_INVALID. Raw Worker TAP/process receipts stayed on runner, so the first failing test/exit status/current Node version remain unknown. Both existing local Node26.13 and24.22 each ran the unchanged33+18 actual tests with exit0/51pass and18actualWorkerexits/final0; both real TAPs are nevertheless rejected by current Worker verifier with TAP_NAME.

## Approaches and ruling
1. Rename/drop original cases, relax ASCII/count/timeout/threshold broadly, or rerun unchanged: rejected; these mask native semantics and do not diagnose actual failure.
2. Preserve original native tests; allow only the exact existing non-ASCII native name, continuously exercise all actual frozen51 names in dependency-free unit fixtures, and emit one bounded safe Worker-stage evidence record on genuine CLI failure: chosen. This repairs a verified consumer contract and makes the still-unknown failure diagnosable.
3. Download another runtime or execute local fake CI/main: not needed/allowed in this package. Local24/26 cannot prove hosted22 cause.

## Exact write boundary
Only scripts/native-studio-ci.mjs and scripts/native-studio-ci.test.mjs. Existing Native110/Worker51/TAP/evidence/context/package/archive/tool/ports/source snapshot/environment/timeout rules and workflow remain unchanged. Preserve every existing300 pure testcase/negative assertion. No original native module or test changes.

## Native-name fidelity
The existing test name is exactly:
`the store: an undo is a write like any other: 1 → 4 → 6, undone to 4, an older copy with 1 gets 4`
Only this immutable native literal may be added alongside current printable-ASCII bounded names; do not allow arbitrary Unicode, normalization/lookalikes/control/newline or unknown native names. Native51 cardinality, uniqueness, mandatory names and exact18 exits/max4/final0 remain strict.
Add dependency-free source-grounded tests covering all51 actual names, not only worker-case placeholders. Safe literal extraction from these two pinned test files must reject unsupported/nonliteral forms, or use reviewed literal-name fixtures checked against source. Do not eval/import/execute native test modules, add TypeScript or any package. Source-derived test fixtures are synthetic verification, not new actual51 execution. Separately feed both already-captured real local51 TAPs through the new verifier without rerunning them.

## Safe failure evidence
Keep the existing three-field first-error diagnostic contract and its private identity branding. Add a separately tagged bounded evidence record to the real CLI failure path only after Worker stage actually acquired a process result. It must survive inner assessment, first-failure capture, later post-check errors and outer error wrapping; never use module-global last-result state. No new execution/registration capability, fake CI switch, options/env forwarding or diagnostic data from foreign error properties.
Allowed fields only: actual process.version (validated format); owned child integer/null exit status plus Boolean process-error/signal; stdout/stderr whole-file SHA256; bounded numeric/nullable observed TAP plan/counters/first failing ordinal; only fixed known fixture file names plus bounded source line/column, or fixed allowlisted Node test error/failure-type enum when safely extracted. Missing/malformed/duplicate data stays null/unknown, not fabricated. Observed counters are not a success verdict. Unknown names/messages/value hashes must not become a secret-carrying diagnostic channel.
Native110 evidence is allowed only from the already validated actual Native result and its completed checks, never from caller-supplied claims. Distinguish Worker post-check passed/failed/unknown, preserving first diagnostic. Raw TAP/stderr, environment, argv, arbitrary test/error text/stack/path/URL/value/hash, private directories and foreign .message/.code/.stack/getters/toJSON are never emitted. Whole-output provenance digests are allowed; raw outputs stay private on runner. No artifacts/cache/upload step.
The evaluation→first-failure capture→outer wrapping→CLI-safe formatter bridge must be pure-unit testable without running production CLI/tool pipeline. Test forged/foreign errors, getters/toJSON, stale/cross-error/cross-run evidence, invalid UTF8/BOM/CR, overlong input, duplicate/bad counters/records, injected secret text and subsequent post-check failures. Prove allowed scalars survive but secret strings and properties never leak. Existing300 tests keep their meaning and assertions; no changes merely to make green.

## TDD and acceptance
- Save exact two before files. Add native-name source-grounded regression and run real RED on existing verifier before minimal closed fix.
- Add behavior RED for missing safe observation through an existing failure assessment/bridge, not just missing-import errors; then minimal branded implementation.
- Full pure300+new tests, syntax2/diff checks, all37 raw inputs+2proof unchanged. Use existing private real51 TAP fixtures as read-only data, label origin; don't print/commit them.
- Non-author SPEC/QUALITY, Root independent tests, safe bridge/realTAP checks, post/exact N5a before source commit. Source readiness does not fix the unknown hosted test failure or authorize a new job; a fresh runtime lease is required later.
