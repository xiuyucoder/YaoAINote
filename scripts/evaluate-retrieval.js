#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

class EvaluationError extends Error {}

const TOP_LEVEL_KEYS = new Set([
  "schema_version",
  "case_id",
  "relevant_result_ids",
  "retrieved_results",
]);
const RESULT_KEYS = new Set(["result_id", "rank"]);
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DEFAULT_K_VALUES = [1, 3, 5, 10];

function usage() {
  return [
    "Usage: node scripts/evaluate-retrieval.js --input <results.jsonl> [--k <k[,k...]>] [--output <metrics.json>]",
    "",
    "Computes macro Recall@K, MRR@K, and nDCG@K from content-free retrieval evaluation JSONL.",
    "Defaults: --k 1,3,5,10; writes metrics JSON to stdout when --output is omitted.",
  ].join("\n");
}

function parseKValues(value) {
  if (!value) {
    throw new EvaluationError("--k requires one or more positive integer values.");
  }

  const values = value.split(",").map((item) => {
    if (!/^[1-9]\d*$/.test(item)) {
      throw new EvaluationError(`Invalid K value "${item}". K must be an integer from 1 through 1000.`);
    }
    const parsed = Number(item);
    if (!Number.isSafeInteger(parsed) || parsed > 1000) {
      throw new EvaluationError(`Invalid K value "${item}". K must be an integer from 1 through 1000.`);
    }
    return parsed;
  });

  if (new Set(values).size !== values.length) {
    throw new EvaluationError("--k must not contain duplicate values.");
  }

  return values.sort((left, right) => left - right);
}

function parseArguments(args) {
  const options = { kValues: DEFAULT_K_VALUES };

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--help" || argument === "-h") {
      options.help = true;
      continue;
    }
    if (argument === "--input" || argument === "-i") {
      options.input = args[++index];
      if (!options.input) {
        throw new EvaluationError(`${argument} requires a file path.`);
      }
      continue;
    }
    if (argument === "--output" || argument === "-o") {
      options.output = args[++index];
      if (!options.output) {
        throw new EvaluationError(`${argument} requires a file path.`);
      }
      continue;
    }
    if (argument === "--k") {
      options.kValues = parseKValues(args[++index]);
      continue;
    }
    throw new EvaluationError(`Unknown argument "${argument}".`);
  }

  if (!options.help && !options.input) {
    throw new EvaluationError("--input is required.");
  }

  return options;
}

function validateKeys(value, allowedKeys, location) {
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      throw new EvaluationError(`${location} contains unsupported field "${key}".`);
    }
  }
}

function requireField(value, field, location) {
  if (!Object.prototype.hasOwnProperty.call(value, field)) {
    throw new EvaluationError(`${location} is missing required field "${field}".`);
  }
}

function validateOpaqueId(value, location) {
  if (typeof value !== "string" || !OPAQUE_ID.test(value)) {
    throw new EvaluationError(`${location} must be an opaque identifier using 1-128 letters, digits, ".", "_", ":", or "-".`);
  }
}

function validateRecord(record, lineNumber, caseIds) {
  const location = `Line ${lineNumber}`;
  if (record === null || Array.isArray(record) || typeof record !== "object") {
    throw new EvaluationError(`${location} must be a JSON object.`);
  }

  validateKeys(record, TOP_LEVEL_KEYS, location);
  for (const field of TOP_LEVEL_KEYS) {
    requireField(record, field, location);
  }

  if (record.schema_version !== "1.0") {
    throw new EvaluationError(`${location}.schema_version must be "1.0".`);
  }
  validateOpaqueId(record.case_id, `${location}.case_id`);
  if (caseIds.has(record.case_id)) {
    throw new EvaluationError(`${location}.case_id duplicates an earlier case ID.`);
  }
  caseIds.add(record.case_id);

  if (!Array.isArray(record.relevant_result_ids) || record.relevant_result_ids.length === 0) {
    throw new EvaluationError(`${location}.relevant_result_ids must be a non-empty array.`);
  }
  const relevantIds = new Set();
  for (const [index, resultId] of record.relevant_result_ids.entries()) {
    validateOpaqueId(resultId, `${location}.relevant_result_ids[${index}]`);
    if (relevantIds.has(resultId)) {
      throw new EvaluationError(`${location}.relevant_result_ids must not contain duplicate IDs.`);
    }
    relevantIds.add(resultId);
  }

  if (!Array.isArray(record.retrieved_results)) {
    throw new EvaluationError(`${location}.retrieved_results must be an array.`);
  }
  const retrievedIds = new Set();
  const ranks = new Set();
  for (const [index, result] of record.retrieved_results.entries()) {
    const resultLocation = `${location}.retrieved_results[${index}]`;
    if (result === null || Array.isArray(result) || typeof result !== "object") {
      throw new EvaluationError(`${resultLocation} must be an object.`);
    }
    validateKeys(result, RESULT_KEYS, resultLocation);
    for (const field of RESULT_KEYS) {
      requireField(result, field, resultLocation);
    }
    validateOpaqueId(result.result_id, `${resultLocation}.result_id`);
    if (retrievedIds.has(result.result_id)) {
      throw new EvaluationError(`${location}.retrieved_results must not contain duplicate result IDs.`);
    }
    retrievedIds.add(result.result_id);
    if (!Number.isInteger(result.rank) || result.rank < 1 || result.rank > 100000) {
      throw new EvaluationError(`${resultLocation}.rank must be an integer from 1 through 100000.`);
    }
    if (ranks.has(result.rank)) {
      throw new EvaluationError(`${location}.retrieved_results must not contain duplicate ranks.`);
    }
    ranks.add(result.rank);
  }

  const sortedResults = [...record.retrieved_results].sort((left, right) => left.rank - right.rank);
  for (const [index, result] of sortedResults.entries()) {
    if (result.rank !== index + 1) {
      throw new EvaluationError(`${location}.retrieved_results ranks must be contiguous and start at 1.`);
    }
  }

  return { relevantIds, retrievedResults: sortedResults };
}

function readRecords(inputPath) {
  let input;
  try {
    input = fs.readFileSync(inputPath, "utf8");
  } catch (error) {
    throw new Error(`Unable to read input "${inputPath}": ${error.message}`);
  }

  const records = [];
  const caseIds = new Set();
  for (const [index, line] of input.split(/\r?\n/).entries()) {
    if (line.trim() === "") {
      continue;
    }
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      throw new EvaluationError(`Line ${index + 1} is not valid JSON: ${error.message}`);
    }
    records.push(validateRecord(parsed, index + 1, caseIds));
  }

  if (records.length === 0) {
    throw new EvaluationError("Input must contain at least one non-blank JSONL record.");
  }
  return records;
}

function discountedGain(rank) {
  return 1 / Math.log2(rank + 1);
}

function calculateMetrics(records, kValues) {
  const metrics = {};

  for (const k of kValues) {
    let recall = 0;
    let reciprocalRank = 0;
    let normalizedDcg = 0;

    for (const record of records) {
      const relevantRanks = record.retrievedResults
        .filter((result) => result.rank <= k && record.relevantIds.has(result.result_id))
        .map((result) => result.rank);
      recall += relevantRanks.length / record.relevantIds.size;
      reciprocalRank += relevantRanks.length === 0 ? 0 : 1 / relevantRanks[0];

      const dcg = relevantRanks.reduce((sum, rank) => sum + discountedGain(rank), 0);
      let idealDcg = 0;
      for (let rank = 1; rank <= Math.min(k, record.relevantIds.size); rank += 1) {
        idealDcg += discountedGain(rank);
      }
      normalizedDcg += dcg / idealDcg;
    }

    metrics[String(k)] = {
      recall_at_k: recall / records.length,
      mrr_at_k: reciprocalRank / records.length,
      ndcg_at_k: normalizedDcg / records.length,
    };
  }

  return {
    schema_version: "1.0",
    case_count: records.length,
    k_values: kValues,
    metrics,
  };
}

function writeOutput(outputPath, metrics) {
  const serialized = `${JSON.stringify(metrics, null, 2)}\n`;
  if (!outputPath) {
    process.stdout.write(serialized);
    return;
  }
  try {
    fs.writeFileSync(outputPath, serialized, "utf8");
  } catch (error) {
    throw new Error(`Unable to write output "${outputPath}": ${error.message}`);
  }
}

function pathsReferToSameFile(inputPath, outputPath) {
  const normalize = (filePath) => {
    const resolved = path.resolve(filePath);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };

  if (normalize(inputPath) === normalize(outputPath)) {
    return true;
  }

  try {
    return normalize(fs.realpathSync(inputPath)) === normalize(fs.realpathSync(outputPath));
  } catch {
    return false;
  }
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  if (options.output && pathsReferToSameFile(options.input, options.output)) {
    throw new EvaluationError("--output must not overwrite --input.");
  }

  const records = readRecords(options.input);
  writeOutput(options.output, calculateMetrics(records, options.kValues));
}

try {
  main();
} catch (error) {
  process.stderr.write(`Evaluation failed: ${error.message}\n`);
  if (error instanceof EvaluationError) {
    process.stderr.write(`${usage()}\n`);
    process.exitCode = 2;
  } else {
    process.exitCode = 1;
  }
}
