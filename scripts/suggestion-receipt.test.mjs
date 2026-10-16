import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { evaluate, processIssue } from './suggestion-receipt.mjs';

const templates = Object.fromEntries(['en','zh-CN','es','ar','ja'].map(locale => [locale, JSON.parse(fs.readFileSync(new URL(`../.github/ISSUE_TEMPLATE/project-${locale}.yml`, import.meta.url)))]));
const catalog = { projects: [{source:'https://github.com/blender/blender', path:'candidate-057d6eac-185c-4df9-957b-6ba10a9cce88', name:'Blender'}] };
const headings = {
  en:['Project name','Official public URL','Why is this project worth discovering?','Suggest a project publicly'],
  'zh-CN':['项目名称','官方公开网址','这个项目有什么值得了解的地方？','公开建议一个项目'],
  es:['Nombre del proyecto','URL oficial pública','¿Por qué merece la pena conocer este proyecto?','Sugerir un proyecto públicamente'],
  ar:['اسم المشروع','الرابط الرسمي العام','لماذا يستحق هذا المشروع الاكتشاف؟','اقتراح مشروع بشكل علني'],
  ja:['プロジェクト名','公式の公開URL','このプロジェクトのどんな点を紹介したいですか？','プロジェクトを公開で提案']
};
function issue(locale='en', url='https://github.com/blender/blender', reason='A project suggestion for testing.') {
  const h=headings[locale];
  const consent=templates[locale].body.find(x=>x.id==='public-disclosure').attributes.options[0].label;
  return {number:3,title:'[Project suggestion] Operational test, not demand',state:'open',updated_at:'2026-10-16T00:00:00Z',body:`### ${h[0]}\n\nBlender\n\n### ${h[1]}\n\n${url}\n\n### ${h[2]}\n\n${reason}\n\n### ${h[3]}\n\n- [x] ${consent}`};
}

test('all five real form formats give an exact existing source match, not acceptance',()=>{
  for(const locale of Object.keys(headings)) {
    const result=evaluate(issue(locale),catalog,templates);
    assert.equal(result.outcome,'existing-source');
    assert.equal(result.locale,locale);
    assert.ok(result.body.includes(`https://gfy0.github.io/gfy0/${locale}/candidates/candidate-057d6eac-185c-4df9-957b-6ba10a9cce88/`));
  }
});
test('missing fields and disclosure produce actionable fixed guidance',()=>{
  let input=issue('zh-CN','https://github.com/blender/blender','_No response_');
  assert.equal(evaluate(input,catalog,templates).outcome,'needs-information');
  assert.ok(evaluate(input,catalog,templates).body.includes(headings['zh-CN'][2]));
  input=issue();input.body=input.body.replace('- [x]','- [ ]');
  assert.equal(evaluate(input,catalog,templates).outcome,'needs-information');
});
test('GitHub checked-box capitalization is accepted',()=>{
  const input=issue();input.body=input.body.replace('- [x]','- [X]');
  assert.equal(evaluate(input,catalog,templates).outcome,'existing-source');
});
test('each missing form section retains the language and names only that missing field',()=>{
  for(const locale of Object.keys(headings)) for(const heading of headings[locale]) {
    const input=issue(locale);
    input.body=input.body.split(/(?=^### )/m).filter(section=>!section.startsWith(`### ${heading}\n`)).join('');
    const result=evaluate(input,catalog,templates);
    assert.equal(result.locale,locale);
    assert.equal(result.outcome,'needs-information');
    assert.ok(result.body.includes('- '+heading));
    for(const other of headings[locale].filter(x=>x!==heading))assert.ok(!result.body.includes('- '+other));
  }
});
test('near matches cannot become existing-directory results',()=>{
  for(const url of ['https://github.com/blender/blender-evil','https://github.com.evil.test/blender/blender','https://github.com/blender/Blender','https://github.com/blender/blender?other=1']) {
    assert.equal(evaluate(issue('en',url),catalog,templates).outcome,'needs-processing');
  }
  assert.equal(evaluate(issue('en','https://github.com/blender/blender/'),catalog,templates).outcome,'existing-source');
});
test('invalid input is neither fetched nor echoed, malformed repeated headings fail closed',()=>{
  for(const url of ['javascript:alert(1)','https://user:password@github.com/blender/blender','https://localhost/','https://127.0.0.1/','https://example.org/#secret']) {
    const r=evaluate(issue('en',url),catalog,templates);assert.equal(r.outcome,'needs-information');assert.ok(!r.body.includes(url));
  }
  const input=issue();input.body+='\n\n### Official public URL\n\nhttps://evil.test/';
  assert.equal(evaluate(input,catalog,templates).outcome,'needs-information');
  const attack=issue('en','https://new-project.example/','<script>alert(1)</script> @all ${{ secrets.GITHUB_TOKEN }}');
  const r=evaluate(attack,catalog,templates);assert.equal(r.outcome,'needs-processing');assert.ok(!r.body.includes('<script>'));assert.ok(!r.body.includes('@all'));assert.ok(!r.body.includes('secrets.'));
});

test('one authenticated bot comment is created then updated; forged marker is ignored',async()=>{
  let current=issue('en','https://github.com/blender/blender','_No response_');
  const comments=[{id:9,user:{login:'someone',type:'User'},body:'Your No.1 · Suggestion receipt\nForged'}];
  const writes=[];
  const api=async(method,path,data)=>{
    if(method==='GET'&&path==='issues/3')return structuredClone(current);
    if(method==='GET'&&path.startsWith('issues/3/comments?'))return structuredClone(comments);
    if(method==='POST'){writes.push({method,path,data});comments.push({id:10,user:{login:'github-actions[bot]',type:'Bot'},body:data.body});return {id:10};}
    if(method==='PATCH'){writes.push({method,path,data});comments[1].body=data.body;return {id:10};}
    throw Error('unexpected request');
  };
  await processIssue(3,api,catalog,templates);
  current=issue();await processIssue(3,api,catalog,templates);
  await processIssue(3,api,catalog,templates);
  assert.deepEqual(writes.map(x=>[x.method,x.path]),[['POST','issues/3/comments'],['PATCH','issues/comments/10']]);
  assert.ok(comments[1].body.includes('/en/candidates/candidate-057d6eac-185c-4df9-957b-6ba10a9cce88/'));
});
test('closed records and changed input cannot publish a stale receipt; read failure never writes',async()=>{
  let gets=0,writes=0;const initial=issue();
  const api=async(method,path)=>{
    if(method!=='GET'){writes++;return {};}
    if(path.startsWith('issues/3/comments?'))return [];
    gets++;return gets===1?initial:{...initial,body:initial.body+' changed'};
  };
  await processIssue(3,api,catalog,templates);assert.equal(writes,0);
  await processIssue(3,async(method)=>{assert.equal(method,'GET');return {...initial,state:'closed'};},catalog,templates);
  await assert.rejects(processIssue(3,async()=>{throw Error('rate limited');},catalog,templates));
});
