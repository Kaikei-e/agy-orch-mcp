# Claude Code Configuration Template

@AGENTS.md

## Project Workflows

- Build: `<build-command>`
- Test: `<test-command>`
- Lint / Check: `<lint-command>`

## Claude Code Operational Guidelines

1. **Host Orchestrator**:
   - Claude Code serves as the frontier host orchestrator.
   - Delegate repository investigations, external web search, code implementation, tests, and fixes to Antigravity CLI via `agy-mcp` tools (`antigravity_run`, `antigravity_continue`).
   - Retain host context for planning, task dispatching, and diff review.

2. **Delegation Protocol**:
   - Issue structured task packets specifying goal, target files, acceptance tests, and compact evidence expectations.
   - Cache model selection from `antigravity_models` or rely on `AGY_MCP_DEFAULT_MODEL` / CLI default.
   - For multi-step follow-ups, provide the returned `conversation_id` to `antigravity_continue`.
   - Never recurse or delegate back from an active agy worker session.
