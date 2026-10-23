import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  createResultRecord,
  mergeResultSnapshot,
  snapshotDeploymentNeeded,
  validateResultSnapshot,
} from "./cloud-suggestion-results.mjs";
import { versionOf } from "./github-suggestion-bridge.mjs";

const at = "2026-10-22T12:00:00.000Z";
const version = "b3c0b46215ca8f40b3c0b46215ca8f40b3c0b46215ca8f40b3c0b46215ca8f40";
const candidate =
  "https://gfy0.github.io/gfy0/en/candidates/candidate-057d6eac-185c-4df9-957b-6ba10a9cce88/";

test("queue and failure snapshots contain only an issue version, status and timestamps", () => {
  for (const status of ["review-queued", "review-failed"]) {
    const record = createResultRecord({
      issue: 11,
      version,
      status,
      observedAt: at,
      title: "must not be copied",
      body: "must not be copied",
      username: "must not be copied",
      modelDiagnostic: "must not be copied",
    });
    assert.deepEqual(Object.keys(record).sort(), [
      "issue",
      "issueUrl",
      "observedAt",
      "status",
      "version",
    ]);
    assert.equal(record.issueUrl, "https://github.com/gfy0/gfy0/issues/11");
    assert.equal(record.status, status);
  }
});

test("snapshot version is the complete issue title and body version and changes when either changes", () => {
  const issue = { number: 11, title: "Project suggestion", body: "A public project" };
  const record = createResultRecord({
    issue: issue.number,
    version: versionOf(issue),
    status: "review-queued",
    observedAt: at,
  });
  assert.equal(record.version, versionOf(issue));
  assert.match(record.version, /^[a-f0-9]{64}$/);
  assert.notEqual(record.version, versionOf({ ...issue, body: "An edited project" }));
  assert.notEqual(record.version, versionOf({ ...issue, title: "Edited title" }));
});

test("snapshot merge keeps the latest workflow projection for each issue", () => {
  const old = createResultRecord({
    issue: 11,
    version: "a".repeat(64),
    status: "review-queued",
    observedAt: at,
  });
  const newer = createResultRecord({
    issue: 11,
    version,
    status: "review-failed",
    observedAt: "2026-10-22T12:01:00.000Z",
  });
  const other = createResultRecord({
    issue: 12,
    version: "c".repeat(64),
    status: "review-queued",
    observedAt: at,
  });
  const snapshot = mergeResultSnapshot(
    { schemaVersion: 1, generatedAt: at, records: [old, other] },
    [newer],
    "2026-10-22T12:02:00.000Z",
  );
  assert.deepEqual(
    snapshot.records.map(({ issue, status }) => [issue, status]),
    [
      [11, "review-failed"],
      [12, "review-queued"],
    ],
  );
  assert.equal(snapshot.generatedAt, "2026-10-22T12:02:00.000Z");
});

test("approval never creates a candidate link; published requires first-deploy live verification", () => {
  const approved = createResultRecord({
    issue: 11,
    version,
    status: "approved",
    observedAt: at,
    candidateUrl: candidate,
    liveVerified: true,
  });
  assert.equal(approved.candidateUrl, undefined);
  assert.throws(
    () =>
      createResultRecord({
        issue: 11,
        version,
        status: "published",
        observedAt: at,
        candidateUrl: candidate,
        liveVerified: false,
      }),
    /live verification/,
  );
  const published = createResultRecord({
    issue: 11,
    version,
    status: "published",
    observedAt: at,
    candidateUrl: candidate,
    liveVerified: true,
  });
  assert.equal(published.candidateUrl, candidate);
  assert.throws(
    () => createResultRecord({ issue: 11, version, status: "existing", observedAt: at }),
    /candidate URL/,
  );
});

test("published snapshots reject noncanonical candidate links and invalid issue/status/version values", () => {
  assert.throws(
    () =>
      createResultRecord({
        issue: 0,
        version: "b3c0b46215ca8f40",
        status: "review-failed",
        observedAt: at,
      }),
    /issue/,
  );
  assert.throws(
    () =>
      createResultRecord({
        issue: 11,
        version: "not-a-hash",
        status: "review-failed",
        observedAt: at,
      }),
    /version/,
  );
  assert.throws(
    () => createResultRecord({ issue: 11, version, status: "arbitrary", observedAt: at }),
    /status/,
  );
  assert.throws(
    () =>
      createResultRecord({
        issue: 11,
        version,
        status: "published",
        observedAt: at,
        candidateUrl: "https://example.com/project",
        liveVerified: true,
      }),
    /candidate/,
  );
});

test("snapshot reader validation binds each safe record to its exact issue number", () => {
  const record = createResultRecord({
    issue: 11,
    version,
    status: "review-failed",
    observedAt: at,
  });
  const snapshot = { schemaVersion: 1, generatedAt: at, records: [record] };
  assert.equal(validateResultSnapshot(snapshot).records[0].issue, 11);
  assert.throws(
    () => validateResultSnapshot({ ...snapshot, records: [{ ...record, issue: 12 }] }),
    /issue URL/,
  );
  assert.throws(
    () =>
      validateResultSnapshot({
        ...snapshot,
        records: [{ ...record, status: "approved", candidateUrl: candidate }],
      }),
    /candidate/,
  );
});

test("a committed snapshot is redeployed on the next run when the live Pages copy is absent or behind", async () => {
  const record = createResultRecord({
    issue: 11,
    version,
    status: "review-failed",
    observedAt: at,
  });
  const snapshot = { schemaVersion: 1, generatedAt: at, records: [record] };
  const response = (value) => ({
    ok: true,
    headers: { get: () => String(JSON.stringify(value).length) },
    text: async () => JSON.stringify(value),
  });
  assert.equal(await snapshotDeploymentNeeded(snapshot, async () => ({ ok: false })), true);
  assert.equal(await snapshotDeploymentNeeded(snapshot, async () => response(snapshot)), false);
  assert.equal(
    await snapshotDeploymentNeeded(snapshot, async () => response({ ...snapshot, records: [] })),
    true,
  );
});

test("Pages workflow calls the production scripts path and publishes a separate recovery artifact", () => {
  const workflow = readFileSync(
    new URL("./cloud-suggestion-workflow.yml", import.meta.url),
    "utf8",
  );
  assert.match(
    workflow,
    /node --test automation\/scripts\/cloud-suggestion-results\.test\.mjs automation\/scripts\/suggestion-results-client\.test\.mjs/,
  );
  assert.match(workflow, /run: node automation\/scripts\/cloud-suggestion-review\.mjs prepare/);
  assert.match(workflow, /run: node automation\/scripts\/cloud-suggestion-review\.mjs finish/);
  assert.match(workflow, /name: github-pages-results/);
  assert.match(workflow, /artifact_name: github-pages-results/);
  assert.match(workflow, /id: verify/);
  assert.match(
    workflow,
    /if: always\(\) && steps\.verify\.outcome == 'success' && steps\.finish\.outputs\.snapshot_deploy == 'true'/,
  );
});
