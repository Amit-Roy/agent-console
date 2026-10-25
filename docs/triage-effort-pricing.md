# Session effort pricing

The input is the initial user message, or consecutive initial user messages before the first agent response. The outputs are recorded totals for the entire inactive session, including later follow-ups, retries, and measured failures. Later conversation, assistant plans, tools, commits, and realized usage never enter the input features.

The previous delivery-run model selected only commit-backed turns. Its 26-run cohort and four held-out runs did not represent the requested session-level problem. That selection is superseded.

## Dataset and identity

The collector inventories Console threads and retained native Claude, Codex, and Pi transcripts. A transcript file is not necessarily an independent user session. Child sessions attach to their traceable parent. Backend resumptions within one Console session share an identity. A native transcript and its Console accounting mirror are never added together.

Complete native records take precedence when they cover the linked session. Complete Console accounting is a fallback when native coverage is missing. Unknown token usage remains unknown, never zero. Active sessions are excluded from training. Historical errors and zero-tool conversations remain valid when their actual usage is recorded.

Only user sessions train the model. A native transcript with no Console thread is kept only when its origin is interactive (Claude `entrypoint` `cli`, Codex `originator` `codex-tui`; Pi has no origin field) and its working directory is not under `/tmp`, `~/scratch*` or `~/worktrees`. Console quota window openers (title `Window opener`, one-word probe) are excluded and unlinked, so their native transcripts fall to the same origin rule. The filter reads origin only, never outcome. The audit counts `exclusions.nonUserOrigin` and `quotaWindowOpener`. On 2026-10-25 this removed 306 probe rows (SDK smoke tests, A/B trials, `Reply with the single word: ok`) and left 307 sessions. Probes had taught the trees that a short request means a tiny session, so length dominated the quote.

The private audit records discovered files, roots, children, duplicate identities, accounting coverage, excluded sessions, privacy refusals, feature failures, temporal purges, and final train/test counts. A session is an observed snapshot: resuming it can change its eventual total. Child usage without a reliable identity or counter is not invented.

## Learned equation

The small model extracts four evidence-backed initial-request features: breadth, behavior complexity, uncertainty, and risk. Each is an ordinal value from 0 to 3, or unknown. An exact quote must support every known value. Request length and token consumption do not define task complexity. Initial request text is bounded to 12,000 characters, with truncation recorded in provenance.

The supervised target is total recorded session tokens: input plus generated output. Cached input is included once in input. Tool counts are optional diagnostics and do not determine sample eligibility or the fitted target.

The offline fit learns nonnegative complexity weights:

```text
z(x) = intercept + Σ beta[j] * feature[j] / scale[j]
                 + Σ missingBeta[j] * isUnknown[j]
predicted total tokens = max(0, exp(z(x)) - 1)
```

Training-only medians fill unknown feature values. Missingness has separate coefficients. Regularization uses strictly older completed groups. Increasing a known feature cannot reduce predicted usage. Raw token usage is the output target, never an input feature.

Chronological out-of-fold residuals generate paired scenarios:

```text
r_i = log1p(observed_total_tokens_i) - log1p(out_of_fold_prediction_i)
scenario_total_i(x) = max(0, exp(z(x) + r_i) - 1)
scenario_output_i(x) = scenario_total_i(x) * observed_output_i / observed_total_i
scenario_input_i(x) = scenario_total_i(x) * observed_input_i / observed_total_i
```

Explicit zero-total observations retain an empirical point mass at zero instead of dividing by zero. Their usage still trains the regression. Other scenarios preserve paired input/output shares that sum to one. Cache/fresh shares are optional; unknown cache splits do not erase known input totals. Grand-total quantiles use paired input-plus-output scenarios, not sums of marginal quantiles.

The triage effort label follows the level of design (none: Trivial, light: BAU, detailed: Deep), not these tokens. The quote's own tier (training-session terciles) is a rough guide only. Predicted session tokens reflect usage, not human hours or pure implementation difficulty. Provider behavior, cached replay, follow-ups, and later scope changes influence the measured outcome. The initial request supplies the complexity evidence; the model learns its relationship to whole-session usage.

## Request-shape features

Most initial requests are short: the median is 90 characters. In the audited cohort the small model could extract breadth, complexity, uncertainty, and risk for only 14 of 120 training sessions, so the fit had almost nothing to learn from. The fitter now also uses four deterministic buckets (0–3) computed from the request text. They are always known and never come from a model call:

| Feature | Buckets |
| --- | --- |
| `requestSize` | characters: <20, 20–119, 120–399, 400+ |
| `requestLines` | non-blank lines: 1, 2–3, 4–7, 8+ |
| `requestReferences` | URLs, file paths, and inline code spans: 0, 1, 2–3, 4+ |
| `requestActions` | action verbs such as fix, add, deploy, audit: 0, 1, 2–3, 4+ |

Weights stay nonnegative, so a longer or more structured request never prices lower. A dataset without these fields still fits the original four features, and four-feature artifacts remain valid.

Estimator selection also changed. Session totals span five orders of magnitude, so raw-token MAE on 34 sessions is decided by a few extreme sessions. The fit minimizes log error, so selection now compares RMSLE against the training-median baseline. MAE stays in the report.

When the model includes request-shape features, unknown model-extracted metrics no longer force the P95 routing policy. The out-of-fold residuals already contain the usual share of unknown metrics. Unknown shape features or extrapolation still select P95. Four-feature artifacts keep the original policy.

## Uncertainty and validation

Quotes show P50, P80, and P95 model scenarios. The planning reserve is P80 total tokens minus P50 total tokens; generated-token reserve is also shown. Unknown or extrapolated scope prices the quote tier and the recommended budget through P95 by policy. Complete, in-range scope uses P50 and recommends P80. Neither sets the label.

Every session scenario is capped at the largest total in the training split, recorded as `workloadCeiling`. A residual tail multiplied by a predicted median can otherwise price more usage than any session ever measured, and the missing-structure interpolation then turns that surplus into an absurd recommended budget. The cap applies to token channels together through the paired shares, so input plus generated output still equals the capped total. Legacy actions artifacts keep no ceiling. A capped quote is a bound on the observed distribution, not a forecast of unseen work.

This resembles an uncertainty reserve in pricing. It is not an options-market valuation. Initial messages cannot fully explain later scope changes, so whole-session usage can have substantial unexplained variance. Percentile names do not establish completion probabilities.

Newest thread groups remain held out. Training outcomes must be available before a target request starts; forks and related sessions share groups. Validation reports total-token, generated-token, and input-token error against a median baseline, plus observed interval coverage. Counts are derived from the audited cohort, not fixed at four held-out cases.

The [aggregate report](triage-effort-report.json) records the reviewed frozen snapshot below. The private live report can change after daily calibration. Source requests and session identities remain private. The model stays experimental unless its held-out evidence meets the stated validation checks. A complexity candidate that fails to beat the training-median baseline on held-out total-token error serves the historical-session distribution instead. Candidate metrics and coefficients remain visible. This fallback is not task-specific, and the data that selected it are not an independent test of that selection.

## Audited snapshot: 2026-10-19

The frozen inventory contains 342 native transcript files: 177 roots and 165 child logs. Complete native snapshots contribute 153 sessions, including 112 traceable child logs. Nine Console accounting fallbacks bring the canonical cohort to 162 observed sessions in 159 related-session groups. Nineteen Console mirrors are not counted twice. One initial request was truncated at the 12,000-character limit.

Initial-request features were evaluated for 146 sessions. Twelve credential-suspect requests were not transmitted, and four requests lacked a valid model annotation. All 16 retain measured outcomes with unknown features. The fitter rejects none of the 162 complete outcomes. Sixty-three sessions have zero observed tool calls; six have explicitly measured zero usage.

The chronological split has 120 training sessions, 34 held-out sessions in 32 groups, and eight sessions purged because their outcomes overlapped the test start. The former four-case holdout is superseded.

The complexity candidate has total-token MAE 1,937,335,120, versus 6,997,939 for the training-median baseline. It fails the quality gate. The active estimator is the empirical historical-session baseline, with candidate coefficients and errors retained for inspection. It does not provide proven task-specific pricing.

The active distribution's held-out P80 hit rate is 35.3%; P95 is 88.2%. These intervals under-cover. Session usage changed substantially across the chronological split; the quoted percentiles are historical scenarios, not 80% or 95% completion guarantees. The test selected the fallback and is not an independent test of that selection.

## Operation and reproduction

The runtime loads a private Node artifact. Python runs only for offline fitting. The numerical implementation uses NumPy and [SciPy bounded least squares](https://docs.scipy.org/doc/scipy/reference/generated/scipy.optimize.lsq_linear.html).

```sh
uv venv --managed-python --python 3.13 ~/.local/share/agent-console/triage-venv
uv pip install --python ~/.local/share/agent-console/triage-venv/bin/python -r requirements-triage.txt
bin/github-triage calibrate
npm run test:triage
npm run test:effort-fit
```

`AGENT_CONSOLE_TRIAGE_PYTHON` selects the fitter. `AGENT_CONSOLE_TRIAGE_EFFORT_MODEL` selects the artifact, defaulting to `~/.config/agent-console/triage-effort-model.json`. The matching numerical training snapshot and report live beside it. Private files use mode 0600. The feature cache is versioned for initial-session requests and does not reuse the prior context-based feature definition.

Only credential-checked initial request text reaches the configured small-model providers. Suspect credentials are refused before inference; this is conservative filtering, not universal secret detection. Their measured session outcomes remain in training with explicitly unknown features. Failed feature extraction also retains known outcomes as unknown-feature samples. Feature extraction uses two bounded batches concurrently, caches completed results, and reuses a working configured fallback instead of repeatedly waiting for a timed-out route. Source requests, later conversation, and raw logs are never posted as calibration evidence.

The host watchdog checks receiver health first and schedules daily fitting separately. Failed candidates retain the installed model. Scratch data directories do not scan production native transcripts unless native directories are explicitly supplied. The calibration pipeline validates each artifact before promotion. Existing GitHub comments are updated in place with session quotes and their measured limitations.

## Snapshot: request-shape refit

The refit on 122 training and 35 held-out sessions (33 thread groups) selected the learned estimator. Held-out RMSLE is 2.93 against 3.88 for the training median. Active weights: uncertainty 1.73, request size 0.93, references 0.46, risk 0.29, action verbs 0.19; the other features are zero.

Intervals still under-cover. Observed hit rates on the held-out block are 63% at P80 and 80% at P95. The newest sessions run longer than older ones, so older residuals understate them. Status stays `experimental`, and the comment says so. A prediction is still wide: residual P95 is about four log units. Treat P50 as a typical session and P95 as the budget to watch.

Chronological rolling-origin checks on all 162 sessions agree with the held-out result: nonnegative shape features reduce log error from 4.18 to 3.50 against the running median.

## Snapshot: usage ceiling refit (2026-10-24)

Uncapped scenario quantiles had reached 394.0M total tokens, more than three times the largest recorded session in the cohort, and the missing-structure interpolation turned that surplus into a 149.0M recommended budget for almost every request. Scenarios now clamp to `workloadCeiling`, the training-split maximum, which is 119,894,832 total tokens for this artifact.

The refit on 308 training and 89 held-out sessions keeps the complexity estimator, with RMSLE 2.64 against 3.57 for the training-median baseline. Active held-out coverage is 83.1% at P80 and 96.6% at P95 on the fitted target, so this artifact reports `validated` rather than `experimental`. Coverage is still validation-selection evidence, not an independent test. The ceiling bounds a quote by the observed distribution; it does not predict unseen work, and one missing structure item still moves a budget a third of the way from P80 to the capped P95.

## Quantile tree heads (2026-10-24)

The ridge equation prices an average session and then spreads residuals. That cannot express the observed heteroscedasticity: a linear quantile fit stayed 40 to 45 percent behind boosted trees on held-out log pinball loss. Eight hundred fifty-two measured session rows, four shape buckets and eleven deterministic text features are now fitted with five independent gradient-boosted quantile heads (depth 3, 100 iterations, learning rate 0.05, leaf 20, L2 1.0) for P50, P75, P80, P95 and P99.

Independent heads can cross. They are rearranged into a monotone set before pricing, and every quantile is capped at the largest observed training total. The artifact stores the trees as flat node arrays (`f`, `t`, `l`, `r`, `v`), so the runtime walks them without Python. A fit fails if the exported arrays do not reproduce the fitted estimator to 1e-9.

The comment reports the best guess as P50, then P75, P80, P95 and P99. Input, generated and cached channels keep the median observed share of the priced total, so a printed input plus output budget still matches the total. Holding out the newest 20% of thread groups gives pinball 0.365 with coverage 0.31 at P50, 0.88 at P80 and 0.96 at P95. P50 coverage below nominal is why the budget still uses P80 for complete requests and P95 for incomplete ones.

The ridge equation stays in the artifact for structure pricing, cost-driver text and the legacy path. Artifacts without text features load unchanged and quote with the ridge equation.

## Stable heads and statistical gate

The first depth-3 heads (leaf 20, L2 1.0, learning rate 0.05) moved noticeably when the newest dozen training rows changed. The heads are now `max_depth` 2, `min_samples_leaf` 80, `l2_regularization` 10, `learning_rate` 0.03 and `max_iter` 100, held in the single `TREE_PARAMS` constant of `scripts/triage-effort-fit.py`. On the real dataset this scored held-out mean pinball 0.461 against 0.479 for the installed champion. The fit pins `OMP_NUM_THREADS` to 1 before importing numpy and sklearn: these tiny trees take about 2 s single-threaded, but thread contention once stretched one fit to 2 min 47 s.

With `--champion`, the fit stores `validation.quantileModel.champion.pairedDelta` = `{mean, lower90, upper90, resamples}`. It is the paired bootstrap (2000 resamples, fixed seed) of per-row mean pinball, challenger minus champion, on the shared held-out rows. Negative means the challenger is better. The fit also stores a report-only `validation.quantileModel.stability` = `{droppedNewest: 14, meanPinball, gap}`: the same heads refit without the 14 newest training rows and scored on the same held-out rows. The gap does not gate promotion.

`promotionDecision` checks coverage against the champion. Without a scoreable champion or its coverage it uses the absolute bounds: P80 0.75-0.92, P95 at least 0.90. With champion coverage, a challenger outside those bounds still passes unless its distance from nominal (0.80, 0.95) exceeds the champion's by more than 2 standard errors, `sqrt(q(1-q)/n)` over the shared held-out rows. Reason like `p80 coverage 0.963 is above 0.92 and 0.036 further from 0.80 than champion (limit 0.077)`. Hard sanity bounds always apply: P80 0.60-0.98, P95 at least 0.80. The metrics also carry `championP80Coverage` and `championP95Coverage`. For pinball, when `pairedDelta` is present it rejects if `lower90 > 0` (challenger clearly worse, reason like `pinball worse: delta 0.07 [0.05,0.10]`) or if the challenger mean pinball is above 1.10 times the champion (hard cap). Without `pairedDelta` it keeps the older 1.02 ratio rule.

Each head carries a conformal offset in log1p space. The runtime adds it to `baseline` before the tree sum, then applies the ceiling cap and the monotone rearrangement. The fit computes it from training rows only (conformalized quantile regression): thread groups are dealt round-robin into 5 folds, the five heads are refit without each fold, and the offset for quantile q is the q-th empirical quantile of `log1p(total) - out_of_fold_prediction`, clamped to +/-1.0. Held-out rows never touch it. The held-out score, the paired delta and the stability probe all apply the offsets; the champion is still scored with its own stored offsets. `validation.quantileModel` records `offsetSource: "oof-cqr"`, `offsetFolds` and `oofCoverage` = per-quantile `{nominal, offset, clamped, before, after}` (out-of-fold coverage before and after the shift, ignoring the cap and rearrangement). On the 2026-10-24 dataset the offsets moved held-out P80 coverage from 0.923, which the gate rejected as above 0.92, to 0.875, and mean pinball from 0.452 to 0.445 against the champion's 0.496.

## CLI

`bin/effort-model` is the agent-facing entry point. Each command prints facts on success, failures print `effort-model: <stage>: <msg>` on stderr with exit 1, and bad arguments print one usage line with exit 2. `--json` gives machine output.

```sh
bin/effort-model status
bin/effort-model bench --dataset /tmp/effort-e2e/x/dataset.json --external swe-chat --out /tmp/effort-bench
bin/effort-model data fetch
```

- `status` reads the live artifact, the optional challenger, `calibration-state.json` and the `effort-model.json` toggles in at most 300 bytes. Missing files print `none`.

  ```
  live 2026-10-24 pinball 0.479 p80 0.84 p95 0.97 rows 410/101 nodes 5282
  last 2026-10-24 rejected: p80 coverage 0.93 is above 0.92.
  next 2026-10-31 | toggles all on
  ```

- `bench` scores `current` (the live artifact's recorded `parameters`, else the depth-3 legacy ones), `stable` (`TREE_PARAMS`) and, with `--external swe-chat`, `stable+swe-chat-prior` on the same frozen held-out block. The default dataset is the installed `triage-effort-training.json` beside the artifact. The prior pools the external rows at weight 0.2 after moving their median onto ours. External rows are train-only: never held out, never part of the `workloadCeiling`. Their request features come from `scripts/effort-data-features.ts` (the runtime `requestFeatures`), cached as `features.jsonl` beside `rows.jsonl`; `--external-rows PATH` overrides the default `~/.cache/agent-console/effort-data/swe-chat`. The gap is the mean over 6 rolling cut-points of the pinball change when the newest 14 training rows are dropped. It writes `summary.json` under `--out` (default `~/.cache/agent-console/effort-bench/<timestamp>/`). `stable` applies the fitter's out-of-fold conformal offsets (`conformal_offsets`), `stable+swe-chat-prior` computes its offsets from out-of-fold residuals on our training rows only (external rows join the fits, never the residuals), and `current` and `qrf` use none. Offsets are in `summary.json` per candidate. They are applied on the final split only: the rolling gap uses raw heads, because offsets would cost about 6x per cut-point. `qrf` is a bench-only quantile regression forest (`quantile-forest`, 300 trees) on the same features, split and log1p target; `min_samples_leaf` in {5, 10, 20} and `max_features` in {0.5, 1.0} are picked on the older 80% of the training rows and scored on the newest 20%. It reports `nodes n/a` and its pickled size in `kb`; there is no Node export. Every line ends with the serialized model size and fit time, and `--candidates a,b` runs a subset.

  ```
  stable pinball 0.463 cov 0.92/0.99 gap 0.013 nodes 2518 kb 99 fit 2.1s
  best stable out /tmp/effort-bench/summary.json
  ```

- `data fetch [--dir DIR] [--raw-dir DIR] [--keep-raw]` runs `scripts/effort-data.py` and passes its line through, for example `swe-chat up to date rev 1a2b3c4d rows 13830`. Only the fetch needs pyarrow; `bench` reads jsonl.

`AGENT_CONSOLE_TRIAGE_PYTHON` selects the Python. Tests: `npm run test:effort-model` and `npm run test:effort-bench`.

## Improve-prompt quotes (2026-10-25)

The Improve prompt dialog quotes the draft and the rewrite with the same trees. The rewrite is priced with the draft's length and layout features (`size`, `lines`, `verbs`, `logChars`, `logLines`, `logVerbs`, `fence`, `checklist`, `bullets`, `questions`) through `requestFeatures(text, { shapeFrom: draft })`; content features (`refs`, `logRefs`, `logPaths`, `tests`, `versions`) come from the rewrite with placeholders removed. Clearer wording therefore never changes the quote. Added asks are shown as unpriced hints (`+N deliverables`, `+clarifying round`) because no calibrated label exists for them. The rewriter is pinned to `claude-opus-5-5`.

Refit on the 307 real sessions (scratch, 59 held-out rows): mean pinball 0.496 against the installed champion's 0.619 on the same rows, paired delta -0.164 (90% interval -0.281 to -0.078); P80 coverage 0.86 against 0.67. The example draft "Need a better way to label threads..." moved from P50 311k to 3.10M: question-style requests in real sessions are investigations, not short answers. Deterministic intent features (question, edit, ship, research, debug, issue reference, numbered asks) did not beat the stable set on real rows (0.469 against 0.458) and stay a bench-only `intent` candidate. The legacy model-extracted features cover only 25 of 356 real rows and are not revived.
