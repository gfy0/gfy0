import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const marker = 'Your No.1 · Suggestion receipt';
const repository = 'gfy0/gfy0';
const site = 'https://gfy0.github.io/gfy0/';
const copy = {
  en: ['Automatic receipt — preliminary checks only', 'Please complete or correct these fields, then edit this same suggestion to check again:', 'This exact source URL is already in the published directory:', 'Your information is saved. This suggestion needs operator processing; no response time is promised.', 'This is not content approval or a new listing. Automatic content review and publication are not enabled. No payment is requested.', 'View this result:', 'If no updated receipt appears, keep this record and retry later by editing it. Do not create a duplicate.'],
  'zh-CN': ['自动回执 — 仅做初步检查', '请补充或修正以下字段，再编辑这条建议重新检查：', '这个完全一致的来源网址已存在于公开目录：', '资料已保存。本条建议需要运营者处理，不承诺答复时间。', '这不是内容审核通过，也不是新增收录。尚未启用自动内容审核和发布，不收取费用。', '查看本次结果：', '若没有出现更新后的回执，请保留原记录，稍后编辑重试，不要重复创建。'],
  es: ['Acuse automático — solo comprobaciones iniciales', 'Completa o corrige estos campos y edita esta misma sugerencia para volver a comprobarla:', 'Esta URL de fuente exacta ya está en el directorio publicado:', 'La información está guardada. Esta sugerencia requiere atención del operador; no se promete un plazo de respuesta.', 'No es una aprobación de contenido ni una nueva inclusión. La revisión y publicación automáticas no están habilitadas. No se solicita pago.', 'Consulta este resultado:', 'Si no aparece un acuse actualizado, conserva el registro y vuelve a editarlo más tarde. No crees un duplicado.'],
  ar: ['إيصال آلي — فحوص أولية فقط', 'أكمل هذه الحقول أو صححها ثم عدّل الاقتراح نفسه لإعادة الفحص:', 'رابط المصدر المطابق موجود بالفعل في الدليل المنشور:', 'تم حفظ المعلومات. يحتاج هذا الاقتراح إلى معالجة من المشغّل، ولا نعد بموعد للرد.', 'هذا ليس قبولاً للمحتوى ولا إدراجاً جديداً. المراجعة الآلية للمحتوى والنشر غير مفعّلين. لا نطلب أي دفع.', 'عرض هذه النتيجة:', 'إذا لم يظهر إيصال محدّث، احتفظ بالسجل وعدّله لاحقاً للمحاولة مجدداً. لا تنشئ نسخة مكررة.'],
  ja: ['自動受付結果 — 初期確認のみ', '次の項目を補足・修正し、同じ投稿を編集して再確認してください：', 'この出典 URL は公開ディレクトリにすでに存在します：', '情報を保存しました。この提案は運営者による対応が必要です。回答期限はお約束しません。', 'これは内容の承認や新規掲載ではありません。内容の自動審査・公開は有効になっていません。料金はかかりません。', 'この結果を確認：', '更新された受付結果が表示されない場合は、記録を保存し、後で同じ投稿を編集してください。重複投稿は避けてください。']
};

function fingerprint(issue) {
  return createHash('sha256').update(JSON.stringify([issue.title, issue.body])).digest('hex').slice(0,16);
}
function sourceUrl(value) {
  if (typeof value !== 'string' || value.length > 2048 || /\s/.test(value)) return null;
  try {
    const url = new URL(value);
    if(url.protocol !== 'https:' || url.username || url.password || url.hash || url.port || !url.hostname.includes('.') || /(^localhost$|\.localhost$|\.local$|^[\d.]+$|:)/i.test(url.hostname)) return null;
    return url.href.replace(/\/$/, '');
  } catch { return null; }
}
function fields(body) {
  const parts = (typeof body === 'string' ? body : '').split(/^### (.+)\r?$/m);
  const result = new Map();
  for(let i=1;i<parts.length;i+=2) {
    const label=parts[i].trim();
    result.set(label,result.has(label) ? null : parts[i+1].trim());
  }
  return result;
}

export function evaluate(issue, catalog, templates) {
  const values = fields(issue.body);
  const locales = Object.keys(templates).filter(locale => templates[locale].body.some(field => field.id && values.has(field.attributes.label)));
  const locale = locales.length === 1 ? locales[0] : 'en';
  const form = templates[locale].body.filter(field=>field.id);
  const t = copy[locale];
  const missing=[];
  for(const field of form) {
    const value=values.get(field.attributes.label);
    const absent=typeof value !== 'string' || !value || value === '_No response_';
    const invalid=field.id==='official-url' ? !sourceUrl(value) : field.id==='public-disclosure' ? absent || !value.split(/\r?\n/).some(line=>line.replace(/^- \[X\]/,'- [x]')==='- [x] '+field.attributes.options[0].label) : absent || value.length > (field.id==='project-name'?200:4000);
    if(invalid) missing.push(field.attributes.label);
  }
  if(locales.length !== 1 && !missing.length) missing.push(form[0].attributes.label);
  const source=sourceUrl(values.get(form.find(f=>f.id==='official-url').attributes.label));
  const project=missing.length?null:catalog.projects.find(p=>sourceUrl(p.source)===source);
  const outcome=missing.length?'needs-information':project?'existing-source':'needs-processing';
  const detail=missing.length ? `${t[1]}\n${missing.map(label=>'- '+label).join('\n')}` : project ? `${t[2]}\n${site}${locale}/candidates/${project.path}/` : t[3];
  return {locale,outcome,body:`${marker}\n${t[0]}\n\n${detail}\n\n${t[4]}\n\n${t[5]}\n${site}${locale}/submit/?issue=${issue.number}\n\n${t[6]}`};
}

export async function processIssue(number, api, catalog, templates) {
  if(!Number.isSafeInteger(number) || number<1) throw Error('Invalid issue number');
  const issue=await api('GET',`issues/${number}`);
  if(issue.pull_request || issue.state!=='open') return {outcome:'skipped'};
  const comments=[];
  for(let page=1;page<=3;page++) {
    const batch=await api('GET',`issues/${number}/comments?per_page=100&page=${page}`);
    if(!Array.isArray(batch)) throw Error('Invalid comments response');
    comments.push(...batch);
    if(batch.length<100) break;
    if(page===3) throw Error('Comment bound exceeded; no write');
  }
  const previous=comments.find(c=>c.user?.login==='github-actions[bot]' && c.user?.type==='Bot' && typeof c.body==='string' && c.body.startsWith(marker));
  if(!issue.title?.startsWith('[Project suggestion]') && !previous) return {outcome:'skipped'};
  const receipt=evaluate(issue,catalog,templates);
  if(previous?.body===receipt.body) return {outcome:'unchanged'};
  const latest=await api('GET',`issues/${number}`);
  if(latest.state!=='open' || fingerprint(latest)!==fingerprint(issue)) return {outcome:'changed-before-write'};
  if(previous) await api('PATCH',`issues/comments/${previous.id}`,{body:receipt.body});
  else await api('POST',`issues/${number}/comments`,{body:receipt.body});
  return {outcome:receipt.outcome};
}

async function main() {
  const event=JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH,'utf8'));
  if(process.env.GITHUB_REPOSITORY!==repository || event.repository?.full_name!==repository || event.repository?.private!==false || !['opened','edited','reopened'].includes(event.action)) throw Error('Unexpected event scope');
  const token=process.env.GITHUB_TOKEN;
  if(!token) throw Error('Missing scoped workflow credential');
  const templates=Object.fromEntries(Object.keys(copy).map(locale=>[locale,JSON.parse(fs.readFileSync(new URL(`../.github/ISSUE_TEMPLATE/project-${locale}.yml`,import.meta.url),'utf8'))]));
  const catalog=JSON.parse(fs.readFileSync(new URL('./published-directory.json',import.meta.url),'utf8'));
  const api=async(method,path,data)=>{
    const response=await fetch(`https://api.github.com/repos/${repository}/${path}`,{method,headers:{Accept:'application/vnd.github+json',Authorization:`Bearer ${token}`,'X-GitHub-Api-Version':'2022-11-28','Content-Type':'application/json'},body:data?JSON.stringify(data):undefined,signal:AbortSignal.timeout(15000),redirect:'error'});
    if(!response.ok) throw Error(`GitHub request failed (${response.status}); no automatic retry`);
    return response.json();
  };
  console.log(JSON.stringify(await processIssue(event.issue?.number,api,catalog,templates)));
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  main().catch(error=>{console.error(error.message);process.exitCode=1;});
}
