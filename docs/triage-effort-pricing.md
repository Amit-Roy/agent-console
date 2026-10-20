# Session effort pricing

The input is the initial user message, or consecutive initial user messages before the first agent response. The outputs are recorded totals for the entire inactive session, including later follow-ups, retries, and measured failures. Later conversation, assistant plans, tools, commits, and realized usage never enter the input features.

The previous delivery-run model selected only commit-backed turns. Its 26-run cohort and four held-out runs did not represent the requested session-level problem. That selection is superseded.

## Dataset and identity

The collector inventories Console threads and retained native Claude, Codex, and Pi transcripts. A transcript file is not necessarily an independent user session. Child sessions attach to their traceable parent. Backend resumptions within one Console session share an identity. A native transcript and its Console accounting mirror are never added together.

Complete native records take precedence when they cover the linked session. Complete Console accounting is a fallback when native coverage is missing. Unknown token usage remains unknown, never zero. Active sessions are excluded from training. Historical errors and zero-tool conversations remain valid when their actual usage is recorded.

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
