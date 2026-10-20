import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CANDIDATE_REVIEW_SOURCE_MAX_CHARACTERS,
  evaluateAutomatedCandidateReview,
} from "../packages/domain/src/automated-candidate-review.ts";

export const categoryPolicy = {
  version: "github-development-tools-1",
  maxReadmeCharacters: CANDIDATE_REVIEW_SOURCE_MAX_CHARACTERS,
  maxModelCallsPerRun: 1,
  kinds: ["code-formatter", "static-linter", "type-checker", "compiler"],
  licenses: [
    "MIT",
    "Apache-2.0",
    "BSD-2-Clause",
    "BSD-3-Clause",
    "ISC",
    "MPL-2.0",
    "GPL-3.0",
    "GPL-3.0-only",
    "GPL-3.0-or-later",
  ],
};
const digest = (value) => createHash("sha256").update(value).digest("hex");
const sha = /^[a-f0-9]{40}$/;
const kinds = {
  "code-formatter": /\b(?:code formatter|code formatting|formats? (?:source )?code)\b/i,
  "static-linter": /\b(?:linter|linting)\b/i,
  "type-checker": /\b(?:type checker|type checking|type-checker|type-checking)\b/i,
  compiler: /\bcompiler\b/i,
};
const summaries = {
  "code-formatter": [
    "An open-source code formatting tool.",
    "开源代码格式化工具。",
    "Herramienta de código abierto para dar formato al código.",
    "أداة مفتوحة المصدر لتنسيق الشيفرة.",
    "オープンソースのコード整形ツール。",
  ],
  "static-linter": [
    "An open-source tool for checking source code.",
    "用于检查源代码的开源工具。",
    "Herramienta de código abierto para comprobar código fuente.",
    "أداة مفتوحة المصدر لفحص الشيفرة المصدرية.",
    "ソースコードを検査するオープンソースツール。",
  ],
  "type-checker": [
    "An open-source type-checking tool.",
    "开源类型检查工具。",
    "Herramienta de código abierto para comprobar tipos.",
    "أداة مفتوحة المصدر للتحقق من الأنواع.",
    "オープンソースの型検査ツール。",
  ],
  compiler: [
    "An open-source compiler.",
    "开源编译器。",
    "Compilador de código abierto.",
    "مُصرّف مفتوح المصدر.",
    "オープンソースのコンパイラ。",
  ],
};
const sensitive =
  /\b(?:political|elections?|voters?|campaign volunteers|weapon|ransomware|malware|phishing|credential theft|penetration testing|exploit development|surveillance|casino|gambling|pornography|medical diagnosis|investment advice)\b/i;
const instructions =
  /(?:ignore|disregard|override)\s+(?:all\s+)?(?:previous|prior|system|above)\s+instructions|system\s*prompt|output\s+(?:only\s+)?(?:approval|approved)|<\|(?:system|assistant|im_start)\|>/i;
const sameKeys = (value, expected) =>
  value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).sort().join("|") === [...expected].sort().join("|");

export function githubSource(url) {
  if (typeof url !== "string") return null;
  const match =
    /^https:\/\/github\.com\/([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9][A-Za-z0-9._-]{0,99})\/?$/.exec(
      url,
    );
  if (!match || match[2].endsWith(".git") || match[2].includes("..")) return null;
  return `${match[1]}/${match[2]}`;
}

function decodeFile(file, limit) {
  if (
    file?.type !== "file" ||
    file.encoding !== "base64" ||
    !sha.test(file.sha) ||
    typeof file.path !== "string" ||
    !/^[A-Za-z0-9._/-]+$/.test(file.path) ||
    file.path.includes("..")
  )
    throw Error("invalid-source-file");
  if (
    !Number.isSafeInteger(file.size) ||
    file.size < 1 ||
    file.size > limit * 4 ||
    typeof file.content !== "string" ||
    file.content.length > limit * 6
  )
    throw Error("source-file-too-large");
  const bytes = Buffer.from(file.content, "base64");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (
    bytes.length !== file.size ||
    !text.trim() ||
    text.length > limit ||
    [...text].some((char) => char.charCodeAt(0) < 32 && ![9, 10, 13].includes(char.charCodeAt(0)))
  )
    throw Error("invalid-source-text");
  return text;
}

export function makeSnapshot(url, facts) {
  const fullName = githubSource(url);
  const r = facts?.repo;
  if (
    !fullName ||
    !r ||
    r.full_name?.toLowerCase() !== fullName.toLowerCase() ||
    !githubSource(`https://github.com/${r.full_name}`) ||
    !Number.isSafeInteger(r.id) ||
    r.id <= 0 ||
    !Number.isSafeInteger(r.owner?.id) ||
    r.owner.id <= 0 ||
    r.owner.type !== "Organization" ||
    r.owner.login?.toLowerCase() !== fullName.split("/")[0].toLowerCase() ||
    !r.name ||
    r.full_name.split("/")[1] !== r.name ||
    typeof r.default_branch !== "string" ||
    !r.default_branch ||
    r.private !== false ||
    r.fork !== false ||
    r.archived !== false ||
    r.disabled !== false ||
    !categoryPolicy.licenses.includes(r.license?.spdx_id) ||
    !sha.test(facts.commit?.sha)
  )
    throw Error("source-ineligible");
  const text = decodeFile(facts.readme, categoryPolicy.maxReadmeCharacters);
  decodeFile(facts.license, 40000);
  const snapshot = {
    fullName: r.full_name,
    id: r.id,
    ownerId: r.owner.id,
    ownerLogin: r.owner.login,
    ownerType: r.owner.type,
    name: r.name,
    branch: r.default_branch,
    commit: facts.commit.sha,
    readmePath: facts.readme.path,
    readmeSha: facts.readme.sha,
    licensePath: facts.license.path,
    licenseSha: facts.license.sha,
    license: r.license.spdx_id,
    source: `https://github.com/${r.full_name}`,
    text,
  };
  snapshot.hash = digest(JSON.stringify(snapshot));
  const h = snapshot.hash;
  snapshot.sourceId = `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
  return snapshot;
}

export function sourceUnchanged(snapshot, facts) {
  try {
    return makeSnapshot(snapshot.source, facts).hash === snapshot.hash;
  } catch {
    return false;
  }
}

export function sourceRiskDetected(snapshot) {
  return sensitive.test(snapshot.text) || instructions.test(snapshot.text);
}

export function evaluateSource(snapshot, proposal, submittedName) {
  const held = { status: "review-held" };
  if (
    !sameKeys(proposal, ["snapshotHash", "toolKind", "review"]) ||
    proposal.snapshotHash !== snapshot.hash ||
    !categoryPolicy.kinds.includes(proposal.toolKind) ||
    sourceRiskDetected(snapshot)
  )
    return held;
  const domain = evaluateAutomatedCandidateReview(
    { sourceId: snapshot.sourceId, textPreview: snapshot.text },
    proposal.review,
  );
  if (
    domain.status !== "supported-proposal" ||
    !kinds[proposal.toolKind].test(domain.summary) ||
    typeof submittedName !== "string" ||
    domain.name.toLowerCase() !== snapshot.name.toLowerCase() ||
    submittedName.toLowerCase() !== snapshot.name.toLowerCase()
  )
    return held;
  if (
    /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|\b(?:\d{1,3}\.){3}\d{1,3}\b/i.test(
      `${domain.name} ${domain.summary}`,
    )
  )
    return held;
  const { text, hash, sourceId, ...source } = snapshot;
  return {
    status: "supported",
    domain,
    source: {
      ...source,
      name: domain.name,
      summaries: Object.fromEntries(
        ["en", "zh-CN", "es", "ar", "ja"].map((locale, i) => [
          locale,
          summaries[proposal.toolKind][i],
        ]),
      ),
      review: {
        decision: "accepted-static-project-profile-only",
        category: "software-development-tool",
        political: false,
        highRisk: false,
        privatePerson: false,
        uncertain: false,
        policy: categoryPolicy.version,
        toolKind: proposal.toolKind,
        snapshotHash: hash,
        sourceId,
        evidence: `https://github.com/${source.fullName}/blob/${source.commit}/${source.readmePath}`,
        nameQuote: domain.name,
        summaryQuote: domain.summary,
      },
    },
  };
}

export async function fetchSourceFacts(api, url) {
  const fullName = githubSource(url);
  if (!fullName) throw Error("unsupported-source");
  const prefix = `/repos/${fullName}`;
  const repo = await api("GET", prefix);
  if (
    repo.private !== false ||
    repo.disabled !== false ||
    repo.archived !== false ||
    repo.fork !== false ||
    !categoryPolicy.licenses.includes(repo.license?.spdx_id)
  )
    throw Error("source-ineligible");
  const commit = await api("GET", `${prefix}/commits/${encodeURIComponent(repo.default_branch)}`);
  if (!sha.test(commit.sha)) throw Error("invalid-source-commit");
  const [readme, license] = await Promise.all([
    api("GET", `${prefix}/readme?ref=${commit.sha}`),
    api("GET", `${prefix}/license?ref=${commit.sha}`),
  ]);
  return { repo, commit, readme, license };
}

export function validModelReport(report, inputHash) {
  return (
    report?.status === "PROPOSAL_ONLY" &&
    report.inputSha256 === inputHash &&
    report.model === "gpt-oss-safeguard:20b" &&
    report.runtime === "v0.40.6" &&
    report.runtimeSha256 === "c164ab8b1b28e2a247c29719b8e404c423c5b83ae64c3ab4e59d50c7ff7fc5e0" &&
    report.canonicalManifestSha256 ===
      "f2e795d0099c05eb8231a96445e6d2440aa381e1c03a1e3b3cb1f2cec296adff" &&
    report.doneReason === "stop" &&
    Number.isSafeInteger(report.promptTokens) &&
    report.promptTokens > 0 &&
    report.promptTokens < 7168 &&
    report.cleanupVerified === true &&
    report.serverStopped === true
  );
}

export function modelInput(snapshot) {
  return JSON.stringify({
    snapshotHash: snapshot.hash,
    sourceId: snapshot.sourceId,
    name: snapshot.name,
    text: snapshot.text,
  });
}

export function verifiedRecovery(record, source, facts) {
  try {
    const snapshot = makeSnapshot(source.source, facts);
    if (
      record.snapshotHash !== snapshot.hash ||
      source.review.snapshotHash !== snapshot.hash ||
      source.review.sourceId !== snapshot.sourceId ||
      source.review.policy !== categoryPolicy.version ||
      JSON.stringify(record.acceptedSource) !== JSON.stringify(source)
    )
      return false;
    for (const [key, value] of Object.entries({
      source: snapshot.source,
      repoId: snapshot.id,
      ownerId: snapshot.ownerId,
      commit: snapshot.commit,
      readmeSha: snapshot.readmeSha,
      licenseSha: snapshot.licenseSha,
    }))
      if (record[key] !== value) return false;
    if (
      !validModelReport(
        { ...record.modelAttestation, status: "PROPOSAL_ONLY" },
        digest(modelInput(snapshot)),
      )
    )
      return false;
    const result = evaluateSource(
      snapshot,
      {
        snapshotHash: snapshot.hash,
        toolKind: source.review.toolKind,
        review: {
          category: "general",
          uncertain: false,
          nameQuote: source.review.nameQuote,
          summaryQuote: source.review.summaryQuote,
        },
      },
      source.name,
    );
    return (
      result.status === "supported" && JSON.stringify(result.source) === JSON.stringify(source)
    );
  } catch {
    return false;
  }
}

export function reviewPolicyFingerprint(pins) {
  const files = [
    "./cloud-suggestion-review.mjs",
    "./cloud-source-review.mjs",
    "./cloud-source-model.py",
    "./cloud_model_manifest.py",
    "../spec/cloud-model-metadata.json",
    "../spec/cloud-model-canonical.json",
    "../packages/domain/src/automated-candidate-review.ts",
  ];
  return digest(
    JSON.stringify(pins) +
      JSON.stringify(categoryPolicy) +
      files.map((file) => fs.readFileSync(new URL(file, import.meta.url), "utf8")).join("\n"),
  ).slice(0, 16);
}

export function proposeSource(snapshot) {
  if (process.env.GITHUB_ACTIONS !== "true" || process.env.GITHUB_REPOSITORY !== "gfy0/gfy0")
    throw Error("cloud-only-model");
  const file = path.join(process.env.RUNNER_TEMP, "your-no1-cloud-source-request.json");
  const input = modelInput(snapshot);
  fs.writeFileSync(file, input, { flag: "wx", mode: 0o600 });
  try {
    const env = Object.fromEntries(
      ["PATH", "RUNNER_TEMP", "GITHUB_ACTIONS", "GITHUB_REPOSITORY", "GITHUB_EVENT_NAME"].map(
        (key) => [key, process.env[key]],
      ),
    );
    const raw = execFileSync(
      "python3",
      ["-B", fileURLToPath(new URL("./cloud-source-model.py", import.meta.url)), file],
      {
        env,
        encoding: "utf8",
        timeout: 1130000,
        maxBuffer: 64000,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const report = JSON.parse(raw);
    if (!validModelReport(report, digest(input))) throw Error("unverified-model-result");
    return {
      proposal: report.proposal,
      attestation: {
        model: report.model,
        runtime: report.runtime,
        runtimeSha256: report.runtimeSha256,
        canonicalManifestSha256: report.canonicalManifestSha256,
        inputSha256: report.inputSha256,
        promptTokens: report.promptTokens,
        doneReason: report.doneReason,
        cleanupVerified: report.cleanupVerified,
        serverStopped: report.serverStopped,
      },
    };
  } finally {
    fs.unlinkSync(file);
  }
}
