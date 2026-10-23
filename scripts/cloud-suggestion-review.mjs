import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  categoryPolicy,
  evaluateSource,
  fetchSourceFacts,
  githubSource,
  makeSnapshot,
  modelFailureDetails,
  proposeSource,
  reviewPolicyFingerprint,
  sourceEvidence,
  sourceRiskDetected,
  sourceUnchanged,
  verifiedRecovery,
} from "./cloud-source-review.mjs";
import {
  escapeHtml,
  hash,
  locales,
  parseSuggestion,
  renderCandidate,
  repository,
  versionOf,
} from "./github-suggestion-bridge.mjs";
import {
  createResultRecord,
  mergeResultSnapshot,
  snapshotDeploymentNeeded,
  validateResultSnapshot,
} from "./cloud-suggestion-results.mjs";

const base = "https://gfy0.github.io/gfy0";
const branch = "codex/your-no1-pages";
const templateSlug = "candidate-057d6eac-185c-4df9-957b-6ba10a9cce88";
let executionStage = "initialization";
export function failureDetails(error, stage) {
  const stages = [
    "initialization",
    "initial-source-fetch",
    "model-review",
    "persist-model-budget",
    "report-model-failure",
    "source-decision",
    "report-review-held",
    "admission-decision",
    "confirm-submission-version",
    "recheck-source",
    "report-source-unavailable",
    "render-project-pages",
    "report-approved",
    "save-pending",
    "persist-site",
    "finish",
  ];
  const names = ["Error", "TypeError", "SyntaxError", "RangeError", "AbortError"];
  const codes = [
    "UND_ERR_SOCKET",
    "ECONNRESET",
    "EPIPE",
    "UND_ERR_CONNECT_TIMEOUT",
    "UND_ERR_HEADERS_TIMEOUT",
    "ETIMEDOUT",
    "ENOENT",
    "EACCES",
    "ERR_INVALID_URL",
    "ERR_INVALID_ARG_TYPE",
  ];
  const code = error?.cause?.code ?? error?.code;
  return {
    event: "cloud-review-failure",
    stage: stages.includes(stage) ? stage : "other",
    name: names.includes(error?.name) ? error.name : "other",
    code: codes.includes(code) ? code : "other",
    ...(stage === "model-review" && modelFailureDetails(error?.modelFailure)
      ? { model: modelFailureDetails(error.modelFailure) }
      : {}),
  };
}
const normalize = (s) =>
  String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
const sourceKey = (s) => {
  const repo = githubSource(String(s));
  return repo ? `https://github.com/${repo.toLowerCase()}` : String(s).replace(/\/$/, "");
};

export function sourceMatches(source, facts) {
  if (!facts) return false;
  const review = source.review;
  if (
    review?.decision !== "accepted-static-project-profile-only" ||
    review.category !== "software-development-tool" ||
    !["political", "highRisk", "privatePerson", "uncertain"].every((key) => review[key] === false)
  )
    return false;
  const r = facts.repo;
  return Boolean(
    r &&
      r.id === source.id &&
      r.owner?.id === source.ownerId &&
      r.full_name === source.fullName &&
      r.default_branch === source.branch &&
      r.private === false &&
      r.archived === false &&
      r.disabled === false &&
      r.fork === false &&
      r.license?.spdx_id === source.license &&
      facts.commit?.sha === source.commit &&
      facts.readme?.sha === source.readmeSha &&
      facts.license?.sha === source.licenseSha,
  );
}

export function recoveryHold(record, policy, source, facts) {
  if (record?.policy !== policy || !source) return "source-changed";
  if (!facts) return "source-unavailable";
  if (source.review?.policy === categoryPolicy.version && !verifiedRecovery(record, source, facts))
    return "source-changed";
  return sourceMatches(source, facts) ? null : "source-changed";
}

export function decide(input, sources, catalog, facts) {
  const existing = catalog.projects.find((p) => sourceKey(p.source) === sourceKey(input.sourceUrl));
  if (existing) return { status: "existing", slug: existing.path, source: existing };
  const source = sources.find((s) => sourceKey(s.source) === sourceKey(input.sourceUrl));
  if (!source) return { status: "out-of-scope" };
  if (input.name.toLowerCase() !== source.name.toLowerCase()) return { status: "name-mismatch" };
  if (catalog.projects.some((p) => normalize(p.name) === normalize(source.name)))
    return { status: "duplicate-uncertain" };
  if (!facts) return { status: "source-unavailable" };
  if (!sourceMatches(source, facts)) return { status: "source-changed" };
  const hex = hash(`github-repo:${source.id}`);
  const slug = `candidate-${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  return { status: "approved", source, slug };
}

const messages = {
  es: {
    "review-queued":
      "Guardado en la cola: la revisión programada revisa como máximo un proyecto nuevo por hora. Consulta aquí el resultado.",
    "review-failed":
      "La revisión no terminó. Edita esta misma sugerencia para volver a ponerla en cola.",
    "review-held":
      "No incluido: no se pudo confirmar que cumple las categorías y condiciones de revisión automática. Puedes corregir este registro.",
    "out-of-scope":
      "No incluido: la revisión automática acepta repositorios públicos de GitHub de herramientas generales de formato, linting, tipos y compilación.",
    "name-mismatch": "No incluido: corrige el nombre del proyecto y edita este registro.",
    "duplicate-uncertain":
      "No incluido: existe un nombre similar con otra fuente. No se ha fusionado ni duplicado.",
    "source-unavailable":
      "Aún no incluido: la fuente no está disponible para comprobarla. La recuperación en la nube puede reintentarlo.",
    "source-changed":
      "No incluido: cambió la identidad o versión revisada de la fuente; requiere una nueva revisión.",
    "needs-information":
      "Completa los campos y ambas confirmaciones, luego edita este mismo registro.",
    approved: "Fuente verificada; publicación pendiente. La inclusión aún no está confirmada.",
    "deployment-pending":
      "Publicación sin verificar. La tarea en la nube reintentará; no envíes duplicados.",
    published: "已审核并收录 / Reviewed and listed\nRevisado e incluido.",
    existing: "El proyecto ya está incluido; no se creó un duplicado.",
    scope:
      "Revisión gratuita limitada a fuentes concretas, sin pagos. Resultado válido solo para esta versión del registro.",
  },
  ar: {
    "review-queued":
      "حُفظ في قائمة الانتظار: تراجع المهمة المجدولة مشروعًا جديدًا واحدًا كحد أقصى كل ساعة. تابع النتيجة هنا.",
    "review-failed": "لم تكتمل المراجعة. عدّل الاقتراح نفسه لإعادته إلى قائمة الانتظار.",
    "review-held":
      "لم يُدرج: تعذر التأكد من استيفاء فئات وشروط المراجعة التلقائية. يمكنك تعديل هذا السجل.",
    "out-of-scope":
      "لم يُدرج: تدعم المراجعة التلقائية مستودعات GitHub العامة لأدوات تنسيق الشيفرة وفحصها والتحقق من الأنواع والترجمة.",
    "name-mismatch": "لم يُدرج: صحّح اسم المشروع ثم عدّل السجل نفسه.",
    "duplicate-uncertain": "لم يُدرج: يوجد اسم مشابه بمصدر آخر. لم يتم الدمج أو التكرار.",
    "source-unavailable":
      "لم يُدرج بعد: تعذر التحقق من المصدر مؤقتًا. يمكن للمهمة السحابية إعادة المحاولة.",
    "source-changed": "لم يُدرج: تغيّرت هوية المصدر أو نسخته المراجعة، ويلزم فحص جديد.",
    "needs-information": "أكمل الحقول والتأكيدين ثم عدّل السجل نفسه.",
    approved: "اجتاز المصدر التحقق؛ النشر قيد الانتظار. لم يتأكد الإدراج بعد.",
    "deployment-pending": "لم يتأكد النشر. ستعيد المهمة السحابية المحاولة؛ لا ترسل نسخة مكررة.",
    published: "已审核并收录 / Reviewed and listed\nتمت المراجعة والإدراج.",
    existing: "المشروع مدرج بالفعل؛ لم يُنشأ إدراج مكرر.",
    scope: "مراجعة مجانية لمصادر محددة، دون مدفوعات. النتيجة تخص هذه النسخة من السجل فقط.",
  },
  ja: {
    "review-queued":
      "受付済み：クラウドの定期審査で毎時最大1件の新規プロジェクトを審査します。ここで結果を確認できます。",
    "review-failed": "審査が完了しませんでした。同じ投稿を編集すると再び審査待ちになります。",
    "review-held":
      "未掲載：自動審査の対象分類と条件を満たすことを確認できませんでした。この記録を修正できます。",
    "out-of-scope":
      "未掲載：自動審査の対象は、コード整形・静的検査・型検査・コンパイルを行う一般用途ツールの公開 GitHub リポジトリです。",
    "name-mismatch": "未掲載：プロジェクト名を修正し、同じ記録を編集してください。",
    "duplicate-uncertain":
      "未掲載：別の出典で類似の名前が存在します。統合や重複作成は行いませんでした。",
    "source-unavailable":
      "まだ掲載されていません。出典を一時的に確認できないため、クラウドの復旧処理で再試行できます。",
    "source-changed": "未掲載：出典の識別情報または確認済みの版が変わり、再審査が必要です。",
    "needs-information": "必須項目と二つの確認欄を完成させ、同じ記録を編集してください。",
    approved: "出典の確認が完了しました。公開待ちで、掲載はまだ確定していません。",
    "deployment-pending":
      "公開を確認できていません。クラウド処理が再試行します。重複投稿は不要です。",
    published: "已审核并收录 / Reviewed and listed\n審査済み・掲載済み。",
    existing: "すでに掲載されています。重複作成はしていません。",
    scope: "出典を限定した無料審査です。決済はありません。結果はこの投稿の版にのみ適用されます。",
  },
  en: {
    "review-queued":
      "Saved in the queue: scheduled cloud review handles at most one new project per hour. Check the result here.",
    "review-failed": "Review did not finish. Edit this same suggestion to queue it again.",
    "review-held":
      "Not listed: eligibility for the automatic review categories and conditions could not be confirmed. You can correct this same suggestion.",
    "out-of-scope":
      "Not listed: automatic review supports public GitHub repositories for ordinary code formatters, linters, type checkers and compilers.",
    "name-mismatch":
      "Not listed: use the exact project name shown in the eligible sources, then edit this same suggestion.",
    "duplicate-uncertain":
      "Not listed: a similar project name exists with another source. No automatic merge or duplicate listing was made.",
    "source-unavailable":
      "Not listed yet: GitHub source verification is temporarily unavailable. A cloud retry can recover this record.",
    "source-changed":
      "Not listed: the source identity or reviewed content version changed. It needs a new source review; no automatic approval.",
    "needs-information":
      "Not listed: complete the project name, HTTPS source, explanation and both acknowledgements, then edit this same suggestion.",
    approved:
      "Source checks passed. Website deployment is pending; this is not confirmation of a live listing.",
    "deployment-pending":
      "Website publication has not been verified. The suggestion is saved; cloud recovery will retry. Do not submit a duplicate.",
    published: "已审核并收录 / Reviewed and listed",
    existing: "Already listed. No duplicate project was created.",
    scope:
      "Free, limited source review. No payments. Result applies only to this suggestion version; edits require rechecking.",
  },
  "zh-CN": {
    "review-queued": "投稿已保存并排队：云端定时审核每小时最多处理一个新项目，可在这里查看结果。",
    "review-failed": "本次审核未完成。修改本条投稿即可重新排队，无需重复投稿。",
    "review-held":
      "未收录：无法确认符合自动审核的类别和条件。你可以修改本条投稿；不会未经核实直接发布。",
    "out-of-scope":
      "未收录：自动审核目前支持 GitHub 公开仓库中的通用代码格式化、静态检查、类型检查和编译工具。",
    "name-mismatch": "未收录：请使用可收录来源中的准确项目名称，编辑本条投稿后重试。",
    "duplicate-uncertain": "未收录：已有同名项目但来源不同，未自动合并或重复添加。",
    "source-unavailable": "尚未收录：暂时无法核实 GitHub 来源，云端任务可重试恢复。",
    "source-changed": "未收录：来源身份或已审核内容版本发生变化，需要重新核实来源，不会自动放行。",
    "needs-information": "未收录：请补全项目名称、HTTPS 来源、说明和两项确认，再编辑本条投稿。",
    approved: "来源核验通过，正在发布网站；这还不代表已上线收录。",
    "deployment-pending": "尚未验证网站发布成功，投稿已保存，云端恢复任务会重试，请勿重复提交。",
    published: "已审核并收录 / Reviewed and listed",
    existing: "项目已经收录，未重复创建。",
    scope: "免费、限定来源审核，不收款。结果仅对应本次投稿版本，编辑后需要重新核验。",
  },
};

export function mayGenerateProposal(eventName, calls) {
  return (
    ["issues", "schedule", "workflow_dispatch"].includes(eventName) &&
    calls < categoryPolicy.maxModelCallsPerRun
  );
}

class ModelBudgetError extends Error {
  constructor() {
    super("model-budget-unavailable");
    this.name = "ModelBudgetError";
  }
}

export async function runBudgetedProposal({
  eventName,
  calls,
  number,
  queueHead,
  budget,
  now,
  persist,
  generate,
}) {
  if (
    !mayGenerateProposal(eventName, calls) ||
    !Number.isSafeInteger(number) ||
    number < 1 ||
    number !== queueHead
  )
    return null;
  const validHour = (hour) =>
    typeof hour === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}$/.test(hour) &&
    Number.isFinite(Date.parse(`${hour}:00:00.000Z`)) &&
    new Date(`${hour}:00:00.000Z`).toISOString().slice(0, 13) === hour;
  const hour = typeof now === "string" ? now.slice(0, 13) : "";
  if (
    !budget ||
    Object.keys(budget).sort().join("|") !== "hour|version" ||
    budget.version !== 1 ||
    !validHour(budget.hour) ||
    !validHour(hour) ||
    budget.hour > hour
  )
    throw new ModelBudgetError();
  if (budget.hour === hour) return null;
  try {
    await persist({ version: 1, hour });
  } catch {
    throw new ModelBudgetError();
  }
  return generate();
}

const terminalReviewStatuses = new Set([
  "published",
  "existing",
  "out-of-scope",
  "review-held",
  "review-failed",
  "name-mismatch",
  "needs-information",
  "duplicate-uncertain",
  "source-changed",
]);

export function advanceQueueHead(head, number, confirmedStatus) {
  return head === null || terminalReviewStatuses.has(confirmedStatus) ? number : head;
}

export function hasCompletedReview(comments, version, policy) {
  return comments.some(
    (c) =>
      (c.user?.login === "github-actions[bot]" &&
        c.user?.type === "Bot" &&
        c.body?.startsWith(`Your No.1 · Cloud review · ${version.slice(0, 16)}\n`) &&
        c.body.includes(`Policy: ${policy}`) &&
        terminalReviewStatuses.has(c.body.match(/Status: ([a-z-]+)$/)?.[1])) ||
      (c.user?.login === "gfy0" &&
        c.body?.startsWith(`Your No.1 · Review result · ${version.slice(0, 16)}`) &&
        c.body.includes("Reviewed and listed")),
  );
}

export function resultBody(input, status, _source, slug, policy = "") {
  const t = messages[input.locale] || messages.en;
  const link =
    ["published", "existing"].includes(status) && slug
      ? `\n${base}/${input.locale}/candidates/${slug}/`
      : "";
  return `Your No.1 · Cloud review · ${input.version.slice(0, 16)}\n\n${t[status] || t["deployment-pending"]}${link}\n\n${t.scope}\n\n${base}/${input.locale}/submit/?issue=${input.number}\nPolicy: ${policy}\nStatus: ${status}`;
}

export function commitAllowed(file) {
  return (
    ["published-directory.json", "cloud-review-records.json"].includes(file) ||
    /^(en|zh-CN|es|ar|ja)\/discover\/index\.html$/.test(file) ||
    /^(en|zh-CN|es|ar|ja)\/candidates\/candidate-[a-f0-9-]{36}\/index\.html$/.test(file)
  );
}

export function changedPaths(porcelain) {
  return porcelain
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      if (!/^( M|M |\?\?) /.test(line)) throw Error("unexpected-git-status");
      return line.slice(3);
    });
}

export function liveMatches(page, directory, item, locale) {
  const name = escapeHtml(item.source.name);
  const url = escapeHtml(item.source.source);
  const card = directory.match(
    new RegExp(
      `<li class="project-card">(?:(?!<li class="project-card">)[\\s\\S])*?/candidates/${item.slug}\\?from=discover(?:(?!</li>)[\\s\\S])*</li>`,
    ),
  )?.[0];
  if (
    !page.includes(`<h1><bdi>${name}</bdi></h1>`) ||
    !page.includes(`class="primary-link visit-source" href="${url}"`) ||
    !page.includes(`class="source-link" href="${url}"`) ||
    !card?.includes(`<bdi>${name}</bdi>`)
  )
    return false;
  const summary = item.source.summaries?.[locale];
  return (
    typeof summary === "string" &&
    summary.length > 0 &&
    page.includes(`<p class="candidate-summary"><bdi>${escapeHtml(summary)}</bdi></p>`) &&
    card.includes(`<p><bdi>${escapeHtml(summary)}</bdi></p>`)
  );
}

export function selectNumbers(issues) {
  return issues
    .filter(
      (i) =>
        !i.pull_request &&
        i.state === "open" &&
        i.title?.startsWith("[Project suggestion]") &&
        Number.isSafeInteger(i.number) &&
        i.number > 0,
    )
    .sort((a, b) => a.number - b.number)
    .slice(0, 100)
    .map((i) => i.number);
}

export async function selectPendingQueue({ fetchPage, readComments, policy }) {
  const pending = [];
  let previous = 0;
  for (let page = 1; page <= 10; page++) {
    const issues = await fetchPage(page);
    if (!Array.isArray(issues) || issues.length > 100) throw Error("queue-page-invalid");
    for (const issue of issues) {
      if (!Number.isSafeInteger(issue.number) || issue.number <= previous)
        throw Error("queue-order-invalid");
      previous = issue.number;
    }
    const numbers = new Set(selectNumbers(issues));
    for (const issue of issues) {
      if (!numbers.has(issue.number)) continue;
      if (hasCompletedReview(await readComments(issue), versionOf(issue), policy)) continue;
      pending.push(issue.number);
      if (pending.length === 20) return pending;
    }
    if (issues.length < 100) return pending;
  }
  throw Error("queue-scan-limit");
}

function publishProjection(site, decision) {
  const { source, slug } = decision;
  for (const locale of locales) {
    const summary = source.summaries[locale];
    if (!summary) throw Error("missing-reviewed-summary");
    const template = fs.readFileSync(
      path.join(site, locale, "candidates", templateSlug, "index.html"),
      "utf8",
    );
    const detail = { slug, name: source.name, summary, source: { url: source.source } };
    const folder = path.join(site, locale, "candidates", slug);
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(
      path.join(folder, "index.html"),
      renderCandidate(template, templateSlug, detail),
    );
    const discovery = path.join(site, locale, "discover/index.html");
    let html = fs.readFileSync(discovery, "utf8");
    if (!html.includes(`/candidates/${slug}`)) {
      const card = `<li class="project-card"><span class="project-monogram" aria-hidden="true">${escapeHtml(source.name[0])}</span><div><h3><a href="/gfy0/${locale}/candidates/${slug}?from=discover"><bdi>${escapeHtml(source.name)}</bdi></a></h3><p><bdi>${escapeHtml(summary)}</bdi></p></div><span class="project-card-link" aria-hidden="true">↗</span></li>`;
      if (!html.includes('<li class="project-card">')) throw Error("directory-template-changed");
      html = html.replace('<li class="project-card">', `${card}<li class="project-card">`);
      fs.writeFileSync(discovery, html);
    }
  }
}

async function main() {
  if (
    process.env.GITHUB_ACTIONS !== "true" ||
    process.env.GITHUB_REPOSITORY !== repository ||
    process.env.GITHUB_REF !== "refs/heads/main"
  )
    throw Error("cloud-execution-scope-invalid");
  const event = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
  if (event.repository?.full_name !== repository || event.repository?.private !== false)
    throw Error("public-repository-required");
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw Error("scoped-token-required");
  const site = path.resolve(process.env.SITE_DIRECTORY);
  const stateFile = path.join(process.env.RUNNER_TEMP, "your-no1-cloud-review.json");
  const resultQueueFile = path.join(
    process.env.RUNNER_TEMP,
    "your-no1-cloud-result-projections.json",
  );
  if (!fs.existsSync(resultQueueFile)) fs.writeFileSync(resultQueueFile, "[]\n", { mode: 0o600 });
  const pins = JSON.parse(
    fs.readFileSync(new URL("./free-cloud-sources.json", import.meta.url), "utf8"),
  );
  const policy = reviewPolicyFingerprint(pins);
  let activeSourceRepository = null;
  let modelCalls = 0;
  const api = async (method, route, data) => {
    if (
      !route.startsWith(`/repos/${repository}/`) &&
      !(
        method === "GET" &&
        (pins.sources.some(
          (s) => route.startsWith(`/repos/${s.fullName}/`) || route === `/repos/${s.fullName}`,
        ) ||
          (activeSourceRepository &&
            (route === `/repos/${activeSourceRepository}` ||
              (route.startsWith(`/repos/${activeSourceRepository}/`) &&
                /^\/(?:commits\/[^/?#]+|(?:readme|license)\?ref=[a-f0-9]{40})$/.test(
                  route.slice(`/repos/${activeSourceRepository}`.length),
                )))))
      )
    )
      throw Error("api-route-denied");
    const response = await fetch(`https://api.github.com${route}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: data === undefined ? undefined : JSON.stringify(data),
      signal: AbortSignal.timeout(15000),
      redirect: "error",
    });
    if (!response.ok) throw Error(`github-http-${response.status}`);
    const text = await response.text();
    if (text.length > 2_000_000) throw Error("github-response-too-large");
    return text ? JSON.parse(text) : null;
  };
  const own = (method, route, data) => api(method, `/repos/${repository}/${route}`, data);
  const current = async (input) => {
    const issue = await own("GET", `issues/${input.number}`);
    return issue.state === "open" && versionOf(issue) === input.version;
  };
  const comments = async (number) => {
    const data = await own("GET", `issues/${number}/comments?per_page=100`);
    if (!Array.isArray(data) || data.length >= 100) throw Error("comment-limit");
    return data;
  };
  const git = (...args) =>
    execFileSync("git", ["-C", site, ...args], {
      encoding: "utf8",
      timeout: 120000,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
        GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
      },
    }).trimEnd();
  const reportedOutcomes = new Map();
  const report = async (input, status, source, slug, { liveVerified = false } = {}) => {
    if (!(await current(input))) return false;
    const all = await comments(input.number);
    const prior = all.find(
      (c) =>
        c.user?.login === "github-actions[bot]" &&
        c.user?.type === "Bot" &&
        c.body?.startsWith("Your No.1 · Cloud review · "),
    );
    const body = resultBody(input, status, source, slug, policy);
    if (prior?.body !== body)
      await own(
        prior ? "PATCH" : "POST",
        prior ? `issues/comments/${prior.id}` : `issues/${input.number}/comments`,
        { body },
      );
    reportedOutcomes.set(input.number, status);
    const candidateUrl =
      liveVerified && slug && locales.includes(input.locale)
        ? `${base}/${input.locale}/candidates/${slug}/`
        : undefined;
    const record = createResultRecord({
      issue: input.number,
      version: input.version,
      status,
      observedAt: new Date().toISOString(),
      candidateUrl,
      liveVerified,
    });
    const projections = JSON.parse(fs.readFileSync(resultQueueFile, "utf8"));
    if (!Array.isArray(projections)) throw Error("invalid-result-projection-queue");
    projections.push(record);
    fs.writeFileSync(resultQueueFile, `${JSON.stringify(projections)}\n`, { mode: 0o600 });
    return true;
  };
  const live = async (item) => {
    if (!/^candidate-[a-f0-9-]{36}$/.test(item.slug)) return false;
    for (const locale of locales) {
      const page = await fetch(`${base}/${locale}/candidates/${item.slug}/`, {
        redirect: "error",
        signal: AbortSignal.timeout(15000),
        cache: "no-store",
      });
      const directory = await fetch(`${base}/${locale}/discover/`, {
        redirect: "error",
        signal: AbortSignal.timeout(15000),
        cache: "no-store",
      });
      if (
        !page.ok ||
        !directory.ok ||
        !(item.existing
          ? hash((await page.text()).replaceAll("\r\n", "\n")) ===
              hash(
                fs
                  .readFileSync(
                    path.join(site, locale, "candidates", item.slug, "index.html"),
                    "utf8",
                  )
                  .replaceAll("\r\n", "\n"),
              ) && (await directory.text()).includes(`/candidates/${item.slug}`)
          : liveMatches(await page.text(), await directory.text(), item, locale))
      )
        return false;
    }
    return true;
  };
  if (process.argv[2] === "finish") {
    executionStage = "finish";
    const items = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, "utf8")) : [];
    if (!Array.isArray(items)) throw Error("invalid-pending-review-state");
    for (const item of items) {
      let verified = false;
      if (process.env.DEPLOY_RESULT === "success") {
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            verified = await live(item);
          } catch {
            /* Keep the saved suggestion recoverable. */
          }
          if (verified) break;
          if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 10000));
        }
      }
      await report(
        item.input,
        verified ? "published" : "deployment-pending",
        item.source,
        item.slug,
        { liveVerified: verified },
      );
    }
    const projections = JSON.parse(fs.readFileSync(resultQueueFile, "utf8"));
    if (!Array.isArray(projections)) throw Error("invalid-result-projection-queue");
    let snapshotNeedsDeployment = false;
    const snapshotFile = path.join(site, "cloud-suggestion-results.json");
    if (projections.length) {
      const prior = fs.existsSync(snapshotFile)
        ? validateResultSnapshot(JSON.parse(fs.readFileSync(snapshotFile, "utf8")))
        : null;
      const snapshot = mergeResultSnapshot(prior, projections, new Date().toISOString());
      const content = `${JSON.stringify(snapshot, null, 2)}\n`;
      if (!fs.existsSync(snapshotFile) || fs.readFileSync(snapshotFile, "utf8") !== content) {
        if (git("status", "--porcelain", "--untracked-files=all"))
          throw Error("site-checkout-dirty");
        fs.writeFileSync(snapshotFile, content);
        const files = changedPaths(git("status", "--porcelain", "--untracked-files=all"));
        if (files.length !== 1 || files[0] !== "cloud-suggestion-results.json")
          throw Error("unexpected-result-snapshot-file");
        git("add", "--", "cloud-suggestion-results.json");
        git(
          "-c",
          "user.name=github-actions[bot]",
          "-c",
          "user.email=41898282+github-actions[bot]@users.noreply.github.com",
          "commit",
          "-m",
          "Publish public suggestion result snapshot",
        );
        git("push", "origin", `HEAD:refs/heads/${branch}`);
        snapshotNeedsDeployment = true;
      }
      if (!snapshotNeedsDeployment)
        snapshotNeedsDeployment = await snapshotDeploymentNeeded(snapshot, fetch);
    } else if (fs.existsSync(snapshotFile)) {
      const snapshot = validateResultSnapshot(JSON.parse(fs.readFileSync(snapshotFile, "utf8")));
      snapshotNeedsDeployment = await snapshotDeploymentNeeded(snapshot, fetch);
    }
    if (process.env.GITHUB_OUTPUT)
      fs.appendFileSync(process.env.GITHUB_OUTPUT, `snapshot_deploy=${snapshotNeedsDeployment}\n`);
    return;
  }
  if (git("status", "--porcelain")) throw Error("site-checkout-dirty");
  const templates = Object.fromEntries(
    locales.map((locale) => [
      locale,
      JSON.parse(
        fs.readFileSync(
          new URL(`../.github/ISSUE_TEMPLATE/project-${locale}.yml`, import.meta.url),
          "utf8",
        ),
      ),
    ]),
  );
  const catalogFile = path.join(site, "published-directory.json");
  const catalog = JSON.parse(fs.readFileSync(catalogFile, "utf8"));
  const auditFile = path.join(site, "cloud-review-records.json");
  const audit = fs.existsSync(auditFile) ? JSON.parse(fs.readFileSync(auditFile, "utf8")) : [];
  const eventNumber = event.issue?.number;
  const targetNumber = Number(event.inputs?.issue_number);
  // Preserve an immediate receipt even when the bounded queue has older work.
  if (Number.isSafeInteger(eventNumber) && eventNumber > 0) {
    const issue = await own("GET", `issues/${eventNumber}`);
    const all = await comments(eventNumber);
    if (!hasCompletedReview(all, versionOf(issue), policy)) {
      try {
        await report(parseSuggestion(issue, templates), "review-queued");
      } catch {
        // The ordinary queue retains the existing invalid-input handling.
      }
    }
  }
  const numbers = await selectPendingQueue({
    fetchPage: (page) =>
      own("GET", `issues?state=open&sort=created&direction=asc&per_page=100&page=${page}`),
    readComments: (issue) => comments(issue.number),
    policy,
  });
  let queueHead = null;
  const pending = [];
  let handled = 0;
  for (const number of numbers) {
    executionStage = "initialization";
    if (handled >= 20) break;
    const issue = await own("GET", `issues/${number}`);
    if (
      issue.pull_request ||
      issue.state !== "open" ||
      !issue.title?.startsWith("[Project suggestion]")
    )
      continue;
    const all = await comments(number);
    const version = versionOf(issue);
    if (hasCompletedReview(all, version, policy)) continue;
    queueHead = advanceQueueHead(queueHead, number, reportedOutcomes.get(queueHead));
    if (
      process.env.GITHUB_EVENT_NAME === "workflow_dispatch" &&
      Number.isSafeInteger(targetNumber) &&
      targetNumber > 0 &&
      targetNumber !== number
    )
      continue;
    handled++;
    let input;
    try {
      input = parseSuggestion(issue, templates);
    } catch {
      await report({ number, version, locale: "en" }, "needs-information");
      continue;
    }
    if (queueHead !== number) {
      await report(input, "review-queued");
      continue;
    }
    let source = pins.sources.find((s) => sourceKey(s.source) === sourceKey(input.sourceUrl));
    source ||= audit.find(
      (r) =>
        r.issue === number &&
        r.version === version &&
        r.policy === policy &&
        sourceKey(r.acceptedSource?.source) === sourceKey(input.sourceUrl),
    )?.acceptedSource;
    activeSourceRepository = githubSource(input.sourceUrl);
    let facts;
    let snapshot;
    let attestation;
    const alreadyListed = catalog.projects.some(
      (p) => sourceKey(p.source) === sourceKey(input.sourceUrl),
    );
    if (
      (!source && activeSourceRepository && !alreadyListed) ||
      source?.review?.policy === categoryPolicy.version
    ) {
      try {
        executionStage = "initial-source-fetch";
        facts = await fetchSourceFacts(api, input.sourceUrl);
        snapshot = makeSnapshot(input.sourceUrl, facts);
      } catch (error) {
        const unavailable = /github-http-(429|5\d\d)|fetch|timeout|abort/i.test(
          String(error.message),
        );
        executionStage = unavailable ? "report-source-unavailable" : "report-review-held";
        await report(input, unavailable ? "source-unavailable" : "review-held");
        continue;
      }
      if (!source) {
        if (sourceRiskDetected(snapshot) || sourceEvidence(snapshot).length === 0) {
          await report(input, "review-held");
          continue;
        }
        let model;
        try {
          executionStage = "persist-model-budget";
          const budgetFile = path.join(site, "cloud-review-budget.json");
          let budget;
          try {
            budget = JSON.parse(fs.readFileSync(budgetFile, "utf8"));
          } catch {
            throw new ModelBudgetError();
          }
          model = await runBudgetedProposal({
            eventName: process.env.GITHUB_EVENT_NAME,
            calls: modelCalls,
            number,
            queueHead,
            budget,
            now: new Date().toISOString(),
            persist: async (next) => {
              if (git("diff", "--cached", "--name-only")) throw Error("unexpected-index");
              fs.writeFileSync(budgetFile, `${JSON.stringify(next)}\n`);
              git("add", "--", "cloud-review-budget.json");
              if (git("diff", "--cached", "--name-only") !== "cloud-review-budget.json")
                throw Error("unexpected-budget-file");
              git(
                "-c",
                "user.name=github-actions[bot]",
                "-c",
                "user.email=41898282+github-actions[bot]@users.noreply.github.com",
                "commit",
                "-m",
                "Reserve one UTC-hour cloud review allowance",
              );
              git("push", "origin", `HEAD:refs/heads/${branch}`);
            },
            generate: async () => {
              modelCalls++;
              executionStage = "model-review";
              return proposeSource(snapshot);
            },
          });
          if (!model) {
            await report(input, "review-queued");
            continue;
          }
        } catch (error) {
          if (error instanceof ModelBudgetError) throw error;
          console.error(JSON.stringify(failureDetails(error, "model-review")));
          executionStage = "report-model-failure";
          await report(input, "review-failed");
          continue;
        }
        executionStage = "source-decision";
        const proposal = evaluateSource(snapshot, model.proposal, input.name);
        if (proposal.status !== "supported") {
          executionStage = "report-review-held";
          await report(input, "review-held");
          continue;
        }
        source = proposal.source;
        attestation = model.attestation;
      }
    } else if (source) {
      try {
        const prefix = `/repos/${source.fullName}`;
        const [repo, commit, readme, license] = await Promise.all([
          api("GET", prefix),
          api("GET", `${prefix}/commits/${source.branch}`),
          api("GET", `${prefix}/contents/${source.readmePath}?ref=${source.branch}`),
          api("GET", `${prefix}/contents/${source.licensePath}?ref=${source.branch}`),
        ]);
        facts = { repo, commit, readme, license };
      } catch {
        facts = null;
      }
    }
    executionStage = "admission-decision";
    const decision = decide(input, source ? [source] : pins.sources, catalog, facts);
    executionStage = "confirm-submission-version";
    if (!(await current(input))) continue;
    if (decision.status === "existing") {
      const recovered = audit.find(
        (r) => r.issue === number && r.version === version && r.slug === decision.slug,
      );
      const hold = recovered ? recoveryHold(recovered, policy, source, facts) : null;
      if (hold) {
        const existing = { input, source: decision.source, slug: decision.slug, existing: true };
        let alreadyLive = false;
        try {
          alreadyLive = await live(existing);
        } catch {
          /* An obsolete pending acceptance must not be redeployed. */
        }
        if (alreadyLive) {
          await report(input, "existing", decision.source, decision.slug, { liveVerified: true });
          continue;
        }
        await report(input, hold);
        throw Error("obsolete-pending-acceptance");
      }
      const item = {
        input,
        source: recovered ? source : decision.source,
        slug: decision.slug,
        existing: !recovered,
      };
      if (recovered && !source) {
        await report(input, "source-changed");
        continue;
      }
      let verified = false;
      try {
        verified = await live(item);
      } catch {
        /* Redeploy only an audited prior acceptance. */
      }
      if (verified)
        await report(input, recovered ? "published" : "existing", decision.source, decision.slug, {
          liveVerified: true,
        });
      else if (recovered) {
        pending.push(item);
        await report(input, "deployment-pending");
      } else await report(input, "source-unavailable");
      continue;
    }
    if (decision.status !== "approved") {
      await report(input, decision.status);
      continue;
    }
    if (snapshot) {
      let fresh;
      try {
        executionStage = "recheck-source";
        fresh = await fetchSourceFacts(api, input.sourceUrl);
      } catch {
        executionStage = "report-source-unavailable";
        await report(input, "source-unavailable");
        continue;
      }
      if (!sourceUnchanged(snapshot, fresh)) {
        await report(input, "source-changed");
        continue;
      }
    }
    executionStage = "render-project-pages";
    publishProjection(site, decision);
    catalog.projects.push({ name: source.name, source: source.source, path: decision.slug });
    audit.push({
      issue: number,
      version,
      source: source.source,
      repoId: source.id,
      ownerId: source.ownerId,
      commit: source.commit,
      readmeSha: source.readmeSha,
      licenseSha: source.licenseSha,
      policy,
      slug: decision.slug,
      decision: "accepted-for-static-directory",
      actor: "github-actions[bot]",
      run: `https://github.com/${repository}/actions/runs/${process.env.GITHUB_RUN_ID}`,
      reviewedAt: new Date().toISOString(),
      ...(snapshot
        ? { acceptedSource: source, snapshotHash: snapshot.hash, modelAttestation: attestation }
        : {}),
    });
    pending.push({ input, source, slug: decision.slug });
    executionStage = "report-approved";
    await report(input, "approved", source);
  }
  executionStage = "save-pending";
  fs.writeFileSync(stateFile, JSON.stringify(pending));
  if (pending.length) {
    executionStage = "persist-site";
    for (const item of pending)
      if (!(await current(item.input))) throw Error("suggestion-changed-before-commit");
    fs.writeFileSync(catalogFile, `${JSON.stringify(catalog, null, 2)}\n`);
    fs.writeFileSync(auditFile, `${JSON.stringify(audit, null, 2)}\n`);
    const files = changedPaths(git("status", "--porcelain", "--untracked-files=all"));
    if (!files.every(commitAllowed)) throw Error("unexpected-site-file");
    if (files.length) {
      git("add", "--", ...files);
      git(
        "-c",
        "user.name=github-actions[bot]",
        "-c",
        "user.email=41898282+github-actions[bot]@users.noreply.github.com",
        "commit",
        "-m",
        "Publish source-verified free project suggestions",
      );
      git("push", "origin", `HEAD:refs/heads/${branch}`);
    }
  }
  fs.appendFileSync(
    process.env.GITHUB_OUTPUT,
    `deploy=${pending.length > 0 || process.env.GITHUB_EVENT_NAME === "workflow_dispatch"}\n`,
  );
  console.log(
    JSON.stringify({
      handled,
      approvedOrRecovering: pending.length,
      hostedModelCalls: modelCalls,
      payments: false,
    }),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error) => {
    console.error(JSON.stringify(failureDetails(error, executionStage)));
    console.error("Cloud review failed; saved suggestions remain available.");
    process.exitCode = 1;
  });
