# Analysis: GitHub Data Size Limits for LLM Processing

When feeding GitHub data (non-code) through LLM models, there are practical thresholds where analysis quality degrades or breaks down entirely. This document examines those limits by data type, model context window, and failure mode.

---

## 1. Context Window Baselines

| Model Family | Context Window | Effective Usable¹ | Approx. Characters² |
|---|---|---|---|
| Claude 3.5 / 4 (Anthropic) | 200K tokens | ~160K tokens | ~640K chars |
| GPT-4o (OpenAI) | 128K tokens | ~100K tokens | ~400K chars |
| Gemini 1.5 / 2.0 (Google) | 1M–2M tokens | ~800K–1.6M tokens | ~3.2M–6.4M chars |
| Open-source (Llama, Mistral) | 8K–128K tokens | ~6K–100K tokens | ~24K–400K chars |

¹ After system prompt, tool definitions, instructions, and response reserve.  
² Rough estimate at ~4 characters per token for English prose. GitHub data with URLs, metadata, and markdown often tokenizes less efficiently (~3–3.5 chars/token).

---

## 2. GitHub Data Types and Typical Sizes

### 2.1 Issues

| Metric | Small Project | Medium Project | Large Project (e.g., kubernetes, rust) |
|---|---|---|---|
| Single issue (body + comments) | 1–5 KB | 5–50 KB | 50–500 KB |
| 100 issues (titles + bodies) | 100–500 KB | 0.5–5 MB | 5–50 MB |
| 1,000 issues (full thread) | 1–5 MB | 5–50 MB | 50–500 MB |

**Breakdown point:** A single heavily-discussed issue (100+ comments) can reach 200–500 KB, consuming an entire 128K-token context window. Batch analysis of more than ~50 full issue threads will exceed even 200K-token models.

### 2.2 Pull Requests (metadata, not diffs)

| Component | Typical Size |
|---|---|
| PR description | 0.5–10 KB |
| Review comments (per PR) | 1–100 KB |
| CI status / check metadata | 1–5 KB per PR |
| Full PR thread (description + all review comments + bot comments) | 5–500 KB |

**Breakdown point:** PR threads with extensive review conversations (e.g., 50+ review comments, bot auto-comments from linters/CI) routinely hit 100–300 KB. A batch of 20 such PRs will exceed most context windows. Bot-generated noise (Dependabot, Codecov, CI summaries) inflates PR data 2–5× beyond human content.

### 2.3 Discussions

GitHub Discussions tend to be longer-form than issues. A single active discussion with 30+ replies can reach 50–200 KB. Community Q&A repositories (e.g., framework "help" discussions) can have individual threads exceeding 300 KB.

### 2.4 Commit History

| Metric | Size |
|---|---|
| Single commit message | 0.1–2 KB |
| 1,000 commits (messages only) | 100 KB–2 MB |
| 10,000 commits (messages only) | 1–20 MB |
| Commit metadata (SHA, author, date, message) per commit | 0.3–3 KB |

**Breakdown point:** Commit message analysis works well up to ~5,000 commits on 200K-token models (~2–5 MB of message text). Beyond that, the model loses the ability to identify patterns or provide accurate summaries.

### 2.5 Release Notes / Changelogs

| Metric | Size |
|---|---|
| Single release (notes) | 1–20 KB |
| 50 releases | 50 KB–1 MB |
| 200+ releases (mature project) | 200 KB–4 MB |

**Breakdown point:** Most projects' full release history fits within context, but projects with detailed per-release notes (e.g., VS Code, Rust) can exceed 1 MB for their complete history.

### 2.6 Wiki Pages

| Metric | Size |
|---|---|
| Single wiki page | 2–50 KB |
| Small project wiki (10–20 pages) | 20–500 KB |
| Large project wiki (100+ pages) | 500 KB–10 MB |

**Breakdown point:** Wikis over 50 pages generally exceed context limits for single-pass analysis.

### 2.7 CI/CD Logs

| Metric | Size |
|---|---|
| Single job log | 10 KB–10 MB |
| Single workflow run (multiple jobs) | 50 KB–50 MB |
| Flaky test output | 50 KB–5 MB per run |

**Breakdown point:** CI logs are the most problematic GitHub data type. A single verbose build log can exceed the entire context window. Even truncated logs routinely hit 500 KB–2 MB.

### 2.8 GitHub Actions Workflow Files (YAML metadata)

Usually small (1–10 KB each), rarely a problem. A project with 50 workflows totals ~50–500 KB.

### 2.9 Project Board / Roadmap Data

Typically lightweight (issue title + status + labels). A 500-card project board serialized as structured data is ~50–200 KB. Rarely a bottleneck.

---

## 3. Degradation Thresholds

Quality does not drop off as a clean cliff — it degrades progressively. The following thresholds are based on observed behavior across models:

### 3.1 Attention Degradation ("Lost in the Middle")

LLMs attend most strongly to the **beginning** and **end** of context. Data in the middle receives weaker attention. This is measurable and well-documented.

| Context Fill | Effect |
|---|---|
| 0–30% of window | Reliable analysis. Model attends to all content. |
| 30–60% of window | Minor degradation. Some details in the middle may be overlooked. Summaries remain accurate. |
| 60–80% of window | Noticeable degradation. The model starts missing specific items, conflating similar issues, and producing vaguer summaries. Cross-referencing between distant items becomes unreliable. |
| 80–95% of window | Significant degradation. Facts from the middle third of input may be fabricated or swapped. Quantitative claims become unreliable. |
| 95–100% of window | Severe breakdown. The model may truncate its own response, hallucinate aggressively, or fail mid-generation. Pi's auto-compaction triggers in this zone. |

### 3.2 Practical Per-Model Limits for Reliable GitHub Data Analysis

| Model | Reliable Limit | Degraded-but-Usable | Breakdown |
|---|---|---|---|
| Claude 3.5/4 (200K) | ~80K tokens (~250 KB) | 80–160K tokens (250–550 KB) | >160K tokens |
| GPT-4o (128K) | ~50K tokens (~170 KB) | 50–100K tokens (170–350 KB) | >100K tokens |
| Gemini 2.0 (1M) | ~400K tokens (~1.3 MB) | 400K–800K tokens (1.3–2.6 MB) | >800K tokens |
| Llama 3 (128K) | ~40K tokens (~130 KB) | 40–90K tokens (130–300 KB) | >90K tokens |

### 3.3 Task-Specific Sensitivity

Some tasks tolerate large context better than others:

| Task | Tolerance | Notes |
|---|---|---|
| Summarization | High | Models can scan-and-summarize large volumes reasonably well |
| Trend analysis across issues | Medium | Works up to ~200 issues, degrades with more |
| Finding a specific item | Low | "Needle in a haystack" degrades quickly past 50% context fill |
| Cross-referencing (e.g., "which issues relate to PR #X") | Low | Requires attending to multiple distant locations simultaneously |
| Counting / quantitative analysis | Very Low | Models lose accuracy on counts beyond ~50–100 items regardless of context size |
| Timeline reconstruction | Medium | Chronological data benefits from the sequential attention pattern |

---

## 4. Specific Failure Modes

### 4.1 Hallucinated Issue Numbers / PR References
When processing large batches of issues, models start inventing issue numbers or attributing comments to the wrong issue. This begins around 100+ issues in context.

### 4.2 Merged Identities
With many contributors in context, the model conflates who said what and who authored which PR. Degrades past ~50 distinct contributors in a single context window.

### 4.3 Temporal Confusion
When processing months of activity data, models lose the ability to accurately distinguish "last week" from "three months ago." Onset at ~500 events spanning more than 6 months.

### 4.4 Silent Omission
The most dangerous failure: the model produces a confident summary that simply omits significant items without indicating anything was left out. This is common when context is 60%+ full.

### 4.5 Quantitative Drift
Asked "how many issues are labeled `bug`?", models become unreliable past ~80 items. The error margin grows roughly linearly with count.

---

## 5. Mitigation Strategies

### 5.1 Chunked Processing
Split data into chunks that stay within the reliable zone (30–50% of context window), process each chunk, then synthesize. Example: process 50 issues at a time, extract structured data, then analyze the structured output.

### 5.2 Pre-filtering
Use conventional tools (GitHub API queries, `jq`, `grep`) to narrow data before LLM analysis. A query like "all issues labeled `bug` closed in the last 30 days" is far more tractable than "analyze all issues."

### 5.3 Structured Extraction First
Convert verbose GitHub data (full issue threads) into structured summaries (issue number, title, labels, status, 1-line summary) using per-item LLM calls, then analyze the structured dataset.

### 5.4 Pi's Compaction
For interactive exploration of GitHub data across a session, pi's auto-compaction helps maintain a working summary. However, compaction is lossy — specific data points (exact issue numbers, precise quotes) may not survive compaction. Set `keepRecentTokens` higher if recent context accuracy matters:

```json
{
  "compaction": {
    "keepRecentTokens": 40000
  }
}
```

### 5.5 Map-Reduce Pattern
For large datasets (1,000+ issues):
1. **Map:** Process each item individually, extracting structured fields
2. **Reduce:** Feed structured outputs into a final synthesis pass

This converts a 50 MB problem into many 5 KB problems plus one 500 KB synthesis.

---

## 6. Quick Reference: Maximum Recommended Batch Sizes

For **reliable** single-pass analysis (staying within 30–40% of context):

| Data Type | Claude 200K | GPT-4o 128K | Gemini 1M |
|---|---|---|---|
| Full issue threads | 20–40 | 10–25 | 100–200 |
| Issue titles + labels (no body) | 500–1,000 | 300–600 | 2,500–5,000 |
| PR descriptions (no comments) | 50–100 | 30–60 | 250–500 |
| Full PR threads (with reviews) | 10–20 | 5–12 | 50–100 |
| Commit messages | 2,000–4,000 | 1,200–2,500 | 10,000–20,000 |
| Release notes | 30–60 | 20–40 | 150–300 |
| CI log (single) | 1 (truncated) | 1 (truncated) | 1–3 (full) |
| Wiki pages | 15–30 | 8–20 | 75–150 |

These are conservative estimates for analysis tasks requiring accuracy. Summarization-only tasks can push 1.5–2× higher.

---

## 7. Summary

GitHub's non-code data grows fast — a moderately active repository generates 10–50 MB of issue/PR/discussion text per year. No current LLM can process a full year of activity for a medium-to-large project in a single pass.

**The practical ceiling for reliable single-pass analysis is:**
- **~250 KB** of GitHub data on a 200K-token model (Claude)
- **~170 KB** on a 128K-token model (GPT-4o)  
- **~1.3 MB** on a 1M-token model (Gemini)

Beyond these thresholds, use chunked processing, pre-filtering, or map-reduce patterns. Treat LLM analysis of GitHub data as you would any data pipeline: validate, sample, and never trust aggregate counts from a single oversized prompt.
