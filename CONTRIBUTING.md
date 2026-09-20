# Contributing to agy-orch-mcp

Thanks for improving the project. Small, focused pull requests are easiest to review.

## Before opening a pull request

1. Open an issue first for a substantial behavior or API change so the intended contract can be discussed.
2. Use Node.js 22 or newer and the pnpm version pinned in `package.json`.
3. Install dependencies with `pnpm install --frozen-lockfile`.
4. Keep each change scoped and include tests when behavior changes.
5. Run the relevant checks:

   ```bash
   pnpm check
   pnpm test
   pnpm format:check
   ```

`pnpm test` builds the TypeScript output before running the Node test suite. Use `pnpm format` only when you intend to apply formatting changes.

## Development notes

- Preserve the stdio protocol: stdout is reserved for MCP JSON-RPC. Use stderr for diagnostics.
- Treat prompts and returned agent output as untrusted data.
- The bridge bounds concurrent CLI processes with `AGY_MCP_MAX_CONCURRENT`. Preserve per-call output, progress, cancellation, and deadlines; same-ID continuations must not overlap, and implicit latest-conversation continuation must remain exclusive. Locks apply only within one server; workspace files and external CLI state are shared. Cover parallel execution and shutdown with subprocess and MCP integration tests.
- Workspace validation is a selection boundary, not an OS sandbox. Avoid describing it as filesystem or network confinement.
- Keep public documentation in English and Japanese when a user-visible behavior changes.

Run `pnpm run doctor` to check a local `agy` installation without starting a model turn. `pnpm run probe` is a live integration check: it may consume quota and create a conversation, so it is optional and should not be used as a routine unit test.

## Commit and review expectations

Describe the user-visible change, mention any security or compatibility implication, and state which checks you ran. Do not commit credentials, local workspace paths, conversation IDs, or generated archives. See [SECURITY.md](SECURITY.md) for sensitive reports.

By submitting a contribution, you agree that it is licensed under the repository's [Apache License 2.0](LICENSE).
