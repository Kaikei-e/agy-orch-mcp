# Claude Code Instructions for agy-orch-mcp

@AGENTS.md

## Overview & Architecture

`agy-orch-mcp` is a Model Context Protocol (MCP) server providing a bridge from MCP clients to the Google Antigravity CLI (`agy`). It starts `agy` as a child process and returns structured execution results over stdio.

## Key Verification Commands

- Build: `pnpm build`
- Install guard (once): `node dist/index.js --install-guard`
- Doctor / audit: `pnpm run doctor`
- Typecheck: `pnpm check`
- Test: `pnpm test`
- Format check: `pnpm format:check`
- Format fix: `pnpm exec prettier --write <files>`

## agy-first Operational Guardrails for Claude Code

1. **Frontier Orchestrator Role**:
   - Act as orchestrator, planner, and reviewer.
   - Delegate repo research, web searches, implementation, tests, and fixes to Antigravity CLI via `agy-orch-mcp` tools (`antigravity_run`, `antigravity_continue`, `antigravity_batch`).
   - Avoid performing direct file editing or repetitive research when agy delegation is available.
   - Review `verified_outputs` (the machine-extracted `run_command` ledger) and `git diff` rather than trusting commands quoted in the model's prose Evidence.

2. **No Recursive Delegation**:
   - Tasks executed within an Antigravity session must proceed directly using native tools and MUST NOT recursively invoke `agy-orch-mcp` or delegate back to the host.

3. **Task Packet Formulation & 15-Minute Turn Cap**:
   - Plan tasks as `<= 15`-minute resumable turns (`timeout_seconds` default and max `900`).
   - Install the command guard once (`agy-orch-mcp --install-guard`). Because the guard returns actionable hints when denying shell constructs, packets no longer need long lists of forbidden shell characters—keep only the "one simple command per call" advice.
   - Formulate concise task packets specifying Goal, File Scope / Ownership, Constraints / Acceptance Criteria, and expected compact handoff (or set `return_mode: "structured"` for a parsed `handoff`).
   - Emit multiple `antigravity_run` or distinct-ID `antigravity_continue` calls in one message to run in parallel (`readOnlyHint: true`); relay subagents are unnecessary (rebuild `dist` after upgrading so the running server advertises the annotation). Note that Claude Code moves MCP calls running longer than 2 minutes to the background automatically (`CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS`).

4. **Bounded Recovery**:
   - On `TIMEOUT` (`resumable: true`), continue the same conversation with `antigravity_continue` using the reported `conversation_id`, `partial_response`, `verified_outputs`, `workspace_changes`, and `terminated_tasks`.
   - Use `queue_timeout_seconds` (`0`–`900`) to wait in the FIFO queue with position progress instead of failing with `BUSY`, or serialize calls; avoid retry storms.
   - Inspect `workspace_changes` (`git status`) and `partial_response` after `EMPTY_RESPONSE` before retrying.
   - On `PERMISSION_DENIED` or tool errors, check `denied_commands` and either continue with a named permitted alternative or report concrete blockers rather than silently shifting workload to the host.
