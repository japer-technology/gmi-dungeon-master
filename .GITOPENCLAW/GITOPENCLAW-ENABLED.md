# GitOpenClaw — Enabled ✅

This file is the **opt-in sentinel** for `.GITOPENCLAW` workflows.

## How it works

- **Present** → all `.GITOPENCLAW` workflows are allowed to run.
- **Absent** → all `.GITOPENCLAW` workflows are blocked at the "Guard" step.

The guard logic lives in `lifecycle/GITOPENCLAW-ENABLED.ts`, which runs as the
very first step of every workflow and calls `process.exit(1)` when this file is
missing. This fail-closed design guarantees that GitOpenClaw never activates
by accident on a fresh clone.

## Quick toggle

| Action | Command |
|---|---|
| **Disable** | `git rm .GITOPENCLAW/GITOPENCLAW-ENABLED.md && git commit -m "disable gitopenclaw" && git push` |
| **Re-enable** | Restore this file and push |
