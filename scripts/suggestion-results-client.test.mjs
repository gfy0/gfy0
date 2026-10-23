import assert from "node:assert/strict";
import fs from "node:fs";
import { webcrypto } from "node:crypto";
import vm from "node:vm";
import test from "node:test";
const clientModule = { exports: {} };
const clientPath = new URL("./suggestion-results.js", import.meta.url);
vm.runInNewContext(fs.readFileSync(clientPath, "utf8"), {
  module: clientModule,
  exports: clientModule.exports,
  AbortController,
  clearTimeout,
  crypto: webcrypto,
  fetch,
  setTimeout,
  TextEncoder,
});
const { loadIssue, loadSnapshotRecord, parseResultSnapshot, lookupWithSnapshot } =
  clientModule.exports;

const issueNumber = 11;
const issueVersion = "b3c0b46215ca8f40b3c0b46215ca8f40b3c0b46215ca8f40b3c0b46215ca8f40";
const observedAt = "2026-10-22T12:00:00.000Z";
const issueUrl = "https://github.com/gfy0/gfy0/issues/11";
const failure = {
  issue: issueNumber,
  version: issueVersion,
  status: "review-failed",
  observedAt,
  issueUrl,
};
const envelope = { schemaVersion: 1, generatedAt: observedAt, records: [failure] };

test("same-origin result lookup reads a fixed issue snapshot with no credentials or cache reuse", async () => {
  let request;
  const record = await loadSnapshotRecord(issueNumber, async (url, options) => {
    request = { url, options };
    return { ok: true, json: async () => envelope };
  });
  assert.equal(record.status, "review-failed");
  assert.equal(record.version.length, 64);
  assert.equal(request.url, "../../cloud-suggestion-results.json");
  assert.equal(request.options.credentials, "omit");
  assert.equal(request.options.cache, "no-store");
});

test("a GitHub API outage falls back to the matching same-origin snapshot", async () => {
  const result = await lookupWithSnapshot(
    issueNumber,
    async () => {
      throw Error("unavailable");
    },
    async (number) => (number === issueNumber ? failure : null),
  );
  assert.equal(result.live, null);
  assert.equal(result.snapshot.issueUrl, issueUrl);
  assert.equal(result.snapshot.status, "review-failed");
});

test("a GitHub 403 falls back to the matching same-origin snapshot without retrying", async () => {
  let apiCalls = 0;
  let snapshotCalls = 0;
  const result = await lookupWithSnapshot(
    issueNumber,
    (number) =>
      loadIssue(number, async () => {
        apiCalls++;
        return { ok: false, status: 403 };
      }),
    async (number) => {
      snapshotCalls++;
      return number === issueNumber ? failure : null;
    },
  );
  assert.equal(result.live, null);
  assert.equal(result.snapshot.status, "review-failed");
  assert.equal(apiCalls, 1);
  assert.equal(snapshotCalls, 1);
});

test("a current official GitHub result takes precedence over an old snapshot", async () => {
  let snapshotRead = false;
  const live = {
    issue: { number: issueNumber },
    review: {
      status: "published",
      url: "https://gfy0.github.io/gfy0/en/candidates/candidate-057d6eac-185c-4df9-957b-6ba10a9cce88/",
    },
  };
  const result = await lookupWithSnapshot(
    issueNumber,
    async () => live,
    async () => {
      snapshotRead = true;
      return failure;
    },
  );
  assert.equal(result.live, live);
  assert.equal(result.snapshot, null);
  assert.equal(snapshotRead, false);
});

test("snapshot contract rejects mismatched issues and unverified candidate claims", () => {
  assert.equal(parseResultSnapshot(envelope, 11), failure);
  assert.equal(parseResultSnapshot(envelope, 12), null);
  assert.equal(
    parseResultSnapshot({ ...envelope, records: [{ ...failure, issue: 12 }] }, 12),
    null,
  );
  assert.equal(
    parseResultSnapshot(
      {
        ...envelope,
        records: [
          {
            ...failure,
            status: "approved",
            candidateUrl:
              "https://gfy0.github.io/gfy0/en/candidates/candidate-057d6eac-185c-4df9-957b-6ba10a9cce88/",
          },
        ],
      },
      11,
    ),
    null,
  );
});

test("GitHub issue version remains a full SHA-256 value while official comment markers use its prefix", async () => {
  const issue = {
    number: issueNumber,
    html_url: issueUrl,
    state: "open",
    title: "title",
    body: "body",
    comments: 0,
  };
  const result = await loadIssue(issueNumber, async () => ({ ok: true, json: async () => issue }));
  assert.match(result.version, /^[a-f0-9]{64}$/);
});
