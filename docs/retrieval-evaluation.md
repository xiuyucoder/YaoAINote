# Retrieval quality evaluation

This repository evaluates retrieval quality without collecting queries,
documents, chunks, answers, embeddings, source snippets, filenames, or user
identities. The fixture is synthetic and uses only placeholder IDs.

## Data contract

[`evaluation/retrieval-results.schema.json`](../evaluation/retrieval-results.schema.json)
defines one JSON object per JSONL line. The evaluator also enforces this schema
without requiring a JSON Schema package.

```json
{
  "schema_version": "1.0",
  "case_id": "case-opaque-id",
  "relevant_result_ids": ["result-opaque-id"],
  "retrieved_results": [
    { "result_id": "result-opaque-id", "rank": 1 }
  ]
}
```

`case_id` and `result_id` must be opaque IDs matching
`[A-Za-z0-9][A-Za-z0-9._:-]{0,127}`. They are not query text, filenames,
document IDs, hashes of user data, or provider IDs. `relevant_result_ids` is
the complete binary relevance judgment set for a case. Returned result IDs and
ranks must be unique; ranks must be contiguous and start at 1. Empty retrieval
results are valid. Unknown fields, including query text, content, source
metadata, scores, and answers, are rejected.

Keep the input in an access-controlled evaluation corpus outside the repository
when it is not the checked-in placeholder fixture. Do not transform production
logs or telemetry into this file. This is consistent with
[`observability.md`](observability.md): normal telemetry excludes document IDs,
queries, chunks, result IDs, text, and other linkable/content-bearing values.

## Running the evaluator

The dependency-free script requires a supported Node.js runtime and accepts
only JSONL matching the contract:

```powershell
node scripts/evaluate-retrieval.js `
  --input evaluation/fixtures/placeholder-retrieval-results.jsonl `
  --k 1,3,5 `
  --output evaluation/fixtures/placeholder-metrics.json
```

Without `--output`, JSON is written to stdout. `--k` defaults to `1,3,5,10`
and accepts unique integers from 1 through 1000.

The output is deterministic aggregate-only JSON:

```json
{
  "schema_version": "1.0",
  "case_count": 2,
  "k_values": [1, 3, 5],
  "metrics": {
    "1": {
      "recall_at_k": 0.25,
      "mrr_at_k": 0.5,
      "ndcg_at_k": 0.5
    }
  }
}
```

For every case, Recall@K is the number of relevant returned IDs at ranks at
most K divided by the number of judged relevant IDs. MRR@K is the reciprocal
rank of the first relevant result (or zero). nDCG@K uses binary gains and
`1 / log2(rank + 1)`, normalized by the ideal ranking for the judged relevant
set. Each reported value is the macro-average over cases.

The script exits with status `2` for argument, JSONL, or schema/ranking
validation errors, and status `1` for input/output I/O failures. It reports the
line and field where possible, rejects duplicate case IDs, result IDs, and
ranks, and prevents an output path from overwriting the input.

## Secure scheduled CI and publication

Run this as a scheduled, manually dispatchable CI job using a trusted runner
and a least-privilege `contents: read` token. Do not run a job that reads a
private evaluation corpus for untrusted pull requests or forked code. Obtain
the corpus from an approved access-controlled store with workload identity
(not a repository secret printed to logs), and delete its workspace copy at job
completion. The corpus must remain content-free under this contract.

For example, after a separate authenticated retrieval job produces the
content-free JSONL on the trusted runner:

```yaml
on:
  workflow_dispatch:
  schedule:
    - cron: "17 3 * * 1"
permissions:
  contents: read
jobs:
  evaluate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@<pinned-commit>
      - uses: actions/setup-node@<pinned-commit>
        with:
          node-version: 20
      - run: node scripts/evaluate-retrieval.js --input "$RUNNER_TEMP/retrieval.jsonl" --k 1,3,5,10 --output metrics.json
      - uses: actions/upload-artifact@<pinned-commit>
        with:
          name: retrieval-quality-aggregate
          path: metrics.json
```

Pin action commits in the real workflow and configure the retrieval-producing
step not to log its input. Publish only `metrics.json`, case count, and
approved pass/fail thresholds to a restricted CI summary, artifact, or quality
dashboard. Never publish JSONL, case IDs, per-case metrics, or raw retrieval
results. The existing observability metric contract intentionally has no
retrieval-evaluation metric; do not add an application telemetry metric or
labels for case/result IDs without first updating that contract and its privacy
review.
