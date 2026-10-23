/* Public suggestion records only. No credentials, payment state or automatic publication. */
(function () {
  "use strict";
  const repository = "https://github.com/gfy0/gfy0/issues/";
  const api = "https://api.github.com/repos/gfy0/gfy0/issues/";
  function parseIssueNumber(value) {
    const text = String(value).trim();
    const match =
      /^(?:#)?([1-9]\d{0,8})$/.exec(text) ||
      /^https:\/\/github\.com\/gfy0\/gfy0\/issues\/([1-9]\d{0,8})\/?$/.exec(text);
    return match ? Number(match[1]) : null;
  }
  async function request(url, fetcher) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetcher(url, {
        credentials: "omit",
        referrerPolicy: "no-referrer",
        signal: controller.signal,
        headers: { Accept: "application/vnd.github+json" },
      });
      if (!response.ok)
        throw Error(
          response.status === 404
            ? "not-found"
            : [403, 429].includes(response.status)
              ? "rate-limited"
              : "unavailable",
        );
      return await response.json();
    } finally {
      clearTimeout(timeout);
    }
  }
  function isOfficialReview(reply) {
    return (
      typeof reply?.body === "string" &&
      ((reply.user?.login === "gfy0" &&
        /^Your No\.1 · Review result · [a-f0-9]{16}$/.test(reply.body.split(/\r?\n/, 1)[0])) ||
        (reply.user?.login === "github-actions[bot]" &&
          reply.user?.type === "Bot" &&
          /^Your No\.1 · Cloud review · [a-f0-9]{16}$/.test(reply.body.split(/\r?\n/, 1)[0])))
    );
  }
  async function issueVersion(issue) {
    const bytes = new TextEncoder().encode(JSON.stringify([issue.title, issue.body]));
    const hash = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  const reviewStatuses = new Set([
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
  function isCurrentReview(reply, version) {
    return (
      typeof version === "string" &&
      /^[a-f0-9]{16}$/.test(version) &&
      isOfficialReview(reply) &&
      reply.body.split(/\r?\n/, 1)[0].endsWith(" · " + version)
    );
  }
  function reviewFor(replies, version, complete) {
    if (!complete) return null;
    const reply = replies.filter((r) => isCurrentReview(r, version)).at(-1);
    if (!reply) return null;
    const urls = [
      ...reply.body.matchAll(
        /^https:\/\/gfy0\.github\.io\/gfy0\/(?:en|zh-CN|es|ar|ja)\/candidates\/candidate-[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}\/$/gm,
      ),
    ];
    if (reply.user.login === "gfy0") {
      const listed = [...reply.body.matchAll(/^已审核并收录 \/ Reviewed and listed$/gm)];
      return listed.length === 1 && urls.length === 1
        ? { status: "published", url: urls[0][0] }
        : null;
    }
    const states = [...reply.body.matchAll(/^Status: ([a-z-]+)$/gm)];
    const policies = [...reply.body.matchAll(/^Policy: [a-f0-9]{16}$/gm)];
    if (states.length !== 1 || policies.length !== 1 || !reviewStatuses.has(states[0][1]))
      return null;
    const status = states[0][1];
    if (["published", "existing"].includes(status))
      return urls.length === 1 ? { status, url: urls[0][0] } : null;
    return { status, url: null };
  }
  function validSnapshotTimestamp(value) {
    return (
      typeof value === "string" &&
      /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) &&
      !Number.isNaN(Date.parse(value)) &&
      new Date(value).toISOString() === value
    );
  }
  function validSnapshotRecord(record, number) {
    const statuses = [
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
    ];
    if (
      !record ||
      typeof record !== "object" ||
      Array.isArray(record) ||
      record.issue !== number ||
      record.issueUrl !== repository + number ||
      typeof record.version !== "string" ||
      !/^[a-f0-9]{64}$/.test(record.version) ||
      !statuses.includes(record.status) ||
      !validSnapshotTimestamp(record.observedAt)
    )
      return false;
    const keys = Object.keys(record).sort();
    const expected = ["issue", "issueUrl", "observedAt", "status", "version"];
    if (Object.hasOwn(record, "candidateUrl")) expected.push("candidateUrl");
    expected.sort();
    if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index]))
      return false;
    const candidate =
      typeof record.candidateUrl === "string" &&
      /^https:\/\/gfy0\.github\.io\/gfy0\/(?:en|zh-CN|es|ar|ja)\/candidates\/candidate-[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}\/$/.test(
        record.candidateUrl,
      );
    if (["published", "existing"].includes(record.status))
      return Object.hasOwn(record, "candidateUrl") && candidate;
    if (Object.hasOwn(record, "candidateUrl")) return record.status === "existing" && candidate;
    return true;
  }
  function parseResultSnapshot(snapshot, number) {
    if (
      !snapshot ||
      typeof snapshot !== "object" ||
      Array.isArray(snapshot) ||
      Object.keys(snapshot).sort().join(",") !== "generatedAt,records,schemaVersion" ||
      snapshot.schemaVersion !== 1 ||
      !validSnapshotTimestamp(snapshot.generatedAt) ||
      !Array.isArray(snapshot.records)
    )
      return null;
    const seen = new Set();
    for (const record of snapshot.records) {
      if (
        !Number.isSafeInteger(record?.issue) ||
        record.issue < 1 ||
        seen.has(record.issue) ||
        !validSnapshotRecord(record, record.issue)
      )
        return null;
      seen.add(record.issue);
    }
    return snapshot.records.find((record) => record.issue === number) || null;
  }
  async function loadSnapshotRecord(
    number,
    fetcher = fetch,
    snapshotUrl = "../../cloud-suggestion-results.json",
  ) {
    if (parseIssueNumber(number) !== number) throw Error("invalid-number");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetcher(snapshotUrl, {
        credentials: "omit",
        referrerPolicy: "no-referrer",
        cache: "no-store",
        signal: controller.signal,
        headers: { Accept: "application/json" },
      });
      if (!response.ok) return null;
      return parseResultSnapshot(await response.json(), number);
    } finally {
      clearTimeout(timeout);
    }
  }
  async function lookupWithSnapshot(
    number,
    issueLoader = loadIssue,
    snapshotLoader = loadSnapshotRecord,
  ) {
    try {
      const live = await issueLoader(number);
      let snapshot = null;
      if (!live.review) {
        try {
          snapshot = await snapshotLoader(number);
        } catch {
          /* The public issue remains available without a snapshot. */
        }
      }
      return { live, snapshot };
    } catch (error) {
      if (["invalid-number", "not-found"].includes(error?.message)) throw error;
      let snapshot = null;
      try {
        snapshot = await snapshotLoader(number);
      } catch {
        /* Keep the original GitHub failure if the same-origin file is unavailable. */
      }
      if (!snapshot) throw error;
      return { live: null, snapshot };
    }
  }
  async function loadIssue(number, fetcher = fetch) {
    if (parseIssueNumber(number) !== number) throw Error("invalid-number");
    const issue = await request(api + number, fetcher);
    if (
      !issue ||
      issue.number !== number ||
      issue.html_url !== repository + number ||
      issue.pull_request ||
      !["open", "closed"].includes(issue.state) ||
      typeof issue.title !== "string"
    )
      throw Error("invalid-response");
    const result = { issue, replies: [], repliesUnavailable: false, review: null, version: null };
    try {
      result.version = await issueVersion(issue);
    } catch {
      /* Never infer review state without an exact version. */
    }
    const version = result.version?.slice(0, 16) || null;
    if (Number.isSafeInteger(issue.comments) && issue.comments > 0) {
      try {
        const replies = await request(api + number + "/comments?per_page=100&page=1", fetcher);
        if (!Array.isArray(replies)) throw Error("invalid-response");
        const first = replies.slice(0, 100).filter((reply) => typeof reply?.body === "string");
        if (replies.length < Math.min(issue.comments, 100) || issue.comments > 105)
          result.repliesUnavailable = true;
        result.replies = first.slice(-5);
        let reviewed =
          first.filter((r) => isCurrentReview(r, version)).at(-1) ||
          first.filter(isOfficialReview).at(-1);
        if (issue.comments > 100) {
          try {
            const tail = await request(
              api + number + "/comments?per_page=5&page=" + Math.ceil(issue.comments / 5),
              fetcher,
            );
            if (!Array.isArray(tail)) throw Error("invalid-response");
            if (tail.length < ((issue.comments - 1) % 5) + 1) result.repliesUnavailable = true;
            result.replies = tail.slice(0, 5).filter((reply) => typeof reply?.body === "string");
            reviewed = result.replies.filter((r) => isCurrentReview(r, version)).at(-1) || reviewed;
          } catch {
            result.repliesUnavailable = true;
          }
        }
        if (reviewed && !result.replies.some((reply) => reply.id === reviewed.id))
          result.replies.unshift(reviewed);
        result.review = reviewFor(result.replies, version, !result.repliesUnavailable);
      } catch {
        result.repliesUnavailable = true;
      }
    }
    return result;
  }
  if (typeof module !== "undefined")
    module.exports = {
      parseIssueNumber,
      loadIssue,
      issueVersion,
      reviewFor,
      loadSnapshotRecord,
      parseResultSnapshot,
      lookupWithSnapshot,
    };
  if (typeof document === "undefined") return;
  const translations = {
    en: [
      "View your suggestion",
      "Paste the issue number or its GitHub link. Keep this link to return on another device.",
      "Issue number or link",
      "e.g. 2 or https://github.com/gfy0/gfy0/issues/2",
      "View result",
      "Loading…",
      "Open record",
      "Closed record",
      "Completed",
      "Not planned",
      "Reopened",
      "No closure reason provided",
      "This is the public GitHub record status. It does not mean the project has been added to the directory.",
      "Updated",
      "Suggestion",
      "Review and recent replies",
      "Read the complete record or reply on GitHub",
      "Share this result",
      "Enter a positive issue number or a link from github.com/gfy0/gfy0/issues.",
      "Record not found. Check the number or open GitHub.",
      "GitHub has limited this lookup. No automatic retry will occur; use the original record below.",
      "Unable to read GitHub right now. Your saved suggestion is unchanged. Open the original record or try later.",
      "Some replies were not read. Open GitHub for the complete record.",
      "No replies yet.",
      "No description provided.",
    ],
    "zh-CN": [
      "查看投稿结果",
      "输入投稿编号或 GitHub 记录链接。保存结果页链接，换设备也能继续查看。",
      "投稿编号或记录链接",
      "例如 2，或 https://github.com/gfy0/gfy0/issues/2",
      "查看结果",
      "正在读取…",
      "记录开启",
      "记录已关闭",
      "已完成",
      "未计划处理",
      "重新开启",
      "未提供关闭原因",
      "这是 GitHub 公开记录的状态，不代表项目已被目录收录。",
      "更新时间",
      "投稿内容",
      "审核与最近答复",
      "在 GitHub 查看完整记录或答复",
      "分享此结果",
      "请输入正整数编号，或 github.com/gfy0/gfy0/issues 下的记录链接。",
      "没有找到记录，请核对编号或打开 GitHub。",
      "GitHub 暂时限制了查询。页面不会自动重试，可通过下方链接查看原记录。",
      "暂时无法读取 GitHub，已保存的投稿不受影响。请打开原记录或稍后再试。",
      "部分答复未读到，请到 GitHub 查看完整记录。",
      "暂无答复。",
      "没有填写说明。",
    ],
    es: [
      "Consultar tu sugerencia",
      "Introduce el número o enlace de la incidencia. Guarda el enlace del resultado para volver desde otro dispositivo.",
      "Número o enlace",
      "p. ej. 2 o https://github.com/gfy0/gfy0/issues/2",
      "Ver resultado",
      "Cargando…",
      "Registro abierto",
      "Registro cerrado",
      "Completado",
      "No previsto",
      "Reabierto",
      "Sin motivo de cierre",
      "Este es el estado del registro público en GitHub. No significa que el proyecto se haya incluido en el directorio.",
      "Actualizado",
      "Sugerencia",
      "Revisión y respuestas recientes",
      "Ver el registro completo o responder en GitHub",
      "Compartir este resultado",
      "Introduce un número positivo o un enlace de github.com/gfy0/gfy0/issues.",
      "No se encontró el registro. Revisa el número o abre GitHub.",
      "GitHub ha limitado la consulta. No se reintentará automáticamente; usa el enlace al registro.",
      "No se puede consultar GitHub ahora. Tu sugerencia guardada no ha cambiado. Abre el registro o vuelve más tarde.",
      "No se leyeron todas las respuestas. Consulta el registro completo en GitHub.",
      "Aún no hay respuestas.",
      "Sin descripción.",
    ],
    ar: [
      "عرض نتيجة اقتراحك",
      "أدخل رقم السجل أو رابطه على GitHub. احفظ رابط النتيجة للعودة من جهاز آخر.",
      "رقم السجل أو رابطه",
      "مثال: 2 أو https://github.com/gfy0/gfy0/issues/2",
      "عرض النتيجة",
      "جارٍ التحميل…",
      "السجل مفتوح",
      "السجل مغلق",
      "مكتمل",
      "غير مخطط له",
      "أعيد فتحه",
      "لم يُذكر سبب الإغلاق",
      "هذه حالة السجل العام على GitHub، ولا تعني إدراج المشروع في الدليل.",
      "آخر تحديث",
      "محتوى الاقتراح",
      "المراجعة والردود الأخيرة",
      "عرض السجل الكامل أو الرد على GitHub",
      "مشاركة النتيجة",
      "أدخل رقمًا موجبًا أو رابطًا من github.com/gfy0/gfy0/issues.",
      "لم يُعثر على السجل. تحقق من الرقم أو افتح GitHub.",
      "قيّد GitHub الاستعلام مؤقتًا. لن تُعاد المحاولة تلقائيًا؛ استخدم رابط السجل.",
      "تعذرت قراءة GitHub الآن. لم يتغير اقتراحك المحفوظ. افتح السجل أو حاول لاحقًا.",
      "لم تُقرأ بعض الردود. راجع السجل الكامل على GitHub.",
      "لا توجد ردود بعد.",
      "لم يُكتب وصف.",
    ],
    ja: [
      "投稿結果を確認",
      "番号または GitHub の記録リンクを入力してください。結果のリンクを保存すると別の端末でも確認できます。",
      "投稿番号またはリンク",
      "例: 2 または https://github.com/gfy0/gfy0/issues/2",
      "結果を見る",
      "読み込み中…",
      "記録はオープン",
      "記録はクローズ",
      "完了",
      "対応予定なし",
      "再オープン",
      "クローズ理由なし",
      "これは GitHub の公開記録の状態です。ディレクトリへの掲載を意味しません。",
      "更新日時",
      "投稿内容",
      "審査と最近の返信",
      "GitHub で全記録の確認・返信",
      "結果を共有",
      "正の整数、または github.com/gfy0/gfy0/issues のリンクを入力してください。",
      "記録が見つかりません。番号を確認するか GitHub を開いてください。",
      "GitHub の照会制限に達しました。自動再試行は行いません。元の記録を開いてください。",
      "現在 GitHub を読み込めません。保存済みの投稿は変わりません。元の記録を開くか、後で再試行してください。",
      "一部の返信を取得していません。GitHub で全記録をご確認ください。",
      "返信はまだありません。",
      "説明はありません。",
    ],
  };
  const reviewMessages = {
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
      published: "Revisado e incluido.",
      existing: "El proyecto ya está incluido; no se creó un duplicado.",
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
      published: "تمت المراجعة والإدراج.",
      existing: "المشروع مدرج بالفعل؛ لم يُنشأ إدراج مكرر.",
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
      published: "審査済み・掲載済み。",
      existing: "すでに掲載されています。重複作成はしていません。",
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
      published: "Reviewed and listed.",
      existing: "Already listed. No duplicate project was created.",
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
      "source-changed":
        "未收录：来源身份或已审核内容版本发生变化，需要重新核实来源，不会自动放行。",
      "needs-information": "未收录：请补全项目名称、HTTPS 来源、说明和两项确认，再编辑本条投稿。",
      approved: "来源核验通过，正在发布网站；这还不代表已上线收录。",
      "deployment-pending": "尚未验证网站发布成功，投稿已保存，云端恢复任务会重试，请勿重复提交。",
      published: "已审核并收录。",
      existing: "项目已经收录，未重复创建。",
    },
  };
  const reviewLabels = {
    en: [
      "Review status",
      "No confirmed review result for the current suggestion. Read the original GitHub record for details.",
      "Open reviewed project",
      "Recent replies",
    ],
    "zh-CN": [
      "审核状态",
      "尚未确认当前投稿的审核结果，请查看 GitHub 原记录。",
      "打开已审核项目",
      "最近答复",
    ],
    es: [
      "Estado de revisión",
      "No hay un resultado confirmado para la sugerencia actual. Consulta el registro original en GitHub.",
      "Abrir proyecto revisado",
      "Respuestas recientes",
    ],
    ar: [
      "حالة المراجعة",
      "لا توجد نتيجة مراجعة مؤكدة للاقتراح الحالي. راجع السجل الأصلي على GitHub.",
      "فتح المشروع المراجع",
      "الردود الأخيرة",
    ],
    ja: [
      "審査状況",
      "現在の投稿について確認できる審査結果はありません。GitHub の元の記録をご確認ください。",
      "審査済みプロジェクトを開く",
      "最近の返信",
    ],
  };
  const reviewText = reviewMessages[document.documentElement.lang] || reviewMessages.en;
  const reviewLabel = reviewLabels[document.documentElement.lang] || reviewLabels.en;
  const snapshotNotice =
    {
      en: "This result is a saved snapshot for the recorded issue version. The issue may have changed since it was recorded.",
      "zh-CN": "此结果是所示记录版本的快照；记录之后可能已编辑，当前结果可能不同。",
      es: "Este resultado es una instantánea de la versión registrada. El registro puede haber cambiado desde entonces.",
      ar: "هذه النتيجة لقطة محفوظة لإصدار السجل المذكور. ربما تغير السجل منذ ذلك الحين.",
      ja: "この結果は記録された版の保存スナップショットです。記録後に内容が変更された可能性があります。",
    }[document.documentElement.lang] ||
    "This result is a saved snapshot for the recorded issue version. The issue may have changed since it was recorded.";
  const snapshotStaleNotice =
    {
      en: "This saved result is for an earlier issue version; the issue changed after it was recorded.",
      "zh-CN": "此快照对应较早版本；记录在快照生成后已有编辑，当前结果可能不同。",
      es: "Este resultado guardado corresponde a una versión anterior; el registro se editó después.",
      ar: "هذه النتيجة المحفوظة تخص إصدارًا أقدم؛ عُدّل السجل بعد تسجيلها.",
      ja: "この保存結果は以前の版に対応しています。記録後に内容が編集されています。",
    }[document.documentElement.lang] ||
    "This saved result is for an earlier issue version; the issue changed after it was recorded.";
  const observedLabel =
    {
      en: "Result recorded",
      "zh-CN": "结果记录时间",
      es: "Resultado registrado",
      ar: "وقت تسجيل النتيجة",
      ja: "結果の記録日時",
    }[document.documentElement.lang] || "Result recorded";
  const t = translations[document.documentElement.lang] || translations.en;
  const host = document.getElementById("suggestion-results");
  if (!host) return;
  function element(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  }
  function link(text, url) {
    const node = element("a", text);
    node.href = url;
    node.rel = "noopener noreferrer";
    return node;
  }
  function appendSnapshotDetails(target, record, currentVersion = null) {
    target.append(
      element(
        "p",
        currentVersion && currentVersion !== record.version ? snapshotStaleNotice : snapshotNotice,
      ),
    );
    target.append(
      element(
        "p",
        observedLabel +
          ": " +
          new Date(record.observedAt).toLocaleString(document.documentElement.lang),
      ),
    );
    target.append(link(t[16], record.issueUrl));
    if (record.candidateUrl) target.append(link(reviewLabel[2], record.candidateUrl));
  }
  const heading = element("h2", t[0]);
  heading.id = "results-heading";
  const form = element("form");
  const label = element("label", t[2]);
  label.htmlFor = "issue-number";
  const input = element("input");
  input.id = "issue-number";
  input.name = "issue";
  input.type = "text";
  input.required = true;
  input.maxLength = 200;
  input.placeholder = t[3];
  input.dir = "ltr";
  const button = element("button", t[4]);
  button.type = "submit";
  const status = element("p");
  status.id = "lookup-status";
  status.setAttribute("role", "status");
  const output = element("div");
  output.id = "lookup-result";
  const recovery = element("p");
  recovery.hidden = true;
  form.append(label, input, button);
  host.append(heading, element("p", t[1]), form, status, recovery, output);
  async function lookup(event) {
    if (event) event.preventDefault();
    if (button.disabled) return;
    output.replaceChildren();
    recovery.replaceChildren();
    recovery.hidden = true;
    delete output.dataset.loaded;
    const number = parseIssueNumber(input.value);
    if (!number) {
      status.textContent = t[18];
      return;
    }
    recovery.append(link(t[16], repository + number));
    recovery.hidden = false;
    button.disabled = true;
    status.textContent = t[5];
    host.setAttribute("aria-busy", "true");
    let limited = false;
    try {
      const lookupResult = await lookupWithSnapshot(number);
      const resultUrl = new URL(location.href);
      resultUrl.search = "";
      resultUrl.searchParams.set("issue", String(number));
      resultUrl.hash = "suggestion-results";
      history.replaceState(null, "", resultUrl);
      if (!lookupResult.live) {
        const record = lookupResult.snapshot;
        const title = element("h3", "#" + number);
        const review = element("section", undefined, "suggestion-review");
        review.setAttribute("aria-label", reviewLabel[0]);
        review.append(
          element("h4", reviewLabel[0]),
          element("p", reviewText[record.status] || reviewLabel[1]),
        );
        appendSnapshotDetails(review, record);
        output.append(title, review);
        status.textContent = "";
        output.dataset.loaded = "true";
        return;
      }
      const result = lookupResult.live;
      const issue = result.issue;
      const title = element("h3", "#" + number + " · " + issue.title.slice(0, 300));
      const state = element("p", issue.state === "open" ? t[6] : t[7], "suggestion-state");
      state.dataset.state = issue.state;
      state.dataset.stateReason = issue.state_reason || "";
      if (issue.state === "closed")
        state.append(
          document.createTextNode(
            " · " +
              ({ completed: t[8], not_planned: t[9], reopened: t[10] }[issue.state_reason] ||
                t[11]),
          ),
        );
      const updated = new Date(issue.updated_at);
      const review = element("section", undefined, "suggestion-review");
      review.setAttribute("aria-label", reviewLabel[0]);
      review.append(
        element("h4", reviewLabel[0]),
        element(
          "p",
          result.review
            ? reviewText[result.review.status]
            : lookupResult.snapshot
              ? reviewText[lookupResult.snapshot.status]
              : reviewLabel[1],
        ),
      );
      if (lookupResult.snapshot && !result.review)
        appendSnapshotDetails(review, lookupResult.snapshot, result.version);
      else if (result.review?.url) review.append(link(reviewLabel[2], result.review.url));
      output.append(title, review, state, element("p", t[12]));
      if (!Number.isNaN(updated.valueOf()))
        output.append(
          element("p", t[13] + ": " + updated.toLocaleString(document.documentElement.lang)),
        );
      output.append(
        element("p"),
        link(t[17], resultUrl.href),
        element("h4", t[14]),
        element(
          "pre",
          typeof issue.body === "string" && issue.body ? issue.body.slice(0, 12000) : t[24],
          "suggestion-text",
        ),
        element("h4", reviewLabel[3]),
      );
      if (result.repliesUnavailable) output.append(element("p", t[22]));
      const discussion = result.replies.filter((reply) => !isOfficialReview(reply));
      if (!discussion.length && !result.repliesUnavailable) output.append(element("p", t[23]));
      else
        for (const reply of discussion)
          output.append(element("pre", reply.body.slice(0, 6000), "suggestion-text"));
      status.textContent = "";
      output.dataset.loaded = "true";
    } catch (error) {
      delete output.dataset.loaded;
      limited = error.message === "rate-limited";
      status.textContent = error.message === "not-found" ? t[19] : limited ? t[20] : t[21];
    } finally {
      button.disabled = limited;
      host.removeAttribute("aria-busy");
    }
  }
  form.addEventListener("submit", lookup);
  const initial = new URLSearchParams(location.search).get("issue");
  if (initial) {
    input.value = initial;
    lookup();
  }
})();
