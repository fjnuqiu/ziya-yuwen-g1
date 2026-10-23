import { STORAGE_KEY, createState, flattenCurriculum, getItemStatus, buildDailyPlan, recordAttempt, markStudied, exportState, importState, dateKey } from './learning-engine.js';

import { ProgressSync, CLOUD_PREFIX } from './cloud-sync.js';
import { mergeStates } from './sync-model.js';
import { mountAccountGate } from './account-ui.js';
import { makeSupabaseProgressFetcher } from './supabase-progress.js';

const $app = document.querySelector('#app');
const esc = (v = '') => String(v).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const icons = {
  sprout:'<path d="M12 21V9m0 6C5 15 3 10 4 5c6 0 9 3 8 10Zm0-4c0-6 3-9 9-9 1 6-3 9-9 9Z"/>',
  home:'<path d="m3 10 9-7 9 7v10H3Zm6 10v-7h6v7"/>',
  book:'<path d="M12 5C8 3 5 3 2 4v15c3-1 6-1 10 1 4-2 7-2 10-1V4c-3-1-6-1-10 1Zm0 0v15"/>',
  leaf:'<path d="M4 20C2 7 9 3 21 3c0 12-5 18-13 14M3 21l12-12"/>',
  chart:'<path d="M4 3v18h18M9 16v-5m5 5V7m5 9V4"/>',
  settings:'<path d="M4 6h16M4 12h16M4 18h16M8 3v6m8 0v6M9 15v6"/>',
  arrow:'<path d="M4 12h16m-6-6 6 6-6 6"/>',
  sound:'<path d="m11 4-6 5H2v6h3l6 5ZM15 8c3 2 3 6 0 8m3-12c6 4 6 12 0 16"/>',
  check:'<path d="m4 12 5 5L20 6"/>',
  clock:'<circle cx="12" cy="12" r="9"/><path d="M12 6v6l4 2"/>',
};
const icon = (name) => `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || icons.leaf}</svg>`;
const kindLabel = { write: '会写 · 纸笔默写', pinyin: '会拼 · 拼音练习', recognize: '会认 · 朗读辨认' };
const shortKind = { write: '写字', pinyin: '拼音', recognize: '识字' };
let curriculum, references, items, itemMap, state, route = 'today', selectedLesson, session = null, lastSummary = null;
let search = '', kindFilter = 'all', storageProblem = '', modal = null, strokesPromise, writer;
let dirtyPersist = false, storageBlocked = false, originalStorage = '';
let cloud, syncStatus = {phase:'syncing',pending:0}, settingsSnapshot, settingsEdited=false, failedSettingsPatch={};
let accountService, currentAccount, accountGateCleanup, accountGeneration=0, passwordRecovery=false;
const emailMode=$app.dataset.authMode==='email';
const today = () => dateKey();
const status = (item) => getItemStatus(state.records[item.id], today());
const record = (item) => state.records[item.id];
const lessonItems = (lesson) => items.filter(item => item.lessonId === lesson.id);
const allLessonItems = (lesson) => ['pinyin','write','recognize'].flatMap(kind => (lesson[kind] || []).map(content => items.find(i => i.kind === kind && i.text === content.text && (kind !== 'recognize' || i.pinyin === content.pinyin))).filter(Boolean));
const isEligible = item => item.lessonOrder <= state.settings.teacherOrder;
const button = (label, action, extra = '', style = 'primary') => `<button class="button ${style}" data-action="${action}" ${extra}>${label}</button>`;
const dateLabel = () => new Intl.DateTimeFormat('zh-CN', {month:'long',day:'numeric',weekday:'long'}).format(new Date());
const chineseNumber = n => String(n).padStart(2,'0');

function pinyinGuide(text) {
  const width = Math.max(200, [...text].length * 50 + 70);
  // Andika has a 1040/2048 em x-height. Fix the baseline on line three,
  // and the x-height on line two, so a/o/e occupy the middle band.
  return `<svg class="pinyin-guide" viewBox="0 0 ${width} 150" role="img" aria-label="${esc(text)}，四线三格示范"><path d="M5 15H${width-5}M5 55H${width-5}M5 95H${width-5}M5 135H${width-5}"/><text x="${width/2}" y="95" text-anchor="middle" font-size="78.77">${esc(text)}</text></svg>`;
}

function persist(settingsPatch = {}) {
  if (storageBlocked) { dirtyPersist = true; return; }
  try {
    failedSettingsPatch={...failedSettingsPatch,...settingsPatch};
    state = cloud ? cloud.commit(state, failedSettingsPatch) : state;
    if (!cloud) localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    dirtyPersist = false; storageProblem = ''; failedSettingsPatch={};
  } catch { dirtyPersist = true; storageProblem = '这台设备暂时无法保存进度。请先导出备份，避免关闭页面后丢失。'; }
}
function cloudLabel() {
  return ({synced:'已同步 · 手机电脑接着学',syncing:'正在同步语文进度…',pending:'已存本机 · 等待同步',offline:'暂未连上云端 · 记录保留在本机',login:'需要登录 · 本机记录已保留',local:'当前为本机预览'})[syncStatus.phase] || '正在连接云端…';
}
function cloudBar() {
  return `<div class="cloud-bar ${['offline','login'].includes(syncStatus.phase)?'cloud-warning':''}" role="status"><span class="cloud-status-dot"></span><span class="cloud-copy"><strong>${cloudLabel()}</strong><small>${syncStatus.pending?`${syncStatus.pending} 条更新待上传 · `:''}${syncStatus.phase==='synced'?emailMode?'使用同一个语文账号即可继续学习':'使用同一 ChatGPT 账号即可继续学习':'语文独立保存，与英语分开'}</small></span>${syncStatus.phase==='login'?emailMode?button('重新登录','account-logout','','ghost small'):'<a class="button ghost small" href="/signin-with-chatgpt?return_to=/">重新登录</a>':cloud?button('立即同步','sync-now','','ghost small'):'<a class="button ghost small" href="https://ziya-yuwen-g1.fresh-melon-3977.chatgpt.site/" target="_blank" rel="noopener">打开同步网站 ↗</a>'}</div>`;
}
function updateCloudStatus(value) {
  syncStatus=value;
  const target=document.querySelector('#cloud-status');
  if(target)target.innerHTML=cloudBar();
}
function receiveCloud(next) {
  if(dirtyPersist)return; // Never discard changes that failed to reach local storage.
  const changed=JSON.stringify(state)!==JSON.stringify(next);
  state=next;
  const editing=document.activeElement?.matches('input,select,textarea') || (route==='settings'&&settingsEdited);
  if(changed&&!session&&!modal&&!editing)render();
}
function notify(message) {
  document.querySelector('.toast')?.remove();
  const el = document.createElement('div'); el.className = 'toast'; el.role = 'status'; el.textContent = message;
  document.body.append(el); setTimeout(() => el.remove(), 4200);
}
function navigate(next) {
  if (session) { modal = { type:'leave', next }; renderModal(); return; }
  route = next; location.hash = next; render(); window.scrollTo(0,0);
}
function shell(content) {
  const navigation = [['today','home','今日陪学'],['courses','book','课本目录'],['review','leaf','巩固本'],['progress','chart','学习记录'],['settings','settings','家长设置']];
  return `<div class="shell"><aside class="sidebar"><a class="brand" href="#today" data-nav="today"><span class="brand-mark">${icon('sprout')}</span><span><span class="brand-name">字芽</span><span class="brand-subtitle">一点一点，长出本领</span></span></a><nav aria-label="主要导航">${navigation.map(([id,im,label])=>`<a class="nav-link ${route===id?'active':''}" ${route===id?'aria-current="page"':''} href="#${id}" data-nav="${id}"><span class="nav-icon">${icon(im)}</span><span class="nav-label">${label}</span></a>`).join('')}</nav><div class="sidebar-note"><strong>一年级 · 语文上册</strong><p>每天 ${state.settings.minutes} 分钟<br>读一读，写一写，记牢一点点。</p><span>独立语文学习空间</span></div></aside><main class="main" id="main"><div id="cloud-status">${cloudBar()}</div>${storageProblem?`<div class="notice warning" role="alert">${esc(storageProblem)} ${button('导出本页备份','export','','secondary')}${storageBlocked&&originalStorage?button('导出原始记录','export-raw','','ghost'):''}</div>`:''}${content}</main></div><div id="modal-root"></div><div id="print-root"></div>`;
}
function top(title, sub, actions = '') {
  return `<header class="topbar"><div><p class="eyebrow">字芽 / 一年级上册 · ${dateLabel()}</p><h1 class="page-title">${title}</h1><p class="subtitle">${sub}</p></div><div class="header-actions">${actions || `<span class="pill">每天 ${state.settings.minutes} 分钟</span>`}</div></header>`;
}
function stat(label, value, detail, ratio) {
  return `<div class="stat-card"><span class="stat-label">${label}</span><strong class="stat-value">${value}</strong><p class="stat-detail">${detail}</p>${ratio===undefined?'':`<div class="progress-track"><div class="progress-fill" style="width:${ratio}%"></div></div>`}</div>`;
}
function row(item, action = 'study-one') {
  const st = status(item);
  const hidden = action === 'quiz-one' || (route === 'review' && !!st.lastAttemptDate);
  const reason = record(item)?.attempts.at(-1)?.reason;
  return `<li class="item-row"><div class="mini-character ${item.kind==='pinyin'?'latin':''}">${hidden?'?':esc(item.text)}</div><div class="item-main"><strong>${hidden?shortKind[item.kind]+' · 答案已收起':esc(item.content.word || item.pinyin || item.content.category || shortKind[item.kind])}</strong><small>${esc(item.unit)} · ${esc(item.title)}${reason?' · '+esc(reason):''}</small></div><span class="item-badge ${st.isDue?'warning':''}">${esc(st.label)}</span>${button(action==='quiz-one'?'复测':'学习',action,`data-id="${esc(item.id)}"`,'ghost small')}</li>`;
}
function dashboard() {
  const plan = buildDailyPlan(items,state,today());
  const current = curriculum.lessons.find(l=>l.order===state.settings.teacherOrder);
  const learned = items.filter(i=>status(i).studied || status(i).lastAttemptDate).length;
  const stable = items.filter(i=>status(i).stable).length;
  const testedToday = items.filter(i=>status(i).lastAttemptDate===today()).length;
  const newQueue = [...plan.newItems,...plan.recognition].sort((a,b)=>a.lessonOrder-b.lessonOrder);
  const hasWork = plan.review.length + plan.quiz.length + newQueue.length;
  return top('今天，让记住变成会用。','先学一点，再合上答案试一试。每天的小进步，都有迹可循。',button('调整老师进度','go-settings','','secondary')) +
    `<div class="dashboard-grid"><section class="hero"><div class="hero-copy"><p class="eyebrow">今日陪学 · ${state.settings.minutes} 分钟计划</p><h2>${hasWork?'陪她读写，慢慢扎根。':'今天的计划，已告一段落。'}</h2><p>${hasWork?`今天安排 ${newQueue.length} 项新学习、${plan.quiz.length} 项学后小测、${plan.review.length} 项到期复测。先完成旧内容的复测，再学习新的内容。`:'让记忆休息一下，明天再来试一试。也可以在课本目录中选择老师正在教的课。'}</p><div class="hero-actions">${hasWork?button(`${plan.review.length?'开始隔天复测':plan.quiz.length?'继续今日小测':'开始今日学习'} ${icon('arrow')}`,'start-daily','','primary large'):button('查看课本目录','go-courses','','primary large')}<span class="pill">${current?`进度：${esc(current.title)}`:'请设置教学进度'}</span></div></div><div class="hero-art" aria-hidden="true"><div class="tianzi">芽</div><div class="hero-pinyin latin">yá</div><span class="hero-sprout">${icon('sprout')}</span></div></section>
    <section class="stats-grid" aria-label="学习概况">${stat('今日新学习',`${newQueue.length}<small>项</small>`,'只安排老师已教到的内容')}${stat('等待复测',`${plan.summary.reviewDueCount}<small>项</small>`,'先回忆，再看答案')}${stat('今天已小测',`${testedToday}<small>项</small>`,'首次作答比反复刷分更有意义')}${stat('稳定掌握',`${stable}<small>/ ${items.length}</small>`,'经过不同日期与延迟复测', Math.round(stable/items.length*100))}</section>
    <section class="panel"><div class="section-heading"><h2>每天这样陪她学</h2><span>建议节奏 · 可灵活休息</span></div><ol class="plan-steps">${[['回想昨天','合上书，先试到期的内容。忘了也没关系。','4 分钟'],['少量新学','读准声音、观察结构、用手写一遍。','7 分钟'],['合上答案，小测一下','先在纸上写，家长再核对。提示过要如实记。','6 分钟'],['找出一处进步','说说哪里容易错，再写一次，明天重测。','3 分钟']].map(([t,d,time],i)=>`<li class="plan-step"><span class="step-number">${i+1}</span><div><h3>${t}</h3><p>${d}</p></div><span class="step-time">${time}</span></li>`).join('')}</ol><p class="source-note">时间是陪学建议；实际题量会按 ${state.settings.minutes} 分钟预算调整。今天不必做满整课。</p></section>
    <section class="panel"><div class="section-heading"><h2>今天要学什么</h2>${button('按课查看','go-courses','','ghost small')}</div>${newQueue.length?`<ul class="list">${newQueue.slice(0,5).map(i=>row(i)).join('')}</ul>`:`<div class="empty-state"><h3>${plan.quiz.length?'学过的内容，来小测一下':'先巩固，再往前走'}</h3><p>${plan.quiz.length?'刚学过还需要独立作答，才能记录为初步记住。':'当前没有新增安排。可以调整老师进度，或先完成到期复习。'}</p></div>`}<p class="source-note">已开始学习 ${learned} 项 · 识字、写字、拼音分别记录。</p></section>
    ${plan.overflowReviewCount||plan.overflowQuizCount?`<div class="notice warning full-width">还有 ${plan.overflowReviewCount+plan.overflowQuizCount} 项复习或小测超出今日预算，已保留在巩固本。可以明天继续，避免一次练太多。</div>`:''}
    <section class="panel full-width"><div class="section-heading"><h2>一册书，一条清楚的学习路线</h2><span>${curriculum.lessons.length} 个课次与园地</span></div><div class="book-summary"><span><strong>${curriculum.book.recognitionCount}</strong> 个识字字形</span><span><strong>${curriculum.book.writingCount}</strong> 个写字字形</span><span>拼音、声调、拼读规则按课安排</span></div><p class="source-note">依据人教社当前电子教材整理。例词和教学提示为陪学补充；课文原文请打开官方教材。</p></section></div>`;
}
function courses() {
  if (selectedLesson) return courseDetail(curriculum.lessons.find(l=>l.id===selectedLesson));
  const q = search.trim().toLowerCase();
  const visible = curriculum.lessons.filter(l=> (!q || [l.title,l.unit,...['write','recognize','pinyin'].flatMap(k=>(l[k]||[]).flatMap(x=>[x.text,x.pinyin||'']))].join(' ').toLowerCase().includes(q)) && (kindFilter==='all'||l[kindFilter]?.length));
  const units = [...new Set(visible.map(l=>l.unit))];
  return top('顺着课本，一课一课来。','识字、写字、拼音以及语文园地，保持教材中的先后顺序。')+`<div class="filters">${button('笔画与偏旁','go-references','','secondary')}<label class="sr-only" for="course-search">搜索课名、汉字或拼音</label><input id="course-search" class="search-input" placeholder="搜索课名、汉字或拼音" value="${esc(search)}">${[['all','全部'],['pinyin','拼音'],['write','会写的字'],['recognize','会认的字']].map(([k,l])=>button(l,'filter',`data-kind="${k}"`,`${kindFilter===k?'primary active':'secondary'}`)).join('')}</div><div class="course-grid">${units.map(unit=>`<section class="unit-group"><h2>${esc(unit)}</h2><div class="lesson-grid">${visible.filter(l=>l.unit===unit).map(l=>`<button class="lesson-card ${l.order===state.settings.teacherOrder?'selected':''}" data-action="lesson" data-id="${esc(l.id)}"><span class="lesson-head"><span class="lesson-order">${chineseNumber(l.order)}</span><span class="item-badge ${l.order>state.settings.teacherOrder?'neutral':''}">${l.order===state.settings.teacherOrder?'老师教到这里':l.order<state.settings.teacherOrder?'已到教学范围':'后续课程'}</span></span><h3>${esc(l.title)}</h3><p>课本第 ${esc(l.page)} 页</p><div class="character-list">${(l.write||[]).slice(0,7).map(c=>`<span class="char-chip">${esc(c.text)}</span>`).join('')}${!l.write?.length?(l.pinyin||[]).slice(0,5).map(c=>`<span class="char-chip">${esc(c.text)}</span>`).join(''):''}</div><div class="lesson-meta"><span>认 ${l.recognize?.length||0}</span><span>写 ${l.write?.length||0}</span>${l.pinyin?.length?`<span>拼音 ${l.pinyin.length} 项</span>`:''}</div></button>`).join('')}</div></section>`).join('')||'<div class="empty-state">没有找到匹配内容，换个词试试。</div>'}</div>`;
}
function courseDetail(l) {
  if (!l) {selectedLesson=null;return courses();}
  const ls = allLessonItems(l);
  return top(esc(l.title),`${esc(l.unit)} · 课本第 ${l.page} 页${l.pinyin?.some(c=>c.supplemental)?' · 带“自编巩固”的项目为补充练习':''}`,button('返回目录','close-lesson','','secondary'))+
    `<div class="lesson-actions">${button('跟着这一课学习','study-lesson',`data-id="${l.id}"`)}${button('看完这一课后练习','quiz-lesson',`data-id="${l.id}"`,'secondary')}${button('老师教到这里','set-teacher',`data-order="${l.order}"`,'ghost')}${button('打印默写纸','print-lesson',`data-id="${l.id}"`,'ghost')}<a class="button ghost" href="${esc(curriculum.book.sourceUrl)}" target="_blank" rel="noopener">查看原教材 ↗</a></div>
    ${l.order>state.settings.teacherOrder?'<div class="notice info">这一课还未加入每天的自动计划。老师教到后，点“老师教到这里”即可。</div>':''}
    ${['pinyin','write','recognize'].map(k=> l[k]?.length?`<section class="panel"><div class="section-heading"><h2>${kindLabel[k]}</h2><span>${l[k].length} 项${k==='recognize'?' · 不等于要求全部默写':''}</span></div><div class="learning-items">${l[k].map(c=>{const i=ls.find(x=>x.kind===k&&x.text===c.text&&(k!=='recognize'||x.pinyin===c.pinyin));return `<button class="content-tile" data-action="study-one" data-id="${esc(i?.id||'')}"><span class="tile-pinyin">${esc(c.pinyin||c.category||'')}</span><strong class="${k==='pinyin'?'latin':''}">${esc(c.text)}</strong><span>${esc(c.word|| (i?status(i).label:''))}</span></button>`;}).join('')}</div></section>`:'').join('')}
    ${l.notes?.length?`<section class="panel soft"><h2>这一课的陪学重点</h2><ul class="note-list">${l.notes.map(n=>`<li>${esc(n)}</li>`).join('')}</ul></section>`:''}<p class="source-note">教学提示、例词为自编陪学内容。教师规定的读音、笔顺和书写格式以课堂与教材为准。</p>`;
}
function reviewPage() {
  const due = items.filter(i=>isEligible(i)&&status(i).isDue);
  const weak = items.filter(i=>isEligible(i)&&['fail','hint'].includes(status(i).lastResult));
  const pending = items.filter(i=>isEligible(i)&&status(i).needsQuiz);
  return top('把还不稳的，再扶一扶。','错一次只是找到练习的方向。先遮住答案回忆，核对后再练最容易错的地方。')+
    `<section class="stats-grid">${stat('到期复测',due.length,'已到再次检验的日期')}${stat('需要再巩固',weak.length,'上次答错或需要提示')}${stat('学后待小测',pending.length,'只看过还不能算记住')}${stat('今日建议上限',state.settings.minutes+'<small>分钟</small>','练习可以分成两小段')}</section>`+
    [[due,'先做到期复测','review-due'],[pending,'已经学过，试着独立作答','quiz-pending'],[weak,'这些内容值得再看一看','study-weak']].map(([list,title,action])=>`<section class="panel"><div class="section-heading"><h2>${title}</h2>${list.length?button(action==='study-weak'?'重新学习':'开始小测',action,'','secondary'):''}</div>${list.length?`<ul class="list">${list.slice(0,24).map(i=>row(i,action==='study-weak'?'study-one':'quiz-one')).join('')}</ul>${list.length>24?`<p class="source-note">先展示24项，开始小测时会按今天的题量安排。</p>`:''}`:'<div class="empty-state"><p>这里暂时没有内容。随着学习记录，会自动出现需要巩固的项目。</p></div>'}</section>`).join('');
}
function progressPage() {
  const started=items.filter(i=>state.records[i.id]);
  const attempts=items.flatMap(i=>(record(i)?.attempts||[]).map(a=>({...a,item:i})));
  const dates=[...new Set(attempts.map(a=>a.date))].sort().reverse();
  const firsts=dates.slice(0,7).map(date=>{const seen=new Set(); const as=attempts.filter(a=>a.date===date).filter(a=>!seen.has(a.item.id)&&seen.add(a.item.id));return {date,total:as.length,pass:as.filter(a=>a.result==='pass').length,hint:as.filter(a=>a.result==='hint').length,fail:as.filter(a=>a.result==='fail').length};});
  return top('看见进步，也看见真实。','这里按家长核对的首次作答记录。不用一次满分，重要的是过几天还记得。')+
    `<section class="stats-grid">${stat('学习天数',new Set(started.flatMap(i=>[...record(i).studiedDates,...record(i).attempts.map(a=>a.date)])).size,'有学习或小测的日期')}${stat('稳定掌握',started.filter(i=>status(i).stable).length,'至少通过7天间隔的复测')}${stat('初步记住 / 巩固中',started.filter(i=>status(i).stage>0&&!status(i).stable).length,'继续按间隔检验')}${stat('累计作答',attempts.length,'包含重试，首次正确率另算')}</section>
    <section class="panel"><div class="section-heading"><h2>最近七个小测日</h2><span>每项只取当天第一次作答</span></div>${firsts.length?`<div class="history-list">${firsts.map(d=>`<div class="item-row"><div class="item-main"><strong>${d.date}</strong><small>独立正确 ${d.pass} · 提示 ${d.hint} · 需练习 ${d.fail}</small></div><div class="history-bar" aria-label="首次独立正确率 ${Math.round(d.pass/d.total*100)}%"><span style="width:${d.pass/d.total*100}%"></span></div><strong>${Math.round(d.pass/d.total*100)}%</strong></div>`).join('')}</div>`:'<div class="empty-state"><h3>第一笔记录，从今天开始。</h3><p>完成学习后的纸笔小测，就会在这里看到结果。</p></div>'}</section>
    <section class="panel"><h2>三种能力，分别长大</h2><div class="summary-grid">${['pinyin','write','recognize'].map(k=>{const all=items.filter(i=>i.kind===k), n=all.filter(i=>status(i).stable).length;return stat(shortKind[k],`${n}<small>/ ${all.length}</small>`,'稳定掌握项数',n/all.length*100);}).join('')}</div><p class="source-note">拼音包含63个教材基础项目和66项自编声调、拼读巩固。识字按读音分别记录，280个汉字对应284项读音。“稳定掌握”只表示平台上已记录的延迟复测表现，不是考试成绩预测。</p></section>
    <section class="panel"><div class="section-heading"><h2>每一项的掌握过程</h2>${button('导出进度备份','export','','secondary')}</div>${started.length?`<ul class="list">${started.slice().sort((a,b)=>(status(b).lastAttemptDate||'').localeCompare(status(a).lastAttemptDate||'')).slice(0,50).map(i=>`<li class="item-row"><div class="mini-character ${i.kind==='pinyin'?'latin':''}">${esc(i.text)}</div><div class="item-main"><strong>${shortKind[i.kind]} · ${esc(status(i).label)}</strong><small>${esc(i.title)} · ${record(i).attempts.length} 次记录${status(i).dueDate?` · 下次 ${status(i).dueDate}`:''}</small></div><span class="item-badge">阶段 ${status(i).stage} / 4</span></li>`).join('')}</ul>`:'<p>还没有学习记录。</p>'}</section>`;
}
function settingsPage() {
  settingsSnapshot={...state.settings};settingsEdited=false;
  return top('由你掌握，陪学的节奏。','老师进度以后再补充也可以；先从第一课开始，不会自动把后面的内容提前加入计划。')+
    `<form id="settings-form" class="panel"><div class="section-heading"><h2>学习安排</h2><span>保存后自动调整每天的题量</span></div><div class="settings-grid"><label class="form-field">老师已经教到<select name="teacherOrder">${curriculum.lessons.map(l=>`<option value="${l.order}" ${state.settings.teacherOrder===l.order?'selected':''}>${esc(l.unit)} · ${esc(l.title)}</option>`).join('')}</select><small>只限定自动计划；课本目录始终可以浏览全册。</small></label><label class="form-field">每天陪学时间<select name="minutes">${[10,15,20,25,30].map(n=>`<option ${state.settings.minutes===n?'selected':''} value="${n}">${n} 分钟${n===20?' · 当前建议':''}</option>`).join('')}</select></label><label class="form-field">每天最多新学几项<select name="newLimit">${[2,3,4,5,6,8].map(n=>`<option ${state.settings.newLimit===n?'selected':''} value="${n}">${n} 项</option>`).join('')}</select><small>按时间预算可能再减少，复习多时少加新内容。</small></label><label class="checkbox-row"><input type="checkbox" name="includeRecognition" ${state.settings.includeRecognition?'checked':''}><span>把“会认的字”也放进每日学习<small>识字采用开口认读，写字采用纸笔默写，分别记录。</small></span></label></div><button class="button primary" type="submit">保存学习安排</button></form>
    ${emailMode?`<section class="panel"><h2>语文账号</h2><p>${esc(currentAccount?.email||"已登录")}</p><p>只同步这个账号的语文记录。退出后，再次登录即可继续。</p>${button("退出账号","account-logout","","secondary")}</section>`:""}<section class="panel"><h2>手机、电脑，接着学</h2><p>在两台设备打开字芽，用同一个${emailMode?"语文邮箱账号":" ChatGPT 账号"}登录。老师教学进度、学习安排、已学内容、小测和错题会自动同步；切回页面也会检查更新。语文有自己的独立云端数据库，与英语平台完全分开。</p><p>网络暂时断开时，已完成的记录先保存在本机，联网后自动补传。换设备前请确认顶部显示“已同步”。当前尚未判分的题目不会生成成绩。</p><div class="backup-controls">${button('导出进度备份','export','','secondary')}<label class="button secondary">导入语文备份<input id="backup-file" type="file" accept="application/json,.json" class="sr-only"></label>${button('下载全册学习清单','download-curriculum','','ghost')}</div><p class="source-note">如果以前在本地预览地址学习，请先在那里导出，再到正式网站导入一次。导入会合并语文记录并采用备份中的学习安排；以后自动同步。清理浏览器前，先确认没有待上传记录。</p></section>
    <section class="panel"><h2>怎样判断真的记住了</h2><ol class="note-list"><li>先学习：读音、形状和写法；看答案不记作掌握。</li><li>合上答案独立作答，家长检查读音、声调、字形和书写。</li><li>只有独立正确才推进；提示后答对、写错或不会，明天再练。</li><li>同一天重复答对不升级。依次经过1天、3天、7天间隔复测，才记为稳定掌握；之后14天再检验。</li></ol><p class="source-note">间隔复习与主动回忆参考 <a href="https://ies.ed.gov/ncee/WWC/PracticeGuide/1" target="_blank" rel="noopener">IES 学习实践指南 ↗</a>。具体天数与题量是本平台的陪学安排，并未针对孩子进行效果试验。</p></section>
    <section class="panel"><div class="section-heading"><h2>教材与练习来源</h2>${button('笔画与偏旁','go-references','','secondary')}</div><p>${esc(curriculum.book.title)} · ${esc(curriculum.book.publisher)} · ${esc(curriculum.book.edition||'当前官方电子版')}</p><p>${esc(curriculum.book.verificationNote||'识字表、写字表和拼音课次均按原书整理。')}</p><div class="backup-controls"><a class="button secondary" href="${esc(curriculum.book.sourceUrl)}" target="_blank" rel="noopener">人教社官方教材 ↗</a><a class="button ghost" href="data/curriculum-verification.md" target="_blank" rel="noopener">查看内容核验说明 ↗</a></div><p class="source-note">本平台不收录整篇课文。词例、学习提示为自编；笔顺动画使用 Hanzi Writer / Make Me a Hanzi，课堂要求优先。<a href="assets/vendor/NOTICE.txt" target="_blank">开源许可</a></p></section>`;
}

function referencePage() {
  return top('写字的小工具箱。','笔画和偏旁按教材附录顺序列出，供遇到相应汉字时查阅。它们不等于新增的必默写字。',button('返回课本目录','go-courses','','secondary'))+
    [['strokes','常用笔画名称'],['radicals','常用偏旁名称']].map(([key,title])=>`<section class="panel"><div class="section-heading"><h2>${title}</h2><span>${references?.[key]?.length||0} 项</span></div><div class="reference-grid">${(references?.[key]||[]).map(r=>`<div class="reference-cell"><strong>${esc(r.symbol)}</strong><span>${esc(r.name)}${r.example?`<small>例：${esc(r.example)}</small>`:''}</span></div>`).join('')}</div></section>`).join('')+`<p class="source-note">${esc(references?.note||'参考教材附录，教学进度以课堂为准。')}</p>`;
}

function startStudy(queue, label = '今日学习') {
  if (!queue.length) return notify('没有待学习的内容，可以先调整老师进度。');
  session={ type:'study', queue:[...new Map(queue.map(i=>[i.id,i])).values()], index:0,label,startedAt:Date.now(), results:[],hidden:false };
  lastSummary=null; modal=null; route='today'; location.hash='today'; enterStudyItem(); render();window.scrollTo(0,0);
}
function enterStudyItem() {
  state=markStudied(state,session.queue[session.index].id,today());persist();
}
function startQuiz(queue,label='今日小测') {
  if (!queue.length) return notify('没有待测内容。先学一点，再来小测。');
  session={type:'quiz',queue:[...new Map(queue.map(i=>[i.id,i])).values()],index:0,label,startedAt:Date.now(),results:[],phase:'prompt',assisted:false,reason:''};
  lastSummary=null;modal=null;route='today';location.hash='today';render();window.scrollTo(0,0);
}
function dailyStart() {
  const p=buildDailyPlan(items,state,today());
  if(p.review.length)startQuiz(p.review,'隔天复测');else if(p.quiz.length)startQuiz(p.quiz,'今日小测');else startStudy([...p.newItems,...p.recognition].sort((a,b)=>a.lessonOrder-b.lessonOrder));
}
function sessionHeader() {
  return `<div class="stage-heading"><div><span class="eyebrow">${esc(session.label)}</span><h2>${session.type==='study'?'读一读，写一写。':'合上答案，自己试一试。'}</h2></div>${button('暂时结束','exit-session','','ghost')}</div><div class="session-progress"><div class="progress-track"><div class="progress-fill" style="width:${session.index/session.queue.length*100}%"></div></div><span>${session.index+1} / ${session.queue.length}</span></div>`;
}
function studyView() {
  const i=session.queue[session.index], c=i.content;
  return top('小小一页，慢慢学会。','先读、再观察、动手写。每次只学一点。')+`<section class="study-stage">${sessionHeader()}<div class="study-card"><div class="kind-label">${kindLabel[i.kind]}<span>${esc(i.title)}</span></div>${session.hidden?`<div class="answer-hidden"><span>现在，把它想出来。</span><p>${i.kind==='recognize'?'在心里想想刚才看到的字怎么读。':'在纸上试着写一遍，再打开对照。'}</p></div>`:`<div class="study-character-wrap"><div class="tile-pinyin large">${esc(i.pinyin)}</div>${i.kind==='pinyin'?pinyinGuide(i.text):`<div class="character-display tianzi" id="stroke-target">${esc(i.text)}</div>`}</div><p class="word-example">${esc(c.word||c.category||'读准声音，再记住字形')}</p>${c.toneForms?.length?`<div class="tone-list latin">${c.toneForms.map(t=>`<span>${esc(t)}</span>`).join('')}</div>`:''}<p class="teaching-tip">${esc(c.hint||(i.kind==='recognize'?'指着这个字读一读，在课本中找一找它。':'观察笔画和位置，再在纸上写一遍。'))}</p>${c.example?`<p class="source-note">练一练：${esc(c.example)}</p>`:''}`}
    <div class="study-controls">${!session.hidden&&i.kind!=='pinyin'?button(`${icon('sound')} 听读音`,'speak-study','','secondary'):''}${!session.hidden&&i.kind==='write'?button('看笔顺','animate-strokes','','secondary'):''}${button(session.hidden?'打开对照':i.kind==='recognize'?'遮住回想':'遮住试写','toggle-study','','secondary')}</div><div class="study-footer">${button(session.index+1===session.queue.length?'学完了，准备小测':'这一项学完了 · 下一项','study-next','','primary large')}</div><p class="source-note">学习完成只是第一步；独立小测之后才记录“初步记住”。</p></div></section>`;
}
function quizView() {
  const i=session.queue[session.index],c=i.content, answer=session.phase==='answer';
  const ordinal=session.index+1;
  return top(session.label==='隔天复测'?'过了几天，还记得吗？':i.kind==='recognize'?'试一试，能自己读出来吗？':'试一试，能自己写出来吗？','家长先确认题目，让孩子独立作答，再打开答案核对。')+`<section class="quiz-stage">${sessionHeader()}<div class="study-card"><div class="kind-label">${kindLabel[i.kind]}<span>第 ${ordinal} 题</span></div>${answer?`<div class="answer-reveal"><span class="eyebrow">核对答案</span><div class="tile-pinyin large">${esc(i.pinyin)}</div><div class="${i.kind==='pinyin'?'pinyin-display latin':'character-display tianzi'}">${esc(i.text)}</div><p class="word-example">${esc(c.word||c.category||'')}</p><p class="teaching-tip">${esc(c.hint||'核对字形、笔画、读音与声调。')}</p></div><div class="notice ${session.assisted?'warning':'info'}">${session.assisted?'这题用过提示，答对也会安排再练。':'请对照孩子刚才已经完成的答案判分；不要把对照后改正当成独立正确。'}</div><div class="error-tags" aria-label="记录容易错的方面">${['字形/笔画','读音/声调','拼写顺序','暂时想不起来'].map(reason=>`<button class="button ${session.reason===reason?'primary':'ghost'} small" data-action="reason" data-value="${reason}">${reason}</button>`).join('')}</div><div class="grade-buttons">${!session.assisted?button(`${icon('check')} 独立正确`,'grade','data-result="pass"','correct'):''}${button('提示后答对','grade','data-result="hint"','hinted')}${button('写错 / 还不会','grade','data-result="fail"','incorrect')}</div>`:`<div class="answer-hidden">${i.kind==='recognize'?`<div class="character-display">${esc(i.text)}</div>${c.word?`<p class="word-example">${esc(c.word)}</p>`:''}<p>${c.word?'读出词语中这个字的读音。':'请读出这个字，并试着说一个词。'}</p>`:`<div class="paper-icon" aria-hidden="true">?</div><h3>听题后，在纸上写${i.kind==='write'?'一个字':'拼音'}。</h3><p>请家长读题，答案暂时收起来了。</p>`}</div><div class="study-controls">${i.kind!=='recognize'?button('家长看题目','parent-prompt','','secondary'):''}${i.kind==='write'?button(`${icon('sound')} 听题`,'speak-question','','secondary'):''}</div><div class="study-footer">${button(i.kind==='recognize'?'我已经独立读好了 · 核对':'我已经独立写好了 · 核对','independent-done','','primary large')}${button('想不起来，给我提示','need-hint','','ghost')}</div><p class="source-note">写字请准备铅笔与纸；平台由家长判分，不会自动识别纸上的字。</p>`}</div></section>`;
}
function saveSessionTime() {
  if(!session)return;
  const minutes=Math.min(60,Math.max(0,Math.round((Date.now()-session.startedAt)/6000)/10));
  state={...state,sessions:[...state.sessions,{date:today(),minutes,id:crypto.randomUUID(),at:new Date().toISOString()}].slice(-3660)};persist();
}
function finishSession() {
  saveSessionTime();
  lastSummary={...session};session=null;writer=null;render();window.scrollTo(0,0);
}
function summaryView() {
  const s=lastSummary, n=s.results.length, passes=s.results.filter(r=>r.result==='pass').length;
  const weak=s.results.filter(r=>r.result!=='pass');
  const plan=buildDailyPlan(items,state,today());
  return top('今天的努力，已经留下来了。','做对了就给自己一个肯定；还不稳的，我们下次再试。')+`<section class="panel session-summary"><div class="summary-emblem">${icon('sprout')}</div><h2>${s.type==='study'?'学完一小组，现在来试试。':`完成 ${n} 项小测，辛苦啦。`}</h2><p>${s.type==='study'?'接下来合上答案，在纸上写或者开口读，由家长核对。':`独立正确 ${passes} 项，${weak.length} 项需要继续巩固。当天的正确只是开始，之后还会再检验。`}</p>${s.type==='quiz'?`<div class="summary-grid">${stat('独立正确',passes,'如实核对的这次作答')}${stat('提示或需练',weak.length,'明天会重新安排')}${stat('延迟验证','1 → 3 → 7<small>天</small>','隔几天还会，才算更稳')}</div>`:''}<div class="hero-actions">${s.type==='study'?button('合上答案，开始小测','quiz-studied'):plan.review.length||plan.quiz.length||plan.newItems.length||plan.recognition.length?button('继续今日计划','continue-daily'):button('回到今天','finish-back')}${s.type==='quiz'&&weak.length?button('再看一遍易错项','study-summary-weak','','secondary'):''}${button('休息一下','finish-back','','ghost')}</div></section>${weak.length?`<section class="panel"><h2>下一次，重点看这些</h2><ul class="list">${weak.map(r=>`<li class="item-row"><div class="mini-character ${r.item.kind==='pinyin'?'latin':''}">${esc(r.item.text)}</div><div class="item-main"><strong>${shortKind[r.item.kind]} · ${esc(r.item.pinyin||r.item.content.category||'')}</strong><small>${esc(r.reason||'需要再巩固')} · 明天再试</small></div></li>`).join('')}</ul></section>`:''}`;
}
function render() {
  if(emailMode&&!currentAccount)return;
  writer=null;
  const content=session?(session.type==='study'?studyView():quizView()):lastSummary?summaryView():({today:dashboard,courses,review:reviewPage,progress:progressPage,settings:settingsPage,references:referencePage}[route]||dashboard)();
  $app.innerHTML=shell(content);renderModal();
}
function renderModal() {
  const target=document.querySelector('#modal-root');if(!target)return;
  if(!modal){target.innerHTML='';return;}
  let content;
  if(modal.type==='parent') {
    const i=session.queue[session.index];
    content=`<p class="eyebrow">仅供家长看 · 请背向孩子</p><h2>这道题，请这样读</h2><div class="parent-prompt">${i.kind==='write'?`请写“${esc(i.content.word||i.text)}”的“${esc(i.text)}”。`:`请听家长读“<span class="latin">${esc(i.text)}</span>”，再写下来。`}</div><p>${i.kind==='pinyin'?'请按老师的课堂读音读出，检查声调和占格。这里不用机器朗读单个拼音字母，避免读成英语。':'只要求写出指定的一个字。可读两遍，让孩子先独立完成。'}</p><div class="dialog-actions">${button('已记住题目，遮住继续','close-parent')}${button('孩子看到了答案','parent-seen','','secondary')}</div>`;
  } else if(modal.type==='leave') {
    content=`<h2>先休息一下吗？</h2><p>已经完成的学习与判分都已保存。当前未判分的题目不记成绩。</p><div class="dialog-actions">${button('结束这一小组','confirm-leave')}${button('继续练习','close-modal','','secondary')}</div>`;
  } else if(modal.type==='import') {
    content=`<h2>导入这份语文进度？</h2><p>备份包含 ${Object.keys(modal.state.records).length} 项学习记录，学习时间设为 ${modal.state.settings.minutes} 分钟。导入会合并已有语文记录，并采用备份中的学习安排，再同步到同一账号的其他设备。</p><p>建议先导出当前进度留存。</p><div class="dialog-actions">${button('先导出当前进度','export','','secondary')}${button('确认导入','confirm-import')}${button('取消','close-modal','','ghost')}</div>`;
  } else if(modal.type==='logout') {
    content=`<h2>退出这个语文账号？</h2><p>${cloud?.pending().length||dirtyPersist?'还有记录没有同步。请先导出备份；下次用这个账号在本机登录时，会继续补传。':'已同步的学习记录会保留，下次登录可以继续。'}退出后，这台设备会回到登录页。</p><div class="dialog-actions">${button('导出备份','export','','secondary')}${button('退出账号','confirm-logout')}${button('继续学习','close-modal','','ghost')}</div>`;
  }
  target.innerHTML=`<div class="overlay"><section class="dialog" role="dialog" aria-modal="true" aria-label="${modal.type==='parent'?'家长看题目':modal.type==='import'?'导入进度':modal.type==='logout'?'退出账号':'结束练习'}">${content}</section></div>`;
  target.querySelector('button')?.focus();
}
function speak(text) {
  if(!('speechSynthesis'in window)){notify('当前浏览器不支持朗读，请由家长读题。');return;}
  speechSynthesis.cancel();const utterance=new SpeechSynthesisUtterance(text);utterance.lang='zh-CN';utterance.rate=.72;
  const voice=speechSynthesis.getVoices().find(v=>/zh[-_]CN/i.test(v.lang));if(voice)utterance.voice=voice;
  utterance.onerror=()=>notify('朗读没有成功，请由家长读题。');speechSynthesis.speak(utterance);
}
async function animateStrokes() {
  const item=session?.queue[session.index];if(!item||item.kind!=='write')return;
  const target=document.querySelector('#stroke-target');
  try {
    if(a==='account-logout'){modal={type:'logout'};renderModal();return;}
    if(a==='confirm-logout'){if(session)saveSessionTime();await accountService.signOut();connectAccount(null);return;}
    const [module,data]=await Promise.all([import('./vendor/hanzi-writer.esm.js'),strokesPromise||=(fetch('data/strokes.json').then(r=>{if(!r.ok)throw Error();return r.json();}))]);
    if(!data[item.text])throw Error();
    if(!target.isConnected)return;
    target.textContent='';
    writer=module.default.create(target,item.text,{width:190,height:190,padding:16,strokeColor:'#315b49',outlineColor:'#e0e4d7',drawingColor:'#b9583f',showCharacter:false,strokeAnimationSpeed:.8,delayBetweenStrokes:220,charDataLoader:(char,complete)=>complete(data[char])});
    await writer.animateCharacter();
  }catch {notify('笔顺动画暂时不可用，请对照课本笔顺示范。');if(target.isConnected)target.textContent=item.text;}
}
function download(name,text,type='application/json') {
  const url=URL.createObjectURL(new Blob([text],{type}));const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
function curriculumMarkdown() {
  return `# 字芽 · 一年级上册学习清单\n\n来源：${curriculum.book.sourceUrl}\n\n按教材课序整理：280个识字字形（284项读音）、100个会写字、63个基础拼音项目。另附66项明确标注的自编巩固练习。\n\n识字不等于都要默写。提示和例词为自编陪学内容；老师课堂及实物课本要求优先。\n\n`+curriculum.lessons.map(l=>`## ${l.order}. ${l.unit} · ${l.title}（第${l.page}页）\n\n${['pinyin','write','recognize'].map(k=>{
    const list=(l[k]||[]).filter(c=>!c.supplemental);
    return list.length?`- ${shortKind[k]}：${list.map(c=>`${c.text}${c.pinyin?'（'+c.pinyin+'）':''}`).join('、')}\n`:'';
  }).join('')}${l.pinyin?.some(c=>c.supplemental)?`- 自编声调与拼读巩固：${l.pinyin.filter(c=>c.supplemental).map(c=>c.text).join('、')}\n`:''}\n${(l.notes||[]).map(n=>'- '+n).join('\n')}\n`).join('\n');
}

function printLesson(l) {
  const ls=allLessonItems(l).filter(i=>i.kind!=='recognize');
  if(!ls.length)return notify('这一课以认读为主，没有默写项目。');
  const prompts=ls.map((i,k)=>`<li>${k+1}. ${i.kind==='write'?`${esc(i.content.word||i.text)}的${esc(i.text)}`:esc(i.text)} ${i.pinyin?'（'+esc(i.pinyin)+'）':''}</li>`).join('');
  document.querySelector('#print-root').innerHTML=`<div class="print-sheet"><h1>字芽 · ${esc(l.title)} · 默写纸</h1><p>日期：__________　姓名：__________　请听家长读题后写。</p><div class="print-grid">${ls.map((i,k)=>`<div class="print-item"><span>${k+1}. ${shortKind[i.kind]}</span><div class="${i.kind==='write'?'tianzi':'pinyin-lines'}"></div><small>独立正确 □　提示 □　再练 □</small></div>`).join('')}</div><section class="print-answers"><h2>家长读题与核对页（请与孩子练习页分开）</h2><ol>${prompts}</ol><p>纸上练习后，可回到平台进行小测并记录家长核对结果。</p></section></div>`;
  window.print();
}

$app.addEventListener('click',async event=>{
  const nav=event.target.closest('[data-nav]');if(nav){event.preventDefault();if(!session)lastSummary=null;navigate(nav.dataset.nav);return;}
  const el=event.target.closest('[data-action]');if(!el)return;
  const a=el.dataset.action,id=el.dataset.id;
  try {
    if(a==='sync-now'){await cloud?.syncNow();if(cloud?.status.message)notify(cloud.status.message);return;}
    if(a==='go-settings'||a==='go-courses'){lastSummary=null;navigate(a==='go-settings'?'settings':'courses');}
    else if(a==='go-references'){lastSummary=null;navigate('references');}
    else if(a==='filter'){kindFilter=el.dataset.kind;render();}
    else if(a==='lesson'){selectedLesson=id;render();window.scrollTo(0,0);}
    else if(a==='close-lesson'){selectedLesson=null;render();}
    else if(a==='set-teacher'){state.settings.teacherOrder=Number(el.dataset.order);persist({teacherOrder:state.settings.teacherOrder});render();notify('已更新老师教学进度。');}
    else if(a==='start-daily'||a==='continue-daily'){lastSummary=null;dailyStart();}
    else if(a==='study-one'){const i=itemMap.get(id);if(i)startStudy([i],esc(i.title));}
    else if(a==='quiz-one'){const i=itemMap.get(id);if(i)startQuiz([i],status(i).isDue?'隔天复测':'单项小测');}
    else if(a==='study-lesson'){const l=curriculum.lessons.find(l=>l.id===id);startStudy(allLessonItems(l).filter(i=>state.settings.includeRecognition||i.kind!=='recognize'),l.title);}
    else if(a==='quiz-lesson'){const l=curriculum.lessons.find(l=>l.id===id);const q=allLessonItems(l).filter(i=>state.settings.includeRecognition||i.kind!=='recognize');for(const i of q)state=markStudied(state,i.id,today());persist();startQuiz(q,l.title+' · 学后练习');}
    else if(a==='review-due'){const p=buildDailyPlan(items,state,today());startQuiz(p.review,'隔天复测');}
    else if(a==='quiz-pending'){const p=buildDailyPlan(items,state,today());startQuiz(p.quiz,'今日小测');}
    else if(a==='study-weak')startStudy(items.filter(i=>isEligible(i)&&['hint','fail'].includes(status(i).lastResult)).slice(0,state.settings.newLimit||6),'易错项重学');
    else if(a==='study-next'){if(++session.index>=session.queue.length)finishSession();else{session.hidden=false;enterStudyItem();render();}}
    else if(a==='toggle-study'){session.hidden=!session.hidden;render();}
    else if(a==='speak-study'){const i=session.queue[session.index];speak(i.content.word||i.text);}
    else if(a==='animate-strokes')await animateStrokes();
    else if(a==='quiz-studied'){const q=lastSummary.queue;startQuiz(q,'学后小测');}
    else if(a==='finish-back'){lastSummary=null;route='today';render();}
    else if(a==='parent-prompt'){modal={type:'parent'};renderModal();}
    else if(a==='close-parent'){modal=null;renderModal();}
    else if(a==='parent-seen'){session.assisted=true;modal=null;render();notify('已记录使用提示，这题不计为独立正确。');}
    else if(a==='speak-question'){const i=session.queue[session.index];speak(`请写${i.content.word||i.text}的${i.text}`);}
    else if(a==='independent-done'){session.phase='answer';render();}
    else if(a==='need-hint'){session.assisted=true;session.phase='answer';render();}
    else if(a==='reason'){session.reason=el.dataset.value;render();}
    else if(a==='grade'){
      if(!session||session.phase!=='answer')return;
      const i=session.queue[session.index],result=session.assisted&&el.dataset.result==='pass'?'hint':el.dataset.result;
      state=recordAttempt(state,i.id,{date:today(),result,reason:session.reason,id:crypto.randomUUID(),at:new Date().toISOString(),mode:status(i).lastAttemptDate?'review':'quiz'});persist();
      session.results.push({item:i,result,reason:session.reason});
      if(++session.index>=session.queue.length)finishSession();else{session.phase='prompt';session.assisted=false;session.reason='';render();}
    }
    else if(a==='study-summary-weak')startStudy(lastSummary.results.filter(r=>r.result!=='pass').map(r=>r.item),'易错项重学');
    else if(a==='exit-session'){modal={type:'leave',next:'today'};renderModal();}
    else if(a==='confirm-leave'){saveSessionTime();route=modal.next;session=null;modal=null;lastSummary=null;render();}
    else if(a==='close-modal'){modal=null;renderModal();}
    else if(a==='export-raw'){download(`字芽-待恢复原始记录-${today()}.json`,originalStorage);}
    else if(a==='export'){download(`字芽-语文进度-${today()}.json`,exportState(state));notify('备份已导出，请保留这份文件。');}
    else if(a==='confirm-import'){const patch={...modal.state.settings};state=mergeStates(state,modal.state,patch,items.map(i=>i.id));modal=null;storageBlocked=false;persist(patch);render();notify('语文进度已合并，联网后会自动同步。');}
    else if(a==='download-curriculum')download('一年级上册-按课序学习清单.md',curriculumMarkdown(),'text/markdown;charset=utf-8');
    else if(a==='print-lesson')printLesson(curriculum.lessons.find(l=>l.id===id));
  } catch(error) {notify(error.message||'操作未完成，请再试一次。');}
});
$app.addEventListener('input',event=>{
  if(event.target.closest('#settings-form'))settingsEdited=true;
  if(event.target.id==='course-search'){const pos=event.target.selectionStart;search=event.target.value;render();const input=document.querySelector('#course-search');input.focus();input.setSelectionRange(pos,pos);}
});
$app.addEventListener('submit',event=>{
  if(event.target.id!=='settings-form')return;event.preventDefault();const fd=new FormData(event.target);
  const selected={minutes:Number(fd.get('minutes')),teacherOrder:Number(fd.get('teacherOrder')),newLimit:Number(fd.get('newLimit')),includeRecognition:fd.has('includeRecognition')};
  const patch=Object.fromEntries(Object.entries(selected).filter(([key,value])=>value!==settingsSnapshot[key]));
  state.settings={...state.settings,...patch};persist(patch);render();notify('学习安排已保存。');
});
$app.addEventListener('change',async event=>{
  if(event.target.closest('#settings-form'))settingsEdited=true;
  if(event.target.id!=='backup-file')return;
  const f=event.target.files[0];if(!f)return;
  try{if(f.size>2_000_000)throw Error('备份文件超过2 MB。');const imported=importState(await f.text(),items.map(i=>i.id));if(imported.settings.teacherOrder>curriculum.lessons.at(-1).order)throw Error('备份教学进度超出本册范围。');modal={type:'import',state:imported};renderModal();}catch(e){notify(e.message);}
  event.target.value='';
});
document.addEventListener('keydown',event=>{
  if(!modal)return;
  if(event.key==='Escape'){modal=null;renderModal();}
  if(event.key==='Tab'){const nodes=[...document.querySelectorAll('.dialog button,.dialog a,.dialog input')];if(!nodes.length)return;const first=nodes[0],last=nodes.at(-1);if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}}
});
window.addEventListener('beforeunload',event=>{if(session||dirtyPersist){event.preventDefault();event.returnValue='';}});
window.addEventListener('storage',event=>{if(event.key?.startsWith(CLOUD_PREFIX)&&cloud){try{cloud.refreshLocal();}catch{notify('本机记录暂未合并，请先导出备份。');}}});
window.addEventListener('online',()=>cloud?.syncNow());
window.addEventListener('focus',()=>cloud?.syncNow());
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')cloud?.syncNow();});
setInterval(()=>{if(document.visibilityState==='visible')cloud?.syncNow();},20000);
window.addEventListener('hashchange',()=>{if(emailMode&&!currentAccount)return;const r=location.hash.slice(1);if(!session&&r!==route&&['today','courses','review','progress','settings','references'].includes(r)){route=r;lastSummary=null;render();}});

function connectAccount(authSession,configurationError='') {
  const user=authSession?.user;
  if(user?.id===currentAccount?.id&&user&&!passwordRecovery)return;
  accountGeneration++;const generation=accountGeneration;
  cloud?.close();cloud=null;accountGateCleanup?.();accountGateCleanup=null;
  currentAccount=null;state=createState();state.settings.includeRecognition=true;
  session=null;modal=null;lastSummary=null;selectedLesson=null;search='';kindFilter='all';
  dirtyPersist=false;storageBlocked=false;storageProblem='';failedSettingsPatch={};settingsEdited=false;originalStorage='';
  if("speechSynthesis" in window)speechSynthesis.cancel();
  if(!user||passwordRecovery){
    accountGateCleanup=mountAccountGate($app,{account:accountService,configurationError,mode:passwordRecovery?'recovery':'login',onPasswordChanged:async()=>{passwordRecovery=false;connectAccount(await accountService.current());}});
    return;
  }
  currentAccount=user;syncStatus={phase:'syncing',pending:0};
  try{
    cloud=new ProgressSync({storage:localStorage,ownerId:user.id,namespace:accountService.namespace,knownIds:items.map(i=>i.id),fetcher:makeSupabaseProgressFetcher({client:accountService.client,ownerId:user.id,knownIds:items.map(i=>i.id)}),loginMessage:'请用原来的语文账号重新登录。',onState:next=>{if(generation===accountGeneration)receiveCloud(next);},onStatus:value=>{if(generation===accountGeneration)updateCloudStatus(value);}});
    state=cloud.state;
  }catch(error){storageBlocked=true;dirtyPersist=true;storageProblem=`本机记录暂未打开：${error.message} 请保留当前浏览器数据。`;}
  route=['today','courses','review','progress','settings','references'].includes(location.hash.slice(1))?location.hash.slice(1):'today';
  render();cloud?.syncNow();
}

export async function boot({account,configurationError}={}){
  $app.innerHTML='<main class="boot-screen"><span class="brand-mark">'+icon('sprout')+'</span><h1>字芽</h1><p>正在打开这一册的学习内容…</p></main>';
  try{
    const response=await fetch('data/curriculum.json');if(!response.ok)throw Error('课程资料暂时没有加载成功。');
    curriculum=await response.json();
    const practiceResponse=await fetch('data/practices.json');if(!practiceResponse.ok)throw Error('拼音巩固资料加载失败。');
    const practices=await practiceResponse.json();
    for(const e of practices.exercises){const l=curriculum.lessons.find(l=>l.id===e.lessonId);if(!l)throw Error('拼音练习的课次不一致。');l.pinyin.push({...e,supplemental:true});}
    const refResponse=await fetch('data/references.json');references=refResponse.ok?await refResponse.json():null;
    items=flattenCurriculum(curriculum);itemMap=new Map(items.map(i=>[i.id,i]));
    if(emailMode){
      accountService=account;
      if(!account){connectAccount(null,configurationError||'账号服务暂未连接。');return;}
      account.watch((event,authSession)=>{
        if(event==='PASSWORD_RECOVERY')passwordRecovery=true;
        if(event==='SIGNED_OUT')passwordRecovery=false;
        connectAccount(authSession);
      });
      const authSession=await account.current();passwordRecovery=account.recovering;
      connectAccount(authSession);return;
    }
    state=createState();state.settings.includeRecognition=true;
    try{const saved=localStorage.getItem(STORAGE_KEY);originalStorage=saved||'';if(saved&&!$app.dataset.accountId)state=importState(saved,items.map(i=>i.id));}catch(e){storageBlocked=true;storageProblem=`已有进度未能读取：${e.message} 已保护原记录；本次操作暂不写入。请导出原始记录或导入有效备份恢复。`;dirtyPersist=true;}
    route=['today','courses','review','progress','settings','references'].includes(location.hash.slice(1))?location.hash.slice(1):'today';
    if($app.dataset.accountId&&!storageBlocked){
      try{cloud=new ProgressSync({storage:localStorage,ownerId:$app.dataset.accountId,knownIds:items.map(i=>i.id),onState:receiveCloud,onStatus:updateCloudStatus});state=cloud.state;}
      catch(e){storageBlocked=true;dirtyPersist=true;storageProblem=`已有记录未能打开：${e.message} 请先导出备份，保留原记录。`;}
    }else syncStatus={phase:'local',pending:0};
    render();cloud?.syncNow();
  }catch(e){$app.innerHTML=`<main class="boot-screen"><h1>暂时没能打开字芽</h1><p>${esc(e.message)}</p><button class="button primary" onclick="location.reload()">重新加载</button></main>`;}
}
if(!emailMode)boot();
