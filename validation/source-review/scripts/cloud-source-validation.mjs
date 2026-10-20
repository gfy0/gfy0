import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  evaluateSource,
  makeSnapshot,
  proposeSource,
  sourceRiskDetected,
} from "./cloud-source-review.mjs";

// Read-only operator validation against an independently checked immutable source.
const commit = "700f0a2ad4ec45eea713e6f2ec66e6c04b3c861e";
const report = { experiment: "free-cloud-source-validation", source: "dprint/dprint", commit };
let stage = "scope";
async function get(route) {
  assert.ok(
    [
      "/repos/dprint/dprint",
      `/repos/dprint/dprint/commits/${commit}`,
      `/repos/dprint/dprint/readme?ref=${commit}`,
      `/repos/dprint/dprint/license?ref=${commit}`,
    ].includes(route),
  );
  const response = await fetch(`https://api.github.com${route}`, {
    redirect: "error",
    signal: AbortSignal.timeout(30000),
    headers: { Accept: "application/vnd.github+json", "User-Agent": "Your-No1-source-validation" },
  });
  assert.equal(response.status, 200);
  return response.json();
}
try {
  assert.equal(process.env.GITHUB_ACTIONS, "true");
  assert.equal(process.env.GITHUB_REPOSITORY, "gfy0/gfy0");
  assert.equal(process.env.GITHUB_EVENT_NAME, "workflow_dispatch");
  assert.equal(Number(process.versions.node.split(".")[0]), 24);
  stage = "fixed-source";
  const [repo, revision, readme, license] = await Promise.all([
    get("/repos/dprint/dprint"),
    get(`/repos/dprint/dprint/commits/${commit}`),
    get(`/repos/dprint/dprint/readme?ref=${commit}`),
    get(`/repos/dprint/dprint/license?ref=${commit}`),
  ]);
  assert.equal(repo.id, 192136193);
  assert.equal(repo.owner.id, 64226271);
  assert.equal(revision.sha, commit);
  assert.equal(readme.sha, "4bae2586865878c458b3c07ab4ffcf852058a741");
  assert.equal(license.sha, "8c64c54183aaff2b0db2c632aac2eec1544513aa");
  const snapshot = makeSnapshot("https://github.com/dprint/dprint", {
    repo,
    commit: revision,
    readme,
    license,
  });
  assert.equal(snapshot.text.length, 4903);
  assert.ok(
    snapshot.text.includes(
      "Monorepo for dprint—a pluggable and configurable code formatting platform.",
    ),
  );
  assert.equal(sourceRiskDetected(snapshot), false);
  report.sourceCharacters = snapshot.text.length;
  report.snapshotHash = snapshot.hash;
  stage = "cloud-proposal";
  const { proposal, attestation } = proposeSource(snapshot);
  Object.assign(report, { attestation });
  const review = proposal?.review;
  const name = typeof review?.nameQuote === "string" ? review.nameQuote : "";
  const summary = typeof review?.summaryQuote === "string" ? review.summaryQuote : "";
  report.admissionChecks = {
    outerKeysValid: Boolean(
      proposal && Object.keys(proposal).sort().join("|") === "review|snapshotHash|toolKind",
    ),
    reviewKeysValid: Boolean(
      review &&
        Object.keys(review).sort().join("|") === "category|nameQuote|summaryQuote|uncertain",
    ),
    snapshotMatches: proposal?.snapshotHash === snapshot.hash,
    category: ["general", "political", "high-risk", "private-person", "unknown"].includes(
      review?.category,
    )
      ? review.category
      : "invalid",
    uncertain: typeof review?.uncertain === "boolean" ? review.uncertain : "invalid",
    toolKind: ["code-formatter", "static-linter", "type-checker", "compiler", "unknown"].includes(
      proposal?.toolKind,
    )
      ? proposal.toolKind
      : "invalid",
    nameMatches: name === "dprint",
    nameWithinLimit: name.length > 0 && name.length <= 200,
    summaryWithinLimit: summary.length > 0 && summary.length <= 500,
    nameInSource: name.length > 0 && snapshot.text.includes(name),
    summaryInSource: summary.length > 0 && snapshot.text.includes(summary),
    summaryContainsName: name.length > 0 && summary.includes(name),
    singleLine: !/[\r\n]/.test(summary),
  };
  stage = "source-bound-admission";
  const evaluated = evaluateSource(snapshot, proposal, "dprint");
  report.evaluationStatus = evaluated.status;
  assert.equal(evaluated.status, "supported");
  stage = "display-name";
  assert.equal(evaluated.source.name, "dprint");
  stage = "expected-category";
  assert.equal(proposal.toolKind, "code-formatter");
  stage = "no-publication-authority";
  assert.equal(evaluated.domain.publishable, false);
  Object.assign(report, {
    status: "PASS",
    toolKind: proposal.toolKind,
    sourceBoundQuoteVerified: true,
    publicationPerformed: false,
  });
} catch (error) {
  Object.assign(report, { status: "FAIL", failedStage: stage, errorType: error.name });
  // A failed child may have emitted a bounded report; never print its raw output.
  try {
    const child = JSON.parse(String(error.stdout));
    report.diagnostic = Object.fromEntries(
      [
        "status",
        "failedStage",
        "errorType",
        "doneReason",
        "promptTokens",
        "cleanupVerified",
        "serverStopped",
        "peakModelProcessRssKiB",
      ]
        .filter((key) => Object.hasOwn(child, key))
        .map((key) => [key, child[key]]),
    );
  } catch {}
} finally {
  report.requestRemoved = !fs.existsSync(
    path.join(process.env.RUNNER_TEMP || ".", "your-no1-cloud-source-request.json"),
  );
  console.log(JSON.stringify(report));
}
process.exitCode = report.status === "PASS" && report.requestRemoved ? 0 : 1;
