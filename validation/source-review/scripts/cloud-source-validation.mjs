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
const commit = "3f0cdd9114894cc3b308833eccb956ae6e980bdf";
const report = { experiment: "free-cloud-source-validation", source: "astral-sh/ruff", commit };
let stage = "scope";
async function get(route) {
  assert.ok(
    [
      "/repos/astral-sh/ruff",
      `/repos/astral-sh/ruff/commits/${commit}`,
      `/repos/astral-sh/ruff/readme?ref=${commit}`,
      `/repos/astral-sh/ruff/license?ref=${commit}`,
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
    get("/repos/astral-sh/ruff"),
    get(`/repos/astral-sh/ruff/commits/${commit}`),
    get(`/repos/astral-sh/ruff/readme?ref=${commit}`),
    get(`/repos/astral-sh/ruff/license?ref=${commit}`),
  ]);
  assert.equal(repo.id, 523043277);
  assert.equal(repo.owner.id, 115962839);
  assert.equal(revision.sha, commit);
  assert.equal(readme.sha, "925c4337b5278ebf78708db8a917b221f41e3c93");
  assert.equal(license.sha, "655a0c76fc5539b2f8e63b673741a5fd0e0c5799");
  const snapshot = makeSnapshot("https://github.com/astral-sh/ruff", {
    repo,
    commit: revision,
    readme,
    license,
  });
  assert.equal(snapshot.text.length, 19606);
  assert.ok(snapshot.text.includes("To run Ruff as a linter, try any of the following:"));
  assert.equal(sourceRiskDetected(snapshot), false);
  report.sourceCharacters = snapshot.text.length;
  report.snapshotHash = snapshot.hash;
  stage = "cloud-proposal";
  const { proposal, attestation } = proposeSource(snapshot);
  Object.assign(report, { attestation });
  stage = "source-bound-admission";
  const evaluated = evaluateSource(snapshot, proposal, "Ruff");
  assert.equal(evaluated.status, "supported");
  assert.equal(evaluated.source.name, "Ruff");
  assert.ok(["static-linter", "code-formatter"].includes(proposal.toolKind));
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
