# ADR 0011 — Tree-sitter runtime, grammar ABI, and WASM packaging (P3-00 spike)

## Status

Accepted (P3-00 spike).

## Context

Phase 3 needs `web-tree-sitter` plus TypeScript/TSX/JavaScript WASM grammars that
work under pinned Bun 1.3.13 on Ubuntu, macOS, and Windows, including a
`bun build --compile` executable run from an unrelated working directory.
No runtime download or grammar compile is allowed; `src/diff` stays untouched
and no `src/context` runtime exists yet.

Verified in this spike on Windows with `bun run` and a compiled executable;
parsing is covered on all three OSes by `tests/unit/tree-sitter-spike.test.ts`
via the existing 3-OS `bun test` CI matrix.

## Decision

- Runtime: `web-tree-sitter@0.25.10` exact (MIT, `bun.lock`
  `sha512-Y09sF44/13XvgVKgO2cNDw5rGk6s26MgoZPXLESvMXeefBf7i6/73eFurre0IsTW6E14Y0ArIzhUMmjoc7xyzA==`).
  After `Parser.init`, `LANGUAGE_VERSION=15`, `MIN_COMPATIBLE_VERSION=13`.
- Grammars: `@vscode/tree-sitter-wasm@0.3.1` exact (MIT, `bun.lock`
  `sha512-RJFoomET6FajjG511fmQxeBQfU6M24a0aFZPqpid+ttIxanWf1VGytBG0UmsGjt07qmIPJS8U31D+aecuCucsQ==`),
  built with `tree-sitter-cli@0.25.10` from `tree-sitter-typescript@0.23.2`
  (typescript + tsx) and `tree-sitter-javascript@0.25.0`. Grammar licenses are
  MIT; wrapper is MIT (Microsoft VS Code team).
- Pinned WASM SHA256 (installed bytes): runtime `tree-sitter.wasm`
  `F38DCC4B43B818F9A0785BC1C6D5611A75AC4CDD428FF3F02757C34CA4E46D7F`,
  `tree-sitter-typescript.wasm` `778025DB5A8BE0E70F8CCC3671E486DFEDDD048C25D9E8A70C26DE2E1BF6F97D`,
  `tree-sitter-tsx.wasm` `79E5DA75EA62855A0CD67177685F0164EAC87D5F630B3CBE1E0A099751AD30F8`,
  `tree-sitter-javascript.wasm` `5FB488D0CABB4775A594BAB85682DE5AD6CE83C0D6AC997A9F82DD084D571240`.
- ABI: typescript/tsx ABI 14, javascript ABI 15, all within runtime `[13, 15]`.
  Verified `Language.load(bytes)` succeeds and a known `function_declaration`
  (`jsx_element` for TSX) parses with `hasError=false`.
- Loading (both `bun run` and compiled exe, no `process.cwd()`, no network):
  `import path from "<pkg>/<file>.wasm" with { type: "file" }`,
  `Bun.file(path).bytes()`, `Parser.init({ wasmBinary })` once per process,
  then `Language.load(bytes)` per grammar. Grammar bytes are passed directly;
  no grammar compile or download occurs at runtime.
- Lifecycle pinned for P3-01: `Parser.init(moduleOptions?)`, `Language.load`
  accepts `Uint8Array`, `parse` returns `Tree | null` (null on cancelled/failed
  parse), `reset()` before reuse after cancellation, `dispose` via
  `delete()` on parser/tree/query/cursor. `setTimeoutMicros` is deprecated
  since 0.25.0 — P3-01 must use `parse` `progressCallback` + `QueryOptions`
  `timeoutMicros`/`progressCallback`; note `ParseOptions.progressCallback` is
  typed `(state) => void` in 0.25.10 while `ProgressCallback` is
  `(progress) => boolean`, so P3-01 must empirically verify cancellation
  rather than assuming the return-value contract.
- Compiled distribution is supported now (not deferred): `bun build --compile`
  embeds the four WASMs via `with { type: "file" }` into the Bun virtual FS
  (`B:/~BUN/root/*.wasm` on Windows); the exe loads them through
  `Bun.file(embeddedPath)` and parses identically when run from an unrelated
  cwd outside the repo and build directory. No adjacent-asset layout is needed.
- Normal packaging: WASMs ship via the two pinned npm packages
  (`bun install --frozen-lockfile` suffices); nothing under `scripts/` or
  `node_modules` is excluded by `.gitignore`, and `scripts/**/*.ts` is
  typechecked. Rejected alternatives: `tree-sitter-wasms`/`@repomix`
  (Unlicense wrapper) and `tree-sitter-wasm@2.0.4` (120 MB unpacked, CLI 0.27
  newer than runtime line) — both parsed, but MIT + CLI-match + smaller
  2.1 MB package favored `@vscode`.

## Consequences

- `scripts/tree-sitter-spike.ts` is the reproducible spike (embedded assets,
  deterministic samples); `tests/unit/tree-sitter-spike.test.ts` locks
  versions, ABIs, known nodes, and determinism on all three CI OSes.
- P3-01 builds the real parser runtime on these pins, adds time-budget
  enforcement with empirically verified cancellation, and must not change
  `src/diff`, shared contracts, or the `NOT_IMPLEMENTED` review stub.
- If grammar or runtime versions change, update this ADR, the SHA pins, the
  spike, and the test together.
