# Historical usage baseline (superseded)

This baseline is retained for audit. [Complexity-based effort pricing](triage-effort-pricing.md) is the active model.

Effort now uses measured prior delivery runs. The previous token-per-work-unit constants have been removed.

## Formula

For each eligible historical run, let `y_i` be its observed direct-agent output tokens. Input tokens include repeated cached context and do not determine effort.

```text
S(request) = verified earlier runs selected by the validated retrieval method
y_hat      = median(y_i for i in S)
budget     = [Q10(y_i in S), Q90(y_i in S)]
trivial    = y_hat <= Q1/3(all eligible y)
deep       = y_hat >= Q2/3(all eligible y)
bau        = otherwise, or when both cutoffs coincide
```

Input, output, and total token budgets use separate empirical medians and sample ranges. Their medians do not necessarily add. The label terciles are an explicit relative-size policy. They do not prove human effort, business priority, or whole-issue cost.

SQLite FTS5 supplies BM25 lexical matching against original requests. Candidate methods use three or five matches from different thread groups. Expanding-window tuning chooses a method only when it improves generated-token multiplicative error over the global median. The newest 20% of complete thread groups remain untouched until evaluation. A group must finish before a target group starts. A minimum of 15 groups and five tuning cases is an explicit conservative selection gate, not a fitted coefficient.

Sparse or unhelpful matches use the all-history median. That fallback deliberately makes no claim that different issues have different estimated workloads.

## Initial evidence: 2026-10-18

The extractor inspected 345 ledger rows and 330 completed request/result segments. It retained 26 verified completed delivery runs across 13 thread groups, dated 2026-10-16 through 2026-10-18. Seventeen runs used Codex; nine used Claude. Only direct-agent usage is established.

| Quantity | Observed value |
| --- | ---: |
| Generated-token median | 6,373 |
| Generated-token P10–P90 | 2,010–21,130 |
| Input-token median, including cache reads once | 2,112,106 |
| Input-token P10–P90 | 454,838–6,367,028 |
| Relative Trivial cutoff | ≤4,287 output tokens |
| Relative Deep cutoff | ≥10,312 output tokens |
| Current method | Global median |
| Held-out runs / thread groups | 9 / 3 |
| Held-out output-token MAE | 8,438 |
| Held-out multiplicative error | 2.52× |
| Held-out sample-range hit rate | 4/9, or 44% |

This evidence supports a personalized historical baseline. It does **not** establish accurate issue-specific predictions. The observed P10–P90 range is descriptive; its held-out coverage was not 80%. Current forecasts therefore share the baseline until enough independent history supports a better method.

## Data quality and limits

Each retained run requires an exact accounting identity, a self-contained original request, a successful Git or RTK commit output, and a verified commit created within its availability interval. Realized changed files, added lines, assistant answers, and commit gaps are not prediction features.

Of the completed segments, exclusions included 134 without successful commit proof, 80 context-only requests, 37 commands or other non-task inputs, 34 without a unique accounting identity, 12 failed or incompletely measured runs, six with multiple requests, and one without a safe completion bound. Four thread logs were unavailable. Counts are separate checks at their respective grains, not a percentage of independent tasks.

Twenty-one retained runs had exact result timestamps. Four used the next user input as a conservative completion upper bound; one used idle-thread metadata. These bounds establish when a run was available for training. They never imply active runtime.

Selection favors successful, commit-backed delivery runs. Prior failed runs, unclear task boundaries, and unmeasured child agents prevent whole-issue totals. Tool retries inside a measured successful run remain included. Cross-provider token counts and changing context strategies add variation. No missing usage is imputed.

## Reproduction and refresh

```sh
bin/github-triage calibrate
npm run test:triage
```

The private dataset lives in `~/.config/agent-console/triage-history.json` with mode 0600. It contains source requests and provenance; it must never be committed or posted. Calibration prints aggregate diagnostics only. The production watchdog refreshes it every 24 hours, retaining the last valid dataset if extraction fails.

Each GitHub comment shows the selected method, source count, historical cutoffs, validation limits, and example source commit links. New evidence updates estimates through the same deterministic code. Priority and design remain documented policy decisions.
