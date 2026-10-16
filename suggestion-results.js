/* Public suggestion records only. No credentials, payment state or automatic publication. */
(function () {
  'use strict';
  const repository = 'https://github.com/gfy0/gfy0/issues/';
  const api = 'https://api.github.com/repos/gfy0/gfy0/issues/';
  function parseIssueNumber(value) {
    const text = String(value).trim();
    const match = /^(?:#)?([1-9]\d{0,8})$/.exec(text) || /^https:\/\/github\.com\/gfy0\/gfy0\/issues\/([1-9]\d{0,8})\/?$/.exec(text);
    return match ? Number(match[1]) : null;
  }
  async function request(url, fetcher) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetcher(url, {credentials:'omit', referrerPolicy:'no-referrer', signal:controller.signal, headers:{Accept:'application/vnd.github+json'}});
      if (!response.ok) throw Error(response.status === 404 ? 'not-found' : [403,429].includes(response.status) ? 'rate-limited' : 'unavailable');
      return await response.json();
    } finally { clearTimeout(timeout); }
  }
  async function loadIssue(number, fetcher = fetch) {
    if (parseIssueNumber(number) !== number) throw Error('invalid-number');
    const issue = await request(api + number, fetcher);
    if (!issue || issue.number !== number || issue.html_url !== repository + number || issue.pull_request || !['open','closed'].includes(issue.state) || typeof issue.title !== 'string') throw Error('invalid-response');
    const result = {issue, replies:[], repliesUnavailable:false};
    if (Number.isSafeInteger(issue.comments) && issue.comments > 0) {
      try {
        const replies = await request(api + number + '/comments?per_page=5&page=' + Math.ceil(issue.comments / 5), fetcher);
        if (!Array.isArray(replies)) throw Error('invalid-response');
        result.replies = replies.slice(0,5).filter(reply => typeof reply.body === 'string');
      } catch { result.repliesUnavailable = true; }
    }
    return result;
  }
  if (typeof module !== 'undefined') module.exports = {parseIssueNumber, loadIssue};
  if (typeof document === 'undefined') return;
  const translations = {
    en:['View your suggestion','Paste the issue number or its GitHub link. Keep this link to return on another device.','Issue number or link','e.g. 2 or https://github.com/gfy0/gfy0/issues/2','View result','Loading…','Open record','Closed record','Completed','Not planned','Reopened','No closure reason provided','This is the public GitHub record status. It does not mean the project has been added to the directory.','Updated','Suggestion','Latest page of replies','Read the complete record or reply on GitHub','Share this result','Enter a positive issue number or a link from github.com/gfy0/gfy0/issues.','Record not found. Check the number or open GitHub.','GitHub has limited this lookup. No automatic retry will occur; use the original record below.','Unable to read GitHub right now. Your saved suggestion is unchanged. Open the original record or try later.','The record loaded, but replies could not be read. See GitHub for replies.','No replies yet.','No description provided.'],
    'zh-CN':['查看投稿结果','输入投稿编号或 GitHub 记录链接。保存结果页链接，换设备也能继续查看。','投稿编号或记录链接','例如 2，或 https://github.com/gfy0/gfy0/issues/2','查看结果','正在读取…','记录开启','记录已关闭','已完成','未计划处理','重新开启','未提供关闭原因','这是 GitHub 公开记录的状态，不代表项目已被目录收录。','更新时间','投稿内容','最新一页答复','在 GitHub 查看完整记录或答复','分享此结果','请输入正整数编号，或 github.com/gfy0/gfy0/issues 下的记录链接。','没有找到记录，请核对编号或打开 GitHub。','GitHub 暂时限制了查询。页面不会自动重试，可通过下方链接查看原记录。','暂时无法读取 GitHub，已保存的投稿不受影响。请打开原记录或稍后再试。','记录已读到，但答复读取失败，请到 GitHub 查看。','暂无答复。','没有填写说明。'],
    es:['Consultar tu sugerencia','Introduce el número o enlace de la incidencia. Guarda el enlace del resultado para volver desde otro dispositivo.','Número o enlace','p. ej. 2 o https://github.com/gfy0/gfy0/issues/2','Ver resultado','Cargando…','Registro abierto','Registro cerrado','Completado','No previsto','Reabierto','Sin motivo de cierre','Este es el estado del registro público en GitHub. No significa que el proyecto se haya incluido en el directorio.','Actualizado','Sugerencia','Última página de respuestas','Ver el registro completo o responder en GitHub','Compartir este resultado','Introduce un número positivo o un enlace de github.com/gfy0/gfy0/issues.','No se encontró el registro. Revisa el número o abre GitHub.','GitHub ha limitado la consulta. No se reintentará automáticamente; usa el enlace al registro.','No se puede consultar GitHub ahora. Tu sugerencia guardada no ha cambiado. Abre el registro o vuelve más tarde.','Se cargó el registro, pero no las respuestas. Consúltalas en GitHub.','Aún no hay respuestas.','Sin descripción.'],
    ar:['عرض نتيجة اقتراحك','أدخل رقم السجل أو رابطه على GitHub. احفظ رابط النتيجة للعودة من جهاز آخر.','رقم السجل أو رابطه','مثال: 2 أو https://github.com/gfy0/gfy0/issues/2','عرض النتيجة','جارٍ التحميل…','السجل مفتوح','السجل مغلق','مكتمل','غير مخطط له','أعيد فتحه','لم يُذكر سبب الإغلاق','هذه حالة السجل العام على GitHub، ولا تعني إدراج المشروع في الدليل.','آخر تحديث','محتوى الاقتراح','أحدث صفحة من الردود','عرض السجل الكامل أو الرد على GitHub','مشاركة النتيجة','أدخل رقمًا موجبًا أو رابطًا من github.com/gfy0/gfy0/issues.','لم يُعثر على السجل. تحقق من الرقم أو افتح GitHub.','قيّد GitHub الاستعلام مؤقتًا. لن تُعاد المحاولة تلقائيًا؛ استخدم رابط السجل.','تعذرت قراءة GitHub الآن. لم يتغير اقتراحك المحفوظ. افتح السجل أو حاول لاحقًا.','تم تحميل السجل وتعذرت قراءة الردود. راجع GitHub.','لا توجد ردود بعد.','لم يُكتب وصف.'],
    ja:['投稿結果を確認','番号または GitHub の記録リンクを入力してください。結果のリンクを保存すると別の端末でも確認できます。','投稿番号またはリンク','例: 2 または https://github.com/gfy0/gfy0/issues/2','結果を見る','読み込み中…','記録はオープン','記録はクローズ','完了','対応予定なし','再オープン','クローズ理由なし','これは GitHub の公開記録の状態です。ディレクトリへの掲載を意味しません。','更新日時','投稿内容','返信の最新ページ','GitHub で全記録の確認・返信','結果を共有','正の整数、または github.com/gfy0/gfy0/issues のリンクを入力してください。','記録が見つかりません。番号を確認するか GitHub を開いてください。','GitHub の照会制限に達しました。自動再試行は行いません。元の記録を開いてください。','現在 GitHub を読み込めません。保存済みの投稿は変わりません。元の記録を開くか、後で再試行してください。','記録は読み込めましたが返信を取得できませんでした。GitHub をご確認ください。','返信はまだありません。','説明はありません。']
  };
  const t = translations[document.documentElement.lang] || translations.en;
  const host = document.getElementById('suggestion-results');
  if (!host) return;
  function element(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  }
  function link(text, url) {
    const node = element('a', text); node.href = url; node.rel = 'noopener noreferrer'; return node;
  }
  const heading = element('h2', t[0]); heading.id = 'results-heading';
  const form = element('form');
  const label = element('label', t[2]); label.htmlFor = 'issue-number';
  const input = element('input'); input.id = 'issue-number'; input.name = 'issue'; input.type = 'text'; input.required = true; input.maxLength = 200; input.placeholder = t[3]; input.dir = 'ltr';
  const button = element('button', t[4]); button.type = 'submit';
  const status = element('p'); status.id = 'lookup-status'; status.setAttribute('role','status');
  const output = element('div'); output.id = 'lookup-result';
  const recovery = element('p'); recovery.hidden = true;
  form.append(label,input,button);
  host.append(heading,element('p',t[1]),form,status,recovery,output);
  async function lookup(event) {
    if (event) event.preventDefault();
    if (button.disabled) return;
    output.replaceChildren(); recovery.replaceChildren(); recovery.hidden = true;
    delete output.dataset.loaded;
    const number = parseIssueNumber(input.value);
    if (!number) { status.textContent = t[18]; return; }
    recovery.append(link(t[16], repository + number)); recovery.hidden = false;
    button.disabled = true; status.textContent = t[5]; host.setAttribute('aria-busy','true');
    let limited = false;
    try {
      const result = await loadIssue(number);
      const issue = result.issue;
      const url = new URL(location.href); url.search = ''; url.searchParams.set('issue',String(number)); url.hash = 'suggestion-results';
      history.replaceState(null,'',url);
      const title = element('h3', '#' + number + ' · ' + issue.title.slice(0,300));
      const state = element('p', issue.state === 'open' ? t[6] : t[7], 'suggestion-state');
      state.dataset.state = issue.state; state.dataset.stateReason = issue.state_reason || '';
      if (issue.state === 'closed') state.append(document.createTextNode(' · ' + ({completed:t[8],not_planned:t[9],reopened:t[10]}[issue.state_reason] || t[11])));
      const updated = new Date(issue.updated_at);
      output.append(title,state,element('p',t[12]));
      if (!Number.isNaN(updated.valueOf())) output.append(element('p',t[13] + ': ' + updated.toLocaleString(document.documentElement.lang)));
      output.append(element('p'),link(t[17],url.href),element('h4',t[14]),element('pre',typeof issue.body === 'string' && issue.body ? issue.body.slice(0,12000) : t[24], 'suggestion-text'),element('h4',t[15]));
      if(result.repliesUnavailable) output.append(element('p',t[22]));
      else if(!result.replies.length) output.append(element('p',t[23]));
      else for(const reply of result.replies) {
        output.append(element('pre',reply.body.slice(0,6000),'suggestion-text'));
        if(reply.user?.login === 'gfy0' && reply.body.startsWith('Your No.1 · Review result · ')) {
          const match = reply.body.match(/^https:\/\/gfy0\.github\.io\/gfy0\/(?:en|zh-CN|es|ar|ja)\/candidates\/candidate-[a-f0-9-]{36}\/$/m);
          if(match) output.append(link({"en":"Open reviewed project","zh-CN":"打开已审核项目","es":"Abrir proyecto revisado","ar":"فتح المشروع المراجع","ja":"審査済みプロジェクトを開く"}[document.documentElement.lang] || 'Open reviewed project', match[0]));
        }
      }
      status.textContent = ''; output.dataset.loaded = 'true';
    } catch(error) {
      delete output.dataset.loaded;
      limited = error.message === 'rate-limited';
      status.textContent = error.message === 'not-found' ? t[19] : limited ? t[20] : t[21];
    } finally {button.disabled = limited; host.removeAttribute('aria-busy');}
  }
  form.addEventListener('submit',lookup);
  const initial = new URLSearchParams(location.search).get('issue');
  if(initial) { input.value = initial; lookup(); }
})();
