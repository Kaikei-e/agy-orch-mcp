# Claude Code Instructions for agy-mcp

@AGENTS.md

## Overview & Architecture

`agy-mcp` is a Model Context Protocol (MCP) server providing a bridge from MCP clients to the Google Antigravity CLI (`agy`). It starts `agy` as a child process and returns structured execution results over stdio.

## Key Verification Commands

- Build: `pnpm build`
- Typecheck: `pnpm check`
- Test: `pnpm test`
- Format check: `pnpm format:check`
- Format fix: `pnpm exec prettier --write <files>`

## agy-first Operational Guardrails for Claude Code

1. **Frontier Orchestrator Role**:
   - Act as orchestrator, planner, and reviewer.
   - Delegate repo research, web searches, implementation, tests, and fixes to Antigravity CLI via `agy-mcp` tools (`antigravity_run`, `antigravity_continue`).
   - Avoid performing direct file editing or repetitive research when agy delegation is available.

2. **No Recursive Delegation**:
   - Tasks executed within an Antigravity session must proceed directly using native tools and MUST NOT recursively invoke `agy-mcp` or delegate back to the host.

3. **Task Packet Formulation**:
   - When delegating to agy, formulate structured task packets specifying: Goal, File Scope / Ownership, Constraints / Acceptance Criteria, and expected compact evidence (changed paths, test command outputs, relevant reference URLs).

4. **Bounded Recovery**:
   - Handle `BUSY` responses by waiting or serializing; avoid retry storms.
   - Inspect workspace side effects with `git status` after timeouts or empty responses before retrying.
   - On `PERMISSION_DENIED` or tool errors, report concrete blockers rather than silently shifting workload to the host.
