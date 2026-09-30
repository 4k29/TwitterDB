# AGENTS.md

## Project purpose
TwitterDB is a personal X/Twitter archive browser and analytics UI. Extend the existing application with useful, explainable analysis and post-draft performance estimates. Inspect current code and data contracts before selecting an implementation.

## Code Review Rules

### Keep private data private
The public repository and published site must never contain tweet archive contents, analytics data, classifications, deleted-state data, credentials, or other data that belongs in the private `4k29/TwitterDB-data` repository.
This also applies to fitted model parameters, learned vocabularies, embeddings, nearest-neighbor indexes, real-data fixtures, screenshots, and reports derived from private data. Keep these in the local authenticated browser or the private repository through the intended flow. Public tests must use synthetic data.

### Keep credentials client-local
Fine-grained GitHub access tokens must remain stored only in the user's local browser storage. Never commit, log, transmit to unrelated services, or embed tokens in generated files or public code.

### Preserve the public/private repository boundary
The public UI may retrieve private data only through the intended authenticated GitHub API flow. Changes must not accidentally move private data into the public repository or make unauthenticated private-data access possible.
Do not require real credentials in CI, introduce paid APIs or a backend without an explicit request, or send drafts/archive data to external AI services.

## Repository and compatibility
- Public UI: `4k29/TwitterDB`; private data: `4k29/TwitterDB-data`.
- Inspect `README.md`, `private-data-v13.js`, `data-loader-v10.js`, `app-v9.js`, and `analytics/` as relevant. Follow actual referenced files, not assumed version names.
- Preserve archive browsing, filters, category corrections, deleted-state handling, authentication, caching, and monthly reviews.
- Preserve the analytics graph as the analytics entry screen and the small link to the post DB.
- Maintain the existing simple visual style. Japanese user-facing text, mobile usability, accessible labels, and clear loading/empty/error states.
- Prefer small reusable modules over appending large inline scripts or stacking additional CSS override files. Avoid unrelated rewrites and framework migrations.
- Never overwrite or delete source archives to implement analysis. Treat missing metrics as missing, not zero. Keep tweet IDs as strings.

## Analysis and prediction
- Audit available fields, date range, freshness, duplicates, missingness, snapshot dates, observation age, and exclusion rules before modeling. Distinguish original posts, replies, quotes, and reposts.
- Define the target explicitly. Predict a fixed horizon such as 24-hour likes only when corresponding observations exist. Otherwise describe estimates as archive-snapshot likes with unknown/mixed observation age; never invent a horizon or final lifetime count.
- Use only information available at draft/submission time as prediction features. Likes, repost totals, impressions, or later engagement are labels or evaluation data, not draft-time inputs. Do not invent unavailable follower counts, media properties, or topic labels.
- Use chronological train/validation/test partitions or rolling backtests. Fit vocabulary, feature scaling, category statistics, similarity indexes, hyperparameters, and interval calibration on the appropriate earlier partitions only. Exclude the target post and avoid duplicate/near-duplicate leakage. Keep a final holdout untouched by model selection.
- Compare to simple recent-period and category-median baselines. Favor explainable similarity-based estimates first; complexity must be supported by held-out results.
- Report sample counts, evaluation periods, MAE and a robust metric such as log1p error. Evaluate prediction-interval coverage and width on unseen data. Do not call an uncalibrated historical spread a confidence/prediction interval.
- Display probabilities of exceeding a threshold only when tested/calibrated with adequate data; otherwise use clearly labeled historical proportions or omit them.
- If comparable data are sparse, stale, or outside the supported domain, widen uncertainty or return insufficient evidence. Never fabricate predictions, accuracy claims, or X internal scores.
- If the model does not outperform baselines, retain the baseline/experimental estimate and honestly report the result.
- Similar posts and feature associations explain historical patterns, not causal effects or guarantees that editing a draft will increase engagement.
- Keep prediction reproducible, including algorithm/config version and source-data version. Invalidate caches when either changes.

## Verification and delivery
- Run existing relevant checks when available. Add meaningful synthetic tests for chronological leakage, missing-vs-zero metrics, exclusions, unsupported input, intervals, and cache invalidation when implementing prediction.
- Verify authentication-required behavior, loading failures, archive/analytics regressions, and mobile layout. Escape draft/post text rather than inserting raw HTML.
- Measure browser responsiveness for the actual available data size; use chunking or a worker if needed.
- Never publish real private data in test output or screenshots. If private data are unavailable, finish a runnable implementation with synthetic tests and document that real-data validation remains unperformed.
- Document how to run, reproduce validation, interpret estimates, and update/retrain. Report changes, checks actually run, results, and limitations; distinguish implemented behavior from measured accuracy.
