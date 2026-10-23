const issueBase = "https://github.com/gfy0/gfy0/issues/";
const candidateBase = "https://gfy0.github.io/gfy0/";
const versionPattern = /^[a-f0-9]{64}$/;
const statuses = new Set([
  "review-queued",
  "review-failed",
  "review-held",
  "out-of-scope",
  "name-mismatch",
  "duplicate-uncertain",
  "source-unavailable",
  "source-changed",
  "needs-information",
  "approved",
  "deployment-pending",
  "published",
  "existing",
]);
const locales = new Set(["en", "zh-CN", "es", "ar", "ja"]);

function validTimestamp(value) {
  return (
    typeof value === "string" &&
    /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) &&
    !Number.isNaN(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

function validCandidateUrl(value) {
  if (typeof value !== "string") return false;
  const match =
    /^https:\/\/gfy0\.github\.io\/gfy0\/(en|zh-CN|es|ar|ja)\/candidates\/(candidate-[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12})\/$/.exec(
      value,
    );
  return Boolean(match && locales.has(match[1]));
}

function validateRecord(record) {
  if (!record || typeof record !== "object" || Array.isArray(record))
    throw Error("invalid snapshot record");
  const keys = Object.keys(record).sort();
  const expected = ["issue", "issueUrl", "observedAt", "status", "version"];
  if (Object.hasOwn(record, "candidateUrl")) expected.push("candidateUrl");
  expected.sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index]))
    throw Error("invalid snapshot fields");
  if (!Number.isSafeInteger(record.issue) || record.issue < 1 || record.issue > 999999999)
    throw Error("invalid issue number");
  if (record.issueUrl !== issueBase + record.issue) throw Error("invalid issue URL");
  if (typeof record.version !== "string" || !versionPattern.test(record.version))
    throw Error("invalid issue version");
  if (!statuses.has(record.status)) throw Error("invalid review status");
  if (!validTimestamp(record.observedAt)) throw Error("invalid observation timestamp");
  const hasCandidate = Object.hasOwn(record, "candidateUrl");
  if (record.status === "published") {
    if (!hasCandidate || !validCandidateUrl(record.candidateUrl))
      throw Error("published result requires a candidate URL");
  } else if (record.status === "existing") {
    if (!hasCandidate || !validCandidateUrl(record.candidateUrl))
      throw Error("existing result requires a live-verified candidate URL");
  } else if (hasCandidate) {
    throw Error("candidate URL is not allowed for this status");
  }
  return {
    issue: record.issue,
    version: record.version,
    status: record.status,
    observedAt: record.observedAt,
    issueUrl: record.issueUrl,
    ...(hasCandidate ? { candidateUrl: record.candidateUrl } : {}),
  };
}

export function createResultRecord({
  issue,
  version,
  status,
  observedAt,
  candidateUrl,
  liveVerified = false,
}) {
  if (!Number.isSafeInteger(issue) || issue < 1 || issue > 999999999)
    throw Error("invalid issue number");
  if (typeof version !== "string" || !versionPattern.test(version))
    throw Error("invalid issue version");
  if (!statuses.has(status)) throw Error("invalid review status");
  if (!validTimestamp(observedAt)) throw Error("invalid observation timestamp");
  if (status === "published" && liveVerified !== true)
    throw Error("published result requires live verification");
  const includeCandidate = ["published", "existing"].includes(status) && candidateUrl !== undefined;
  if (["published", "existing"].includes(status) && !includeCandidate)
    throw Error(`${status} result requires a candidate URL`);
  if (includeCandidate && (liveVerified !== true || !validCandidateUrl(candidateUrl)))
    throw Error("candidate URL requires live verification and a canonical candidate URL");
  return validateRecord({
    issue,
    version,
    status,
    observedAt,
    issueUrl: issueBase + issue,
    ...(includeCandidate ? { candidateUrl } : {}),
  });
}

export function validateResultSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot))
    throw Error("invalid snapshot");
  const keys = Object.keys(snapshot).sort();
  if (
    keys.length !== 3 ||
    keys[0] !== "generatedAt" ||
    keys[1] !== "records" ||
    keys[2] !== "schemaVersion"
  )
    throw Error("invalid snapshot fields");
  if (
    snapshot.schemaVersion !== 1 ||
    !validTimestamp(snapshot.generatedAt) ||
    !Array.isArray(snapshot.records)
  )
    throw Error("invalid snapshot metadata");
  const seen = new Set();
  const records = snapshot.records.map(validateRecord);
  for (const record of records) {
    if (seen.has(record.issue)) throw Error("duplicate issue snapshot");
    seen.add(record.issue);
  }
  return { schemaVersion: 1, generatedAt: snapshot.generatedAt, records };
}

export function mergeResultSnapshot(existing, updates, generatedAt) {
  if (!validTimestamp(generatedAt)) throw Error("invalid generation timestamp");
  if (!Array.isArray(updates)) throw Error("invalid result updates");
  const prior =
    existing === null || existing === undefined
      ? { schemaVersion: 1, generatedAt, records: [] }
      : validateResultSnapshot(existing);
  const byIssue = new Map(prior.records.map((record) => [record.issue, record]));
  for (const value of updates) {
    const record = validateRecord(value);
    const previous = byIssue.get(record.issue);
    if (!previous || record.observedAt >= previous.observedAt) byIssue.set(record.issue, record);
  }
  return validateResultSnapshot({
    schemaVersion: 1,
    generatedAt,
    records: [...byIssue.values()].sort((left, right) => left.issue - right.issue),
  });
}

export async function snapshotDeploymentNeeded(snapshot, fetcher = fetch) {
  const expected = validateResultSnapshot(snapshot);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetcher(`${candidateBase}cloud-suggestion-results.json`, {
      credentials: "omit",
      referrerPolicy: "no-referrer",
      cache: "no-store",
      redirect: "error",
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    if (!response.ok) return true;
    const declaredSize = Number(response.headers?.get?.("content-length") || 0);
    if (declaredSize > 1_000_000) return true;
    const content = await response.text();
    if (content.length > 1_000_000) return true;
    const live = validateResultSnapshot(JSON.parse(content));
    return JSON.stringify(live) !== JSON.stringify(expected);
  } catch {
    return true;
  } finally {
    clearTimeout(timeout);
  }
}
