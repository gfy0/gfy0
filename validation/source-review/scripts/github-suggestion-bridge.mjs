import { createHash } from "node:crypto";

export const repository = "gfy0/gfy0";
export const locales = ["en", "zh-CN", "es", "ar", "ja"];
export function renderDirectoryEntry(locale) {
  if (!locales.includes(locale)) throw Error("entry-locale-invalid");
  const labels = {
    en: "Explore projects",
    "zh-CN": "发现项目",
    es: "Explorar proyectos",
    ar: "استكشف المشاريع",
    ja: "プロジェクトを探す",
  };
  const target = `/gfy0/${locale}/discover/`;
  return `<!doctype html>
<html lang="${locale}" dir="${locale === "ar" ? "rtl" : "ltr"}">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Your No.1</title><link rel="canonical" href="https://gfy0.github.io${target}">
<link rel="stylesheet" href="/gfy0/migration.css"></head>
<body><main><h1>Your No.1</h1><p><a href="${target}">${labels[locale]}</a></p></main>
<script>location.replace(${JSON.stringify(target)} + location.search + location.hash);</script>
</body></html>
`;
}
export const hash = (value) => createHash("sha256").update(value).digest("hex");
export const versionOf = (issue) => hash(JSON.stringify([issue.title, issue.body]));
export function preservesPublishedResult(previous, status) {
  return (
    status !== "published" &&
    typeof previous === "string" &&
    previous.includes("\n已审核并收录 / Reviewed and listed\n")
  );
}
export function publishedCatalog(catalog, detail, commit) {
  if (!/^[a-f0-9]{40}$/.test(commit)) throw Error("release-commit-invalid");
  const next = structuredClone(catalog);
  const entry = next.projects.find((project) => project.path === detail.slug);
  if (entry && (entry.name !== detail.name || entry.source !== detail.source.url))
    throw Error("published-index-conflict");
  if (!entry)
    next.projects.push({ name: detail.name, source: detail.source.url, path: detail.slug });
  next.sourceCommit = commit;
  return next;
}
export function recoveryOutcome(report) {
  if (report.siteVerified && report.indexCommit) return "published";
  if (report.siteVerified) return "site-live-pending";
  return report.pagesPushed ? "release-pending" : report.error;
}
export function requireRemoteBaseline(git, branch) {
  git("fetch", "origin", branch);
  if (git("rev-parse", "HEAD") !== git("rev-parse", "FETCH_HEAD"))
    throw Error("release-branch-not-at-remote-baseline");
}
export function parseSuggestion(issue, templates) {
  if (
    issue.pull_request ||
    issue.state !== "open" ||
    !Number.isSafeInteger(issue.number) ||
    issue.number < 1 ||
    !issue.title?.startsWith("[Project suggestion]") ||
    typeof issue.body !== "string" ||
    issue.body.length > 12000
  )
    throw Error("suggestion-invalid");
  const parts = issue.body.split(/^### (.+)\r?$/m);
  const fields = new Map();
  for (let i = 1; i < parts.length; i += 2) {
    if (fields.has(parts[i].trim())) throw Error("suggestion-duplicate-field");
    fields.set(parts[i].trim(), parts[i + 1].trim());
  }
  const matching = Object.keys(templates).filter((locale) =>
    templates[locale].body.some((f) => f.id === "project-name" && fields.has(f.attributes.label)),
  );
  if (matching.length !== 1) throw Error("suggestion-template-invalid");
  const locale = matching[0];
  const values = {};
  for (const field of templates[locale].body.filter((f) => f.id)) {
    const value = fields.get(field.attributes.label);
    if (
      !value ||
      value === "_No response_" ||
      value.length > (field.id === "project-name" ? 200 : 4000)
    )
      throw Error("suggestion-needs-information");
    if (
      ["public-disclosure", "not-listed"].includes(field.id) &&
      !value
        .split(/\r?\n/)
        .some(
          (line) =>
            line.replace(/^- \[X\]/, "- [x]") === `- [x] ${field.attributes.options[0].label}`,
        )
    )
      throw Error("suggestion-acknowledgement-required");
    values[field.id] = value;
  }
  if (!values["not-listed"] || !values["public-disclosure"])
    throw Error("suggestion-acknowledgement-required");
  const url = new URL(values["official-url"]);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    url.hash ||
    /\s/.test(values["official-url"]) ||
    !url.hostname.includes(".") ||
    /(^localhost$|\.localhost$|\.local$|^[\d.]+$|:)/i.test(url.hostname)
  )
    throw Error("suggestion-source-invalid");
  return {
    number: issue.number,
    locale,
    version: versionOf(issue),
    name: values["project-name"],
    sourceUrl: url.href,
    noneOfTheseConfirmed: true,
  };
}
export function requestKey(input) {
  const hex = hash(`${repository}:${input.number}:${input.version}`);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
export function guardVersion(database, assertCurrent) {
  return {
    query: database.query.bind(database),
    transaction: (work) =>
      database.transaction(async (tx) => {
        await assertCurrent();
        const result = await work(tx);
        await assertCurrent();
        return result;
      }),
  };
}
export const escapeHtml = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
export function renderCandidate(template, oldSlug, detail) {
  if (
    !/^candidate-[a-f0-9-]{36}$/.test(detail.slug) ||
    !detail.name ||
    !detail.summary ||
    new URL(detail.source.url).protocol !== "https:"
  )
    throw Error("public-projection-invalid");
  const replace = (html, pattern, replacement) => {
    if (!pattern.test(html)) throw Error("static-template-changed");
    return html.replace(pattern, () => replacement);
  };
  let html = template.replaceAll(oldSlug, detail.slug);
  html = replace(
    html,
    /<title>[^<]*<\/title>/,
    `<title>${escapeHtml(detail.name)} — Your No.1</title>`,
  );
  html = replace(
    html,
    /<h1><bdi>[^<]*<\/bdi><\/h1>/,
    `<h1><bdi>${escapeHtml(detail.name)}</bdi></h1>`,
  );
  html = replace(
    html,
    /<p class="candidate-summary"><bdi>[\s\S]*?<\/bdi><\/p>/,
    `<p class="candidate-summary"><bdi>${escapeHtml(detail.summary)}</bdi></p>`,
  );
  html = replace(
    html,
    /<span class="project-monogram detail-monogram" aria-hidden="true">[^<]*<\/span>/,
    `<span class="project-monogram detail-monogram" aria-hidden="true">${escapeHtml(Array.from(detail.name)[0])}</span>`,
  );
  html = replace(
    html,
    /<a class="primary-link visit-source" href="[^"]*"/,
    `<a class="primary-link visit-source" href="${escapeHtml(detail.source.url)}"`,
  );
  html = replace(
    html,
    /<a class="source-link" href="[^"]*"([^>]*)><bdi>[^<]*<\/bdi>/,
    `<a class="source-link" href="${escapeHtml(detail.source.url)}" rel="noreferrer" target="_blank"><bdi>${escapeHtml(new URL(detail.source.url).hostname)}</bdi>`,
  );
  return html;
}
