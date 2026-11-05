'use strict';
/* 电阻器质量系统 · 前端（零依赖） */

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
// 单引号也要转义：属性值可能写成 data-x='…'（如预警行的 data-act），漏掉就能跳出属性注入
const esc = s => (s == null ? '' : String(s).replace(/[&<>"']/g, c => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c])));
const fmt = (v, d = 2) => (v == null || v === '' ? '—' : Number(v).toFixed(d));
/**
 * SPC 数值显示：最多 maxDecimals 位小数（默认 6），并同时约束整数位数，
 * 使单个数值不超过约 14 个字符——避免“小数点前很长 + 6 位小数”继续撑破表格。
 * 极小/极大值改用科学计数法，防止被四舍五入成 0 或显示成无意义的整数串。
 */
const spcNum = (v, maxDecimals = 6) => {
  if (v == null || v === '') return '—';
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  if (n === 0) return '0';
  const abs = Math.abs(n);
  if (abs < 1e-6 || abs >= 1e12) return n.toExponential(3).replace(/\.?0+e/, 'e');
  const intDigits = Math.max(1, Math.floor(Math.log10(abs)) + 1);
  // 13 位留给“整数 + 小数点 + 小数”，单个数值不超过 14 个字符
  const decimals = Math.max(0, Math.min(maxDecimals, 13 - intDigits));
  const text = n.toFixed(decimals);
  return text.includes('.') ? text.replace(/0+$/, '').replace(/\.$/, '') : text;
};

function toast(msg, kind = '') {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast show ' + kind;
  clearTimeout(t._h);
  t._h = setTimeout(() => (t.className = 'toast'), 2600);
}

let activeDialogCancel = null;

function showFormDialog({
  title,
  description = '',
  fields = [],
  confirmText = '确认',
  cancelText = '取消',
  danger = false,
  validate,
}) {
  if (activeDialogCancel) activeDialogCancel();
  return new Promise(resolve => {
    const previousFocus = document.activeElement;
    const backdrop = document.createElement('div');
    backdrop.id = 'appDialogBackdrop';
    backdrop.className = 'app-dialog-backdrop';
    const fieldHtml = fields.map((field, index) => {
      const id = `appDialogField${index}`;
      const required = field.required ? ' required' : '';
      const attrs = `id="${id}" name="${esc(field.key)}"${required}`;
      let control;
      if (field.type === 'textarea') {
        control = `<textarea ${attrs} rows="${field.rows || 4}" placeholder="${esc(field.placeholder || '')}">${esc(field.value ?? '')}</textarea>`;
      } else if (field.type === 'select') {
        control = `<select ${attrs}>${(field.options || []).map(option => {
          const value = typeof option === 'object' ? option.value : option;
          const label = typeof option === 'object' ? option.label : option;
          return `<option value="${esc(value)}" ${String(value) === String(field.value ?? '') ? 'selected' : ''}>${esc(label)}</option>`;
        }).join('')}</select>`;
      } else {
        const type = field.type || 'text';
        const min = field.min == null ? '' : ` min="${esc(field.min)}"`;
        const max = field.max == null ? '' : ` max="${esc(field.max)}"`;
        const step = field.step == null ? '' : ` step="${esc(field.step)}"`;
        control = `<input ${attrs} type="${esc(type)}" value="${esc(field.value ?? '')}" placeholder="${esc(field.placeholder || '')}"${min}${max}${step}>`;
      }
      return `<div class="field app-dialog-field">
        <label for="${id}">${esc(field.label)}${field.required ? ' <span class="app-dialog-required">*</span>' : ''}</label>
        ${control}
        ${field.hint ? `<small class="app-dialog-hint">${esc(field.hint)}</small>` : ''}
      </div>`;
    }).join('');
    backdrop.innerHTML = `
      <form class="app-dialog" role="dialog" aria-modal="true" aria-labelledby="appDialogTitle">
        <div class="app-dialog-head">
          <div><h2 id="appDialogTitle">${esc(title)}</h2>${description ? `<p>${esc(description)}</p>` : ''}</div>
          <button type="button" class="x" data-dialog-cancel aria-label="关闭">✕</button>
        </div>
        <div class="app-dialog-body">
          ${fieldHtml}
          <div class="app-dialog-error" role="alert" hidden></div>
        </div>
        <div class="app-dialog-actions">
          <button type="button" class="btn ghost" data-dialog-cancel>${esc(cancelText)}</button>
          <button type="submit" class="btn${danger ? ' danger' : ''}">${esc(confirmText)}</button>
        </div>
      </form>`;
    document.body.appendChild(backdrop);
    const form = $('form', backdrop);
    const error = $('.app-dialog-error', backdrop);
    const cancel = () => finish(null);
    const finish = value => {
      document.removeEventListener('keydown', onKeydown);
      activeDialogCancel = null;
      backdrop.remove();
      previousFocus?.focus?.();
      resolve(value);
    };
    const onKeydown = event => {
      if (event.key === 'Escape') {
        event.preventDefault();
        cancel();
      } else if (event.key === 'Tab') {
        const focusable = $$('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled])', form);
        if (!focusable.length) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    activeDialogCancel = cancel;
    document.addEventListener('keydown', onKeydown);
    $$('[data-dialog-cancel]', backdrop).forEach(button => button.onclick = cancel);
    backdrop.onclick = event => {
      if (event.target === backdrop) cancel();
    };
    form.onsubmit = async event => {
      event.preventDefault();
      error.hidden = true;
      const values = {};
      fields.forEach(field => {
        const control = form.elements[field.key];
        values[field.key] = control ? control.value : '';
      });
      const problem = fields.find(field => field.required && !String(values[field.key] ?? '').trim());
      if (problem) {
        error.textContent = `请填写${problem.label}`;
        error.hidden = false;
        form.elements[problem.key]?.focus();
        return;
      }
      try {
        const message = validate ? await validate(values) : '';
        if (message) {
          error.textContent = message;
          error.hidden = false;
          return;
        }
        finish(values);
      } catch (e) {
        error.textContent = e.message || '内容校验失败';
        error.hidden = false;
      }
    };
    (form.elements[fields[0]?.key] || $('[type="submit"]', form))?.focus();
  });
}

function showConfirmDialog(title, description, options = {}) {
  return showFormDialog({ title, description, fields: [], ...options }).then(Boolean);
}

// S-07：project.phase 是 0–5，数组必须同为 0-based，不能整体错位一位
const phaseName = n => ['组织与准备', '策划和定义项目', '产品设计和开发', '过程设计和开发',
  '产品和过程确认', '反馈、评定和纠正措施'][n] || '—';
const STAGE = { PROTO: '样件', PILOT: '试生产', SOP: '量产' };
// D-10：特性来源使用受控词表（datalist 仍允许历史自由文本）
const CHAR_SOURCE_TYPES = ['客户图纸', '客户规范', 'AEC-Q200', 'IEC 标准', '国家标准',
  '试验报告', '内部', 'DOE', '工艺验证', '8D/FA', '其他'];

const NAV = [
  { g: '项目工作台' },
  { id: 'projects', t: '项目清单' },
  { id: 'dash', t: '项目总览' },
  { id: 'alerts', t: '预警中心' },
  { g: 'APQP 项目管理' },
  { id: 'apqp', t: 'APQP 阶段管理' },
  { id: 'gates', t: '门径评审' },
  { id: 'tree', t: '交付物影响分析' },
  { g: '质量工程工具' },
  { id: 'fmea', t: 'FMEA' },
  { id: 'cp', t: '控制计划' },
  { id: 'spc', t: 'SPC 过程监控' },
  { id: 'msa', t: 'MSA 测量系统分析' },
  { id: 'ppap', t: 'PPAP 提交' },
  { g: '质量规则与基础数据' },
  { id: 'processdict', t: '工序字典' },
  { id: 'chardict', t: '特性字典' },
  { id: 'productdict', t: '产品族/系列字典' },
  { id: 'apmatrix', t: 'AP 矩阵与等级规则' },
  { g: '质量追溯与闭环' },
  { id: 'chars', t: '特性穿透' },
  { id: 'loop', t: '闭环视图' },
  { g: '变更与版本控制' },
  { id: 'ecr', t: '工程变更管理' },
  { id: 'baseline', t: '基线与版本差异' },
  { g: '审计与系统维护' },
  { id: 'exports', t: '导出审计' },
  { id: 'users', t: '账号与权限', perm: 'user.manage' },
  { id: 'backups', t: '数据库备份', perm: 'backup.manage' },
];
const APQP_NAV_PHASES = [
  { no: 0, name: '入门' },
  { no: 1, name: '策划和定义项目' },
  { no: 2, name: '产品设计和开发' },
  { no: 3, name: '过程设计和开发' },
  { no: 4, name: '产品和过程确认' },
  { no: 5, name: '反馈、评定和纠正' },
];

const state = {
  meta: null, view: 'dash', project: null, fmeaType: 'DFMEA', fmeaView: 'tree',
  fmeaSelectedNode: null, fmeaCollapsed: new Set(), charId: null, spcId: null,
  spcDatasetId: null, spcChartType: null, cpStage: null, ppapNo: null, tplReturnPpap: null,
  pfdSelectedStepId: null, pfdMode: 'PROCESS', msaStudyId: null, ppapSubmissionId: null, user: null,
  apMatrix: null,
};
let docShortcutHandler = null;
// A-04：文档编辑器卸载钩子：清理自动保存定时器、移除 Ctrl+S 监听，并把最后一次编辑落库
let docEditorCleanup = null;
let relatedPreviewState = null;
// S-11：路由历史。普通导航 pushState（浏览器可后退），popstate/hashchange 回放时不再新增历史
let suppressRouteHistory = false;
// A-15：离开页面前提示未保存的交付物编辑
let docHasUnsaved = false;
window.addEventListener('beforeunload', event => {
  if (!docHasUnsaved) return;
  event.preventDefault();
  event.returnValue = '交付物有未保存的修改，确认离开？';
});
function setRouteHash(hash) {
  if (location.hash.slice(1) === hash) { lastRouteDispatch = '#' + hash; return; }
  if (suppressRouteHistory) history.replaceState(null, '', '#' + hash);
  else history.pushState(null, '', '#' + hash);
  lastRouteDispatch = '#' + hash;
}

function resetPersistentView() {
  const current = $('#view');
  if (!current) return null;
  const fresh = current.cloneNode(false);
  current.replaceWith(fresh);
  return fresh;
}

async function api(path, opts = {}) {
  const sep = path.includes('?') ? '&' : '?';
  const url = '/api' + path + (state.project ? `${sep}p=${encodeURIComponent(state.project)}` : '');
  const r = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const j = await r.json();
  if (r.status === 401) {
    const error = new Error(j.error || '请先登录');
    error.auth = true;
    showLogin();
    throw error;
  }
  if (!r.ok) {
    const error = new Error(j.error || '请求失败');
    error.status = r.status;
    // 影响面等结构化信息随错误一起返回，供确认框列出待处理对象
    error.details = j.details || null;
    throw error;
  }
  return j;
}

function showLogin() {
  if ($('#loginScreen')) return;
  const screen = document.createElement('div');
  screen.id = 'loginScreen';
  screen.className = 'login-screen';
  screen.innerHTML = `
    <form class="login-card">
      <div class="brand-mark">RQ</div>
      <h1>电阻器质量系统</h1>
      <p class="dim">请登录后继续使用 APQP / FMEA / SPC / MSA / PPAP</p>
      <label>用户名<input id="loginUsername" autocomplete="username" required value="admin"></label>
      <label>密码<input id="loginPassword" type="password" autocomplete="current-password" required></label>
      <div id="loginError" class="alert bad" hidden></div>
      <button class="btn" type="submit">登录</button>
      <small class="dim">账号由管理员分配；首次启动生成的一次性口令见 data/initial-credentials.&lt;库名&gt;.txt</small>
    </form>`;
  document.body.appendChild(screen);
  $('.login-card', screen).onsubmit = async event => {
    event.preventDefault();
    const error = $('#loginError', screen);
    error.hidden = true;
    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: $('#loginUsername', screen).value.trim(),
          password: $('#loginPassword', screen).value,
        }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || '登录失败');
      state.user = result.user;
      screen.remove();
      boot();
    } catch (e) {
      error.textContent = e.message;
      error.hidden = false;
    }
  };
}

/* ------------------------------------------------------------------ 导航 */
/** 当前账号是否拥有权限点；未取到权限列表时不隐藏入口，由服务端统一拦截 */
function userCan(point) {
  const perms = state.user && state.user.permissions;
  if (!Array.isArray(perms)) return true;
  return perms.includes(point);
}
function paintNav() {
  const active = (state.view === 'doc' || state.view === 'tpl') ? 'apqp'
    : state.view === 'ppapEvidence' ? 'ppap' : state.view;
  $('#nav').innerHTML = NAV.filter(n => !n.perm || userCan(n.perm)).map(n => {
    if (n.g) return `<div class="nav-group">${n.g}</div>`;
    // 导航是 <div>，加 tabindex + 键盘处理才能用 Tab 聚焦、Enter/空格进入
    const item = `<div class="nav-item ${active === n.id ? 'on' : ''}" data-v="${n.id}" tabindex="0" role="link">`
      + `<span class="dot"></span>${n.t}</div>`;
    if (n.id !== 'apqp') return item;
    return item + `<div class="nav-sub">${APQP_NAV_PHASES.map(phase =>
      `<div class="nav-subitem ${active === 'apqp' && state.apqpPhase === phase.no ? 'on' : ''}"
        data-apqp-nav="${phase.no}" tabindex="0" role="link">
        <span class="mono">${phase.no}</span><span>${esc(phase.name)}</span></div>`).join('')}</div>`;
  }).join('');
  $$('#nav .nav-item[data-v]').forEach(el => {
    el.onclick = () => go(el.dataset.v);
    el.onkeydown = event => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      go(el.dataset.v);
    };
  });
  $$('#nav [data-apqp-nav]').forEach(el => {
    el.onclick = () => goApqpPhase(+el.dataset.apqpNav);
    el.onkeydown = event => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      goApqpPhase(+el.dataset.apqpNav);
    };
  });
}

async function boot() {
  try {
    const auth = await api('/auth/me');
    state.user = auth.user;
  } catch (e) {
    if (e.auth) return;
    throw e;
  }
  // 一次性口令未改之前服务端会拒绝所有业务接口，这里先让用户改密
  if (state.user?.must_change_password) return openChangePassword(true);
  const requestedProject = new URLSearchParams(location.search).get('p');
  const saved = localStorage.getItem('qms.project');
  if (requestedProject) state.project = requestedProject;
  else if (saved) state.project = saved;
  try {
    state.meta = await api('/meta');
  } catch (e) {
    // 链接里的 ?p= 指向无权访问的项目时，退回服务端默认项目，不能让整页白屏
    if (requestedProject) {
      state.project = '';
      state.meta = await api('/meta');
      setTimeout(() => toast('无权访问 ' + requestedProject + '，已切换到 ' + state.meta.project.project_id, 'warn'), 300);
    } else throw e;
  }
  state.project = state.meta.project.project_id;
  localStorage.setItem('qms.project', state.project);
  state.structure = await api('/structure').catch(() => null);
  paintTop();
  paintNav();
  const initial = location.hash.slice(1);
  if (initial.startsWith('ppap/')) openPpapEvidence(initial.slice(5));
  else if (initial.startsWith('apqp/')) goApqpPhase(+initial.slice(5));
  else if (initial === 'pfd' || initial.startsWith('pfd/')) goPfd(initial.split('/')[1]);
  else if (initial === 'upload') { go('apqp'); setTimeout(openUpload, 400); }
  else if (initial === 'fmea-import') { go('fmea'); setTimeout(openFromImage, 500); }
  else if (initial === 'sysreq') go('tree');
  else if (initial === 'ai-settings') { go('fmea'); setTimeout(openAISettings, 500); }
  else if (initial === 'func-ai' || initial === 'func-ai-gen') {
    go('fmea');
    setTimeout(async () => {
      const d = await api('/fmea?type=DFMEA');
      const st = d.nodes.filter(n => n.node_type === 'STRUCTURE');
      const target = st.find(n => n.name.indexOf('基体') >= 0) || st[st.length - 1];
      if (!target) return;
      openFunctions(target.node_id, target.name);
      if (initial === 'func-ai-gen') {
        setTimeout(() => {
          const t = $('#faDraft');
          if (t) t.value = '撑住电阻膜，不导电，还要能扛装配时引脚的压力';
          const b = $('#faGen');
          if (b) b.click();
        }, 500);
      }
    }, 700);
  }
  else if (initial === 'row-edit') {
    go('fmea');
    setTimeout(async () => {
      const d = await api('/fmea?type=DFMEA');
      if (d.rows && d.rows.length) openRow(d.rows[0].row_id, d);
    }, 700);
  }
  else if (initial === 'row-new' || initial === 'row-new-ai' || initial === 'row-new-rate') {
    go('fmea');
    setTimeout(async () => {
      const d = await api('/fmea?type=DFMEA');
      const st = d.nodes.filter(n => n.node_type === 'STRUCTURE');
      const leaf = st.find(n => n.parent_id === null || n.parent_id === undefined) || st[0];
      if (!leaf) return;
      openRow(null, d, leaf.node_id);
      if (initial === 'row-new-ai') setTimeout(() => { const b = $('#aiGen'); if (b) b.click(); }, 500);
      if (initial === 'row-new-rate') setTimeout(() => openRating('S', '#f_sp'), 600);
    }, 700);
  }
  else if (initial.startsWith('doc/')) openDoc(initial.slice(4));
  else if (initial.startsWith('tpl/')) openTpl(initial.slice(4));
  else go(NAV.some(n => n.id === initial) ? initial : 'dash');
}

function paintTop() {
  const p = state.meta.project;
  $('#sideProject').textContent = p.name;
  $('#sidePhase').textContent = `${p.code} · 阶段 ${p.phase}`;
  $('#phaseChip').innerHTML = `${esc(p.code)} · 阶段 ${p.phase}　<span class="dim" style="font-weight:400">切换 ▾</span>`;
  $('#phaseChip').style.cursor = 'pointer';
  $('#phaseChip').onclick = () => go('projects');
  if (state.user && $('#role')) {
    // S-10：角色来自登录账号，只读展示；不再用下拉暗示“可切换权限”
    const roleMap = { admin: '系统管理员', engineer: '工艺工程师', quality: '质量工程师', auditor: '内审员（只读）' };
    const dept = state.user.department ? `${state.user.department} · ` : '';
    const label = `${state.user.display_name || ''} · ${dept}${state.user.role_name || roleMap[state.user.role] || state.user.role || ''}`;
    $('#role').innerHTML = `<option selected>${esc(label)}</option>`;
    $('#role').disabled = true;
    $('#role').title = '角色由登录账号决定，不能在此切换';
  }
}

async function switchProject(id) {
  if (!id || id === state.project) return;
  // S-09：项目切换视为会话级重置，不保留上一项目的任何选中态/缓存
  const preserved = { project: id, meta: state.meta, user: state.user };
  for (const key of Object.keys(state)) delete state[key];
  Object.assign(state, preserved);
  state.fmeaSelectedNode = null;
  state.fmeaCollapsed = new Set();
  state.pfdSelectedStepId = null;
  state.pfdMode = 'PROCESS';
  state.msaStudyId = null;
  state.ppapSubmissionId = null;
  state.docCode = null;
  state.docData = null;
  state.docReturnPhase = null;
  state.cpStage = null;
  state.spcId = null;
  state.spcDatasetId = null;
  state.spcChartType = null;
  state.apqpPhase = null;
  state.tplId = null;
  state.tplReturnPpap = null;
  state.ppapNo = null;
  state.view = 'dash';
  state.lastDocs = null;
  localStorage.setItem('qms.project', id);
  state.meta = await api('/meta');
  paintTop();
  go('dash');
  toast('已切换项目：' + state.meta.project.name, 'ok');
}

function go(v) {
  closeRelatedPreview();
  if (v === 'cockpit') v = 'dash';
  if (v === 'sysreq') v = 'tree';
  if (v !== 'doc') {
    if (docShortcutHandler) {
      document.removeEventListener('keydown', docShortcutHandler);
      docShortcutHandler = null;
    }
    if (docEditorCleanup) {
      const cleanup = docEditorCleanup;
      docEditorCleanup = null;
      cleanup();
    }
  }
  if (state.view !== v) state.view = v;
  if (v === 'apqp') state.apqpPhase = null;
  const hash = v === 'pfd' ? `pfd/${state.pfdMode}` : v;
  setRouteHash(hash);
  paintNav();
  if (!qualityToolCode(v)) hideQualityLinks();
  const item = NAV.find(n => n.id === v);
  $('#viewTitle').textContent = v === 'pfd'
    ? (state.pfdMode === 'INITIAL' ? '初始流程图' : '过程流程图')
    : item ? item.t : '';
  $('#view').innerHTML = '<div class="empty">加载中…</div>';
  const map = { projects: vProjects, dash: vDash, alerts: vAlerts, apqp: vApqp, gates: vGates, ecr: vEcr, tree: vTree, loop: vLoop, chars: vChars, chardict: vCharDict, processdict: vProcessDict, productdict: vProductDict, apmatrix: vApMatrix, fmea: vFmea, pfd: vPfd, cp: vCp, spc: vSpc, msa: vMsa, ppap: vPpap, baseline: vBaseline, exports: vExports, users: vUsers, backups: vBackups };
  map[v]().catch(e => {
    $('#view').innerHTML = `<div class="alert bad"><b>加载失败：</b>${esc(e.message)}</div>`;
  });
}

function goPfd(mode = 'PROCESS') {
  state.pfdMode = String(mode).toUpperCase() === 'INITIAL' ? 'INITIAL' : 'PROCESS';
  state.pfdSelectedStepId = null;
  go('pfd');
}

function goApqpPhase(phase) {
  closeRelatedPreview();
  hideQualityLinks();
  // A-04：阶段页不经过 go()，这里同样要卸载文档编辑器的定时器与快捷键
  if (docShortcutHandler) {
    document.removeEventListener('keydown', docShortcutHandler);
    docShortcutHandler = null;
  }
  if (docEditorCleanup) {
    const cleanup = docEditorCleanup;
    docEditorCleanup = null;
    cleanup();
  }
  const no = Math.max(0, Math.min(5, +phase || 0));
  state.view = 'apqp';
  state.apqpPhase = no;
  setRouteHash('apqp/' + no);
  paintNav();
  $('#viewTitle').textContent = `阶段 ${no}`;
  $('#view').innerHTML = '<div class="empty">加载中…</div>';
  vApqp(no).catch(e => {
    $('#view').innerHTML = `<div class="alert bad"><b>加载失败：</b>${esc(e.message)}</div>`;
  });
}

/* ------------------------------------------------------------------ 通用片段 */
const apBadge = ap => `<span class="badge b-${ap}">${ap === 'H' ? '高' : ap === 'M' ? '中' : '低'} ${ap}</span>`;
const specBadge = (sp, sym) => {
  if (!sp) return '<span class="dim">—</span>';
  const cls = sym === 'CC' ? 'b-cc' : sym === 'SC' ? 'b-sc' : sym === 'SAFETY' ? 'b-safe' : 'b-gray';
  const label = sym === 'SAFETY' ? '安全' : sym === 'FIT' ? '配合' : sym;
  return `<span class="badge ${cls}">${label}</span>`;
};
const statusBadge = s => {
  const m = {
    '已完成': 'b-ok', '已批准': 'b-ok', '进行中': 'b-warn', '待审核': 'b-warn',
    '未开始': 'b-gray', '草稿': 'b-gray', '条件接受': 'b-warn', '接受': 'b-ok',
    '不接受': 'b-bad', '系统模块': 'b-warn', '计划': 'b-gray', '研究中': 'b-warn',
    '待复核': 'b-warn',
  };
  return `<span class="badge ${m[s] || 'b-gray'}">${esc(s)}</span>`;
};
const bar = (pct, cls = '') => `<div class="bar ${cls}"><i style="width:${Math.min(100, Math.max(0, pct))}%"></i></div>`;

function qualityToolCode(view = state.view) {
  if (view === 'fmea') return state.fmeaType === 'PFMEA' ? 'P3-06' : 'P2-01';
  if (view === 'cp') return ({ PROTO: 'P2-05', PILOT: 'P3-06b', SOP: 'P4-07' })[state.cpStage] || 'P2-05';
  return ({ spc: 'P4-03', msa: 'P4-02', ppap: 'P4-04' })[view] || '';
}

function hideQualityLinks() {
  const slot = $('#qualityLinks');
  if (!slot) return;
  slot.hidden = true;
  slot.innerHTML = '';
}

const relatedValueText = value => {
  if (value == null || value === '') return '-';
  if (Array.isArray(value)) return value.map(relatedValueText).join('；');
  if (typeof value === 'object') {
    return Object.entries(value).map(([key, item]) => `${key}: ${relatedValueText(item)}`).join('；');
  }
  return String(value);
};

const relatedTableText = field => [
  field.label,
  (field.columns || []).join('\t'),
  ...(field.rows || []).map(row => row.map(relatedValueText).join('\t')),
].join('\n');

const relatedSectionText = section => {
  const lines = [section.title];
  if (section.note) lines.push(section.note);
  for (const field of section.fields || []) {
    lines.push(field.type === 'table'
      ? relatedTableText(field)
      : `${field.label}：${relatedValueText(field.value)}`);
  }
  return lines.filter(Boolean).join('\n');
};

const relatedPreviewText = data => {
  const meta = data.meta || {};
  return [
    `${meta.code || ''} ${meta.name || ''}`.trim(),
    `状态：${meta.status || '-'}　版本：${meta.version || '-'}`,
    meta.approved_by ? `批准人：${meta.approved_by}` : '',
    ...(data.sections || []).map(relatedSectionText),
  ].filter(Boolean).join('\n\n');
};

async function copyRelatedText(text) {
  try {
    await navigator.clipboard.writeText(String(text || ''));
  } catch (error) {
    const area = document.createElement('textarea');
    area.value = String(text || '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    document.execCommand('copy');
    area.remove();
  }
  toast('已复制，可直接粘贴到当前交付物', 'ok');
}

function closeRelatedPreview() {
  relatedPreviewState = null;
  const panel = $('#relatedPreview');
  if (!panel) return;
  panel.hidden = true;
  $('#relatedPreviewBody').innerHTML = '';
}

function relatedPreviewTableHtml(field, sectionIndex, fieldIndex) {
  const rows = Array.isArray(field.rows) ? field.rows : [];
  return `<div class="related-preview-table-tools"><span>${rows.length} 行 · ${(field.columns || []).length} 列</span>
      <button class="related-preview-copy" data-preview-copy-table="${sectionIndex}:${fieldIndex}">复制整表</button></div>
    <div class="related-preview-table-scroll"><table class="related-preview-table"><thead><tr>
      <th style="width:52px">操作</th>${(field.columns || []).map(column => `<th>${esc(column)}</th>`).join('')}
    </tr></thead><tbody>${rows.length ? rows.map((row, rowIndex) => `<tr>
      <td><button class="related-preview-copy" data-preview-copy-row="${sectionIndex}:${fieldIndex}:${rowIndex}">复制</button></td>
      ${(field.columns || []).map((column, columnIndex) =>
        `<td data-preview-copy-cell="${sectionIndex}:${fieldIndex}:${rowIndex}:${columnIndex}">${esc(relatedValueText(row[columnIndex]))}</td>`).join('')}
    </tr>`).join('') : `<tr><td colspan="${(field.columns || []).length + 1}" class="dim">-</td></tr>`}
    </tbody></table></div>`;
}

function renderRelatedPreview(data) {
  const panel = $('#relatedPreview');
  if (!panel) return;
  const meta = data.meta || {};
  $('#relatedPreviewTitle').textContent = `${meta.code || ''} · ${meta.name || '关联文件'}`;
  const versionBar = (data.versions || []).length > 1
    ? `<div class="related-preview-versionbar"><span>查看版本</span>${(data.versions || []).map(version =>
        `<button class="related-preview-version ${version.key === data.selectedVersion ? 'on' : ''}"
          data-preview-version="${esc(version.key)}">${esc(version.label)} · ${esc(version.status || '')} ${esc(version.version || '')}</button>`).join('')}</div>`
    : '';
  const sections = (data.sections || []).map((section, sectionIndex) => `
    <section class="related-preview-section">
      <header><b>${esc(section.title)}</b><button class="related-preview-copy" data-preview-copy-section="${sectionIndex}">复制本段</button></header>
      <div>${section.note ? `<p class="related-preview-note">${esc(section.note)}</p>` : ''}
        ${(section.fields || []).map((field, fieldIndex) => field.type === 'table'
          ? relatedPreviewTableHtml(field, sectionIndex, fieldIndex)
          : `<div class="related-preview-field">
              <div class="related-preview-field-head"><span>${esc(field.label)}</span>
                <button class="related-preview-copy" data-preview-copy-field="${sectionIndex}:${fieldIndex}">复制</button></div>
              <div class="related-preview-field-value">${esc(relatedValueText(field.value))}</div>
            </div>`).join('')}
      </div>
    </section>`).join('');
  $('#relatedPreviewBody').innerHTML = `<div class="related-preview-meta">
      <div><span>状态</span><b>${esc(meta.status || '-')}</b></div>
      <div><span>版本</span><b>${esc(meta.version || '-')}</b></div>
      <div><span>负责人</span><b>${esc(meta.owner || '-')}</b></div>
      <div><span>批准人</span><b>${esc(meta.approved_by || '-')}</b></div>
    </div>${versionBar}${sections || '<div class="related-preview-empty">当前文件暂无详细内容</div>'}`;
  relatedPreviewState = { ...data, code: meta.code };
}

async function openRelatedPreview(code, version = 'current') {
  const panel = $('#relatedPreview');
  if (!panel) return;
  if (state.view !== 'doc') return;
  const previous = relatedPreviewState;
  relatedPreviewState = { code, version };
  panel.hidden = false;
  $('#relatedPreviewTitle').textContent = code;
  $('#relatedPreviewBody').innerHTML = '<div class="related-preview-loading">正在读取关联文件内容…</div>';
  try {
    const data = await api(`/related-preview?code=${encodeURIComponent(code)}&version=${encodeURIComponent(version)}`);
    if (!relatedPreviewState || relatedPreviewState.code !== code) return;
    renderRelatedPreview(data);
  } catch (error) {
    relatedPreviewState = previous;
    $('#relatedPreviewBody').innerHTML = `<div class="alert bad">${esc(error.message)}</div>`;
  }
}

async function mountQualityToolLinks(view = state.view) {
  const slot = $('#qualityLinks');
  const code = qualityToolCode(view);
  if (!slot || !code) {
    if (slot) {
      slot.hidden = true;
      slot.innerHTML = '';
    }
    return;
  }
  const [relations, links] = await Promise.all([
    api('/deliverable-links/relations?doc=' + encodeURIComponent(code)),
    api('/deliverable-links?doc=' + encodeURIComponent(code)),
  ]);
  if (state.view !== view) return;
  const relationRows = (relations.items || []).map(relation => ({
    direction: relation.direction,
    code: relation.direction === '上游' ? relation.sourceCode : relation.targetCode,
    name: relation.direction === '上游' ? relation.sourceName : relation.targetName,
    kind: relation.direction === '上游' ? relation.sourceKind : relation.targetKind,
    module: relation.direction === '上游' ? relation.sourceModule : relation.targetModule,
    arg: relation.direction === '上游' ? relation.sourceArg : relation.targetArg,
    phase: relation.direction === '上游' ? relation.sourcePhase : relation.targetPhase,
    status: relation.direction === '上游' ? relation.sourceStatus : relation.targetStatus,
  })).filter((item, index, all) =>
    all.findIndex(other => other.code === item.code && other.direction === item.direction) === index);
  const chip = item => `<button class="quality-link-chip" data-quality-code="${esc(item.code)}"
      data-quality-kind="${esc(item.kind || '')}" data-quality-module="${esc(item.module || '')}"
      data-quality-arg="${esc(item.arg || '')}" data-quality-phase="${esc(item.phase ?? '')}">
      <span class="mono">${esc(item.code)}</span><b>${esc(item.name)}</b>${statusBadge(item.status)}
    </button>`;
  const row = (direction, label) => {
    const items = relationRows.filter(item => item.direction === direction);
    return `<div class="quality-links-row"><strong>${label}</strong><div>
      ${items.length ? items.map(chip).join('') : '<span class="doc-link-empty">-</span>'}</div></div>`;
  };
  const summary = links.summary || {};
  const pending = (summary.conflict || 0) + (summary.review_required || 0);
  slot.hidden = false;
  slot.innerHTML = `<div class="quality-links-head">
      <div><b>质量工具上下游</b><span class="mono">${esc(code)}</span></div>
      <span>${links.items?.length || 0} 条同步记录${pending ? ` · ${pending} 条待处理` : ''}</span>
    </div>${row('上游', '上游输入')}${row('下游', '下游去向')}`;
  $$('[data-quality-code]', slot).forEach(button => button.onclick = () => {
    const kind = button.dataset.qualityKind;
    const module = button.dataset.qualityModule;
    const arg = button.dataset.qualityArg;
    if (kind === 'form') return openDoc(button.dataset.qualityCode);
    if (kind === 'module' && module === 'fmea') {
      state.fmeaType = arg === 'PFMEA' ? 'PFMEA' : 'DFMEA';
      return go('fmea');
    }
    if (kind === 'module' && module === 'cp') {
      state.cpStage = arg || 'PROTO';
      return go('cp');
    }
    if (kind === 'module' && module === 'pfd') {
      return goPfd(arg);
    }
    if (kind === 'module' && ['spc', 'msa', 'ppap'].includes(module)) return go(module);
    goApqpPhase(Number(button.dataset.qualityPhase) || 0);
  });
}

/* ------------------------------------------------------------------ 概览 */
async function vDash() {
  const [d, cockpit] = await Promise.all([api('/dashboard'), api('/cockpit')]);
  const totalRows = d.apDist.reduce((a, b) => a + b.c, 0);
  const hCount = (d.apDist.find(x => x.ap === 'H') || { c: 0 }).c;
  const cpkOk = 0; // 由 SPC 视图给出
  const phPct = Math.round(((d.docsDone || 0) / Math.max(1, d.docsTotal || 1)) * 100);
  const healthBand = cockpit.band === '健康' ? 'b-ok' : cockpit.band === '关注' ? 'b-warn' : 'b-bad';

  $('#viewSub').textContent = `项目 ${state.meta.project.code} · 客户 ${state.meta.project.customer} · 标准 ${state.meta.project.standard}`;

  const box = (kind, title, detail) =>
    `<div class="alert ${kind}"><div><b>${title}</b>${detail ? `<div class="dim" style="margin-top:3px">${detail}</div>` : ''}</div></div>`;
  const alertHtml = [
    d.highNoDecision.length ? box('bad', `${d.highNoDecision.length} 条 AP=高 的分析行缺少处置决定`,
      `${d.highNoDecision.map(r => r.row_id).join('、')} —— 审核时这是第一个被问到的点`) : '',
    d.cpNoSpc.length ? box('warn', `${d.cpNoSpc.length} 行 CP 勾选了「纳入 SPC」但尚未生成监控项`,
      d.cpNoSpc.map(r => r.cp_row_id).join('、')) : '',
    d.overdueActions.length ? box('warn', `${d.overdueActions.length} 条措施已过目标完成日期`) : '',
    d.msaWarn.length ? box('warn', `${d.msaWarn.length} 台检具需要复评`,
      `${d.msaWarn.map(g => g.name).join('、')}（超期未做 GR&R，或 %GRR &gt; 30%）`) : '',
  ].join('');

  $('#view').innerHTML = `
    <div class="grid g4" style="margin-bottom:14px">
      <div class="kpi"><div class="k">APQP 交付物完成度</div><div class="v">${phPct}<small>%</small></div>
        <div class="d">${d.docsDone} / ${d.docsTotal} 份交付物</div>${bar(phPct)}</div>
      <div class="kpi ${hCount ? 'bad' : 'ok'}"><div class="k">AP = 高（未决策 ${d.highNoDecision.length}）</div><div class="v">${hCount}</div>
        <div class="d">共 ${totalRows} 条分析行 · DFMEA + PFMEA</div>${bar(totalRows ? (hCount / totalRows) * 100 : 0, 'bad')}</div>
      <div class="kpi ${d.cpNoSpc.length ? 'warn' : 'ok'}"><div class="k">CP 行 / 监控项</div><div class="v">${d.counts.cpRows}<small>行</small></div>
        <div class="d">未生成监控项 ${d.cpNoSpc.length} 行</div></div>
      <div class="kpi ${d.ppapTotal > 0 && d.ppapDone === d.ppapTotal ? 'ok' : 'warn'}"><div class="k">PPAP 要素</div><div class="v">${d.ppapDone}<small>/${d.ppapTotal || 0}</small></div>
        <div class="d">${d.ppapTotal === 0 ? '未开始' : d.ppapDone === d.ppapTotal ? '可提交' : '仍有要素未完成'}</div>${bar(d.ppapTotal ? (d.ppapDone / d.ppapTotal) * 100 : 0, 'ok')}</div>
    </div>

    <div class="card" style="margin-bottom:14px">
      <div class="card-h"><h3>项目综合健康度</h3><span class="badge ${healthBand}">${esc(cockpit.band)}</span></div>
      <div class="card-b">
        <div style="display:flex;align-items:center;gap:14px;margin-bottom:12px">
          <div class="v" style="font-size:27px;font-weight:700;min-width:90px">${cockpit.health}<small style="font-size:13px">/100</small></div>
          <div style="flex:1">${bar(cockpit.health, cockpit.band === '健康' ? 'ok' : cockpit.band === '关注' ? 'warn' : 'bad')}</div>
          <div class="dim">Gate 准时率 <b>${cockpit.metrics.gateOnTime}%</b></div>
        </div>
        <div class="grid g4">
          ${cockpit.breakdown.map(b => `<div>
            <div style="display:flex;justify-content:space-between;gap:8px;margin-bottom:4px"><b>${esc(b.name)}</b><span class="dim">${b.weight}% · ${b.score}分</span></div>
            ${bar(b.score, b.score >= 80 ? 'ok' : b.score >= 50 ? 'warn' : 'bad')}
            <div class="dim" style="margin-top:3px">${esc(b.value)}</div>
          </div>`).join('')}
        </div>
      </div>
    </div>

    <div class="grid g23" style="margin-bottom:14px">
      <div class="card">
        <div class="card-h"><h3>APQP 阶段门</h3><span class="hint">当前阶段 ${state.meta.project.phase} · ${phaseName(state.meta.project.phase)}</span></div>
        <div class="card-b">
          <div class="phases" style="grid-template-columns:repeat(${d.phases.length},1fr)">${d.phases.map(p => {
            const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
            const cls = p.status === '已完成' ? 'done' : p.status === '进行中' ? 'doing' : '';
            return `<div class="phase ${cls}"><div class="ph-no">PHASE ${p.phase}</div><div class="ph-name" style="font-size:12px">${esc(p.name)}</div>
              ${bar(pct, pct === 100 ? 'ok' : '')}<div class="ph-meta"><span>${p.done}/${p.total} 项</span><span>${pct}%</span></div></div>`;
          }).join('')}</div>
        </div>
      </div>
      <div class="card">
        <div class="card-h"><h3>风险与缺口</h3><span class="hint">自动汇总</span></div>
        <div class="card-b" style="display:grid;gap:9px">
          ${alertHtml || '<div class="alert info">当前没有阻断项。</div>'}
        </div>
      </div>
    </div>

    <div class="grid g2">
      <div class="card">
        <div class="card-h"><h3>AP 分布</h3><span class="hint">按分析行统计</span></div>
        <div class="card-b">
          ${['H', 'M', 'L'].map(ap => {
            const c = (d.apDist.find(x => x.ap === ap) || { c: 0 }).c;
            const pct = totalRows ? Math.round((c / totalRows) * 100) : 0;
            return `<div style="display:flex;align-items:center;gap:10px;margin-bottom:10px">
              ${apBadge(ap)}<div style="flex:1">${bar(pct, ap === 'H' ? 'bad' : ap === 'M' ? 'warn' : 'ok')}</div>
              <div style="width:64px;text-align:right;font-variant-numeric:tabular-nums"><b>${c}</b> <span class="dim">${pct}%</span></div></div>`;
          }).join('')}
          <div class="legend"><span><i style="background:#B91C1C"></i>高：必须给出决定</span><span><i style="background:#B45309"></i>中：评估成本</span><span><i style="background:#15803D"></i>低：团队自行决定</span></div>
        </div>
      </div>
      <div class="card">
        <div class="card-h"><h3>最近操作</h3><span class="hint">审计事件流（只增不改）</span></div>
        <div class="card-b" style="padding:8px 16px">
          <table class="t"><tbody>
          ${d.audit.map(a => `<tr><td class="nowrap mono">${esc(a.created_at.slice(5, 16))}</td><td class="nowrap">${esc(a.actor)}</td>
            <td><span class="chip">${esc(a.action)}</span></td><td class="dim">${esc(a.object_type)} / ${esc(a.object_id)}</td></tr>`).join('')}
          </tbody></table>
        </div>
      </div>
    </div>

    <div class="card" style="margin-top:14px">
      <div class="card-h"><h3>特性穿透覆盖</h3><span class="hint">每个产品特性的下游覆盖情况 —— 缺口会直接暴露出来</span></div>
      <table class="t"><thead><tr><th>特性</th><th>编号</th><th>规格</th><th>特殊特性</th>
        <th class="num">过程特性</th><th class="num">CP 行（已批准）</th><th class="num">监控项</th><th class="num">MSA 接受</th><th>覆盖状态</th></tr></thead><tbody>
        ${(d.charCoverage || []).map(c => {
          // D-07：多级覆盖状态，而不是“有记录就算完整”
          const cls = { unlinked: 'b-bad', linked: 'b-warn', in_cp: 'b-warn',
            cp_approved: 'b-warn', monitored: 'b-warn', complete: 'b-ok' }[c.stage] || 'b-gray';
          const st = `<span class="badge ${cls}">${esc(c.label || '')}</span>`;
          return `<tr data-coverage-char="${esc(c.char_id)}" style="cursor:pointer">
            <td><b>${esc(c.name)}</b></td><td class="mono">${esc(c.char_id)}</td>
            <td class="dim">${esc(c.tol_text || '—')}</td><td>${specBadge(c.is_special, c.special_symbol)}</td>
            <td class="num">${c.links}</td><td class="num">${c.cps}<small class="dim"> / ${c.cp_approved || 0} 批准</small></td>
            <td class="num">${c.mons}</td><td class="num">${c.msa_ok || 0}</td><td>${st}</td></tr>`;
        }).join('')}
      </tbody></table>
      <div class="dim" style="font-size:11.5px;margin-top:8px">点击任意特性查看缺口明细：过程特性关联 → CP 行与批准状态 → SPC 监控 → MSA 接受。</div>
    </div>`;
  // D-07：下钻到具体缺口对象
  $$('[data-coverage-char]').forEach(row => row.onclick = async () => {
    try {
      const detail = await api('/chars/' + encodeURIComponent(row.dataset.coverageChar));
      const cpRows = detail.cpRows || [];
      const mons = detail.mons || [];
      const msaPlans = detail.msaPlans || [];
      const drawer = $('#drawer');
      const links = [...(detail.down || []), ...(detail.up || [])];
      // 特性关联是共享主数据；本项目未引入的特性要标出来，避免把字典关联误读成本项目覆盖
      const projectCharIds = new Set((detail.projectChars || []).map(item => item.char_id));
      $('.drawer-box', drawer).innerHTML = `
        <div class="drawer-h"><div><h2>特性覆盖缺口</h2>
          <p>${esc(detail.char.char_id)} · ${esc(detail.char.name)} · 规格 ${esc(detail.char.tol_text || '未维护')}</p></div>
          <button class="x" onclick="document.getElementById('drawer').classList.remove('open')">✕</button></div>
        <div class="drawer-b">
          <div class="lbl" style="margin-bottom:6px">过程特性关联（${links.length}）</div>
          ${links.length ? `<table class="t"><thead><tr><th>过程特性</th><th>方向</th><th>强度</th><th>本项目</th></tr></thead><tbody>
            ${links.map(link => {
              const otherId = link.process_char_id || link.product_char_id || '';
              const inProject = projectCharIds.has(otherId);
              return `<tr><td>${esc(link.pname || otherId)}</td>
                <td>${esc(link.direction || '')}</td><td>${esc(link.strength || '')}</td>
                <td>${inProject ? '<span class="badge b-ok">已引入</span>' : '<span class="badge b-warn">未引入</span>'}</td></tr>`;
            }).join('')}
          </tbody></table>` : '<div class="alert warn">尚未建立过程特性关联：请到“特性穿透 → 特性关联维护”补充</div>'}
          <div class="lbl" style="margin:14px 0 6px">控制计划行（${cpRows.length}）</div>
          ${cpRows.length ? `<table class="t"><thead><tr><th>行</th><th>工序</th><th>阶段/版本</th><th>CP 状态</th><th>规范</th></tr></thead><tbody>
            ${cpRows.map(item => `<tr><td class="mono">${esc(item.cp_row_id)}</td>
              <td>${esc(item.step_no || '')} ${esc(item.sname || '')}</td>
              <td class="dim">${esc(item.stage || '')} ${esc(item.cp_rev || '')}</td>
              <td>${statusBadge(item.cp_status || '草稿')}</td>
              <td class="dim">${esc(item.spec_text || '—')}</td></tr>`).join('')}
          </tbody></table>` : '<div class="alert warn">该特性尚未进入任何控制计划行</div>'}
          <div class="lbl" style="margin:14px 0 6px">SPC 监控（${mons.length}）</div>
          ${mons.length ? `<table class="t"><thead><tr><th>监控项</th><th>图型</th><th>审核</th><th>状态</th></tr></thead><tbody>
            ${mons.map(item => `<tr><td class="mono">${esc(item.mon_id)}</td><td>${esc(item.chart_type || '')}</td>
              <td>${statusBadge(item.approval_status || '')}</td><td>${esc(item.status || '')}</td></tr>`).join('')}
          </tbody></table>` : '<div class="alert warn">该特性未纳入 SPC 监控</div>'}
          <div class="lbl" style="margin:14px 0 6px">MSA 计划（${msaPlans.length}）</div>
          ${msaPlans.length ? `<table class="t"><thead><tr><th>计划</th><th>状态</th><th>判定</th><th>来源</th></tr></thead><tbody>
            ${msaPlans.map(item => `<tr><td class="mono">${esc(item.plan_id)}</td><td>${esc(item.status || '')}</td>
              <td>${item.judgment ? statusBadge(item.judgment) : '—'}</td>
              <td class="dim">${esc(item.source_status || '')}</td></tr>`).join('')}
          </tbody></table>` : '<div class="alert warn">该特性尚无 MSA 计划；MSA 计划由已批准 CP 的测量行生成</div>'}
        </div>`;
      drawer.classList.add('open');
    } catch (error) { toast(error.message, 'err'); }
  });
}

/* ------------------------------------------------------------------ 预警中心 */
async function vAlerts() {
  const d = await api('/alerts');
  const lv = l => l === 'high' ? '<span class="badge b-bad">高</span>' : l === 'mid' ? '<span class="badge b-warn">中</span>' : '<span class="badge b-gray">低</span>';
  $('#viewSub').textContent = `共 ${d.total} 条待处理（高优先级 ${d.high} 条）。预警由数据自动产生，不需要人工登记。`;
  $('#view').innerHTML = d.total ? `
    <div class="card">
      <div class="card-h"><h3>全部预警</h3><span class="hint">按优先级排序</span></div>
      <table class="t"><thead><tr><th style="width:60px">级别</th><th style="width:70px">来源</th>
        <th>事项</th><th style="width:34%">说明</th><th style="width:110px">操作</th></tr></thead><tbody>
      ${d.list.map(a => `<tr>
        <td>${lv(a.level)}</td><td><span class="chip">${esc(a.type)}</span></td>
        <td><b>${esc(a.title)}</b></td><td class="dim">${esc(a.detail)}</td>
        <td><button class="btn sm ghost" data-act='${esc(JSON.stringify(a.action))}'>去处理</button></td></tr>`).join('')}
      </tbody></table>
    </div>` : '<div class="empty">当前没有待处理预警</div>';

  $$('[data-act]').forEach(b => b.onclick = () => {
    // 浏览器读取属性时已还原 HTML 实体，这里只需容错解析
    let a;
    try { a = JSON.parse(b.dataset.act); } catch (e) { return; }
    if (a.type === 'module') { if (a.id === 'fmea' && a.arg) state.fmeaType = a.arg; go(a.id); }
    else if (a.type === 'doc') openDoc(a.code);
    else if (a.type === 'page') go(a.id);
  });
}

/* ------------------------------------------------------------------ 门径评审 */
async function vGates() {
  const d = await api('/gates');
  const decCls = v => v === '通过' ? 'b-ok' : v === '驳回' ? 'b-bad' : ['待评审', '待复核'].includes(v) ? 'b-warn' : 'b-gray';
  $('#viewSub').textContent = '按 APQP 第三版 Gate 0–5 评审；系统提示只辅助核对，结论由授权评审人确认';
  $('#view').innerHTML = `
    <div class="phases" style="grid-template-columns:repeat(6,1fr);margin-bottom:16px">
      ${d.gates.map(g => `<div class="phase ${g.decision === '通过' ? 'done' : g.decision === '待评审' ? 'doing' : ''}">
        <div class="ph-no">GATE ${g.no}</div><div class="ph-name" style="font-size:12px">${esc(g.name)}</div>
        <div style="margin:6px 0">${bar(g.checks.filter(Boolean).length / g.criteria.length * 100, g.decision === '通过' ? 'ok' : '')}</div>
        <div class="ph-meta"><span>${g.checks.filter(Boolean).length}/${g.criteria.length} · 数据提示 ${g.autoChecks.filter(Boolean).length}</span>
          <span><span class="badge ${decCls(g.decision)}">${g.decision}</span></span></div></div>`).join('')}
    </div>
    ${d.gates.map(g => `<div class="card" style="margin-bottom:14px">
      <div class="card-h"><h3>Gate ${g.no} · ${esc(g.name)}</h3>
        <span class="hint">${g.reviewed_at ? '评审于 ' + esc(g.reviewed_at.slice(0, 16)) + ' · ' + esc(g.reviewer) : '尚未评审'}</span></div>
      <div class="card-b">
        ${g.needsRevalidation ? `<div class="alert warn" style="margin-bottom:12px">评审准则已按 APQP 第三版更新。历史结论“${esc(g.recordedDecision)}”保留作审计记录，但需按当前要求重新评审。</div>` : ''}
        <div class="grid g2" style="gap:16px">
          <div>
            <div class="lbl" style="margin-bottom:8px">检查项</div>
            ${g.criteria.map((c, i) => {
              const action = g.actions[i] || {};
              return `<div class="gate-check-row">
                <label><input type="checkbox" data-g="${g.no}" data-i="${i}" ${g.checks[i] ? 'checked' : ''}>
                  <span>${esc(c)}</span></label>
                <span class="badge ${g.autoChecks[i] ? 'b-ok' : 'b-gray'}">${g.autoChecks[i] ? '系统找到相关记录' : '需人工核实'}</span>
                <div class="gate-action-fields" data-ga-row="${g.no}-${i}" ${g.checks[i] ? 'hidden' : ''}>
                  <input data-ga="${g.no}" data-i="${i}" data-f="action" value="${esc(action.action || '')}" placeholder="未满足时的措施">
                  <input data-ga="${g.no}" data-i="${i}" data-f="owner" value="${esc(action.owner || '')}" placeholder="责任人">
                  <input data-ga="${g.no}" data-i="${i}" data-f="due" type="date" value="${esc(action.due || '')}">
                </div>
              </div>`;
            }).join('')}
          </div>
          <div>
            <div class="field"><label>评审意见</label><textarea id="gc-${g.no}" rows="3">${esc(g.comment || '')}</textarea></div>
            <div style="display:flex;gap:8px">
              <button class="btn sm" data-gate="${g.no}" data-dec="通过" ${g.canReview ? '' : 'disabled title="前一 Gate 尚未按当前准则通过"'}>评审通过</button>
              <button class="btn sm danger" data-gate="${g.no}" data-dec="驳回" ${g.canReview ? '' : 'disabled title="前一 Gate 尚未按当前准则通过"'}>驳回</button>
              <button class="btn sm ghost" data-gate="${g.no}" data-dec="待评审" ${g.canReview ? '' : 'disabled title="前一 Gate 尚未按当前准则通过"'}>保存为待评审</button>
              ${['通过', '驳回'].includes(g.decision)
                ? `<button class="btn sm ghost" data-gate-withdraw="${g.no}">撤回评审</button>` : ''}
            </div>
            <div class="dim" style="font-size:11.5px;margin-top:8px">未满足项必须记录措施、责任人和计划完成日期。系统数据提示不等同于审核结论。</div>
          </div>
        </div>
      </div>
    </div>`).join('')}`;

  $$('input[type="checkbox"][data-g]').forEach(input => input.onchange = () => {
    const row = document.querySelector(`[data-ga-row="${input.dataset.g}-${input.dataset.i}"]`);
    if (row) row.hidden = input.checked;
  });
  $$('[data-gate]').forEach(b => b.onclick = async () => {
    const phase = +b.dataset.gate, dec = b.dataset.dec;
    const checks = [...document.querySelectorAll(`input[data-g="${phase}"]`)].map(c => (c.checked ? 1 : 0));
    const actions = checks.map((_, index) => Object.fromEntries(
      [...document.querySelectorAll(`input[data-ga="${phase}"][data-i="${index}"]`)]
        .map(input => [input.dataset.f, input.value.trim()])
    ));
    const comment = $('#gc-' + phase).value.trim();
    // S-08：结论属于受控动作，通过/驳回前二次确认并强制记录结论意见
    if (['通过', '驳回'].includes(dec)) {
      if (comment.length < 4) return toast(`${dec} Gate 必须填写不少于 4 个字的评审意见`, 'err');
      const ok = await showConfirmDialog(`确认${dec} Gate ${phase}`,
        `评审意见：${comment}\n\n${dec === '通过' ? '通过后项目阶段将按连续通过的 Gate 重新派生。' : '驳回后项目阶段会回退到实际通过的位置。'}`,
        { confirmText: `确认${dec}`, danger: dec === '驳回' });
      if (!ok) return;
    }
    try {
      const result = await api('/gates/' + phase, { method: 'POST', body: {
        decision: dec, checks, actions, comment,
      } });
      toast(`Gate ${phase} 已${dec === '通过' ? '通过' : dec}；当前派生阶段 ${result.derived_phase}`, 'ok');
      state.meta = await api('/meta');
      paintTop();
      vGates();
    } catch (e) { toast(e.message, 'err'); }
  });
  $$('[data-gate-withdraw]').forEach(b => b.onclick = async () => {
    const phase = +b.dataset.gateWithdraw;
    const result = await showFormDialog({
      title: `撤回 Gate ${phase} 评审`,
      description: '撤回后该 Gate 回到“待评审”，项目阶段按实际通过情况回退；操作写入审计。',
      fields: [{ key: 'reason', label: '撤回原因', type: 'textarea', rows: 3, required: true }],
      confirmText: '确认撤回',
      validate: values => values.reason.trim().length >= 4 ? '' : '请填写不少于 4 个字的撤回原因。',
    });
    if (!result) return;
    try {
      await api(`/gates/${phase}/withdraw`, { method: 'POST', body: { reason: result.reason.trim() } });
      toast(`Gate ${phase} 已撤回，当前派生阶段 ${(await api('/gates')).derivedPhase}`, 'ok');
      state.meta = await api('/meta');
      paintTop();
      vGates();
    } catch (e) { toast(e.message, 'err'); }
  });
}

/* ------------------------------------------------------------------ 变更管理 */
async function vEcr() {
  const [d, approvals] = await Promise.all([api('/ecr'), api('/approvals')]);
  const stCls = s => s === '已批准' ? 'b-ok' : s === '待审批' ? 'b-warn' : s === '已驳回' ? 'b-bad' : 'b-gray';
  $('#viewSub').textContent = 'ECR（工程变更申请）→ 影响分析 → 审批 → 基线升版；变更单与影响清单可追溯';
  $('#view').innerHTML = `
    <div class="card" style="margin-bottom:14px">
      <div class="card-h"><h3>变更单</h3><span class="hint">${d.list.length} 条</span></div>
      <div class="ecr-table-scroll"><table class="t ecr-table"><thead><tr><th>编号</th><th>变更内容</th>
        <th>原因</th><th style="width:20%">影响范围</th><th style="width:90px">状态</th>
        <th style="width:110px">发起</th><th style="width:150px">操作</th></tr></thead><tbody>
        ${d.list.map(e => `<tr>
          <td class="mono">${esc(e.ecr_id)}</td>
          <td><b>${esc(e.title)}</b></td>
          <td class="dim">${esc(e.reason)}</td>
          <td class="dim">${esc(e.scope)}</td>
          <td><span class="badge ${stCls(e.status)}">${esc(e.status)}</span></td>
          <td class="dim">${esc(e.requested_by)}</td>
          <td class="nowrap"><button class="btn sm ghost" data-ecr-impact="${e.ecr_id}">影响</button>
             ${e.branch_baseline_id ? `<button class="btn sm ghost" data-ecr-baseline="${esc(e.branch_baseline_id)}">实施基线</button>` : ''}
             ${e.status === '待审批'
               ? `<button class="btn sm" data-ecr="${e.ecr_id}" data-st="已批准">批准</button>
                  <button class="btn sm ghost" data-ecr="${e.ecr_id}" data-st="已驳回">驳回</button>`
               : e.status === '已批准' ? `<button class="btn sm" data-ecr-apply="${e.ecr_id}">实施</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="7" class="dim">暂无变更单</td></tr>'}
      </tbody></table></div>
    </div>
    <div class="card">
      <div class="card-h"><h3>发起新变更</h3><span class="hint">提交后进入待审批，并在预警中心提醒</span></div>
      <div class="card-b">
        <div class="field"><label>变更内容</label><input id="ecrTitle" placeholder="如：激光功率规格由 12 W 调整为 10 W"></div>
        <div class="field"><label>变更原因</label><textarea id="ecrReason" rows="2"></textarea></div>
        <div class="row2"><div class="field"><label>影响分析源类型</label><select id="ecrSourceType">
          <option value="">— 手工填写影响范围 —</option><option value="CHAR">特性</option>
          <option value="FMEA_ROW">FMEA 行</option><option value="CP_ROW">CP 行</option><option value="STEP">工序</option></select></div>
          <div class="field"><label>影响分析源 ID</label><input id="ecrSourceId" placeholder="如 CHR-D-0142 / FR-PF-00001 / CP-00020"></div></div>
        <div class="field"><label>影响范围（无分析源时手工填写）</label><input id="ecrScope" placeholder="如：DFMEA 1 项 / PFMEA 3 行 / CP 2 行"></div>
        <button class="btn" id="ecrSubmit">提交变更申请</button>
      </div>
    </div>
    <div class="card" style="margin-top:14px">
      <div class="card-h"><h3>活动审批</h3><span class="hint">${approvals.list.length} 条</span></div>
      <table class="t"><thead><tr><th>动作</th><th>标题</th><th>状态</th><th>申请时间</th><th>批准人</th><th>操作</th></tr></thead><tbody>
        ${approvals.list.map(a => `<tr><td class="mono">${esc(a.action_type)}</td><td>${esc(a.title)}</td>
          <td>${statusBadge(a.status)}</td><td class="mono">${esc(a.requested_at)}</td><td>${esc(a.approved_by || '—')}</td>
          <td>${a.status === '待审批' ? `<button class="btn sm" data-approval="${a.approval_id}" data-st="已批准">批准</button>
            <button class="btn sm ghost" data-approval="${a.approval_id}" data-st="已驳回">驳回</button>` : '—'}</td></tr>`).join('') || '<tr><td colspan="6" class="dim">暂无活动审批</td></tr>'}
      </tbody></table>
    </div>`;

  $$('[data-ecr]').forEach(b => b.onclick = async () => {
    try {
      // 批准人由服务端取当前登录身份，前端不再传姓名
      await api('/ecr/' + b.dataset.ecr, { method: 'PATCH', body: { status: b.dataset.st } });
      toast(b.dataset.st.startsWith('已') ? b.dataset.st : '已' + b.dataset.st, 'ok');
      vEcr();
    } catch (e) { toast(e.message, 'err'); }
  });
  $$('[data-ecr-impact]').forEach(button => button.onclick = async () => {
    try {
      const detail = await api('/ecr/' + encodeURIComponent(button.dataset.ecrImpact) + '/impact');
      const drawer = $('#drawer');
      $('.drawer-box', drawer).innerHTML = `
        <div class="drawer-h"><div><h2>变更影响分析</h2><p>${esc(detail.ecr.ecr_id)} · ${esc(detail.ecr.title)}</p></div>
          <button class="x" onclick="document.getElementById('drawer').classList.remove('open')">✕</button></div>
        <div class="drawer-b">${detail.parentBaseline ? `<div class="alert info">父基线：<b>${esc(detail.parentBaseline.tag)}</b> · ${esc(detail.parentBaseline.version)} · <span class="mono">${esc(detail.parentBaseline.baseline_id)}</span>
          <button class="btn sm ghost" data-ecr-baseline="${esc(detail.parentBaseline.baseline_id)}" style="margin-left:8px">查看</button></div>` : ''}
          ${detail.branchBaseline ? `<div class="alert info">变更后基线：<b>${esc(detail.branchBaseline.tag)}</b> · ${esc(detail.branchBaseline.version)} · <span class="mono">${esc(detail.branchBaseline.baseline_id)}</span></div>` : ''}
          ${detail.ecr.impact_analysis ? `<div class="alert info"><b>影响分析</b><br>${esc(detail.ecr.impact_analysis)}</div>` : ''}
          ${detail.ecr.verification ? `<div class="alert ${detail.ecr.status === '已关闭' ? 'info' : 'warn'}"><b>验证结论</b><br>${esc(detail.ecr.verification)}</div>` : ''}
          ${detail.items.filter(item => item.change_type === 'FIELD').length ? `
            <div class="lbl" style="margin:8px 0 6px">结构化变更项（${detail.items.filter(item => item.change_type === 'FIELD').length}）</div>
            <table class="t"><thead><tr><th>对象</th><th>字段</th><th>旧值</th><th>新值</th><th>执行</th></tr></thead><tbody>
            ${detail.items.filter(item => item.change_type === 'FIELD').map(item => `<tr>
              <td class="mono">${esc(item.object_type)}:${esc(item.object_id)}</td>
              <td>${esc(item.field_name || '')}</td>
              <td class="dim">${esc(item.old_value ?? '空')}</td>
              <td>${esc(item.new_value ?? '空')}</td>
              <td>${item.applied_at
                ? `<span class="badge b-ok">${esc(item.applied_by || '已执行')}</span><div class="dim">${esc(item.applied_at)}</div>`
                : '<span class="badge b-warn">待实施</span>'}</td></tr>`).join('')}
            </tbody></table>` : ''}
          <div class="lbl" style="margin:12px 0 6px">受影响对象（${detail.items.length}）</div>
          ${detail.items.length ? `<table class="t"><thead><tr><th>距离</th><th>对象类型</th><th>对象 ID</th><th>传播路径</th></tr></thead><tbody>
          ${detail.items.map(item => `<tr><td>${item.distance}</td><td>${esc(item.object_type)}</td><td class="mono">${esc(item.object_id)}</td><td class="dim">${esc(item.change_type === 'FIELD' ? `${item.field_name}: ${item.old_value ?? '空'} → ${item.new_value ?? '空'}` : item.note)}</td></tr>`).join('')}
        </tbody></table>` : '<div class="empty">该变更没有结构化影响清单</div>'}</div>`;
      drawer.classList.add('open');
      $('[data-ecr-baseline]', drawer)?.addEventListener('click', () => {
        drawer.classList.remove('open');
        go('baseline');
      });
    } catch (e) { toast(e.message, 'err'); }
  });
  $$('[data-ecr-baseline]').forEach(button => button.onclick = () => {
    go('baseline');
    setTimeout(() => document.querySelector(`[data-baseline-detail="${CSS.escape(button.dataset.ecrBaseline)}"]`)?.click(), 300);
  });
  $$('[data-ecr-apply]').forEach(button => button.onclick = async () => {
    try {
      const result = await api('/ecr/' + encodeURIComponent(button.dataset.ecrApply) + '/apply', {
        method: 'POST', body: { note: '变更实施完成' },
      });
      toast(`变更已实施，分支快照 ${result.branch_baseline_id}`, 'ok'); vEcr();
    } catch (e) { toast(e.message, 'err'); }
  });
  $$('[data-approval]').forEach(button => button.onclick = async () => {
    try {
      await api('/approvals/' + encodeURIComponent(button.dataset.approval), {
        method: 'PATCH', body: { status: button.dataset.st },
      });
      toast(button.dataset.st); vEcr();
    } catch (e) { toast(e.message, 'err'); }
  });
  $('#ecrSubmit').onclick = async () => {
    try {
      const sourceType = $('#ecrSourceType').value;
      const sourceId = $('#ecrSourceId').value.trim();
      if (sourceType && !sourceId) throw new Error('选择影响分析源后必须填写源 ID');
      await api('/ecr', { method: 'POST', body: {
        title: $('#ecrTitle').value, reason: $('#ecrReason').value, scope: $('#ecrScope').value,
        source_type: sourceType || null, source_id: sourceId || null,
      } });
      toast('变更单已提交，等待审批', 'ok');
      vEcr();
    } catch (e) { toast(e.message, 'err'); }
  };
}

/* ------------------------------------------------------------------ 项目清单 */
async function vProjects() {
  const d = await api('/projects');
  const [familiesResult, seriesResult] = await Promise.all([
    api('/product-families'), api('/product-series'),
  ]);
  const families = familiesResult.list || [];
  const series = seriesResult.list || [];
  $('#viewSub').textContent = `共 ${d.list.length} 个项目。同一项目下的 APQP 交付物、FMEA、PFD、CP、SPC/MSA 与 PPAP 共享同一套产品数据。`;
  const phaseTxt = n => ['入门', '策划和定义项目', '产品设计和开发', '过程设计和开发', '产品和过程确认', '反馈与改进'][n] || '—';

  $('#view').innerHTML = `
    <div style="display:flex;justify-content:flex-end;margin-bottom:10px">
      ${userCan('project.manage') ? '<button class="btn" id="btnNewProj">＋ 新建项目</button>' : ''}
    </div>
    <div class="grid g3">
      ${d.list.map(p => {
        const cur = p.project_id === d.current;
        return `<div class="card" style="${cur ? 'border-color:#8FB4F0;box-shadow:0 0 0 3px #EAF1FE' : ''}">
          <div class="card-h">
            <h3 style="font-size:14px">${esc(p.name)}</h3>
            ${cur ? '<span class="badge b-ok">当前项目</span>' : ''}
          </div>
          <div class="card-b">
            <div class="kv" style="grid-template-columns:78px 1fr;gap:6px 8px">
              <div class="k">项目编号</div><div class="mono">${esc(p.project_id)}</div>
              <div class="k">零件号</div><div class="mono">${esc(p.part_no || '—')}</div>
              <div class="k">产品族 / 系列</div><div>${esc(p.family_name || p.family_id || '—')} / ${esc(p.series_name || p.series_code || '—')}</div>
              <div class="k">客户</div><div>${esc(p.customer || '—')}</div>
              <div class="k">当前阶段</div><div>阶段 ${p.phase} · ${phaseTxt(p.phase)}</div>
            </div>
            <div style="margin:12px 0 6px;display:flex;justify-content:space-between;font-size:11.5px" class="dim">
              <span>交付物完成度</span><span>${p.done_docs}/${p.total_docs}（${p.pct}%）</span>
            </div>
            ${bar(p.pct, p.pct >= 100 ? 'ok' : '')}
            <div class="grid g4" style="margin-top:12px;gap:8px">
              <div style="text-align:center"><div class="lbl">FMEA 行</div><div class="val">${p.fmea_rows}</div></div>
              <div style="text-align:center"><div class="lbl">CP 行</div><div class="val">${p.cp_rows}</div></div>
              <div style="text-align:center"><div class="lbl">工序</div><div class="val">${p.steps}</div></div>
              <div style="text-align:center"><div class="lbl">基线</div><div class="val">${p.baselines}</div></div>
            </div>
            <button class="btn ${cur ? 'ghost' : ''} wide" data-open="${p.project_id}" style="margin-top:14px">
              ${cur ? '进入项目' : '切换到此项目'}</button>
            ${userCan('project.manage') ? `<button class="btn sm ghost" data-del-proj="${p.project_id}" style="margin-top:6px;width:100%;color:#B91C1C;border-color:#F3C6C6">删除此项目</button>` : ''}
          </div>
        </div>`;
      }).join('')}
    </div>
    <div class="alert info" style="margin-top:16px">
      <div><b>项目隔离规则</b>
        <div style="margin-top:4px;line-height:1.7">
          · 项目之间数据隔离：A 项目的 FMEA、PFD、CP、交付物不会出现在 B 项目里<br>
          · 共享的是「特性主数据」与「检具台账」，因为同一产品族应使用同一套特性定义<br>
          · 交付物之间通过「关联关系」串联：改一个设计特性，可沿链路找到受影响的 PFMEA 行与 CP 行
        </div>
      </div>
    </div>`;
  const nb = document.getElementById('btnNewProj');
  if (nb) nb.onclick = () => {
    const drawer = $('#drawer');
    $('.drawer-box', drawer).innerHTML = `
      <div class="drawer-h"><div><h2>新建项目</h2><p>会同时生成 6 个阶段、68 项交付物、APQP 任务、PPAP 18 项、DFMEA/PFMEA 结构及三阶段控制计划</p></div>
        <button class="x" onclick="document.getElementById('drawer').classList.remove('open')">✕</button></div>
      <div class="drawer-b">
        <div class="field"><label>项目名称 <span style="color:#B91C1C">*</span></label><input id="npName" placeholder="如 RJ 系列 1/8W 精密电阻器"></div>
        <div class="row2">
          <div class="field"><label>项目编号</label><input id="npId" placeholder="留空自动生成"></div>
          <div class="field"><label>零件号</label><input id="npPart" placeholder="如 RJ-0.125W-1K"></div>
        </div>
        <div class="field"><label>客户</label><input id="npCust" placeholder="如 车规客户 D"></div>
        <div class="row2">
          <div class="field"><label>产品族 <span style="color:#B91C1C">*</span></label>
            <select id="npFamily">${families.map(item => `<option value="${esc(item.family_id)}">${esc(item.code)} · ${esc(item.name)}</option>`).join('')}</select></div>
          <div class="field"><label>产品系列 <span style="color:#B91C1C">*</span></label>
            <select id="npSeries"></select></div>
        </div>
        <div class="row2" id="npManualSeries" hidden>
          <div class="field"><label>新增系列 / 型号编码</label><input id="npSeriesCode" placeholder="如 RXG 或 RXE"></div>
          <div class="field"><label>新增系列 / 型号名称</label><input id="npSeriesName" placeholder="如 RXG 国军标线绕电阻器"></div>
        </div>
        <div class="field"><label>复制自现有项目</label>
          <select id="npCopy"><option value="">— 空白项目 —</option>
            ${d.list.map(p => `<option value="${esc(p.project_id)}">${esc(p.project_id)} ${esc(p.name)}</option>`).join('')}
          </select>
          <div class="dim" style="font-size:11px;margin-top:4px">复制会复用交付物、FMEA、工序、CP 和客户模板；只能复制自己有权访问的项目，复制活动记入审计。</div>
        </div>
        <button class="btn" id="npSave">创建</button>
      </div>`;
    drawer.classList.add('open');
    const fillSeries = () => {
      const familyId = $('#npFamily').value;
      const list = series.filter(item => item.family_id === familyId);
      $('#npSeries').innerHTML = list.map(item => `<option value="${esc(item.series_id)}">${esc(item.code)} · ${esc(item.name)}</option>`).join('')
        + '<option value="__manual__">＋手动新增系列 / 型号</option>';
      $('#npManualSeries').hidden = $('#npSeries').value !== '__manual__';
    };
    $('#npFamily').onchange = fillSeries;
    $('#npSeries').onchange = () => { $('#npManualSeries').hidden = $('#npSeries').value !== '__manual__'; };
    fillSeries();
    document.getElementById('npSave').onclick = async () => {
      try {
        const manualSeries = document.getElementById('npSeries').value === '__manual__';
        if (manualSeries && !document.getElementById('npSeriesCode').value.trim()) {
          throw new Error('手动新增系列/型号时必须填写编码');
        }
        const r = await api('/projects', { method: 'POST', body: {
          name: document.getElementById('npName').value.trim(),
          project_id: document.getElementById('npId').value.trim(),
          part_no: document.getElementById('npPart').value.trim(),
          customer: document.getElementById('npCust').value.trim(),
          family_id: document.getElementById('npFamily').value,
          series_id: document.getElementById('npSeries').value === '__manual__' ? '' : document.getElementById('npSeries').value,
          series_code: document.getElementById('npSeries').value === '__manual__' ? document.getElementById('npSeriesCode').value.trim() : '',
          series_name: document.getElementById('npSeries').value === '__manual__' ? document.getElementById('npSeriesName').value.trim() : '',
          copy_from: document.getElementById('npCopy').value || null,
        } });
        toast('已创建 ' + r.project_id, 'ok');
        drawer.classList.remove('open');
        vProjects();
      } catch (e) { toast(e.message, 'err'); }
    };
  };
  document.querySelectorAll('[data-del-proj]').forEach(b => {
    let armed = false;
    b.onclick = async (ev) => {
      ev.stopPropagation();
      if (!armed) { armed = true; b.textContent = '确认删除?'; b.style.background = '#FEF2F2';
        setTimeout(() => { armed = false; b.textContent = '删除此项目'; b.style.background = ''; }, 5000); return; }
      try { await api('/projects/' + encodeURIComponent(b.dataset.delProj), { method: 'DELETE' });
        toast('已删除项目'); vProjects(); } catch (e) { toast(e.message, 'err'); }
    };
  });
  $$('[data-open]').forEach(b => b.onclick = () => switchProject(b.dataset.open));
}

/* ------------------------------------------------------------------ APQP 交付物关系图 */
async function vTree() {
  const [d, structure] = await Promise.all([api('/docs'), api('/structure').catch(() => null)]);
  const all = d.phases.flatMap(p => p.docs);
  const byCode = new Map(all.map(x => [x.code, x]));
  const nm = c => (byCode.get(c) || {}).name || c;
  const relations = new Map(all.map(doc => [doc.code, {
    up: new Set(doc.up || []),
    down: new Set(doc.down || []),
  }]));
  for (const doc of all) {
    for (const code of doc.up || []) {
      if (relations.has(code)) relations.get(code).down.add(doc.code);
    }
    for (const code of doc.down || []) {
      if (relations.has(code)) relations.get(code).up.add(doc.code);
    }
  }
  const selectedCode = state.treeSelectedCode && byCode.has(state.treeSelectedCode)
    ? state.treeSelectedCode : 'P2-01';
  const selected = byCode.get(selectedCode);
  const selectedRelations = selected ? relations.get(selected.code) : { up: new Set(), down: new Set() };
  const openDocAction = (doc) => {
    if (!doc) return;
    if (doc.module === 'pfd') {
      goPfd(doc.arg);
      return;
    }
    if (doc.kind === 'module') {
      if (doc.module === 'fmea' && doc.arg) state.fmeaType = doc.arg;
      if (doc.module === 'cp' && doc.arg) state.cpStage = doc.arg;
      go(doc.module);
    }
    else if (doc.kind === 'form') openDoc(doc.code);
    else toast('该项为活动，不产生文件');
  };
  const relationLinks = codes => codes.length ? codes.map(code => byCode.has(code)
    ? `<button class="apqp-rel-link" data-code="${code}">${esc(nm(code))}<span class="mono">${code}</span></button>`
    : '<span class="dim">无直接关联</span>').join('') : '<span class="dim">无直接关联</span>';
  // 影响面：谁直接依赖它、它又直接依赖谁；只统计本项目在册交付物
  const downstreamOf = code => [...(relations.get(code)?.down || [])];
  // 把“整页阶段墙”换成“选一个文件看影响面”：阶段墙与「APQP 阶段管理」重复
  const options = d.phases.map(phase => {
    const docs = phase.docs.filter(doc => doc.group !== 'input');
    if (!docs.length) return '';
    return `<optgroup label="PHASE ${phase.no} ${esc(phase.name)}">${docs.map(doc =>
      `<option value="${esc(doc.code)}" ${doc.code === selectedCode ? 'selected' : ''}>${esc(doc.code)} · ${esc(doc.name)}</option>`).join('')}</optgroup>`;
  }).join('');
  const pendingDown = downstreamOf(selectedCode).filter(code => {
    const doc = byCode.get(code);
    return doc && !['已完成', '已批准'].includes(doc.status);
  });
  $('#viewSub').textContent = '选一份交付物，查看它依赖谁、谁又依赖它；完整清单见「APQP 阶段管理」。';
  $('#view').innerHTML = `
    <section class="card apqp-rel-panel">
      <div class="card-h"><div><h3>选择交付物</h3><span class="hint">用于判断“改这份文件会影响谁”</span></div></div>
      <div class="card-b">
        <div class="apqp-rel-picker">
          <select id="treeDoc" class="sel">${options}</select>
          <span class="dim">共 ${all.filter(doc => doc.group !== 'input').length} 份可关联交付物</span>
        </div>
        ${pendingDown.length ? `<div class="alert warn" style="margin-top:10px"><div>
          下游有 ${pendingDown.length} 份文件尚未完成：${pendingDown.map(code => esc(nm(code))).join('、')}</div></div>` : ''}
      </div>
    </section>

    <section class="card apqp-rel-detail">
      <div class="card-h"><div><h3>${esc(selected?.name || '交付物关系')}</h3><span class="hint">${esc(selected?.desc || '')}</span></div>
        ${selected ? `<button class="btn sm" id="openSelectedDoc">打开</button>` : ''}
      </div>
      <div class="card-b">
        <div class="apqp-rel-meta">
          <span><b>编号</b><code>${esc(selected?.code || '—')}</code></span>
          <span><b>负责人</b>${esc(selected?.owner || '—')}</span>
          <span><b>状态</b>${esc(selected?.status || '—')}</span>
        </div>
        <div class="apqp-rel-connections">
          <div><b>上游输入</b><div>${relationLinks([...selectedRelations.up])}</div></div>
          <div><b>下游去向</b><div>${relationLinks([...selectedRelations.down])}</div></div>
        </div>
      </div>
    </section>

    <details class="apqp-rel-principles">
      <summary>APQP 贯穿原则 <span>${(structure?.globalReqs || []).length} 项 · 参考信息，不计入交付物完成度</span></summary>
      <div class="apqp-rel-principle-list">
        ${(structure?.globalReqs || []).map(item => `<div><b>${esc(item.name)}</b><span>${esc(item.desc)}</span></div>`).join('')}
      </div>
    </details>`;

  if ($('#treeDoc')) $('#treeDoc').onchange = event => {
    state.treeSelectedCode = event.target.value;
    vTree();
  };
  $$('[data-code]').forEach(el => el.onclick = () => openDocAction(byCode.get(el.dataset.code)));
  if ($('#openSelectedDoc')) $('#openSelectedDoc').onclick = () => openDocAction(selected);
}

async function vLoop() {
  const type = state.loopType || 'DFMEA';
  const stage = state.loopStage || 'SOP';
  const d = await api('/closed-loop?type=' + encodeURIComponent(type) + '&stage=' + encodeURIComponent(stage));
  $('#viewSub').textContent = type === 'DFMEA'
    ? '检查 DFMEA 失效行是否被 DVP&R 验证项覆盖'
    : '检查 PFMEA 失效行是否进入指定阶段控制计划';
  $('#view').innerHTML = `
    <div class="tabs">
      <div class="tab ${type === 'DFMEA' ? 'on' : ''}" data-loop-type="DFMEA">DFMEA → DVP&R</div>
      <div class="tab ${type === 'PFMEA' ? 'on' : ''}" data-loop-type="PFMEA">PFMEA → CP</div>
      ${type === 'PFMEA' ? ['PROTO','PILOT','SOP'].map(x => `<span class="badge ${x === stage ? 'b-ok' : 'b-gray'}" data-loop-stage="${x}" style="cursor:pointer;align-self:center">${STAGE[x]}</span>`).join('') : ''}
    </div>
    <div class="grid g3" style="margin-bottom:14px">
      <div class="kpi"><div class="k">检查对象</div><div class="v">${d.summary.total}</div><div class="d">${type}</div></div>
      <div class="kpi ok"><div class="k">已覆盖</div><div class="v">${d.summary.covered}</div><div class="d">${type === 'DFMEA' ? 'P2-03 DVP&R' : (STAGE[d.stage] || d.stage) + ' CP'}</div></div>
      <div class="kpi bad"><div class="k">未覆盖</div><div class="v">${d.summary.missing}</div><div class="d">需要补充证据或控制</div></div>
    </div>
    <div class="card"><div class="card-h"><h3>${type === 'DFMEA' ? 'DFMEA → DVP&R' : 'PFMEA → CP'} 闭环明细</h3>
      <span class="hint">${esc(d.source?.status || '')}</span></div>
      <table class="t"><thead><tr><th>状态</th><th>${type === 'DFMEA' ? '设计特性' : '工序'}</th><th>失效影响</th><th>失效模式</th>
        <th>${type === 'DFMEA' ? 'DVP 项数' : 'CP 行'}</th><th>说明</th></tr></thead><tbody>
        ${d.items.map(item => `<tr><td>${item.covered ? '<span class="badge b-ok">已覆盖</span>' : '<span class="badge b-bad">缺闭环</span>'}</td>
          <td>${type === 'DFMEA' ? esc(item.char_name || item.char_id || '—') : `${esc(item.step_no || '')} ${esc(item.step_name || '')}`}</td>
          <td>${esc(item.failure_effect || '—')}</td><td>${esc(item.failure_mode || '—')}</td>
          <td>${type === 'DFMEA' ? item.dvp_count : esc(item.cp_row_id || '—')}</td>
          <td class="dim">${type === 'DFMEA' ? (item.dvp_count ? '已按特性编号/名称匹配 DVP&R' : 'P2-03 中未找到对应特性') : (item.covered ? `CP 序号 ${item.cp_seq}` : '指定阶段 CP 中没有对应行')}</td></tr>`).join('')}
      </tbody></table></div>`;
  $$('[data-loop-type]').forEach(tab => tab.onclick = () => { state.loopType = tab.dataset.loopType; vLoop(); });
  $$('[data-loop-stage]').forEach(tab => tab.onclick = () => { state.loopStage = tab.dataset.loopStage; vLoop(); });
}

/* ------------------------------------------------------------------ APQP */
async function vApqp(phase = null) {
  const d = await api('/docs');
  const outs = d.summary.total - d.summary.input;
  const selectedPhase = phase == null ? null : d.phases.find(item => +item.no === +phase);
  if (phase != null && !selectedPhase) {
    state.apqpPhase = null;
    go('apqp');
    return;
  }
  state.apqpPhase = selectedPhase ? +selectedPhase.no : null;
  const stCls = s => s === '已完成' || s === '已批准' ? 'b-ok'
    : ['草稿', '待审核', '系统模块'].includes(s) ? 'b-warn' : 'b-gray';
  const allDocs = d.phases.flatMap(p => p.docs);
  state.lastDocs = allDocs;
  const byCode = new Map(allDocs.map(x => [x.code, x]));
  const nm = c => (byCode.get(c) || {}).name || c;

  const opCell = doc => {
    const editBtn = doc.module === 'pfd'
      ? `<button class="btn sm" data-goto="pfd" data-arg="${doc.arg || 'PROCESS'}">进入流程图</button>`
      : doc.kind === 'module'
      ? `<button class="btn sm" data-goto="${doc.module}" data-arg="${doc.arg || ''}">进入模块</button>`
      : `<button class="btn sm" data-doc="${doc.code}">编辑</button>`;
    const uploadBtn = `<button class="btn sm ghost" data-updoc="${doc.code}" data-phase="${doc.phase || 0}" data-name="${esc(doc.name)}">上传</button>`;
    const nameBtn = `<button class="btn sm ghost" data-rename="${doc.code}" data-name="${esc(doc.name)}">改名</button>`;
    const delBtn = `<button class="btn sm ghost" data-hide="${doc.code}" style="color:#B91C1C;border-color:#F3C6C6">删除</button>`;
    const dl = doc.kind === 'form' && doc.module !== 'pfd'
      ? `<button class="btn sm ghost" data-dl="${doc.code}" data-fmt="docx">Word</button><button class="btn sm ghost" data-dl="${doc.code}" data-fmt="xlsx">Excel</button>`
      : '';
    const mark = doc.kind === 'none'
      ? `<button class="btn sm ghost" data-mark="${doc.code}" data-st="${doc.status === '已完成' ? '未开始' : '已完成'}">${doc.status === '已完成' ? '撤销' : '标记完成'}</button>`
      : '';
    return editBtn + uploadBtn + nameBtn + delBtn + dl + mark;
  };

  const rowHtml = doc => `<tr>
    <td class="mono nowrap">${doc.code}</td>
    <td><b>${esc(doc.name)}</b>${doc.kind === 'module' || doc.module === 'pfd' ? ' <span class="tag">流程图工作台</span>' : ''}
      <div class="dim" style="font-size:11px">${esc(doc.desc)}</div></td>
    <td class="nowrap">${esc(doc.owner)}</td>
    <td><span class="badge ${stCls(doc.status)}">${esc(doc.status)}</span>
      ${doc.kind === 'form' && doc.status !== '已完成' && doc.pct ? `<div class="bar" style="margin-top:4px"><i style="width:${doc.pct}%"></i></div>` : ''}</td>
    <td>${(doc.up || []).slice(0, 2).map(c => `<span class="tag">↑${esc(nm(c))}</span>`).join('')}
        ${(doc.down || []).slice(0, 2).map(c => `<span class="tag">↓${esc(nm(c))}</span>`).join('')}
        ${(!doc.up || !doc.up.length) && (!doc.down || !doc.down.length) ? '<span class="dim">—</span>' : ''}</td>
    <td class="nowrap">${opCell(doc)}</td></tr>`;

  if (!selectedPhase) {
    $('#viewTitle').textContent = '阶段管理';
    $('#viewSub').textContent = `APQP 第三版项目总览：共 ${d.summary.total} 项（输入 ${d.summary.input} · 输出/活动 ${outs} · 检查表 ${d.summary.checklist}）`;
    const activePhases = d.phases.filter(item => item.pct > 0 && item.pct < 100).length;
    $('#view').innerHTML = `
      <div class="alert info" style="margin-bottom:14px"><div>
        <b>项目进度总览</b><br>
        阶段管理一级页面只展示进度和完成情况；点击阶段卡片或左侧二级菜单进入该阶段，查看文件、输入、活动和检查表。
      </div></div>
      <div class="grid g4" style="margin-bottom:14px">
        <div class="kpi"><div class="k">交付物总数</div><div class="v">${d.summary.total}</div><div class="d">文件 ${d.summary.form} · 模块 ${d.summary.module} · 活动 ${d.summary.activity}</div></div>
        <div class="kpi ok"><div class="k">已完成表单</div><div class="v">${d.summary.done}<small>/${d.summary.formTotal || 0}</small></div>
          <div class="d">${bar(d.summary.formTotal ? d.summary.done / d.summary.formTotal * 100 : 0, 'ok')}<span class="dim" style="font-size:11px">模块/活动不计入完成度</span></div></div>
        <div class="kpi warn"><div class="k">草稿 / 待审核</div><div class="v">${d.summary.drafting}</div><div class="d">需要继续推进的交付物</div></div>
        <div class="kpi"><div class="k">推进中阶段</div><div class="v">${activePhases}</div><div class="d">当前项目阶段 ${state.meta.project.phase}</div></div>
      </div>
      <div class="card" style="margin-bottom:14px">
        <div class="card-h"><h3>APQP 阶段进度</h3><span class="hint">点击阶段进入详细交付物</span></div>
        <div class="card-b"><div class="phases" style="grid-template-columns:repeat(6,1fr)">
          ${d.phases.map(item => `<button class="phase phase-link ${item.pct === 100 ? 'done' : item.pct > 0 ? 'doing' : ''}" data-apqp-open="${item.no}" style="text-align:left;cursor:pointer">
            <div class="ph-no">PHASE ${item.no}</div>
            <div class="ph-name" style="font-size:12px">${esc(item.name)}</div>
            ${bar(item.pct, item.pct === 100 ? 'ok' : '')}
            <div class="ph-meta"><span>${item.done}/${item.total}</span><span>${item.pct}%</span></div>
          </button>`).join('')}
        </div></div>
      </div>
      <div class="grid g2">
        <div class="card"><div class="card-h"><h3>进入下一步的建议</h3></div><div class="card-b">
          ${d.phases.filter(item => item.pct < 100).sort((a, b) => a.no - b.no).slice(0, 3).map(item =>
            `<div style="display:flex;gap:10px;align-items:center;padding:8px 0;border-bottom:1px solid var(--line2)">
              <span class="badge ${item.pct > 0 ? 'b-warn' : 'b-gray'}">Phase ${item.no}</span>
              <span style="flex:1">${esc(item.name)} · ${item.done}/${item.total}</span>
              <button class="btn sm ghost" data-apqp-open="${item.no}">打开</button>
            </div>`).join('')}
        </div></div>
        <div class="card"><div class="card-h"><h3>项目管理操作</h3></div><div class="card-b" style="display:flex;flex-wrap:wrap;gap:8px">
          <button class="btn" data-apqp-open="0">从阶段 0 开始</button>
          <button class="btn ghost" data-apqp-open="${state.meta.project.phase}">进入当前阶段</button>
          <button class="btn ghost" data-apqp-open="5">量产与改进</button>
        </div></div>
      </div>`;
    $$('[data-apqp-open]').forEach(button => button.onclick = () => goApqpPhase(+button.dataset.apqpOpen));
    return;
  }

  const p = selectedPhase;
  const inputs = p.docs.filter(x => x.group === 'input');
  const outputs = p.docs.filter(x => x.group !== 'input' && x.group !== 'checklist');
  const checklists = p.docs.filter(x => x.group === 'checklist');
  $('#viewTitle').textContent = `阶段 ${p.no} · ${p.name}`;
  $('#viewSub').textContent = `${p.done}/${p.total} 已完成（${p.pct}%） · 输入 ${inputs.length} · 输出/活动 ${outputs.length} · 检查表 ${checklists.length}`;
  $('#view').innerHTML = `
    <div class="docbar">
      <div><button class="btn ghost" id="apqpOverviewBack">返回阶段总览</button></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        ${p.no > 0 ? `<button class="btn ghost" data-apqp-open="${p.no - 1}">上一阶段</button>` : ''}
        ${p.no < 5 ? `<button class="btn ghost" data-apqp-open="${p.no + 1}">下一阶段</button>` : ''}
        <button class="btn ghost" data-up-phase="${p.no}">上传到本阶段</button>
        <button class="btn ghost" data-batch-submit="${p.no}">批量提交草稿</button>
        <button class="btn ghost" data-batch-export="${p.no}">批量导出 ZIP</button>
        <button class="btn" data-new-doc="${p.no}">＋ 新建</button>
      </div>
    </div>
    <div class="grid g4" style="margin-bottom:14px">
      <div class="kpi"><div class="k">本阶段完成度</div><div class="v">${p.pct}<small>%</small></div><div class="d">${bar(p.pct, p.pct === 100 ? 'ok' : '')}</div></div>
      <div class="kpi"><div class="k">交付物</div><div class="v">${p.total}</div><div class="d">已完成 ${p.done}</div></div>
      <div class="kpi"><div class="k">输入</div><div class="v">${inputs.length}</div><div class="d">本阶段的上游依据</div></div>
      <div class="kpi"><div class="k">检查表</div><div class="v">${checklists.length}</div><div class="d">阶段放行检查</div></div>
    </div>
    <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:14px">
      ${((state.structure && state.structure.tabs && state.structure.tabs[p.no]) || []).map(tab =>
        `<button class="btn sm ghost" data-phase="${p.no}" data-tab="${esc(tab.name)}"
           title="${tab.target.type === 'planned' ? '规划中' : tab.target.type === 'module' ? '进入系统模块' : '打开'}"
           style="${tab.target.type === 'planned' ? 'opacity:.55' : ''}">${esc(tab.name)}</button>`).join('')}
    </div>
    <div class="card" id="ph-${p.no}">
      <div class="card-h"><h3>阶段 ${p.no} · ${esc(p.name)} 文件明细</h3><span class="hint">只显示当前阶段，减少长页面阅读负担</span></div>
      <div class="card-b" style="display:grid;grid-template-columns:${inputs.length ? '210px 1fr' : '1fr'};gap:16px;align-items:start">
        ${inputs.length ? `<div><div class="lbl" style="margin-bottom:6px">阶段输入</div>
          ${inputs.map(item => `<div class="chip" style="display:block;margin-bottom:5px;white-space:normal">${esc(item.name)}</div>`).join('')}</div>` : ''}
        <div>
          <table class="t"><thead><tr><th style="width:70px">编号</th><th>交付物</th>
            <th style="width:76px">负责人</th><th style="width:96px">状态</th><th style="width:24%">关联</th>
            <th style="width:200px">操作</th></tr></thead><tbody>
            ${outputs.map(rowHtml).join('') || '<tr><td colspan="6" class="dim">本阶段无文件类输出</td></tr>'}
          </tbody></table>
          ${checklists.length ? `<div class="lbl" style="margin:14px 0 6px">检查表</div>
            <table class="t"><thead><tr><th style="width:70px">编号</th><th>检查表</th><th style="width:76px">负责人</th><th style="width:96px">状态</th><th style="width:24%">关联</th><th style="width:200px">操作</th></tr></thead>
            <tbody>${checklists.map(rowHtml).join('')}</tbody></table>` : ''}
        </div>
      </div>
    </div>`;
  $('#apqpOverviewBack').onclick = () => go('apqp');
  $$('[data-apqp-open]').forEach(button => button.onclick = () => goApqpPhase(+button.dataset.apqpOpen));

  /* 每行的上传 / 改名 / 删除 */
  document.querySelectorAll('[data-updoc]').forEach(b => b.onclick = (e) => {
    e.stopPropagation();
    openUpload({ phase: +b.dataset.phase, docCode: b.dataset.updoc, name: b.dataset.name });
  });
  document.querySelectorAll('[data-rename]').forEach(b => b.onclick = async (e) => {
    e.stopPropagation();
    const cur = b.dataset.name || '';
    const result = await showFormDialog({
      title: '修改交付物名称',
      fields: [{ key: 'name', label: '交付物名称', value: cur, required: true }],
      confirmText: '保存',
    });
    if (!result) return;
    try {
      await api('/docs/' + encodeURIComponent(b.dataset.rename) + '/meta', { method: 'PATCH', body: { custom_name: result.name.trim() } });
      toast('已改名', 'ok');
      vApqp(p.no);
    } catch (err) { toast(err.message, 'err'); }
  });
  document.querySelectorAll('[data-hide]').forEach(b => {
    let armed = false;
    b.onclick = async (e) => {
      e.stopPropagation();
      if (!armed) {
        armed = true; b.textContent = '确认?'; b.style.background = '#FEF2F2';
        setTimeout(() => { armed = false; b.textContent = '删除'; b.style.background = ''; }, 5000);
        return;
      }
      try {
        await api('/docs/' + encodeURIComponent(b.dataset.hide) + '/meta', { method: 'PATCH', body: { hidden: 1 } });
        toast('已从清单移除', 'ok');
        vApqp(p.no);
      } catch (err) { toast(err.message, 'err'); }
    };
  });

  $$('[data-doc]').forEach(b => b.onclick = () => {
    const doc = byCode.get(b.dataset.doc);
    if (doc?.module === 'pfd') {
      goPfd(doc.arg);
    } else openDoc(b.dataset.doc);
  });
  $$('[data-tpl]').forEach(b => b.onclick = () => openTpl(b.dataset.tpl));
  $$('[data-tpl-dl]').forEach(b => b.onclick = () => {
    const pj2 = state.project ? `?p=${encodeURIComponent(state.project)}` : '';
    window.location.href = `/api/templates/${encodeURIComponent(b.dataset.tplDl)}/export${pj2}`;
    toast('正在生成文件…');
  });
  $$('[data-dl]').forEach(b => b.onclick = () => downloadDoc(b.dataset.dl, b.dataset.fmt));
  $$('[data-goto]').forEach(b => b.onclick = () => {
    if (b.dataset.goto === 'fmea' && b.dataset.arg) state.fmeaType = b.dataset.arg;
    if (b.dataset.goto === 'cp' && b.dataset.arg) state.cpStage = b.dataset.arg;
    if (b.dataset.goto === 'pfd') return goPfd(b.dataset.arg);
    go(b.dataset.goto);
  });
  $$('[data-mark]').forEach(b => b.onclick = async () => {
    try {
      await api('/docs/' + b.dataset.mark, { method: 'PUT', body: {
        data: {}, status: b.dataset.st, activity_mark: true,
      } });
      toast('已更新为「' + b.dataset.st + '」', 'ok');
      vApqp(p.no);
    } catch (e) { toast(e.message, 'err'); }
  });

  document.querySelectorAll('[data-new-doc]').forEach(b => b.onclick = (e) => {
    e.stopPropagation();
    const phase = +b.dataset.newDoc;
    const drawer = $('#drawer');
    $('.drawer-box', drawer).innerHTML = `
      <div class="drawer-h"><div><h2>新建交付物 · 阶段 ${phase}</h2>
        <p>编号自动分配：交付物 P${phase}-xx，检查表走全局 A-xx</p></div>
        <button class="x" onclick="document.getElementById('drawer').classList.remove('open')">✕</button></div>
      <div class="drawer-b">
        <div class="field"><label>名称 <span style="color:#B91C1C">*</span></label>
          <input id="ndName" placeholder="如 首件确认记录 / 量产爬坡检查表"></div>
        <div class="field"><label>类型</label>
          <select id="ndKind">
            <option value="doc">交付物（编号 P${phase}-xx）</option>
            <option value="chk">检查表（编号 A-xx 全局排）</option>
          </select></div>
        <button class="btn" id="ndSave">创建并打开</button>
      </div>`;
    drawer.classList.add('open');
    document.getElementById('ndSave').onclick = async () => {
      try {
        const r = await api('/docs/new', { method: 'POST', body: {
          name: document.getElementById('ndName').value.trim(),
          phase,
          isChecklist: document.getElementById('ndKind').value === 'chk',
        } });
        toast('已创建 ' + r.doc_code, 'ok');
        drawer.classList.remove('open');
        vApqp(p.no);
        setTimeout(() => openTpl(r.tpl_id), 300);
      } catch (err) { toast(err.message, 'err'); }
    };
  });
  document.querySelectorAll('[data-up-phase]').forEach(b => b.onclick = (e) => {
    e.stopPropagation();
    openUpload({ phase: +b.dataset.upPhase });
  });
  // A-20：按阶段批量提交/导出（只针对表单类交付物）
  document.querySelectorAll('[data-batch-submit]').forEach(b => b.onclick = async (e) => {
    e.stopPropagation();
    const codes = [...outputs, ...checklists].filter(doc => doc.kind === 'form'
      && ['草稿', '未开始', '已退回'].includes(doc.status)).map(doc => doc.code);
    if (!codes.length) return toast('本阶段没有可提交的草稿交付物', 'err');
    const ok = await showConfirmDialog('批量提交审核',
      `将提交 ${codes.length} 份草稿交付物：${codes.join('、')}。缺少变更原因或检查项不完整的会跳过。`,
      { confirmText: '批量提交' });
    if (!ok) return;
    try {
      const result = await api('/docs/batch/submit', { method: 'POST', body: { codes } });
      toast(`已提交 ${result.submitted.length} 份${result.skipped.length
        ? `；跳过 ${result.skipped.length} 份（${result.skipped.map(item => `${item.code} ${item.reason}`).join('；')}）` : ''}`,
      result.skipped.length ? 'warn' : 'ok');
      vApqp(p.no);
    } catch (error) { toast(error.message, 'err'); }
  });
  document.querySelectorAll('[data-batch-export]').forEach(b => b.onclick = async (e) => {
    e.stopPropagation();
    const codes = [...outputs, ...checklists].filter(doc => doc.kind === 'form').map(doc => doc.code);
    if (!codes.length) return toast('本阶段没有可导出的交付物', 'err');
    const fmt = await showFormDialog({
      title: '批量导出交付物',
      description: `将导出本阶段 ${codes.length} 份表单交付物为 ZIP；已批准交付物取最近批准版本，其余标注非受控。`,
      fields: [{ key: 'fmt', label: '文件格式', type: 'select', value: 'docx', options: ['docx', 'xlsx'], required: true }],
      confirmText: '开始导出',
    });
    if (!fmt) return;
    try {
      const result = await api('/docs/batch/export', { method: 'POST', body: { codes, fmt: fmt.fmt } });
      const bytes = Uint8Array.from(atob(result.dataBase64), ch => ch.charCodeAt(0));
      const href = URL.createObjectURL(new Blob([bytes], { type: 'application/zip' }));
      const anchor = document.createElement('a');
      anchor.href = href;
      anchor.download = result.fileName;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(href), 4000);
      toast(`已导出 ${result.files} 份${result.skipped.length ? `，跳过 ${result.skipped.length} 份` : ''}`,
        result.skipped.length ? 'warn' : 'ok');
    } catch (error) { toast(error.message, 'err'); }
  });
  $$('[data-tab]').forEach(b => b.onclick = () => {
    const ph = +b.dataset.phase;
    const tabs = (state.structure && state.structure.tabs && state.structure.tabs[ph]) || [];
    const tab = tabs.find(t => t.name === b.dataset.tab);
    if (!tab) return;
    const t = tab.target;
    if (t.type === 'doc') openDoc(t.code);
    else if (t.type === 'module') {
      if (t.id === 'fmea' && t.arg) state.fmeaType = t.arg;
      if (t.id === 'pfd') return goPfd(t.arg);
      go(t.id);
    }
    else if (t.type === 'page') {
      if (t.id === 'phase-docs') {
        const el = document.getElementById('ph-' + ph);
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        toast('本阶段交付物见下方列表');
      } else go(t.id);
    } else toast('该功能规划中：' + tab.name);
  });
}

// A-14：导出失败时保留当前页面，用 fetch + blob 下载而不是整页跳转到 JSON 错误
async function downloadBlob(url, fallbackName) {
  const response = await fetch(url);
  if (!response.ok) {
    let message = `导出失败（HTTP ${response.status}）`;
    try {
      const data = await response.json();
      if (data && data.error) message = data.error;
    } catch (error) { /* 非 JSON 错误体 */ }
    throw new Error(message);
  }
  const disposition = response.headers.get('content-disposition') || '';
  const match = /filename\*=UTF-8''([^;]+)/i.exec(disposition);
  const fileName = match ? decodeURIComponent(match[1]) : fallbackName;
  const blob = await response.blob();
  const href = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = href;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(href), 4000);
}

async function downloadDoc(code, fmt) {
  const pj = state.project ? `&p=${encodeURIComponent(state.project)}` : '';
  toast(`正在生成 ${fmt === 'docx' ? 'Word' : 'Excel'} 文件…`);
  try {
    await downloadBlob(`/api/docs/${encodeURIComponent(code)}/export?fmt=${fmt}${pj}`, `${code}.${fmt}`);
    toast('文件已生成', 'ok');
  } catch (error) {
    toast(error.message, 'err');
  }
}

async function exportQualityTool(tool, fmt) {
  const params = new URLSearchParams({ fmt, p: state.project || '' });
  if (tool === 'fmea') params.set('type', state.fmeaType);
  if (tool === 'cp') params.set('stage', state.cpStage || '');
  if (tool === 'spc') {
    params.set('mon_id', state.spcId || '');
    params.set('chart', state.spcChartType || '');
    if (state.spcDatasetId) params.set('dataset_id', state.spcDatasetId);
  }
  if (tool === 'msa' && state.msaStudyId) params.set('study_id', state.msaStudyId);
  if (tool === 'ppap' && state.ppapSubmissionId) params.set('submission_id', state.ppapSubmissionId);
  toast(`正在生成 ${tool.toUpperCase()} ${fmt === 'docx' ? 'Word' : 'Excel'} 文件…`);
  try {
    await downloadBlob(`/api/quality-tools/${tool}/export?${params}`, `${tool}.${fmt}`);
    toast('文件已生成', 'ok');
  } catch (error) {
    toast(error.message, 'err');
  }
}

document.addEventListener('click', event => {
  const button = event.target.closest?.('[data-quality-export]');
  if (!button) return;
  event.preventDefault();
  exportQualityTool(button.dataset.qualityExport, button.dataset.exportFmt);
});

const DOC_FIELD = f => f.type === 'date' ? '<input type="date">' : '<input type="text">';

function syncSummaryText(sync) {
  if (!sync) return '';
  const count = value => Array.isArray(value) ? value.length : Number(value || 0);
  return `联动新增 ${count(sync.created)}，更新 ${count(sync.updated)}，冲突 ${count(sync.conflicts)}，待复核 ${count(sync.review_required)}，失效来源 ${count(sync.source_missing)}`;
}

const FIELD_RELEVANCE_GROUPS = [
  ['工序', '工步', '步骤', '流程', '编号'],
  ['名称', '操作', '项目', '描述'],
  ['设备', '工装', '设施', '检具', '量具'],
  ['特性', '参数', '规格', '公差', '要求', '能力'],
  ['数量', '容量', '班次', '节拍', '产能', '用量', '样本', '频次', '频率'],
  ['责任', '负责人', '人员', '角色', '部门'],
  ['日期', '时间', '期限', '到位'],
  ['状态', '结论', '判定'],
  ['输入', '输出', '物料', '材料'],
];

const FIELD_RELEVANCE_PAIRS = [
  [/工序|工步|步骤|流程/, /项目|工序|工步|步骤|名称|操作|设备|产能|节拍|数量/, '高'],
  [/设备|工装|设施|检具|量具/, /设备|工装|设施|名称|型号|能力|数量|到位|状态/, '高'],
  [/节拍|班次|日产能|产能|数量|用量/, /产能|节拍|数量|容量|能力|班次/, '高'],
  [/名称|操作|项目/, /名称|操作|项目|描述|内容/, '高'],
  [/规格|参数|公差|要求/, /规格|参数|公差|要求|能力/, '高'],
  [/责任|负责人|人员|角色|部门/, /责任|负责人|人员|角色|部门/, '高'],
  [/日期|时间|期限|到位/, /日期|时间|期限|到位|状态/, '高'],
  [/瓶颈|风险|问题/, /风险|能力|状态|备注|措施/, '中'],
  [/编号|编码/, /编号|编码|项目|名称/, '中'],
];

function fieldRelevance(sourceLabel, targetLabel) {
  const clean = value => String(value || '').toLowerCase().replace(/[\s（）()、/—\-]/g, '');
  const source = clean(sourceLabel);
  const target = clean(targetLabel);
  if (!source || !target) return '低';
  if (source === target || source.includes(target) || target.includes(source)) return '高';
  const paired = FIELD_RELEVANCE_PAIRS.find(([sourceRule, targetRule]) =>
    sourceRule.test(source) && targetRule.test(target));
  if (paired) return paired[2];
  if (FIELD_RELEVANCE_GROUPS.some(group => group.some(word => source.includes(word))
      && group.some(word => target.includes(word)))) return '高';
  if (/日期|时间|期限/.test(source) && /日期|时间|到期|到位/.test(target)) return '高';
  if (/数量|容量|产能|节拍|样本|频次/.test(source) && /数量|容量|产能|节拍|样本|频次/.test(target)) return '高';
  const pairs = value => new Set((value.match(/../g) || []));
  const targetPairs = pairs(target);
  const overlap = [...pairs(source)].filter(pair => targetPairs.has(pair)).length;
  return overlap >= 2 ? '中' : '低';
}

function deliverableLinksHtml(items, relations = [], currentCode = '') {
  const labels = {
    synced: '已同步', conflict: '人工修改冲突', review_required: '待复核',
    source_missing: '来源已失效', pending_approval: '等待上游批准',
    kept: '保留人工值', read_only: '受控引用',
  };
  const safeValue = value => {
    if (value == null || value === '') return '-';
    if (Array.isArray(value)) return value.map(safeValue).join('；');
    if (typeof value === 'object') return '关联内容已记录';
    return String(value);
  };
  const valueHtml = value => `<div class="doc-link-value">${esc(safeValue(value))}</div>`;
  const relationHtml = relations.length ? `<div class="doc-relation-list">
    ${relations.map(relation => {
      const mapping = relation.mapping;
      const fieldPreview = mapping?.fields?.length
        ? mapping.fields.slice(0, 2).map(field => `<span class="doc-map-pair">
            ${esc(field.sourceLabel)} → ${esc(field.targetLabel)}
            <i class="rel-badge rel-${esc(field.relevance || '中')}">${esc(field.relevance || '中')}</i>
          </span>`).join('')
          + (mapping.fields.length > 2 ? `<span class="dim">另 ${mapping.fields.length - 2} 项</span>` : '')
        : '<span class="doc-link-empty">-</span>';
      const relationDoc = (code, name, status) => `<button class="doc-relation-doc" type="button"
          data-preview-related="${esc(code)}" title="在右侧预览 ${esc(name)}">
          <b>${esc(name)}</b><span class="mono">${esc(code)}</span>
          ${status ? `<i>${esc(status)}</i>` : ''}
        </button>`;
      return `<div class="doc-relation-row">
        <div class="doc-relation-pair">
          ${relation.sourceCode === currentCode ? `<div class="doc-relation-doc current">
            <b>${esc(relation.sourceName)}</b><span class="mono">${esc(relation.sourceCode)}</span><i>当前文件</i></div>`
            : relationDoc(relation.sourceCode, relation.sourceName, relation.sourceStatus)}
          <span class="doc-relation-arrow">→</span>
          ${relation.targetCode === currentCode ? `<div class="doc-relation-doc current">
            <b>${esc(relation.targetName)}</b><span class="mono">${esc(relation.targetCode)}</span><i>当前文件</i></div>`
            : relationDoc(relation.targetCode, relation.targetName, relation.targetStatus)}
        </div>
        <div class="doc-relation-map">${mapping ? '<span class="badge b-ok">已配置</span>' : ''}${fieldPreview}</div>
        <button class="btn sm ghost" data-preview-related="${esc(relation.sourceCode === currentCode ? relation.targetCode : relation.sourceCode)}">预览</button>
      </div>`;
    }).join('')}</div>` : '<div class="doc-link-empty">-</div>';
  const conflictCount = items.filter(item => ['conflict', 'review_required'].includes(item.state)).length;
  const syncHtml = `<details class="doc-sync-panel" ${conflictCount ? 'open' : ''}>
    <summary>字段同步明细 <span>${items.length} 条</span>${conflictCount ? `<b>${conflictCount} 条待处理</b>` : ''}</summary>
    ${items.length ? `<div class="doc-sync-list">${items.map(item => {
      const display = item.display || {};
      const isReference = display.kind === 'reference' || item.kind === 'reference';
      const frozen = ['已批准', '已冻结', '已发布', '已完成'].includes(item.target_status);
      const pending = item.state === 'pending_approval';
      const canResolve = ['conflict', 'review_required'].includes(item.state)
        && !['reference', 'needs_confirmation'].includes(item.kind) && item.id != null && !pending;
      const fields = Array.isArray(display.fields) ? display.fields : [];
      return `<article class="doc-sync-item">
        <div class="doc-sync-item-head">
          <div class="doc-sync-route">
            <b>${esc(display.sourceName || '上游交付物')}</b>
            ${display.sourceCode ? `<span class="mono">${esc(display.sourceCode)}</span>` : ''}
            <i>→</i>
            <b>${esc(display.targetName || '下游交付物')}</b>
            ${display.targetCode ? `<span class="mono">${esc(display.targetCode)}</span>` : ''}
          </div>
          <div class="doc-sync-badges">
            ${display.version ? `<span class="chip">版本 ${esc(display.version)}</span>` : ''}
            <span class="badge ${item.state === 'synced' || item.state === 'kept' ? 'b-ok' : item.state === 'read_only' ? 'b-gray' : 'b-warn'}">${esc(labels[item.state] || '待处理')}</span>
          </div>
        </div>
        <div class="doc-sync-summary">
          ${isReference ? `<span class="badge b-gray">${esc(display.relationLabel || '受控引用')}</span>` : ''}
          <span>${esc(display.summary || (isReference ? '仅记录上下游关系，不复制业务字段' : '字段内容待确认或尚未映射'))}</span>
        </div>
        ${fields.length ? `<div class="doc-sync-fields">${fields.map(field => `
          <section class="doc-sync-field">
            <header><b>${esc(field.label || '关联内容')}</b></header>
            ${isReference
              ? `<div class="doc-sync-reference-value">${valueHtml(field.incomingValue ?? field.currentValue)}</div>`
              : `<div class="doc-sync-compare">
                  <span><i>原同步</i>${valueHtml(field.previousValue)}</span>
                  <span><i>当前</i>${valueHtml(field.currentValue)}</span>
                  <span><i>上游</i>${valueHtml(field.incomingValue)}</span>
                </div>`}
          </section>`).join('')}</div>` : `<div class="doc-sync-empty">-</div>`}
        <div class="doc-sync-item-foot">
          <span>${esc(item.message || (isReference ? '受控引用，不覆盖下游字段' : '系统已记录来源、当前值和同步差异'))}</span>
          ${frozen && canResolve ? '<b class="dim">目标已受控，请先发起修订</b>' : ''}
          ${canResolve ? `<div class="doc-link-actions">
            <button class="btn sm ghost" data-resolve-link="${esc(item.id)}" data-link-action="keep">保留当前</button>
            <button class="btn sm" data-resolve-link="${esc(item.id)}" data-link-action="adopt" ${frozen ? 'disabled' : ''}>采用上游</button>
          </div>` : ''}
        </div>
      </article>`;
    }).join('')}</div>` : '<div class="doc-sync-empty">-</div>'}</details>`;
  return `${relationHtml}${syncHtml}`;
}

/* ------------------------------------------------------------------ 附件：图册与查看器 */
/** 图片加载失败（文件丢失/无权限）时不要留破图标，换成一行可读提示 */
function markBrokenImage(img, message) {
  if (!img || !img.parentNode) return;
  const hint = document.createElement('span');
  hint.className = 'attach-file-badge bad';
  hint.textContent = message || '图片加载失败';
  img.replaceWith(hint);
}

/**
 * 全屏图片查看器：滚轮缩放（以光标为中心）、拖动平移、双击复位、多图左右切换。
 * PDF 交给浏览器内建阅读器（<embed>），同样支持滚动与缩放。
 */
function openImageViewer(items, startIndex = 0) {
  if (!Array.isArray(items) || !items.length) return;
  const images = items.filter(item => item && (item.is_image || item.is_pdf));
  if (!images.length) return;
  let index = Math.max(0, Math.min(images.length - 1, startIndex));
  let scale = 1, offsetX = 0, offsetY = 0, dragging = false, startX = 0, startY = 0, moved = false;

  const overlay = document.createElement('div');
  overlay.className = 'img-viewer';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.innerHTML = `
    <div class="img-viewer-bar">
      <div class="img-viewer-title"><b></b><span></span></div>
      <div class="img-viewer-actions">
        <button class="btn sm ghost" data-zoom-out title="缩小（-）">−</button>
        <span class="img-viewer-zoom" data-zoom-label>100%</span>
        <button class="btn sm ghost" data-zoom-in title="放大（+）">＋</button>
        <button class="btn sm ghost" data-zoom-reset title="复位（0）">1:1</button>
        <button class="btn sm ghost" data-close title="关闭（Esc）">✕</button>
      </div>
    </div>
    <div class="img-viewer-stage" tabindex="0">
      <div class="img-viewer-canvas"></div>
    </div>
    <div class="img-viewer-strip"></div>`;
  document.body.appendChild(overlay);
  document.body.classList.add('viewer-open');

  const stage = $('.img-viewer-stage', overlay);
  const canvas = $('.img-viewer-canvas', overlay);
  const title = $('.img-viewer-title b', overlay);
  const meta = $('.img-viewer-title span', overlay);
  const zoomLabel = $('[data-zoom-label]', overlay);
  const strip = $('.img-viewer-strip', overlay);

  const applyTransform = () => {
    zoomLabel.textContent = `${Math.round(scale * 100)}%`;
    const content = $('.img-viewer-img', canvas);
    if (content) content.style.transform = `translate(${offsetX}px, ${offsetY}px) scale(${scale})`;
  };
  const reset = () => { scale = 1; offsetX = 0; offsetY = 0; applyTransform(); };
  const zoomAt = (factor, clientX, clientY) => {
    const next = Math.max(0.2, Math.min(8, scale * factor));
    if (next === scale) return;
    const rect = stage.getBoundingClientRect();
    const px = (clientX ?? (rect.left + rect.width / 2)) - rect.left - rect.width / 2;
    const py = (clientY ?? (rect.top + rect.height / 2)) - rect.top - rect.height / 2;
    // 以光标为中心缩放：保持光标下的图面点不动
    offsetX = px - ((px - offsetX) * next) / scale;
    offsetY = py - ((py - offsetY) * next) / scale;
    scale = next;
    applyTransform();
  };

  const render = () => {
    const item = images[index];
    title.textContent = item.caption || item.file_name || '附件';
    meta.textContent = [
      item.group_label, item.file_name,
      item.size ? `${Math.max(1, Math.round(item.size / 1024))} KB` : '',
      images.length > 1 ? `${index + 1}/${images.length}` : '',
    ].filter(Boolean).join(' · ');
    reset();
    if (item.is_pdf) {
      canvas.innerHTML = `<embed class="img-viewer-pdf" type="application/pdf" src="${esc(item.url)}">`;
    } else {
      canvas.innerHTML = `<img class="img-viewer-img" alt="${esc(item.caption || item.file_name || '')}"
        src="${esc(item.url)}" draggable="false">`;
      const image = $('.img-viewer-img', canvas);
      image.onload = () => { applyTransform(); };
    }
    strip.querySelectorAll('[data-goto]').forEach((button, buttonIndex) => {
      button.classList.toggle('on', buttonIndex === index);
    });
  };

  strip.innerHTML = images.length > 1 ? images.map((item, itemIndex) =>
    `<button class="img-viewer-thumb ${itemIndex === index ? 'on' : ''}" data-goto="${itemIndex}"
      title="${esc(item.caption || item.file_name || '')}">
      ${item.is_pdf ? '<span class="img-viewer-pdf-badge">PDF</span>'
        : `<img src="${esc(item.url)}" alt="">`}
    </button>`).join('') : '';

  const close = () => {
    overlay.remove();
    document.body.classList.remove('viewer-open');
    document.removeEventListener('keydown', onKey);
  };
  const step = delta => {
    if (images.length < 2) return;
    index = (index + delta + images.length) % images.length;
    render();
  };
  function onKey(event) {
    if (event.key === 'Escape') { event.preventDefault(); close(); }
    else if (event.key === 'ArrowRight') { event.preventDefault(); step(1); }
    else if (event.key === 'ArrowLeft') { event.preventDefault(); step(-1); }
    else if (event.key === '+' || event.key === '=') { event.preventDefault(); zoomAt(1.2); }
    else if (event.key === '-') { event.preventDefault(); zoomAt(1 / 1.2); }
    else if (event.key === '0') { event.preventDefault(); reset(); }
  }
  document.addEventListener('keydown', onKey);

  stage.addEventListener('wheel', event => {
    // 图片：滚轮缩放；PDF：交给浏览器滚动/翻页
    if (images[index].is_pdf) return;
    event.preventDefault();
    zoomAt(event.deltaY < 0 ? 1.12 : 1 / 1.12, event.clientX, event.clientY);
  }, { passive: false });
  stage.addEventListener('pointerdown', event => {
    if (images[index].is_pdf) return;
    dragging = true; moved = false;
    startX = event.clientX - offsetX;
    startY = event.clientY - offsetY;
    stage.setPointerCapture(event.pointerId);
    stage.classList.add('dragging');
  });
  stage.addEventListener('pointermove', event => {
    if (!dragging) return;
    offsetX = event.clientX - startX;
    offsetY = event.clientY - startY;
    if (Math.abs(offsetX) > 2 || Math.abs(offsetY) > 2) moved = true;
    applyTransform();
  });
  const endDrag = event => {
    if (!dragging) return;
    dragging = false;
    stage.classList.remove('dragging');
    try { stage.releasePointerCapture(event.pointerId); } catch (e) { /* 指针已释放 */ }
  };
  stage.addEventListener('pointerup', endDrag);
  stage.addEventListener('pointercancel', endDrag);
  stage.addEventListener('dblclick', () => { if (!images[index].is_pdf) reset(); });
  stage.addEventListener('click', () => { if (moved) { moved = false; return; } });

  overlay.addEventListener('click', event => {
    if (event.target === overlay) close();
    const goto = event.target.closest('[data-goto]');
    if (goto) { index = +goto.dataset.goto; render(); return; }
    if (event.target.closest('[data-zoom-in]')) zoomAt(1.2);
    else if (event.target.closest('[data-zoom-out]')) zoomAt(1 / 1.2);
    else if (event.target.closest('[data-zoom-reset]')) reset();
    else if (event.target.closest('[data-close]')) close();
  });

  render();
  stage.focus();
}

/**
 * 交付物附件图册：上传、说明、分类、作废、点击放大。
 * 二进制经 base64 JSON 上传（与 DFMEA 示意图一致），不引入 multipart。
 */
function openAttachmentGallery({ docCode, category, title, hint, readOnly = false }) {
  const drawer = $('#drawer');
  $('.drawer-box', drawer).innerHTML = `
    <div class="drawer-h"><div><h2>${esc(title)}</h2><p>${esc(hint || '')}</p></div>
      <button class="x" onclick="document.getElementById('drawer').classList.remove('open')">✕</button></div>
    <div class="drawer-b" id="attachBody"><div class="empty">加载中…</div></div>`;
  drawer.classList.add('open');
  // 图片 404/410 时浏览器只显示破图标，这里换成可读提示（error 不冒泡，用捕获阶段）
  $('#attachBody', drawer).addEventListener('error', event => {
    const img = event.target;
    if (!img || img.tagName !== 'IMG' || img.dataset.attachImg === undefined) return;
    markBrokenImage(img, '图片加载失败（文件可能已丢失）');
  }, true);

  const acceptMap = {
    packaging: 'image/png,image/jpeg,application/pdf',
    'drawing-preview': 'image/png,image/jpeg,application/pdf',
    'drawing-source': '.dwg,.dxf,.step,.stp,.igs,.iges,.zip',
  };
  let items = [];

  const render = () => {
    const groups = [...new Set(items.map(item => item.group_label).filter(Boolean))];
    const body = $('#attachBody', drawer);
    body.innerHTML = `
      ${readOnly ? '<div class="alert warn"><div>交付物已锁定，附件只读；如需调整请先“发起修订”。</div></div>' : `
      <div class="attach-upload">
        <input type="file" id="attachFile" accept="${acceptMap[category] || ''}" hidden>
        <button class="btn" id="attachPick">＋ 上传${category === 'drawing-source' ? ' CAD 源文件' : '图片'}</button>
        <span class="dim">${category === 'drawing-source' ? 'DWG / DXF / STEP / IGES / ZIP，单个不超过 20 MB'
          : 'PNG / JPG / PDF，单个不超过 8 MB'}</span>
      </div>
      <div class="row2">
        <div class="field"><label>说明（可选）</label><input id="attachCaption" maxlength="200"
          placeholder="${category === 'packaging' ? '如：外箱唛头正面' : category === 'drawing-source' ? '如：三维模型 V2' : '如：总装图首页'}"></div>
        <div class="field"><label>分类（可选）</label><input id="attachGroup" maxlength="40" list="attachGroupList"
          placeholder="${category === 'packaging' ? '外箱 / 内包装 / 标签 / 栈板' : '图纸 / 模型 / 工艺'}">
          <datalist id="attachGroupList">${groups.map(group => `<option value="${esc(group)}"></option>`).join('')}</datalist></div>
      </div>`}
      ${items.length ? `<div class="attach-grid">${items.map((item, index) => `
        <figure class="attach-card">
          <button class="attach-thumb" data-open-attach="${index}"
            title="${esc(item.caption || item.file_name)}">
            ${item.is_image ? `<img src="${esc(item.url)}" alt="" loading="lazy" data-attach-img="${index}">`
              : item.is_pdf ? '<span class="attach-file-badge">PDF</span>'
                : `<span class="attach-file-badge">${esc(String(item.file_name || '').split('.').pop().toUpperCase())}</span>`}
          </button>
          <figcaption>
            <div class="attach-caption">${esc(item.caption || '未填写说明')}</div>
            <div class="dim">${[item.group_label, item.file_name,
              item.size ? `${Math.max(1, Math.round(item.size / 1024))} KB` : ''].filter(Boolean).map(esc).join(' · ')}</div>
            ${readOnly ? '' : `<div class="attach-actions">
              <button class="btn sm ghost" data-edit-attach="${index}">说明</button>
              <a class="btn sm ghost" href="${esc(item.download_url)}" download>下载</a>
              <button class="btn sm ghost" data-void-attach="${index}" style="color:#B91C1C">作废</button>
            </div>`}
            ${readOnly ? `<div class="attach-actions"><a class="btn sm ghost" href="${esc(item.download_url)}" download>下载</a></div>` : ''}
          </figcaption>
        </figure>`).join('')}</div>`
        : '<div class="empty">尚未上传附件</div>'}`;

    if ($('#attachPick', drawer)) {
      $('#attachPick', drawer).onclick = () => $('#attachFile', drawer).click();
      $('#attachFile', drawer).onchange = async event => {
        const file = event.target.files && event.target.files[0];
        if (!file) return;
        const caption = $('#attachCaption', drawer).value.trim();
        const groupLabel = $('#attachGroup', drawer).value.trim();
        const button = $('#attachPick', drawer);
        button.disabled = true;
        try {
          const dataBase64 = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject(new Error('读取文件失败'));
            reader.readAsDataURL(file);
          });
          await api('/attachments', {
            method: 'POST',
            body: { doc_code: docCode, category, caption, group_label: groupLabel, file_name: file.name, dataBase64 },
          });
          toast('附件已上传', 'ok');
          await load();
        } catch (error) {
          toast(error.message, 'err');
          button.disabled = false;
        } finally {
          event.target.value = '';
        }
      };
    }
    $$('[data-open-attach]', drawer).forEach(button => button.onclick = () => {
      openImageViewer(items, +button.dataset.openAttach);
    });
    $$('[data-edit-attach]', drawer).forEach(button => button.onclick = async () => {
      const item = items[+button.dataset.editAttach];
      const result = await showFormDialog({
        title: '编辑附件说明',
        fields: [
          { key: 'caption', label: '说明', value: item.caption || '' },
          { key: 'group_label', label: '分类', value: item.group_label || '' },
        ],
        confirmText: '保存',
      });
      if (!result) return;
      try {
        await api('/attachments/' + encodeURIComponent(item.attachment_id), {
          method: 'PATCH', body: { caption: result.caption, group_label: result.group_label },
        });
        toast('已更新', 'ok');
        await load();
      } catch (error) { toast(error.message, 'err'); }
    });
    $$('[data-void-attach]', drawer).forEach(button => button.onclick = async () => {
      const item = items[+button.dataset.voidAttach];
      const result = await showFormDialog({
        title: '作废附件',
        description: '作废后页面不再显示，但文件与记录保留可追溯。',
        fields: [{ key: 'reason', label: '作废原因', type: 'textarea', required: true }],
        confirmText: '确认作废',
        validate: values => String(values.reason || '').trim().length >= 4 ? '' : '请至少填写 4 个字的原因。',
      });
      if (!result) return;
      try {
        await api('/attachments/' + encodeURIComponent(item.attachment_id) + '/void', {
          method: 'POST', body: { reason: result.reason },
        });
        toast('附件已作废', 'ok');
        await load();
      } catch (error) { toast(error.message, 'err'); }
    });
  };

  const load = async () => {
    try {
      const data = await api('/attachments?doc=' + encodeURIComponent(docCode)
        + '&category=' + encodeURIComponent(category));
      items = data.list || [];
      render();
    } catch (error) {
      $('#attachBody', drawer).innerHTML = `<div class="alert bad">${esc(error.message)}</div>`;
    }
  };
  load();
}

/** P3-02 页面内的包装图册（只展示 + 上传入口，详细管理走抽屉） */
async function mountPackingGallery(docCode, readOnly) {
  const host = $('#packingGallery');
  if (!host) return;
  let items = [];
  try {
    const data = await api('/attachments?doc=' + encodeURIComponent(docCode) + '&category=packaging');
    items = data.list || [];
  } catch (error) {
    host.innerHTML = `<div class="alert bad">${esc(error.message)}</div>`;
    return;
  }
  host.innerHTML = `
    <div class="packing-gallery-head">
      <span class="dim">${items.length ? `共 ${items.length} 张` : '尚未上传包装图片'}</span>
      ${readOnly ? '<span class="badge b-gray">已锁定，仅查看</span>'
        : '<button class="btn sm" id="packingUpload">＋ 上传包装图片</button>'}
    </div>
    ${items.length ? `<div class="attach-grid">${items.map((item, index) => `
      <figure class="attach-card">
        <button class="attach-thumb" data-packing-open="${index}" title="${esc(item.caption || item.file_name)}">
          ${item.is_image ? `<img src="${esc(item.url)}" alt="" loading="lazy" data-packing-img>` : '<span class="attach-file-badge">PDF</span>'}
        </button>
        <figcaption>
          <div class="attach-caption">${esc(item.caption || '未填写说明')}</div>
          <div class="dim">${[item.group_label, item.file_name].filter(Boolean).map(esc).join(' · ')}</div>
        </figcaption>
      </figure>`).join('')}</div>` : '<div class="empty">暂无图片</div>'}
    <input type="file" id="packingFile" accept="image/png,image/jpeg,application/pdf" hidden>`;
  $$('[data-packing-open]', host).forEach(button => button.onclick = () => {
    openImageViewer(items, +button.dataset.packingOpen);
  });
  $$('[data-packing-img]', host).forEach(img => {
    img.onerror = () => markBrokenImage(img, '图片加载失败');
  });
  if ($('#packingUpload', host)) {
    $('#packingUpload', host).onclick = () => $('#packingFile', host).click();
    $('#packingFile', host).onchange = async event => {
      const file = event.target.files && event.target.files[0];
      if (!file) return;
      try {
        const dataBase64 = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = () => reject(new Error('读取文件失败'));
          reader.readAsDataURL(file);
        });
        await api('/attachments', {
          method: 'POST',
          body: { doc_code: docCode, category: 'packaging', file_name: file.name, dataBase64 },
        });
        toast('包装图片已上传', 'ok');
        await mountPackingGallery(docCode, readOnly);
      } catch (error) {
        toast(error.message, 'err');
      } finally {
        event.target.value = '';
      }
    };
  }
}

/** P2-06 工程图页：预览 + CAD 源文件 + 变更履历 */
async function mountDrawingDoc(docCode, readOnly, docData) {
  const [previewResult, sourceResult, historyResult] = await Promise.all([
    api('/attachments?doc=' + encodeURIComponent(docCode) + '&category=drawing-preview').catch(() => ({ list: [] })),
    api('/attachments?doc=' + encodeURIComponent(docCode) + '&category=drawing-source').catch(() => ({ list: [] })),
    api('/docs/' + encodeURIComponent(docCode) + '/revisions').catch(() => ({ list: [] })),
  ]);
  const previews = previewResult.list || [];
  const sources = sourceResult.list || [];
  const revisions = historyResult.list || [];

  const previewHost = $('#drawingPreview');
  if (previewHost) {
    const cover = previews[0];
    previewHost.innerHTML = cover
      ? (cover.is_pdf
        ? `<embed class="drawing-embed" type="application/pdf" src="${esc(cover.url)}">`
        : `<button class="drawing-cover" data-drawing-open="0" title="点击查看完整图面">
            <img src="${esc(cover.url)}" alt="${esc(cover.caption || cover.file_name || '图纸预览')}">
            <span class="drawing-cover-hint">点击放大 · 滚轮缩放</span>
          </button>`)
      : `<div class="drawing-empty">
          <b>尚未上传图纸预览</b>
          <span class="dim">上传 PDF 或 PNG/JPG 后，这里显示产品主视图；点击可查看完整图面。</span>
        </div>`;
    const coverImg = $('.drawing-cover img', previewHost);
    if (coverImg) {
      coverImg.onerror = () => {
        previewHost.innerHTML = `<div class="drawing-empty">
          <b>图纸预览加载失败</b>
          <span class="dim">文件可能已丢失或当前账号无权访问，请重新上传。</span></div>`;
      };
    }
    if (cover && !cover.is_pdf) {
      $$('[data-drawing-open]', previewHost).forEach(button => button.onclick = () => {
        openImageViewer(previews, +button.dataset.drawingOpen);
      });
    }
    const actions = $('#drawingActions');
    if (actions) {
      actions.innerHTML = `
        ${previews.length > 1 ? `<div class="drawing-thumbs">${previews.map((item, index) => `
          <button class="drawing-thumb" data-drawing-open="${index}" title="${esc(item.caption || item.file_name)}">
            ${item.is_image ? `<img src="${esc(item.url)}" alt="" loading="lazy" data-drawing-thumb-img>` : '<span class="attach-file-badge">PDF</span>'}
          </button>`).join('')}</div>` : ''}
        ${readOnly ? '' : `<div class="qt-actions">
          <button class="btn sm" id="drawingUploadPreview">＋ 上传图纸预览</button>
          <span class="dim">PNG / JPG / PDF，单个不超过 8 MB</span>
        </div>
        <input type="file" id="drawingPreviewFile" accept="image/png,image/jpeg,application/pdf" hidden>`}`;
      $$('[data-drawing-open]', actions).forEach(button => button.onclick = () => {
        openImageViewer(previews, +button.dataset.drawingOpen);
      });
      $$('[data-drawing-thumb-img]', actions).forEach(img => {
        img.onerror = () => markBrokenImage(img, '加载失败');
      });
      const upload = $('#drawingUploadPreview');
      if (upload) {
        upload.onclick = () => $('#drawingPreviewFile').click();
        $('#drawingPreviewFile').onchange = async event => {
          const file = event.target.files && event.target.files[0];
          if (!file) return;
          try {
            const dataBase64 = await new Promise((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = () => resolve(reader.result);
              reader.onerror = () => reject(new Error('读取文件失败'));
              reader.readAsDataURL(file);
            });
            await api('/attachments', {
              method: 'POST',
              body: { doc_code: docCode, category: 'drawing-preview', file_name: file.name, dataBase64 },
            });
            toast('图纸预览已上传', 'ok');
            await mountDrawingDoc(docCode, readOnly, docData);
          } catch (error) { toast(error.message, 'err'); }
          finally { event.target.value = ''; }
        };
      }
    }
  }

  const sourceHost = $('#drawingSources');
  if (sourceHost) {
    sourceHost.innerHTML = `
      ${sources.length ? `<table class="t"><thead><tr><th>文件</th><th>说明</th><th class="num">大小</th><th>上传时间</th><th>操作</th></tr></thead><tbody>
        ${sources.map(item => `<tr>
          <td class="mono">${esc(item.file_name)}</td>
          <td>${esc(item.caption || '—')}</td>
          <td class="num">${Math.max(1, Math.round((item.size || 0) / 1024))} KB</td>
          <td class="mono dim">${esc(item.created_at || '')}</td>
          <td class="nowrap"><a class="btn sm ghost" href="${esc(item.download_url)}" download>下载</a>
            ${readOnly ? '' : `<button class="btn sm ghost" data-void-source="${esc(item.attachment_id)}" style="color:#B91C1C">作废</button>`}</td>
        </tr>`).join('')}</tbody></table>` : '<div class="empty">尚未上传 CAD 源文件</div>'}
      ${readOnly ? '' : `<div class="qt-actions" style="margin-top:10px">
        <button class="btn sm" id="drawingUploadSource">＋ 上传 CAD 源文件</button>
        <span class="dim">DWG / DXF / STEP / IGES / ZIP，单个不超过 20 MB</span>
      </div><input type="file" id="drawingSourceFile" accept=".dwg,.dxf,.step,.stp,.igs,.iges,.zip" hidden>`}`;
    const upload = $('#drawingUploadSource');
    if (upload) {
      upload.onclick = () => $('#drawingSourceFile').click();
      $('#drawingSourceFile').onchange = async event => {
        const file = event.target.files && event.target.files[0];
        if (!file) return;
        try {
          const dataBase64 = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject(new Error('读取文件失败'));
            reader.readAsDataURL(file);
          });
          await api('/attachments', {
            method: 'POST',
            body: { doc_code: docCode, category: 'drawing-source', file_name: file.name, dataBase64 },
          });
          toast('CAD 源文件已上传', 'ok');
          await mountDrawingDoc(docCode, readOnly, docData);
        } catch (error) { toast(error.message, 'err'); }
        finally { event.target.value = ''; }
      };
    }
    $$('[data-void-source]', sourceHost).forEach(button => button.onclick = async () => {
      const result = await showFormDialog({
        title: '作废 CAD 源文件',
        description: '作废后页面不再显示，文件与记录保留可追溯。',
        fields: [{ key: 'reason', label: '作废原因', type: 'textarea', required: true }],
        confirmText: '确认作废',
        validate: values => String(values.reason || '').trim().length >= 4 ? '' : '请至少填写 4 个字的原因。',
      });
      if (!result) return;
      try {
        await api('/attachments/' + encodeURIComponent(button.dataset.voidSource) + '/void', {
          method: 'POST', body: { reason: result.reason },
        });
        toast('已作废', 'ok');
        await mountDrawingDoc(docCode, readOnly, docData);
      } catch (error) { toast(error.message, 'err'); }
    });
  }

  const historyHost = $('#drawingHistory');
  if (historyHost) {
    historyHost.innerHTML = revisions.length ? `
      <table class="t"><thead><tr><th>时间</th><th>版本</th><th>状态</th><th>变更人</th><th>说明</th><th>批准人</th><th>操作</th></tr></thead><tbody>
        ${revisions.slice(0, 20).map(rev => `<tr>
          <td class="mono">${esc(rev.changed_at || '')}</td>
          <td class="mono">${esc(rev.version || '')}</td>
          <td>${statusBadge(rev.status)}</td>
          <td>${esc(rev.changed_by || '')}</td>
          <td>${esc(rev.change_note || '')}</td>
          <td>${esc(rev.approved_by || '—')}</td>
          <td class="nowrap">
            <button class="btn sm ghost" data-drawing-rev="${esc(rev.rev_id)}">查看</button>
            <button class="btn sm ghost" data-drawing-restore="${esc(rev.rev_id)}">恢复</button>
          </td></tr>`).join('')}
      </tbody></table>
      ${revisions.length > 20 ? '<div class="dim" style="font-size:11.5px;margin-top:6px">仅显示最近 20 条；完整历史请用页头的“历史版本”。</div>' : ''}`
      : '<div class="empty">尚无保存记录</div>';
    $$('[data-drawing-rev]', historyHost).forEach(button => button.onclick = async () => {
      const drawer = $('#drawer');
      $('.drawer-box', drawer).innerHTML = `<div class="drawer-h"><div><h2>历史快照</h2>
        <p>${esc(docCode)} · 只读</p></div>
        <button class="x" onclick="document.getElementById('drawer').classList.remove('open')">✕</button></div>
        <div class="drawer-b" id="drawingRevSnapshot"><div class="dim">加载中…</div></div>`;
      drawer.classList.add('open');
      try {
        await openDocSnapshot(docCode, button.dataset.drawingRev, '#drawingRevSnapshot');
      } catch (error) { toast(error.message, 'err'); }
    });
    $$('[data-drawing-restore]', historyHost).forEach(button => button.onclick = async () => {
      const ok = await showConfirmDialog('恢复历史版本',
        '将把该快照写回草稿，并先把当前内容保存为“恢复前”快照，可再次回退。是否继续？',
        { confirmText: '恢复' });
      if (!ok) return;
      try {
        await api(`/docs/${encodeURIComponent(docCode)}/restore/${encodeURIComponent(button.dataset.drawingRestore)}`,
          { method: 'POST', body: {} });
        toast('已恢复到所选历史版本（草稿）', 'ok');
        vDoc(docCode);
      } catch (error) { toast(error.message, 'err'); }
    });
    const hint = $('#drawingHistoryHint');
    if (hint) hint.textContent = `${revisions.length} 个保存/审批快照`;
  }
}

/* ------------------------------------------------------------------ 交付物编辑器 */
async function vDoc(code) {
  resetPersistentView();
  const [d, liveMetrics] = await Promise.all([
    api('/docs/' + code),
    code === 'P1-16' ? api('/program-metrics') : Promise.resolve(null),
  ]);
  state.docCode = code;
  const data = JSON.parse(JSON.stringify(d.data || {}));
  data._syncRows = data._syncRows || data._row_ids || {};
  d.sections.forEach(s => s.fields.forEach(f => {
    data[f.k] = f.type === 'table' ? JSON.parse(JSON.stringify(f.value || [])) : (f.value ?? '');
    if (f.type === 'table') {
      const ids = data._syncRows[f.k] || [];
      data._syncRows[f.k] = data[f.k].map((row, index) => ids[index] || crypto.randomUUID());
    }
  }));
  state.docData = data;
  state.docMeta = d.meta;
  const lockedDoc = ['待审核', '已批准', '已完成'].includes(d.status);

  $('#viewSub').textContent = `${d.phaseName} · ${d.meta.owner} · 版本 ${d.version} ${d.updated_at ? '· 更新于 ' + d.updated_at.slice(0, 16) : ''}`;

  const findFieldByKey = k => d.sections.flatMap(section => section.fields || []).find(field => field.k === k);
  const guideTitle = guide => guide
    ? `${guide.required}。${guide.guidance}${guide.example ? ` 示例：${guide.example}` : ''}`
    : '';
  const columnGuideFor = (k, ci) => findFieldByKey(k)?.col_guides?.[ci] || null;
  const fieldGuideHtml = (guide, key) => !guide ? '' : `<small class="field-guide" id="guide-${esc(key)}">
    <b>${esc(guide.required)}</b> ${esc(guide.guidance)}
    ${guide.example ? `<span>示例：${esc(guide.example)}</span>` : ''}
  </small>`;
  const columnHelpBadge = (k, ci) => {
    const guide = columnGuideFor(k, ci);
    return guide ? `<span class="column-help" title="${esc(guideTitle(guide))}" aria-label="${esc(guideTitle(guide))}">?</span>` : '';
  };
  const tableCellHtml = (k, ri, ci, value, readonly = false) => {
    const guide = columnGuideFor(k, ci);
    const title = guide ? ` title="${esc(guideTitle(guide))}"` : '';
    const typeColumn = k === 'chars' && ((code === 'P1-11' && ci === 5) || (code === 'P2-11' && ci === 6));
    if (typeColumn) return `<select data-k="${k}" data-r="${ri}" data-c="${ci}"${title}>
      <option value="">请选择类型</option>${['PRODUCT', 'PROCESS'].map(type =>
        `<option value="${type}" ${value === type || value === (type === 'PRODUCT' ? '产品特性' : '过程特性') ? 'selected' : ''}>${type === 'PRODUCT' ? '产品特性' : '过程特性'}</option>`).join('')}</select>`;
    if (code === 'P1-11' && k === 'chars' && ci === 6) {
      return `<select data-k="${k}" data-r="${ri}" data-c="${ci}"${title}>
        <option value="">请选择识别主体</option>${['顾客', '组织'].map(option =>
          `<option ${value === option ? 'selected' : ''}>${option}</option>`).join('')}</select>`;
    }
    if (code.startsWith('A-') && k === 'items' && ci === 2) {
      return `<select data-k="${k}" data-r="${ri}" data-c="${ci}"${title}>
        <option value="">请选择</option>${['是', '否', '不适用'].map(option =>
          `<option ${value === option ? 'selected' : ''}>${option}</option>`).join('')}</select>`;
    }
    const inputType = code.startsWith('A-') && k === 'items' && ci === 6 ? 'date' : 'text';
    return `<input type="${inputType}" data-k="${k}" data-r="${ri}" data-c="${ci}" value="${esc(value ?? '')}"${title} ${readonly ? 'readonly' : ''}>`;
  };
  const protectedColumns = f => Number.isInteger(f.protected_cols) ? f.protected_cols : 0;
  const columnHeadHtml = (f, title, ci) => ci < protectedColumns(f)
    ? `<th title="标准关联字段">${esc(title)}${columnHelpBadge(f.k, ci)}</th>`
    : `<th><input class="colname" data-ck="${f.k}" data-ci="${ci}" value="${esc(title)}">${columnHelpBadge(f.k, ci)}<button class="del-col" data-k="${f.k}" data-c="${ci}" title="删除此列" style="border:0;background:transparent;cursor:pointer;color:#B91C1C;font-size:11px;margin-left:4px;padding:0">✕</button></th>`;
  const fieldHtml = f => {
    if (f.type === 'table') {
      const cols = f.cols || [];
      const readonly = false;
      return `<div class="fld wide"><label>${esc(f.label)}</label>
        <details class="table-guide"><summary>填写指引 <span>按列说明</span></summary>
          <div class="table-guide-list">${cols.map((column, ci) => {
            const guide = columnGuideFor(f.k, ci);
            return guide ? `<div class="table-guide-item"><b>${esc(column)}</b><span>${esc(guide.guidance)}</span>
              ${guide.example ? `<em>示例：${esc(guide.example)}</em>` : ''}</div>` : '';
          }).join('')}</div>
        </details>
        <div class="tbl-edit" data-tbl="${f.k}">
          <table><thead><tr>${cols.map((c, ci) => readonly ? `<th>${esc(c)}${columnHelpBadge(f.k, ci)}</th>` : columnHeadHtml(f, c, ci)).join('')}${readonly ? '' : `<th style="width:46px"><button class="add-col" data-k="${f.k}" title="添加一列" style="border:0;background:transparent;cursor:pointer;color:#2D6CDF;font-size:12px;padding:0">＋</button></th>`}</tr></thead>
          <tbody>${(data[f.k] || []).map((row, ri) => `<tr>${cols.map((c, ci) =>
            `<td>${tableCellHtml(f.k, ri, ci, row[ci], readonly)}</td>`).join('')}
            ${readonly ? '' : `<td><button class="x del-row" data-k="${f.k}" data-r="${ri}" title="删除此行">✕</button></td>`}</tr>`).join('')}</tbody>
        </table>
        </div>
        <button class="btn sm ghost add-row" data-k="${f.k}" data-cols="${cols.length}" style="margin-top:8px;align-self:flex-start">+ 添加一行</button></div>`;
    }
    if (f.type === 'textarea') {
      return `<div class="fld wide"><label>${esc(f.label)}</label>
        ${fieldGuideHtml(f.guide, f.k)}
        <textarea data-k="${f.k}" rows="3" title="${esc(guideTitle(f.guide))}">${esc(data[f.k] ?? '')}</textarea></div>`;
    }
    if (f.type === 'select') {
      const opts = (f.options || []).map(o => `<option ${o === data[f.k] ? 'selected' : ''}>${esc(o)}</option>`).join('');
      return `<div class="fld"><label>${esc(f.label)}</label>
        ${fieldGuideHtml(f.guide, f.k)}
        <select data-k="${f.k}" title="${esc(guideTitle(f.guide))}"><option value="">— 请选择 —</option>${opts}</select></div>`;
    }
    const t = f.type === 'date' ? 'date' : 'text';
    return `<div class="fld ${f.w === 'half' ? 'half' : ''}"><label>${esc(f.label)}</label>
      ${fieldGuideHtml(f.guide, f.k)}
      <input type="${t}" data-k="${f.k}" value="${esc(data[f.k] ?? '')}" title="${esc(guideTitle(f.guide))}"></div>`;
  };
  const programMetricsHtml = liveMetrics ? `
    ${(() => {
      const snapshot = d.data._programMetricsSnapshot;
      return `<div class="program-metrics-source">${snapshot?.captured_at
        ? `已批准快照 ${esc(snapshot.captured_at.slice(0, 16))} · ${esc(snapshot.approved_by || '')}`
        : '当前准备度（批准本交付物时将冻结快照）'}</div>`;
    })()}
    <section class="sec program-metrics">
      <div class="program-metrics-head">
        <div><h3>APQP 关键要素准备度</h3><span class="dim">项目经理核对系统状态后用于阶段评审；系统汇总不替代人工批准</span></div>
        <div class="program-metrics-summary">
          <span class="b-bad">${(d.data._programMetricsSnapshot?.summary || liveMetrics.summary).red} 红</span>
          <span class="b-warn">${(d.data._programMetricsSnapshot?.summary || liveMetrics.summary).yellow} 黄</span>
          <span class="b-ok">${(d.data._programMetricsSnapshot?.summary || liveMetrics.summary).green} 绿</span>
          ${(d.data._programMetricsSnapshot?.summary || liveMetrics.summary).overdue ? `<span class="b-bad">${(d.data._programMetricsSnapshot?.summary || liveMetrics.summary).overdue} 逾期</span>` : ''}
        </div>
      </div>
      <div class="program-metrics-scroll"><table class="t">
        <thead><tr><th>阶段</th><th>关键要素</th><th>负责人</th><th>状态</th><th>进展 / 说明</th></tr></thead>
        <tbody>${(d.data._programMetricsSnapshot?.items || liveMetrics.items).map(item => `<tr>
          <td>P${item.phase}</td>
          <td><button class="program-metric-link" data-open-metric="${esc(item.code)}">${esc(item.name)}</button>
            <span class="mono dim">${esc(item.code)}</span></td>
          <td>${esc(item.owner || '—')}</td>
          <td><span class="badge ${item.health === 'green' ? 'b-ok' : item.health === 'yellow' ? 'b-warn' : 'b-bad'}">${esc(item.status)}${item.overdue ? ' · 逾期' : ''}</span></td>
          <td class="dim">${esc(item.detail || '—')}</td>
        </tr>`).join('')}</tbody>
      </table></div>
      <div class="program-metrics-special">特殊特性：产品 ${(d.data._programMetricsSnapshot?.summary || liveMetrics.summary).specialProductChars} 项 · 过程 ${(d.data._programMetricsSnapshot?.summary || liveMetrics.summary).specialProcessChars} 项</div>
    </section>` : '';

  // P2-06 工程图：只保留图纸预览、CAD 源文件、变更履历与折叠的图纸清单
  const isDrawing = code === 'P2-06';
  const isPackaging = code === 'P3-02';
  const drawingSections = isDrawing
    ? d.sections.filter(sec => sec.t !== '基本信息')
    : d.sections;

  $('#view').innerHTML = `
    <div class="docbar">
      <div>
        <div class="lbl">${esc(d.meta.code)} · ${esc(d.phaseName)}</div>
        <h2 style="margin:2px 0 0;font-size:19px">${esc(d.meta.name)}</h2>
        <div class="dim" style="font-size:11.5px;margin-top:2px">编制归属：${esc(d.meta.owner || '未指定')}
          ${d.meta.ownerRoles && d.meta.ownerRoles.length ? `（${d.meta.ownerRoles.map(esc).join(' / ')}）` : ''}</div>
      </div>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <select id="docStatus" class="sel" disabled title="状态由提交、审批和退回动作驱动">
          ${['未开始', '草稿', '待审核', '已批准', '已完成'].map(s => `<option ${s === d.status ? 'selected' : ''}>${s}</option>`).join('')}
        </select>
        <button class="btn ghost" id="docHistory">历史版本</button>
        <button class="btn ghost" id="docBack">返回清单</button>
        <button class="btn ghost" id="dlDocx">下载 Word</button>
        <button class="btn ghost" id="dlXlsx">下载 Excel</button>
        ${['未开始', '草稿'].includes(d.status) && d.meta.can_edit ? '<button class="btn ghost" id="docSubmit">提交审核</button>' : ''}
        ${d.status === '待审核' && d.meta.can_approve ? '<button class="btn" id="docApprove">批准</button><button class="btn ghost" id="docReject">退回</button>' : ''}
        ${d.status === '已批准' && d.meta.can_complete ? '<button class="btn ghost" id="docComplete">标记完成</button>' : ''}
        ${['已批准', '已完成'].includes(d.status) && d.meta.can_edit ? '<button class="btn" id="docRevise">发起修订</button>' : ''}
        ${lockedDoc || !d.meta.can_edit ? '' : '<button class="btn" id="docSave">保存</button>'}
      </div>
    </div>
    <div class="docwrap">
      <div class="field doc-change-reason">
        <label>本次内容变更原因 <span class="dim">（重新提交前必填）</span></label>
        <input id="docChangeNote" value="${esc(['变更原因待补充', '保存交付物'].includes(d.change_note) ? '' : d.change_note)}"
          placeholder="说明为什么修改，例如：依据顾客图纸 Rev C 更新阻值公差">
        <small class="dim">申请人、批准人和时间由系统随版本记录。</small>
      </div>
      ${isDrawing ? `
      <section class="sec drawing-hero">
        <div class="doc-links-heading"><h3>图纸预览</h3>
          <span class="dim" id="drawingPreviewHint">首屏显示主视图，点击可放大查看完整图面</span></div>
        <div id="drawingPreview" class="drawing-preview"><div class="empty">加载中…</div></div>
        <div class="drawing-actions" id="drawingActions"></div>
      </section>
      <section class="sec">
        <div class="doc-links-heading"><h3>CAD 源文件</h3>
          <span class="dim">DWG / DXF / STEP / IGES，作为受控附件归档</span></div>
        <div id="drawingSources"><div class="dim">加载中…</div></div>
      </section>
      <section class="sec">
        <div class="doc-links-heading"><h3>变更履历</h3>
          <span class="dim" id="drawingHistoryHint">最近保存与审批快照</span></div>
        <div id="drawingHistory"><div class="dim">加载中…</div></div>
      </section>` : `
      <section class="sec doc-links-section">
        <div class="doc-links-heading"><h3>上游来源与内容联动</h3>
          <span class="dim" id="docLinkSummary">正在读取关联…</span></div>
        <details class="doc-link-advanced">
          <summary>高级设置 · 字段自动填充</summary>
          <div><span>仅在需要自动写入下游字段时使用；日常文件编制请直接点击上下游文件预览并复制。</span>
            <button class="btn sm ghost" id="docConfigureLinks">配置字段映射</button></div>
        </details>
        <div id="docLinks"><div class="dim">加载中…</div></div>
      </section>`}
      ${programMetricsHtml}
      ${drawingSections.map(sec => {
        const plain = sec.fields.filter(f => f.type !== 'table');
        const tables = sec.fields.filter(f => f.type === 'table');
        const body = tables.length
          ? `<div class="stack">${sec.fields.map(fieldHtml).join('')}</div>`
          : `<div class="fields">${plain.map(fieldHtml).join('')}</div>`;
        // 工程图页：图纸清单折叠保留，不干扰主视图
        if (isDrawing) {
          return `<details class="sec drawing-list">
            <summary>${esc(sec.t)}（可选附表）</summary>
            ${sec.note ? `<p class="dim" style="margin:-4px 0 10px">${esc(sec.note)}</p>` : ''}
            ${body}
          </details>`;
        }
        return `<section class="sec">
        <h3>${esc(sec.t)}</h3>
        ${sec.note ? `<p class="dim" style="margin:-4px 0 10px">${esc(sec.note)}</p>` : ''}
        ${body}
      </section>`;
      }).join('')}
      ${isPackaging ? `
      <section class="sec packing-gallery">
        <div class="doc-links-heading"><h3>包装图片与标识</h3>
          <span class="dim">「标识内容」列的文字应与图片中的唛头、标签一致</span></div>
        <div id="packingGallery"><div class="empty">加载中…</div></div>
        <div class="dim" style="font-size:11.5px;margin-top:8px">图片随交付物归档：点击缩略图可放大，滚轮缩放、拖动平移；导出 Word 时按顺序嵌入。</div>
      </section>` : ''}
      <div class="docfoot">
        <span id="saveState" class="dim">已保存</span>
        <span class="dim">该文档的内容会写入审计流；下载即生成当前版本的 Word / Excel 文件。</span>
      </div>
    </div>`;
  if (lockedDoc) {
    $$('.docwrap input, .docwrap textarea, .docwrap select, .docwrap .add-row, .docwrap .add-col, .docwrap .del-row, .docwrap .del-col')
      .forEach(element => {
        if (element.closest('.doc-links-section') || element.closest('.doc-derived-actions')) return;
        if (element.matches('.add-row, .add-col, .del-row, .del-col')) element.hidden = true;
        else element.disabled = true;
      });
  }

  $$('[data-open-metric]').forEach(button => button.onclick = () => {
    const meta = (state.lastDocs || []).find(item => item.code === button.dataset.openMetric)
      || liveMetrics?.items.find(item => item.code === button.dataset.openMetric);
    if (!meta) return;
    if (meta.module === 'pfd') {
      goPfd(meta.arg);
    } else if (meta.kind === 'module') {
      if (meta.module === 'fmea' && meta.arg) state.fmeaType = meta.arg;
      if (meta.module === 'cp' && meta.arg) state.cpStage = meta.arg;
      go(meta.module);
    } else openDoc(meta.code);
  });

  // 绑定
  let dirty = false, timer = null;
  let currentRelations = [];
  const refreshLinks = async () => {
    try {
      const [links, relations] = await Promise.all([
        api('/deliverable-links?doc=' + encodeURIComponent(code)),
        api('/deliverable-links/relations?doc=' + encodeURIComponent(code)),
      ]);
      if (state.view !== 'doc' || state.docCode !== code || !$('#docLinks')) return;
      const items = (links.items || []).filter(item => !String(item.ruleId || '').startsWith('project-reference:'));
      currentRelations = relations.items || [];
      const mappingByPair = new Map((relations.mappings || [])
        .map(item => [`${item.sourceCode}:${item.targetCode}`, item]));
      currentRelations.forEach(relation => {
        relation.mapping = mappingByPair.get(`${relation.sourceCode}:${relation.targetCode}`) || null;
      });
      $('#docLinkSummary').textContent = `${currentRelations.length} 条上下游关系 · ${items.length} 条同步记录`;
      $('#docLinks').innerHTML = deliverableLinksHtml(items, currentRelations, code);
    } catch (e) {
      if ($('#docLinks')) $('#docLinks').textContent = '关联读取失败：' + e.message;
    }
  };
  // P2-06 不渲染上下游联动区块，避免读写不存在的节点
  if ($('#docLinks')) refreshLinks();
  const openFieldMapping = async (sourceCode = null, targetCode = null) => {
    const relations = currentRelations.filter(item => item.sourceCode);
    if (!relations.length) return toast('当前交付物没有可配置的上下游表单关系', 'warn');
    const selectedRelation = relations.findIndex(item =>
      item.sourceCode === sourceCode && item.targetCode === targetCode);
    const drawer = $('#drawer');
    $('.drawer-box', drawer).innerHTML = `<div class="drawer-h"><div><h2>配置字段联动</h2>
      <p>用唯一匹配键连接上下游行；不按行号或名称自动猜测。</p></div>
      <button class="x" id="fieldMapClose" title="关闭">✕</button></div>
      <div class="drawer-b"><div class="field"><label>上下游关系</label>
        <select id="fieldMapRelation">${relations.map((item, index) =>
          `<option value="${index}" ${index === selectedRelation ? 'selected' : ''}>${esc(item.label)}</option>`).join('')}</select></div>
        <div id="fieldMapBody"><div class="dim">正在读取表格字段…</div></div></div>`;
    drawer.classList.add('open');
    $('#fieldMapClose').onclick = () => drawer.classList.remove('open');
    const loadMappingFields = async () => {
      const relation = relations[+$('#fieldMapRelation').value];
      const options = await api(`/deliverable-links/fields?source=${encodeURIComponent(relation.sourceCode)}&target=${encodeURIComponent(relation.targetCode)}`);
      if (!options.sourceTables.length || !options.targetTables.length) {
        $('#fieldMapBody').innerHTML = '<div class="empty">上下游交付物中没有可映射的表格。</div>';
        return;
      }
      const tableOptions = (tables, selected) => tables.map(table =>
        `<option value="${esc(table.key)}" ${table.key === selected ? 'selected' : ''}>${esc(table.label)}（${table.rows} 行）</option>`).join('');
      const sourceTable = options.sourceTables[0], targetTable = options.targetTables[0];
      const sourceState = options.source.approved ? `已批准 ${options.source.version} · 正式同步`
        : `${options.source.status} · 可草稿预填`;
      $('#fieldMapBody').innerHTML = `<section class="field-map-section">
        <div class="field-map-section-head"><i>1</i><div><b>上下游范围</b><span>先确定数据来自哪张表、写入哪张表。</span></div></div>
        <div class="field-map-source-state">
          <span>上游状态</span><b>${esc(sourceState)}</b>
          ${!options.source.approved ? '<em>当前无已批准输入；确认后先写入下游空白行，上游批准后再正式同步。</em>' : ''}
        </div>
        <div class="row2">
          <div class="field"><label>上游表格</label><select id="fieldMapSourceTable">${tableOptions(options.sourceTables, sourceTable.key)}</select></div>
          <div class="field"><label>下游表格</label><select id="fieldMapTargetTable">${tableOptions(options.targetTables, targetTable.key)}</select></div>
        </div>
      </section>
      <section class="field-map-section">
        <div class="field-map-section-head"><i>2</i><div><b>字段对应</b><span>每个上游字段只映射一个下游字段；第一组同时作为匹配键。</span></div></div>
        <div id="fieldMapRows"></div>
        <button class="btn sm ghost" id="fieldMapAdd">＋ 添加映射字段</button>
      </section>
      <section class="field-map-section field-map-confirm">
        <div class="field-map-section-head"><i>3</i><div><b>确认写入</b><span>已有值不覆盖；无匹配行时写入下游空白行。</span></div></div>
        <div class="alert info">确认后会记录来源、映射字段和本次预填结果；上游批准后进入正式同步。</div>
        <button class="btn" id="fieldMapSave">确认并同步</button>
      </section>`;
      const tableByKey = (tables, key) => tables.find(table => table.key === key);
      const optionLabel = column => `${column.label}${column.sample ? ` · ${column.sample}` : ''}`;
      const columnsHtml = columns => columns.map(column =>
        `<option value="${column.index}">${esc(optionLabel(column))}</option>`).join('');
      const suggestedTargets = (sourceColumn, columns) => ['高', '中', '低'].flatMap(level =>
        columns.filter(column => fieldRelevance(sourceColumn?.label, column.label) === level)
          .map(column => ({ column, level })));
      const targetOptionsHtml = (sourceColumn, columns) => suggestedTargets(sourceColumn, columns)
        .map(({ column, level }) =>
          `<option value="${column.index}" data-relevance="${level}">[${level}] ${esc(optionLabel(column))}</option>`).join('')
        + '<option value="__new" data-relevance="低">新增下游列…</option>';
      const targetSuggestion = (sourceLabel, targetCode) => {
        const target = tableByKey(options.targetTables, $('#fieldMapTargetTable').value);
        const column = target.columns.find(item => String(item.index) === String(targetCode));
        return fieldRelevance(sourceLabel, column?.label);
      };
      const renumberCards = () => $$('.field-map-row', $('#fieldMapRows')).forEach((card, index) => {
        $('.field-map-card-index', card).textContent = String(index + 1).padStart(2, '0');
      });
      const refreshTargetOptions = row => {
        const source = tableByKey(options.sourceTables, $('#fieldMapSourceTable').value);
        const target = tableByKey(options.targetTables, $('#fieldMapTargetTable').value);
        const sourceSelect = $('.field-map-source', row);
        const targetSelect = $('.field-map-target', row);
        const oldLabel = target.columns.find(column => String(column.index) === targetSelect.value)?.label;
        const sourceColumn = source.columns[+sourceSelect.value];
        targetSelect.innerHTML = targetOptionsHtml(sourceColumn, target.columns);
        const same = target.columns.find(column => column.label === oldLabel);
        if (same) targetSelect.value = String(same.index);
        $('.field-map-relevance', row).value = targetSuggestion(sourceColumn?.label, targetSelect.value);
        $('.field-map-source-value', row).textContent = sourceColumn?.sample || '-';
        const targetColumn = target.columns.find(column => String(column.index) === targetSelect.value);
        $('.field-map-target-value', row).textContent = targetColumn?.sample || '-';
      };
      const renderFields = () => {
        const source = tableByKey(options.sourceTables, $('#fieldMapSourceTable').value);
        const target = tableByKey(options.targetTables, $('#fieldMapTargetTable').value);
        $('#fieldMapRows').innerHTML = `<div class="field-map-table-scroll"><table class="field-map-table">
          <thead><tr><th>#</th><th>上游字段</th><th>下游字段内容</th><th>关联度</th>
            <th>上游当前值</th><th>下游当前值</th><th>操作</th></tr></thead>
          <tbody><tr class="field-map-row">
            <td><span class="field-map-card-index">01</span></td>
            <td><select class="field-map-source">${columnsHtml(source.columns)}</select></td>
            <td><div class="field-map-target-wrap">
              <select class="field-map-target">${targetOptionsHtml(source.columns[0], target.columns)}</select>
              <input class="field-map-new" placeholder="新列名称" hidden></div></td>
            <td><select class="field-map-relevance">
              <option value="高">高</option><option value="中">中</option><option value="低">低</option>
            </select></td>
            <td><b class="field-map-source-value">-</b></td>
            <td><b class="field-map-target-value">-</b></td>
            <td><button class="x" data-remove-map title="移除这组映射">✕</button></td>
          </tr></tbody>
        </table></div>`;
        refreshTargetOptions($('.field-map-row', $('#fieldMapRows')));
        $('#fieldMapRows').onchange = event => {
          const row = event.target.closest('.field-map-row');
          if (!row) return;
          if (event.target.classList.contains('field-map-source')) {
            refreshTargetOptions(row);
            return;
          }
          if (!event.target.classList.contains('field-map-target')) return;
          const input = $('.field-map-new', row);
          input.hidden = event.target.value !== '__new';
          if (!input.hidden) input.focus();
          const source = tableByKey(options.sourceTables, $('#fieldMapSourceTable').value);
          const sourceColumn = source.columns[+$('.field-map-source', row).value];
          $('.field-map-relevance', row).value = targetSuggestion(
            sourceColumn?.label,
            event.target.value,
          );
          const target = tableByKey(options.targetTables, $('#fieldMapTargetTable').value);
          const targetColumn = target.columns.find(column => String(column.index) === event.target.value);
          $('.field-map-source-value', row).textContent = sourceColumn?.sample || '-';
          $('.field-map-target-value', row).textContent = targetColumn?.sample || '-';
        };
        $('#fieldMapRows').onclick = event => {
          const remove = event.target.closest('[data-remove-map]');
          if (!remove) return;
          if ($$('.field-map-row', $('#fieldMapRows')).length === 1) {
            return toast('至少保留一组字段映射', 'warn');
          }
          remove.closest('.field-map-row').remove();
          renumberCards();
        };
      };
      if (options.mapping) {
        $('#fieldMapSourceTable').value = options.mapping.sourceTable;
        $('#fieldMapTargetTable').value = options.mapping.targetTable;
      }
      renderFields();
      if (options.mapping && options.mapping.sourceTable === $('#fieldMapSourceTable').value
          && options.mapping.targetTable === $('#fieldMapTargetTable').value) {
        const savedFields = options.mapping.fields.filter((mapping, index, fields) =>
          fields.findIndex(item => item.sourceIndex === mapping.sourceIndex) === index);
        const firstRow = $('.field-map-row', $('#fieldMapRows'));
        for (const [index, mapping] of savedFields.entries()) {
          const mapRow = index === 0 ? firstRow : firstRow.cloneNode(true);
          if (index) $('#fieldMapRows').appendChild(mapRow);
          $('.field-map-source', mapRow).value = String(mapping.sourceIndex);
          const targetSelect = $('.field-map-target', mapRow);
          const targetColumns = tableByKey(options.targetTables, options.mapping.targetTable).columns;
          if (!targetColumns.some(column => column.index === mapping.targetIndex)) {
            targetSelect.value = '__new';
            const input = $('.field-map-new', mapRow);
            input.hidden = false;
            input.value = mapping.targetLabel;
          } else {
            refreshTargetOptions(mapRow);
            targetSelect.value = String(mapping.targetIndex);
          }
          $('.field-map-relevance', mapRow).value = mapping.relevance || '中';
        }
      }
      $('#fieldMapSourceTable').onchange = renderFields;
      $('#fieldMapTargetTable').onchange = renderFields;
      $('#fieldMapAdd').onclick = () => {
        const source = tableByKey(options.sourceTables, $('#fieldMapSourceTable').value);
        const target = tableByKey(options.targetTables, $('#fieldMapTargetTable').value);
        const usedSources = new Set($$('.field-map-source', $('#fieldMapRows')).map(select => +select.value));
        const nextSource = source.columns.find(column => !usedSources.has(column.index));
        if (!nextSource) return toast('所有上游字段都已配置映射', 'warn');
        const row = $('.field-map-row', $('#fieldMapRows')).cloneNode(true);
        $('.field-map-table tbody', $('#fieldMapRows')).appendChild(row);
        $('.field-map-source', row).value = String(nextSource.index);
        refreshTargetOptions(row);
        const usedTargets = new Set($$('.field-map-target', $('#fieldMapRows'))
          .filter(select => select !== $('.field-map-target', row))
          .map(select => +select.value).filter(Number.isInteger));
        const nextTarget = [...$('.field-map-target', row).options]
          .find(option => option.value !== '__new' && !usedTargets.has(+option.value));
        if (nextTarget) {
          $('.field-map-target', row).value = nextTarget.value;
          $('.field-map-target', row).dispatchEvent(new Event('change', { bubbles: true }));
        }
        renumberCards();
      };
      $('#fieldMapSave').onclick = async () => {
        try {
          const mappings = $$('.field-map-row', $('#fieldMapRows')).map(row => {
            const targetSelect = $('.field-map-target', row);
            const isNew = targetSelect.value === '__new';
            return {
              sourceIndex: +$('.field-map-source', row).value,
              targetIndex: isNew ? -1 : +targetSelect.value,
              targetLabel: isNew ? $('.field-map-new', row).value.trim()
                : tableByKey(options.targetTables, $('#fieldMapTargetTable').value).columns
                  .find(column => column.index === +targetSelect.value)?.label,
              relevance: $('.field-map-relevance', row).value,
            };
          });
          if (new Set(mappings.map(mapping => mapping.sourceIndex)).size !== mappings.length) {
            throw new Error('同一上游字段只能映射一个下游字段，请删除重复映射');
          }
          const result = await api('/deliverable-links/fields', { method: 'POST', body: {
            ...relation, sourceTable: $('#fieldMapSourceTable').value,
            targetTable: $('#fieldMapTargetTable').value,
            fields: mappings,
          } });
          drawer.classList.remove('open');
          toast(result.preview?.rows
            ? `字段联动已配置，并按当前上游内容预填 ${result.preview.rows} 行`
            : '字段联动已配置；上游批准后执行正式同步', 'ok');
          await vDoc(code);
        } catch (error) { toast(error.message, 'err'); }
      };
    };
    $('#fieldMapRelation').onchange = () => loadMappingFields().catch(error => toast(error.message, 'err'));
    try { await loadMappingFields(); } catch (error) { toast(error.message, 'err'); }
  };
  if ($('#docConfigureLinks')) $('#docConfigureLinks').onclick = () => openFieldMapping();
  if ($('#docLinks')) $('#docLinks').addEventListener('click', event => {
    const preview = event.target.closest('[data-preview-related]');
    if (preview) {
      openRelatedPreview(preview.dataset.previewRelated);
      return;
    }
    const button = event.target.closest('[data-configure-field]');
    if (!button) return;
    const [sourceCode, targetCode] = button.dataset.configureField.split(':');
    openFieldMapping(sourceCode, targetCode);
  });
  // 包装图片（P3-02）与工程图（P2-06）的附件区
  const attachReadOnly = lockedDoc || !d.meta.can_edit;
  if (isPackaging) mountPackingGallery(code, attachReadOnly);
  if (isDrawing) mountDrawingDoc(code, attachReadOnly, d);
  const markDirty = () => {
    dirty = true;
    docHasUnsaved = true;
    const el = $('#saveState');
    if (el) { el.textContent = '未保存…'; el.className = 'dim'; }
    clearTimeout(timer);
    timer = setTimeout(() => saveDoc(true), 1500);
  };
  const saveDoc = async (auto) => {
    try {
      clearTimeout(timer);
      // A-04/A-17：保存只依赖本次快照，不读全局 state；状态控件禁用时沿用服务端状态
      const snapshot = JSON.parse(JSON.stringify(state.docData || {}));
      const statusEl = $('#docStatus');
      const status = statusEl && !statusEl.disabled ? statusEl.value : (d.status || '草稿');
      const changeNote = $('#docChangeNote') && !$('#docChangeNote').disabled
        ? $('#docChangeNote').value.trim() : '';
      const colsMap = {};
      for (const sec of (d.sections || [])) {
        for (const f of (sec.fields || [])) {
          if (f.type === 'table' && Array.isArray(f.cols)) colsMap[f.k] = f.cols;
        }
      }
      const r = await api('/docs/' + code, { method: 'PUT', body: {
        data: snapshot, cols: colsMap, status, version: d.version,
        base_lock_token: d.lock_token || '',
        change_note: changeNote,
      } });
      // 服务端每次保存都轮换令牌，作为下一次保存的乐观锁基准
      if (r.lock_token) d.lock_token = r.lock_token;
      if (r.updated_at) d.updated_at = r.updated_at;
      dirty = false;
      docHasUnsaved = false;
      if ($('#docStatus')) $('#docStatus').value = r.status || status;
      const el = $('#saveState');
      if (el) { el.textContent = `已保存（完成度 ${r.pct}%）· ${new Date().toLocaleTimeString('zh-CN')}`; el.className = 'ok'; }
      if (!auto) toast(r.status !== status
        ? `内容已保存为${r.status}，修改后需重新提交审核${r.sync ? '；' + syncSummaryText(r.sync) : ''}`
        : '已保存，完成度 ' + r.pct + '%' + (r.sync ? '；' + syncSummaryText(r.sync) : ''), 'ok');
      await refreshLinks();
      if (status === '未开始' && r.pct > 0 && $('#docStatus')) $('#docStatus').value = r.status;
      // 自检：回读一次，确认库里确实存下了
      try {
        const back = await api('/docs/' + encodeURIComponent(code));
        const check = (back.sections || []).filter(x => x.fields && x.fields.length)
          .flatMap(x => x.fields).filter(f => f.type !== 'table');
        let lost = 0;
        for (const f of check) {
          const sent = snapshot[f.k] == null ? '' : String(snapshot[f.k]);
          const got = f.value == null ? '' : String(f.value);
          if (sent && sent !== got) lost += 1;
        }
        if (lost) {
          toast('保存校验失败：' + lost + ' 个字段未落库，请联系管理员', 'err');
          if (el) { el.textContent = '保存校验失败'; el.className = 'err'; }
        }
      } catch (e2) { /* 回读失败不阻塞 */ }
      return true;
    } catch (e) {
      if (e.status === 409) {
        // 乐观锁冲突：不要把旧内容写回去，也不要再自动重试
        dirty = false;
        const el = $('#saveState');
        if (el) { el.textContent = '保存冲突：文档已被其他会话修改'; el.className = 'err'; }
      }
      toast(e.message, 'err');
      return false;
    }
  };

  $('#view').addEventListener('input', e => {
    const el = e.target;
    if (el.id === 'docChangeNote') { markDirty(); return; }
    const k = el.dataset.k;
    if (!k) return;
    if (el.dataset.r !== undefined) {
      const r = +el.dataset.r, c = +el.dataset.c;
      state.docData[k] = state.docData[k] || [];
      state.docData[k][r] = state.docData[k][r] || [];
      state.docData[k][r][c] = el.value;
    } else {
      state.docData[k] = el.value;
    }
    markDirty();
  });
  $('#view').addEventListener('change', e => {
    const el = e.target;
    if (el.tagName !== 'SELECT' || !el.dataset.k) return;
    const k = el.dataset.k;
    if (el.dataset.r !== undefined) {
      const r = +el.dataset.r, c = +el.dataset.c;
      state.docData[k][r][c] = el.value;
    } else state.docData[k] = el.value;
    markDirty();
  });

  const findTblField = (k) => {
    for (const sec of (d.sections || [])) {
      for (const f of (sec.fields || [])) if (f.k === k && f.type === 'table') return f;
    }
    return null;
  };
  const rebuildTable = (k) => {
    const f = findTblField(k);
    const wrap = $(`.tbl-edit[data-tbl="${k}"]`);
    if (!f || !wrap) return;
    const cols = f.cols;
    const rows = state.docData[k] || [];
    wrap.innerHTML = `<table><thead><tr>${cols.map((c, ci) => columnHeadHtml(f, c, ci)).join('')}
      <th style="width:46px"><button class="add-col" data-k="${k}" title="添加一列" style="border:0;background:transparent;cursor:pointer;color:#2D6CDF;font-size:12px;padding:0">＋</button></th></tr></thead>
      <tbody>${rows.map((row, ri) => `<tr>${cols.map((c, ci) =>
        `<td>${tableCellHtml(k, ri, ci, row[ci])}</td>`).join('')}
        <td><button class="x del-row" data-k="${k}" data-r="${ri}">✕</button></td></tr>`).join('')}</tbody></table>`;
  };

  $('#view').addEventListener('input', e => {
    const el = e.target.closest('.colname');
    if (!el) return;
    const f = findTblField(el.dataset.ck);
    if (!f) return;
    if (+el.dataset.ci < protectedColumns(f)) return;
    f.cols[+el.dataset.ci] = el.value;
    markDirty();
  });

  $('#view').addEventListener('click', e => {
    const add = e.target.closest('.add-row');
    if (add) {
      const k = add.dataset.k, n = findTblField(k)?.cols.length || +add.dataset.cols;
      state.docData[k] = state.docData[k] || [];
      state.docData[k].push(Array(n).fill(''));
      state.docData._syncRows[k] = state.docData._syncRows[k] || [];
      state.docData._syncRows[k].push(crypto.randomUUID());
      const tbody = $(`.tbl-edit[data-tbl="${k}"] tbody`);
      const ri = state.docData[k].length - 1;
      const tr = document.createElement('tr');
      tr.innerHTML = Array.from({ length: n }, (_, ci) =>
        `<td>${tableCellHtml(k, ri, ci, '')}</td>`).join('') +
        `<td><button class="x del-row" data-k="${k}" data-r="${ri}">✕</button></td>`;
      tbody.appendChild(tr);
      markDirty();
      return;
    }
    const addCol = e.target.closest('.add-col');
    if (addCol) {
      const k = addCol.dataset.k;
      const f = findTblField(k);
      let n = f.cols.length + 1;
      while (f.cols.includes('新列' + n)) n += 1;
      const name = '新列' + n;
      f.cols.push(name);
      (state.docData[k] || []).forEach(row => row.push(''));
      rebuildTable(k);
      markDirty();
      return;
    }
    const delCol = e.target.closest('.del-col');
    if (delCol) {
      const k = delCol.dataset.k, ci = +delCol.dataset.c;
      const f = findTblField(k);
      if (ci < protectedColumns(f)) { toast('标准关联字段不能删除', 'err'); return; }
      if (f.cols.length <= 1) { toast('至少保留一列', 'err'); return; }
      f.cols.splice(ci, 1);
      (state.docData[k] || []).forEach(row => row.splice(ci, 1));
      rebuildTable(k);
      markDirty();
      return;
    }
    const del = e.target.closest('.del-row');
    if (del) {
      const k = del.dataset.k, r = +del.dataset.r;
      state.docData[k].splice(r, 1);
      state.docData._syncRows[k]?.splice(r, 1);
      // 重建该表
      const wrap = $(`.tbl-edit[data-tbl="${k}"]`);
      const cols = [...wrap.querySelectorAll('thead th')].length - 1;
      const rows = state.docData[k];
      wrap.querySelector('tbody').innerHTML = rows.map((row, ri) =>
        `<tr>${Array.from({ length: cols }, (_, ci) =>
          `<td>${tableCellHtml(k, ri, ci, row[ci])}</td>`).join('')}
          <td><button class="x del-row" data-k="${k}" data-r="${ri}">✕</button></td></tr>`).join('');
      markDirty();
    }
  });

  if ($('#docSave')) $('#docSave').onclick = () => saveDoc(false);
  if ($('#docMsaPlans')) $('#docMsaPlans').onclick = async () => {
    if (dirty && !await saveDoc(true)) return;
    clearTimeout(timer);
    go('msa');
  };
  if ($('#docLinks')) $('#docLinks').onclick = async event => {
    const button = event.target.closest('[data-resolve-link]');
    if (!button) return;
    if (dirty && !await saveDoc(true)) return;
    clearTimeout(timer);
    button.disabled = true;
    try {
      await api('/deliverable-links/' + encodeURIComponent(button.dataset.resolveLink) + '/resolve', {
        method: 'POST', body: { action: button.dataset.linkAction },
      });
      toast(button.dataset.linkAction === 'keep' ? '已保留当前值' : '已采用上游内容', 'ok');
      await vDoc(code);
    } catch (e) { toast(e.message, 'err'); button.disabled = false; }
  };
  if ($('#docSubmit')) $('#docSubmit').onclick = async () => {
    try {
      if (dirty && !await saveDoc(true)) return;
      // A-07：仅“已发布过再修订”时必须填写变更原因；首次提交不强制
      if (d.published_version && !$('#docChangeNote')?.value.trim()) {
        toast('请先填写本次内容变更原因，再提交审核', 'err');
        return;
      }
      clearTimeout(timer);
      await api('/docs/' + encodeURIComponent(code) + '/submit', {
        method: 'POST', body: { note: '提交审核' },
      });
      toast('已提交审核', 'ok');
      vDoc(code);
    } catch (e) { toast(e.message, 'err'); }
  };
  if ($('#docApprove')) $('#docApprove').onclick = async () => {
    if (d.published_version && !$('#docChangeNote')?.value.trim()) {
      toast('请先填写本次内容变更原因，再批准', 'err');
      return;
    }
    // 批准人不再是可填字段：服务端一律取当前登录账号
    const ok = await showConfirmDialog('批准交付物',
      `将以当前登录账号「${state.user?.display_name || ''}」作为批准人，生成受控版本并按关联规则同步下游草稿。`,
      { confirmText: '批准' });
    if (!ok) return;
    try {
      const r = await api('/docs/' + encodeURIComponent(code) + '/approve', {
        method: 'POST', body: { note: '审核批准' },
      });
      toast('已批准，版本 ' + r.version + (r.sync ? '；' + syncSummaryText(r.sync) : ''), 'ok');
      vDoc(code);
    } catch (e) { toast(e.message, 'err'); }
  };
  if ($('#docComplete')) $('#docComplete').onclick = async () => {
    const ok = await showConfirmDialog('标记交付物完成',
      '完成表示该交付物的编制与交付工作已结束；已批准版本继续保留，之后如需修改请发起修订。',
      { confirmText: '标记完成' });
    if (!ok) return;
    try {
      await api('/docs/' + encodeURIComponent(code) + '/complete', { method: 'POST', body: {} });
      toast('已标记完成', 'ok');
      vDoc(code);
    } catch (e) { toast(e.message, 'err'); }
  };
  if ($('#docRevise')) $('#docRevise').onclick = async () => {
    const result = await showFormDialog({
      title: '发起修订',
      description: '原批准版本会继续保留，本次修订将转入草稿。',
      fields: [{ key: 'reason', label: '修订原因', type: 'textarea', value: '根据评审意见修订', required: true }],
      confirmText: '开始修订',
    });
    if (!result) return;
    try {
      await api('/docs/' + encodeURIComponent(code) + '/revise', {
        method: 'POST', body: { reason: result.reason.trim() },
      });
      toast('已转入草稿修订，原批准版本继续保留', 'ok');
      vDoc(code);
    } catch (e) { toast(e.message, 'err'); }
  };
  if ($('#docReject')) $('#docReject').onclick = async () => {
    const result = await showFormDialog({
      title: '退回交付物',
      fields: [{ key: 'reason', label: '退回原因', type: 'textarea', required: true }],
      confirmText: '确认退回',
    });
    if (!result) return;
    try {
      await api('/docs/' + encodeURIComponent(code) + '/reject', {
        method: 'POST', body: { reason: result.reason.trim() },
      });
      toast('已退回', 'ok');
      vDoc(code);
    } catch (e) { toast(e.message, 'err'); }
  };
  $('#docHistory').onclick = () => openDocRevisions(code, d.meta.name);
  // A-04：离开前等待在途保存完成，避免最后一次编辑丢失
  $('#docBack').onclick = async () => { if (dirty) await saveDoc(true); openApqp(); };
  $('#dlDocx').onclick = async () => { if (dirty) await saveDoc(true); downloadDoc(code, 'docx'); };
  $('#dlXlsx').onclick = async () => { if (dirty) await saveDoc(true); downloadDoc(code, 'xlsx'); };
  $('#docStatus').onchange = () => { markDirty(); saveDoc(false); };
  if (docShortcutHandler) document.removeEventListener('keydown', docShortcutHandler);
  docShortcutHandler = function esc(e) {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); saveDoc(false); }
  };
  document.addEventListener('keydown', docShortcutHandler);
  // A-04：视图卸载时清理定时器/监听，并补一次保存（仅当确实有未保存内容）
  docEditorCleanup = () => {
    clearTimeout(timer);
    timer = null;
    document.removeEventListener('keydown', docShortcutHandler);
    docShortcutHandler = null;
    if (dirty) saveDoc(true);
    else docHasUnsaved = false;
  };
}

/**
 * 渲染某一历史版本快照：标量字段 + 表格字段（工程图清单等表格型交付物也能回溯）。
 * 表格按当前 schema 的列名展示，数据取快照本身的 data / cols。
 */
async function openDocSnapshot(code, revId, target) {
  const detail = await api(`/docs/${encodeURIComponent(code)}/revisions/${encodeURIComponent(revId)}`);
  const box = typeof target === 'string' ? $(target) : target;
  if (!box) return;
  const current = await api('/docs/' + encodeURIComponent(code));
  const savedCols = detail.cols || {};
  const sections = (current.sections || []).map(section => ({
    t: section.t,
    scalars: (section.fields || []).filter(field => field.type !== 'table')
      .map(field => ({ label: field.label, value: detail.data?.[field.k] ?? '' }))
      .filter(field => String(field.value).trim() !== ''),
    tables: (section.fields || []).filter(field => field.type === 'table').map(field => {
      const cols = savedCols[field.k] || field.cols || [];
      const rows = Array.isArray(detail.data?.[field.k]) ? detail.data[field.k] : [];
      return { label: field.label, cols, rows };
    }).filter(table => table.rows.some(row => Array.isArray(row)
      && row.some(cell => String(cell ?? '').trim() !== ''))),
  })).filter(section => section.scalars.length || section.tables.length);
  box.innerHTML = `<div class="card"><div class="card-h"><h3>快照 ${esc(detail.revision.version || '')} · ${esc(detail.revision.changed_at || '')}</h3>
    <span class="hint">${esc(detail.revision.change_note || '')}</span></div><div class="card-b">
    ${sections.length ? sections.map(section => `
      <div class="lbl" style="margin:6px 0 4px">${esc(section.t)}</div>
      ${section.scalars.length ? `<div class="kv">${section.scalars.map(field =>
        `<div class="k">${esc(field.label)}</div><div>${esc(String(field.value))}</div>`).join('')}</div>` : ''}
      ${section.tables.map(table => `<div class="dim" style="font-size:11.5px;margin:8px 0 4px">${esc(table.label)}</div>
        <div class="t-scroll"><table class="t"><thead><tr>${table.cols.map(col => `<th>${esc(col)}</th>`).join('')}</tr></thead>
          <tbody>${table.rows.map(row => `<tr>${table.cols.map((_, index) =>
            `<td>${esc(String(row?.[index] ?? ''))}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`).join('')}
    `).join('') : '<div class="dim">该版本无可展示内容</div>'}
  </div></div>`;
}

async function openDocRevisions(code, name) {
  const drawer = $('#drawer');
  try {
    const d = await api('/docs/' + encodeURIComponent(code) + '/revisions');
    $('.drawer-box', drawer).innerHTML = `
      <div class="drawer-h"><div><h2>历史版本</h2><p>${esc(name)} · ${esc(code)} · ${d.list.length} 个保存/审批快照</p></div>
        <button class="x" onclick="document.getElementById('drawer').classList.remove('open')">✕</button></div>
      <div class="drawer-b">
        ${d.list.length ? `<table class="t"><thead><tr><th>时间</th><th>版本</th><th>状态</th><th>变更人</th><th>说明</th><th>批准人</th><th style="width:110px">操作</th></tr></thead><tbody>
          ${d.list.map(r => `<tr><td class="mono">${esc(r.changed_at || '')}</td><td class="mono">${esc(r.version || '')}</td>
            <td>${statusBadge(r.status)}</td><td>${esc(r.changed_by || '')}</td><td>${esc(r.change_note || '')}</td>
            <td>${esc(r.approved_by || '—')}</td>
            <td class="nowrap"><button class="btn sm ghost" data-rev-view="${esc(r.rev_id)}">查看</button>
              <button class="btn sm ghost" data-rev-restore="${esc(r.rev_id)}">恢复</button></td></tr>`).join('')}</tbody></table>
          <div class="dim" style="font-size:11.5px;margin-top:8px">恢复会把该快照写回草稿，并先把当前内容保存为“恢复前”快照，可再次回退。</div>`
          : '<div class="empty">尚无历史版本</div>'}
        <div id="revSnapshot" style="margin-top:14px"></div>
      </div>`;
    drawer.classList.add('open');
    const viewSnapshot = revId => openDocSnapshot(code, revId, '#revSnapshot');
    $$('[data-rev-view]').forEach(button => button.onclick = () => viewSnapshot(button.dataset.revView)
      .catch(error => toast(error.message, 'err')));
    $$('[data-rev-restore]').forEach(button => button.onclick = async () => {
      const ok = await showConfirmDialog('恢复历史版本',
        '恢复会把该快照写回草稿，当前内容会先保存为“恢复前”快照。确认恢复？',
        { confirmText: '确认恢复', danger: true });
      if (!ok) return;
      try {
        await api(`/docs/${encodeURIComponent(code)}/restore/${encodeURIComponent(button.dataset.revRestore)}`, {
          method: 'POST', body: {},
        });
        drawer.classList.remove('open');
        toast('已恢复到所选历史版本（草稿）', 'ok');
        vDoc(code);
      } catch (error) { toast(error.message, 'err'); }
    });
  } catch (e) {
    toast(e.message, 'err');
  }
}

async function openDoc(code) {
  closeRelatedPreview();
  hideQualityLinks();
  if (code === 'P1-10') {
    goPfd('INITIAL');
    return;
  }
  if (state.view === 'doc' && state.docCode === code) return;
  const meta = (state.lastDocs || []).find(x => x.code === code);
  if (meta && meta.tplId) { openTpl(meta.tplId); return; }
  if (!meta) {
    // A-18：不在标准目录中的编号，可能是自定义模板，先按编号找绑定模板再决定入口
    try {
      const bound = await api('/templates/by-code/' + encodeURIComponent(code));
      if (bound?.tpl_id) { openTpl(bound.tpl_id); return; }
    } catch (error) { /* 不是模板编号，继续按标准交付物处理 */ }
  }
  state.docReturnPhase = state.view === 'apqp' ? state.apqpPhase : null;
  state.view = 'doc';
  state.docCode = code;
  setRouteHash('doc/' + code);
  paintNav();
  $('#viewTitle').textContent = 'APQP 交付物';
  $('#view').innerHTML = '<div class="empty">加载中…</div>';
  vDoc(code).catch(e => { $('#view').innerHTML = `<div class="alert bad">${esc(e.message)}</div>`; });
}
function openApqp() {
  const returnPhase = state.docReturnPhase;
  state.docReturnPhase = null;
  state.view = 'apqp';
  if (returnPhase != null) goApqpPhase(returnPhase);
  else {
    location.hash = 'apqp';
    go('apqp');
  }
}

/* ================================================================== 自定义模板 */
const toBase64 = (buf) => {
  const bytes = new Uint8Array(buf);
  let s = '';
  const CH = 8192;
  for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  return btoa(s);
};

function openUpload(preset) {
  preset = preset || {};
  const drawer = $('#drawer');
  const phases = ['入门', '策划与准备', '产品设计与开发', '过程设计与开发', '产品与过程确认', '量产与持续改进'];
  $('.drawer-box', drawer).innerHTML = `
    <div class="drawer-h">
      <div><h2>上传模板</h2><p>支持 .xlsx / .docx。Word 原文件会作为导出版底保留，在线填写后仍按原表格、图片、页眉页脚和字体版式输出。</p></div>
      <button class="x" id="upClose">✕</button>
    </div>
    <div class="drawer-b">
      <div class="field"><label>模板文件</label>
        <input type="file" id="upFile" accept=".xlsx,.docx">
        <div class="dim" style="font-size:11.5px;margin-top:4px">仅支持 Office Open XML（.xlsx / .docx）；旧版 .xls / .doc 请先另存为新格式。</div>
      </div>
      <div class="row2">
        <div class="field"><label>模板名称</label><input id="upName" value="${esc(preset.name || '')}" placeholder="留空则取文件名"></div>
        <div class="field"><label>归属阶段</label>
          <select id="upPhase">${phases.map((p, i) => `<option value="${i}" ${i === 1 ? 'selected' : ''}>P${i} · ${p}</option>`).join('')}</select>
        </div>
      </div>
      <div class="alert info" style="display:block">
        <b>解析规则</b>
        <div style="margin-top:6px;line-height:1.7">
          · 合并单元格会保留，标题行识别为表头<br>
          · 连续多行且首行为短文本 → 识别为「表格」，表头列自动生成列说明<br>
          · 左侧标签 + 右侧空单元格 → 识别为「字段」，按标签语义生成填写说明<br>
          · 空白单元格即待填写项，说明会作为输入提示显示
          <br>· Word 下载采用“原 DOCX 包内覆盖字段值”，不会重新生成一套版式
        </div>
      </div>
      <button class="btn" id="upSubmit">上传并解析</button>
      <div id="upResult" style="margin-top:14px"></div>
    </div>`;
  drawer.classList.add('open');
  if (preset && preset.phase !== undefined) {
    const sp = document.getElementById('upPhase');
    if (sp) sp.value = String(preset.phase);
  }
  $('#upClose').onclick = () => drawer.classList.remove('open');

  $('#upSubmit').onclick = async () => {
    const f = $('#upFile').files[0];
    if (!f) return toast('请先选择文件', 'err');
    if (!/\.(xlsx|docx)$/i.test(f.name)) return toast('仅支持 .xlsx / .docx', 'err');
    const box = $('#upResult');
    box.innerHTML = '<div class="alert info">正在解析…</div>';
    try {
      const buf = await f.arrayBuffer();
      const body = {
        name: $('#upName').value.trim() || f.name.replace(/\.[^.]+$/, ''),
        phase: +$('#upPhase').value,
        filename: f.name,
        dataBase64: toBase64(buf),
        doc_code: preset.docCode || null,
      };
      const r = await api('/templates', { method: 'POST', body });
      const warnings = Array.isArray(r.warnings) ? r.warnings : [];
      box.innerHTML = `<div class="alert info"><b>解析成功，原文件已保留</b>
        <div style="margin-top:4px">来源 ${r.source.toUpperCase()}　｜　`
        + (r.source === 'xlsx'
          ? `表格 ${r.stats.tables} 个　字段 ${r.stats.fields} 个　范围 ${r.stats.rows} 行 × ${r.stats.cols} 列`
          : `段落 ${r.stats.blocks} 块　表格 ${r.stats.tables} 个`)
        + `</div></div>`
        + (warnings.length ? `<div class="alert warn" style="margin-top:8px"><b>解析提示</b><br>
          ${warnings.map(item => esc(item)).join('<br>')}</div>` : '');
      toast('已转换为可编辑模板，Word 原版式将在下载时保留', 'ok');
      setTimeout(() => {
        closeDrawer();
        if (preset.ppapNo) openPpapEvidence(preset.ppapNo);
        else openTpl(r.tpl_id);
      }, 900);
    } catch (e) {
      box.innerHTML = `<div class="alert bad">${esc(e.message)}</div>`;
    }
  };
}
function closeDrawer() { $('#drawer').classList.remove('open'); }

function openTpl(id, returnPpapNo) {
  closeRelatedPreview();
  hideQualityLinks();
  if (state.view === 'tpl' && state.tplId === id) return;
  state.tplReturnPpap = returnPpapNo || null;
  state.view = 'tpl';
  state.tplId = id;
  setRouteHash('tpl/' + id);
  paintNav();
  $('#viewTitle').textContent = 'APQP 交付物';
  $('#view').innerHTML = '<div class="empty">加载中…</div>';
  vTpl(id).catch(e => { $('#view').innerHTML = `<div class="alert bad">${esc(e.message)}</div>`; });
}

async function vTpl(id) {
  resetPersistentView();
  const d = await api('/templates/' + id);
  const s = d.schema;
  window.__tplSchema = s;
  window.__tplId = id;
  state.tplSchema = s;
  const meta = d.meta;

  const insPanel = (s.instructions || []).map(g => `
    <div class="insg">
      <div class="insg-h">${esc(g.scope)}</div>
      <ul>${g.items.map(t => `<li>${esc(t)}</li>`).join('')}</ul>
    </div>`).join('') || '<div class="empty" style="padding:18px">未识别到需要说明的列</div>';

  const gridHtml = (() => {
    if (s.kind !== 'grid') return '';
    const widths = s.cols.map(c => Math.max(60, (c.w || 14) * 7.2));
    return `<table class="xgrid"><colgroup>${widths.map(w => `<col style="width:${w}px">`).join('')}</colgroup><tbody>
      ${s.rows.map((row, ri) => `<tr>${row.map((c, ci) => {
        if (!c || c.covered) return '';
        const span = (c.cs > 1 ? ` colspan="${c.cs}"` : '') + (c.rs > 1 ? ` rowspan="${c.rs}"` : '');
        const cls = c.header ? 'xh' : c.label ? 'xl' : (c.input || !c.header) ? 'xc' : 'xc';
        return `<td${span} class="${cls}"><input data-r="${ri}" data-c="${ci}"
          class="${c.header ? 'hdr' : ''}" value="${esc(c.v || '')}"
          placeholder="${esc(c.hint || '')}" title="${esc(c.hint || '')}"></td>`;
      }).join('')}</tr>`).join('')}
    </tbody></table>`;
  })();

  const docHtml = (() => {
    if (s.kind !== 'doc') return '';
    return `<div class="blockdoc">${s.blocks.map((b, bi) => {
      if (b.type === 'text') {
        const head = b.text.length <= 20 && !/[。；，]/.test(b.text);
        return `<div class="${head ? 'bd-h' : 'bd-p'}">${esc(b.text)}</div>`;
      }
      if (b.type === 'field') {
        return `<div class="bd-f"><label>${esc(b.label)}</label>
          <input data-b="${bi}" value="${esc(b.value || '')}" placeholder="${esc(b.hint || '')}" title="${esc(b.hint || '')}"></div>`;
      }
      return `<div class="bd-tbl"><table class="xgrid"><thead><tr>${b.cols.map(c =>
        `<th title="${esc(c.hint || '')}"><input class="xcol" data-t="${bi}" data-ci="${b.cols.indexOf(c)}" value="${esc(c.label)}"></th>`).join('')}</tr></thead>
        <tbody>${b.rows.map((r, ri) => `<tr>${b.cols.map((c, ci) =>
          `<td class="xc"><input data-t="${bi}" data-r="${ri}" data-c="${ci}" value="${esc(r[ci] || '')}"
             placeholder="${esc(c.hint || '')}"></td>`).join('')}</tr>`).join('')}</tbody></table>
        <div style="display:flex;gap:8px;margin-top:6px">
          <button class="btn sm ghost add-trow" data-t="${bi}">＋ 加行</button>
          <button class="btn sm ghost add-tcol" data-t="${bi}">＋ 加列</button>
          <button class="btn sm ghost del-trow" data-t="${bi}">－ 删末行</button>
        </div></div>`;
    }).join('')}</div>`;
  })();

  $('#viewSub').textContent = `${meta.source.toUpperCase()} 解析 · ${meta.filename || '未命名'} · 状态 ${meta.status}`;

  $('#view').innerHTML = `
    <div class="docbar">
      <div>
        <div class="lbl">${esc(meta.tpl_id)} · P${meta.phase} · 自定义模板</div>
        <h2 style="margin:2px 0 0;font-size:19px">${esc(meta.name)}</h2>
      </div>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        ${statusBadge(meta.status)}
        <button class="btn ghost" id="tplSide">说明</button>
        ${s.kind === 'grid' ? '<button class="btn ghost" id="tplMapping">字段映射</button>' : ''}
        ${s.kind === 'grid' ? '<button class="btn ghost" id="tplApply">按业务数据填充</button>' : ''}
        <button class="btn ghost" id="tplBack">返回清单</button>
        <button class="btn ghost" id="tplDownload">下载 ${s.kind === 'grid' ? 'Excel' : 'Word'}</button>
        <button class="btn ghost" id="tplDelete" style="color:#B91C1C;border-color:#F3C9C9">删除</button>
        ${['草稿', '未开始', '已退回'].includes(meta.status) ? '<button class="btn ghost" id="tplSubmit">提交审核</button>' : ''}
        ${meta.status === '待审核' ? '<button class="btn" id="tplApprove">批准</button><button class="btn ghost" id="tplReject">退回</button>' : ''}
        <button class="btn" id="tplSave">保存</button>
      </div>
    </div>
    ${meta.doc_code
      ? `<div class="alert ${meta.status === '已批准' ? 'info' : 'warn'}" style="margin-bottom:10px">已绑定交付物 <b>${esc(meta.doc_code)}</b>；模板审批与交付物状态同步，审批通过后该交付物才计入完成度。</div>`
      : ''}
    <div class="tplwrap">
      <div class="tplmain">
        ${meta.source === 'docx' && meta.source_path ? '<div class="alert info" style="margin-bottom:12px"><div><b>原版 Word 已保留</b><br>这里只统一在线填写界面的视觉样式；下载时会读取上传的原始 DOCX，仅替换字段和表格数据，保留图片、页眉页脚、合并单元格、边框与字体。</div></div>' : ''}
        <div class="sec tpl-doc-surface">
          <div class="tpl-sec-head">
            <h3>模板内容</h3>
            <span class="hint">在线表单采用统一视觉；Word 导出版以原模板为底稿</span>
          </div>
          <div class="tpl-doc-body">
            ${s.kind === 'grid' ? gridHtml : docHtml}
          </div>
        </div>
        <div class="docfoot">
          <span id="saveState" class="dim">已保存</span>
          <span class="dim">空白单元格为待填写项；输入框的灰色提示即该列的填写说明。</span>
        </div>
      </div>
      <aside class="tlpside">
        <div class="card">
          <div class="card-h"><h3>填写说明</h3><span class="hint">按内容自动生成</span></div>
          <div class="card-b" style="padding:10px 12px">
            ${insPanel}
          </div>
        </div>
      </aside>
    </div>`;

  let dirty = false, timer = null;
  const mark = () => {
    dirty = true; clearTimeout(timer);
    const el = $('#saveState');
    if (el) { el.textContent = '未保存…'; el.className = 'dim'; }
    timer = setTimeout(() => save(true), 1500);
  };
  const save = async (auto) => {
    try {
      const r = await api('/templates/' + id, { method: 'PUT', body: { schema: state.tplSchema } });
      dirty = false;
      const el = $('#saveState');
      if (el) { el.textContent = `已保存（完成度 ${r.pct}%）· ${new Date().toLocaleTimeString('zh-CN')}`; el.className = 'ok'; }
      if (!auto) toast('已保存，完成度 ' + r.pct + '%', 'ok');
    } catch (e) { toast(e.message, 'err'); }
  };

  $('#view').addEventListener('input', e => {
    const el = e.target;
    if (el.dataset.r !== undefined && el.dataset.t === undefined && el.dataset.c !== undefined) {
      const r = +el.dataset.r, c = +el.dataset.c;
      if (state.tplSchema.rows[r] && state.tplSchema.rows[r][c]) {
        state.tplSchema.rows[r][c].v = el.value;
        mark();
      }
    } else if (el.dataset.t !== undefined) {
      const b = +el.dataset.t, r = +el.dataset.r, c = +el.dataset.c;
      const blk = state.tplSchema.blocks[b];
      if (blk && blk.rows[r]) { blk.rows[r][c] = el.value; mark(); }
    } else if (el.dataset.b !== undefined) {
      const blk = state.tplSchema.blocks[+el.dataset.b];
      if (blk) { blk.value = el.value; mark(); }
    }
  });

  document.getElementById('view').addEventListener('change', async (e) => {
    const el = e.target.closest('.xcol');
    if (!el) return;
    const bi = +el.dataset.t, ci = +el.dataset.ci;
    const b = (window.__tplSchema && window.__tplSchema.blocks) ? window.__tplSchema.blocks[bi] : null;
    if (!b || !b.cols[ci]) return;
    b.cols[ci].label = el.value.trim() || ('列' + (ci + 1));
    try {
      await api('/templates/' + encodeURIComponent(window.__tplId), { method: 'PUT', body: { schema: window.__tplSchema } });
      toast('列名已保存', 'ok');
    } catch (err) { toast(err.message, 'err'); }
  });

  document.getElementById('view').addEventListener('click', async (e) => {
    const arow = e.target.closest('.add-trow');
    const acol = e.target.closest('.add-tcol');
    const drow = e.target.closest('.del-trow');
    if (!arow && !acol && !drow) return;
    const bi = +((arow || acol || drow).dataset.t);
    const b = (window.__tplSchema && window.__tplSchema.blocks) ? window.__tplSchema.blocks[bi] : null;
    if (!b) return;
    if (arow) b.rows.push(Array(b.cols.length).fill(''));
    if (acol) {
      let mn = b.cols.length + 1;
      while (b.cols.some(function (x) { return x.label === '新列' + mn; })) mn += 1;
      b.cols.push({ label: '新列' + mn, hint: '' });
      b.rows.forEach(function (r) { r.push(''); });
    }
    if (drow) {
      if (b.rows.length <= 1) return toast('至少保留一行', 'err');
      b.rows.pop();
    }
    try {
      await api('/templates/' + encodeURIComponent(window.__tplId), { method: 'PUT', body: { schema: window.__tplSchema } });
      vTpl(window.__tplId);
    } catch (err) { toast(err.message, 'err'); }
  });

  $('#tplSave').onclick = () => save(false);
  if ($('#tplMapping')) $('#tplMapping').onclick = async () => {
    if (s.kind !== 'grid') return toast('当前仅支持 XLSX 网格模板字段映射', 'err');
    const existing = (() => { try { return JSON.parse(meta.mapping_json || '[]'); } catch (e) { return []; } })();
    const sample = [{ r: 1, c: 1, path: 'project.name' }, { r: 1, c: 2, path: 'project.part_no' }];
    const result = await showFormDialog({
      title: '配置模板字段映射',
      description: 'r / c 从 1 开始；path 可使用 project.name、doc.version、fmea.high、cp.stage。保存后由当前登录的质量角色批准并写入审计。',
      fields: [
        {
          key: 'mapping_text', label: '映射 JSON', type: 'textarea', rows: 10, required: true,
          value: JSON.stringify(existing.length ? existing : sample, null, 2),
        },
      ],
      confirmText: '保存并批准',
      validate: values => {
        try { JSON.parse(values.mapping_text); return ''; } catch (e) { return 'JSON 格式无效，请检查括号、引号和逗号。'; }
      },
    });
    if (!result) return;
    const mapping = JSON.parse(result.mapping_text);
    try {
      await api('/templates/' + encodeURIComponent(id) + '/mapping', {
        method: 'PATCH', body: { mapping, note: '模板字段映射配置' },
      });
      toast('字段映射已批准', 'ok');
      vTpl(id);
    } catch (e) { toast(e.message, 'err'); }
  };
  if ($('#tplApply')) $('#tplApply').onclick = async () => {
    try {
      const applyOnce = extra => api('/templates/' + encodeURIComponent(id) + '/apply', {
        method: 'POST', body: { doc_code: meta.doc_code, ...extra },
      });
      let r;
      try {
        r = await applyOnce({});
      } catch (e) {
        // A-13：覆盖已填写内容前列出差异并确认
        if (e.status !== 409 || !e.details?.changes) throw e;
        const list = e.details.changes.filter(change => change.from !== '')
          .slice(0, 8).map(change => `R${change.r}C${change.c}：${change.from || '空'} → ${change.to}`).join('\n');
        const ok = await showConfirmDialog('确认覆盖已填写内容',
          `${e.message}\n\n${list}${e.details.changes.length > 8 ? '\n…' : ''}`,
          { confirmText: '确认覆盖' });
        if (!ok) return;
        r = await applyOnce({ confirm_overwrite: true });
      }
      toast('已按业务数据填充，完成度 ' + r.pct + '%', 'ok');
      vTpl(id);
    } catch (e) { toast(e.message, 'err'); }
  };
  $('#tplSide').onclick = () => {
    const w = $('.tplwrap');
    w.classList.toggle('hide-side');
    $('#tplSide').classList.toggle('on');
  };
  $('#tplBack').onclick = () => {
    if (dirty) save(true);
    if (state.tplReturnPpap) {
      const no = state.tplReturnPpap;
      state.tplReturnPpap = null;
      openPpapEvidence(no);
    } else openApqp();
  };
  $('#tplDownload').onclick = async () => {
    if (dirty) await save(true);
    try {
      await downloadBlob(`/api/templates/${encodeURIComponent(id)}/export?fmt=${s.kind === 'grid' ? 'xlsx' : 'docx'}`,
        `${meta.name || id}.${s.kind === 'grid' ? 'xlsx' : 'docx'}`);
    } catch (error) { toast(error.message, 'err'); }
  };
  if ($('#tplSubmit')) $('#tplSubmit').onclick = async () => {
    if (dirty) await save(true);
    try {
      await api('/templates/' + encodeURIComponent(id) + '/submit', { method: 'POST', body: {} });
      toast('模板已提交审核；绑定交付物同步进入待审核', 'ok');
      vTpl(id);
    } catch (error) { toast(error.message, 'err'); }
  };
  if ($('#tplApprove')) $('#tplApprove').onclick = async () => {
    const ok = await showConfirmDialog('批准模板', '批准后模板及其绑定交付物都会进入已批准状态，并生成交付物新版本。', {
      confirmText: '确认批准',
    });
    if (!ok) return;
    try {
      await api('/templates/' + encodeURIComponent(id) + '/approve', { method: 'POST', body: {} });
      toast('模板与交付物已批准', 'ok');
      vTpl(id);
    } catch (error) { toast(error.message, 'err'); }
  };
  if ($('#tplReject')) $('#tplReject').onclick = async () => {
    const result = await showFormDialog({
      title: '退回模板',
      fields: [{ key: 'reason', label: '退回原因', type: 'textarea', rows: 3, required: true }],
      confirmText: '确认退回', danger: true,
    });
    if (!result) return;
    try {
      await api('/templates/' + encodeURIComponent(id) + '/reject', {
        method: 'POST', body: { reason: result.reason.trim() },
      });
      toast('模板已退回草稿', 'ok');
      vTpl(id);
    } catch (error) { toast(error.message, 'err'); }
  };
  $('#tplDelete').onclick = async () => {
    if (!await showConfirmDialog('删除模板', '删除后不可恢复，确认删除该模板？', {
      confirmText: '删除模板', danger: true,
    })) return;
    await api('/templates/' + id, { method: 'DELETE' });
    toast('已删除');
    openApqp();
  };
}


/* ------------------------------------------------------------------ 特性穿透 */
async function vChars() {
  const list = await api('/chars');
  $('#viewSub').textContent = '特性穿透 = 顺着“产品特性 → 过程特性 → 工序 → CP 行 → SPC 监控 / MSA 研究”一路往下看：'
    + '左边选一个特性，右边就是它在各环节的落点与缺口（红字表示该环节还没覆盖）。';
  if (!state.charId) state.charId = list.find(c => c.char_kind === 'PRODUCT')?.char_id;

  $('#view').innerHTML = `
    <div class="grid" style="grid-template-columns:300px 1fr;gap:14px">
      <div class="card" style="align-self:start">
        <div class="card-h"><h3>特性主数据</h3><span class="hint">${list.length} 条
          <button class="btn sm ghost" id="btnCharLinks" style="margin-left:6px">维护关联</button></span></div>
        <div style="max-height:640px;overflow:auto;padding:6px">
          ${list.map(c => `<div class="nav-item ${state.charId === c.char_id ? 'on' : ''}" data-char="${c.char_id}"
             style="background:${state.charId === c.char_id ? '' : 'transparent'};color:${state.charId === c.char_id ? '#fff' : 'var(--ink)'}">
             <span class="dot"></span>
             <span style="flex:1;min-width:0"><b style="font-size:12px">${esc(c.name)}</b>
             <span class="mono" style="display:block;color:${state.charId === c.char_id ? '#DCE8FB' : 'var(--ink3)'};font-size:10.5px">${c.char_id}</span></span>
             ${specBadge(c.is_special, c.special_symbol)}</div>`).join('')}
        </div>
      </div>
      <div id="charDetail"><div class="empty">选择左侧特性查看穿透链</div></div>
    </div>`;

  $$('[data-char]').forEach(el => el.onclick = () => { state.charId = el.dataset.char; vChars(); });
  $('#btnCharLinks').onclick = () => openCharLinks(state.charId);
  if (state.charId) renderCharDetail(state.charId);
}

async function renderCharDetail(id) {
  const d = await api('/chars/' + encodeURIComponent(id));
  const c = d.char;
  const isProduct = c.char_kind === 'PRODUCT';
  const spec = c.lsl != null && c.usl != null ? `${c.lsl} – ${c.usl} ${c.unit || ''}` : (c.tol_text || '—');
  const relatedChars = isProduct
    ? d.down.map(link => ({ id: link.process_char_id, name: link.pname, link }))
    : [{ id: c.char_id, name: c.name, link: null }];
  const traceBranches = relatedChars.map(processChar => {
    const projectCharIds = new Set(d.projectChars
      .filter(item => item.char_id === processChar.id)
      .map(item => item.pchar_id));
    const fmeaRows = d.fmeaRows.filter(row =>
      row.process_char_id === processChar.id || row.char_id === processChar.id
    );
    const cpRows = d.cpRows.filter(row =>
      row.char_id === processChar.id || projectCharIds.has(row.project_char_id)
    );
    const cpIds = new Set(cpRows.map(row => row.cp_row_id));
    const monitors = d.mons.filter(item => cpIds.has(item.cp_row_id));
    const msa = d.msaPlans.filter(item =>
      item.char_id === processChar.id || projectCharIds.has(item.project_char_id)
    );
    return `<div class="char-trace-branch">
      <div class="char-trace-cell">
        <span class="char-trace-label">${isProduct ? '设计特性' : '上游设计特性'}</span>
        ${isProduct
          ? `<b>${esc(c.name)}</b><small class="mono">${esc(c.char_id)}</small>`
          : d.up.length
            ? d.up.map(link => `<b>${esc(link.pname)}</b><small class="mono">${esc(link.product_char_id)}</small>
              <small>规格 ${esc(link.lsl != null && link.usl != null ? `${link.lsl} – ${link.usl} ${link.punit || ''}` : link.tol_text || '—')}</small>`).join('')
            : '<span class="char-trace-gap">未关联上游设计特性</span>'}
        ${isProduct ? `<small>规格 ${esc(spec)}</small>` : ''}
      </div>
      <div class="char-trace-cell process">
        <span class="char-trace-label">过程特性</span>
        <b>${esc(processChar.name)}</b><small class="mono">${esc(processChar.id)}</small>
        ${processChar.link ? `<small>${esc(processChar.link.mechanism)}</small>
          <small>关联：${esc(processChar.link.direction)} · ${esc(processChar.link.strength)} · 证据 ${esc(processChar.link.evidence_ref || '未填写')}</small>` : ''}
      </div>
      <div class="char-trace-cell">
        <span class="char-trace-label">PFMEA</span>
        ${fmeaRows.length ? fmeaRows.map(row => `<div class="char-trace-item">
          <b>${esc(row.failure_mode || '失效模式未命名')}</b>
          <small>${esc(row.step_no || '')} ${esc(row.step_name || '')} · AP ${esc(row.ap || '—')} · S/O/D ${row.s ?? '—'}/${row.o ?? '—'}/${row.d ?? '—'}</small>
        </div>`).join('') : '<span class="char-trace-gap">未关联 PFMEA 行</span>'}
      </div>
      <div class="char-trace-cell">
        <span class="char-trace-label">控制计划与测量</span>
        ${cpRows.length ? cpRows.map(row => {
          const monitor = monitors.find(item => item.cp_row_id === row.cp_row_id);
          const plan = msa.find(item => item.char_id === row.char_id || item.project_char_id === row.project_char_id);
          const linkedFmea = fmeaRows.some(item => item.row_id === row.fmea_row_id);
          return `<div class="char-trace-item">
            <b>${esc(row.step_no || '')} ${esc(row.sname || '')} · CP ${esc(row.cp_row_id)}</b>
            <small>规格 ${esc(row.spec_text || '未填写')} · 样本/频率 ${row.sample_size || '—'} / ${row.freq_value || '—'} ${esc(row.freq_unit || '')}</small>
            <small>PFMEA ${linkedFmea ? '已关联' : '未关联'} · SPC ${monitor ? `${esc(monitor.mon_id)} · ${esc(monitor.approval_status || monitor.status || '已建立')}` : '未建立'}</small>
            <small>MSA ${plan ? esc(plan.study_id ? (plan.judgment || plan.status || '已计算') : (plan.status || '计划中')) : '未建立'}</small>
          </div>`;
        }).join('') : '<span class="char-trace-gap">未关联控制计划</span>'}
        ${!cpRows.length && msa.length ? `<small class="char-trace-orphan">另有 MSA 计划 ${msa.length} 项，尚未连到控制计划行</small>` : ''}
      </div>
    </div>`;
  }).join('');
  const designRows = d.fmeaRows.filter(row => row.char_id === c.char_id && row.fmea_type === 'DFMEA');
  const chain = `<div class="char-trace">
    <div class="char-trace-intro">穿透 = 沿着真实关联检查：设计要求如何落到过程参数，再由风险分析和控制/测量证据承接。虚线缺口代表当前项目没有对应记录，不代表系统已自动补齐。</div>
    ${designRows.length ? `<div class="char-trace-design-fmea"><b>DFMEA 设计风险</b>${designRows.map(row =>
      `<span>${esc(row.failure_mode || '失效模式未命名')} · AP ${esc(row.ap || '—')}</span>`).join('')}</div>` : ''}
    <div class="char-trace-head"><span>设计特性</span><span>过程特性 / 传递机理</span><span>PFMEA 风险行</span><span>控制计划 / SPC / MSA</span></div>
    ${traceBranches || `<div class="char-trace-empty">尚未建立产品特性到过程特性的关联。先维护关联，系统才会显示下游链路。</div>`}
  </div>`;

  $('#charDetail').innerHTML = `
    <div class="card" style="margin-bottom:14px">
      <div class="card-h"><h3>${esc(c.name)} <span class="mono" style="font-weight:400">${c.char_id}</span></h3>
        <span class="hint">${isProduct ? '产品特性' : '过程特性'} · ${specBadge(c.is_special, c.special_symbol)}</span></div>
      <div class="card-b" style="display:grid;grid-template-columns:repeat(5,1fr);gap:14px">
        <div><div class="lbl">单位</div><div class="val">${esc(c.unit || '—')}</div></div>
        <div><div class="lbl">目标值</div><div class="val">${c.target ?? '—'}</div></div>
        <div><div class="lbl">规格上下限</div><div class="val">${c.lsl ?? '—'} / ${c.usl ?? '—'}</div></div>
        <div><div class="lbl">来源</div><div class="val">${esc(c.source_type)}</div></div>
        <div><div class="lbl">关联数（下游 / 上游）</div><div class="val">${d.down.length} / ${d.up.length}</div></div>
      </div>
    </div>
    <div class="card">
      <div class="card-h"><h3>特性穿透路径</h3><span class="hint">只展示当前项目已关联的记录与缺口</span></div>
      <div class="card-b">${chain}</div>
    </div>`;
}

async function openCharLinks(defaultProductId) {
  // D-07 / S-02：关联维护只针对当前项目已引入的特性，与列表的项目过滤保持一致
  const [projectChars, links] = await Promise.all([api('/project-chars'), api('/char-links')]);
  const chars = projectChars.items || [];
  const products = chars.filter(c => c.char_kind === 'PRODUCT');
  const processes = chars.filter(c => c.char_kind === 'PROCESS');
  const drawer = $('#drawer');
  $('.drawer-box', drawer).innerHTML = `
    <div class="drawer-h"><div><h2>特性关联维护</h2><p>质量角色维护产品特性与过程特性的 M:N 关系；关联作废后保留历史。</p></div>
      <button class="x" onclick="document.getElementById('drawer').classList.remove('open')">✕</button></div>
    <div class="drawer-b">
      <div class="card" style="margin-bottom:12px"><div class="card-h"><h3>新增关联</h3></div><div class="card-b">
        <div class="row2">
          <div class="field"><label>产品特性</label><select id="clProduct">${products.map(c =>
            `<option value="${c.char_id}" ${c.char_id === defaultProductId ? 'selected' : ''}>${esc(c.char_id)} ${esc(c.name)}</option>`).join('')}</select></div>
          <div class="field"><label>过程特性</label><select id="clProcess">${processes.map(c =>
            `<option value="${c.char_id}">${esc(c.char_id)} ${esc(c.name)}</option>`).join('')}</select></div>
        </div>
        <div class="row3">
          <div class="field"><label>方向</label><select id="clDirection"><option>正相关</option><option>负相关</option><option>非线性</option><option>阈值型</option></select></div>
          <div class="field"><label>强度</label><select id="clStrength"><option>强</option><option selected>中</option><option>弱</option></select></div>
          <div class="field"><label>证据引用</label><input id="clEvidence" placeholder="DOE / 试验报告编号"></div>
        </div>
        <div class="field"><label>传递机理 <span style="color:#B91C1C">*</span></label><textarea id="clMechanism" rows="2" placeholder="一句话说明该过程特性如何影响产品特性"></textarea></div>
        <button class="btn" id="clAdd">添加关联</button>
      </div></div>
      <div class="card"><div class="card-h"><h3>现有有效关联</h3><span class="hint">${links.list.length} 条</span></div>
        <table class="t"><thead><tr><th>产品特性</th><th>过程特性</th><th>方向</th><th>强度</th><th>机理</th><th>证据</th><th>操作</th></tr></thead><tbody>
          ${links.list.map(link => `<tr><td>${esc(link.product_name)}<div class="mono dim">${esc(link.product_char_id)}</div></td>
            <td>${esc(link.process_name)}<div class="mono dim">${esc(link.process_char_id)}</div></td>
            <td>${esc(link.direction)}</td><td>${esc(link.strength)}</td><td>${esc(link.mechanism)}</td>
            <td>${esc(link.evidence_ref || '—')}</td>
            <td><button class="btn sm ghost" data-edit-link="${link.link_id}">编辑</button>
              <button class="btn sm ghost" data-del-link="${link.link_id}" style="color:#B91C1C">作废</button></td></tr>`).join('') || '<tr><td colspan="7" class="dim">暂无有效关联</td></tr>'}
        </tbody></table>
      </div>
    </div>`;
  drawer.classList.add('open');
  $('#clAdd').onclick = async () => {
    try {
      await api('/char-links', { method: 'POST', body: {
        product_char_id: $('#clProduct').value,
        process_char_id: $('#clProcess').value,
        direction: $('#clDirection').value,
        strength: $('#clStrength').value,
        evidence_ref: $('#clEvidence').value,
        mechanism: $('#clMechanism').value,
      } });
      toast('关联已新增', 'ok');
      openCharLinks($('#clProduct').value);
    } catch (e) { toast(e.message, 'err'); }
  };
  $$('[data-del-link]').forEach(btn => btn.onclick = async () => {
    if (!await showConfirmDialog('作废特性关联', '作废后不再参与穿透和影响分析，确认继续？', {
      confirmText: '确认作废', danger: true,
    })) return;
    await api('/char-links/' + btn.dataset.delLink, { method: 'DELETE' });
    toast('已作废');
    openCharLinks(defaultProductId);
  });
  $$('[data-edit-link]').forEach(btn => btn.onclick = async () => {
    const link = links.list.find(item => String(item.link_id) === btn.dataset.editLink);
    if (!link) return;
    const result = await showFormDialog({
      title: '编辑特性关联',
      fields: [
        { key: 'mechanism', label: '传递机理', type: 'textarea', rows: 3, value: link.mechanism || '' },
        { key: 'evidence_ref', label: '证据引用', value: link.evidence_ref || '', placeholder: '例如：验证报告编号或文件名称' },
      ],
      confirmText: '保存',
    });
    if (!result) return;
    try {
      await api('/char-links/' + link.link_id, { method: 'PATCH', body: {
        mechanism: result.mechanism, evidence_ref: result.evidence_ref,
      } });
      toast('关联已更新', 'ok');
      openCharLinks(defaultProductId);
    } catch (e) { toast(e.message, 'err'); }
  });
}

/* ------------------------------------------------------------------ FMEA */
async function vFmea() {
  await vFmeaContent();
  await mountQualityToolLinks('fmea');
}

async function vFmeaContent() {
  const d = await api('/fmea?type=' + state.fmeaType);
  // F-02：AP 矩阵以后端下发表为准
  state.apMatrix = new Map((d.apMatrix || []).map(item => [`${item.s}-${item.o}-${item.d}`, item.ap]));
  const isD = d.header.fmea_type === 'DFMEA';
  const reviseFmea = async () => {
    const result = await showFormDialog({
      title: `修订 ${state.fmeaType}`,
      description: '原发布版本会继续保留，本次修订将转入草稿。',
      fields: [{ key: 'reason', label: '修订原因', type: 'textarea', value: '根据评审或变更要求修订', required: true }],
      confirmText: '开始修订',
    });
    if (!result) return;
    try {
      await api('/fmea/revise', {
        method: 'POST', body: { fmea_type: state.fmeaType, reason: result.reason.trim() },
      });
      toast('FMEA 已转入草稿修订，原发布版本保留', 'ok');
      vFmea();
    } catch (e) { toast(e.message, 'err'); }
  };
  const publishFmea = async () => {
    const result = await showConfirmDialog('发布 ' + state.fmeaType,
      '发布后将以新版本受控，并向下游提供已确认的分析结果。发布人取当前登录账号并写入审计。',
      { confirmText: '确认发布' });
    if (!result) return;
    try {
      const published = await api('/fmea/publish', {
        method: 'POST',
        body: { fmea_type: state.fmeaType },
      });
      toast('FMEA 已发布，版本 ' + published.rev, 'ok');
      vFmea();
    } catch (e) { toast(e.message, 'err'); }
  };
  $('#viewSub').textContent = `${d.header.title} · 版本 ${d.header.rev} · AP 矩阵 ${d.header.ap_ver} · 一行 = 一个 (失效影响, 失效模式, 失效原因)`;

  if (state.fmeaView === 'tree') {
    const structs = d.nodes.filter(node => node.node_type === 'STRUCTURE')
      .sort((a, b) => (a.seq || 0) - (b.seq || 0));
    const childrenOf = id => structs.filter(node => (node.parent_id || null) === id);
    const roots = childrenOf(null);
    const rowsByNode = new Map();
    const funcsByNode = new Map();
    for (const row of d.rows) {
      const key = row.focus_node_id || '__none';
      if (!rowsByNode.has(key)) rowsByNode.set(key, []);
      rowsByNode.get(key).push(row);
    }
    for (const func of d.functions || []) {
      if (!funcsByNode.has(func.node_id)) funcsByNode.set(func.node_id, []);
      funcsByNode.get(func.node_id).push(func);
    }
    let selected = structs.find(node => node.node_id === state.fmeaSelectedNode);
    if (!selected) {
      selected = structs.find(node => (rowsByNode.get(node.node_id) || []).length)
        || structs.find(node => childrenOf(node.node_id).length === 0)
        || structs[0] || null;
    }
    state.fmeaSelectedNode = selected?.node_id || null;
    const rowCount = node => (rowsByNode.get(node.node_id) || []).length;
    const funcList = node => funcsByNode.get(node.node_id) || [];
    const formalList = node => funcList(node).filter(func => func.status === '正式');
    const candidateList = node => funcList(node).filter(func => func.status === '候选');
    const highCount = node => (rowsByNode.get(node.node_id) || []).filter(row => row.ap === 'H').length;
    const collapsed = state.fmeaCollapsed || (state.fmeaCollapsed = new Set());
    const renderTreeNode = (node, depth) => {
      const children = childrenOf(node.node_id);
      const isCollapsed = collapsed.has(node.node_id);
      const formal = formalList(node);
      const candidates = candidateList(node);
      return `<div class="fmea-tree-branch" data-tree-branch data-node-id="${esc(node.node_id)}">
        <div class="fmea-tree-node ${selected?.node_id === node.node_id ? 'active' : ''}" data-fmea-select="${esc(node.node_id)}" style="--depth:${depth}">
          <button class="fmea-tree-toggle" data-fmea-toggle="${esc(node.node_id)}" ${children.length ? '' : 'disabled'}>${children.length ? (isCollapsed ? '▸' : '▾') : '·'}</button>
          <div class="fmea-tree-node-main"><b>${esc(node.name)}</b>
            <small>${esc(node.desc || (isD ? '产品结构节点' : '过程结构节点'))}</small></div>
          <div class="fmea-tree-node-badges">
            ${formal.length ? `<span class="badge b-ok">${formal.length} 功能</span>` : '<span class="badge b-warn">待功能</span>'}
            ${rowCount(node) ? `<span class="badge b-gray">${rowCount(node)} 失效</span>` : ''}
            ${highCount(node) ? `<span class="badge b-bad">H ${highCount(node)}</span>` : ''}
            ${candidates.length ? `<span class="badge b-cc">${candidates.length} 候选</span>` : ''}
          </div>
        </div>
        ${children.length && !isCollapsed ? `<div class="fmea-tree-children">${children.map(child => renderTreeNode(child, depth + 1)).join('')}</div>` : ''}
      </div>`;
    };
    const breadcrumb = [];
    if (selected) {
      let current = selected;
      while (current) {
        breadcrumb.unshift(current);
        current = structs.find(node => node.node_id === (current.parent_id || null));
      }
    }
    const selectedRows = selected ? (rowsByNode.get(selected.node_id) || []) : [];
    const selectedFunctions = selected ? funcList(selected) : [];
    const selectedFormal = selectedFunctions.filter(func => func.status === '正式');
    const selectedCandidates = selectedFunctions.filter(func => func.status === '候选');
    const rowsByFunc = new Map();
    const unassignedRows = [];
    for (const row of selectedRows) {
      if (row.func_id && selectedFormal.some(func => func.func_id === row.func_id)) {
        if (!rowsByFunc.has(row.func_id)) rowsByFunc.set(row.func_id, []);
        rowsByFunc.get(row.func_id).push(row);
      } else unassignedRows.push(row);
    }
    const relatedChars = [];
    const seenChars = new Set();
    for (const row of selectedRows) {
      const values = [
        [row.char_id, row.char_name, '产品特性'],
        [row.process_char_id, row.process_char_name, '过程特性'],
      ];
      for (const [id, name, kind] of values) {
        if (!id || seenChars.has(id)) continue;
        seenChars.add(id);
        relatedChars.push({ id, name: name || id, kind });
      }
    }
    const apCounts = { H: 0, M: 0, L: 0 };
    selectedRows.forEach(row => { if (apCounts[row.ap] != null) apCounts[row.ap] += 1; });
    const allFormal = (d.functions || []).filter(func => func.status === '正式');
    const allCandidates = (d.functions || []).filter(func => func.status === '候选');
    const stepState = [
      ['结构', structs.length > 0, `${structs.length} 个节点`],
      ['功能', allFormal.length > 0, `${allFormal.length} 条正式功能`],
      ['失效', d.rows.length > 0, `${d.rows.length} 条分析行`],
      ['风险', d.rows.every(row => row.s != null && row.o != null && row.d != null), 'S/O/D 完整性'],
      ['优化', d.rows.some(row => row.actions > 0), '措施与决定'],
      ['文件', d.header.status === '已发布', d.header.status],
    ];
    const failureChip = row => `<button class="fmea-failure-chip" data-fmea-row="${esc(row.row_id)}">
      ${apBadge(row.ap)}<span>${esc(row.fm_name || '未命名失效模式')}</span>
      <small>S${row.s} O${row.o} D${row.d}</small></button>`;
    const functionCard = func => {
      const rows = rowsByFunc.get(func.func_id) || [];
      return `<article class="fmea-function-card">
        <header><div><span class="lbl">功能</span><b>${esc(func.text)}</b>
          ${func.source === 'image' ? '<span class="badge b-warn">历史图纸导入记录</span>' : ''}</div>
          <span class="badge ${rows.length ? 'b-ok' : 'b-warn'}">${rows.length} 条失效</span></header>
        ${rows.length ? `<div class="fmea-failure-list">${rows.map(failureChip).join('')}</div>`
          : '<div class="fmea-empty-inline">尚未针对该功能建立失效链</div>'}
        <footer>
          <button class="btn sm" data-fmea-add-row-fn="${esc(selected.node_id)}" data-func-id="${esc(func.func_id)}">＋失效分析</button>
        </footer>
      </article>`;
    };
    $('#view').innerHTML = `
      <div class="fmea-modebar qt-toolbar">
        <div class="tabs" style="margin:0">
          <div class="tab ${isD ? 'on' : ''}" data-type="DFMEA">DFMEA（设计）</div>
          <div class="tab ${!isD ? 'on' : ''}" data-type="PFMEA">PFMEA（过程）</div>
        </div>
        <div class="segmented">
          <button class="active" data-fmea-view="tree">结构树工作台</button>
          <button data-fmea-view="table">完整工作表</button>
        </div>
        <div class="fmea-mode-actions qt-actions">
          <div class="qt-toolbar-meta">
            <span class="qt-chip">${esc(d.header.status || '草稿')}</span>
            <span class="qt-chip">${esc(d.header.rev || 'V1.0')}</span>
          </div>
          <button class="btn sm ghost" data-quality-export="fmea" data-export-fmt="docx">导出 Word</button>
          <button class="btn sm ghost" data-quality-export="fmea" data-export-fmt="xlsx">导出 Excel</button>
          <button class="btn sm ghost" id="fmeaAddNode">＋结构节点</button>
          <details class="qt-more">
            <summary>更多</summary>
            <div class="qt-more-menu">
              ${isD ? '<button class="btn sm ghost" id="btnFromImage">从示意图生成结构</button>'
                : '<button class="btn sm ghost" id="btnFromPfd">从PFD同步结构</button><button class="btn sm ghost" onclick="openHeader()">表头</button>'}
              ${state.user?.role === 'admin' ? '<button class="btn sm ghost" id="aiCfgLink">AI 设置</button>' : ''}
            </div>
          </details>
          ${d.header.status === '已发布'
            ? '<button class="btn sm ghost" id="reviseFmea">发起修订</button>'
            : '<button class="btn sm" id="publishFmea">发布</button>'}
        </div>
      </div>
      <div class="fmea-workspace">
        <aside class="fmea-tree-panel">
          <div class="fmea-panel-head">
            <div><h3>结构树</h3></div>
            <span class="badge b-gray">${structs.length} 节点</span>
          </div>
          <input class="sel fmea-tree-search" id="fmeaTreeSearch" placeholder="搜索结构节点">
          <div class="fmea-tree-scroll">
            ${roots.length ? roots.map(root => renderTreeNode(root, 0)).join('') : '<div class="empty">暂无结构树，请先从 PFD 或示意图生成</div>'}
          </div>
        </aside>
        <main class="fmea-node-panel">
          ${selected ? `
            <div class="fmea-node-breadcrumb">${breadcrumb.map((node, index) =>
              `<button data-fmea-select="${esc(node.node_id)}">${esc(node.name)}</button>${index < breadcrumb.length - 1 ? '<span>›</span>' : ''}`).join('')}</div>
            <div class="fmea-node-hero">
              <div><span class="lbl">${isD ? 'DFMEA 结构节点' : 'PFMEA 过程步骤'}</span>
                <h2>${esc(selected.name)}</h2>
                <p>${esc(selected.desc || '尚未填写节点说明')}</p></div>
              <div class="fmea-node-actions">
                <button class="btn ghost" data-fmea-rename="${esc(selected.node_id)}" data-name="${esc(selected.name)}">改名</button>
                <button class="btn" data-fmea-open-functions="${esc(selected.node_id)}" data-fmea-node-name="${esc(selected.name)}" data-fmea-node-desc="${esc(selected.desc || '')}">管理功能</button>
              </div>
            </div>
            <div class="fmea-node-kpis">
              <div><span>正式功能</span><b>${selectedFormal.length}</b><small>候选 ${selectedCandidates.length}</small></div>
              <div><span>失效行</span><b>${selectedRows.length}</b><small>未关联 ${unassignedRows.length}</small></div>
              <div><span>高 AP</span><b class="${apCounts.H ? 'bad' : ''}">${apCounts.H}</b><small>需处置决定</small></div>
              <div><span>子节点</span><b>${childrenOf(selected.node_id).length}</b><small>${relatedChars.length} 个关联特性</small></div>
            </div>
            <section class="fmea-function-section">
              <div class="fmea-section-head"><div><h3>功能与失效链</h3></div>
                <button class="btn sm ghost" data-fmea-add-row="${esc(selected.node_id)}">＋未指定功能的分析行</button></div>
              ${selectedFormal.length ? selectedFormal.map(functionCard).join('')
                : `<div class="fmea-empty-state"><b>该节点还没有正式功能</b><span>${isD ? '描述结构件的设计用途和性能要求，生成 DFMEA 功能与设计失效链。' : '描述工序要实现的输出和控制要求，生成 PFMEA 功能与过程失效链。'}</span><button class="btn" data-fmea-open-functions="${esc(selected.node_id)}" data-fmea-node-name="${esc(selected.name)}" data-fmea-node-desc="${esc(selected.desc || '')}">开始功能分析</button></div>`}
              ${unassignedRows.length ? `<article class="fmea-function-card unassigned">
                <header><div><span class="lbl">未关联功能</span><b>需要补充所针对的功能</b></div><span class="badge b-warn">${unassignedRows.length} 条</span></header>
                <div class="fmea-failure-list">${unassignedRows.map(failureChip).join('')}</div></article>` : ''}
              ${selectedCandidates.length ? `<div class="fmea-candidate-strip"><b>${selectedCandidates.length} 条功能候选待处理</b>
                <button class="btn sm ghost" data-fmea-open-functions="${esc(selected.node_id)}" data-fmea-node-name="${esc(selected.name)}" data-fmea-node-desc="${esc(selected.desc || '')}">查看候选</button></div>` : ''}
            </section>`
          : '<div class="empty">请选择一个结构节点</div>'}
        </main>
        <aside class="fmea-inspector">
          <section>
            <div class="fmea-panel-head"><div><h3>七步完整度</h3></div><span class="badge b-warn">${d.header.status}</span></div>
            <div class="fmea-step-list">${stepState.map(([name, done, detail], index) =>
              `<div class="${done ? 'done' : ''}"><i>${done ? '✓' : index + 1}</i><span><b>${name}</b><small>${esc(detail)}</small></span></div>`).join('')}</div>
          </section>
          <section>
            <div class="fmea-panel-head"><div><h3>AP 分布</h3></div></div>
            <div class="fmea-risk-bars">
              ${['H', 'M', 'L'].map(level => `<div><span>${level}</span><div class="bar ${level === 'H' ? 'bad' : level === 'M' ? 'warn' : 'ok'}"><i style="width:${selectedRows.length ? (apCounts[level] / selectedRows.length) * 100 : 0}%"></i></div><b>${apCounts[level]}</b></div>`).join('')}
            </div>
          </section>
          <section>
            <div class="fmea-panel-head"><div><h3>关联特性</h3></div><span class="badge b-gray">${relatedChars.length}</span></div>
            <div class="fmea-char-list">${relatedChars.length ? relatedChars.map(char =>
              `<span class="chip"><b>${esc(char.name)}</b><small>${esc(char.kind)} · ${esc(char.id)}</small></span>`).join('') : '<div class="dim">该节点尚未关联产品/过程特性</div>'}</div>
          </section>
          <section>
            <div class="fmea-panel-head"><div><h3>分析概览</h3></div></div>
            <div class="kv"><div class="k">结构节点</div><div>${structs.length}</div>
              <div class="k">正式功能</div><div>${allFormal.length}</div>
              <div class="k">候选功能</div><div>${allCandidates.length}</div>
              <div class="k">失效分析行</div><div>${d.rows.length}</div>
              <div class="k">高 AP</div><div>${d.rows.filter(row => row.ap === 'H').length}</div></div>
          </section>
        </aside>
      </div>`;
    $$('[data-type]').forEach(tab => tab.onclick = () => {
      state.fmeaType = tab.dataset.type;
      state.fmeaSelectedNode = null;
      vFmea();
    });
    $$('[data-fmea-view]').forEach(button => button.onclick = () => {
      state.fmeaView = button.dataset.fmeaView;
      vFmea();
    });
    $$('[data-fmea-select]').forEach(button => button.onclick = () => {
      state.fmeaSelectedNode = button.dataset.fmeaSelect;
      vFmea();
    });
    $$('[data-fmea-toggle]').forEach(button => button.onclick = event => {
      event.stopPropagation();
      const nodeId = button.dataset.fmeaToggle;
      if (collapsed.has(nodeId)) collapsed.delete(nodeId);
      else collapsed.add(nodeId);
      vFmea();
    });
    $$('[data-fmea-row]').forEach(button => button.onclick = () => openRow(button.dataset.fmeaRow, d));
    $$('[data-fmea-open-functions]').forEach(button => button.onclick = () =>
      openFunctions(button.dataset.fmeaOpenFunctions, button.dataset.fmeaNodeName, button.dataset.fmeaNodeDesc || ''));
    $$('[data-fmea-add-row]').forEach(button => button.onclick = () => openRow(null, d, button.dataset.fmeaAddRow));
    $$('[data-fmea-add-row-fn]').forEach(button => button.onclick = () =>
      openRow(null, d, button.dataset.fmeaAddRowFn, button.dataset.funcId));
    $$('[data-fmea-rename]').forEach(button => button.onclick = async () => {
      const result = await showFormDialog({
        title: '修改结构节点名称',
        fields: [{ key: 'name', label: '节点名称', value: button.dataset.name || '', required: true }],
        confirmText: '保存',
      });
      if (!result || result.name.trim() === button.dataset.name) return;
      try {
        await api('/fmea/node/' + encodeURIComponent(button.dataset.fmeaRename), {
          method: 'PATCH', body: { name: result.name.trim() },
        });
        vFmea();
      } catch (e) { toast(e.message, 'err'); }
    });
    $('#fmeaTreeSearch').oninput = event => {
      const needle = event.target.value.trim().toLowerCase();
      $$('[data-tree-branch]').forEach(branch => {
        const node = branch.querySelector('.fmea-tree-node');
        branch.style.display = !needle || (node?.innerText || '').toLowerCase().includes(needle) ? '' : 'none';
      });
    };
    $('#fmeaAddNode').onclick = async () => {
      const parentId = selected?.node_id || null;
      const fields = [{ key: 'name', label: '结构节点名称', required: true }];
      if (parentId) {
        fields.push({
          key: 'placement',
          label: '节点位置',
          type: 'select',
          value: 'child',
          options: [
            { value: 'child', label: `作为“${selected.name}”的子节点` },
            { value: 'sibling', label: `作为“${selected.name}”的同级节点` },
          ],
        });
      }
      const result = await showFormDialog({
        title: '新增结构节点',
        fields,
        confirmText: '新增节点',
      });
      if (!result) return;
      try {
        const result = await api('/fmea/node', {
          method: 'POST',
          body: {
            fmea_type: state.fmeaType, name: result.name.trim(),
            parent_id: result.placement === 'sibling' ? (selected?.parent_id || null) : parentId,
          },
        });
        state.fmeaSelectedNode = result.node_id;
        vFmea();
      } catch (e) { toast(e.message, 'err'); }
    };
    $('#aiCfgLink').onclick = event => { event.preventDefault(); openAISettings(); };
    if ($('#reviseFmea')) $('#reviseFmea').onclick = reviseFmea;
    if ($('#publishFmea')) $('#publishFmea').onclick = publishFmea;
    if ($('#btnFromImage')) $('#btnFromImage').onclick = () => openFromImage();
    if ($('#btnFromPfd')) $('#btnFromPfd').onclick = async () => {
      const button = $('#btnFromPfd');
      button.disabled = true;
      button.textContent = '同步中…';
      try {
        const result = await api('/pfmea/from-pfd', { method: 'POST', body: { with4m: true } });
        toast(`已同步 ${result.steps} 道工序，当前 ${result.nodes} 个结构节点，新增 ${result.created_nodes} 个` +
          (result.draft_steps ? `；其中 ${result.draft_steps} 道 PFD 工序仍为草稿` : ''), 'ok');
        state.fmeaSelectedNode = null;
        vFmea();
      } catch (e) {
        toast(e.message, 'err');
        button.disabled = false;
        button.textContent = '从PFD同步结构';
      }
    };
    return;
  }

  $('#view').innerHTML = `
    <div class="tabs">
      <div class="tab ${isD ? 'on' : ''}" data-type="DFMEA">DFMEA（设计）</div>
      <div class="tab ${!isD ? 'on' : ''}" data-type="PFMEA">PFMEA（过程）</div>
    </div>
    <div class="fmea-table-switch"><button class="btn sm ghost" data-fmea-view="tree">← 返回结构树工作台</button></div>
    <div class="alert info" style="margin-bottom:12px">
      <div>AIAG-VDA 七步法：结构 → 功能 → 失效 → 风险 → 优化。AP 由 S/O/D 查矩阵得出，<b>不是相乘</b>。点击任意行可编辑并登记措施与处置决定。</div>
    </div>
    ${isD ? `<div class="card" style="margin-bottom:12px">
      <div class="card-b" style="display:flex;justify-content:space-between;align-items:center;gap:12px">
        <div><b>结构分析太难写？</b>
          <span class="dim" style="font-size:12px">粘贴产品示意图，系统识别图上的零件名，自动生成「产品总成 → 组件 → 零件」结构树。</span></div>
        <button class="btn" id="btnFromImage">从示意图生成结构</button>
      </div>
    </div>` : `<div class="card" style="margin-bottom:12px">
      <div class="card-b" style="display:flex;justify-content:space-between;align-items:center;gap:12px">
        <div><b>PFMEA 结构应来自工艺流程图</b>
          <span class="dim" style="font-size:12px">一键把 PFD 的工序变成 PFMEA 结构节点（重复生成会自动替换旧树）</span></div>
        <div style="display:flex;gap:8px;align-items:center;white-space:nowrap">
          <select id="pfd4m" style="padding:6px 8px;border:1px solid var(--line);border-radius:7px">
            <option value="">仅工序层</option>
            <option value="1">工序 + 4M 要素</option>
          </select>
          <button class="btn ghost" onclick="openHeader()">表头</button>
          <button class="btn ghost" onclick="openReport()">FMEA 报告</button>
          <button class="btn" id="btnFromPfd">从 PFD 生成结构</button>
        </div>
      </div>
    </div>`}

    ${(() => {
      const structs = d.nodes.filter(n => n.node_type === 'STRUCTURE');
      const kids = id => structs.filter(n => (n.parent_id || null) === id).sort((a, b) => a.seq - b.seq);
      const roots = kids(null);
      const byNode = new Map();
      for (const r of d.rows) {
        const k = r.focus_node_id || '__none';
        if (!byNode.has(k)) byNode.set(k, []);
        byNode.get(k).push(r);
      }
      const NC = isD ? 13 : 14;
      let dispSeq = 0;
      const rowHtml = (r, indent) => {
        dispSeq += 1;
        const no = String(dispSeq).padStart(4, '0');
        return `<tr data-row="${r.row_id}" style="cursor:pointer">
        <td class="nowrap" style="padding-left:${(indent || 0) + 10}px">
          <span class="mono" style="font-weight:700">${no}</span>
        </td>
        ${isD ? '' : `<td class="nowrap">${esc(r.step_no || '')}</td>`}
        <td>${esc(r.fe_name)}</td><td class="num">${r.s}</td>
        <td>${esc(r.fm_name)}</td><td>${esc(r.fc_name)}</td>
        <td class="dim">${esc(r.pc_text)}</td><td class="num">${r.o}</td>
        <td class="dim">${esc(r.dc_text)}</td><td class="num">${r.d}</td>
        <td>${apBadge(r.ap)}</td>
        <td class="nowrap">${r.actions ? `<span class="chip">${r.actions} 条</span>` : '<span class="dim">—</span>'}</td>
        <td>${r.decision ? statusBadge(r.dstatus) : (r.ap === 'H' ? '<span class="badge b-bad">缺决定</span>' : '<span class="dim">—</span>')}</td>
        <td><button class="btn sm ghost" data-del-row="${r.row_id}" style="color:#B91C1C;border-color:#F3C6C6">删</button></td>
      </tr>`;
      };
      const fnByNode = new Map();
      for (const f of (d.functions || [])) {
        if (!fnByNode.has(f.node_id)) fnByNode.set(f.node_id, []);
        fnByNode.get(f.node_id).push(f);
      }
      const nodeHtml = (n, depth) => {
        const rs = byNode.get(n.node_id) || [];
        const fns = fnByNode.get(n.node_id) || [];
        const formal = fns.filter(f => f.status === '正式' && !/^[（(]\s*待补充/.test(f.text));
        const cand = fns.filter(f => f.status === '候选');
        const head = `<tr class="strow">
          <td colspan="${NC}" style="padding-left:${depth * 22 + 10}px">
            <span class="stname" data-edit="${n.node_id}" data-field="name" title="点击可改名">${depth ? '└' : '▸'} ${esc(n.name)}</span>
            ${n.desc ? `<span class="std" style="max-width:640px">${esc(n.desc)}</span>` : ""}
            <span class="tag">${rs.length} 条失效</span>
            ${formal.length ? '' : '<span class="tag" style="background:#FEF3C7;color:#B45309">功能待补</span>'}
            ${cand.length ? `<span class="tag" style="background:#EEF2FF;color:#4338CA">${cand.length} 条候选中</span>` : ''}
            <span style="float:right">
              <button class="btn sm ghost" data-func-mgr="${n.node_id}" data-fname="${esc(n.name)}" data-fdesc="${esc(n.desc || '')}">功能${formal.length ? '(' + formal.length + ')' : ''}</button>
              <button class="btn sm ghost" data-newrow="${n.node_id}">＋新增未关联失效行</button>
              <button class="btn sm ghost" data-del-node="${n.node_id}" data-nname="${esc(n.name)}"
                style="color:#B91C1C;border-color:#F3C6C6">删除</button>
            </span>
          </td></tr>`;
        const isLeaf = kids(n.node_id).length === 0;
        const body = (() => {
          const byFunc = new Map();
          const unassigned = [];
          for (const r of rs) {
            if (r.func_id && formal.some(f => f.func_id === r.func_id)) {
              if (!byFunc.has(r.func_id)) byFunc.set(r.func_id, []);
              byFunc.get(r.func_id).push(r);
            } else unassigned.push(r);
          }
          const pad = depth * 22 + 34;
          const fnRows = formal.map((f, i) => {
            const list = byFunc.get(f.func_id) || [];
            return `<tr><td colspan="${NC}" class="fnrow" style="padding-left:${pad}px">
                <span style="color:var(--ink3);font-size:11px">功能${formal.length > 1 ? i + 1 : ''}：</span>${esc(f.text)}
                ${f.source === 'image' ? '<span class="badge b-warn">历史图纸导入记录</span>' : ''}
                <span class="tag" style="margin-left:8px">${list.length} 条失效</span>
                <span style="float:right">
                  <button class="btn sm ghost" data-newrow-fn="${n.node_id}" data-fn="${f.func_id}">＋失效分析</button>
                  <button class="btn sm ghost" data-del-fn="${f.func_id}" style="color:#B91C1C;border-color:#F3C6C6">删</button>
                </span>
              </td></tr>` + list.map(r => rowHtml(r, pad + 18)).join('');
          }).join('');
          const unRow = unassigned.length ? `<tr><td colspan="${NC}" class="fnrow" style="padding-left:${pad}px">
              <span style="color:#B45309;font-size:11px">未关联功能</span>
              <span class="dim" style="font-size:11px;margin-left:8px">这些行没有指定针对哪条功能，建议打开该行补上</span>
              <span class="tag" style="margin-left:8px">${unassigned.length} 条失效</span>
            </td></tr>` + unassigned.map(r => rowHtml(r, pad + 18)).join('') : '';
          const emptyHint = (!formal.length && isLeaf)
            ? `<tr><td colspan="${NC}" class="dim" style="padding-left:${pad}px">该结构尚未做失效分析</td></tr>` : '';
          return fnRows + unRow + emptyHint;
        })();
        return head + body + kids(n.node_id).map(c => nodeHtml(c, depth + 1)).join('');
      };
      const orphans = byNode.get('__none') || [];
      const orphanHtml = orphans.length ? `
        <tr class="strow"><td colspan="${NC}" style="padding-left:10px">
          <span class="stname">▸ 未关联结构</span>
          <span class="std" style="color:#B45309">这些行没有指定结构节点，建议重新关联</span>
          <span class="tag">${orphans.length} 条失效</span></td></tr>${orphans.map(rowHtml).join('')}` : '';

      return `<div class="card">
        <div class="card-h"><h3>${esc(d.header.fmea_type)} 工作表</h3>
          <span class="hint">${structs.length} 个结构节点 · ${d.rows.length} 条失效分析 · 高 AP ${d.rows.filter(r => r.ap === 'H').length} 条
            ${state.user?.role === 'admin' ? '<a href="#" id="aiCfgLink" style="color:var(--accent);margin-left:10px">AI 设置</a>' : ''}
            ${d.header.status === '已发布'
              ? '<button class="btn sm ghost" id="reviseFmea" style="margin-left:10px">发起修订</button>'
              : '<button class="btn sm ghost" id="publishFmea" style="margin-left:10px">发布 FMEA</button>'}
            <button class="btn sm ghost" id="mergeNodes" style="margin-left:10px">合并同名结构</button>
            ${d.rows.length ? `<button class="btn sm ghost" id="clearRows" style="margin-left:10px;color:#B91C1C;border-color:#F3C6C6">清空全部</button>` : ''}
          </span></div>
        <div style="overflow:auto;max-height:76vh">
        <table class="t"><thead><tr>
          <th class="nowrap" style="width:76px">序号</th>${isD ? '' : '<th style="width:70px">工序</th>'}
          <th>失效影响 (FE)</th><th class="num" style="width:42px">S</th><th>失效模式 (FM)</th><th>失效原因 (FC)</th>
          <th>现行预防控制 (PC)</th><th class="num" style="width:42px">O</th><th>现行探测控制 (DC)</th><th class="num" style="width:42px">D</th>
          <th style="width:58px">AP</th><th style="width:64px">措施</th><th style="width:84px">决定</th><th style="width:72px">操作</th></tr></thead>
        <tbody>
          ${roots.length ? roots.map(r => nodeHtml(r, 0)).join('') : '<tr><td class="dim" colspan="' + NC + '">还没有结构树，请先用「从示意图生成结构」或手工建立</td></tr>'}
          ${orphanHtml}
        </tbody></table></div>
      </div>`;
    })()}`;

  $$('[data-type]').forEach(t => t.onclick = () => { state.fmeaType = t.dataset.type; vFmea(); });
  $$('[data-fmea-view]').forEach(button => button.onclick = () => {
    state.fmeaView = button.dataset.fmeaView;
    vFmea();
  });
  $$('[data-row]').forEach(tr => tr.onclick = () => openRow(tr.dataset.row, d));
  if ($('#btnFromImage')) $('#btnFromImage').onclick = () => openFromImage();
  if ($('#btnFromPfd')) $('#btnFromPfd').onclick = async () => {
    const with4m = !!$('#pfd4m').value;
    const btn = $('#btnFromPfd');
    btn.disabled = true;
    btn.textContent = '生成中…';
    try {
      const r = await api('/pfmea/from-pfd', { method: 'POST', body: { with4m } });
      toast(`已同步 ${r.steps} 道工序，当前 ${r.nodes} 个结构节点，新增 ${r.created_nodes} 个` +
        (r.draft_steps ? `，其中 ${r.draft_steps} 道仍为草稿` : '') +
        (r.replaced ? `，替换旧树 ${r.replaced} 个节点` : ''), 'ok');
      vFmea();
    } catch (e) {
      toast(e.message, 'err');
      btn.disabled = false;
      btn.textContent = '从 PFD 生成结构';
    }
  };
  if ($('#aiCfgLink')) $('#aiCfgLink').onclick = (e) => { e.preventDefault(); openAISettings(); };
  if ($('#reviseFmea')) $('#reviseFmea').onclick = reviseFmea;
  if ($('#publishFmea')) $('#publishFmea').onclick = publishFmea;
  $$('[data-newrow]').forEach(b => b.onclick = (e) => {
    e.stopPropagation();
    openRow(null, d, b.dataset.newrow);
  });
  $$('[data-newrow-fn]').forEach(b => b.onclick = (e) => {
    e.stopPropagation();
    openRow(null, d, b.dataset.newrowFn, b.dataset.fn);
  });

  /* ---------------- 结构节点：改名 / 改功能 / 删除 ---------------- */
  $$('[data-edit]').forEach(el => el.onclick = (e) => {
    e.stopPropagation();
    const id = el.dataset.edit, field = el.dataset.field;
    const isName = field === 'name';
    const prefix = isName ? (el.textContent.trim().startsWith('└') ? '└ ' : '▸ ') : '功能：';
    const cur = el.textContent.replace(/^[└▸]\s*/, '').replace(/^功能：/, '').trim();
    const inp = document.createElement('input');
    inp.value = cur === '未登记（点击填写）' ? '' : cur;
    inp.style.cssText = `font-size:12px;padding:2px 6px;border:1px solid var(--accent);border-radius:5px;min-width:220px;width:${Math.min(560, Math.max(220, cur.length * 15))}px`;
    el.replaceWith(inp);
    inp.focus(); inp.select();
    let done = false;
    const save = async () => {
      if (done) return;
      done = true;
      const v = inp.value.trim();
      if (v && v !== cur) {
        try {
          const body = isName ? { name: v } : { desc: v };
          await api('/fmea/node/' + encodeURIComponent(id), { method: 'PATCH', body });
          toast(isName ? '名称已更新' : '功能已更新', 'ok');
        } catch (err) { toast(err.message, 'err'); }
      }
      vFmea();
    };
    inp.onkeydown = ev => { if (ev.key === 'Enter') save(); if (ev.key === 'Escape') { done = true; vFmea(); } };
    inp.onblur = save;
  });

  $$('[data-func-mgr]').forEach(b => b.onclick = (e) => {
    e.stopPropagation();
    openFunctions(b.dataset.funcMgr, b.dataset.fname, b.dataset.fdesc || '');
  });

  if ($('#mergeNodes')) {
    $('#mergeNodes').onclick = async () => {
      try {
        const r = await api('/fmea/nodes/merge', { method: 'POST', body: {} });
        if (r.merged) toast(`合并了 ${r.merged} 个同名结构节点`, 'ok');
        else toast('没有发现同名结构节点');
        vFmea();
      } catch (e) { toast(e.message, 'err'); }
    };
  }

  /* 失效行 / 功能行的独立删除（二次确认） */
  const armDelete = (btn, label, run) => {
    let armed = false;
    btn.onclick = async (ev) => {
      ev.stopPropagation();
      if (!armed) {
        armed = true;
        btn.textContent = '确认?';
        btn.style.background = '#FEF2F2';
        setTimeout(() => { armed = false; btn.textContent = label; btn.style.background = ''; }, 6000);
        return;
      }
      try { await run(); } catch (e) { toast(e.message, 'err'); }
    };
  };
  $$('[data-del-row]').forEach(b => armDelete(b, '删', async () => {
    const rid = b.dataset.delRow;
    await api('/fmea/row/' + encodeURIComponent(rid), { method: 'DELETE' });
    toast('已删除 ' + rid, 'ok');
    vFmea();
  }));
  $$('[data-del-fn]').forEach(b => armDelete(b, '删', async () => {
    await api('/fmea/functions/' + encodeURIComponent(b.dataset.delFn), { method: 'DELETE' });
    toast('已删除功能', 'ok');
    vFmea();
  }));

  $$('[data-del-node]').forEach(b => {
    b.onclick = async (e) => {
      e.stopPropagation();
      try {
        // F-10：先取影响预览，要求输入节点名确认，避免误删整棵结构
        const impact = await api(`/fmea/node/${encodeURIComponent(b.dataset.delNode)}/impact`);
        const cpText = impact.cp_rows.length
          ? `\n受影响控制计划行：${impact.cp_rows.slice(0, 8).map(row => row.cp_row_id).join('、')}${impact.cp_rows.length > 8 ? ' 等' : ''}`
          : '';
        const result = await showFormDialog({
          title: `删除结构节点“${impact.node.name}”`,
          description: `将删除 ${impact.nodes} 个结构节点（含子节点 ${impact.child_nodes} 个）、${impact.rows} 条失效分析、${impact.actions} 条措施、${impact.decisions} 条处置决定。${cpText}\n\n此操作不可撤销。`,
          fields: [{
            key: 'confirm_name', label: `请输入节点名称“${impact.node.name}”确认`, required: true,
          }],
          confirmText: '确认删除节点', danger: true,
          validate: values => values.confirm_name.trim() === impact.node.name ? '' : '输入的节点名称不一致，未执行删除。',
        });
        if (!result) return;
        const r = await api('/fmea/node/' + encodeURIComponent(b.dataset.delNode), { method: 'DELETE' });
        toast(`已删除 ${r.nodes} 个结构节点、${r.rows} 条失效分析`, 'ok');
        vFmea();
      } catch (err) { toast(err.message, 'err'); }
    };
  });
  if ($('#clearRows')) {
    let armed = false;
    $('#clearRows').onclick = async () => {
      const b = $('#clearRows');
      if (!armed) {
        armed = true;
        b.textContent = '再点一次确认清空';
        b.style.background = '#FEF2F2';
        setTimeout(() => { armed = false; b.textContent = '清空全部'; b.style.background = ''; }, 6000);
        return;
      }
      try {
        const r = await api('/fmea/rows?type=' + state.fmeaType, { method: 'DELETE' });
        toast(`已清空 ${r.removed} 行`, 'ok');
        vFmea();
      } catch (e) { toast(e.message, 'err'); }
    };
  }
}

/* 功能管理：一个结构节点可以有多个功能；AI 候选落库，关掉窗口不丢 */
async function openFunctions(nodeId, nodeName, nodeDesc) {
  const isDfmea = (state.fmeaType || 'PFMEA') === 'DFMEA';
  const controlLabels = isDfmea
    ? { pc: '设计预防控制', dc: '设计验证控制' }
    : { pc: '现行预防控制 PC', dc: '现行探测控制 DC' };
  const drawer = $('#drawer');
  $('.drawer-box', drawer).innerHTML = `
    <div class="drawer-h">
      <div><h2>功能管理</h2><p>结构节点：${esc(nodeName)}</p></div>
      <button class="x" id="fnClose">✕</button>
    </div>
    <div class="drawer-b"><div class="dim">加载中…</div></div>`;
  drawer.classList.add('open');
  $('#fnClose').onclick = () => drawer.classList.remove('open');

  const render = async () => {
    const { list } = await api('/fmea/functions?node=' + encodeURIComponent(nodeId));
    const formal = list.filter(f => f.status === '正式');
    const cand = list.filter(f => f.status === '候选');
    const used = list.length;
    const remaining = Math.max(0, 15 - used);
    $('.drawer-b', drawer).innerHTML = `
      <div class="fmea-compact-guide">
        <b>${isDfmea ? 'DFMEA 功能分析' : 'PFMEA 第 3–4 步'}</b>
        <span>${isDfmea ? '描述结构件设计用途、接口和性能要求' : '标准功能 = 动作 + 对象 + 可测量要求'}</span>
        <span class="badge b-gray">${used}/15</span>
      </div>

      <div class="lbl" style="margin-bottom:8px">已采用（${formal.length}）
        <span class="dim" style="font-weight:400">— 每条功能都有独立失效链</span></div>
      <div style="margin-bottom:16px">
        ${formal.length ? formal.map(f => `
          <div style="border:1px solid var(--line);border-radius:8px;margin-bottom:8px;padding:9px 10px">
            <div style="display:flex;align-items:center;gap:8px">
              <span style="flex:1;font-size:12.5px">${esc(f.text)}
                ${f.source === 'image' ? '<span class="badge b-warn">历史图纸导入记录</span>' : ''}</span>
              <button class="btn sm" data-open-cand="${f.func_id}" data-func-text="${esc(f.text)}">查看失效候选${f.failure_candidate_count ? `(${f.failure_candidate_count})` : ''}</button>
              <button class="btn sm ghost" data-fn-del="${f.func_id}">删除</button>
            </div>
            <div data-cand-box="${f.func_id}" style="margin-top:8px"></div>
          </div>`).join('') : '<div class="dim" style="font-size:12px">尚无功能，从候选里采用，或直接添加</div>'}
      </div>

      ${cand.length ? `<div class="lbl" style="margin-bottom:8px">待采用候选（${cand.length}）
        <span class="dim" style="font-weight:400">未采用候选会保留；采用后再生成失效分析</span></div>
      <div style="margin-bottom:16px">
        ${cand.map(f => `<div style="border:1px solid var(--line);border-radius:8px;padding:9px;margin-bottom:7px;background:#fff">
          <div class="fnitem" style="align-items:flex-start">
            <textarea data-fn-text="${f.func_id}" rows="2" style="flex:1">${esc(f.text)}</textarea>
            <button class="btn sm" data-fn-use="${f.func_id}">采用</button>
            <button class="btn sm ghost" data-fn-del="${f.func_id}">删除</button>
          </div>
          ${f.rationale ? `<div class="dim" style="font-size:11px;margin:5px 0 0 2px">AI 归纳：${esc(f.rationale)}</div>` : ''}
          <div style="margin-top:6px"><span class="badge ${f.failure_candidate_count ? 'b-ok' : 'b-warn'}">${f.failure_candidate_count ? `已保存 ${f.failure_candidate_count} 条失效候选` : '尚未生成失效候选'}</span></div>
        </div>`).join('')}
      </div>` : '<div class="fmea-candidate-empty">暂无功能候选</div>'}

      <div class="lbl" style="margin-bottom:8px">新增功能 <span class="dim" style="font-weight:400">当前 ${used}/15 · 剩余 ${remaining} 条</span></div>
      <div class="alert info" style="margin-bottom:10px;font-size:11.5px">
        ${isDfmea
          ? '说明该结构件为什么存在、与相邻结构如何配合、需要满足哪些性能。AI 只整理标准设计功能，采用后再生成设计失效链。'
          : '说明这一步要做什么、处理什么对象、做到什么程度、为什么需要它。AI 只整理标准过程功能，采用后再生成过程失效链。'}
      </div>
      <div class="field"><label>口语化描述</label>
        <textarea id="faDraft" rows="5" placeholder="${isDfmea
          ? '例如：陶瓷基体要支撑电阻膜层，隔开导电膜和基体，满足图纸绝缘与尺寸要求。'
          : '例如：激光划线机按产品尺寸在陶瓷基片上形成预切线，使后续分粒沿线断开且不伤及基片。'}"></textarea></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
        <button class="btn" id="faGen" ${remaining === 0 ? 'disabled' : ''}>${remaining === 0 ? '已达到 15 条上限' : `AI 解析并生成 ${Math.min(3, remaining)} 个功能`}</button>
      </div>
      <div id="faNote" class="dim" style="font-size:11.5px;margin-top:10px"></div>
      <details class="fmea-manual-add">
        <summary>手工补充标准功能</summary>
        <div style="display:flex;gap:8px;align-items:flex-end">
          <div class="field" style="flex:1;margin:0"><input id="faManual" placeholder="动词 + 名词 + 可测量要求，如：在陶瓷基片表面形成预划痕"></div>
          <button class="btn ghost" id="faAdd" ${remaining === 0 ? 'disabled' : ''}>添加</button>
        </div>
      </details>
      `;

    /* 每条功能下的失效候选：生成 + 采用 + 编辑 */
    const renderCandFor = async (funcId, box) => {
      const funcText = (formal.find(item => item.func_id === funcId) || {}).text || '';
      const { list } = await api(`/fmea/failure-cands?node=${encodeURIComponent(nodeId)}&func=${encodeURIComponent(funcId)}`);
      const pend = list.filter(c => c.status === '候选');
      const done = list.filter(c => c.status === '已采用');
      box.innerHTML = `
        <div style="display:flex;gap:7px;align-items:center;margin-bottom:7px">
          <span class="lbl">该功能的失效候选</span>
          <span class="dim" style="font-size:11px">${pend.length} 条待采用 · ${done.length} 条已采用</span>
          <span style="margin-left:auto"></span>
          <button class="btn sm ghost" data-gen-fail="${funcId}">${list.length ? '再生成 3 条候选' : '生成失效候选'}</button>
        </div>
        ${!list.length ? '<div class="dim" style="font-size:11.5px">暂无已保存的失效候选；点击“生成失效候选”后才会调用 AI 或本地规则。</div>' : ''}
        ${pend.length ? pend.map(c => `<div style="border:1px solid var(--line);border-radius:7px;padding:8px;margin-bottom:6px;background:#fff">
          <div style="display:flex;gap:6px;align-items:center;margin-bottom:6px">
            ${c.cat ? `<span class="badge b-gray">${esc(c.cat)}</span>` : ''}
            <span class="dim" style="font-size:11px">S</span><input data-cd="${c.cand_id}" data-k="s" type="number" min="1" max="10" value="${c.s}" style="width:46px">
            <span style="margin-left:auto">
              <button class="btn sm" data-adopt-fn="${c.cand_id}" data-fid="${funcId}">采用</button>
              <button class="btn sm ghost" data-drop-fn="${c.cand_id}" data-fid="${funcId}">删除</button>
            </span>
          </div>
          <textarea data-cd="${c.cand_id}" data-k="mode" rows="2" style="width:100%;margin-bottom:4px" placeholder="失效模式">${esc(c.mode || '')}</textarea>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px">
            <textarea data-cd="${c.cand_id}" data-k="effect" rows="2" placeholder="失效影响">${esc(c.effect || '')}</textarea>
            <textarea data-cd="${c.cand_id}" data-k="cause" rows="2" placeholder="失效原因">${esc(c.cause || '')}</textarea>
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:4px">
            <textarea data-cd="${c.cand_id}" data-k="pc" rows="2" placeholder="${controlLabels.pc}">${esc(c.pc || '')}</textarea>
            <textarea data-cd="${c.cand_id}" data-k="dc" rows="2" placeholder="${controlLabels.dc}">${esc(c.dc || '')}</textarea>
          </div>
        </div>`).join('') : ''}
        ${done.length ? `<div class="dim" style="font-size:11px;margin:6px 0 4px">已采用 ${done.length} 条</div>
          ${done.map(c => `<div style="display:flex;gap:6px;align-items:center;font-size:11.5px;padding:4px 0">
            <span class="badge b-ok">已采用</span><span style="flex:1">${esc(c.mode || '')}</span>
            <span class="mono dim">${esc(c.row_id || '')}</span></div>`).join('')}` : ''}`;

      box.querySelectorAll('[data-cd]').forEach(el => {
        el.onblur = async () => {
          const g = k => (box.querySelector(`[data-cd="${el.dataset.cd}"][data-k="${k}"]`) || {}).value || '';
          await api('/fmea/failure-cands/' + encodeURIComponent(el.dataset.cd), {
            method: 'PATCH',
            body: { mode: g('mode'), effect: g('effect'), cause: g('cause'), pc: g('pc'), dc: g('dc'), s: +g('s') || 8 },
          });
        };
      });
      box.querySelectorAll('[data-drop-fn]').forEach(b => b.onclick = async () => {
        await api('/fmea/failure-cands/' + encodeURIComponent(b.dataset.dropFn), { method: 'DELETE' });
        renderCandFor(funcId, box);
      });
      box.querySelectorAll('[data-adopt-fn]').forEach(b => b.onclick = async () => {
        const g = k => (box.querySelector(`[data-cd="${b.dataset.adoptFn}"][data-k="${k}"]`) || {}).value || '';
        if (!g('mode').trim()) return toast('失效模式不能为空', 'err');
        try {
          const res = await api('/fmea/row-from-text', { method: 'POST', body: {
            focus_node_id: nodeId, func_id: funcId,
            mode: g('mode'), effect: g('effect'), cause: g('cause'),
            pc_text: g('pc'), dc_text: g('dc'),
            s: +g('s') || 8, o: 5, d: 5, fmea_type: state.fmeaType || 'PFMEA',
          } });
          await api('/fmea/failure-cands/' + encodeURIComponent(b.dataset.adoptFn), { method: 'PATCH', body: { status: '已采用', row_id: res.row_id } });
          toast('已生成分析行 ' + res.row_id, 'ok');
          renderCandFor(funcId, box); vFmea();
        } catch (e) { toast(e.message, 'err'); }
      });
      box.querySelectorAll('[data-gen-fail]').forEach(b => b.onclick = async () => {
        box.innerHTML = '<div class="dim" style="font-size:11.5px">正在读取或生成失效候选…</div>';
        try {
          await api('/ai/suggest', { method: 'POST', body: {
            node: nodeName, func: funcText, product: state.meta.project.name,
            node_id: nodeId, func_id: funcId,
          } });
          await renderCandFor(funcId, box);
        } catch (e) { box.innerHTML = `<div class="alert bad">${esc(e.message)}</div>`; }
      });
    };

    $$('[data-open-cand]').forEach(b => b.onclick = async () => {
      const box = document.querySelector(`[data-cand-box="${b.dataset.openCand}"]`);
      try { await renderCandFor(b.dataset.openCand, box); }
      catch (e) { box.innerHTML = `<div class="alert bad">${esc(e.message)}</div>`; }
    });
    $$('[data-fn-use]').forEach(b => b.onclick = async () => {
      const ta = document.querySelector(`[data-fn-text="${b.dataset.fnUse}"]`);
      await api('/fmea/functions/' + encodeURIComponent(b.dataset.fnUse), {
        method: 'PATCH', body: { status: '正式', text: ta ? ta.value : undefined },
      });
      toast('已采用', 'ok');
      render(); vFmea();
    });
    $$('[data-fn-del]').forEach(b => b.onclick = async () => {
      await api('/fmea/functions/' + encodeURIComponent(b.dataset.fnDel), { method: 'DELETE' });
      toast('已删除');
      render(); vFmea();
    });
    $$('[data-fn-text]').forEach(ta => ta.onblur = async () => {
      await api('/fmea/functions/' + encodeURIComponent(ta.dataset.fnText), {
        method: 'PATCH', body: { text: ta.value },
      });
    });

    $('#faAdd').onclick = async () => {
      const v = $('#faManual').value.trim();
      if (!v) return toast('请填写标准功能', 'err');
      await api('/fmea/functions', { method: 'POST', body: { node_id: nodeId, text: v, status: '正式', source: 'manual' } });
      toast('已添加', 'ok');
      render(); vFmea();
    };

    $('#faGen').onclick = async () => {
      const note = $('#faNote');
      const draft = $('#faDraft').value.trim();
      if (!draft) return toast('请先用大白话描述这一步的功能', 'err');
      note.textContent = `正在按${isDfmea ? 'DFMEA 设计功能' : 'PFMEA 过程功能'}口径生成 3 条功能候选…`;
      try {
        const r = await api('/ai/function', {
          method: 'POST',
          body: { node: nodeName, draft, product: state.meta.project.name, node_id: nodeId, context: nodeDesc || '' },
        });
        if (r.limitReached) {
          note.textContent = r.note;
          return;
        }
        toast(r.note || `已生成 ${r.saved.length} 个功能候选`, r.source === 'local' ? 'err' : 'ok');
        await render(); vFmea();
      } catch (e) {
        note.textContent = '失败：' + e.message;
      }
    };
  };

  await render();
}

async function openAISettings() {
  const drawer = $('#drawer');
  const cfg = await api('/ai/config');
  const PRESETS = [
    { id: 'deepseek', name: 'DeepSeek', base: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
    { id: 'openai', name: 'OpenAI（国内常不可达）', base: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
    { id: 'qwen', name: '阿里百炼（通义）', base: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
    { id: 'ollama', name: '本地 Ollama', base: 'http://127.0.0.1:11434/v1', model: 'qwen2.5' },
    { id: 'custom', name: '自定义', base: '', model: '' },
  ];
  $('.drawer-box', drawer).innerHTML = `
    <div class="drawer-h">
      <div><h2>AI 接口设置</h2><p>兼容 OpenAI 协议的任意接口；Key 存本机数据库，不回传前端</p></div>
      <button class="x" id="asClose">✕</button>
    </div>
    <div class="drawer-b">
      <div class="alert ${cfg.configured ? 'info' : 'warn'}" style="margin-bottom:14px">
        ${cfg.configured ? `已配置：${esc(cfg.model)} @ ${esc(cfg.base_url)}`
          : '未配置外部接口，AI 按钮会退回「本地规则」生成（只能给出通用建议）'}
      </div>
      <div class="field"><label>常用服务商（一键填充地址与模型）</label>
        <select id="aiPreset">
          <option value="">— 选择服务商 —</option>
          ${PRESETS.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}
        </select></div>
      <div class="field"><label>接口地址（Base URL，末尾不带 /chat/completions）</label>
        <input id="aiBase" value="${esc(cfg.base_url)}" placeholder="https://api.deepseek.com/v1"></div>
      <div class="field"><label>模型名</label>
        <input id="aiModel" value="${esc(cfg.model)}" placeholder="deepseek-chat"></div>
      <div class="field"><label>API Key</label>
        <input id="aiKey" type="password" placeholder="${cfg.hasKey ? '已设置，留空则不修改' : 'sk-...'}"></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn" id="aiSave">保存</button>
        <button class="btn ghost" id="aiTest">测试连接</button>
        <button class="btn ghost" id="aiClear">清除 Key</button>
      </div>
      <div id="aiTestOut" style="margin-top:12px"></div>
      <div class="dim" style="font-size:11.5px;margin-top:14px;line-height:1.75">
        · 模型名必须与服务商匹配：「deepseek-chat」配 api.deepseek.com，不能配 api.openai.com<br>
        · 国内网络访问 api.openai.com 大多超时，建议用 DeepSeek / 通义 / 本地模型<br>
        · 内网可指向自建 vLLM / Ollama，数据不出网；若必须走代理，用
        <code>NODE_USE_ENV_PROXY=1 HTTPS_PROXY=http://127.0.0.1:7890 node server.js</code> 启动
      </div>
    </div>`;
  drawer.classList.add('open');
  $('#asClose').onclick = () => drawer.classList.remove('open');

  $('#aiPreset').onchange = e => {
    const p = PRESETS.find(x => x.id === e.target.value);
    if (!p || p.id === 'custom') return;
    $('#aiBase').value = p.base;
    $('#aiModel').value = p.model;
  };

  $('#aiTest').onclick = async () => {
    $('#aiTestOut').innerHTML = '<div class="alert info">正在测试…（最长 12 秒）</div>';
    try {
      const r = await api('/ai/test', {
        method: 'POST',
        body: { base_url: $('#aiBase').value.trim(), model: $('#aiModel').value.trim(), api_key: $('#aiKey').value.trim() },
      });
      $('#aiTestOut').innerHTML = `<div class="alert ${r.ok ? 'info' : 'bad'}">
        <div><b>${r.ok ? '连接成功' : '连接失败'}</b>　${esc(r.message)}</div>
        <div class="dim" style="font-size:11.5px;margin-top:4px">
          ${r.status ? 'HTTP ' + r.status + ' · ' : ''}${r.ms} ms
          ${r.models && r.models.length ? '<br>可用模型（前 8 个）：' + r.models.map(m => esc(m)).join('、') : ''}
        </div></div>`;
    } catch (e) {
      $('#aiTestOut').innerHTML = `<div class="alert bad">${esc(e.message)}</div>`;
    }
  };

  $('#aiSave').onclick = async () => {
    await api('/ai/config', {
      method: 'POST',
      body: { base_url: $('#aiBase').value.trim(), model: $('#aiModel').value.trim(), api_key: $('#aiKey').value.trim() },
    });
    toast('已保存', 'ok');
    drawer.classList.remove('open');
  };
  $('#aiClear').onclick = async () => {
    await api('/ai/config', { method: 'POST', body: { clear_key: true } });
    toast('已清除 Key');
    drawer.classList.remove('open');
  };
}

/* ------------------------------------------------------------------ 示意图 → 结构树 */
function openFromImage() {
  const drawer = $('#drawer');
  $('.drawer-box', drawer).innerHTML = `
    <div class="drawer-h">
      <div><h2>从示意图生成结构</h2>
        <p>粘贴产品剖面图/示意图 → 本机离线 OCR 识别零件名 → 生成结构树并写入 DFMEA</p></div>
      <button class="x" id="fiClose">✕</button>
    </div>
    <div class="drawer-b">
      <div id="fiDrop" style="border:2px dashed #C9D4E3;border-radius:10px;padding:26px;text-align:center;cursor:pointer;background:#FBFCFE">
        <div style="font-size:28px">🖼</div>
        <div style="margin-top:6px;font-weight:600">在此粘贴图片（Ctrl+V）或点击选择文件</div>
        <div class="dim" style="font-size:11.5px;margin-top:4px">支持 PNG / JPG；建议使用带引线与文字标注的剖面图</div>
        <input type="file" id="fiFile" accept="image/*" style="display:none">
      </div>
      <div id="fiPreview" style="margin-top:12px"></div>
      <div class="dim" style="font-size:11.5px;margin-top:8px;text-align:center">
        没有现成图纸？<a href="#" id="fiSample" style="color:var(--accent)">用示例图纸试一下</a>
      </div>
      <div id="fiBody"></div>
    </div>`;
  drawer.classList.add('open');
  $('#fiClose').onclick = () => drawer.classList.remove('open');

  let imageB64 = null;
  let labels = [];

  const drop = $('#fiDrop');
  drop.onclick = () => $('#fiFile').click();
  $('#fiFile').onchange = e => { const f = e.target.files[0]; if (f) readFile(f); };
  $('#fiSample').onclick = async (e) => {
    e.preventDefault();
    const resp = await fetch('/samples/resistor-drawing.png');
    const blob = await resp.blob();
    readFile(new File([blob], 'resistor-drawing.png', { type: 'image/png' }));
  };
  drawer.onpaste = e => {
    for (const it of (e.clipboardData || {}).items || []) {
      if (it.type && it.type.startsWith('image/')) { readFile(it.getAsFile()); e.preventDefault(); return; }
    }
  };

  function readFile(file) {
    const fr = new FileReader();
    fr.onload = async () => {
      imageB64 = fr.result;
      $('#fiPreview').innerHTML = `<div style="display:flex;gap:12px;align-items:flex-start">
        <img src="${imageB64}" style="max-width:320px;max-height:220px;border:1px solid var(--line);border-radius:8px;background:#fff">
        <div class="dim" style="font-size:12px">已载入，正在识别图上的文字…</div></div>`;
      try {
        const r = await api('/dfmea/ocr', { method: 'POST', body: { imageBase64: imageB64 } });
        labels = r.labels || [];
        renderLabels(r);
      } catch (err) {
        $('#fiBody').innerHTML = `<div class="alert bad" style="margin-top:12px">${esc(err.message)}</div>`;
      }
    };
    fr.readAsDataURL(file);
  }

  function renderLabels(r) {
    $('#fiBody').innerHTML = `
      <div class="card" style="margin-top:12px">
        <div class="card-h"><h3>识别到的结构词</h3>
          <span class="hint">共 ${labels.length} 个 · 可删可改</span></div>
        <div class="card-b">
          <div id="fiChips" style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px">
            ${labels.map((l, i) => `<span class="chip" style="padding:4px 10px">
              <input value="${esc(l)}" data-li="${i}" style="border:0;background:transparent;width:${Math.max(60, l.length * 15)}px;font-size:12px">
              <span data-del="${i}" style="cursor:pointer;color:#B91C1C;margin-left:4px">✕</span></span>`).join('')}
          </div>
          <div style="display:flex;gap:8px">
            <input id="fiNew" class="sel" placeholder="漏识别的零件名，回车添加" style="flex:1">
            <button class="btn ghost" id="fiAdd">添加</button>
          </div>
          ${r && r.raw ? `<div class="dim" style="font-size:11px;margin-top:8px">OCR 原始输出：${esc(r.raw)}</div>` : ''}
          <button class="btn" id="fiBuild" style="margin-top:12px">生成结构树预览</button>
        </div>
      </div>
      <div id="fiTree"></div>`;

    $$('[data-li]').forEach(inp => inp.oninput = () => { labels[+inp.dataset.li] = inp.value; });
    $$('[data-del]').forEach(x => x.onclick = () => { labels.splice(+x.dataset.del, 1); renderLabels({}); });
    $('#fiAdd').onclick = () => {
      const v = $('#fiNew').value.trim();
      if (!v) return;
      labels.push(v); renderLabels({});
    };
    $('#fiNew').onkeydown = e => { if (e.key === 'Enter') $('#fiAdd').click(); };
    $('#fiBuild').onclick = buildTree;
  }

  async function buildTree() {
    if (!labels.length) return toast('没有可用的结构词', 'err');
    try {
      const r = await api('/dfmea/tree', { method: 'POST', body: { labels } });
      const t = r.tree;
      $('#fiTree').innerHTML = `
        <div class="card" style="margin-top:12px">
          <div class="card-h"><h3>DFMEA 结构树预览</h3><span class="hint">${t.nodeCount} 个结构节点 · 不自动推断功能或失效</span></div>
          <div class="card-b">
            <div class="chain" style="gap:8px">
              <div class="chain-node design"><b>${esc(t.product)}</b><span class="tag">产品总成</span></div>
              ${t.nodes.map(g => `
                <div style="margin-left:26px;border-left:2px solid #D7E2F5;padding-left:14px;margin-top:8px">
                  <div class="chain-node proc" style="margin-bottom:6px"><b>${esc(g.name)}</b>
                    <div class="dim" style="font-size:11.5px;margin-top:2px">结构分组</div></div>
                  ${g.children.map(c => `<div class="chain-node step" style="margin:6px 0 6px 20px">
                    <b>${esc(c.name)}</b> <span class="tag">零件</span>
                    <div class="dim" style="font-size:11.5px;margin-top:2px">功能待 DFMEA 分析确认</div>
                  </div>`).join('')}
                </div>`).join('')}
            </div>
            ${t.unknown && t.unknown.length ? `<div class="alert warn" style="margin-top:12px">未归类的词：${t.unknown.join('、')}（会放入「其他零件」）</div>` : ''}
            <div style="display:flex;gap:8px;margin-top:14px">
              <button class="btn" id="fiApply">写入 DFMEA 结构</button>
              <button class="btn ghost" id="fiCancel">取消</button>
            </div>
          </div>
        </div>`;
      $('#fiCancel').onclick = () => $('#drawer').classList.remove('open');
      $('#fiApply').onclick = async () => {
        try {
          const res = await api('/dfmea/apply', { method: 'POST', body: { tree: t, labels, imageBase64: imageB64 } });
          toast(`已写入 ${res.added} 个结构节点，示意图已存档`, 'ok');
          $('#drawer').classList.remove('open');
          vFmea();
        } catch (e) { toast(e.message, 'err'); }
      };
      $('#fiTree').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } catch (e) { toast(e.message, 'err'); }
  }
}

async function openRow(rowId, data, focusNodeId, presetFuncId) {
  const isNew = !rowId;
  const r = isNew ? {
    row_id: '（新建）', s: 8, o: 5, d: 5, ap: 'M', fe_name: '', fm_name: '', fc_name: '',
    pc_text: '', dc_text: '', char_id: null, step_id: null, acts: [], decision: null,
    rationale: '', approved_by: '', review_due: '',
  } : data.rows.find(x => x.row_id === rowId);
  const isD = data.header.fmea_type === 'DFMEA';
  const nodes = data.nodes;
  const bySub = sub => nodes.filter(n => n.node_subtype === sub);
  const charData = await api('/project-chars');
  const charList = charData.items || [];
  const charDictionary = (charData.dictionary || []).filter(c => !c.imported);
  const steps = isD ? [] : (await api('/steps'));
  const upstreamRows = isD ? [] : await api('/fmea?type=DFMEA').then(x => x.rows || []).catch(() => []);
  const focusId = isNew ? (focusNodeId || null) : r.focus_node_id;
  const focusName = (nodes.find(n => n.node_id === focusId) || {}).name || '';
  const fnList = focusId
    ? (await api('/fmea/functions?node=' + encodeURIComponent(focusId))).list
      .filter(f => f.status === '正式' && !/^[（(]\s*待补充/.test(f.text))
    : [];

  const dl = (list, id) => `<datalist id="${id}">${list.map(n => `<option value="${esc(n.name)}">`).join('')}</datalist>`;

  const drawer = $('#drawer');
  $('.drawer-box', drawer).innerHTML = `
    <div class="drawer-h">
      <div><h2>${isNew ? '新建分析行' : esc(r.row_id)} <span class="mono" style="font-weight:400;font-size:12px">${isD ? 'DFMEA' : 'PFMEA'}</span></h2>
        <p>结构节点：${esc(focusName || '（未关联）')}</p></div>
      <button class="x" id="closeDrawer">✕</button>
    </div>
    <div class="drawer-b">
      <div class="analysis-function-context">
        <div class="field" style="flex:1;margin:0"><label>本行针对的功能</label>
          <select id="f_func">
            <option value="">— 未指定 —</option>
            ${fnList.map((f, i) => {
              const sel = r.func_id === f.func_id || presetFuncId === f.func_id;
              return `<option value="${f.func_id}" ${sel ? 'selected' : ''}>功能${i + 1}：${esc(f.text)}</option>`;
            }).join('')}
          </select>
        </div>
        ${fnList.length ? `<span class="badge b-ok">已关联 ${fnList.length} 条功能</span>`
          : `<button class="btn sm ghost" id="gotoFunc">先去生成功能</button>`}
      </div>
      <div class="row2">
        <div class="field"><label>失效影响 (FE) <span style="color:#B91C1C">*</span></label>
          <input id="f_fe" list="feList" value="${esc(r.fe_name || '')}" placeholder="失效对客户/整车的影响">
          ${dl(bySub('FE'), 'feList')}</div>
        <div class="field"><label>失效模式 (FM) <span style="color:#B91C1C">*</span></label>
          <input id="f_fm" list="fmList" value="${esc(r.fm_name || '')}" placeholder="该零件出了什么问题">
          ${dl(bySub('FM'), 'fmList')}</div>
      </div>
      <div class="field"><label>失效原因 (FC) <span style="color:#B91C1C">*</span></label>
        <input id="f_fc" list="fcList" value="${esc(r.fc_name || '')}" placeholder="为什么会发生">
        ${dl(bySub('FC'), 'fcList')}</div>
      <div class="row2">
        <div class="field"><label>关联产品特性（对应失效模式）</label><select id="f_char">
          <option value="">— 选择 —</option>
          <optgroup label="本项目 PFMEA / 特性使用记录">${charList.filter(c => c.char_kind === 'PRODUCT').map(c =>
            `<option value="${c.char_id}" ${c.char_id === r.char_id ? 'selected' : ''}>${c.char_id} ${esc(c.name)}${c.tol_text ? ' · ' + esc(c.tol_text) : ''}</option>`).join('')}</optgroup>
          <optgroup label="从产品族 / 产品系列字典引入">${charDictionary.filter(c => c.char_kind === 'PRODUCT').map(c =>
            `<option value="dict:${c.char_id}">${c.char_id} ${esc(c.name)} · ${c.series_id ? esc(c.series_name) : '产品族通用'}</option>`).join('')}</optgroup>
          <optgroup label="没有需要的新增"><option value="__new__">＋ 新增当前产品系列产品特性</option></optgroup>
        </select></div>
        <div class="field"><label>关联过程特性（对应失效原因）</label><select id="f_process_char">
          <option value="">— 选择过程特性 —</option>
          <optgroup label="本项目 PFMEA / 特性使用记录">${charList.filter(c => c.char_kind === 'PROCESS').map(c =>
            `<option value="${c.char_id}" ${c.char_id === r.process_char_id ? 'selected' : ''}>${c.char_id} ${esc(c.name)}${c.tol_text ? ' · ' + esc(c.tol_text) : ''}</option>`).join('')}</optgroup>
          <optgroup label="从产品族 / 产品系列字典引入">${charDictionary.filter(c => c.char_kind === 'PROCESS').map(c =>
            `<option value="dict:${c.char_id}">${c.char_id} ${esc(c.name)} · ${c.series_id ? esc(c.series_name) : '产品族通用'}</option>`).join('')}</optgroup>
          <optgroup label="没有需要的新增"><option value="__new__">＋ 新增当前产品系列过程特性</option></optgroup>
        </select></div>
      </div>

      <details class="analysis-advanced">
        <summary>高级关联与筛选</summary>
        <div class="row2" style="margin-top:10px">
          <div class="field"><label>筛选器代码（可选）</label><input id="f_filter" placeholder="如 LL / CC"></div>
          ${isD ? '' : `<div class="field"><label>关联工序（PFD）</label><select id="f_step">
            <option value="">— 选择 —</option>
            ${steps.map(s => `<option value="${s.step_id}" ${s.step_id === r.step_id ? 'selected' : ''}>${s.step_no} ${esc(s.name)}</option>`).join('')}
          </select></div>`}
        </div>
        ${isD ? '' : `<div class="field"><label>DFMEA 上游失效引用（可空）</label>
        <select id="f_upstream"><option value="">— 无 —</option>
          ${upstreamRows.map(row => `<option value="${row.row_id}" ${row.row_id === r.upstream_row_id ? 'selected' : ''}>${esc(row.row_id)} · ${esc(row.fe_name || '')} / ${esc(row.fm_name || '')}</option>`).join('')}
        </select></div>`}
      </details>

      <div class="field"><label>${isD ? '设计预防控制' : '现行预防控制 (PC)'} <span style="color:#B91C1C">*</span></label><textarea id="f_pc">${esc(r.pc_text || '')}</textarea></div>
      <div class="field"><label>${isD ? '设计验证控制' : '现行探测控制 (DC)'} <span style="color:#B91C1C">*</span></label><textarea id="f_dc">${esc(r.dc_text || '')}</textarea></div>

      <div class="dim" style="font-size:11.5px;margin-bottom:6px">失效影响分三个场景分别评级，<b>S 取三者最大值</b>（AIAG-VDA 手册 P41–44）</div>
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:10px">
        <div><div class="k" style="font-size:11px">S · 您的工厂 <a href="#" onclick="openRating('S','#f_sp');return false" style="color:var(--accent)">?</a></div>
          <input type="number" id="f_sp" min="1" max="10" value="${r.s_plant ?? ''}" placeholder="—"></div>
        <div><div class="k" style="font-size:11px">S · 发运至工厂 <a href="#" onclick="openRating('S','#f_ss');return false" style="color:var(--accent)">?</a></div>
          <input type="number" id="f_ss" min="1" max="10" value="${r.s_ship ?? ''}" placeholder="—"></div>
        <div><div class="k" style="font-size:11px">S · 最终用户 <a href="#" onclick="openRating('S','#f_su');return false" style="color:var(--accent)">?</a></div>
          <input type="number" id="f_su" min="1" max="10" value="${r.s_user ?? ''}" placeholder="—"></div>
      </div>
      <div class="sod">
        <div><div class="k">S 严重度（取最大）</div><input type="number" id="f_s" min="1" max="10" value="${r.s}" readonly
          style="background:#F7FAFF;font-weight:700"></div>
        <div><div class="k">O 发生度 <a href="#" onclick="openRating('O','#f_o');return false" style="color:var(--accent)">?</a></div><input type="number" id="f_o" min="1" max="10" value="${r.o}"></div>
        <div><div class="k">D 探测度 <a href="#" onclick="openRating('D','#f_d');return false" style="color:var(--accent)">?</a></div><input type="number" id="f_d" min="1" max="10" value="${r.d}"></div>
      </div>
      <div class="ap-box"><span class="lbl">实时 AP</span><span class="big" id="apLive">—</span>
        <span class="dim" style="font-size:11.5px">由 S/O/D 查矩阵得出（非 S×O×D）</span></div>

      <div style="margin-top:16px;display:flex;gap:8px;align-items:center">
        <button class="btn" id="saveRow">保存分析行</button>
        <button class="btn ghost" id="closeDrawer2">关闭</button>
        ${isNew ? '' : `<button class="btn ghost" id="delRow"
          style="margin-left:auto;color:#B91C1C;border-color:#F3C6C6">删除本行</button>`}
      </div>

      ${!isNew ? `<div style="margin-top:22px">
        <h3 style="font-size:13px;margin:0 0 8px">决策与措施</h3>
        <div class="alert ${r.decision ? 'info' : (r.ap === 'H' ? 'bad' : 'info')}">
          ${r.decision ? `已登记决定：<b>${r.decision === 'TAKE_ACTION' ? '采取措施' : r.decision === 'NO_ACTION' ? '经论证不采取措施' : '待评审'}</b>　批准：${esc(r.approved_by || '—')}` :
            (r.ap === 'H' ? '<b>AP=高，必须有处置决定</b>（采取措施，或经论证不采取措施 + 理由 + 批准人）'
              : `AP=${r.ap === 'M' ? '中' : '低'}，按手册不强制登记；如客户或企业规范要求，可直接选决定并登记。`)}
        </div>
        <div class="row2" style="margin-top:10px">
          <div class="field"><label>决定${r.ap === 'H' ? '<span style="color:#B91C1C">*</span>' : ''}</label><select id="d_decision">
            ${r.ap === 'H' ? '' : '<option value="">— 未决定 —</option>'}
            <option value="TAKE_ACTION" ${r.decision === 'TAKE_ACTION' || (r.ap === 'H' && !r.decision) ? 'selected' : ''}>采取措施</option>
            <option value="NO_ACTION" ${r.decision === 'NO_ACTION' ? 'selected' : ''}>经论证不采取措施${r.ap === 'H' ? '（需 ≥30 字理由 + 批准人）' : ''}</option>
            ${r.ap === 'H' ? '' : `<option value="PENDING" ${r.decision === 'PENDING' ? 'selected' : ''}>待评审</option>`}
          </select></div>
          <div class="field"><label>批准人（由审批动作写入）</label><input id="d_by" readonly
            value="${esc(r.approved_by || state.user?.display_name || '')}" title="批准人取当前登录账号，不能手工指定"></div>
        </div>
        <div class="field"><label>理由（不采取措施时至少 30 字）</label><textarea id="d_why">${esc(r.rationale || '')}</textarea></div>
        <div class="row2"><div class="field"><label>复审日期</label><input type="date" id="d_due" value="${esc(r.review_due || '')}"></div>
          <div class="field"><label>决定状态</label><select id="d_status">
            <option value="待评审" ${r.dstatus === '待评审' ? 'selected' : ''}>待评审</option>
            <option value="已批准" ${r.dstatus === '已批准' ? 'selected' : ''}>已批准</option>
          </select></div></div>
        <button class="btn sm" id="saveDecision">登记决定</button>

        <table class="t" style="margin-top:16px"><thead><tr><th>措施</th><th>责任人</th><th>目标</th><th>状态</th><th>措施后 AP</th><th>操作</th></tr></thead><tbody>
          ${r.acts.length ? r.acts.map(a => `<tr><td>${esc(a.description)}</td><td>${esc(a.owner)}</td><td class="mono">${esc(a.due_date)}</td>
            <td>${statusBadge(a.status)}</td><td>${a.ap_after ? apBadge(a.ap_after) : '—'}</td>
            <td><button class="btn sm ghost" data-act-status="${a.action_id}">更新</button></td></tr>`).join('')
            : '<tr><td colspan="6" class="dim">暂无措施</td></tr>'}
        </tbody></table>

        <div class="card" style="margin-top:12px">
          <div class="card-h"><h3>新增措施</h3><span class="hint">措施后重评会自动算 AP</span></div>
          <div class="card-b">
            <div class="row2"><div class="field"><label>措施描述</label><input id="a_desc"></div>
              <div class="field"><label>责任人</label><input id="a_owner" placeholder="措施责任人"></div></div>
            <div class="row3"><div class="field"><label>类型</label><select id="a_type"><option>预防</option><option>探测</option></select></div>
              <div class="field"><label>目标日期</label><input type="date" id="a_due" value="2027-03-31"></div>
              <div class="field"><label>状态</label><select id="a_status"><option>开放的</option><option>尚未决定</option><option>尚未执行</option><option>已完成</option><option>不执行</option></select></div></div>
            <div class="field"><label>基于证据的措施（文档编号/报告名称/日期）</label><input id="a_evidence" placeholder="如 WI-2026-031 / 压力曲线验证报告 2026-11-20"></div>
            <div class="row3"><div class="field"><label>措施后 S</label><input type="number" id="a_s" min="1" max="10"></div>
              <div class="field"><label>措施后 O</label><input type="number" id="a_o" min="1" max="10"></div>
              <div class="field"><label>措施后 D</label><input type="number" id="a_d" min="1" max="10"></div></div>
            <button class="btn sm" id="addAction">添加措施</button>
          </div>
        </div>
      </div>` : ''}
    </div>`;

  drawer.classList.add('open');
  const gbtn = document.getElementById('gotoFunc'); if (gbtn) gbtn.onclick = () => { drawer.classList.remove('open'); openFunctions(focusId, focusName); };
  const close = () => drawer.classList.remove('open');
  $('#closeDrawer').onclick = close;
  $('#closeDrawer2').onclick = close;

  const sceneMax = () => {
    const v = ['#f_sp', '#f_ss', '#f_su'].map(s => +($(s) && $(s).value) || 0);
    return Math.max(...v, 0);
  };
  const syncS = () => {
    const m = sceneMax();
    if (m) { $('#f_s').value = m; return m; }
    return +$('#f_s').value || 0;
  };
  const liveAp = () => {
    const s = syncS() || +$('#f_s').value;
    const o = +$('#f_o').value, d = +$('#f_d').value;
    const map = AP_MATRIX(s, o, d);
    $('#apLive').innerHTML = map
      ? `<span class="badge b-${map}">${map === 'H' ? '高 H' : map === 'M' ? '中 M' : '低 L'}</span>`
      : '<span class="dim" title="AP 以服务端保存结果为准">保存后由服务端判定</span>';
  };
  ['#f_sp', '#f_ss', '#f_su', '#f_o', '#f_d'].forEach(sel => { if ($(sel)) $(sel).oninput = liveAp; });
  liveAp();

  const bindQuickCharacter = (selector, kind) => {
    const element = $(selector);
    if (!element) return;
    let previous = element.value;
    element.addEventListener('focus', () => { previous = element.value === '__new__' ? previous : element.value; });
    element.addEventListener('change', () => {
      if (element.value !== '__new__') {
        previous = element.value;
        return;
      }
      element.value = previous || '';
      openQuickCharacter(kind, created => {
        if (![...element.options].some(option => option.value === created.char_id)) {
          const option = document.createElement('option');
          option.value = created.char_id;
          option.textContent = `${created.char_id} ${created.name} · 当前项目新增`;
          element.appendChild(option);
        }
        element.value = created.char_id;
        previous = created.char_id;
      });
    });
  };
  bindQuickCharacter('#f_char', 'PRODUCT');
  bindQuickCharacter('#f_process_char', 'PROCESS');

  const resolveCharacteristic = async selector => {
    const element = $(selector);
    const value = element ? element.value : '';
    if (!value || !value.startsWith('dict:')) return value || null;
    const imported = await api('/project-chars/from-dictionary', {
      method: 'POST',
      body: { char_id: value.slice(5), note: 'PFMEA 从产品族/系列字典引入' },
    });
    return imported.item.char_id;
  };

  $('#saveRow').onclick = async () => {
    try {
      const fe = $('#f_fe').value.trim(), fm = $('#f_fm').value.trim(), fc = $('#f_fc').value.trim();
      const pc = $('#f_pc').value.trim(), dc = $('#f_dc').value.trim();
      const ph = /^[（(]\s*待补充\s*[）)]$/;
      const bad = [];
      const req = [['#f_fe', fe, '失效影响'], ['#f_fm', fm, '失效模式'], ['#f_fc', fc, '失效原因'],
        ['#f_pc', pc, '现行预防控制'], ['#f_dc', dc, '现行探测控制']];
      for (const x of req) {
        const el = $(x[0]);
        const ok = x[1] && !ph.test(x[1]);
        el.style.borderColor = ok ? '' : '#DC2626';
        el.style.background = ok ? '' : '#FEF2F2';
        if (!ok) bad.push(x[2]);
      }
      if (bad.length) throw new Error('必填项未完成：' + bad.join('、'));
      const body = {
        row_id: isNew ? null : r.row_id, fmea_type: data.header.fmea_type,
        focus_node_id: focusId || null,
        fe_text: fe, fm_text: fm, fc_text: fc,
        char_id: await resolveCharacteristic('#f_char'),
        process_char_id: await resolveCharacteristic('#f_process_char'),
        s: syncS() || +$('#f_s').value, o: +$('#f_o').value, d: +$('#f_d').value,
        s_plant: $('#f_sp') && $('#f_sp').value !== '' ? +$('#f_sp').value : null,
        s_ship: $('#f_ss') && $('#f_ss').value !== '' ? +$('#f_ss').value : null,
        s_user: $('#f_su') && $('#f_su').value !== '' ? +$('#f_su').value : null,
        pc_text: $('#f_pc').value, dc_text: $('#f_dc').value,
        func_id: $('#f_func') ? ($('#f_func').value || null) : null,
        upstream_row_id: !isD && $('#f_upstream') ? ($('#f_upstream').value || null) : null,
        filter_code: ($('#f_filter') ? $('#f_filter').value.trim() : '') || null,
      };
      if (!isD && $('#f_step')) body.step_id = $('#f_step').value || null;
      const res = await api('/fmea/row', { method: 'POST', body });
      toast(res.downgraded
        ? `已保存，AP = ${res.ap}；${res.message}`
        : '已保存，AP = ' + res.ap, res.downgraded ? 'warn' : 'ok');
      close(); vFmea();
    } catch (e) { toast(e.message, 'err'); }
  };

  /* ---------------- 删除本行（二次确认，避免误删） ---------------- */
  if ($('#delRow')) {
    let armed = false;
    $('#delRow').onclick = async () => {
      const btn = $('#delRow');
      if (!armed) {
        armed = true;
        btn.textContent = '再点一次确认删除';
        btn.style.background = '#FEF2F2';
        btn.style.borderColor = '#B91C1C';
        setTimeout(() => {
          if (!armed) return;
          armed = false;
          btn.textContent = '删除本行';
          btn.style.background = '';
          btn.style.borderColor = '#F3C6C6';
        }, 5000);
        return;
      }
      try {
        await api('/fmea/row/' + encodeURIComponent(r.row_id), { method: 'DELETE' });
        toast('已删除 ' + r.row_id, 'ok');
        close(); vFmea();
      } catch (e) { toast(e.message, 'err'); }
    };
  }

  /* ---------------- AI 分析：候选可编辑，采用后填入本行表单 ---------------- */
  if ($('#aiGen')) $('#aiGen').onclick = async () => {
    const out = $('#aiOut');
    if (!focusName) { out.innerHTML = '<div class="alert warn">该行未关联结构节点，无法按结构生成</div>'; return; }
    const selectedFuncId = $('#f_func') ? $('#f_func').value : '';
    if (!selectedFuncId) {
      out.innerHTML = '<div class="alert warn">请先选择已采用的正式功能，再生成失效候选</div>';
      return;
    }
    out.innerHTML = '<div class="dim" style="font-size:12px">正在生成候选失效…</div>';
    let res;
    try {
      res = await api('/ai/suggest', {
        method: 'POST',
        body: {
          node: focusName,
          node_id: focusId,
          func_id: selectedFuncId,
          product: state.meta.project.name,
          func: (fnList.find(f => f.func_id === selectedFuncId) || {}).text || '',
        },
      });
    } catch (e) {
      out.innerHTML = `<div class="alert bad">${esc(e.message)}</div>`;
      return;
    }
    const src = res.source === 'ai' ? '<span class="badge b-ok">外部 AI</span>'
      : res.source === 'error' ? '<span class="badge b-bad">调用失败</span>'
        : '<span class="badge b-warn">本地规则</span>';
    if (!res.failures || !res.failures.length) {
      out.innerHTML = `<div class="alert ${res.source === 'error' ? 'bad' : 'warn'}">${src} ${esc(res.note || '未生成候选')}</div>`;
      return;
    }
    out.innerHTML = `
      <div style="font-size:11.5px;margin-bottom:6px">${src} <span class="dim">${esc(res.note || '')} — 文字可直接修改后再采用</span></div>
      <table class="t" style="table-layout:fixed"><thead><tr><th style="width:28%">失效影响</th><th style="width:20%">失效模式</th><th style="width:30%">失效原因</th><th class="num" style="width:52px">S</th><th style="width:66px"></th></tr></thead>
      <tbody>${res.failures.map((f, i) => `<tr>
        <td><textarea data-fx="${i}" data-k="effect" rows="3" placeholder="（待补充）">${esc(f.effect || '')}</textarea></td>
        <td><textarea data-fx="${i}" data-k="mode" rows="3">${esc(f.mode || '')}</textarea></td>
        <td><textarea data-fx="${i}" data-k="cause" rows="3" placeholder="（待补充）">${esc(f.cause || '')}</textarea></td>
        <td class="num"><input data-fx="${i}" data-k="s" type="number" min="1" max="10" value="${f.s || 8}" style="width:46px;font-size:11.5px"></td>
        <td><button class="btn sm" data-use="${i}">采用</button></td></tr>`).join('')}
      </tbody></table>
      <div class="dim" style="font-size:11px;margin-top:6px">采用后只填入下方表单，仍需点「保存分析行」才写库；O/D 需按实际控制重新评分。</div>`;

    $$('[data-use]').forEach(b => b.onclick = () => {
      const i = b.dataset.use;
      const get = k => document.querySelector(`[data-fx="${i}"][data-k="${k}"]`).value;
      $('#f_fe').value = get('effect') || '';
      $('#f_fm').value = get('mode') || '';
      $('#f_fc').value = get('cause') || '';
      $('#f_s').value = get('s') || 8;
      liveAp();
      $('#f_fm').scrollIntoView({ behavior: 'smooth', block: 'center' });
      toast('已填入本行，检查后保存', 'ok');
    });
  };

  if ($('#saveDecision')) $('#saveDecision').onclick = async () => {
    try {
      await api('/fmea/decision', {
        method: 'POST', body: {
          row_id: r.row_id, decision: $('#d_decision').value, rationale: $('#d_why').value,
          review_due: $('#d_due').value,
          status: $('#d_status') ? $('#d_status').value : '待评审',
        },
      });
      toast('决定已登记', 'ok'); close(); vFmea();
    } catch (e) { toast(e.message, 'err'); }
  };

  if ($('#addAction')) $('#addAction').onclick = async () => {
    try {
      const res = await api('/fmea/action', {
        method: 'POST', body: {
          row_id: r.row_id, description: $('#a_desc').value, owner: $('#a_owner').value,
          action_type: $('#a_type').value, due_date: $('#a_due').value, status: $('#a_status').value,
          s_after: $('#a_s').value || null, o_after: $('#a_o').value || null, d_after: $('#a_d').value || null,
          evidence_ref: ($('#a_evidence') ? $('#a_evidence').value : '') || '',
        },
      });
      toast('措施已添加' + (res.ap_after ? '，措施后 AP = ' + res.ap_after : ''), 'ok');
      close(); vFmea();
    } catch (e) { toast(e.message, 'err'); }
  };
  $$('[data-act-status]').forEach(button => button.onclick = async () => {
    const action = r.acts.find(item => String(item.action_id) === button.dataset.actStatus);
    if (!action) return;
    const result = await showFormDialog({
      title: '更新措施状态',
      fields: [
        {
          key: 'status', label: '措施状态', type: 'select', value: action.status || '开放的',
          options: ['开放的', '尚未决定', '尚未执行', '已完成待验证', '已完成', '不执行'],
        },
        { key: 'evidence_ref', label: '证据引用', type: 'textarea', rows: 3, value: action.evidence_ref || '' },
        {
          key: 'effect_verified', label: '有效性已验证', type: 'select',
          value: action.effect_verified ? 'yes' : 'no',
          options: [{ value: 'yes', label: '是' }, { value: 'no', label: '否' }],
        },
      ],
      confirmText: '保存状态',
    });
    if (!result) return;
    try {
      const result = await api('/fmea/action/' + action.action_id, {
        method: 'PATCH',
        body: {
          status: result.status,
          evidence_ref: result.evidence_ref,
          effect_verified: result.effect_verified === 'yes',
        },
      });
      toast('措施状态已更新为 ' + result.status, 'ok');
      close(); vFmea();
    } catch (e) { toast(e.message, 'err'); }
  });

  /* ---------------- 失效候选：持久化，一条功能可多条失效 ---------------- */
  const renderCands = async () => {
    try {
    const funcId = $('#f_func') ? $('#f_func').value : '';
    if (!focusId) { $('#aiOut').innerHTML = '<div class="alert warn">该行未关联结构节点</div>'; return; }
    const { list } = await api(`/fmea/failure-cands?node=${encodeURIComponent(focusId)}${funcId ? '&func=' + encodeURIComponent(funcId) : ''}`);
    if (!list.length) {
      $('#aiOut').innerHTML = '<div class="dim" style="font-size:12px">该功能下还没有候选失效，点「AI 分析」生成（生成后会保存，下次打开仍在）</div>';
      return;
    }
    const pending = list.filter(c => c.status === '候选');
    const adopted = list.filter(c => c.status === '已采用');
    const adoptedHtml = adopted.length ? `
      <div style="margin-top:14px">
        <div style="font-size:11.5px;margin-bottom:6px">已采用为分析行（${adopted.length} 条）
          <span class="dim">— 点「打开该行」继续改失效影响/模式/原因/控制/评分</span></div>
        ${adopted.map(c => `<div style="display:flex;align-items:center;gap:8px;padding:8px 10px;
             border:1px solid #BBF7D0;background:#F0FDF4;border-radius:8px;margin-bottom:6px;font-size:12px">
          <span class="badge b-ok">已采用</span>
          <span style="flex:1">${esc(c.mode || '')}</span>
          <span class="mono dim" style="font-size:11px">${esc(c.row_id || '')}</span>
          ${c.row_id ? `<button class="btn sm" data-open-row="${c.row_id}">打开该行</button>` : ''}
        </div>`).join('')}
      </div>` : '';
    $('#aiOut').innerHTML = `
      <div style="font-size:11.5px;margin-bottom:8px">候选失效（${pending.length} 条待采用）
        <span class="dim">— 一条采用就是一行分析；已采用的不再删除，仍可打开编辑</span></div>
      ${pending.length ? '' : '<div class="dim" style="font-size:12px">没有待采用的候选</div>'}
      ${pending.map((c, i) => `
        <div style="border:1px solid var(--line);border-radius:10px;padding:11px;margin-bottom:10px;background:#fff">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:9px">
            <span class="badge b-gray">候选 ${i + 1}</span>
            <span class="dim" style="font-size:11px">S</span>
            <input data-cd="${c.cand_id}" data-k="s" type="number" min="1" max="10" value="${c.s}" style="width:50px">
            <span style="margin-left:auto">
              <button class="btn sm" data-adopt="${i}">采用</button>
              <button class="btn sm ghost" data-drop="${c.cand_id}" style="color:#B91C1C;border-color:#F3C6C6">删除</button>
            </span>
          </div>
          <div class="field" style="margin-bottom:8px">
            <label style="font-size:11px;color:var(--ink3)">失效影响</label>
            <textarea data-cd="${c.cand_id}" data-k="effect" rows="2" placeholder="（待补充）">${esc(c.effect || '')}</textarea>
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px">
            <div class="field"><label style="font-size:11px;color:var(--ink3)">失效模式</label>
              <textarea data-cd="${c.cand_id}" data-k="mode" rows="2">${esc(c.mode || '')}</textarea></div>
            <div class="field"><label style="font-size:11px;color:var(--ink3)">失效原因</label>
              <textarea data-cd="${c.cand_id}" data-k="cause" rows="2" placeholder="（待补充）">${esc(c.cause || '')}</textarea></div>
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
            <div class="field"><label style="font-size:11px;color:var(--ink3)">现行预防控制 PC</label>
              <textarea data-cd="${c.cand_id}" data-k="pc" rows="2" placeholder="防止该原因发生">${esc(c.pc || '')}</textarea></div>
            <div class="field"><label style="font-size:11px;color:var(--ink3)">现行探测控制 DC</label>
              <textarea data-cd="${c.cand_id}" data-k="dc" rows="2" placeholder="发生后如何检出">${esc(c.dc || '')}</textarea></div>
          </div>
        </div>`).join('')}
      <div class="dim" style="font-size:11px">采用后自动建 FE/FM/FC 节点并写入工作表，O/D 默认 5/5 需按实际控制重评。</div>
      ${adoptedHtml}`;
    attachCandHandlers(pending);
    document.querySelectorAll('[data-open-row]').forEach(b => {
      b.onclick = () => {
        const rid = b.dataset.openRow;
        const rr = (data.rows || []).find(x => x.row_id === rid);
        if (rr) { document.getElementById('drawer').classList.remove('open'); openRow(rid, data); }
        else toast('该行已不存在，可能被删除', 'err');
      };
    });
    } catch (err) {
      const box = $('#aiOut');
      if (box) box.innerHTML = `<div class="alert bad">候选加载失败：${esc(err.message)}</div>`;
    }
  };

  const readCand = (candId) => {
    const g = k => (document.querySelector(`[data-cd="${candId}"][data-k="${k}"]`) || {}).value;
    return {
      effect: (g('effect') || '').trim(), mode: (g('mode') || '').trim(),
      cause: (g('cause') || '').trim(), s: +g('s') || 8,
      pc: (g('pc') || '').trim(), dc: (g('dc') || '').trim(),
    };
  };

  const attachCandHandlers = (list) => {
    $$('[data-cd]').forEach(el => el.onblur = async () => {
      const v = readCand(el.dataset.cd);
      await api('/fmea/failure-cands/' + encodeURIComponent(el.dataset.cd), { method: 'PATCH', body: v });
    });
    $$('[data-drop]').forEach(b => b.onclick = async () => {
      await api('/fmea/failure-cands/' + encodeURIComponent(b.dataset.drop), { method: 'DELETE' });
      toast('已删除候选'); renderCands();
    });
    $$('[data-adopt]').forEach(b => b.onclick = async () => {
      const c = list[+b.dataset.adopt];
      const v = readCand(c.cand_id);
      if (!v.effect || !v.mode || !v.cause || !v.pc || !v.dc) {
        return toast('采用前必须补全影响、模式、原因、PC 和 DC', 'err');
      }
      try {
        const res = await api('/fmea/row-from-text', {
          method: 'POST',
          body: {
            focus_node_id: focusId, effect: v.effect, mode: v.mode, cause: v.cause,
            s: v.s, o: 5, d: 5, fmea_type: state.fmeaType,
            pc_text: v.pc, dc_text: v.dc,
            func_id: c.func_id || ($('#f_func') ? $('#f_func').value : null) || null,
          },
        });
        await api('/fmea/failure-cands/' + encodeURIComponent(c.cand_id), { method: 'PATCH', body: { status: '已采用', row_id: res.row_id } });
        toast(`已生成分析行 ${res.row_id}（AP=${res.ap}）`, 'ok');
        renderCands(); vFmea();
      } catch (e) { toast(e.message, 'err'); }
    });
  };

  if ($('#aiGen')) {
    $('#aiGen').onclick = async () => {
      const out = $('#aiOut');
      if (!focusName) { out.innerHTML = '<div class="alert warn">该行未关联结构节点</div>'; return; }
      if (!$('#f_func') || !$('#f_func').value) {
        out.innerHTML = '<div class="alert warn">请先选择已采用的正式功能，再生成失效候选</div>';
        return;
      }
      out.innerHTML = '<div class="dim" style="font-size:12px">正在生成候选失效…（最长 25 秒）</div>';
      try {
        const r = await api('/ai/suggest', {
          method: 'POST',
          body: {
            node: focusName,
            product: state.meta.project.name,
            func: (fnList.find(f => f.func_id === $('#f_func').value) || {}).text || '',
            node_id: focusId,
            func_id: $('#f_func').value || null,
          },
        });
        if (r.source === 'error') { out.innerHTML = `<div class="alert bad">${esc(r.note)}</div>`; return; }
        await renderCands();
        const note = document.createElement('div');
        note.className = 'dim';
        note.style.fontSize = '11px';
        note.textContent = r.note || '';
        out.prepend(note);
      } catch (e) { out.innerHTML = `<div class="alert bad">${esc(e.message)}</div>`; }
    };
  }
  if ($('#f_func')) $('#f_func').onchange = () => renderCands();
  if ($('#aiOut')) renderCands();
}

/* F-02：AP 只由后端矩阵决定；前端仅做查表预览，不再维护第二份规则 */
function AP_MATRIX(s, o, d) {
  const matrix = state.apMatrix;
  if (!matrix || !matrix.size) return null;
  return matrix.get(`${s}-${o}-${d}`) || null;
}

/* ------------------------------------------------------------------ PFD */
async function vPfd(options = {}) {
  const mode = state.pfdMode === 'INITIAL' ? 'INITIAL' : 'PROCESS';
  const preservedScrollY = options.preserveView ? window.scrollY : null;
  const previousMaintenanceScroll = options.preserveView ? $('.pfd-maintenance-scroll') : null;
  const preservedMaintenanceTop = previousMaintenanceScroll ? previousMaintenanceScroll.scrollTop : 0;
  const preservedMaintenanceLeft = previousMaintenanceScroll ? previousMaintenanceScroll.scrollLeft : 0;
  const [steps, pfdEvidence] = await Promise.all([
    api('/steps?mode=' + mode), mode === 'PROCESS' ? api('/ppap/evidence/5').catch(() => null) : null,
  ]);
  const evidenceByStep = new Map(((pfdEvidence && pfdEvidence.pfd && pfdEvidence.pfd.steps) || [])
    .map(step => [step.step_id, step]));
  const activeStepIds = new Set(steps.map(step => step.step_id));
  const childrenByParent = new Map();
  steps.forEach(step => {
    if (!step.parent_step_id) return;
    if (!childrenByParent.has(step.parent_step_id)) childrenByParent.set(step.parent_step_id, []);
    childrenByParent.get(step.parent_step_id).push(step);
  });
  childrenByParent.forEach(children => children.sort((a, b) => (+a.seq || 0) - (+b.seq || 0)));
  const topSteps = steps.filter(step =>
    !step.parent_step_id || !activeStepIds.has(step.parent_step_id));
  const editorSteps = [];
  topSteps.forEach((step, index) => {
    const baseMatch = String(step.step_no || '').match(/\d+/);
    const baseNo = (baseMatch ? baseMatch[0] : String((index + 1) * 10)).padStart(3, '0');
    editorSteps.push({
      ...step,
      display_step_no: `OP${baseNo}`,
      base_step_no: baseNo,
      depth: 0,
      child_count: (childrenByParent.get(step.step_id) || []).length,
    });
    (childrenByParent.get(step.step_id) || []).forEach((child, childIndex) => {
      editorSteps.push({
        ...child,
        display_step_no: `${baseNo}-${childIndex + 1}`,
        base_step_no: baseNo,
        parent_name: step.name,
        depth: 1,
        child_count: 0,
      });
    });
  });
  const stepsView = editorSteps.map(step =>
    Object.assign({}, evidenceByStep.get(step.step_id) || {}, step));
  const typeMeta = {
    '制造': { cls: 'manufacture', label: '制造' },
    '工序': { cls: 'manufacture', label: '制造' },
    '检验': { cls: 'inspection', label: '检验' },
    '特殊过程': { cls: 'special', label: '特殊过程' },
    '存储': { cls: 'storage', label: '存储' },
    '搬运': { cls: 'transport', label: '搬运' },
  };
  const metaOf = step => typeMeta[step.step_type] || typeMeta['制造'];
  const viewChildrenByParent = new Map();
  stepsView.forEach(step => {
    if (!step.parent_step_id) return;
    if (!viewChildrenByParent.has(step.parent_step_id)) viewChildrenByParent.set(step.parent_step_id, []);
    viewChildrenByParent.get(step.parent_step_id).push(step);
  });
  const activityOf = step => step.step_type === '特殊过程' ? 'manufacture' : metaOf(step).cls;
  const matrixActivities = step => {
    const family = step.depth === 0 ? [step, ...(viewChildrenByParent.get(step.step_id) || [])] : [step];
    return new Set(family.map(activityOf));
  };
  const activitySymbol = (activities, type, label) =>
    activities.has(type) ? `<i class="pfd-activity ${type}" title="${label}"></i>` : '';
  const renderMatrixRow = step => {
    const meta = metaOf(step);
    const activities = matrixActivities(step);
    const specialChars = step.special_characteristics || [];
    return `<tr class="${step.depth ? 'pfd-matrix-substep' : 'pfd-matrix-op'}" data-pfd-focus="${esc(step.step_id)}">
      <td class="pfd-matrix-seq"><button class="pfd-matrix-stepno" data-pfd-focus="${esc(step.step_id)}">${esc(step.display_step_no)}</button></td>
      <td class="pfd-activity-cell">${activitySymbol(activities, 'manufacture', '制造')}</td>
      <td class="pfd-activity-cell">${activitySymbol(activities, 'storage', '存储')}</td>
      <td class="pfd-activity-cell">${activitySymbol(activities, 'transport', '搬运')}</td>
      <td class="pfd-activity-cell">${activitySymbol(activities, 'inspection', '检测')}</td>
      <td><button class="pfd-matrix-desc" data-pfd-focus="${esc(step.step_id)}">
        <b>${esc(step.name)}</b>
        <small>${step.depth ? `工步 · ${esc(step.parent_name || '')}` : `${step.child_count || 0} 个工步 · ${meta.label}`}</small>
        ${!isInitial && step.origin_step_id
          ? `<small class="pfd-origin-tag" title="来源 P1-10 初始流程图">↳ P1-10 ${esc(step.origin_step_no || '')}</small>`
          : ''}
      </button></td>
      <td><span class="pfd-row-flow">
        <b class="${step.input_desc ? '' : 'is-empty'}">${esc(step.input_desc || '未维护')}</b>
        <i>→</i>
        <b class="${step.output_desc ? '' : 'is-empty'}">${esc(step.output_desc || '未维护')}</b>
      </span></td>
      <td><span class="pfd-device-cell"><b>${esc(step.equipment || '—')}</b>${step.fixture ? `<small>夹具：${esc(step.fixture)}</small>` : ''}</span></td>
      ${isInitial ? '' : `<td><span class="pfd-product-chars">${specialChars.length
        ? specialChars.map(char => `<em>${specBadge(1, char.special_symbol)} ${esc(char.name)}</em>`).join('')
        : '<span class="dim">—</span>'}</span></td>`}
    </tr>`;
  };
  const typeCount = type => stepsView.filter(step => step.step_type === type).length;
  const totalProcessRows = stepsView.length;
  const manufacturingCount = typeCount('制造') + typeCount('工序') + typeCount('特殊过程');
  const published = stepsView.filter(step => step.status === '已发布').length;
  const childStepCount = editorSteps.filter(step => step.depth === 1).length;
  const project = (state.meta && state.meta.project) || {};
  const projectName = project.name || '当前项目';
  const projectCode = project.code || project.project_id || '';
  const renderStepDetail = (step, meta) => {
    const specialChars = step.special_characteristics || [];
    const locked = step.status === '已发布';
    const readOnly = locked ? 'readonly' : '';
    return `<article class="pfd-step-detail" data-pfd-detail="${esc(step.step_id)}" hidden>
      <div class="pfd-detail-head">
        <span class="pfd-detail-no">${esc(step.display_step_no)}</span>
        <div class="pfd-detail-title">
          <h4>${esc(step.name)}</h4>
          <p><i class="pfd-type-dot ${meta.cls}"></i>${step.depth ? `工步 · 所属 ${esc(step.parent_name || '')}` : 'OP 工序'} · ${meta.label} · ${statusBadge(step.status)}</p>
        </div>
        <div class="pfd-detail-actions">
          <button class="btn ghost pfd-detail-edit" data-pfd-edit="${esc(step.step_id)}">编辑</button>
          <button class="btn pfd-detail-save" data-pfd-detail-save="${esc(step.step_id)}" ${locked ? 'disabled title="已发布工序需先撤回发布"' : ''}>保存</button>
        </div>
      </div>
      <div class="pfd-detail-form-grid">
        <label class="pfd-detail-field pfd-detail-field-wide"><span>工序 / 工步名称</span>
          <input data-pfd-detail-field="name" value="${esc(step.name)}" ${readOnly}>
        </label>
        <label class="pfd-detail-field"><span>类型</span>
          <select data-pfd-detail-field="step_type" ${locked ? 'disabled' : ''}>
            ${['工序', '检验', '特殊过程', '存储', '搬运'].map(type =>
              `<option ${type === step.step_type ? 'selected' : ''}>${type}</option>`).join('')}
          </select>
        </label>
      </div>
      <div class="pfd-detail-flow">
        <label><span>输入</span><textarea data-pfd-detail-field="input_desc" rows="3" ${readOnly} placeholder="未维护输入">${esc(step.input_desc || '')}</textarea></label>
        <i>→</i>
        <label><span>输出</span><textarea data-pfd-detail-field="output_desc" rows="3" ${readOnly} placeholder="未维护输出">${esc(step.output_desc || '')}</textarea></label>
      </div>
      <div class="pfd-detail-meta">
        <label><span>设备</span><input data-pfd-detail-field="equipment" value="${esc(step.equipment || '')}" ${readOnly} placeholder="未维护"></label>
        <label><span>工装治具</span><input data-pfd-detail-field="fixture" value="${esc(step.fixture || '')}" ${readOnly} placeholder="未维护"></label>
        ${isInitial ? '' : `<div><span>关联 FMEA 行</span><b>${step.fmea_rows || 0}</b></div>`}
        <div><span>工序 ID</span><b class="mono">${esc(step.step_id)}</b></div>
      </div>
      ${specialChars.length ? `<div class="pfd-detail-special">
        <span>特殊特性</span>
        <div>${specialChars.map(char => `<em>${specBadge(1, char.special_symbol)} ${esc(char.name)}</em>`).join('')}</div>
      </div>` : ''}
    </article>`;
  };
  const isInitial = mode === 'INITIAL';
  const flowLabel = isInitial ? 'P1-10 初始流程图' : 'P3-04 过程流程图（PFD）';
  const stageLabel = isInitial ? '阶段 1 · 策划和定义项目' : '阶段 3 · 过程设计和开发';
  $('#viewSub').textContent = `${stageLabel} · ${flowLabel} · ${topSteps.length} 个 OP · ${childStepCount} 个工步 · ${published} 项已发布`;
  $('#view').innerHTML = `
    <div class="pfd-stage-context">
      <button class="pfd-stage-back" id="pfdStageBack">阶段 ${isInitial ? '1' : '3'}</button>
      <span>›</span><b>${flowLabel}</b>
      <small>${isInitial ? '初始宏观工序路线，不直接进入 PFMEA 或控制计划' : '正式过程分解，向 PFMEA、控制计划和作业文件传递'}</small>
    </div>
    <div class="pfd-commandbar">
      <div><span class="lbl">${isInitial ? 'APQP DELIVERABLE · P1-10' : 'APQP DELIVERABLE · P3-04'}</span><h2>${flowLabel}</h2></div>
      <div class="fmea-mode-actions">
        ${isInitial ? '' : `<button class="btn ghost" id="btnDeriveFromInitial">从初始流程图派生</button>
        <button class="btn ghost" id="btnPfdConsistency">一致性检查</button>`}
        <button class="btn ghost" id="btnDictStep">引用字典工序</button>
        <button class="btn ghost" onclick="openPfdOcr()">从图片识别</button>
        <button class="btn" id="btnAddStep">＋新增工序</button>
      </div>
    </div>
    <div class="pfd-kpis">
      <div><span>工序 / 工步总数</span><b>${totalProcessRows}</b><small>${topSteps.length} 个 OP · ${childStepCount} 个工步</small></div>
      <div><span>制造活动</span><b>${manufacturingCount}</b><small>含特殊过程 ${typeCount('特殊过程')} 项</small></div>
      <div><span>检验活动</span><b>${typeCount('检验')}</b><small>探测与判定</small></div>
      <div class="warn"><span>${isInitial ? '初步过程' : '特殊过程'}</span><b>${isInitial ? manufacturingCount : typeCount('特殊过程')}</b><small>${isInitial ? '在阶段 3 进一步分解' : '制造活动子集 · 需过程确认'}</small></div>
      <div class="ok"><span>已发布</span><b>${published}<small>/${steps.length}</small></b><small>流程版本受控</small></div>
    </div>
    <div class="pfd-visual-grid">
      <section class="card pfd-structure-card">
        <div class="card-h">
          <div><h3>工艺流程结构图</h3><span class="hint">项目 → 工序顺序，快速查看当前项目包含哪些工序</span></div>
        </div>
        <div class="pfd-structure-scroll">
          <div class="pfd-structure-canvas">
            <div class="pfd-structure-root" data-pfd-focus="${stepsView[0] ? esc(stepsView[0].step_id) : ''}">
              <span>PROJECT</span>
              <b>${esc(projectName)}</b>
              <small>${esc(projectCode)} · ${topSteps.length} 个 OP · ${childStepCount} 个工步</small>
            </div>
            <div class="pfd-structure-list">
              ${stepsView.map(step => {
                const meta = metaOf(step);
                return `<div class="pfd-tree-item ${step.depth ? 'is-substep' : 'is-op'}">
                  <button class="pfd-tree-op ${meta.cls}" data-pfd-focus="${esc(step.step_id)}" aria-pressed="false">
                    <span class="pfd-tree-opno">${esc(step.display_step_no)}</span>
                    <span class="pfd-tree-opmain"><b>${esc(step.name)}</b><small>${step.depth
                      ? `工步 · ${esc(step.parent_name || '')}`
                      : `${step.child_count || 0} 个工步 · ${meta.label}`}</small></span>
                    <i class="pfd-tree-status ${step.status === '已发布' ? 'published' : 'draft'}" title="${esc(step.status)}"></i>
                  </button>
                </div>`;
              }).join('')}
            </div>
          </div>
        </div>
      </section>

      <section class="card pfd-matrix-card">
        <div class="card-h">
          <div><h3 id="pfdMatrixTitle">工序流程矩阵</h3><span class="hint" id="pfdMatrixHint">点击左侧工序，在右侧查看该工序详细内容</span></div>
          <button class="btn sm ghost pfd-matrix-back" id="pfdMatrixBack" hidden>返回矩阵</button>
        </div>
        <div class="pfd-matrix-scroll" id="pfdMatrixScroll">
          <div id="pfdMatrixOverview"><table class="pfd-matrix pfd-matrix-expanded">
            <thead><tr>
              <th class="pfd-matrix-seq-col">序号</th>
              <th class="pfd-activity-col">制造</th>
              <th class="pfd-activity-col">存储</th>
              <th class="pfd-activity-col">搬运</th>
              <th class="pfd-activity-col">检测</th>
              <th class="pfd-matrix-desc-col">工序 / 工步描述</th>
              <th class="pfd-row-flow-col">输入 → 输出</th>
              <th class="pfd-device-col">设备、装置、夹具或刀具</th>
              ${isInitial ? '' : '<th class="pfd-product-col">产品特性</th>'}
            </tr></thead>
            <tbody>${stepsView.map(renderMatrixRow).join('')}</tbody>
          </table></div>
          ${stepsView.map(step => renderStepDetail(step, metaOf(step))).join('')}
        </div>
      </section>
    </div>

    <details class="card pfd-maintenance" open>
      <summary><div><b>工序维护表</b><span>修改名称、类型、设备、输入输出，发布或调整顺序</span></div><span>展开 / 收起编辑</span></summary>
      <div class="pfd-maintenance-scroll">
      <table class="t"><thead><tr><th>工序号</th><th>工序名称</th><th>类型</th><th>设备</th><th>工装治具</th>
        <th>输入</th><th>输出</th>${isInitial ? '' : '<th>关联 FMEA 行</th>'}<th style="width:96px">状态</th><th style="width:210px">操作</th></tr></thead><tbody>
        ${editorSteps.map(s => {
          const locked = s.status === '已发布';
          const ro = locked ? 'readonly' : '';
          const cellStyle = locked
            ? 'border:1px solid transparent;background:transparent;color:var(--ink2)'
            : 'border:1px solid var(--line);background:#fff';
          const rowClass = s.depth ? 'pfd-maintenance-substep' : 'pfd-maintenance-op';
          return `<tr class="${rowClass}" data-step-row="${s.step_id}">
          <td class="mono">${esc(s.display_step_no)}</td>
          <td><div class="pfd-maintenance-name ${s.depth ? 'is-substep' : ''}">
            <input data-sf="name" value="${esc(s.name)}" ${ro} style="${cellStyle};width:100%;font-weight:600">
            <div class="mono dim" style="font-size:10.5px">${s.depth ? `所属 ${esc(s.parent_name || '')}` : s.step_id}${!isInitial && s.origin_step_id ? ` · 源自 P1-10 ${esc(s.origin_step_no || '')}` : ''}</div>
          </div></td>
          <td><select data-sf="step_type" ${locked ? 'disabled' : ''} style="${cellStyle};width:100%">
            ${['工序', '检验', '特殊过程', '存储', '搬运'].map(t => `<option ${t === s.step_type ? 'selected' : ''}>${t}</option>`).join('')}
          </select></td>
          <td><input data-sf="equipment" value="${esc(s.equipment || '')}" ${ro} style="${cellStyle};width:100%"></td>
          <td><input data-sf="fixture" value="${esc(s.fixture || '')}" ${ro} style="${cellStyle};width:100%"></td>
          <td><input data-sf="input_desc" value="${esc(s.input_desc || '')}" ${ro} style="${cellStyle};width:100%" placeholder="如 基片、靶材"></td>
          <td><input data-sf="output_desc" value="${esc(s.output_desc || '')}" ${ro} style="${cellStyle};width:100%" placeholder="如 阻值合格的膜层"></td>
          ${isInitial ? '' : `<td>${s.fmea_rows ? `<span class="chip">${s.fmea_rows}</span>` : '<span class="dim">0</span>'}</td>`}
          <td>${statusBadge(s.status)}</td>
          <td class="pfd-row-actions">
            ${s.depth === 0 && !locked ? `<button class="btn sm ghost" data-add-substep="${s.step_id}">＋工步</button>` : ''}
            ${locked || s.depth ? '' : `<button class="btn sm ghost" data-step-up="${s.step_id}" title="上移">↑</button>
              <button class="btn sm ghost" data-step-down="${s.step_id}" title="下移">↓</button>`}
            ${locked
              ? `<button class="btn sm ghost" data-unpublish="${s.step_id}">撤回发布</button>
                 <button class="btn sm ghost" data-step-rev="${s.step_id}" data-step-name="${esc(s.name)}">历史</button>`
              : `<button class="btn sm" data-save-step="${s.step_id}">存</button>
                 <button class="btn sm ghost" data-publish="${s.step_id}">发布</button>
                 <button class="btn sm ghost" data-step-rev="${s.step_id}" data-step-name="${esc(s.name)}">历史</button>
                 <button class="btn sm ghost" data-del-step="${s.step_id}" style="color:#B91C1C">删</button>`}
          </td></tr>`;
        }).join('')}
      </tbody></table></div>
    </details>`;

  $('#pfdStageBack').onclick = () => goApqpPhase(isInitial ? 1 : 3);
  // P-08：记录进入详情前的滚动位置，返回矩阵时恢复；切换后把焦点移到详情标题
  let pfdScrollBeforeDetail = null;
  const revealStepEditor = stepId => {
    const panel = $('.pfd-maintenance');
    if (panel) panel.open = true;
    const row = document.querySelector(`[data-step-row="${stepId}"]`);
    if (row) {
      row.scrollIntoView({ behavior: 'smooth', block: 'center' });
      const input = row.querySelector('input,select');
      if (input && !input.disabled && !input.readOnly) setTimeout(() => input.focus(), 250);
    }
  };
  const matrixOverview = $('#pfdMatrixOverview');
  const matrixTitle = $('#pfdMatrixTitle');
  const matrixHint = $('#pfdMatrixHint');
  const matrixBack = $('#pfdMatrixBack');
  const matrixScroll = $('#pfdMatrixScroll');
  const clearPfdSelection = () => {
    state.pfdSelectedStepId = null;
    if (matrixOverview) matrixOverview.hidden = false;
    $$('[data-pfd-detail]').forEach(detail => { detail.hidden = true; });
    $$('.pfd-tree-op').forEach(item => {
      item.classList.remove('is-selected');
      item.setAttribute('aria-pressed', 'false');
    });
    if (matrixTitle) matrixTitle.textContent = '工序流程矩阵';
    if (matrixHint) matrixHint.textContent = '点击左侧工序，在右侧查看该工序详细内容';
    if (matrixBack) matrixBack.hidden = true;
    if (matrixScroll) matrixScroll.scrollTop = pfdScrollBeforeDetail ?? 0;
    pfdScrollBeforeDetail = null;
    const first = $('.pfd-tree-op');
    if (first) first.focus();
  };
  const selectPfdStep = stepId => {
    const detail = $$('[data-pfd-detail]').find(item => item.dataset.pfdDetail === stepId);
    if (!detail) return;
    state.pfdSelectedStepId = stepId;
    if (matrixOverview) matrixOverview.hidden = true;
    $$('[data-pfd-detail]').forEach(item => { item.hidden = item !== detail; });
    $$('.pfd-tree-op').forEach(item => {
      const selected = item.dataset.pfdFocus === stepId;
      item.classList.toggle('is-selected', selected);
      item.setAttribute('aria-pressed', String(selected));
    });
    if (matrixTitle) matrixTitle.textContent = '工序详情';
    if (matrixHint) matrixHint.textContent = '查看输入、输出、设备和工序属性';
    if (matrixBack) matrixBack.hidden = false;
    if (matrixScroll && pfdScrollBeforeDetail == null) pfdScrollBeforeDetail = matrixScroll.scrollTop;
    if (matrixScroll) matrixScroll.scrollTop = 0;
    if (matrixTitle) {
      matrixTitle.setAttribute('tabindex', '-1');
      matrixTitle.focus();
    }
  };
  $$('[data-pfd-focus]').forEach(element => element.onclick = event => {
    event.stopPropagation();
    selectPfdStep(element.dataset.pfdFocus);
  });
  // P-08：工序树支持方向键上下移动、回车/空格进入详情
  const treeButtons = $$('.pfd-tree-op');
  treeButtons.forEach((button, index) => {
    button.addEventListener('keydown', event => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const next = treeButtons[Math.max(0, Math.min(treeButtons.length - 1,
          index + (event.key === 'ArrowDown' ? 1 : -1)))];
        next?.focus();
      } else if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        selectPfdStep(button.dataset.pfdFocus);
      }
    });
  });
  $$('[data-pfd-edit]').forEach(button => button.onclick = event => {
    event.stopPropagation();
    revealStepEditor(button.dataset.pfdEdit);
  });
  $$('[data-pfd-detail-save]').forEach(button => button.onclick = async event => {
    event.stopPropagation();
    const detail = button.closest('[data-pfd-detail]');
    const body = { mode };
    detail.querySelectorAll('[data-pfd-detail-field]').forEach(field => {
      body[field.dataset.pfdDetailField] = field.value.trim();
    });
    if (!body.name) {
      toast('工序 / 工步名称不能为空', 'err');
      return;
    }
    button.disabled = true;
    button.textContent = '保存中';
    try {
      await api('/steps/' + encodeURIComponent(button.dataset.pfdDetailSave), { method: 'PATCH', body });
      toast('已保存，工序详情与维护表已同步', 'ok');
      await vPfd({ preserveView: true });
    } catch (error) {
      button.disabled = false;
      button.textContent = '保存';
      toast(error.message, 'err');
    }
  });
  if (matrixBack) matrixBack.onclick = clearPfdSelection;
  if (state.pfdSelectedStepId) selectPfdStep(state.pfdSelectedStepId);
  $$('[data-save-step]').forEach(b => b.onclick = async () => {
    const tr = document.querySelector(`[data-step-row="${b.dataset.saveStep}"]`);
    const body = { mode };
    tr.querySelectorAll('[data-sf]').forEach(el => { body[el.dataset.sf] = el.value.trim(); });
    try {
      await api('/steps/' + encodeURIComponent(b.dataset.saveStep), { method: 'PATCH', body });
      toast('已保存，当前工序维护表保持展开', 'ok');
    }
    catch (e) { toast(e.message, 'err'); }
  });
  $$('[data-publish]').forEach(b => b.onclick = async () => {
    const tr = document.querySelector(`[data-step-row="${b.dataset.publish}"]`);
    const body = { mode, status: '已发布' };
    tr.querySelectorAll('[data-sf]').forEach(el => { body[el.dataset.sf] = el.value.trim(); });
    try {
      await api('/steps/' + encodeURIComponent(b.dataset.publish), { method: 'PATCH', body });
      toast('已发布，当前工序维护表保持展开', 'ok');
      await vPfd({ preserveView: true });
    }
    catch (e) {
      // P-02：父工序下仍有未发布工步时，直接列出这些工步，避免“父工序已发布、工步还是草稿”
      const draftChildren = e.details?.draft_children || [];
      toast(draftChildren.length
        ? `${e.message}：${draftChildren.map(item => `${item.step_no || ''} ${item.name}`.trim()).join('、')}`
        : e.message, 'err');
    }
  });
  // P-04：工序历史版本——可查看与恢复（恢复为草稿）
  $$('[data-step-rev]').forEach(button => button.onclick = async () => {
    try {
      const detail = await api(`/steps/${encodeURIComponent(button.dataset.stepRev)}/revisions`);
      const drawer = $('#drawer');
      $('.drawer-box', drawer).innerHTML = `
        <div class="drawer-h"><div><h2>工序版本历史</h2><p>${esc(button.dataset.stepName || '')} · ${detail.list.length} 个发布/撤回快照</p></div>
          <button class="x" onclick="document.getElementById('drawer').classList.remove('open')">✕</button></div>
        <div class="drawer-b">
          ${detail.list.length ? `<table class="t"><thead><tr><th>时间</th><th>版本</th><th>状态</th><th>说明</th><th>操作</th></tr></thead><tbody>
            ${detail.list.map(item => `<tr><td class="mono">${esc(item.changed_at || '')}</td><td class="mono">${esc(item.ver || '')}</td>
              <td>${statusBadge(item.status)}</td><td class="dim">${esc(item.note || '')}</td>
              <td><button class="btn sm ghost" data-step-restore="${esc(item.rev_id)}"
                data-step-id="${esc(button.dataset.stepRev)}">恢复为草稿</button></td></tr>`).join('')}
          </tbody></table><div class="dim" style="font-size:11.5px;margin-top:8px">恢复会先把当前内容保存为“恢复前”快照；已发布工序需先撤回发布。</div>`
            : '<div class="empty">尚无版本快照；发布或撤回后会记录</div>'}
        </div>`;
      drawer.classList.add('open');
      $$('[data-step-restore]').forEach(restore => restore.onclick = async () => {
        const ok = await showConfirmDialog('恢复工序版本', '将把该版本内容恢复为草稿，当前内容先存为“恢复前”快照。是否继续？',
          { confirmText: '恢复' });
        if (!ok) return;
        try {
          await api(`/steps/${encodeURIComponent(restore.dataset.stepId)}/restore/${encodeURIComponent(restore.dataset.stepRestore)}`, {
            method: 'POST', body: {},
          });
          drawer.classList.remove('open');
          toast('工序已恢复到所选版本（草稿）', 'ok');
          await vPfd({ preserveView: true });
        } catch (error) { toast(error.message, 'err'); }
      });
    } catch (error) { toast(error.message, 'err'); }
  });

  $$('[data-unpublish]').forEach(b => b.onclick = async () => {
    try {
      await api('/steps/' + encodeURIComponent(b.dataset.unpublish), {
        method: 'PATCH', body: { mode, status: '草稿' },
      });
      toast('已撤回，可编辑；工序维护表保持展开', 'ok');
      await vPfd({ preserveView: true });
    }
    catch (e) { toast(e.message, 'err'); }
  });
  if (preservedScrollY !== null) {
    requestAnimationFrame(() => {
      window.scrollTo({ top: preservedScrollY, behavior: 'instant' });
      const panel = $('.pfd-maintenance-scroll');
      if (panel) {
        panel.scrollTop = preservedMaintenanceTop;
        panel.scrollLeft = preservedMaintenanceLeft;
      }
    });
  }
  $$('[data-add-substep]').forEach(button => button.onclick = () => {
    const parent = editorSteps.find(step => step.step_id === button.dataset.addSubstep);
    if (!parent) return;
    const drawer = $('#drawer');
    $('.drawer-box', drawer).innerHTML = `
      <div class="drawer-h"><div><h2>新增工步</h2><p>${esc(parent.display_step_no)} ${esc(parent.name)} · 工步号自动按顺序生成</p></div>
        <button class="x" onclick="document.getElementById('drawer').classList.remove('open')">✕</button></div>
      <div class="drawer-b">
        <div class="field"><label>工步名称</label><input id="subName" placeholder="如 来料检验"></div>
        <div class="field"><label>类型</label><select id="subType">${['工序','检验','特殊过程','存储','搬运'].map(x => `<option ${x === parent.step_type ? 'selected' : ''}>${x}</option>`).join('')}</select></div>
        <div class="row2"><div class="field"><label>设备/检具</label><input id="subEquip" value="${esc(parent.equipment || '')}"></div>
          <div class="field"><label>工装治具</label><input id="subFixture" value="${esc(parent.fixture || '')}"></div></div>
        <div class="row2"><div class="field"><label>输入</label><input id="subInput" value="${esc(parent.input_desc || '')}"></div>
          <div class="field"><label>输出</label><input id="subOutput" value="${esc(parent.output_desc || '')}"></div></div>
        <button class="btn" id="subSave">新增工步</button>
      </div>`;
    drawer.classList.add('open');
    $('#subSave').onclick = async () => {
      try {
        await api('/steps', { method: 'POST', body: {
          mode,
          parent_step_id: parent.step_id,
          name: $('#subName').value.trim(),
          step_type: $('#subType').value,
          equipment: $('#subEquip').value.trim(),
          fixture: $('#subFixture').value.trim(),
          input_desc: $('#subInput').value.trim(),
          output_desc: $('#subOutput').value.trim(),
        } });
        toast('工步已新增', 'ok');
        drawer.classList.remove('open');
        await vPfd({ preserveView: true });
      } catch (e) { toast(e.message, 'err'); }
    };
  });
  $('#btnAddStep').onclick = () => {
    const drawer = $('#drawer');
    $('.drawer-box', drawer).innerHTML = `
      <div class="drawer-h"><div><h2>新增工序</h2><p>工序 ID 自动生成，插入后不会改变已有下游引用。</p></div>
        <button class="x" onclick="document.getElementById('drawer').classList.remove('open')">✕</button></div>
      <div class="drawer-b">
        <div class="row2"><div class="field"><label>工序号</label><input id="stNo" placeholder="留空自动分配"></div>
          <div class="field"><label>工序名称</label><input id="stName" placeholder="如 激光调阻"></div></div>
        <div class="field"><label>类型</label><select id="stType">${['工序','检验','特殊过程','存储','搬运'].map(x => `<option>${x}</option>`).join('')}</select></div>
        <div class="row2"><div class="field"><label>设备/检具</label><input id="stEquip"></div>
          <div class="field"><label>工装治具</label><input id="stFixture"></div></div>
        <div class="row2"><div class="field"><label>输入</label><input id="stInput"></div><div class="field"><label>输出</label><input id="stOutput"></div></div>
        <button class="btn" id="stSave">新增工序</button>
      </div>`;
    drawer.classList.add('open');
    $('#stSave').onclick = async () => {
      try {
        await api('/steps', { method: 'POST', body: {
          mode,
          step_no: $('#stNo').value.trim(), name: $('#stName').value.trim(),
          step_type: $('#stType').value, equipment: $('#stEquip').value,
          fixture: $('#stFixture').value, input_desc: $('#stInput').value,
          output_desc: $('#stOutput').value,
        } });
        toast('工序已新增', 'ok'); drawer.classList.remove('open'); vPfd();
      } catch (e) { toast(e.message, 'err'); }
    };
  };
  $('#btnDictStep').onclick = async () => {
    const dict = await api('/process-dict');
    const today = new Date().toISOString().slice(0, 10);
    const activeDict = dict.list.filter(item => item.status === '生效'
      && (!item.effective_from || item.effective_from <= today)
      && (!item.effective_to || item.effective_to >= today));
    const drawer = $('#drawer');
    $('.drawer-box', drawer).innerHTML = `
      <div class="drawer-h"><div><h2>工序字典</h2><p>字典跨项目复用；引用时工序 ID 仍为项目内稳定 ID。</p></div>
        <button class="x" onclick="document.getElementById('drawer').classList.remove('open')">✕</button></div>
      <div class="drawer-b"><div class="process-dict-toolbar">
        <label class="process-dict-search"><span>查找</span><input id="dictUseSearch" type="search" placeholder="编号或工序名称"></label>
        <button class="btn sm ghost" id="dictManage">维护工序字典</button>
      </div><div class="process-dict-scroll"><table class="t"><thead><tr><th>编号</th><th>名称</th><th>类型</th><th>默认设备</th><th>操作</th></tr></thead><tbody>
        ${activeDict.map(item => `<tr data-dict-use-row><td class="mono">${esc(item.code)}</td><td>${esc(item.name)}</td>
          <td>${esc(item.step_type)}</td><td>${esc(item.default_equipment || '—')}</td>
          <td><button class="btn sm" data-use-dict="${item.dict_id}">引用</button></td></tr>`).join('')}
      </tbody></table></div></div>`;
    drawer.classList.add('open');
    $('#dictManage').onclick = () => { drawer.classList.remove('open'); go('processdict'); };
    $('#dictUseSearch').oninput = event => {
      const query = event.target.value.trim().toLocaleLowerCase();
      $$('[data-dict-use-row]').forEach(row => { row.hidden = !row.textContent.toLocaleLowerCase().includes(query); });
    };
    $$('[data-use-dict]').forEach(button => button.onclick = async () => {
      try {
        await api('/process-dict/' + encodeURIComponent(button.dataset.useDict) + '/use', {
          method: 'POST', body: { mode },
        });
        toast('已从工序字典引用', 'ok'); drawer.classList.remove('open'); vPfd();
      } catch (e) { toast(e.message, 'err'); }
    });
  };
  /* P-06：从 P1-10 初始流程图派生 P3-04 过程流程图，并做两层一致性检查 */
  const PFD_DIFF_LABELS = {
    step_no: '工序号', name: '名称', step_type: '类型', equipment: '设备',
    fixture: '工装', input_desc: '输入', output_desc: '输出',
  };
  const deriveFromInitial = async () => {
    try {
      const c = await api('/pfd/consistency');
      if (!c.initial_total) {
        toast('初始流程图（P1-10）还没有工序，请先在阶段 1 维护初始流程图', 'err');
        return;
      }
      if (!c.missing_in_process.length) {
        toast(`初始流程图的 ${c.initial_total} 道工序已全部派生到过程流程图`, 'ok');
        return;
      }
      const preview = c.missing_in_process.slice(0, 10)
        .map(step => `${step.step_no || ''} ${step.name}`.trim()).join('、');
      const unapproved = c.initial_doc_status && !['已批准', '已完成'].includes(c.initial_doc_status);
      const ok = await showConfirmDialog('从初始流程图派生',
        `将把 ${c.missing_in_process.length} 道尚未进入过程版的初始工序复制为草稿工序（工序号、名称与来源一致）：${preview}` +
        `${c.missing_in_process.length > 10 ? ' 等' : ''}。` +
        `${unapproved ? ` P1-10 当前为“${c.initial_doc_status}”，派生结果需随 P1-10 批准后再受控。` : ''}`,
        { confirmText: '派生' });
      if (!ok) return;
      const result = await api('/pfd/derive-from-initial', { method: 'POST', body: {} });
      toast(`已派生 ${result.created_count} 道工序` +
        `${result.skipped_count ? `，跳过 ${result.skipped_count} 道已派生` : ''}` +
        `${result.step_no_conflicts.length ? `；${result.step_no_conflicts.length} 个工序号与现有工序重复，请调整` : ''}`,
      result.step_no_conflicts.length ? '' : 'ok');
      $('#drawer').classList.remove('open');
      await vPfd();
    } catch (e) { toast(e.message, 'err'); }
  };
  const deriveButton = $('#btnDeriveFromInitial');
  if (deriveButton) deriveButton.onclick = deriveFromInitial;
  const consistencyButton = $('#btnPfdConsistency');
  if (consistencyButton) consistencyButton.onclick = async () => {
    try {
      const c = await api('/pfd/consistency');
      const block = (title, items, render) => items.length
        ? `<div class="pfd-consistency-block"><h3>${title}<span>${items.length}</span></h3>
             <ul>${items.map(item => `<li>${render(item)}</li>`).join('')}</ul></div>`
        : '';
      const drawer = $('#drawer');
      $('.drawer-box', drawer).innerHTML = `
        <div class="drawer-h"><div><h2>P1-10 / P3-04 一致性检查</h2>
          <p>初始流程图 ${c.initial_total} 道 · 过程流程图 ${c.process_total} 道 · 已派生 ${c.derived} 道 · P1-10 状态 ${esc(c.initial_doc_status || '未开始')}</p></div>
          <button class="x" onclick="document.getElementById('drawer').classList.remove('open')">✕</button></div>
        <div class="drawer-b">
          <div class="alert ${c.consistent ? 'info' : 'warn'}">${c.consistent
            ? '两层一致：初始工序已全部派生，过程版没有未标来源的工序。'
            : '两层存在差异。下游 PFMEA / 控制计划只使用过程流程图（P3-04），请先处理下列差异。'}</div>
          ${block('初始版有、过程版没有', c.missing_in_process,
            step => `<b>${esc(step.step_no || '')}</b> ${esc(step.name)} <span class="dim">${esc(step.status)}</span>`)}
          ${block('过程版新增（无初始来源）', c.added_in_process,
            step => `<b>${esc(step.step_no || '')}</b> ${esc(step.name)} <span class="dim">${esc(step.status)}</span>`)}
          ${block('已派生但内容不一致', c.changed,
            item => `<b>${esc(item.initial.step_no || '')}</b> ${esc(item.initial.name)}
              → <b>${esc(item.process.step_no || '')}</b> ${esc(item.process.name)}
              <span class="dim">差异：${item.fields.map(field => PFD_DIFF_LABELS[field] || field).join('、')}</span>`)}
          ${block('来源工序已作废，过程版仍在用', c.source_obsolete,
            step => `<b>${esc(step.step_no || '')}</b> ${esc(step.name)} <span class="dim">来源 ${esc(step.origin_step_id)}</span>`)}
          ${block('同一初始工序被派生多次', c.duplicate_origin,
            item => `<b>${esc(item.initial ? item.initial.step_no : item.origin_step_id)}</b>
              ${esc(item.initial ? item.initial.name : '')} <span class="dim">${item.count} 条过程工序</span>`)}
          ${block('过程版工序号重复', c.step_no_conflicts,
            item => `<b>${esc(item.step_no)}</b> <span class="dim">${item.steps.map(step => esc(step.name)).join(' / ')}</span>`)}
          ${c.missing_in_process.length
            ? `<button class="btn" id="pfdConsistencyDerive">派生缺失的 ${c.missing_in_process.length} 道工序</button>` : ''}
        </div>`;
      drawer.classList.add('open');
      const deriveInDrawer = $('#pfdConsistencyDerive');
      if (deriveInDrawer) deriveInDrawer.onclick = deriveFromInitial;
    } catch (e) { toast(e.message, 'err'); }
  };
  $$('[data-del-step]').forEach(button => {
    let armed = false;
    button.onclick = async event => {
      event.stopPropagation();
      if (!armed) {
        armed = true;
        button.textContent = '确认删除';
        button.style.background = '#FEF2F2';
        setTimeout(() => {
          armed = false;
          button.textContent = '删';
          button.style.background = '';
        }, 6000);
        return;
      }
      try {
        await api('/steps/' + encodeURIComponent(button.dataset.delStep) + '?mode=' + encodeURIComponent(mode), {
          method: 'DELETE',
        });
        toast('工序已作废');
        vPfd();
      } catch (e) { toast(e.message, 'err'); }
    };
  });
  const moveStep = async (id, delta) => {
    const ids = editorSteps.filter(step => step.depth === 0).map(step => step.step_id);
    const index = ids.indexOf(id);
    const target = index + delta;
    if (index < 0 || target < 0 || target >= ids.length) return;
    [ids[index], ids[target]] = [ids[target], ids[index]];
    try {
      await api('/steps/reorder', { method: 'POST', body: { step_ids: ids, mode } });
      vPfd();
    } catch (e) { toast(e.message, 'err'); }
  };
  $$('[data-step-up]').forEach(button => button.onclick = () => moveStep(button.dataset.stepUp, -1));
  $$('[data-step-down]').forEach(button => button.onclick = () => moveStep(button.dataset.stepDown, 1));
}

/* ------------------------------------------------------------------ CP */
async function vCp() {
  await vCpContent();
  await mountQualityToolLinks('cp');
}

async function vCpContent() {
  const query = state.cpStage ? '?stage=' + encodeURIComponent(state.cpStage) : '';
  const d = await api('/cp' + query);
  state.cpStage = d.cp.stage;
  const rows = d.rows;
  const stage = STAGE[d.cp.stage] || d.cp.stage;
  $('#viewSub').textContent = `${d.cp.part_no} · ${stage}控制计划 ${d.cp.rev} · 映射引擎可从 PFD + PFMEA 自动生成`;
  $('#view').innerHTML = `
    <div class="qt-toolbar" style="margin-bottom:12px">
      <div class="qt-toolbar-main"><span class="lbl">当前控制计划</span><b>${esc(stage)} · ${esc(d.cp.rev || 'V1.0')}</b>
        <small>${esc(d.cp.part_no || '')} · ${rows.length} 行 · 产品特性由项目特性主数据引用</small></div>
      <div class="qt-toolbar-meta"><span class="qt-chip">${esc(d.cp.status || '草稿')}</span>
        <span class="qt-chip">${rows.filter(r => r.is_spc).length} 项 SPC</span>
        <span class="qt-chip">${rows.filter(r => r.override_flag).length} 项人工覆盖</span>
        ${d.stopped_rows ? `<span class="qt-chip" title="仍有 SPC/MSA 引用，保留追溯">已停用 ${d.stopped_rows} 行</span>` : ''}</div>
      <div class="qt-actions">
        <button class="btn sm ghost" data-quality-export="cp" data-export-fmt="docx">导出 Word</button>
        <button class="btn sm ghost" data-quality-export="cp" data-export-fmt="xlsx">导出 Excel</button>
      </div>
    </div>
    <div class="tabs">${d.plans.map(plan => `<div class="tab ${plan.cp_id === d.cp.cp_id ? 'on' : ''}" data-cp-stage="${esc(plan.stage)}">
      ${STAGE[plan.stage] || esc(plan.stage)} CP · ${esc(plan.rev)}</div>`).join('')}</div>
    <div class="grid g4" style="margin-bottom:14px">
      <div class="kpi"><div class="k">CP 行数</div><div class="v">${rows.length}</div><div class="d">阶段 ${stage} · 版本 ${d.cp.rev}</div></div>
      <div class="kpi"><div class="k">纳入 SPC</div><div class="v">${rows.filter(r => r.is_spc).length}</div><div class="d">待审核 ${rows.filter(r => r.mon_status === '待审核').length}</div></div>
      <div class="kpi warn"><div class="k">人工覆盖</div><div class="v">${rows.filter(r => r.override_flag).length}</div><div class="d">再同步时保留</div></div>
      <div class="kpi"><div class="k">缺检具</div><div class="v">${rows.filter(r => !r.gauge_id).length}</div><div class="d">MSA 无法挂接</div></div>
    </div>
    <div class="card">
      <div class="card-h"><h3>控制计划</h3>
        <div class="qt-actions">
          <span class="hint">产品特性列为只读，来源 CharID</span>
          ${['已批准', '已冻结'].includes(d.cp.status)
            ? '<button class="btn ghost" id="reviseCp">发起修订</button>' : ''}
          <button class="btn ghost" id="btnCpHeader">表头</button>
          <button class="btn ghost" id="btnCpHistory">版本历史</button>
          <button class="btn ghost" id="btnMonitorReview">SPC 待审核</button>
          <button class="btn ghost" id="btnAddRow">＋ 新增行</button>
          <button class="btn" id="btnGen">一键自动映射</button>
        </div></div>
      <div style="overflow:auto">
      <table class="t"><thead><tr>
        <th>#</th><th>工序</th><th>特性编号</th><th>产品特性</th><th>特殊特性</th><th>规范 / 公差</th>
        <th>测量技术</th><th title="控制计划规定的抽样要求；SPC 子组大小不回写这里">样本（CP 要求）</th>
        <th title="控制计划规定的抽样频率；SPC 配置不覆盖这里">频率（CP 要求）</th>
        <th>控制方法</th><th>反应计划</th><th>检具</th><th>SPC 配置</th><th style="width:70px">操作</th></tr></thead><tbody>
        ${rows.map(r => `<tr>
          <td class="mono">${r.seq}</td>
          <td class="nowrap">${esc(r.step_no || '')} ${esc(r.step_name || '')}</td>
          <td class="mono nowrap"><button class="btn sm ghost" data-link-char="${r.cp_row_id}" style="padding:2px 6px">${esc(r.char_id || '关联特性')}</button>
            <div><span class="tag">${r.fmea_row_id
              ? ((r.override_fields_json || '').includes('char_id') ? '人工覆盖 PFMEA' : '来源 PFMEA')
              : '人工关联'}</span>${r.override_flag ? '<span class="tag">已覆盖</span>' : ''}</div></td>
          <td>${esc(r.char_name || r.char_placeholder || '—')}
            ${r.product_char_name && r.product_char_name !== r.char_name ? `<div class="dim" style="font-size:11px;margin-top:3px">关联产品特性：${esc(r.product_char_name)}</div>` : ''}</td>
          <td>${specBadge(r.is_special, r.special_symbol)}</td>
          <td>${esc(r.spec_text || '—')}</td>
          <td class="dim editable" data-edit="${r.cp_row_id}" data-f="measure_tech">${esc(r.measure_tech || '点此填写')}</td>
          <td class="num editable" data-edit="${r.cp_row_id}" data-f="sample_size">${r.sample_size ?? '—'}</td>
          <td class="nowrap editable" data-edit="${r.cp_row_id}" data-f="freq">${r.freq_value ?? '—'} ${esc(r.freq_unit || '')}</td>
          <td class="dim editable" data-edit="${r.cp_row_id}" data-f="control_method">${esc(r.control_method || '点此填写')}</td>
          <td class="dim editable" data-edit="${r.cp_row_id}" data-f="reaction_plan">${esc(r.reaction_plan || '点此填写')}</td>
          <td class="mono editable" data-edit="${r.cp_row_id}" data-f="gauge_id">${esc(r.gauge_id || '点此选择')}
            ${r.msa_warning ? '<div class="badge b-warn" title="GR&R 未做、过期或校准过期">MSA预警</div>' : ''}</td>
          <td>${r.is_spc ? (r.mon_id ? `<span class="badge ${r.mon_status === '已批准' ? 'b-ok' : r.mon_status === '已退回' ? 'b-bad' : 'b-warn'}">${esc(r.mon_status || '')}</span><div class="mono" style="margin-top:3px">${esc(r.mon_chart_type || '')}${r.mon_subgroup_n ? ' · n=' + r.mon_subgroup_n : ''}</div><div class="dim">${esc(r.mon_id)}</div>` : '<span class="badge b-warn">待生成</span>') : '<span class="dim">否</span>'}</td>
          <td class="nowrap"><button class="btn sm ghost" data-monitor-row="${r.cp_row_id}">${r.mon_status === '已批准' ? '修订SPC' : 'SPC'}</button>
            ${r.mon_id && r.mon_active_status === '启用' ? `<button class="btn sm ghost" data-stop-monitor="${esc(r.mon_id)}">停用</button>` : ''}
            <button class="btn sm ghost" data-override-row="${r.cp_row_id}" data-override-on="${r.override_flag ? 1 : 0}"
              title="${r.override_flag ? '撤销后本行重新接受自动同步' : '标记后本行不再被自动同步覆盖，需填写原因'}">${r.override_flag ? '取消覆盖' : '标记覆盖'}</button>
            <button class="btn sm ghost" data-del-cp="${r.cp_row_id}" style="color:#B91C1C;border-color:#F3C6C6">${r.mon_history_count || r.mon_data_count ? '停用行' : '删'}</button></td>
        </tr>`).join('')}
      </tbody></table></div>
    </div>`;

  $$('[data-cp-stage]').forEach(tab => tab.onclick = () => { state.cpStage = tab.dataset.cpStage; vCp(); });
  if ($('#reviseCp')) $('#reviseCp').onclick = async () => {
    const result = await showFormDialog({
      title: '修订控制计划',
      description: '原批准版本会继续保留，本次修订将转入草稿。',
      fields: [{ key: 'reason', label: '修订原因', type: 'textarea', value: '根据评审或变更要求修订', required: true }],
      confirmText: '开始修订',
    });
    if (!result) return;
    try {
      await api('/cp/' + encodeURIComponent(d.cp.cp_id), {
        method: 'PATCH', body: { status: '草稿', approved_by: '', note: result.reason.trim() },
      });
      toast('控制计划已转入草稿修订', 'ok');
      vCp();
    } catch (e) { toast(e.message, 'err'); }
  };
  $$('[data-link-char]').forEach(button => button.onclick = () => {
    const row = rows.find(item => item.cp_row_id === button.dataset.linkChar);
    if (!row) return;
    const projectChars = d.projectChars || d.chars || [];
    const usedByPfmea = projectChars.filter(item =>
      (item.fmea_count || 0) > 0 || item.pchar_id === row.project_char_id);
    const products = usedByPfmea.filter(item => item.char_kind === 'PRODUCT');
    const processes = usedByPfmea.filter(item => item.char_kind === 'PROCESS');
    const dictionary = d.dictionaryChars || [];
    const charOption = (c, value, selected) => `<option value="${esc(value)}" ${selected ? 'selected' : ''}>${esc(c.char_id)} ${esc(c.name)}${c.tol_text ? ' · ' + esc(c.tol_text) : ''}${c.series_id ? ' · ' + esc(c.series_name || '系列专用') : ' · 产品族通用'}${c.imported ? ' · 已引入项目' : ''}${c.used_in && c.used_in.length ? ' · 已用于' + esc(c.used_in.join('/')) : ''}</option>`;
    const drawer = $('#drawer');
    $('.drawer-box', drawer).innerHTML = `
      <div class="drawer-h"><div><h2>控制计划特性关联</h2><p>${esc(row.step_no || '')} ${esc(row.step_name || '')} · ${esc(row.cp_row_id)}</p></div>
        <button class="x" onclick="document.getElementById('drawer').classList.remove('open')">✕</button></div>
      <div class="drawer-b">
        <div class="alert info">默认分组只显示本项目 PFMEA 已使用或当前行已关联的特性。产品族通用特性适用于同族全部系列，系列专用特性只在所属系列项目中出现。</div>
        ${row.product_char_id ? `<div class="field"><label>通过 CharLink 关联的产品特性</label><input value="${esc(row.product_char_id)} ${esc(row.product_char_name || '')}" readonly></div>` : ''}
        <div class="field"><label>选择要控制/监控的特性</label><select id="cpLinkChar">
          ${processes.length ? `<optgroup label="本项目 PFMEA 使用的过程特性">${processes.map(c => charOption(c, c.pchar_id, c.pchar_id === row.project_char_id || (!row.project_char_id && c.char_id === row.char_id))).join('')}</optgroup>` : '<optgroup label="本项目 PFMEA 尚未使用过程特性"><option value="" disabled>请先在 PFMEA 关联过程特性</option></optgroup>'}
          ${products.length ? `<optgroup label="本项目 PFMEA 使用的产品特性">${products.map(c => charOption(c, c.pchar_id, c.pchar_id === row.project_char_id || (!row.project_char_id && c.char_id === row.char_id))).join('')}</optgroup>` : '<optgroup label="本项目 PFMEA 尚未使用产品特性"><option value="" disabled>请先在 PFMEA 关联产品特性</option></optgroup>'}
          <optgroup label="产品族 / 产品系列特性字典（选择后自动引入项目）">${dictionary.map(c => charOption(c, 'dict:' + c.char_id, false)).join('')}</optgroup>
        </select></div>
        <div class="field"><label>关联理由</label><textarea id="cpLinkReason" rows="2">控制计划按 PFMEA/过程特性核对后关联</textarea></div>
        <button class="btn" id="cpLinkSave">保存关联</button>
      </div>`;
    drawer.classList.add('open');
    $('#cpLinkSave').onclick = async () => {
      try {
        let projectCharId = $('#cpLinkChar').value;
        if (projectCharId.startsWith('dict:')) {
          const imported = await api('/project-chars/from-dictionary', {
            method: 'POST',
            body: { char_id: projectCharId.slice(5), note: '控制计划从特性字典引入' },
          });
          projectCharId = imported.item.pchar_id;
        }
        await api('/cp/row/' + encodeURIComponent(row.cp_row_id) + '/characteristic', {
          method: 'PATCH', body: {
            project_char_id: projectCharId,
            reason: $('#cpLinkReason').value,
          },
        });
        toast('控制计划特性已关联', 'ok');
        drawer.classList.remove('open');
        vCp();
      } catch (e) { toast(e.message, 'err'); }
    };
  });
  $('#btnCpHeader').onclick = () => {
    const drawer = $('#drawer');
    $('.drawer-box', drawer).innerHTML = `
      <div class="drawer-h"><div><h2>控制计划表头</h2><p>${STAGE[d.cp.stage]} · ${esc(d.cp.cp_id)}</p></div>
        <button class="x" onclick="document.getElementById('drawer').classList.remove('open')">✕</button></div>
      <div class="drawer-b">
        <div class="row2"><div class="field"><label>版本</label><input id="cphRev" value="${esc(d.cp.rev || '')}"></div>
          <div class="field"><label>状态</label><select id="cphStatus">${['草稿','已批准','已冻结'].map(s => `<option ${s === d.cp.status ? 'selected' : ''}>${s}</option>`).join('')}</select></div></div>
        <div class="row2"><div class="field"><label>零件号</label><input id="cphPart" value="${esc(d.cp.part_no || '')}"></div>
          <div class="field"><label>零件名称</label><input id="cphName" value="${esc(d.cp.part_name || '')}"></div></div>
        <div class="row2"><div class="field"><label>批准人（受控，由审批动作写入）</label><input id="cphApproved" value="${esc(d.cp.approved_by || '')}" readonly title="批准人由“批准”动作按当前登录账号写入，不能手工修改"></div>
          <div class="field"><label>生效日期</label><input type="date" id="cphDate" value="${esc(d.cp.effective_date || '')}"></div></div>
        <div class="alert info">把状态改为“已批准”时，系统按状态机校验迁移是否合法，并以当前登录账号（质量及以上角色）作为批准人；不允许批准自己编制的控制计划。</div>
        ${d.cp.stage === 'SOP' ? `<hr>
          <div class="alert info">安全投产是量产启动期间的加强遏制，不等同于独立控制计划阶段。适用性按顾客要求确认。</div>
          <div class="field"><label>安全投产适用性</label><select id="cphSafeApplicable">
            ${['未判定', '要求', '不要求'].map(value => `<option ${value === (d.cp.safe_launch_applicability || '未判定') ? 'selected' : ''}>${value}</option>`).join('')}
          </select></div>
          <div class="field"><label>不要求时的顾客/项目依据</label><textarea id="cphSafeNote" rows="2">${esc(d.cp.safe_launch_note || '')}</textarea></div>
          <div class="field"><label>进入条件</label><textarea id="cphSafeEntry" rows="2">${esc(d.cp.safe_launch_entry_criteria || '')}</textarea></div>
          <div class="field"><label>退出准则</label><textarea id="cphSafeExit" rows="2">${esc(d.cp.safe_launch_exit_criteria || '')}</textarea></div>
          <div class="row3">
            <div class="field"><label>执行状态</label><select id="cphSafeStatus">
              ${['未开始', '计划', '执行中', '已退出', '不要求'].map(value => `<option ${value === (d.cp.safe_launch_status || '未开始') ? 'selected' : ''}>${value}</option>`).join('')}
            </select></div>
            <div class="field"><label>退出批准人</label><input id="cphSafeBy" value="${esc(d.cp.safe_launch_exited_by || '')}"></div>
            <div class="field"><label>退出日期</label><input type="date" id="cphSafeAt" value="${esc(d.cp.safe_launch_exited_at || '')}"></div>
          </div>` : ''}
        <button class="btn" id="cphSave">保存表头</button>
      </div>`;
    drawer.classList.add('open');
    $('#cphSave').onclick = async () => {
      try {
        await api('/cp/' + encodeURIComponent(d.cp.cp_id), { method: 'PATCH', body: {
          rev: $('#cphRev').value, status: $('#cphStatus').value,
          part_no: $('#cphPart').value, part_name: $('#cphName').value,
          approved_by: $('#cphApproved').value, effective_date: $('#cphDate').value,
          ...(d.cp.stage === 'SOP' ? {
            safe_launch_applicability: $('#cphSafeApplicable').value,
            safe_launch_note: $('#cphSafeNote').value,
            safe_launch_entry_criteria: $('#cphSafeEntry').value,
            safe_launch_exit_criteria: $('#cphSafeExit').value,
            safe_launch_status: $('#cphSafeStatus').value,
            safe_launch_exited_by: $('#cphSafeBy').value,
            safe_launch_exited_at: $('#cphSafeAt').value,
          } : {}),
        } });
        toast('控制计划表头已保存', 'ok');
        drawer.classList.remove('open');
        vCp();
      } catch (e) { toast(e.message, 'err'); }
    };
  };
  $('#btnCpHistory').onclick = async () => {
    const drawer = $('#drawer');
    const render = (body) => {
      $('.drawer-box', drawer).innerHTML = `
        <div class="drawer-h"><div><h2>控制计划版本历史</h2><p>${esc(d.cp.part_no || '')} · ${STAGE[d.cp.stage] || esc(d.cp.stage)} CP · 当前 ${esc(d.cp.rev || '')}</p></div>
          <button class="x" onclick="document.getElementById('drawer').classList.remove('open')">✕</button></div>
        <div class="drawer-b">${body}</div>`;
      drawer.classList.add('open');
    };
    let list = [];
    try {
      list = (await api('/cp/' + encodeURIComponent(d.cp.cp_id) + '/revisions')).list || [];
    } catch (e) { toast(e.message, 'err'); return; }
    render(`<div class="alert info">每次批准、以及“已批准/已冻结 → 草稿”的降级都会留存一份快照，用于回答“上一版是怎么规定的”。</div>
      ${list.length ? `<table class="t"><thead><tr><th>版本</th><th>当时状态</th><th>行数</th><th>留存时间</th><th>留存人</th><th>说明</th><th>操作</th></tr></thead><tbody>
        ${list.map(item => `<tr><td class="mono">${esc(item.rev)}</td><td>${esc(item.status)}</td><td class="num">${item.row_count}</td>
          <td class="mono nowrap">${esc(item.changed_at || '')}</td><td>${esc(item.changed_by || '')}</td><td>${esc(item.note || '')}</td>
          <td><button class="btn sm ghost" data-cp-rev="${esc(item.rev_id)}">查看</button></td></tr>`).join('')}
      </tbody></table>` : '<div class="empty">尚无版本快照。控制计划批准后会在这里出现第一份快照。</div>'}`);
    $$('[data-cp-rev]').forEach(button => button.onclick = async () => {
      let rev;
      try {
        rev = await api('/cp/' + encodeURIComponent(d.cp.cp_id) + '/revisions/' + encodeURIComponent(button.dataset.cpRev));
      } catch (e) { toast(e.message, 'err'); return; }
      render(`<button class="btn sm ghost" id="cpRevBack">← 返回列表</button>
        <div class="alert info" style="margin-top:10px">快照 ${esc(rev.rev)} · ${esc(rev.status)} · ${esc(rev.changed_at || '')} · ${esc(rev.changed_by || '')}${rev.note ? ' · ' + esc(rev.note) : ''}（只读）</div>
        <div style="overflow:auto"><table class="t"><thead><tr><th>#</th><th>工序</th><th>特性</th><th>特殊特性</th><th>规范/公差</th><th>测量技术</th><th>样本</th><th>控制方法</th><th>反应计划</th></tr></thead><tbody>
          ${(rev.rows || []).map(row => `<tr><td class="mono">${row.seq}</td>
            <td class="nowrap">${esc(row.step_no || '')} ${esc(row.step_name || '')}</td>
            <td>${esc(row.char_name || row.char_id || '—')}</td>
            <td>${specBadge(row.is_special, row.special_symbol)}</td>
            <td>${esc(row.spec_text || '—')}</td><td>${esc(row.measure_tech || '—')}</td>
            <td class="num">${row.sample_size ?? '—'}</td><td>${esc(row.control_method || '—')}</td><td>${esc(row.reaction_plan || '—')}</td></tr>`).join('')}
        </tbody></table></div>`);
      if ($('#cpRevBack')) $('#cpRevBack').onclick = () => $('#btnCpHistory').click();
    });
  };
  $('#btnMonitorReview').onclick = async () => {
    const pending = await api('/monitoring/pending').catch(() => ({ list: [] }));
    const drawer = $('#drawer');
    $('.drawer-box', drawer).innerHTML = `
      <div class="drawer-h"><div><h2>SPC 监控项审核</h2><p>质量工程师审核通过后，监控项才进入 SPC 导入和计算。</p></div>
        <button class="x" onclick="document.getElementById('drawer').classList.remove('open')">✕</button></div>
      <div class="drawer-b">${pending.list.length ? `<table class="t"><thead><tr><th>监控项</th><th>阶段</th><th>特性</th><th>子组</th><th>目标Cpk</th><th>操作</th></tr></thead><tbody>
        ${pending.list.map(item => `<tr><td class="mono">${esc(item.mon_id)}</td><td>${STAGE[item.stage] || esc(item.stage)}</td>
          <td>${esc(item.char_name || item.cp_row_id)}</td><td>${item.subgroup_n}</td><td>${item.cpk_target}</td>
          <td><button class="btn sm" data-approve-mon="${esc(item.mon_id)}">批准</button>
            <button class="btn sm ghost" data-reject-mon="${esc(item.mon_id)}">退回</button></td></tr>`).join('')}
      </tbody></table>` : '<div class="empty">没有待审核监控项</div>'}</div>`;
    drawer.classList.add('open');
    $$('[data-approve-mon]').forEach(button => button.onclick = async () => {
      const ok = await showConfirmDialog('批准 SPC 监控项',
        `将以当前登录账号「${state.user?.display_name || ''}」作为审核人。`, { confirmText: '批准' });
      if (!ok) return;
      try {
        await api('/monitoring/' + encodeURIComponent(button.dataset.approveMon) + '/review', {
          method: 'PATCH', body: { action: 'approve', review_note: '监控配置审核通过' },
        });
        toast('已批准', 'ok'); drawer.classList.remove('open'); vCp();
      } catch (e) { toast(e.message, 'err'); }
    });
    $$('[data-reject-mon]').forEach(button => button.onclick = async () => {
      const result = await showFormDialog({
        title: '退回 SPC 监控项',
        fields: [{ key: 'note', label: '退回原因', type: 'textarea', required: true }],
        confirmText: '确认退回',
      });
      if (!result) return;
      await api('/monitoring/' + encodeURIComponent(button.dataset.rejectMon) + '/review', {
        method: 'PATCH', body: { action: 'reject', review_note: result.note.trim() },
      });
      toast('已退回'); drawer.classList.remove('open'); vCp();
    });
  };

  /* 删除行（二次确认） */
  $$('[data-del-cp]').forEach(b => {
    let armed = false;
    b.onclick = async (e) => {
      e.stopPropagation();
      if (!armed) {
        armed = true;
        b.textContent = '确认?';
        b.style.background = '#FEF2F2';
        setTimeout(() => { armed = false; b.textContent = '删'; b.style.background = ''; }, 5000);
        return;
      }
      try {
        // C-08：按服务端实际动作提示，不能按按钮文案猜测
        const result = await api('/cp/row/' + encodeURIComponent(b.dataset.delCp), { method: 'DELETE' });
        toast(result.deleted === false
          ? '该行仍被 SPC/MSA 引用，已停用并保留历史追溯'
          : '已删除该行', result.deleted === false ? 'warn' : 'ok');
        vCp();
      } catch (err) { toast(err.message, 'err'); }
    };
  });

  $$('[data-stop-monitor]').forEach(button => button.onclick = async () => {
    try {
      await api('/monitoring/' + encodeURIComponent(button.dataset.stopMonitor) + '/status', {
        method: 'PATCH', body: { status: '停用', note: '控制计划维护：停用SPC监控' },
      });
      toast('SPC监控已停用，历史数据已保留', 'ok');
      vCp();
    } catch (error) { toast(error.message, 'err'); }
  });

  $$('[data-monitor-row]').forEach(button => button.onclick = () => {
    const row = rows.find(item => item.cp_row_id === button.dataset.monitorRow);
    if (!row) return;
    if (!row.char_id) {
      toast('请先关联特性，已为你打开关联窗口', 'warn');
      const linkButton = document.querySelector(`[data-link-char="${row.cp_row_id}"]`);
      if (linkButton) linkButton.click();
      return;
    }
    const drawer = $('#drawer');
    $('.drawer-box', drawer).innerHTML = `
      <div class="drawer-h"><div><h2>${row.mon_status === '已批准' ? '修订 SPC 监控项' : '生成 SPC 监控项'}</h2><p>${esc(row.step_no || '')} ${esc(row.step_name || '')} · ${esc(row.char_name || '未关联特性')}</p></div>
        <button class="x" onclick="document.getElementById('drawer').classList.remove('open')">✕</button></div>
      <div class="drawer-b">
        <div class="alert info"><div><b>${esc(row.char_name || '')} · 项目规范</b><br>
          目标 ${spcNum(row.char_target)} ${esc(row.unit || '')} · LSL ${spcNum(row.char_lsl)} / USL ${spcNum(row.char_usl)} · ${esc(row.char_tol_text || row.spec_text || '未维护公差')}<br>
          SPC 将使用项目特性规范，不使用共享字典默认值。</div></div>
        <div class="field"><label>测量设备 <span style="color:#B91C1C">*</span></label>
          <select id="monGauge"><option value="">— 请选择 —</option>
            ${(d.gauges || []).map(g => `<option value="${esc(g.gauge_id)}" ${g.gauge_id === row.gauge_id ? 'selected' : ''}>${esc(g.gauge_id)} ${esc(g.name)}${g.calibration_due ? ` · 校准至 ${esc(g.calibration_due)}` : ' · 未维护校准日期'}</option>`).join('')}
          </select></div>
        <div class="alert ${row.gauge_id ? 'info' : 'warn'}" id="monGaugeHint">检具：${esc(row.gauge_id || '未选择')} ${row.msa_warning ? '，当前存在 MSA 预警' : ''}</div>
        <div class="row3"><div class="field"><label>控制图</label><select id="monChart">
            <option value="Xbar-R" ${row.mon_chart_type === 'Xbar-R' ? 'selected' : ''}>Xbar-R · 均值极差</option><option value="Xbar-S" ${row.mon_chart_type === 'Xbar-S' ? 'selected' : ''}>Xbar-S · 均值标准差</option>
            <option value="I-MR" ${row.mon_chart_type === 'I-MR' ? 'selected' : ''}>I-MR · 单值移动极差</option><option value="P" ${row.mon_chart_type === 'P' ? 'selected' : ''}>P · 不良率</option><option value="C" ${row.mon_chart_type === 'C' ? 'selected' : ''}>C · 缺陷数</option>
          </select></div>
          <div class="field"><label>子组大小</label><input id="monN" type="number" min="2" max="10" value="${Math.max(2, row.mon_subgroup_n || row.sample_size || 5)}"></div>
          <div class="field"><label>Cpk 目标</label><input id="monTarget" type="number" step="0.01" value="${row.mon_cpk_target || (row.is_special ? '1.67' : (state.meta?.defaults?.cpk_target || 1.33))}"></div></div>
        <div class="row3"><div class="field"><label>采样频率值</label><input id="monFreq" type="number" min="0.01" step="0.01" value="${row.mon_freq_value || row.freq_value || 2}"></div>
          <div class="field"><label>频率单位</label><select id="monFreqUnit">${['h','批','班次','炉','件'].map(unit => `<option value="${unit}" ${unit === row.freq_unit ? 'selected' : ''}>${unit === 'h' ? '小时' : unit}</option>`).join('')}</select></div>
          <div class="field"><label>P 图默认样本数</label><input id="monSampleSize" type="number" min="1" value="${row.sample_size || 50}"></div></div>
        <div class="alert info" id="monChartFormat">Xbar-R：每行录入 ${Math.max(2,row.sample_size||5)} 个测量值。</div>
        <div class="field"><label><input type="checkbox" id="monBefore" checked> 分选前取样</label></div>
        <div class="alert info">创建后进入“待审核”，由质量角色的其他人员独立批准；创建人不能自批。</div>
        <div class="field"><label>审核备注</label><textarea id="monNote" rows="2"></textarea></div>
        <button class="btn" id="monCreate">生成并提交</button>
      </div>`;
    drawer.classList.add('open');
    const syncChartForm = () => {
      const type = $('#monChart').value;
      const n = $('#monN');
      const sample = $('#monSampleSize');
      const format = $('#monChartFormat');
      if (type === 'Xbar-R' || type === 'Xbar-S') {
        n.disabled = false;
        n.min = type === 'Xbar-S' ? 5 : 2;
        if (+n.value < +n.min) n.value = n.min;
        sample.disabled = true;
        format.textContent = `${type}：每行录入 ${n.value} 个测量值。`;
      } else if (type === 'P') {
        n.value = 2;
        n.disabled = true;
        sample.disabled = false;
        format.textContent = `P 图：每行录入“不良数, 实际样本数”。计划默认样本数为 ${sample.value}，录入时以每行第二个数为准。`;
      } else {
        n.value = 1;
        n.disabled = true;
        sample.disabled = true;
        format.textContent = type === 'I-MR' ? 'I-MR：每行录入 1 个单值测量结果。' : 'C 图：每行录入 1 个缺陷数。';
      }
    };
    $('#monChart').onchange = syncChartForm;
    $('#monN').oninput = () => {
      $('#monChartFormat').textContent = `${$('#monChart').value}：每行录入 ${$('#monN').value} 个测量值。`;
    };
    syncChartForm();
    const showGaugeMatch = async () => {
      const gauge = (d.gauges || []).find(item => item.gauge_id === $('#monGauge').value);
      const hint = $('#monGaugeHint');
      if (!gauge) {
        hint.className = 'alert warn';
        hint.textContent = '尚未选择测量设备';
        return;
      }
      const match = await api('/msa/match?cp_row_id=' + encodeURIComponent(row.cp_row_id)
        + '&gauge_id=' + encodeURIComponent(gauge.gauge_id)).catch(() => null);
      const plan = match?.plan;
      const study = match?.study;
      const warning = match?.calibration_warning !== false || !plan || !study || study.judgment !== '接受'
        || study.status !== '已完成' || plan.status !== '已完成' || plan.source_status !== '有效';
      hint.className = 'alert ' + (warning ? 'warn' : 'info');
      const result = !plan ? '本工序尚无MSA计划'
        : !study ? `本计划尚无研究（计划${plan.status || '未开始'}）`
          : `${study.study_type === 'ATTRIBUTE' ? '属性研究' : study.result_pct != null
            ? `GRR ${fmt(study.result_pct)}%` : study.study_type || 'MSA研究'} · ${study.judgment || study.status || '待判定'} · ${study.status || ''}`;
      hint.textContent = `${row.step_no || ''} ${row.step_name || ''} · ${row.char_name || '未关联特性'} · ${gauge.gauge_id} ${gauge.name} · 方法${row.measure_tech || '未指定'} · ${result}${match?.calibration_due ? ` · 校准至 ${match.calibration_due}` : ' · 未维护校准日期'}`;
    };
    $('#monGauge').onchange = showGaugeMatch;
    showGaugeMatch();
    $('#monCreate').onclick = async () => {
      try {
        const result = await api('/cp/' + encodeURIComponent(row.cp_row_id) + '/monitor', {
          method: 'POST', body: {
            chart_type: $('#monChart').value,
            gauge_id: $('#monGauge').value,
            subgroup_n: +$('#monN').value,
            sample_size: +$('#monSampleSize').value,
            freq_value: +$('#monFreq').value,
            freq_unit: $('#monFreqUnit').value,
            cpk_target: +$('#monTarget').value,
            before_sort: $('#monBefore').checked,
            review_note: $('#monNote').value,
            ...(row.mon_status === '已批准' ? { revise_monitor_id: row.mon_id } : {}),
          },
        });
        toast(row.mon_status === '已批准'
          ? `旧监控 ${result.revised_from} 已停用，新配置 ${result.mon_id} 待质量审核`
          : '监控项 ' + result.mon_id + ' ' + result.approval_status, 'ok');
        drawer.classList.remove('open');
        vCp();
      } catch (e) { toast(e.message, 'err'); }
    };
  });

  /* 新增行：选工序 + 选特性（可空） */
  $('#btnAddRow').onclick = () => {
    const stepOpts = (d.steps || []).map(s => `<option value="${s.step_id}">${esc(s.step_no)} ${esc(s.name)}</option>`).join('');
    const productOpts = (d.projectChars || []).filter(c => c.char_kind === 'PRODUCT')
      .map(c => `<option value="${c.pchar_id}">${esc(c.char_id)} ${esc(c.name)}${c.tol_text ? ' · ' + esc(c.tol_text) : ''}</option>`).join('');
    const processOpts = (d.projectChars || []).filter(c => c.char_kind === 'PROCESS')
      .map(c => `<option value="${c.pchar_id}">${esc(c.char_id)} ${esc(c.name)}${c.tol_text ? ' · ' + esc(c.tol_text) : ''}</option>`).join('');
    const drawer = $('#drawer');
    $('.drawer-box', drawer).innerHTML = `
      <div class="drawer-h">
        <div><h2>新增控制计划行</h2><p>选择工序，可再指定一条特性；不指定则按基本控制处理</p></div>
        <button class="x" id="cpNewClose">✕</button>
      </div>
      <div class="drawer-b">
        <div class="field"><label>工序 <span style="color:#B91C1C">*</span></label>
          <select id="cpNewStep">${stepOpts}</select></div>
        <div class="field"><label>控制/监控特性（产品特性或过程特性）</label>
          <select id="cpNewChar"><option value="">— 不指定（基本控制）—</option>
            <optgroup label="过程特性">${processOpts}</optgroup><optgroup label="产品特性">${productOpts}</optgroup>
          </select></div>
        <div class="field"><label>检具（纳入 SPC 时必选）</label>
          <select id="cpNewGauge"><option value="">— 不指定 —</option>${(d.gauges || []).map(g =>
            `<option value="${g.gauge_id}">${esc(g.gauge_id)} ${esc(g.name)}</option>`).join('')}</select></div>
        <div class="row3">
          <div class="field"><label>样本容量</label><input id="cpNewSample" type="number" min="1" value="1"></div>
          <div class="field"><label>频率值</label><input id="cpNewFreq" type="number" min="0.01" step="0.01" value="2"></div>
          <div class="field"><label>频率单位</label><select id="cpNewUnit"><option value="h">小时</option><option value="批">批</option><option value="班次">班次</option><option value="炉">炉</option><option value="件">件</option></select></div>
        </div>
        <div class="field"><label>触发条件</label><input id="cpNewTrigger" value="首件 + 巡检"></div>
        <div class="field"><label>控制方法</label><textarea id="cpNewMethod" rows="2" placeholder="按作业指导书执行，首件确认 + 自检 + 过程记录"></textarea></div>
        <div class="field"><label>反应计划</label><textarea id="cpNewReaction" rows="2" placeholder="停线 → 隔离可疑品 → 通知班组长"></textarea></div>
        <button class="btn" id="cpNewSave">添加</button>
      </div>`;
    drawer.classList.add('open');
    $('#cpNewClose').onclick = () => drawer.classList.remove('open');
    $('#cpNewSave').onclick = async () => {
      try {
        await api('/cp/row', {
          method: 'POST',
          body: {
            step_id: $('#cpNewStep').value,
            cp_id: d.cp.cp_id,
            project_char_id: $('#cpNewChar').value || null,
            gauge_id: $('#cpNewGauge').value || null,
            sample_size: +$('#cpNewSample').value,
            freq_value: +$('#cpNewFreq').value,
            freq_unit: $('#cpNewUnit').value,
            freq_trigger: $('#cpNewTrigger').value,
            control_method: $('#cpNewMethod').value,
            reaction_plan: $('#cpNewReaction').value,
          },
        });
        toast('已新增一行', 'ok');
        drawer.classList.remove('open');
        vCp();
      } catch (err) { toast(err.message, 'err'); }
    };
  };

  $('#btnGen').onclick = async () => {
    try {
      const r = await api('/cp/generate', { method: 'POST', body: { cp_id: d.cp.cp_id } });
      toast(`映射完成：新增 ${r.created.length} 行，更新 ${r.kept} 行，跳过人工覆盖 ${r.overridden.length} 行`, 'ok');
      vCp();
    } catch (e) { toast(e.message, 'err'); }
  };

  // C-01：人工覆盖只能显式标记/撤销，普通单元格编辑不再自动打标记
  $$('[data-override-row]').forEach(button => button.onclick = async () => {
    const id = button.dataset.overrideRow;
    const on = button.dataset.overrideOn === '1';
    try {
      let body;
      if (on) {
        const confirmed = await showConfirmDialog('取消人工覆盖',
          '取消后本行重新接受 PFD/PFMEA/特性规范的下游同步，人工修改可能被覆盖。是否继续？');
        if (!confirmed) return;
        body = { action: 'clear-override' };
      } else {
        const result = await showFormDialog({
          title: '标记人工覆盖',
          description: '标记后本行不再被自动同步改写，再同步时保留当前内容。请说明脱离自动同步的原因。',
          fields: [{ key: 'reason', label: '覆盖原因', type: 'textarea', required: true,
            value: '本行工艺参数经试产验证，与上游自动映射取值不同' }],
          confirmText: '标记覆盖',
          validate: values => String(values.reason || '').trim().length >= 4 ? '' : '请至少填写 4 个字的原因。',
        });
        if (!result) return;
        body = { action: 'override', override_reason: result.reason };
      }
      const response = await api('/cp/row/' + id, { method: 'PATCH', body });
      toast(response.note || (on ? '已撤销人工覆盖' : '已标记人工覆盖'), 'ok');
      vCp();
    } catch (e) { toast(e.message, 'err'); }
  });

  $$('[data-edit]').forEach(td => td.onclick = async () => {
    const id = td.dataset.edit, f = td.dataset.f;
    try {
      let response = null;
      if (f === 'reaction_plan' || f === 'measure_tech' || f === 'control_method') {
        const labels = { reaction_plan: '反应计划', measure_tech: '测量技术', control_method: '控制方法' };
        const result = await showFormDialog({
          title: `编辑${labels[f]}`,
          fields: [{
            key: 'value', label: labels[f], type: 'textarea',
            value: td.textContent.trim() === '点此填写' ? '' : td.textContent.trim(),
          }],
          confirmText: '保存',
        });
        if (!result) return;
        response = await api('/cp/row/' + id, { method: 'PATCH', body: { [f]: result.value, override_reason: '人工维护' + labels[f] } });
      } else if (f === 'sample_size') {
        const result = await showFormDialog({
          title: '编辑样本容量',
          fields: [{
            key: 'value', label: '样本容量', type: 'number', min: 1, step: 1,
            value: td.textContent.trim() === '—' ? '' : td.textContent.trim(), required: true,
          }],
          confirmText: '保存',
          validate: values => Number.isInteger(+values.value) && +values.value > 0 ? '' : '样本容量必须是大于 0 的整数。',
        });
        if (!result) return;
        response = await api('/cp/row/' + id, { method: 'PATCH', body: { sample_size: +result.value, override_reason: '人工调整抽样' } });
      } else if (f === 'gauge_id') {
        const row = rows.find(item => item.cp_row_id === id);
        const result = await showFormDialog({
          title: '选择适用检具',
          fields: [{
            key: 'gauge_id', label: '检具', type: 'select', value: row?.gauge_id || '',
            options: [
              { value: '', label: '— 不指定 —' },
              ...(d.gauges || []).map(gauge => ({
                value: gauge.gauge_id,
                label: `${gauge.gauge_id} ${gauge.name || ''}${gauge.calibration_due ? ` · 校准至 ${gauge.calibration_due}` : ''}`,
              })),
            ],
          }],
          confirmText: '保存',
        });
        if (!result) return;
        response = await api('/cp/row/' + id, { method: 'PATCH', body: { gauge_id: result.gauge_id || null, override_reason: '人工调整检具' } });
      } else {
        const row = rows.find(item => item.cp_row_id === id);
        const result = await showFormDialog({
          title: '编辑检验频率',
          fields: [
            {
              key: 'value', label: '频率值', type: 'number', min: 0.01, step: 'any',
              value: row?.freq_value ?? '2', required: true,
            },
            {
              key: 'unit', label: '频率单位', type: 'select', value: row?.freq_unit || 'h',
              options: ['h', '批', '班次', '炉', '件'],
            },
          ],
          confirmText: '保存',
          validate: values => +values.value > 0 ? '' : '频率值必须大于 0。',
        });
        if (!result) return;
        response = await api('/cp/row/' + id, { method: 'PATCH', body: {
          freq_value: +result.value, freq_unit: result.unit, override_reason: '人工调整频率',
        } });
      }
      // C-01/C-07：普通编辑不写覆盖标记；抽样/检具类修改会让已批准 CP 回到草稿，必须如实提示
      toast(response?.note || '已保存', response?.downgraded ? 'warn' : 'ok');
      vCp();
    } catch (e) { toast(e.message, 'err'); }
  });
}

/* ------------------------------------------------------------------ SPC */
function controlChart(stat, char) {
  const primary = stat && (Array.isArray(stat.series) ? stat.series : stat.xbar);
  if (!stat || !Array.isArray(primary) || !primary.length) {
    return '<div class="empty">暂无有效控制图数据</div>';
  }
  const secondary = stat.secondary || (Array.isArray(stat.range) && stat.range.length
    ? { title: stat.chartType === 'Xbar-S' ? 'S 控制图（子组标准差）' : 'R 控制图（子组极差）',
      values: stat.range, labels: stat.labels, center: stat.Rb, ucl: stat.uclR, lcl: stat.lclR } : null);
  const n = primary.length;
  const hasSecondary = !!secondary && Array.isArray(secondary.values) && secondary.values.length > 0;
  const W = 920, H = hasSecondary ? 410 : 275, padL = 66, padR = 18, padT = 44;
  const hX = hasSecondary ? 190 : 165, gapY = 40, hR = 96;
  // Q-04：I-MR 的 MR 子图只有 n−1 个点，必须按 x(i+1) 对齐主图
  const secondaryOffset = String(stat.chartType || '').toUpperCase() === 'I-MR' ? 1 : 0;
  const x = i => padL + (W - padL - padR) * (n === 1 ? 0.5 : i / (n - 1));
  const yRange = (vals, extra = []) => {
    const included = [...vals, ...extra].filter(v => v != null);
    let lo = Math.min(...included), hi = Math.max(...included);
    const m = (hi - lo) * 0.12 || 0.01;
    return [lo - m, hi + m];
  };
  const primaryUcl = stat.seriesUcl || primary.map(() => stat.ucl ?? stat.uclX);
  const primaryLcl = stat.seriesLcl || primary.map(() => stat.lcl ?? stat.lclX);
  const [xLo, xHi] = yRange(primary, [stat.center ?? stat.Xbb, ...primaryUcl, ...primaryLcl, char.lsl, char.usl]);
  const yx = v => padT + hX - ((v - xLo) / (xHi - xLo)) * hX;
  const [rLo, rHi] = hasSecondary
    ? yRange(secondary.values, [secondary.center, secondary.ucl, secondary.lcl]) : [0, 1];
  const yTopR = padT + hX + gapY;
  const yr = v => yTopR + hR - ((v - rLo) / (rHi - rLo || 1)) * hR;
  const line = (y, color, dash, label) => `<line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" stroke="${color}" stroke-width="1.2" ${dash ? 'stroke-dasharray="5 4"' : ''}/>
    <text x="${W - padR - 4}" y="${y - 4}" font-size="10" fill="${color}" text-anchor="end">${label}</text>`;
  const center = stat.center ?? stat.Xbb;
  const pts = primary.map((v, i) => `${x(i)},${yx(v)}`).join(' ');
  // Q-04：y 轴 5 条刻度
  const yTicks = Array.from({ length: 5 }, (_, index) => {
    const value = xLo + (xHi - xLo) * index / 4;
    const y = yx(value);
    return `<line x1="${padL - 4}" y1="${y}" x2="${padL}" y2="${y}" stroke="#CBD5E1"/>
      <text x="${padL - 7}" y="${y + 3}" font-size="9" fill="#64748B" text-anchor="end">${spcNum(value, 4)}</text>`;
  }).join('');
  // Q-04：判异点按规则序号描边，title 嵌入每个圆点
  const violationMap = new Map();
  for (const violation of stat.violations || []) {
    if (!violationMap.has(violation.i)) violationMap.set(violation.i, []);
    violationMap.get(violation.i).push(violation.type);
  }
  const pointTitle = (index, value) => {
    const rules = violationMap.get(index);
    const label = (stat.labels || [])[index] || '#' + (index + 1);
    return `${label}：${spcNum(value)}${rules ? ' · 判异：' + rules.join('；') : ''}`;
  };
  const out = primary.map((v, i) => {
    const rules = violationMap.get(i);
    const outOfLimits = v > primaryUcl[i] || v < primaryLcl[i];
    const color = outOfLimits ? '#DC2626' : rules ? '#F59E0B' : '#2D6CDF';
    const radius = outOfLimits || rules ? 4 : 3.2;
    const stroke = rules && !outOfLimits ? ' stroke="#B45309" stroke-width="1.5"' : '';
    return `<circle cx="${x(i)}" cy="${yx(v)}" r="${radius}" fill="${color}"${stroke}><title>${esc(pointTitle(i, v))}</title></circle>`;
  }).join('');
  const dynamicLimits = (values, color, labelPrefix) => values.some(value => value !== values[0])
    ? `<polyline points="${values.map((v, i) => `${x(i)},${yx(v)}`).join(' ')}" fill="none" stroke="${color}" stroke-width="1.1" stroke-dasharray="5 4"/>`
      + `<text x="${W - padR - 4}" y="${yx(values[values.length - 1]) - 4}" font-size="10" fill="${color}" text-anchor="end">${labelPrefix}</text>`
    : line(yx(values[0]), color, true, `${labelPrefix} ${spcNum(values[0], 4)}`);
  const specs = [], outside = [];
  const inView = v => v != null && v >= xLo && v <= xHi;
  if (char.lsl != null) {
    if (inView(char.lsl)) specs.push(`<line x1="${padL}" y1="${yx(char.lsl)}" x2="${W - padR}" y2="${yx(char.lsl)}" stroke="#15803D" stroke-width="1.4" stroke-dasharray="2 3"/>
    <text x="${padL + 4}" y="${yx(char.lsl) - 4}" font-size="10" fill="#15803D">LSL ${spcNum(char.lsl)}</text>`);
    else outside.push('LSL ' + spcNum(char.lsl));
  }
  if (char.usl != null) {
    if (inView(char.usl)) specs.push(`<line x1="${padL}" y1="${yx(char.usl)}" x2="${W - padR}" y2="${yx(char.usl)}" stroke="#15803D" stroke-width="1.4" stroke-dasharray="2 3"/>
    <text x="${padL + 4}" y="${yx(char.usl) - 4}" font-size="10" fill="#15803D">USL ${spcNum(char.usl)}</text>`);
    else outside.push('USL ' + spcNum(char.usl));
  }
  const outNote = outside.length
    ? `<text x="${padL + 2}" y="${H - 8}" font-size="10" fill="#94A3B8">规格限在视图外（${outside.join(' / ')}），控制图聚焦控制限；能力指数见右侧 Cpk</text>` : '';
  // Q-04：x 轴优先显示批次/时间标签，序号作为次行；点过多时抽稀
  const labelStep = n <= 12 ? 1 : Math.ceil(n / 12);
  const xticks = (stat.labels || []).map((label, i) => {
    if (i % labelStep !== 0 && i !== n - 1) return '';
    const short = String(label == null ? '' : label);
    const text = short && short !== String(i + 1) ? short.slice(-8) : `#${i + 1}`;
    return `<text x="${x(i)}" y="${padT + hX + 14}" font-size="9" fill="#64748B" text-anchor="middle">${esc(text)}</text>`;
  }).join('');
  let secondarySvg = '';
  if (hasSecondary) {
    const rpts = secondary.values.map((v, i) => `${x(i + secondaryOffset)},${yr(v)}`).join(' ');
    const rout = secondary.values.map((v, i) => {
      const bad = v > secondary.ucl || (secondary.lcl > 0 && v < secondary.lcl);
      return `<circle cx="${x(i + secondaryOffset)}" cy="${yr(v)}" r="${bad ? 4 : 3}" fill="${bad ? '#DC2626' : '#64748B'}"${bad ? ' stroke="#fff" stroke-width="1.5"' : ''}>
        <title>${esc(`${(secondary.labels || [])[i] || '#' + (i + 1)}：${spcNum(v)}`)}</title></circle>`;
    }).join('');
    secondarySvg = `
      <text x="${padL}" y="${yTopR - 2}" font-size="11" font-weight="700" fill="#334155">${esc(secondary.title)}</text>
      <rect x="${padL}" y="${yTopR}" width="${W - padL - padR}" height="${hR}" fill="#FCFCFD"/>
      ${line(yr(secondary.ucl), '#DC2626', true, 'UCL ' + spcNum(secondary.ucl, 4))}
      ${line(yr(secondary.center), '#475569', false, 'CL ' + spcNum(secondary.center, 4))}
      ${line(yr(secondary.lcl), '#DC2626', true, 'LCL ' + spcNum(secondary.lcl, 4))}
      <polyline points="${rpts}" fill="none" stroke="#B8C2CF" stroke-width="1.4"/>${rout}`;
  }
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
    <text x="${padL}" y="${padT - 16}" font-size="11" font-weight="700" fill="#334155">${esc(stat.method || '控制图')}</text>
    <rect x="${padL}" y="${padT}" width="${W - padL - padR}" height="${hX}" fill="#FBFDFF"/>
    ${yTicks}
    ${specs.join('')}
    ${dynamicLimits(primaryUcl, '#DC2626', 'UCL')}
    ${line(yx(center), '#475569', false, 'CL ' + spcNum(center, 4))}
    ${dynamicLimits(primaryLcl, '#DC2626', 'LCL')}
    <polyline points="${pts}" fill="none" stroke="#93B4E8" stroke-width="1.4"/>
    ${out}${xticks}
    ${secondarySvg}
    ${outNote}
  </svg>`;
}

function spcHistogram(stat, char) {
  const values = (stat.observations || []).map(Number).filter(Number.isFinite);
  if (!values.length) return '<div class="empty">暂无可用分布数据</div>';
  const W = 640, H = 230, padL = 42, padR = 16, padT = 20, padB = 34;
  const extra = [char.lsl, char.usl, char.target].filter(v => v != null);
  const domain = values.concat(extra);
  let lo = Math.min(...domain), hi = Math.max(...domain);
  if (lo === hi) { lo -= 0.5; hi += 0.5; }
  const bins = Math.max(6, Math.min(12, Math.ceil(Math.sqrt(values.length))));
  const step = (hi - lo) / bins;
  const counts = Array(bins).fill(0);
  values.forEach(value => {
    const index = Math.max(0, Math.min(bins - 1, Math.floor((value - lo) / step)));
    counts[index] += 1;
  });
  const maxCount = Math.max(...counts, 1);
  const chartW = W - padL - padR, chartH = H - padT - padB;
  const x = value => padL + (value - lo) / (hi - lo) * chartW;
  const bars = counts.map((count, index) => {
    const x0 = padL + index / bins * chartW;
    const width = chartW / bins - 2;
    const height = count / maxCount * chartH;
    return `<rect x="${x0}" y="${padT + chartH - height}" width="${width}" height="${height}" rx="2" fill="#93B4E8"/>`;
  }).join('');
  const specLine = (value, label, color) => value == null ? '' :
    `<line x1="${x(value)}" y1="${padT}" x2="${x(value)}" y2="${padT + chartH}" stroke="${color}" stroke-width="1.4" stroke-dasharray="4 3"/>
      <text x="${x(value) + 3}" y="${padT + 10}" font-size="10" fill="${color}">${label} ${spcNum(value)}</text>`;
  return `<svg class="chart" viewBox="0 0 ${W} ${H}">
    <line x1="${padL}" y1="${padT + chartH}" x2="${W - padR}" y2="${padT + chartH}" stroke="#DDE4EE"/>
    ${bars}${specLine(char.lsl, 'LSL', '#15803D')}${specLine(char.usl, 'USL', '#15803D')}
    <text x="${padL}" y="${H - 8}" font-size="10" fill="#94A3B8">分布范围 ${spcNum(lo)} — ${spcNum(hi)} · 样本 ${values.length}</text>
  </svg>`;
}

function spcSubgroupTable(subgroups, stat, chartType, batchNo) {
  if (!Array.isArray(subgroups) || !subgroups.length) return '';
  const type = String(chartType || '').toUpperCase();
  const isP = type === 'P';
  const isC = type === 'C';
  const isIndividual = type === 'I-MR' || type === 'X-MR';
  const valuesByGroup = subgroups.map(group => (Array.isArray(group.v) ? group.v.map(Number) : []));
  const valueWidth = Math.max(...valuesByGroup.map(values => values.length));
  const valueHeaders = isP
    ? ['不良数', '样本数']
    : isC ? ['缺陷数']
      : isIndividual ? ['测量值']
        : Array.from({ length: valueWidth }, (_, index) => `测量值 ${index + 1}`);
  const violationMap = new Map();
  for (const violation of stat?.violations || []) {
    if (!violationMap.has(violation.i)) violationMap.set(violation.i, []);
    violationMap.get(violation.i).push(violation.type);
  }
  const meanOf = values => values.reduce((sum, value) => sum + value, 0) / values.length;
  const rows = subgroups.map((_, index) => {
    const values = valuesByGroup[index];
    const mean = meanOf(values);
    const range = values.length > 1 ? Math.max(...values) - Math.min(...values) : null;
    const std = values.length > 1
      ? Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1)) : null;
    let pointLabel = '';
    let pointValue = '';
    let secondaryLabel = '';
    let secondaryValue = '';
    if (isP) {
      pointLabel = '不良率';
      pointValue = values[1] ? `${spcNum(values[0] / values[1] * 100, 2)}%` : '—';
    } else if (isC) {
      pointLabel = '缺陷数';
      pointValue = spcNum(values[0]);
    } else if (isIndividual) {
      pointLabel = '单值';
      pointValue = spcNum(stat?.series?.[index] ?? mean);
      secondaryLabel = '移动极差';
      secondaryValue = index === 0 ? '—' : spcNum(stat?.range?.[index - 1]);
    } else {
      pointLabel = '子组均值';
      pointValue = spcNum(stat?.series?.[index] ?? mean);
      secondaryLabel = type === 'XBAR-S' ? '标准差 S' : '极差 R';
      secondaryValue = spcNum(stat?.range?.[index] ?? (type === 'XBAR-S' ? std : range));
    }
    const violations = violationMap.get(index) || [];
    return `<tr class="${violations.length ? 'spc-subgroup-row-bad' : ''}">
      <td class="mono">${index + 1}</td>
      ${valueHeaders.map((_, valueIndex) => `<td class="num">${values[valueIndex] == null ? '—' : spcNum(values[valueIndex])}</td>`).join('')}
      <td class="num"><span class="spc-subgroup-stat-label">${pointLabel}</span><b>${pointValue}</b></td>
      ${secondaryLabel ? `<td class="num"><span class="spc-subgroup-stat-label">${secondaryLabel}</span><b>${secondaryValue}</b></td>` : ''}
      <td>${violations.length
        ? `<span class="badge b-bad" title="${esc(violations.join('；'))}">${violations.length} 项</span>`
        : '<span class="dim">正常</span>'}</td>
    </tr>`;
  }).join('');
  return `<details class="spc-subgroup-details" open>
    <summary><span>子组数据明细</span>
      <small>${subgroups.length} 个子组 · ${valueHeaders.length} 个原始值/组 · 批次 ${esc(batchNo || '—')}</small>
    </summary>
    <div class="spc-subgroup-scroll">
      <table class="t spc-subgroup-table">
        <thead><tr><th>#</th>${valueHeaders.map(label => `<th class="num">${esc(label)}</th>`).join('')}
          <th class="num">统计量</th>${isP || isC ? '' : '<th class="num">次级统计量</th>'}<th>判异</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  </details>`;
}

async function vSpc() {
  await vSpcContent();
  await mountQualityToolLinks('spc');
}

async function vSpcContent() {
  const d = await api('/spc');
  if (!d.items.length) {
    $('#viewSub').textContent = 'SPC 过程能力';
    $('#view').innerHTML = `${(d.incomplete || []).length ? `<div class="alert warn" style="margin-bottom:14px"><div><b>${d.incomplete.length} 条历史监控项缺少特性关联</b><br>为避免使用错误规范限计算 Cp/Cpk，系统暂不显示这些监控项。请在控制计划中重新关联项目特性并重新提交监控配置。</div></div>` : ''}
      <div class="empty">尚无特性完整的已批准 SPC 监控项。请先在控制计划中选择项目特性、检具并提交监控配置。</div>`;
    return;
  }
  if (!state.spcId && d.items.length) state.spcId = d.items[0].mon_id;
  const cur = d.items.find(i => i.mon_id === state.spcId) || d.items[0];
  const chartOptions = cur.chartOptions || {};
  const activeChartType = state.spcChartType && chartOptions[state.spcChartType]
    ? state.spcChartType : cur.chart_type;
  const det = cur ? await api('/spc/' + cur.mon_id) : null;
  const history = state.spcDatasetId && cur
    ? await api('/spc/' + cur.mon_id + '/datasets/' + state.spcDatasetId
      + '?chart=' + encodeURIComponent(activeChartType)).catch(() => null)
    : null;
  const shownStat = history ? history.stat : chartOptions[activeChartType] || cur?.stat;
  const shownBatch = history ? history.dataset.batch_no : cur?.stat?.batch_no;
  let shownSubgroups = [];
  try {
    shownSubgroups = JSON.parse((history?.dataset || det?.latest)?.data_json || '[]');
  } catch (e) {
    shownSubgroups = [];
  }

  // Q-13：录入格式与实际分析图型使用同一口径，切换图型后清空已录入内容并重新提示
  const chartTypeUpper = String(activeChartType || cur.chart_type || 'Xbar-R').toUpperCase();
  const expectedValues = chartTypeUpper === 'P' ? 2
    : ['I-MR', 'X-MR', 'C'].includes(chartTypeUpper) ? 1 : cur.subgroup_n;
  const attributeChart = ['P', 'C'].includes(chartTypeUpper);
  const inputHint = chartTypeUpper === 'P'
    ? '每行输入：不良数, 实际样本数'
    : chartTypeUpper === 'I-MR' || chartTypeUpper === 'X-MR'
      ? '每行输入 1 个单值'
      : chartTypeUpper === 'C' ? '每行输入 1 个缺陷数' : `每行输入 ${expectedValues} 个测量值`;
  const secondaryLabel = ['XBAR-S', 'I-MR', 'X-MR'].includes(chartTypeUpper) ? 'S̄ / MR̄'
    : chartTypeUpper === 'P' ? 'p̄' : chartTypeUpper === 'C' ? 'c̄' : 'R̄';
  const subgroupCount = shownStat?.labels?.length || 0;
  const cpkUnavailable = shownStat && (shownStat.cpk == null
    || (String(shownStat.chartType || '').toUpperCase() !== 'P'
      && String(shownStat.chartType || '').toUpperCase() !== 'C' && !(shownStat.sigmaWithin > 0)));
  $('#viewSub').textContent = `${activeChartType} · 项目特性 ${cur.char_name || ''} · 测量设备 ${cur.gauge_id || '—'} · 控制限与规格限分开展示`;
  $('#view').innerHTML = `
    <div class="spc-workbench">
      <aside class="card spc-monitor-list">
        <div class="card-h"><h3>SPC 监控项目</h3><span class="hint">${d.items.length} 项</span></div>
        <div class="spc-monitor-items">
          ${d.items.map(item => `<button class="spc-monitor-item ${item.mon_id === cur.mon_id ? 'on' : ''}" data-mon="${esc(item.mon_id)}">
            <span class="mono">${esc(item.chart_type)}</span><b>${esc(item.char_name || item.mon_id)}</b>
            <small>${esc(item.step_name || item.cp_row_id)} · ${esc(item.gauge_id || '无设备')}</small>
            <i class="${item.stat ? (item.stat.violations.length ? 'warn' : 'ok') : ''}">${item.stat ? (item.stat.violations.length ? item.stat.violations.length + ' 个判异' : '稳定') : '无数据'}</i>
          </button>`).join('')}
        </div>
      </aside>
      <main class="stack spc-main">
        <div class="spc-toolbar">
          <div><span class="lbl">当前监控</span><b>${esc(cur.char_name || cur.mon_id)}</b>
            <small>${esc(cur.mon_id)} · ${esc(activeChartType)} · ${esc(cur.status)} · 批次 ${esc(shownBatch || '—')}</small>
            <div style="display:flex;gap:6px;margin-top:8px">
              <button class="btn sm ghost" data-quality-export="spc" data-export-fmt="docx">导出 Word</button>
              <button class="btn sm ghost" data-quality-export="spc" data-export-fmt="xlsx">导出 Excel</button>
              <button class="btn sm ghost" id="spcMonitorRevise">修订配置</button>
              <button class="btn sm ghost" id="spcMonitorStop" ${cur.status === '启用' ? '' : 'disabled'}>停用监控</button>
              <button class="btn sm ghost" id="spcMonitorDelete" ${det?.items?.length || cur.status === '启用' ? 'disabled title="先停用监控；已有数据时保留历史"' : ''}>删除无数据配置</button>
            </div></div>
          <div class="spc-toolbar-meta"><span><i>分析图型</i><select id="spcChartSwitch" class="sel" style="padding:2px 4px;border:0;background:transparent">${Object.keys(chartOptions).length ? Object.keys(chartOptions).map(type => `<option value="${esc(type)}" ${type === activeChartType ? 'selected' : ''}>${esc(type)}</option>`).join('') : `<option>${esc(cur.chart_type)}</option>`}</select></span>
            <span><i>测量设备</i><b>${esc(cur.gauge_id || '—')}</b></span>
            <span><i>子组 / 数据格式</i><b>${expectedValues} 值/行</b></span>
            <span><i>采样频率</i><b>${cur.freq_value || '—'} ${esc(cur.freq_unit || '')}</b></span>
            <span><i>Cpk 目标</i><b>${cur.cpk_target}</b></span></div>
        </div>
    ${(d.incomplete || []).length ? `<div class="alert warn" style="margin-bottom:14px"><div><b>${d.incomplete.length} 条历史监控项缺少特性关联，已从计算视图排除</b><br>请在控制计划中补充项目特性后重新提交监控项，避免 Cp/Cpk 使用空规范限。</div></div>` : ''}
    ${!cur ? '<div class="empty">尚未生成监控项</div>' : `
    ${shownStat?.diagnostics?.length ? `<div class="alert ${shownStat.diagnostics.some(item => item.level === 'bad') ? 'bad' : 'warn'}" style="margin-bottom:14px"><div>
      <b>${shownStat.diagnostics.map(item => esc(item.title)).join('；')}</b><br>
      ${shownStat.diagnostics.map(item => esc(item.detail)).join('<br>')}</div></div>` : ''}
    <div class="grid g4" style="margin-bottom:14px">
      ${attributeChart ? `
      <div class="kpi"><div class="k">中心线 CL</div><div class="v">${shownStat ? spcNum(shownStat.center, 4) : '—'}</div><div class="d">${chartTypeUpper === 'P' ? '加权平均不良率' : '平均缺陷数'}</div></div>
      <div class="kpi"><div class="k">控制上限 UCL</div><div class="v">${shownStat ? spcNum(shownStat.ucl, 4) : '—'}</div><div class="d">动态 / 固定控制限</div></div>
      <div class="kpi"><div class="k">子组数</div><div class="v">${shownStat ? shownStat.labels.length : '—'}</div><div class="d">计数型数据</div></div>` : `
      <div class="kpi ${cpkUnavailable ? '' : shownStat && shownStat.cpk >= cur.cpk_target ? 'ok' : 'bad'}"><div class="k">Cpk</div>
        <div class="v">${shownStat ? fmt(shownStat.cpk) : '—'}</div><div class="d">${cpkUnavailable ? '无法计算（无变差）' : `目标 ${cur.cpk_target} · 组内 σ`}</div>
        ${shownStat && !cpkUnavailable ? bar(Math.min(100, (shownStat.cpk / 2) * 100), shownStat.cpk >= cur.cpk_target ? 'ok' : 'bad') : ''}</div>
      <div class="kpi"><div class="k">Ppk</div><div class="v">${shownStat ? fmt(shownStat.ppk) : '—'}</div><div class="d">总体 σ（含漂移）</div></div>
      <div class="kpi"><div class="k">Cp</div><div class="v">${shownStat ? fmt(shownStat.cp) : '—'}</div><div class="d">仅反映分布宽度</div></div>`}
      <div class="kpi ${shownStat && shownStat.violations.length ? 'warn' : ''}"><div class="k">判异点</div>
        <div class="v">${shownStat ? shownStat.violations.length : '—'}</div><div class="d">8 类常见规则</div></div>
    </div>
    ${shownStat && !attributeChart && subgroupCount < 25
      ? `<div class="alert warn" style="margin-bottom:14px"><div><b>子组数 ${subgroupCount} 少于 25</b><br>控制限与 Cpk 的统计可靠性有限，仅作参考；建议积累至少 25 个子组后再用于放行判定。</div></div>` : ''}
    <div class="grid g23">
      <div class="card">
        <div class="card-h"><h3>${esc(cur.char_name || '')} · 控制图</h3>
          <span class="hint">n=${cur.subgroup_n} · ${activeChartType} · 批次 ${esc(shownBatch || '—')}</span></div>
        <div class="card-b">${shownStat ? controlChart(shownStat, { lsl: cur.lsl, usl: cur.usl }) : '<div class="empty">暂无数据</div>'}
          <div class="legend"><span><i style="background:#2D6CDF"></i>${chartTypeUpper === 'P' ? '不良率' : chartTypeUpper === 'C' ? '缺陷数' : chartTypeUpper === 'I-MR' || chartTypeUpper === 'X-MR' ? '单值' : '子组均值'}</span>
            <span><i style="background:#DC2626"></i>控制限 / 超限</span><span><i style="background:#F59E0B"></i>规则判异</span>
            <span><i style="background:#15803D"></i>规格限</span></div>
          ${shownStat ? spcSubgroupTable(shownSubgroups, shownStat, chartTypeUpper, shownBatch) : ''}
          <div class="spc-histogram-block"><div class="msa-chart-title">测量值分布与规格位置</div>
            ${shownStat ? spcHistogram(shownStat, { lsl: cur.lsl, usl: cur.usl, target: cur.target }) : '<div class="empty">暂无数据</div>'}</div>
        </div>
      </div>
      <div style="display:grid;gap:14px;align-content:start">
        <div class="card"><div class="card-h"><h3>项目特性规范</h3>
          <button class="btn sm ghost" id="spcSpecEdit" ${cur.project_char_id ? '' : 'disabled'}>调整规范限</button></div><div class="card-b">
          <div class="kv">
            <div class="k">项目特性</div><div>${esc(cur.char_name || '—')} ${specBadge(cur.is_special, cur.special_symbol)}</div>
            <div class="k">特性编号</div><div class="mono">${esc(cur.char_id || '—')}</div>
            <div class="k">目标值</div><div class="mono">${spcNum(cur.target)} ${esc(cur.unit || '')}</div>
            <div class="k">规范限</div><div class="mono">LSL ${spcNum(cur.lsl)} / USL ${spcNum(cur.usl)} ${esc(cur.unit || '')}</div>
            <div class="k">公差</div><div>${esc(cur.tol_text || '未维护')}</div>
          </div>
          <div class="dim" style="font-size:11px;margin-top:8px">此处修改只影响当前项目，不改变产品族特性字典。</div>
        </div></div>
        <div class="card"><div class="card-h"><h3>能力指标</h3></div><div class="card-b">
          ${shownStat ? attributeChart ? `<div class="kv">
            <div class="k">图型</div><div>${esc(shownStat.chartType)}</div>
            <div class="k">中心线</div><div class="mono">${fmt(shownStat.center, 4)}</div>
            <div class="k">UCL / LCL</div><div class="mono">${fmt(shownStat.ucl, 4)} / ${fmt(shownStat.lcl, 4)}</div>
            <div class="k">数据点</div><div>${shownStat.labels.length}</div>
          </div><div class="alert info" style="margin-top:10px"><div><b>计数型控制图</b><br>${esc(shownStat.controlMethod)}。P/C 图不使用 Cp/Cpk，过程能力应结合不良率目标或缺陷 DPMO 单独评价。</div></div>` : `<div class="kv">
            <div class="k">子组数</div><div>${shownStat.n ? shownStat.labels.length : '—'}</div>
            <div class="k">X̄̄</div><div class="mono">${spcNum(shownStat.Xbb)}</div>
            <div class="k">${secondaryLabel}</div><div class="mono">${spcNum(shownStat.Rb)}</div>
            <div class="k">UCL / LCL</div><div class="mono">${spcNum(shownStat.uclX)} / ${spcNum(shownStat.lclX)}</div>
            <div class="k">R̄ / 公差</div><div class="mono">${shownStat.rangeVsSpecPct == null ? '—' : spcNum(shownStat.rangeVsSpecPct, 1) + '%'}</div>
            <div class="k">σ 组内</div><div class="mono">${spcNum(shownStat.sigmaWithin)}</div>
            <div class="k">σ 总体</div><div class="mono">${spcNum(shownStat.sigmaOverall)}</div>
            <div class="k">规格</div><div>${spcNum(cur.lsl)} ~ ${spcNum(cur.usl)} ${esc(cur.unit || '')}</div>
          </div><div class="alert info" style="margin-top:10px"><div><b>控制限不是规格限</b><br>${esc(shownStat.controlMethod)}。绿色 USL/LSL 来自项目特性要求，红色 UCL/LCL 来自过程实际子组变差，两者不能直接比较。</div></div>` : '<div class="dim">无数据</div>'}
        </div></div>
        <div class="card"><div class="card-h"><h3>判异明细</h3></div><div class="card-b">
          ${shownStat && shownStat.violations.length
            ? shownStat.violations.slice(0, 12).map(v => `<div class="alert warn" style="margin-bottom:6px">第 ${v.i + 1} 点：${esc(v.type)}</div>`).join('')
              + (shownStat.violations.length > 12
                ? `<div class="dim" style="font-size:11.5px">还有 ${shownStat.violations.length - 12} 条判异未显示；完整明细见子组数据明细的红/橙行。</div>` : '')
            : '<div class="alert info">未发现判异点</div>'}
        </div></div>
        <div class="card"><div class="card-h"><h3>数据与历史</h3>
          <button class="btn sm ghost" id="spcDataManage">数据录入与历史</button></div><div class="card-b">
          <div class="kv"><div class="k">当前批次</div><div class="mono">${esc(shownBatch || '暂无数据')}</div>
            <div class="k">历史数据集</div><div>${det?.items?.length || 0} 个</div>
            <div class="k">当前图型</div><div>${esc(activeChartType)}</div>
            <div class="k">监控状态</div><div>${esc(cur.status || '—')}</div></div>
        </div></div>
      </div>
    </div>
      </main>
    </div>`}`;

  $$('[data-mon]').forEach(t => t.onclick = () => {
    state.spcId = t.dataset.mon;
    state.spcDatasetId = null;
    state.spcChartType = null;
    vSpc();
  });
  if ($('#spcMonitorStop')) $('#spcMonitorStop').onclick = async () => {
    try {
      await api('/monitoring/' + encodeURIComponent(cur.mon_id) + '/status', {
        method: 'PATCH', body: { status: '停用', note: 'SPC工作台停用监控配置' },
      });
      toast('监控已停用；控制计划和历史数据保留', 'ok');
      await vSpc();
    } catch (error) { toast(error.message, 'err'); }
  };
  if ($('#spcMonitorDelete')) $('#spcMonitorDelete').onclick = async () => {
    try {
      await api('/monitoring/' + encodeURIComponent(cur.mon_id), { method: 'DELETE' });
      toast('无数据监控配置已删除', 'ok');
      state.spcId = null;
      await vSpc();
    } catch (error) { toast(error.message, 'err'); }
  };
  if ($('#spcMonitorRevise')) $('#spcMonitorRevise').onclick = () => {
    const drawer = $('#drawer');
    const gauges = d.gauges || [];
    $('.drawer-box', drawer).innerHTML = `<div class="drawer-h"><div><h2>修订 SPC 监控配置</h2>
      <p>${esc(cur.char_name || cur.mon_id)} · ${esc(cur.step_name || cur.cp_row_id)}</p></div>
      <button class="x" onclick="document.getElementById('drawer').classList.remove('open')" title="关闭">✕</button></div>
      <div class="drawer-b"><div class="alert info">保存后旧配置自动停用并保留原数据；新配置进入质量审核。</div>
        <div class="field"><label>测量设备</label><select id="spcEditGauge">${gauges.map(gauge =>
          `<option value="${esc(gauge.gauge_id)}" ${gauge.gauge_id === cur.gauge_id ? 'selected' : ''}>${esc(gauge.code || gauge.gauge_id)} ${esc(gauge.name)}</option>`).join('')}</select></div>
        <div class="row2"><div class="field"><label>控制图</label><select id="spcEditChart">
          ${['Xbar-R','Xbar-S','I-MR','P','C'].map(type =>
            `<option ${type === cur.chart_type ? 'selected' : ''}>${type}</option>`).join('')}</select></div>
          <div class="field"><label>子组大小</label><input id="spcEditGroup" type="number" min="1" max="10" value="${cur.subgroup_n || 5}"></div></div>
        <div class="row2"><div class="field"><label>采样频率</label><input id="spcEditFreq" type="number" min="0.01" step="0.01" value="${cur.freq_value || 2}"></div>
          <div class="field"><label>频率单位</label><select id="spcEditUnit">${['h','批','班次','炉','件'].map(unit =>
            `<option value="${unit}" ${unit === cur.freq_unit ? 'selected' : ''}>${unit === 'h' ? '小时' : unit}</option>`).join('')}</select></div></div>
        <div class="row2"><div class="field"><label>Cpk 目标</label><input id="spcEditTarget" type="number" step="0.01" value="${cur.cpk_target || state.meta?.defaults?.cpk_target || 1.33}"></div>
          <div class="field"><label>P图默认样本数</label><input id="spcEditSample" type="number" min="1" value="${cur.chart_type === 'P' ? cur.subgroup_n || 50 : 50}"></div></div>
        <button class="btn" id="spcEditSave">保存新版本并提交审核</button></div>`;
    drawer.classList.add('open');
    $('#spcEditSave').onclick = async () => {
      try {
        const result = await api('/cp/' + encodeURIComponent(cur.cp_row_id) + '/monitor', {
          method: 'POST', body: {
            revise_monitor_id: cur.mon_id,
            gauge_id: $('#spcEditGauge').value,
            chart_type: $('#spcEditChart').value,
            subgroup_n: +$('#spcEditGroup').value,
            freq_value: +$('#spcEditFreq').value,
            freq_unit: $('#spcEditUnit').value,
            cpk_target: +$('#spcEditTarget').value,
            sample_size: +$('#spcEditSample').value, review_note: `修订自 ${cur.mon_id}`,
          },
        });
        // Q-10：新配置是“待审核”，不在已批准监控列表中；不要把 spcId 指向不可见项
        state.spcId = null;
        state.spcDatasetId = null;
        drawer.classList.remove('open');
        toast(`新监控配置 ${result.mon_id} 已提交审核，旧监控历史保留；审核通过后才会出现在列表`, 'ok');
        await vSpc();
      } catch (error) { toast(error.message, 'err'); }
    };
  };
  if ($('#spcChartSwitch')) $('#spcChartSwitch').onchange = event => {
    state.spcChartType = event.target.value;
    vSpc();
  };
  const openSpcDataDrawer = () => {
    const drawer = $('#drawer');
    $('.drawer-box', drawer).innerHTML = `
      <div class="drawer-h"><div><h2>数据录入与历史</h2><p>${esc(cur.char_name || cur.mon_id)} · ${esc(activeChartType)} · ${esc(inputHint)}</p></div>
        <button class="x" onclick="document.getElementById('drawer').classList.remove('open')" title="关闭">✕</button></div>
      <div class="drawer-b">
        <div class="field"><label>历史数据集</label><select id="spcHistory"><option value="">最新数据</option>
          ${(det?.items || []).map(item => `<option value="${item.dataset_id}" ${String(item.dataset_id) === String(state.spcDatasetId || '') ? 'selected' : ''}>${esc(item.batch_no)} · ${esc(item.imported_at)}</option>`).join('')}
        </select></div>
        <div class="field"><label>新数据批次号（可选）</label><input id="spcBatch" placeholder="留空自动生成批次号"></div>
        <div class="field"><label>子组数据（${esc(inputHint)}）</label>
          <textarea id="spcData" style="min-height:150px" placeholder="${chartTypeUpper === 'P' ? '12,500' : chartTypeUpper === 'C' ? '3' : chartTypeUpper === 'I-MR' || chartTypeUpper === 'X-MR' ? '10.012' : '10.01,10.02,9.99'}"></textarea></div>
        <button class="btn wide" id="spcSubmit">提交并重算</button>
        <div class="field" style="margin-top:14px"><label>Excel 导入（${esc(inputHint)}）</label>
          <input type="file" id="spcFile" accept=".xlsx">
          <button class="btn ghost wide" id="spcFileSubmit" style="margin-top:6px">导入 Excel</button>
        </div>
      </div>`;
    drawer.classList.add('open');
    $('#spcHistory').onchange = event => {
      state.spcDatasetId = event.target.value ? +event.target.value : null;
      drawer.classList.remove('open');
      vSpc();
    };
    // Q-11：前端逐行校验并指出行号，避免整批提交后只得到一个笼统错误
    const parsePaste = () => {
      const lines = $('#spcData').value.split(/\r?\n/);
      const subs = [];
      const errors = [];
      lines.forEach((line, index) => {
        if (!line.trim()) return;
        const parts = line.split(/[,，\t\s]+/).filter(Boolean);
        const values = parts.map(Number);
        if (values.some(value => !Number.isFinite(value))) {
          errors.push(`第 ${index + 1} 行含非数值`);
          return;
        }
        if (values.length !== expectedValues) {
          errors.push(`第 ${index + 1} 行有 ${values.length} 个数值，应为 ${expectedValues}`);
          return;
        }
        subs.push({ t: `新导入-${subs.length + 1}`, v: values });
      });
      return { subs, errors };
    };
    $('#spcSubmit').onclick = async () => {
      const raw = $('#spcData').value.trim();
      if (!raw) return toast('请粘贴数据', 'err');
      const { subs, errors } = parsePaste();
      if (errors.length) {
        toast(`数据格式有误：${errors.slice(0, 4).join('；')}${errors.length > 4 ? ` 等 ${errors.length} 处` : ''}`, 'err');
        return;
      }
      try {
        await api('/spc/' + cur.mon_id, { method: 'POST', body: { batch_no: $('#spcBatch').value, subgroups: subs } });
        state.spcDatasetId = null;
        drawer.classList.remove('open');
        toast('已导入并重算', 'ok');
        vSpc();
      } catch (e) { toast(e.message, 'err'); }
    };
    $('#spcFileSubmit').onclick = async () => {
      const file = $('#spcFile').files[0];
      if (!file) return toast('请选择 XLSX 文件', 'err');
      if (file.size > 12 * 1024 * 1024) return toast('Excel 文件超过 12 MB，请拆分后导入', 'err');
      const buffer = await file.arrayBuffer();
      try {
        const result = await api('/spc/' + cur.mon_id + '/import', {
          method: 'POST',
          body: { dataBase64: toBase64(buffer), batch_no: $('#spcBatch').value },
        });
        state.spcDatasetId = null;
        drawer.classList.remove('open');
        const skipped = Array.isArray(result.skipped) ? result.skipped : [];
        toast(`Excel 已导入 ${result.count} 个子组${skipped.length
          ? `；跳过 ${skipped.length} 行（第 ${skipped.slice(0, 4).map(item => item.row).join('、')} 行等，原因：${skipped[0].reason}）` : ''}`,
        skipped.length ? 'warn' : 'ok');
        vSpc();
      } catch (e) { toast(e.message, 'err'); }
    };
  };
  if ($('#spcDataManage')) $('#spcDataManage').onclick = openSpcDataDrawer;
  if ($('#spcSpecEdit')) $('#spcSpecEdit').onclick = () => {
    const drawer = $('#drawer');
    $('.drawer-box', drawer).innerHTML = `
      <div class="drawer-h"><div><h2>调整项目特性规范</h2>
        <p>${esc(cur.char_id || '')} · ${esc(cur.char_name || '')} · 仅影响当前项目</p></div>
        <button class="x" onclick="document.getElementById('drawer').classList.remove('open')">✕</button></div>
      <div class="drawer-b">
        <div class="alert info">SPC 后续计算会使用这里的项目参数。产品族特性字典和其他项目不会被覆盖，历史 MSA 研究仍保留当时的容差。</div>
        <div class="row2">
          <div class="field"><label>目标值</label><input id="spcCharTarget" type="number" step="any" value="${cur.target ?? ''}"></div>
          <div class="field"><label>单位</label><input id="spcCharUnit" value="${esc(cur.unit || '')}"></div>
        </div>
        <div class="row2">
          <div class="field"><label>规范下限 LSL</label><input id="spcCharLsl" type="number" step="any" value="${cur.lsl ?? ''}"></div>
          <div class="field"><label>规范上限 USL</label><input id="spcCharUsl" type="number" step="any" value="${cur.usl ?? ''}"></div>
        </div>
        <div class="row2">
          <div class="field"><label>公差文字</label><input id="spcCharTol" value="${esc(cur.tol_text || '')}" placeholder="留空则按上下限生成"></div>
          <div class="field"><label>特殊特性符号</label><input id="spcCharSymbol" value="${esc(cur.special_symbol || '')}" placeholder="CC / SC / 安全"></div>
        </div>
        <div class="field"><label>变更说明</label><textarea id="spcCharNote" rows="2">根据本项目实际工艺窗口调整控制特性规范</textarea></div>
        <button class="btn" id="spcSpecSave">保存并重算</button>
      </div>`;
    drawer.classList.add('open');
    $('#spcSpecSave').onclick = async () => {
      try {
        await api('/project-chars/' + encodeURIComponent(cur.project_char_id), {
          method: 'PATCH',
          body: {
            target: $('#spcCharTarget').value,
            unit: $('#spcCharUnit').value,
            lsl: $('#spcCharLsl').value,
            usl: $('#spcCharUsl').value,
            tol_text: $('#spcCharTol').value,
            special_symbol: $('#spcCharSymbol').value,
            is_special: !!$('#spcCharSymbol').value.trim(),
            note: $('#spcCharNote').value,
          },
        });
        drawer.classList.remove('open');
        toast('项目特性规范已更新，SPC 已按新规范重算', 'ok');
        vSpc();
      } catch (e) { toast(e.message, 'err'); }
    };
  };
}

/* ------------------------------------------------------------------ MSA */
async function vMsaLegacy() {
  const d = await api('/msa');
  $('#viewSub').textContent = '均值-极差法 GR&R（10 件 × 3 人 × 3 次）· 判定：<10% 接受 / 10–30% 条件接受 / >30% 不接受';
  $('#view').innerHTML = `
    <div class="grid g2" style="margin-bottom:14px">
      <div class="card">
        <div class="card-h"><h3>检具台账</h3><span class="hint">CP 行 MSA 预警来源
          <button class="btn sm ghost" id="btnAddGauge" style="margin-left:6px">＋检具</button></span></div>
        <table class="t"><thead><tr><th>编号</th><th>名称</th><th>量程</th><th>校准到期</th><th>校准状态</th><th>操作</th></tr></thead><tbody>
          ${d.gauges.map(g => `<tr><td class="mono">${g.gauge_id}</td><td>${esc(g.name)}</td><td class="dim">${esc(g.range_text || '—')}</td>
            <td class="mono">${esc(g.calibration_due || '未维护')}${g.calibration_warning ? ' <span class="badge b-bad">需校准</span>' : ''}</td>
            <td>${g.calibration_warning ? '<span class="badge b-warn">不可用于新研究</span>' : '<span class="badge b-ok">有效</span>'}</td>
            <td><button class="btn sm ghost" data-edit-gauge="${esc(g.gauge_id)}">编辑</button></td></tr>`).join('')}
        </tbody></table>
      </div>
      <div class="card">
        <div class="card-h"><h3>GR&R 研究记录</h3><span class="hint">${d.studies.length} 次</span></div>
        <table class="t"><thead><tr><th>项目特性 / 检具</th><th>日期</th><th class="num">%GRR</th><th class="num">%EV</th><th class="num">%AV</th><th class="num">ndc</th><th>判定</th></tr></thead><tbody>
          ${d.studies.map(s => `<tr><td class="mono">${esc(s.char_name || s.char_id || '—')}<div class="dim">${esc(s.gauge_id)}</div></td><td class="mono">${esc(s.studied_at)}</td>
            <td class="num"><b>${fmt(s.result_pct)}</b></td><td class="num">${fmt(s.ev_pct)}</td><td class="num">${fmt(s.av_pct)}</td>
            <td class="num">${s.ndc}</td><td>${statusBadge(s.judgment)}</td></tr>`).join('')}
        </tbody></table>
      </div>
    </div>
    <div class="card">
      <div class="card-h"><h3>新建 GR&R 研究</h3><span class="hint">按零件/评价人/试验次数动态校验</span></div>
      <div class="card-b">
        <div class="grid g4" style="margin-bottom:12px">
          <div class="field"><label>检具</label><select id="mGauge">${d.gauges.map(g => `<option value="${g.gauge_id}">${g.gauge_id} ${esc(g.name)}</option>`).join('')}</select></div>
          <div class="field"><label>容差</label><input id="mTol" type="number" value="0.2" step="0.01"></div>
          <div class="field"><label>零件数</label><input id="mParts" type="number" min="2" max="10" value="10"></div>
          <div class="field"><label>评价人 / 试验次数</label><div class="row2"><input id="mOps" type="number" min="2" max="4" value="3"><input id="mTrials" type="number" min="2" max="5" value="3"></div></div>
          <div class="field" style="display:flex;align-items:flex-end"><button class="btn ghost wide" id="mSample">生成示例数据</button></div>
        </div>
        <div class="field"><label>测量数据（行数 = 评价人 × 试验次数，每行列数 = 零件数）</label>
          <textarea id="mData" style="min-height:130px;font-family:ui-monospace,Consolas,monospace;font-size:11.5px"
            placeholder="10.01,10.02,...（每行 10 个）"></textarea></div>
        <div class="dim" id="mShapeHint" style="font-size:11.5px;margin:6px 0 10px"></div>
        <button class="btn" id="mRun">计算 GR&R</button>
        <div id="mResult" style="margin-top:14px"></div>
      </div>
    </div>`;

  $('#mSample').onclick = () => {
    const partsCount = +$('#mParts').value || 10;
    const ops = +$('#mOps').value || 3;
    const trials = +$('#mTrials').value || 3;
    const rows = [];
    const parts = Array.from({ length: partsCount }, (_, i) => 10 + (i - partsCount / 2) * 0.012 + (Math.random() - 0.5) * 0.004);
    for (let o = 0; o < ops; o++)
      for (let t = 0; t < trials; t++)
        rows.push(parts.map(p => (p + (Math.random() - 0.5) * 0.006).toFixed(4)).join(','));
    $('#mData').value = rows.join('\n');
    toast('已生成示例数据（真值相近、测量波动小 → 应判为接受）', 'ok');
  };
  const syncMsaShape = () => {
    const partsCount = +$('#mParts').value || 0;
    const ops = +$('#mOps').value || 0;
    const trials = +$('#mTrials').value || 0;
    $('#mShapeHint').textContent = `当前配置需要 ${ops * trials} 行，每行 ${partsCount} 个零件测量值，共 ${ops * trials * partsCount} 个数据点`;
  };
  ['#mParts', '#mOps', '#mTrials'].forEach(selector => {
    $(selector).oninput = syncMsaShape;
  });
  syncMsaShape();

  $('#mRun').onclick = async () => {
    try {
      const parts = +$('#mParts').value || 10;
      const ops = +$('#mOps').value || 3;
      const trials = +$('#mTrials').value || 3;
      // GR&R 的每一行代表“一个评价人的一次完整试验”，行内才是 all parts 的测量值。
      const expected = ops * trials;
      const lines = $('#mData').value.trim().split(/\n+/).filter(Boolean);
      if (lines.length !== expected) throw new Error(`需要 ${expected} 行数据，当前 ${lines.length} 行`);
      const data = lines.map(l => l.split(/[,，\s]+/).filter(Boolean).map(Number));
      if (data.some(r => r.length !== parts)) throw new Error(`每行必须 ${parts} 个测量值`);
      const r = await api('/msa', { method: 'POST', body: {
        gauge_id: $('#mGauge').value, data, tolerance: +$('#mTol').value,
        parts, ops, trials,
      } });
      $('#mResult').innerHTML = `<div class="alert ${r.judgment === '接受' ? 'info' : 'warn'}">
        <div><b>%GRR = ${r.pctGRR}%</b> → ${r.judgment}　|　%EV ${r.pctEV}%　%AV ${r.pctAV}%　%Tol ${r.pctTol}%　ndc ${r.ndc}</div></div>
        <div class="grid g4" style="margin-top:10px">
          <div class="kpi"><div class="k">EV 重复性</div><div class="v" style="font-size:18px">${r.EV}</div></div>
          <div class="kpi"><div class="k">AV 再现性</div><div class="v" style="font-size:18px">${r.AV}</div></div>
          <div class="kpi"><div class="k">GRR</div><div class="v" style="font-size:18px">${r.GRR}</div></div>
          <div class="kpi"><div class="k">PV 零件变差</div><div class="v" style="font-size:18px">${r.PV}</div></div>
        </div>`;
      toast('计算完成', 'ok');
    } catch (e) { toast(e.message, 'err'); }
  };

  // M-09：打开抽屉时把计划信息作为参数直接渲染，不再 setTimeout 抢 DOM
  const openAddGauge = (preset = {}) => {
    const drawer = $('#drawer');
    $('.drawer-box', drawer).innerHTML = `
      <div class="drawer-h"><div><h2>新增检具</h2><p>检具台账全局共享，供 CP、MSA 与基线引用。</p></div>
        <button class="x" onclick="document.getElementById('drawer').classList.remove('open')">✕</button></div>
      <div class="drawer-b">
        <div class="row2"><div class="field"><label>检具编号</label><input id="gCode" placeholder="G-100" value="${esc(preset.code || '')}"></div>
          <div class="field"><label>名称</label><input id="gName" placeholder="数显电桥" value="${esc(preset.name || '')}"></div></div>
        <div class="row2"><div class="field"><label>型号</label><input id="gModel"></div>
          <div class="field"><label>量程</label><input id="gRange" value="${esc(preset.range_text || '')}"></div></div>
        <div class="field"><label>分辨力</label><input id="gResolution" type="number" min="0" step="any" placeholder="例如 0.001"></div>
        <div class="row2"><div class="field"><label>校准到期日</label><input type="date" id="gCal"></div>
          <div class="field"><label>使用部门</label><input id="gDept"></div></div>
        <button class="btn" id="gSave">新增检具</button>
      </div>`;
    drawer.classList.add('open');
    if (preset.focus) $('#gRange')?.focus();
    $('#gSave').onclick = async () => {
      try {
        await api('/gauges', { method: 'POST', body: {
          code: $('#gCode').value, name: $('#gName').value, model: $('#gModel').value,
          range_text: $('#gRange').value, calibration_due: $('#gCal').value,
          owner_dept: $('#gDept').value, resolution: $('#gResolution').value,
        } });
        toast('检具已新增', 'ok'); drawer.classList.remove('open'); vMsa();
      } catch (e) { toast(e.message, 'err'); }
    };
  };
  $('#btnAddGauge').onclick = () => openAddGauge();
  $$('[data-create-gauge-from-plan]').forEach(button => button.onclick = () => {
    const gauge = d.gauges.find(item => item.gauge_id === button.dataset.createGaugeFromPlan);
    if (!gauge) return;
    openAddGauge({
      code: gauge.code === '未建台账' ? '' : gauge.code || '',
      name: gauge.name || '', range_text: gauge.range_text || '', focus: true,
    });
  });
  $$('[data-edit-gauge]').forEach(button => button.onclick = async () => {
    const gauge = d.gauges.find(item => item.gauge_id === button.dataset.editGauge);
    if (!gauge) return;
    const result = await showFormDialog({
      title: '维护检具能力',
      description: `${gauge.gauge_id} · ${gauge.name || '未命名检具'}`,
      fields: [
        { key: 'calibration_due', label: '校准到期日', type: 'date', value: gauge.calibration_due || '' },
        { key: 'resolution', label: '量具分辨力', value: gauge.resolution ?? '' },
        {
          key: 'status', label: '状态', type: 'select', value: gauge.status || '在用',
          options: ['在用', '停用', '报废'],
        },
      ],
      confirmText: '保存',
    });
    if (!result) return;
    try {
      await api('/gauges/' + encodeURIComponent(gauge.gauge_id), {
        method: 'PATCH', body: {
          calibration_due: result.calibration_due,
          resolution: result.resolution,
          status: result.status,
        },
      });
      toast('检具已更新', 'ok'); vMsa();
    } catch (e) { toast(e.message, 'err'); }
  });
}

function msaComponentChart(result) {
  const values = [
    { label: '重复性 EV', value: result.pctEV, color: '#2D6CDF' },
    { label: '再现性 AV', value: result.pctAV, color: '#0F766E' },
    { label: '%GRR', value: result.pctGRR, color: '#B45309' },
    { label: '%Tol', value: result.pctTol, color: '#7C3AED' },
  ];
  const max = Math.max(30, ...values.map(item => Math.abs(+item.value || 0)));
  return `<div class="msa-bars">${values.map(item => {
    const width = Math.min(100, Math.abs(+item.value || 0) / max * 100);
    return `<div class="msa-bar-row"><span>${item.label}</span>
      <div class="msa-bar-track"><i style="width:${width}%;background:${item.color}"></i></div>
      <b>${fmt(item.value)}%</b></div>`;
  }).join('')}</div>`;
}

function msaPartMeanChart(data) {
  if (!Array.isArray(data) || !data.length || !data[0].length) return '';
  const parts = data[0].length;
  const means = Array.from({ length: parts }, (_, part) => {
    const values = data.map(row => +row[part]).filter(Number.isFinite);
    return values.reduce((sum, value) => sum + value, 0) / values.length;
  });
  const W = 640, H = 170, padL = 44, padR = 12, padT = 18, padB = 28;
  const min = Math.min(...means), max = Math.max(...means);
  const range = max - min || 0.01;
  const x = index => padL + (W - padL - padR) * (parts === 1 ? 0.5 : index / (parts - 1));
  const y = value => padT + (H - padT - padB) * (1 - (value - min) / range);
  const points = means.map((value, index) => `${x(index)},${y(value)}`).join(' ');
  return `<svg class="msa-part-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="零件均值趋势">
    <line x1="${padL}" y1="${H - padB}" x2="${W - padR}" y2="${H - padB}" stroke="#E4E9F0"/>
    <polyline points="${points}" fill="none" stroke="#2D6CDF" stroke-width="2"/>
    ${means.map((value, index) => `<circle cx="${x(index)}" cy="${y(value)}" r="3.5" fill="#fff" stroke="#2D6CDF" stroke-width="2"/>
      <text x="${x(index)}" y="${H - 9}" text-anchor="middle" font-size="10" fill="#7B8798">P${index + 1}</text>`).join('')}
    <text x="${padL}" y="12" font-size="10" fill="#7B8798">零件均值 ${fmt(min)} — ${fmt(max)}</text>
  </svg>`;
}

function msaResultPanel(result, data) {
  const judgmentClass = result.judgment === '接受' ? 'b-ok' : result.judgment === '不接受' ? 'b-bad' : 'b-warn';
  return `<div class="msa-result-head">
      <div><div class="lbl">本次研究结论</div><h3>${esc(result.judgment)}</h3></div>
      <span class="badge ${judgmentClass}">%GRR ${fmt(result.pctGRR)}%</span>
    </div>
    <div class="grid g4 msa-result-kpis">
      <div class="kpi ${judgmentClass === 'b-ok' ? 'ok' : judgmentClass === 'b-bad' ? 'bad' : 'warn'}"><div class="k">%GRR</div><div class="v">${fmt(result.pctGRR)}<small>%</small></div><div class="d">测量系统总变差</div></div>
      <div class="kpi"><div class="k">%Tol</div><div class="v">${fmt(result.pctTol)}<small>%</small></div><div class="d">相对公差带</div></div>
      <div class="kpi ${result.ndc >= 5 ? 'ok' : 'bad'}"><div class="k">ndc</div><div class="v">${result.ndc}</div><div class="d">可区分类别数（≥5）</div></div>
      <div class="kpi"><div class="k">EV / AV</div><div class="v" style="font-size:19px">${fmt(result.pctEV)} / ${fmt(result.pctAV)}<small>%</small></div><div class="d">重复性 / 再现性</div></div>
    </div>
    <div class="msa-result-grid">
      <div><div class="msa-chart-title">变差分量</div>${msaComponentChart(result)}</div>
      <div><div class="msa-chart-title">按零件均值</div>${msaPartMeanChart(data)}</div>
    </div>
    <div class="alert ${result.judgment === '接受' ? 'info' : 'warn'}" style="margin-top:12px">
      <b>${esc(result.judgment)}</b>${result.reason ? `：${esc(result.reason)}。` : '。'}
      ${result.judgment === '接受'
        ? '测量系统可用于当前特性监控。仍应结合量具分辨力、校准状态和取样代表性进行复核。'
        : result.judgment === '条件接受'
          ? '测量系统需结合特性重要度、量具分辨力和客户要求评审；建议改善评价人培训、夹具定位或测量方法后复评。'
          : '测量系统不可接受。应先改善量具、夹具、测量方法或评价人培训，完成改善后重新研究。'}
    </div>
    ${Array.isArray(result.warnings) && result.warnings.length
      ? `<div class="alert warn" style="margin-top:8px">${result.warnings.map(item => esc(item)).join('<br>')}</div>`
      : ''}`;
}

async function vMsa() {
  await vMsaContent();
  await mountQualityToolLinks('msa');
}

async function vMsaContent() {
  const d = await api('/msa');
  const chars = d.projectChars || [];
  const gauges = d.gauges || [];
  const otherGauges = d.other_gauges || [];
  const ledgerGauges = gauges.filter(gauge => !gauge.planned_only);
  const planOnlyGauges = gauges.filter(gauge => gauge.planned_only);
  // 可用 = 台账内、非停用/报废、校准未过期（服务端会拒绝停用与过期检具做研究）
  const activeGauges = ledgerGauges.filter(gauge => !gauge.calibration_warning
    && !['停用', '报废'].includes(gauge.status));
  const calibrationIssues = ledgerGauges.filter(gauge => gauge.calibration_warning).length;
  const plans = d.plans || [];
  // M-10：计划状态只由一个派生函数决定，两个列表按同一状态分组
  const msaPlanView = plan => {
    if (plan.source_active === 0) return 'source_invalid';
    if (plan.source_status && plan.source_status !== '有效') return 'source_review';
    if (plan.status === '已完成') return 'completed';
    if (plan.status === '研究中') return 'researching';
    return 'planned';
  };
  const activePlans = plans.filter(plan => plan.source_active !== 0);
  const currentPlans = plans.filter(plan => ['planned', 'researching', 'source_review'].includes(msaPlanView(plan)));
  const historicalPlanCount = Math.max(0, plans.length - currentPlans.length);
  // “已确认测量系统”只统计来源仍有效且判定接受的已完成计划
  const qualified = activePlans.filter(plan =>
    plan.status === '已完成' && plan.study_judgment === '接受'
    && (!plan.source_status || plan.source_status === '有效')).length;
  const latest = d.studies.find(study => study.result_pct != null && study.status !== '作废'
    && (study.study_type || 'GRR') === 'GRR');
  // 作废与来源失效的研究不能再作为导出对象；保留下来的仍可查看历史
  const exportStudies = d.studies.filter(study => study.result_pct != null
    && study.status !== '作废' && !study.source_invalid);
  if (!state.msaStudyId) state.msaStudyId = exportStudies[0]?.study_id || null;
  const currentStudy = exportStudies.find(study => String(study.study_id) === String(state.msaStudyId)) || exportStudies[0] || null;
  const defaultChar = chars.find(item => item.identified && item.lsl != null && item.usl != null)
    || chars.find(item => item.lsl != null && item.usl != null) || chars[0];
  // 可“开展”的计划（表格里的按钮只看这一组）
  const researchPlans = currentPlans.filter(plan => msaPlanView(plan) === 'planned'
    && (!plan.cp_status || ['已批准', '已冻结'].includes(plan.cp_status))
    && plan.project_char_id && plan.gauge_id
    && (plan.study_type || 'GRR') === 'GRR');
  // 研究设计下拉：额外包含“研究中”的计划，用于计算后保留上下文（选项置灰，不能新开研究）
  const planOptions = currentPlans.filter(plan => ['planned', 'researching'].includes(msaPlanView(plan))
    && (!plan.cp_status || ['已批准', '已冻结'].includes(plan.cp_status))
    && plan.project_char_id && plan.gauge_id
    && (plan.study_type || 'GRR') === 'GRR');
  const planCharLabel = plan => plan.char_name || plan.char_id || '—';
  const planGaugeLabel = plan => [plan.gauge_code || plan.gauge_id, plan.gauge_name]
    .filter(Boolean).join(' ') || '—';
  const toleranceFor = char => char && char.lsl != null && char.usl != null
    ? +Math.abs(char.usl - char.lsl).toFixed(6) : '';
  // 优先匹配当前计划；没有计划时退回“量具 + 特性”的最近研究（含临时研究），
  // 否则左侧会一直显示“尚无记录”，把真实历史藏起来。
  const latestStudyFor = (gaugeId, charId, planId) => {
    const candidates = d.studies.filter(study =>
      study.gauge_id === gaugeId && study.project_char_id === charId);
    if (planId) {
      const planned = candidates.find(study => study.plan_id === planId);
      if (planned) return planned;
    }
    return candidates[0] || null;
  };
  const gaugeStudyText = (gaugeId, charId, planId) => {
    const study = latestStudyFor(gaugeId, charId, planId);
    if (!study) return '当前特性尚无该量具的研究记录';
    const kind = study.result_pct == null
      ? (study.study_type || '外部研究') : `GRR ${fmt(study.result_pct)}%`;
    const status = study.status || '已计算';
    const tag = status === '作废' ? '（已作废）'
      : study.source_invalid ? '（来源已失效）'
        : study.plan_id ? '' : '（临时研究）';
    return `当前特性 ${study.char_name || study.char_id} · ${kind} · ${status}${tag}`;
  };
  // 权限：企管部计量岗维护台账与校准，质量部做研究设计与数据
  const canEditGauge = userCan('msa.gauge.edit');
  const canStudy = userCan('msa.edit');
  // 本厂其他检具：台账页与研究设计页共用同一份折叠清单，
  // 否则“没有台账权限 + 新项目零检具”的账号（如检验员）无法开展研究
  const otherGaugePicker = () => (otherGauges.length ? `
    <details class="msa-other-gauges" ${ledgerGauges.length ? '' : 'open'}>
      <summary>本厂其他检具（${otherGauges.length} 台，本项目尚未使用）</summary>
      <div class="msa-other-list">
        ${otherGauges.map(g => `<button class="chip" title="${esc(g.name || '')}"
          data-use-other-gauge="${esc(g.gauge_id)}">${esc(g.gauge_id)} ${esc(g.name || '')}</button>`).join('')}
      </div>
      <div class="dim" style="font-size:11px">点击可把该检具加入本项目研究（不会改变台账本身）。</div>
    </details>` : '');
  // 默认页签跟随岗位：只有台账权限的账号直接落在台账页，其余落在研究页
  const defaultTab = canStudy ? 'study' : (canEditGauge ? 'ledger' : 'study');
  const currentTab = state.msaTab === 'ledger' ? (canEditGauge ? 'ledger' : 'study')
    : state.msaTab === 'study' ? 'study' : defaultTab;
  $('#viewSub').textContent = 'AIAG 均值-极差法 GR&R 工作台：台账与校准由计量岗维护，研究设计与数据由质量部编制。';
  // 台账页：检具台账 / 校准状态 / 计划待建台账 / 测量能力评定（不涉及研究数据）
  const ledgerPanel = canEditGauge ? `
    <div class="msa-ledger-grid">
      <div class="card">
        <div class="card-h"><h3>检具台账与校准</h3>
          <span class="hint">共 ${ledgerGauges.length} 台 · ${calibrationIssues} 台校准过期/停用/报废</span></div>
        <div class="msa-gauge-list">
          ${ledgerGauges.length ? ledgerGauges.map(g => `
            <div class="msa-gauge-row ${g.calibration_warning ? 'warn' : ''}">
              <div class="msa-gauge-main">
                <span class="msa-gauge-code">${esc(g.gauge_id)}</span><b>${esc(g.name)}</b>
                <small>${esc(g.range_text || g.model || '未填写量程')} · 分辨力 ${g.resolution ?? '未维护'}</small>
                <small>校准到期：${esc(g.calibration_due || '未维护')}${g.status ? ` · 状态 ${esc(g.status)}` : ''}</small>
              </div>
              <div class="msa-gauge-flags">
                ${['停用', '报废'].includes(g.status)
                  ? `<span class="badge b-bad">${esc(g.status)}</span>`
                  : g.calibration_warning
                    ? '<span class="badge b-bad">校准过期</span>'
                    : '<span class="badge b-ok">校准有效</span>'}
                <button class="btn sm ghost" data-edit-gauge="${esc(g.gauge_id)}">维护台账</button>
              </div>
            </div>`).join('') : '<div class="empty">暂无检具，请先建立台账</div>'}
          ${planOnlyGauges.length ? `<div class="lbl" style="margin:12px 0 6px">计划中待建台账（不是真实检具）</div>
            ${planOnlyGauges.map(g => `
            <div class="msa-gauge-row planned-only">
              <div class="msa-gauge-main">
                <span class="msa-gauge-code">${esc(g.code || '待建台账')}</span><b>${esc(g.name)}</b>
                <small>仅来自已批准 MSA 计划，台账尚未建立，不参与台账统计</small>
                <small>计划引用 ${g.plan_ids?.length || 0} 项</small>
              </div>
              <div class="msa-gauge-flags">
                <span class="badge b-warn">待建台账</span>
                <button class="btn sm ghost" data-create-gauge-from-plan="${esc(g.gauge_id)}">建立台账</button>
              </div>
            </div>`).join('')}` : ''}
        </div>
        <div class="card-b" style="border-top:1px solid var(--line2)">
          <button class="btn sm" id="btnAddGauge">＋ 新增检具</button>
          <span class="dim" style="font-size:11px;margin-left:8px">台账与校准由企业管理部维护；停用/报废/校准过期的检具不能用于研究。
            台账是全厂共享主数据，这里只列出本项目已使用或计划使用的检具。</span>
          ${otherGaugePicker()}
        </div>
      </div>
      <div class="stack">
        <div class="card">
          <div class="card-h"><h3>测量能力评定</h3><span class="hint">按最近研究判定检具是否满足测量要求</span></div>
          <div class="card-b">
            ${ledgerGauges.length ? `<div class="t-scroll"><table class="t"><thead><tr><th>检具</th><th>最近研究</th><th class="num">%GRR</th><th>判定</th><th>校准</th></tr></thead><tbody>
              ${ledgerGauges.map(g => {
                const study = d.studies.find(item => item.gauge_id === g.gauge_id
                  && item.result_pct != null && item.status !== '作废');
                return `<tr><td class="mono">${esc(g.gauge_id)}</td>
                  <td>${study ? `${esc(study.char_name || study.char_id || '—')}<div class="dim mono">${esc(study.studied_at || '')}</div>` : '<span class="dim">尚无研究</span>'}</td>
                  <td class="num">${study ? fmt(study.result_pct) : '—'}</td>
                  <td>${study ? statusBadge(study.judgment || '未判定') : '<span class="badge b-gray">待评定</span>'}</td>
                  <td>${['停用', '报废'].includes(g.status) ? `<span class="badge b-bad">${esc(g.status)}</span>`
                    : g.calibration_warning ? '<span class="badge b-bad">校准过期</span>'
                      : '<span class="badge b-ok">有效</span>'}</td></tr>`;
              }).join('')}
            </tbody></table></div>` : '<div class="empty">建立台账后在此查看每台检具的测量能力评定</div>'}
          </div>
        </div>
        <div class="alert info"><div><b>判定基线</b><br>%GRR 与 %Tol 建议均不超过 10%；10–30% 为条件接受；ndc 建议至少为 5。最终判定还应结合特性重要度与客户特殊要求。</div></div>
      </div>
    </div>` : '';
  $('#view').innerHTML = `
    <div class="msa-tabs" role="tablist">
      ${canEditGauge ? `<button class="msa-tab ${currentTab === 'ledger' ? 'on' : ''}" data-msa-tab="ledger" role="tab"
        aria-selected="${currentTab === 'ledger'}" aria-controls="msaPanelLedger"
        title="检具台账、校准状态、计划待建台账、测量能力评定（企业管理部）">
        台账与校准<small>企业管理部</small></button>` : ''}
      <button class="msa-tab ${currentTab === 'study' ? 'on' : ''}" data-msa-tab="study" role="tab"
        aria-selected="${currentTab === 'study'}" aria-controls="msaPanelStudy"
        title="MSA 计划、研究设计、数据矩阵、结果与历史（质量管理部）">
        研究设计与数据<small>质量管理部</small></button>
    </div>
    <div class="msa-panel" id="msaPanelLedger" data-msa-panel="ledger" role="tabpanel" ${currentTab === 'ledger' ? '' : 'hidden'}>${ledgerPanel}</div>
    <div class="msa-panel" id="msaPanelStudy" data-msa-panel="study" role="tabpanel" ${currentTab === 'study' ? '' : 'hidden'}>
    ${canStudy ? '' : '<div class="alert warn"><div>当前账号没有 MSA 研究编制权限（需质量工程师 / 检验员 / 工艺工程师）；可查看研究记录与结果，但不能生成数据或计算。</div></div>'}
    <div class="grid g4" style="margin-bottom:14px">
      <div class="kpi"><div class="k">检具台账</div><div class="v">${activeGauges.length}<small>台可用</small></div><div class="d">共 ${ledgerGauges.length} 台${planOnlyGauges.length ? ` · 计划待建台账 ${planOnlyGauges.length}` : ''}</div></div>
      <div class="kpi ${calibrationIssues ? 'bad' : 'ok'}"><div class="k">校准健康度</div><div class="v">${ledgerGauges.length ? Math.round((ledgerGauges.length - calibrationIssues) / ledgerGauges.length * 100) : 0}<small>%</small></div><div class="d">${calibrationIssues} 台校准过期/停用/报废（不可用于研究）</div></div>
      <div class="kpi ${qualified ? 'ok' : 'warn'}"><div class="k">已确认测量系统</div><div class="v">${qualified}<small>组</small></div><div class="d">${currentPlans.length} 项当前计划待处理</div></div>
      <div class="kpi ${latest ? (latest.judgment === '接受' ? 'ok' : latest.judgment === '条件接受' ? 'warn'
        : latest.judgment === '不接受' ? 'bad' : latest.result_pct < 10 ? 'ok' : latest.result_pct <= 30 ? 'warn' : 'bad') : ''}">
        <div class="k">最近 %GRR</div><div class="v">${latest ? fmt(latest.result_pct) + '<small>%</small>' : '—'}</div>
        <div class="d">${latest ? `${esc(latest.judgment || '未判定')} · ${esc(latest.char_name || latest.char_id || '—')} · ${esc(latest.gauge_id)} · ${esc(latest.measure_tech || '测量方法未记录')}` : '尚无研究记录'}</div></div>
    </div>
    <section class="card" style="margin-bottom:14px">
      <div class="card-h"><h3>APQP MSA 计划</h3>
        <span class="hint">当前有效计划 ${currentPlans.length} 项 · 历史计划和研究 ${historicalPlanCount} 项，不在计划表内重复显示</span></div>
      <div class="t-scroll"><table class="t msa-plan-table"><thead><tr><th>项目特性</th><th>测量设备</th><th>研究设计</th><th>计划日期</th><th>责任人</th><th>来源</th><th>状态</th><th>操作</th></tr></thead><tbody>
        ${currentPlans.length ? currentPlans.map(plan => `<tr>
          <td><b>${esc(planCharLabel(plan))}</b><div class="dim mono">${esc(plan.char_id || '')}</div>
            ${!plan.project_char_id ? '<span class="badge b-warn">特性待关联</span>' : ''}</td>
          <td>${esc(planGaugeLabel(plan))}<div class="dim">分辨力 ${plan.resolution ?? '未维护'}</div>
            ${!plan.gauge_id ? '<span class="badge b-warn">检具待关联</span>' : ''}</td>
          <td>${esc(plan.study_type || 'GRR')}${plan.study_type === 'ATTRIBUTE'
            ? '<div class="dim">按适用方法提交研究证据</div>' : `<div>${plan.parts} 件 × ${plan.operators} 人 × ${plan.trials} 次</div>`}
            <div class="dim">${esc(plan.measure_tech || '')}</div></td>
          <td class="mono">${esc(plan.planned_date || '—')}</td><td>${esc(plan.owner || '—')}</td>
          <td><span class="chip">${esc(plan.trigger_source || 'CP')}</span>
            <div class="dim">${esc(plan.step_no || '')} ${esc(plan.step_name || '')}</div>
            <div class="dim mono">${esc(plan.source_version || '')}</div></td>
          <td>${statusBadge(plan.status)}${plan.source_status && plan.source_status !== '有效' ? `<div class="dim">${esc(plan.source_status)}</div>` : ''}
            ${plan.study_judgment ? `<div class="dim">${esc(plan.study_judgment)}${plan.study_result != null ? ' ' + fmt(plan.study_result) + '%' : ''}</div>` : ''}</td>
          <td class="nowrap"><button class="btn sm ghost" data-edit-plan="${esc(plan.plan_id)}">维护</button>
            ${(!plan.project_char_id || !plan.gauge_id) ? '<span class="dim">请先关联特性和检具</span>'
              : researchPlans.some(item => item.plan_id === plan.plan_id) ? `<button class="btn sm" data-start-plan="${esc(plan.plan_id)}">开展研究</button>`
              : ((plan.study_type || 'GRR') !== 'GRR' && plan.status !== '已完成' && plan.source_active !== 0
                && (!plan.source_status || plan.source_status === '有效') && (!plan.cp_status || ['已批准', '已冻结'].includes(plan.cp_status))
                ? `<button class="btn sm ghost" data-external-plan="${esc(plan.plan_id)}">登记外部研究</button>`
                : plan.source_active === 0 || (plan.source_status && plan.source_status !== '有效') ? '<span class="dim">来源待复核</span>' : '')}</td>
        </tr>`).join('') : '<tr><td colspan="8" class="dim">当前没有待处理计划，历史研究见下方。</td></tr>'}
      </tbody></table></div>
    </section>
    <div class="msa-layout msa-study">
      <aside class="stack">
        <div class="card">
          <div class="card-h"><h3>检具可用性</h3>
            <span class="hint">点击切换到该检具的研究</span></div>
          <div class="msa-gauge-list">
            ${ledgerGauges.length ? ledgerGauges.map(g => `
              <div class="msa-gauge-row ${g.calibration_warning ? 'warn' : ''}">
                <button class="msa-gauge-main" data-pick-gauge="${esc(g.gauge_id)}">
                  <span class="msa-gauge-code">${esc(g.gauge_id)}</span><b>${esc(g.name)}</b>
                  <small>${esc(g.range_text || g.model || '未填写量程')} · 分辨力 ${g.resolution ?? '未维护'}</small>
                  <small data-gauge-study="${esc(g.gauge_id)}">${esc(gaugeStudyText(g.gauge_id, defaultChar?.pchar_id, researchPlans[0]?.plan_id))}</small>
                </button>
                <div class="msa-gauge-flags">
                  ${['停用', '报废'].includes(g.status)
                    ? `<span class="badge b-bad">${esc(g.status)}</span>`
                    : g.calibration_warning
                      ? '<span class="badge b-bad">校准过期</span>'
                      : '<span class="badge b-ok">校准有效</span>'}
                  ${canEditGauge ? `<button class="btn sm ghost" data-edit-gauge="${esc(g.gauge_id)}">维护</button>` : ''}
                </div>
              </div>`).join('') : '<div class="empty">暂无检具，请先维护检具台账</div>'}
            ${planOnlyGauges.length ? `<div class="lbl" style="margin:12px 0 6px">计划中待建台账（不是真实检具）</div>
              ${planOnlyGauges.map(g => `
              <div class="msa-gauge-row planned-only">
                <div class="msa-gauge-main">
                  <span class="msa-gauge-code">${esc(g.code || '待建台账')}</span><b>${esc(g.name)}</b>
                  <small>仅来自已批准 MSA 计划，台账尚未建立，不参与台账统计</small>
                  <small>计划引用 ${g.plan_ids?.length || 0} 项</small>
                </div>
                <div class="msa-gauge-flags">
                  <span class="badge b-warn">待建台账</span>
                  ${canEditGauge ? `<button class="btn sm ghost" data-create-gauge-from-plan="${esc(g.gauge_id)}">建立台账</button>` : ''}
                </div>
              </div>`).join('')}` : ''}
          </div>
        </div>
        <div class="alert info"><div><b>判定基线</b><br>%GRR 与 %Tol 建议均不超过 10%；10–30% 为条件接受；ndc 建议至少为 5。最终判定还应结合特性重要度与客户特殊要求。</div></div>
      </aside>
      <main class="stack">
        <div class="qt-toolbar">
          <div class="qt-toolbar-main"><span class="lbl">当前研究</span>
            <b>${currentStudy ? `${esc(currentStudy.char_name || currentStudy.char_id || 'MSA')} · ${esc(currentStudy.gauge_id)}` : '暂无已完成研究'}</b>
            <small>${currentStudy ? `研究 ${esc(currentStudy.study_id)} · ${esc(currentStudy.studied_at || '')} · ${currentStudy.result_pct != null ? fmt(currentStudy.result_pct) + '% GRR' : ''}` : '完成 GRR 研究后可选择导出对象'}</small></div>
          <div class="field" style="min-width:300px;margin:0"><label>导出研究</label>
            <select id="msaStudySelect" ${exportStudies.length ? '' : 'disabled'}>
              ${exportStudies.map(study => `<option value="${study.study_id}" ${String(study.study_id) === String(state.msaStudyId) ? 'selected' : ''}>${esc(study.char_name || study.char_id || 'MSA')} · ${esc(study.gauge_id)} · ${esc(study.studied_at || '')} · ${fmt(study.result_pct)}%</option>`).join('')}
            </select></div>
          <div class="qt-actions">
            <button class="btn sm ghost" data-quality-export="msa" data-export-fmt="docx" ${currentStudy ? '' : 'disabled'}>导出 Word</button>
            <button class="btn sm ghost" data-quality-export="msa" data-export-fmt="xlsx" ${currentStudy ? '' : 'disabled'}>导出 Excel</button>
          </div>
        </div>
        <section class="card">
          <div class="card-h"><h3>研究设计</h3><span class="hint">默认 10 件 × 3 评价人 × 3 次试验</span></div>
          <div class="card-b"><div class="msa-setup-grid">
            <div class="field" style="grid-column:1/-1"><label>APQP MSA 计划</label><select id="mPlan">
              <option value="">— 临时研究（不关联 P3-08 计划）—</option>
              ${planOptions.map(plan => {
                const researching = msaPlanView(plan) === 'researching';
                const selected = state.msaPlanId ? plan.plan_id === state.msaPlanId : plan === planOptions[0];
                return `<option value="${esc(plan.plan_id)}" data-char="${esc(plan.project_char_id)}" data-gauge="${esc(plan.gauge_id)}" data-parts="${plan.parts}" data-operators="${plan.operators}" data-trials="${plan.trials}"
                  ${researching ? 'disabled' : ''} ${selected ? 'selected' : ''}>${esc(plan.char_name || plan.char_id)} · ${esc(plan.gauge_code || plan.gauge_id)} · ${esc(plan.planned_date || '未排期')}${researching ? '（研究中）' : ''}</option>`;
              }).join('')}
            </select><div class="dim" id="mPlanHint">选定计划后引用该测量系统的特性、检具和研究参数。</div></div>
            <div class="field"><label>项目特性</label><select id="mChar" ${chars.length ? '' : 'disabled'}>
              ${chars.map(c => `<option value="${c.pchar_id}" ${c.pchar_id === defaultChar?.pchar_id ? 'selected' : ''}>${esc(c.char_id)} ${esc(c.name)}${c.identified ? ' · 项目识别' : ''}</option>`).join('')}
            </select><div class="dim" id="mCharRange"></div></div>
            <div class="field"><label>检具 / 测量设备</label><select id="mGauge">
              ${ledgerGauges.filter(g => g.status !== '报废').map(g =>
                `<option value="${esc(g.gauge_id)}" ${g.calibration_warning ? 'data-warning="1"' : ''}>${esc(g.gauge_id)} ${esc(g.name)}${g.calibration_warning ? '（校准过期/停用）' : ''}</option>`).join('')}
            </select><div class="dim" id="mGaugeHint"></div>
              ${canStudy && !canEditGauge ? otherGaugePicker() : ''}</div>
            <div class="field"><label>容差</label><input id="mTol" type="number" min="0" step="any" value="${toleranceFor(defaultChar)}"></div>
            <div class="field"><label>零件数</label><input id="mParts" type="number" min="2" max="10" value="10"></div>
            <div class="field"><label>评价人数</label><input id="mOps" type="number" min="2" max="4" value="3"></div>
            <div class="field"><label>试验次数</label><input id="mTrials" type="number" min="2" max="5" value="3"></div>
            <div class="field"><label>模拟目标 %GRR</label><select id="mSimTarget">
              <option value="5" selected>5% GRR</option><option value="10">10% GRR</option>
              <option value="15">15% GRR</option><option value="25">25% GRR</option>
              <option value="40">40% GRR</option></select></div>
          </div></div>
        </section>
        <section class="card msa-rule-card">
          <details open>
            <summary>模拟数据规则与“容差”口径</summary>
            <div class="msa-rule-grid">
              <div><b>1. 样品真实值</b><span>以项目特性目标值为中心，在 LSL/USL 内生成不同零件的真实差异。</span></div>
              <div><b>2. 目标 %GRR</b><span>%GRR = GRR ÷ 总变差 TV；目标值控制测量系统噪声相对于零件变差的比例。</span></div>
              <div><b>3. 测量结果</b><span>测量值 = 零件真实值 + 评价人偏倚 + 重复测量误差，再按量具分辨力取整。</span></div>
              <div><b>4. 容差</b><span>有 LSL/USL 时强制使用项目特性容差；%Tol = 6×GRR ÷ 容差×100%。容差不是控制限。</span></div>
            </div>
          </details>
        </section>
        <section class="card">
          <div class="card-h"><h3>测量数据矩阵</h3><span class="hint" id="mShapeHint"></span></div>
          <div class="card-b">
            <div class="msa-table-actions"><button class="btn sm ghost" id="mSample">按量具与特性要求生成模拟数据</button>
              <button class="btn sm ghost" id="mClear">清空数据</button><span class="dim">行=评价人的一次完整试验，列=零件。</span></div>
            <div id="mSimInfo"></div>
            <div class="msa-data-wrap" id="mDataGrid"></div>
          </div>
        </section>
        <section class="card">
          <div class="card-h"><h3>研究结果</h3><span class="hint">计算后写入当前项目历史研究</span></div>
          <div class="card-b"><div id="mResult"><div class="empty">填写数据后点击“计算 GR&amp;R”</div></div>
            <button class="btn" id="mRun" style="margin-top:14px" ${chars.length && activeGauges.length ? '' : 'disabled'}>计算 GR&amp;R</button></div>
        </section>
        <section class="card">
          <div class="card-h"><h3>历史研究</h3><span class="hint">${d.studies.length} 次 · 当前项目</span></div>
          <div class="t-scroll"><table class="t msa-history-table"><thead><tr><th>日期</th><th>项目特性</th><th>检具</th><th class="num">%GRR</th><th class="num">%Tol</th><th class="num">ndc</th><th>容差</th><th>判定</th><th>研究状态</th><th>操作</th></tr></thead><tbody>
            ${d.studies.length ? d.studies.map(s => `<tr><td class="mono">${esc(s.studied_at)}
                ${s.evidence_ref ? `<div class="dim">报告引用：${esc(s.evidence_ref)}</div>` : ''}</td>
              <td>${esc(s.char_name || s.char_id || '—')}${s.char_unit ? ` <span class="dim">${esc(s.char_unit)}</span>` : ''}
                ${s.method ? `<div class="dim">方法：${esc(s.method)}</div>` : ''}</td>
              <td class="mono">${esc(s.gauge_id)}</td><td class="num"><b>${fmt(s.result_pct)}</b></td>
              <td class="num">${fmt(s.pct_tol)}</td><td class="num">${s.ndc ?? '—'}</td><td class="mono">${fmt(s.effective_tolerance)}</td><td>${statusBadge(s.judgment)}</td>
              <td>${statusBadge(s.status || '已计算')}${s.completed_by ? `<div class="dim">${esc(s.completed_by)}</div>` : ''}
                ${s.judgment === '接受' && s.status !== '已完成' ? `<button class="btn sm ghost" data-complete-study="${s.study_id}">确认完成</button>` : ''}</td>
              <td>${s.status === '已完成'
                ? `<button class="btn sm ghost" data-void-study="${s.study_id}">作废</button>`
                : `<button class="btn sm ghost" data-delete-study="${s.study_id}" style="color:#B91C1C">删除</button>`}</td></tr>`).join('')
              : '<tr><td colspan="10" class="dim">当前项目尚无 MSA 研究记录</td></tr>'}
          </tbody></table></div>
        </section>
      </main>
    </div>
    </div>`;

  // 页签切换：台账（企管部）与研究（质量部）互不干扰，切换只改可见性，不重绘
  $$('[data-msa-tab]').forEach(tab => {
    tab.onclick = () => {
      const target = tab.dataset.msaTab;
      state.msaTab = target;
      $$('[data-msa-tab]').forEach(item => {
        item.classList.toggle('on', item === tab);
        // 读屏软件靠 aria-selected 判断当前页签
        item.setAttribute('aria-selected', String(item === tab));
      });
      $$('[data-msa-panel]').forEach(panel => {
        panel.hidden = panel.dataset.msaPanel !== target;
      });
    };
  });

  if ($('#msaStudySelect')) $('#msaStudySelect').onchange = event => {
    state.msaStudyId = +event.target.value || null;
  };
  const selectedChar = () => chars.find(item => item.pchar_id === $('#mChar')?.value);
  const completeStudy = async (studyId, operator) => {
    const result = await showFormDialog({
      title: '确认 MSA 研究完成',
      description: '完成后将回写对应 MSA 计划状态，并成为 PPAP 可用证据。',
      fields: [{
        key: 'completed_by', label: '完成确认人', required: true,
        value: operator || state.user?.display_name || '',
      }],
      confirmText: '确认完成',
    });
    if (!result) return;
    try {
      await api('/msa/' + studyId + '/complete', { method: 'PATCH', body: { completed_by: result.completed_by.trim() } });
      $('#drawer')?.classList.remove('open');
      toast('MSA 研究已完成并回写对应计划', 'ok');
      await vMsa();
    } catch (e) { toast(e.message, 'err'); }
  };
  $$('[data-complete-study]').forEach(button => {
    button.onclick = () => completeStudy(button.dataset.completeStudy);
  });
  $$('[data-delete-study]').forEach(button => {
    button.onclick = async () => {
      const study = d.studies.find(item => String(item.study_id) === button.dataset.deleteStudy);
      if (!study) return;
      if (!await showConfirmDialog('删除 MSA 历史研究',
        `确认删除研究 ${study.study_id}（${study.char_name || study.char_id || 'MSA'} · ${study.gauge_id}）？关联计划会退回待研究状态。`, {
          confirmText: '删除研究', danger: true,
        })) return;
      try {
        await api('/msa/' + study.study_id, { method: 'DELETE' });
        if (String(state.msaStudyId) === String(study.study_id)) state.msaStudyId = null;
        toast('MSA 历史研究已删除，关联计划已退回待研究', 'ok');
        await vMsa();
      } catch (error) { toast(error.message, 'err'); }
    };
  });
  // M-05：已完成研究保留证据，只能作废并说明原因
  $$('[data-void-study]').forEach(button => {
    button.onclick = async () => {
      const study = d.studies.find(item => String(item.study_id) === button.dataset.voidStudy);
      if (!study) return;
      const result = await showFormDialog({
        title: '作废 MSA 研究',
        description: `研究 ${study.study_id}（${study.char_name || study.char_id || 'MSA'} · ${study.gauge_id}）将标记为“作废”，原始数据保留，关联计划退回“计划”。`,
        fields: [{ key: 'reason', label: '作废原因', type: 'textarea', rows: 3, required: true }],
        confirmText: '确认作废', danger: true,
        validate: values => values.reason.trim().length >= 4 ? '' : '请填写不少于 4 个字的作废原因。',
      });
      if (!result) return;
      try {
        await api('/msa/' + study.study_id + '/void', { method: 'PATCH', body: { reason: result.reason.trim() } });
        if (String(state.msaStudyId) === String(study.study_id)) state.msaStudyId = null;
        toast('研究已作废，记录与原始数据保留', 'ok');
        await vMsa();
      } catch (error) { toast(error.message, 'err'); }
    };
  });
  const syncCharRange = () => {
    const char = selectedChar();
    $$('[data-gauge-study]').forEach(el => {
      el.textContent = gaugeStudyText(el.dataset.gaugeStudy, char?.pchar_id, $('#mPlan')?.value);
    });
    if (!char) {
      if ($('#mCharRange')) $('#mCharRange').textContent = '请先维护项目特性';
      return;
    }
    const tol = char.lsl != null && char.usl != null ? Math.abs(char.usl - char.lsl) : null;
    $('#mCharRange').textContent = `目标 ${char.target ?? '—'} ${char.unit || ''} · LSL ${char.lsl ?? '—'} / USL ${char.usl ?? '—'} · 容差 ${tol == null ? '—' : +tol.toFixed(6)}`;
    if ($('#mTol')) {
      $('#mTol').readOnly = tol != null;
      $('#mTol').title = tol != null ? '有项目特性 LSL/USL 时，容差取 USL-LSL' : '';
    }
    if (char.lsl != null && char.usl != null) {
      $('#mTol').value = +Math.abs(char.usl - char.lsl).toFixed(6);
    }
  };
  /** 左侧「检具与有效性」状态：跟随当前特性/计划，而不是固定默认值 */
  const refreshGaugeStudyTexts = () => {
    const char = selectedChar();
    const planId = $('#mPlan')?.value || '';
    $$('[data-gauge-study]').forEach(el => {
      el.textContent = gaugeStudyText(el.dataset.gaugeStudy, char?.pchar_id, planId);
    });
    // 当前选中的检具若校准过期/停用，直接在研究设计里提示（服务端会拒绝保存）
    // “本厂其他检具”不在 ledgerGauges 里，改看选项上带的 data-warning
    const hint = $('#mGaugeHint');
    if (hint) {
      const selectedId = $('#mGauge')?.value;
      const gauge = [...ledgerGauges, ...otherGauges].find(item => item.gauge_id === selectedId);
      const flagged = gauge ? gauge.calibration_warning
        : !!$('#mGauge')?.selectedOptions?.[0]?.dataset.warning;
      hint.textContent = flagged
        ? `该检具${gauge && ['停用', '报废'].includes(gauge.status) ? `为“${gauge.status}”` : '校准已过期或未维护'}，服务端会拒绝保存研究；请先维护校准状态。`
        : '';
    }
  };
  const dimensions = () => ({
    parts: +$('#mParts').value || 10,
    ops: +$('#mOps').value || 3,
    trials: +$('#mTrials').value || 3,
  });
  // 记录最近一次模拟的零件真实值：只有网格数据仍与模拟结果一致时才随研究一起保存，
  // 避免用户手工改数后把过期的中心值写进研究。
  let lastSimulation = null;
  const simulationKey = () => {
    const { parts, ops, trials } = dimensions();
    return [state.project, $('#mChar')?.value, $('#mGauge')?.value, parts, ops, trials].join('|');
  };
  const readData = () => {
    const { parts, ops, trials } = dimensions();
    const data = [];
    for (let row = 0; row < ops * trials; row += 1) {
      const values = [];
      for (let column = 0; column < parts; column += 1) {
        const input = document.querySelector(`.msa-cell[data-r="${row}"][data-c="${column}"]`);
        const raw = input ? input.value.trim() : '';
        if (raw === '') return null;
        values.push(+raw);
      }
      data.push(values);
    }
    return data;
  };
  const renderMsaGrid = (snapshot = {}) => {
    const { parts, ops, trials } = dimensions();
    $('#mShapeHint').textContent = `${ops * trials} 行 × ${parts} 列 · ${ops * trials * parts} 个数据点`;
    $('#mDataGrid').innerHTML = `<table class="msa-input-table"><thead><tr><th>评价人 / 试验</th>
      ${Array.from({ length: parts }, (_, index) => `<th>零件 ${index + 1}</th>`).join('')}</tr></thead><tbody>
      ${Array.from({ length: ops * trials }, (_, row) => `<tr><th>评价人 ${Math.floor(row / trials) + 1}<small>试验 ${row % trials + 1}</small></th>
        ${Array.from({ length: parts }, (_, column) => `<td><input class="msa-cell" data-r="${row}" data-c="${column}" type="number" step="any" value="${esc(snapshot[`${row},${column}`] || '')}" aria-label="评价人${Math.floor(row / trials) + 1} 试验${row % trials + 1} 零件${column + 1}"></td>`).join('')}
      </tr>`).join('')}</tbody></table>`;
  };
  renderMsaGrid();
  syncCharRange();
  /** 无研究编制权限的账号：只读历史与结果，不能生成数据或计算 */
  const lockStudyInputs = () => {
    if (canStudy) return;
    ['#mSample', '#mClear', '#mRun'].forEach(selector => {
      const button = $(selector);
      if (button) {
        button.disabled = true;
        button.title = '当前账号没有 MSA 研究编制权限';
      }
    });
    ['#mPlan', '#mChar', '#mGauge', '#mTol', '#mParts', '#mOps', '#mTrials', '#mSimTarget'].forEach(selector => {
      const input = $(selector);
      if (input) input.disabled = true;
    });
    $$('.msa-cell').forEach(input => { input.readOnly = true; });
  };
  // 默认优先选“真正可用”（未过期、非停用）的检具
  if ($('#mGauge')) {
    const preferred = activeGauges[0] || ledgerGauges.find(g => g.status !== '报废');
    if (preferred) $('#mGauge').value = preferred.gauge_id;
  }
  const gridFilledCount = () => $$('.msa-cell').filter(input => input.value !== '').length;
  const clearStudyOutputs = (message) => {
    renderMsaGrid();
    lastSimulation = null;
    if ($('#mSimInfo')) $('#mSimInfo').innerHTML = '';
    if ($('#mResult')) $('#mResult').innerHTML = message || '<div class="empty">填写数据后点击“计算 GR&amp;R”</div>';
  };
  /**
   * 研究身份（计划/特性/检具/维度）变化时统一处理：
   * 已录入数据会失效，先确认再清空，避免旧数据被算到新特性或新检具上。
   */
  const switchContext = async (reason, apply) => {
    const filled = gridFilledCount();
    if (filled) {
      const confirmed = await showConfirmDialog('研究条件已变化',
        `${reason}：已录入的 ${filled} 个数据点属于原来的研究条件，继续会清空数据与结果。是否继续？`,
        { confirmText: '继续并清空', danger: true });
      if (!confirmed) return false;
    }
    apply();
    clearStudyOutputs();
    return true;
  };

  const applyPlanInner = () => {
    const option = $('#mPlan')?.selectedOptions?.[0];
    const plan = option?.value ? plans.find(item => item.plan_id === option.value) : null;
    const locked = !!plan;
    ['#mChar', '#mGauge', '#mParts', '#mOps', '#mTrials'].forEach(selector => {
      const input = $(selector);
      if (input) input.disabled = locked || (selector === '#mChar' && !chars.length);
    });
    if (!locked) {
      // 「临时研究」是独立起点，不应沿用上一个计划的参数
      const fallbackChar = defaultChar?.pchar_id || chars[0]?.pchar_id || '';
      if ($('#mChar') && fallbackChar) $('#mChar').value = fallbackChar;
      if ($('#mGauge')) {
        const preferred = activeGauges[0] || ledgerGauges.find(g => g.status !== '报废');
        if (preferred) $('#mGauge').value = preferred.gauge_id;
      }
      $('#mParts').value = 10;
      $('#mOps').value = 3;
      $('#mTrials').value = 3;
      if ($('#mTol')) { $('#mTol').readOnly = false; $('#mTol').value = toleranceFor(selectedChar()); }
      if ($('#mPlanHint')) $('#mPlanHint').textContent = '临时研究不会回写 P3-08 MSA 计划，但计算结果仍会保存历史。';
      syncCharRange();
      refreshGaugeStudyTexts();
      return;
    }
    const charValue = option.dataset.char || '';
    const gaugeValue = option.dataset.gauge || '';
    const charValid = !charValue || chars.some(item => item.pchar_id === charValue);
    // 计划检具只要还在台账（非报废）就算有效；校准过期由提示与保存时的服务端校验拦下
    const gaugeValid = !gaugeValue || ledgerGauges.some(item =>
      item.gauge_id === gaugeValue && item.status !== '报废');
    if (charValue) $('#mChar').value = charValue;
    if (gaugeValue) $('#mGauge').value = gaugeValue;
    if (!charValid || !gaugeValid) {
      // 特性被删除或检具报废时，计划无法执行：退回临时研究并说明原因，避免控件空白且被禁用
      $('#mPlan').value = '';
      applyPlan();
      toast(`计划 ${plan.plan_id} 的${!charValid ? '项目特性' : '检具'}已不存在，已切换为临时研究`, 'warn');
      return;
    }
    $('#mParts').value = option.dataset.parts || 10;
    $('#mOps').value = option.dataset.operators || 3;
    $('#mTrials').value = option.dataset.trials || 3;
    syncCharRange();
    if ($('#mTol')) {
      // 计划有公差时锁定；计划公差为空时允许按 M-07 提示补填
      const hasTolerance = plan.tolerance != null;
      if (hasTolerance) $('#mTol').value = plan.tolerance;
      $('#mTol').readOnly = hasTolerance;
      $('#mTol').title = hasTolerance ? '计划已维护容差，如需调整请先维护计划'
        : '该计划尚未维护公差：可在此填写正数，保存研究时写回计划';
    }
    refreshGaugeStudyTexts();
    $('#mPlanHint').textContent = `来源 ${plan.trigger_source || 'CP'} ${plan.source_version || ''}；${plan.step_no || ''} ${plan.measure_tech || ''}；特性、设备及研究参数已锁定。`;
  };
  // 只读锁必须每次都覆盖，否则任何一次 applyPlan 都会把控件重新打开
  const applyPlan = () => { applyPlanInner(); lockStudyInputs(); };

  // 记住上一次有效的计划选择，用户取消清空时好恢复
  // 计划选择同时记到 state，页面重绘后仍停在同一计划
  let lastPlanId = $('#mPlan')?.value || '';
  state.msaPlanId = lastPlanId;
  if ($('#mPlan')) $('#mPlan').onchange = async () => {
    const option = $('#mPlan')?.selectedOptions?.[0];
    const plan = option?.value ? plans.find(item => item.plan_id === option.value) : null;
    const reason = plan
      ? `已选择计划 ${plan.plan_id}（${plan.char_name || plan.char_id || ''} · ${plan.gauge_id || ''}）`
      : '已切换为临时研究';
    const proceed = await switchContext(reason, () => {});
    if (!proceed) { $('#mPlan').value = lastPlanId; return; }
    lastPlanId = plan ? plan.plan_id : '';
    state.msaPlanId = lastPlanId;
    applyPlan();
  };
  applyPlan();
  // 改特性/改检具都会改变研究身份：先确认再清空旧数据；取消时恢复原选择
  if ($('#mChar')) {
    let lastCharId = $('#mChar').value;
    $('#mChar').onchange = async () => {
      const char = selectedChar();
      const chosen = $('#mChar').value;
      const proceed = await switchContext(
        `项目特性改为 ${char?.name || char?.char_id || '未选择'}`, () => {});
      if (!proceed) { $('#mChar').value = lastCharId; return; }
      lastCharId = chosen;
      syncCharRange();
      refreshGaugeStudyTexts();
    };
  }
  if ($('#mGauge')) {
    let lastGaugeId = $('#mGauge').value;
    $('#mGauge').onchange = async () => {
      const chosen = $('#mGauge').value;
      const gauge = [...ledgerGauges, ...otherGauges].find(item => item.gauge_id === chosen);
      const proceed = await switchContext(
        `测量设备改为 ${gauge ? `${gauge.gauge_id} ${gauge.name || ''}` : '未选择'}`, () => {});
      if (!proceed) { $('#mGauge').value = lastGaugeId; return; }
      lastGaugeId = chosen;
      refreshGaugeStudyTexts();
    };
  }
  $$('[data-start-plan]').forEach(button => button.onclick = async () => {
    const planId = button.dataset.startPlan;
    const plan = plans.find(item => item.plan_id === planId);
    const proceed = await switchContext(
      `即将开展计划 ${planId}${plan ? `（${plan.char_name || plan.char_id || ''} · ${plan.gauge_id || ''}）` : ''}`,
      () => {});
    if (!proceed) return;
    $('#mPlan').value = planId;
    lastPlanId = planId;
    state.msaPlanId = planId;
    applyPlan();
    $('#mPlan')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  });
  $$('[data-edit-plan]').forEach(button => button.onclick = () => {
    const plan = plans.find(item => item.plan_id === button.dataset.editPlan);
    if (!plan) return;
    const drawer = $('#drawer');
    $('.drawer-box', drawer).innerHTML = `
      <div class="drawer-h"><div><h2>维护 MSA 计划</h2><p>${esc(planCharLabel(plan))} · ${esc(planGaugeLabel(plan))}</p></div>
        <button class="x" onclick="document.getElementById('drawer').classList.remove('open')">✕</button></div>
      <div class="drawer-b">
        <div class="row2"><div class="field"><label>计划日期</label><input type="date" id="mpDate" value="${esc(plan.planned_date || '')}"></div>
          <div class="field"><label>责任人</label><input id="mpOwner" value="${esc(plan.owner || '')}"></div></div>
        <div class="row3"><div class="field"><label>零件数</label><input id="mpParts" type="number" min="2" max="10" value="${plan.parts}"></div>
          <div class="field"><label>评价人数</label><input id="mpOps" type="number" min="2" max="4" value="${plan.operators}"></div>
          <div class="field"><label>试验次数</label><input id="mpTrials" type="number" min="2" max="5" value="${plan.trials}"></div></div>
        ${(plan.study_type || 'GRR') === 'GRR' ? `<div class="field"><label>研究容差（USL-LSL）</label><input id="mpTolerance" type="number" min="0" step="any" value="${plan.tolerance ?? ''}"></div>` : ''}
        <div class="field"><label>备注</label><textarea id="mpNote" rows="3">${esc(plan.note || '')}</textarea></div>
        <div style="display:flex;gap:8px">
          <button class="btn" id="mpSave" ${plan.status === '已完成' ? 'disabled' : ''}>保存计划</button>
          ${plan.status === '研究中'
            ? '<button class="btn ghost" id="mpReopen">评审不通过，退回计划</button>' : ''}
        </div>
      </div>`;
    drawer.classList.add('open');
    if ($('#mpReopen')) $('#mpReopen').onclick = async () => {
      const result = await showFormDialog({
        title: '退回 MSA 计划',
        description: '研究判定为条件接受/不接受或需要重做时，把计划退回“计划”状态；原研究保留在历史记录中。',
        fields: [{ key: 'note', label: '退回原因', type: 'textarea', rows: 3, required: true }],
        confirmText: '退回计划',
        validate: values => values.note.trim().length >= 4 ? '' : '请填写不少于 4 个字的退回原因。',
      });
      if (!result) return;
      try {
        await api('/msa/plans/' + encodeURIComponent(plan.plan_id), {
          method: 'PATCH', body: { status: '计划', note: result.note.trim() },
        });
        drawer.classList.remove('open');
        toast('计划已退回，可重新开展研究', 'ok');
        vMsa();
      } catch (e) { toast(e.message, 'err'); }
    };
    $('#mpSave').onclick = async () => {
      try {
        const tolerance = $('#mpTolerance');
        if (tolerance && (!Number.isFinite(+tolerance.value) || +tolerance.value <= 0)) {
          throw new Error('请在计划中填写大于 0 的研究容差');
        }
        await api('/msa/plans/' + encodeURIComponent(plan.plan_id), { method: 'PATCH', body: {
          planned_date: $('#mpDate').value, owner: $('#mpOwner').value,
          parts: +$('#mpParts').value, operators: +$('#mpOps').value,
          trials: +$('#mpTrials').value, note: $('#mpNote').value, user: '质量-陈',
          ...(tolerance ? { tolerance: +tolerance.value } : {}),
        } });
        drawer.classList.remove('open');
        toast('MSA 计划已更新并同步 P3-08', 'ok');
        vMsa();
      } catch (e) { toast(e.message, 'err'); }
    };
  });
  $$('[data-external-plan]').forEach(button => button.onclick = () => {
    const plan = plans.find(item => item.plan_id === button.dataset.externalPlan);
    if (!plan) return;
    const drawer = $('#drawer');
    $('.drawer-box', drawer).innerHTML = `
      <div class="drawer-h"><div><h2>登记外部 MSA 研究</h2><p>${esc(plan.char_name || plan.char_id)} · ${esc(plan.gauge_code || plan.gauge_id)} · ${esc(plan.study_type)}</p></div>
        <button class="x" onclick="document.getElementById('drawer').classList.remove('open')">✕</button></div>
      <div class="drawer-b">
        <form id="msaExternalForm">
          <div class="field"><label>受控研究报告编号</label><input id="meEvidence" required maxlength="300"></div>
          <div class="field"><label>实际研究方法</label><input id="meMethod" required maxlength="300" value="${esc(plan.measure_tech || '')}"></div>
          <div class="row2"><div class="field"><label>研究日期</label><input type="date" id="meDate" required value="${new Date().toLocaleDateString('sv-SE')}"></div>
            <div class="field"><label>报告确认人</label><input id="meOperator" required value="${esc(state.user?.display_name || '')}"></div></div>
          <div class="field"><label>报告结论</label><select id="meJudgment" required><option value="">请选择报告实际结论</option>
            ${['接受', '条件接受', '不接受'].map(value => `<option>${value}</option>`).join('')}</select></div>
          <p class="dim">登记受控报告引用；本记录不表示报告附件已经上传。接受结论仍需单独确认完成。</p>
          <button class="btn" type="submit" id="meSave">登记研究</button>
        </form>
      </div>`;
    drawer.classList.add('open');
    $('#msaExternalForm').onsubmit = async event => {
      event.preventDefault();
      const save = $('#meSave');
      save.disabled = true;
      const operator = $('#meOperator').value.trim();
      const judgment = $('#meJudgment').value;
      try {
        const result = await api('/msa/external', { method: 'POST', body: {
          plan_id: plan.plan_id, evidence_ref: $('#meEvidence').value.trim(),
          method: $('#meMethod').value.trim(), judgment,
          studied_at: $('#meDate').value, operator,
        } });
        await vMsa();
        $('.drawer-box', drawer).innerHTML = `
          <div class="drawer-h"><div><h2>外部研究已登记</h2><p>${esc(plan.char_name || plan.char_id)} · ${esc(plan.gauge_id)}</p></div>
            <button class="x" onclick="document.getElementById('drawer').classList.remove('open')">✕</button></div>
          <div class="drawer-b"><p>研究记录 ${esc(result.study_id)} · ${esc(judgment)}</p>
            <p class="dim">${judgment === '接受' ? '请确认报告已覆盖本计划的特性、量具和实际测量方法。' : '计划保持未完成，请按实际报告结论改善和复核。'}</p>
            ${judgment === '接受' ? '<button class="btn" id="meComplete">确认研究完成</button>' : ''}</div>`;
        if ($('#meComplete')) $('#meComplete').onclick = () => completeStudy(result.study_id, operator);
        toast('外部研究报告引用已登记', 'ok');
      } catch (e) { toast(e.message, 'err'); save.disabled = false; }
    };
  });
  $$('[data-pick-gauge]').forEach(button => button.onclick = async () => {
    const gaugeId = button.dataset.pickGauge;
    const gauge = activeGauges.find(item => item.gauge_id === gaugeId);
    // 只匹配“可开展”的计划：正在研究/已完成/来源失效的计划都不在 #mPlan 选项里
    const matchingPlan = researchPlans.find(plan => plan.gauge_id === gaugeId && plan.project_char_id);
    const busyPlan = currentPlans.find(plan => plan.gauge_id === gaugeId
      && plan.project_char_id && plan.status === '研究中');
    const reason = matchingPlan
      ? `已切换到计划 ${matchingPlan.plan_id}（${matchingPlan.char_name || matchingPlan.char_id || ''}）`
      : `已设为临时研究设备 ${gaugeId}${gauge?.name ? ` ${gauge.name}` : ''}`;
    const proceed = await switchContext(reason, () => {});
    if (!proceed) return;
    if (matchingPlan && $('#mPlan')) {
      $('#mPlan').value = matchingPlan.plan_id;
      lastPlanId = matchingPlan.plan_id;
      state.msaPlanId = matchingPlan.plan_id;
      applyPlan();
      toast(`已切换到计划 ${matchingPlan.plan_id}`, 'ok');
    } else {
      if ($('#mPlan')) $('#mPlan').value = '';
      lastPlanId = '';
      state.msaPlanId = '';
      if ($('#mGauge')) $('#mGauge').value = gaugeId;
      applyPlan();
      toast(busyPlan
        ? `该检具对应计划 ${busyPlan.plan_id} 正在研究中：请先退回该计划，或在此以临时研究继续`
        : '已切换为临时研究设备', busyPlan ? 'warn' : 'ok');
    }
    $('.msa-setup-grid')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  });
  ['#mParts', '#mOps', '#mTrials'].forEach(selector => {
    const el = $(selector);
    if (!el) return;
    el.addEventListener('focus', () => { el.dataset.before = el.value; });
    el.onchange = async event => {
      // M-15：维度变化后按旧索引保留数据会错位，二次确认后清空
      const filled = $$('.msa-cell').filter(input => input.value !== '').length;
      if (filled) {
        const ok = await showConfirmDialog('修改研究维度',
          `维度变化会清空已录入的 ${filled} 个数据点（按旧行列索引保留会导致错位）。是否继续？`,
          { confirmText: '继续并清空', danger: true });
        if (!ok) {
          event.target.value = event.target.dataset.before || event.target.value;
          return;
        }
      }
      event.target.dataset.before = event.target.value;
      renderMsaGrid();
      lastSimulation = null;
      toast('研究维度已更新，录入数据已清空', 'ok');
    };
  });
  $('#mSample').onclick = async () => {
    try {
      const { parts, ops, trials } = dimensions();
      if (!$('#mChar').value) throw new Error('请选择项目特性');
      if (!$('#mGauge').value) throw new Error('请选择测量设备');
      // 覆盖已录入的数据前先确认，避免误点丢失手工数据
      const filled = gridFilledCount();
      if (filled) {
        const confirmed = await showConfirmDialog('重新生成模拟数据',
          `将覆盖已录入的 ${filled} 个数据点。是否继续？`,
          { confirmText: '覆盖并生成', danger: true });
        if (!confirmed) return;
      }
      const result = await api('/msa/simulate', { method: 'POST', body: {
        project_char_id: $('#mChar').value,
        gauge_id: $('#mGauge').value,
        parts, operators: ops, trials,
        tolerance: +$('#mTol').value,
        target_pct: +$('#mSimTarget').value,
      } });
      renderMsaGrid();
      if ($('#mResult')) $('#mResult').innerHTML = '<div class="empty">数据已更新，请点击“计算 GR&amp;R”</div>';
      result.data.forEach((values, row) => values.forEach((value, column) => {
        const input = document.querySelector(`.msa-cell[data-r="${row}"][data-c="${column}"]`);
        if (input) input.value = value;
      }));
      lastSimulation = result.part_values
        ? { key: simulationKey(), data: result.data, partValues: result.part_values } : null;
      $('#mSimInfo').innerHTML = `<div class="alert ${result.resolution_ok ? 'info' : 'warn'}">
        <div><b>模拟目标 %GRR ${result.target_pct}% → 试算 ${fmt(result.actual_pct)}%</b><br>
        ${result.spec_lsl == null ? '项目特性未配置 LSL/USL；' : `规格 LSL ${spcNum(result.spec_lsl)} / USL ${spcNum(result.spec_usl)}；`}
        本次容差 ${spcNum(result.tolerance)}；零件真实值 ${spcNum(result.part_value_min)}–${spcNum(result.part_value_max)}；模拟读数 ${spcNum(result.reading_min)}–${spcNum(result.reading_max)}。<br>
        量具有效分辨力 ${esc(result.gauge_resolution)}；十等分建议值 ≤ ${esc(result.recommended_resolution)}。
        ${result.resolution_ok ? '分辨力符合建议。' : '当前分辨力不足，低 %GRR 目标可能无法稳定实现。'}<br>
        <span class="dim">模拟中心值（零件真实值）：${(result.part_values || []).map(value => spcNum(value)).join(' / ')}；随研究保存并写入导出数据表的“零件真实值”行。</span></div>
      </div>`;
      toast('已按项目特性和量具分辨力生成模拟数据，请点击计算 GR&R 复核', 'ok');
    } catch (e) { toast(e.message, 'err'); }
  };
  $('#mClear').onclick = () => {
    $$('.msa-cell').forEach(input => { input.value = ''; });
    lastSimulation = null;
    $('#mResult').innerHTML = '<div class="empty">填写数据后点击“计算 GR&amp;R”</div>';
  };
  $('#mRun').onclick = async () => {
    try {
      const { parts, ops, trials } = dimensions();
      const data = readData();
      if (!data) throw new Error(`请填完整 ${ops * trials} 行 × ${parts} 列数据`);
      const projectCharId = $('#mChar').value;
      if (!projectCharId) throw new Error('请选择项目特性');
      if (!$('#mGauge').value) throw new Error('请选择检具');
      // 网格仍等于模拟结果时，把零件真实值一并保存，导出报告可对照“中心值→读数→结论”
      const simulated = lastSimulation && lastSimulation.key === simulationKey()
        && JSON.stringify(lastSimulation.data) === JSON.stringify(data)
        ? lastSimulation.partValues : null;
      const r = await api('/msa', { method: 'POST', body: {
        gauge_id: $('#mGauge').value, project_char_id: projectCharId,
        plan_id: $('#mPlan').value || null,
        data, tolerance: +$('#mTol').value, parts, ops, trials,
        part_values: simulated,
      } });
      // 保存后计划进入“研究中”，记住它以便刷新后仍停在同一计划上
      state.msaPlanId = r.plan_id || '';
      const resultHtml = msaResultPanel(r, data)
        + (r.judgment === '接受' ? `<div class="msa-complete-bar">
          <div><b>研究合格，可以完成确认</b><div class="dim">${r.plan_id ? '完成后关闭当前特性、量具与方法对应的计划。' : '本次为临时研究，不关闭任何 MSA 计划。'}确认人和时间会保留。</div></div>
          <button class="btn" id="mComplete">确认 MSA 研究完成</button></div>` : '')
        + (r.plan_id ? '' : '<div class="alert info" style="margin-top:10px"><div>本次为临时研究：结果已写入历史，但不会回写或关闭任何 MSA 计划。</div></div>');
      // 保存研究会把计划推进到“研究中”，必须重新拉取计划表、历史研究与导出下拉
      await vMsa();
      if ($('#mResult')) {
        $('#mResult').innerHTML = resultHtml;
        if ($('#mComplete')) $('#mComplete').onclick = () => completeStudy(r.study_id);
      }
      toast('计算完成，已写入当前项目研究记录', 'ok');
    } catch (e) { toast(e.message, 'err'); }
  };
  // 台账页仅在具备「台账与校准」权限时渲染；无权限的账号没有新增按钮
  if ($('#btnAddGauge')) $('#btnAddGauge').onclick = () => {
    const drawer = $('#drawer');
    const openAddGauge = (preset = {}) => {
      $('.drawer-box', drawer).innerHTML = `
        <div class="drawer-h"><div><h2>新增检具</h2><p>检具台账全局共享，供 CP、MSA 与基线引用。</p></div>
          <button class="x" onclick="document.getElementById('drawer').classList.remove('open')">✕</button></div>
        <div class="drawer-b">
          <div class="row2"><div class="field"><label>检具编号</label><input id="gCode" placeholder="G-100" value="${esc(preset.code || '')}"></div>
            <div class="field"><label>名称</label><input id="gName" placeholder="数显电桥" value="${esc(preset.name || '')}"></div></div>
          <div class="row2"><div class="field"><label>型号</label><input id="gModel"></div>
            <div class="field"><label>量程</label><input id="gRange" value="${esc(preset.range_text || '')}"></div></div>
          <div class="field"><label>分辨力</label><input id="gResolution" type="number" min="0" step="any" placeholder="例如 0.001"></div>
          <div class="row2"><div class="field"><label>校准到期日</label><input type="date" id="gCal"></div>
            <div class="field"><label>使用部门</label><input id="gDept"></div></div>
          <button class="btn" id="gSave">新增检具</button>
        </div>`;
      drawer.classList.add('open');
      if (preset.focus) $('#gRange')?.focus();
      $('#gSave').onclick = async () => {
        try {
          await api('/gauges', { method: 'POST', body: {
            code: $('#gCode').value, name: $('#gName').value, model: $('#gModel').value,
            range_text: $('#gRange').value, calibration_due: $('#gCal').value,
            owner_dept: $('#gDept').value, resolution: $('#gResolution').value,
          } });
          toast('检具已新增', 'ok'); drawer.classList.remove('open'); vMsa();
        } catch (e) { toast(e.message, 'err'); }
      };
    };
    openAddGauge();
  };
  $$('[data-create-gauge-from-plan]').forEach(button => button.onclick = () => {
    const gauge = gauges.find(item => item.gauge_id === button.dataset.createGaugeFromPlan);
    if (!gauge || !$('#btnAddGauge')) return;
    $('#btnAddGauge').click();
    const preset = {
      code: gauge.code === '未建台账' ? '' : gauge.code || '',
      name: gauge.name || '', range_text: gauge.range_text || '', focus: true,
    };
    // 复用 vMsaContent 内同一抽屉渲染器（如果存在），否则直接填充已打开表单
    const codeInput = $('#gCode');
    if (codeInput) {
      codeInput.value = preset.code;
      $('#gName').value = preset.name;
      $('#gRange').value = preset.range_text;
      $('#gRange').focus();
    }
  });
  // 把“本厂其他检具”加入本项目研究：选中它作为临时研究设备
  $$('[data-use-other-gauge]').forEach(button => button.onclick = async () => {
    const gaugeId = button.dataset.useOtherGauge;
    if (!$('#mGauge')) return;
    // 统一走站内确认框：项目禁止浏览器原生 confirm
    if (gridFilledCount() > 0) {
      const confirmed = await showConfirmDialog('切换测量设备',
        '当前数据矩阵已有数据，切换设备会清空已录入的数据。是否继续？',
        { confirmText: '继续并清空', danger: true });
      if (!confirmed) return;
      clearStudyOutputs();
    }
    const other = otherGauges.find(item => item.gauge_id === gaugeId) || {};
    const option = [...$('#mGauge').options].find(item => item.value === gaugeId);
    if (!option) {
      // 该检具此前不在本项目列表里，补一个选项再选中；校准状态随选项带过去，提示才能显示
      const opt = document.createElement('option');
      opt.value = gaugeId;
      opt.textContent = `${gaugeId} ${other.name || ''}${other.calibration_warning ? '（校准过期/停用）' : ''}`.trim();
      if (other.calibration_warning) opt.dataset.warning = '1';
      $('#mGauge').appendChild(opt);
    }
    $('#mGauge').value = gaugeId;
    $('#mGauge').dispatchEvent(new Event('change'));
    // 本项目原本没有任何可用检具时“计算 GR&R”是禁用的；选中后必须放开，否则走不到计算
    if ($('#mRun') && chars.length) $('#mRun').disabled = false;
    $('#mGauge').scrollIntoView({ behavior: 'smooth', block: 'center' });
    toast(`研究设备已设为 ${gaugeId}（本项目此前未使用过该检具）`, 'ok');
  });
  $$('[data-edit-gauge]').forEach(button => button.onclick = async () => {
    const gauge = gauges.find(item => item.gauge_id === button.dataset.editGauge);
    if (!gauge) return;
    const drawer = $('#drawer');
    $('.drawer-box', drawer).innerHTML = `
      <div class="drawer-h"><div><h2>维护检具能力</h2><p>${esc(gauge.gauge_id)} · ${esc(gauge.name)}</p></div>
        <button class="x" onclick="document.getElementById('drawer').classList.remove('open')">✕</button></div>
      <div class="drawer-b">
        <div class="row2"><div class="field"><label>检具编号</label><input id="egCode" value="${esc(gauge.code || gauge.gauge_id)}"></div>
          <div class="field"><label>名称</label><input id="egName" value="${esc(gauge.name || '')}"></div></div>
        <div class="row2"><div class="field"><label>型号</label><input id="egModel" value="${esc(gauge.model || '')}"></div>
          <div class="field"><label>量程 / 能力指标</label><input id="egRange" value="${esc(gauge.range_text || '')}" placeholder="例如 0–100 μm；U=0.5 μm"></div></div>
        <div class="row2"><div class="field"><label>分辨力</label><input id="egResolution" type="number" min="0" step="any" value="${gauge.resolution ?? ''}"></div>
          <div class="field"><label>校准到期日</label><input id="egCal" type="date" value="${esc(gauge.calibration_due || '')}"></div></div>
        <div class="row2"><div class="field"><label>使用部门</label><input id="egDept" value="${esc(gauge.owner_dept || '')}"></div>
          <div class="field"><label>状态</label><select id="egStatus">${['在用','停用','报废'].map(status =>
            `<option ${status === (gauge.status || '在用') ? 'selected' : ''}>${status}</option>`).join('')}</select></div></div>
        <div class="alert info">维护量程、能力指标和分辨力用于后续 MSA 可行性判断；不会改写已完成的历史研究。</div>
        <button class="btn" id="egSave">保存检具能力</button>
      </div>`;
    drawer.classList.add('open');
    $('#egSave').onclick = async () => {
      try {
        await api('/gauges/' + encodeURIComponent(gauge.gauge_id), {
          method: 'PATCH', body: {
            code: $('#egCode').value.trim(), name: $('#egName').value.trim(),
            model: $('#egModel').value.trim(), range_text: $('#egRange').value.trim(),
            resolution: $('#egResolution').value, calibration_due: $('#egCal').value,
            owner_dept: $('#egDept').value.trim(), status: $('#egStatus').value,
          },
        });
        toast('检具能力已更新，相关 MSA 计划已重新关联', 'ok');
        drawer.classList.remove('open');
        vMsa();
      } catch (e) { toast(e.message, 'err'); }
    };
  });
}

/* ------------------------------------------------------------------ PPAP */
function ppapDocPreviewHtml(doc) {
  const preview = doc.preview || {};
  return `<article class="ppap-doc-preview">
    <header>
      <div><span class="mono">${esc(doc.code)}</span><h3>${esc(doc.name)}</h3>
        <small>引用自项目阶段 · ${esc(doc.version || 'V1.0')} · 更新 ${esc(doc.updated_at || '—')}</small></div>
      <div>${statusBadge(doc.status)}${doc.approved_by ? `<span class="dim" style="font-size:11px">批准：${esc(doc.approved_by)}</span>` : ''}</div>
    </header>
    <div class="ppap-doc-sections">
      ${(preview.sections || []).map(section => `<section>
        <h4>${esc(section.title)}</h4>${section.note ? `<p class="dim">${esc(section.note)}</p>` : ''}
        <div class="ppap-doc-fields">
          ${section.fields.map(field => field.type === 'table'
            ? `<div class="ppap-readonly-table"><div class="lbl">${esc(field.label)}</div>
                <table class="t"><thead><tr>${(field.cols || []).map(col => `<th>${esc(col.label || col)}</th>`).join('')}</tr></thead><tbody>
                  ${(field.value || []).length ? field.value.map(row => `<tr>${(field.cols || []).map((col, index) => `<td>${esc(row[index] || '—')}</td>`).join('')}</tr>`).join('')
                    : `<tr><td colspan="${Math.max(1, (field.cols || []).length)}" class="dim">尚未填写</td></tr>`}
                </tbody></table></div>`
            : `<div class="ppap-readonly-field"><span>${esc(field.label)}</span><b>${esc(field.value === '' || field.value == null ? '—' : field.value)}</b></div>`).join('')}
        </div>
      </section>`).join('')}
    </div>
    <footer><div style="display:flex;gap:7px;flex-wrap:wrap"><button class="btn sm ghost" data-open-doc="${esc(doc.code)}">进入源文件审批</button>
      ${doc.template_id ? `<button class="btn sm ghost" data-open-stage-template="${esc(doc.template_id)}">打开原模板：${esc(doc.template_name || '')}</button>` : ''}</div>
      ${!['已批准','已完成','系统模块'].includes(doc.status) ? '<span class="badge b-warn">需先在项目阶段完成审批</span>' : ''}</footer>
  </article>`;
}

function openPpapEvidence(no) {
  closeRelatedPreview();
  hideQualityLinks();
  const elementNo = Math.max(1, Math.min(18, +no || 1));
  state.view = 'ppapEvidence';
  state.ppapNo = String(elementNo);
  setRouteHash('ppap/' + elementNo);
  paintNav();
  $('#viewTitle').textContent = 'PPAP 证据工作台';
  $('#view').innerHTML = '<div class="empty">加载证据清单…</div>';
  vPpapEvidence(elementNo).catch(error => {
    $('#view').innerHTML = `<div class="alert bad">${esc(error.message)}</div>`;
  });
}

async function vPpapEvidence(no) {
  const d = await api('/ppap/evidence/' + no);
  state.ppapNo = String(no);
  const element = d.element || {};
  const workflow = d.workflow || {};
  const mapping = d.mapping || {};
  const templates = d.customTemplates || [];
  const artifacts = d.artifacts || [];
  const renderedSourceTypes = ['docs', 'fmea', 'pfd', 'cp', 'msa', 'spc', 'gauge'];
  const sourceRendered = renderedSourceTypes.includes(mapping.sourceType);
  $('#viewTitle').textContent = `PPAP ${String(no).padStart(2, '0')} · ${element.name || mapping.sourceLabel || ''}`;
  $('#viewSub').textContent = `${mapping.phase || ''} · ${mapping.owner || ''} · 系统只提供取证入口，完成状态和适用性由责任人确认`;
  $('#view').innerHTML = `
    <div class="docbar">
      <div><button class="btn ghost" id="ppapEvidenceBack">返回 PPAP</button></div>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        ${statusBadge(element.status || '未完成')}
        <span class="badge ${(element.applicability || '适用') === '不适用' ? 'b-gray' : 'b-ok'}">${esc(element.applicability || '适用')}</span>
        <span class="badge ${workflow.linked_ready ? 'b-ok' : 'b-warn'}">关联：${esc(workflow.linked_status || '待关联')}</span>
        <button class="btn ghost" id="ppapEvidenceUpload">${mapping.sourceType === 'manual' ? '上传 / 新建证据模板' : '补充人工附件'}</button>
        ${element.status === '待确认' && ['quality', 'admin'].includes(state.user?.role)
          ? '<button class="btn" id="ppapEvidenceConfirm">确认完成</button>' : ''}
        <button class="btn ${element.status === '待确认' ? 'ghost' : ''}" id="ppapEvidenceSave">${element.status === '已完成' ? '更新证据' : '保存证据（待确认）'}</button>
      </div>
    </div>
    <div class="ppap-evidence-head">
      <div><span class="lbl">PPAP 要素</span><h2>${String(no).padStart(2, '0')} ${esc(element.name || '')}</h2>
        <p>${esc(mapping.rule || '')}</p></div>
      <div class="kv">
        <div class="k">APQP 阶段</div><div>${esc(mapping.phase || '—')}</div>
        <div class="k">建议责任</div><div>${esc(mapping.owner || '—')}</div>
        <div class="k">关联对象</div><div>${esc(mapping.sourceLabel || '—')}</div>
        <div class="k">系统明细</div><div>${esc(workflow.link_detail || '—')}</div>
      </div>
    </div>
    <div class="grid g23">
      <div class="stack ppap-evidence-main ${sourceRendered ? 'source-rendered' : ''}">
        <section class="card ppap-checklist-card ${sourceRendered ? 'compact' : ''}">
          <div class="card-h"><h3>${sourceRendered ? '取证要点' : '应准备的证据'}</h3><span class="hint">${sourceRendered ? '引用内容已自动渲染，核对以下要点即可' : '清单来自 PPAP 初稿，可据此确认修订'}</span></div>
          ${sourceRendered
            ? `<div class="card-b ppap-keypoints">${(mapping.evidenceItems || []).map((item, index) => `<span><b>${index + 1}</b>${esc(item)}</span>`).join('')}</div>`
            : `<div class="card-b evidence-checklist">
            ${(mapping.evidenceItems || []).map((item, index) => `<div class="evidence-check-item">
              <span>${index + 1}</span><div><b>${esc(item)}</b><small>请确认适用性并关联文件、模块记录或填写证据编号</small></div>
            </div>`).join('')}
          </div>`}
        </section>

        ${d.fmea ? `<section class="card">
          <div class="card-h"><h3>${esc(d.fmea.header.fmea_type)} 最终版</h3>
            <div style="display:flex;gap:8px;align-items:center">${d.fmea.final_version ? '<span class="badge b-ok">已发布最终版</span>' : '<span class="badge b-warn">当前未发布</span>'}
              <button class="btn sm ghost" data-open-module="fmea" data-module-arg="${esc(d.fmea.header.fmea_type)}">打开 FMEA 模块</button></div></div>
          <div class="card-b">
            <div class="kv" style="margin-bottom:10px"><div class="k">版本</div><div class="mono">${esc(d.fmea.header.rev)}</div>
              <div class="k">状态</div><div>${statusBadge(d.fmea.header.status)}</div>
              <div class="k">批准人</div><div>${esc(d.fmea.header.approved_by || '—')}</div>
              <div class="k">失效行</div><div>${d.fmea.rows.length}</div></div>
            <div style="max-height:430px;overflow:auto"><table class="t"><thead><tr><th>FE</th><th>FM</th><th>FC</th><th class="num">S</th><th class="num">O</th><th class="num">D</th><th>AP</th><th>决定</th></tr></thead><tbody>
              ${d.fmea.rows.map(row => `<tr><td>${esc(row.fe_name || '—')}</td><td>${esc(row.fm_name || '—')}</td><td>${esc(row.fc_name || '—')}</td>
                <td class="num">${row.s ?? '—'}</td><td class="num">${row.o ?? '—'}</td><td class="num">${row.d ?? '—'}</td>
                <td>${apBadge(row.ap)}</td><td>${esc(row.decision || row.decision_status || '—')}</td></tr>`).join('') || '<tr><td colspan="8" class="dim">尚无失效分析行</td></tr>'}
            </tbody></table></div>
          </div>
        </section>` : ''}

        ${d.projectDocs?.length ? `<section class="card">
          <div class="card-h"><h3>引用的项目阶段文件</h3><span class="hint">PPAP 阶段直接渲染引用内容，审批仍在源文件完成</span></div>
          <div class="ppap-doc-renders">${d.projectDocs.map(ppapDocPreviewHtml).join('')}</div>
        </section>` : ''}

        ${d.pfd ? `<section class="card"><div class="card-h"><h3>过程流程图 PFD</h3><button class="btn sm ghost" data-open-module="pfd">打开 PFD</button></div>
          <div class="card-b">
            <div class="grid g4" style="margin-bottom:14px">
              <div class="kpi"><div class="k">工序数</div><div class="v">${d.pfd.steps.length}</div><div class="d">按工艺顺序排列</div></div>
              <div class="kpi"><div class="k">发布状态</div><div class="v" style="font-size:16px">${d.pfd.all_published ? '全部已发布' : '待发布'}</div><div class="d">${statusBadge(d.pfd.all_published ? '已发布' : '草稿')}</div></div>
              <div class="kpi warn"><div class="k">特殊过程</div><div class="v">${d.pfd.special_process_count}</div><div class="d">PFD 工序类型为“特殊过程”</div></div>
              <div class="kpi warn"><div class="k">特殊特性关联工序</div><div class="v">${d.pfd.special_char_step_count}</div><div class="d">关联 CC / SC / 安全特性</div></div>
            </div>
            <div class="ppap-flow-scroll"><div class="ppap-process-flow">
              ${d.pfd.steps.map((step, index) => `<div class="ppap-flow-item">
                <div class="ppap-flow-box ${step.special_process ? 'special-process' : ''} ${step.special_characteristics.length ? 'special-char' : ''}">
                  <div class="flow-no">${esc(step.step_no)}</div>
                  <b>${esc(step.name)}</b>
                  <small>${esc(step.equipment || step.step_type || '—')}</small>
                  <div class="flow-flags">
                    ${step.special_process ? '<span class="badge b-warn">特殊过程</span>' : ''}
                    ${step.special_characteristics.filter(c => c.char_kind === 'PRODUCT').length ? '<span class="badge b-cc">产品特殊特性</span>' : ''}
                    ${step.special_characteristics.filter(c => c.char_kind === 'PROCESS').length ? '<span class="badge b-sc">过程特殊特性</span>' : ''}
                  </div>
                  ${step.special_characteristics.length ? `<div class="flow-chars">${step.special_characteristics.map(c => `${specBadge(1, c.special_symbol)} ${esc(c.name)}`).join('<br>')}</div>` : ''}
                </div>
                ${index < d.pfd.steps.length - 1 ? '<div class="ppap-flow-arrow">→</div>' : ''}
              </div>`).join('')}
            </div></div>
            <div class="ppap-flow-legend">
              <span><i class="legend-dot normal"></i>普通工序</span>
              <span><i class="legend-dot process"></i>PFD 特殊过程</span>
              <span><i class="legend-dot char"></i>关联特殊特性</span>
            </div>
            <div style="max-height:360px;overflow:auto;margin-top:12px"><table class="t"><thead><tr><th>工序号</th><th>工序</th><th>类型</th><th>设备</th><th>特殊标记</th><th>状态</th></tr></thead><tbody>
              ${d.pfd.steps.map(step => `<tr><td class="mono">${esc(step.step_no)}</td><td>${esc(step.name)}</td><td>${esc(step.step_type)}</td><td>${esc(step.equipment || '—')}</td>
                <td>${step.special_process ? '<span class="badge b-warn">特殊过程</span>' : ''}
                  ${step.special_characteristics.map(c => `<span title="${esc(c.char_id)}">${specBadge(1, c.special_symbol)} ${esc(c.name)}</span>`).join(' ')}
                  ${!step.critical ? '<span class="dim">—</span>' : ''}</td>
                <td>${statusBadge(step.status)}</td></tr>`).join('')}
            </tbody></table></div>
          </div></section>` : ''}

        ${d.cp ? `<section class="card"><div class="card-h"><h3>控制计划</h3><button class="btn sm ghost" data-open-module="cp">打开控制计划</button></div>
          <div class="card-b"><div class="kv" style="margin-bottom:10px"><div class="k">阶段</div><div>${esc(d.cp.header.stage)}</div><div class="k">版本</div><div>${esc(d.cp.header.rev)}</div><div class="k">状态</div><div>${statusBadge(d.cp.header.status)}</div><div class="k">行数</div><div>${d.cp.rows.length}</div></div>
          <div style="max-height:380px;overflow:auto"><table class="t"><thead><tr><th>#</th><th>特性</th><th>规范</th><th>测量设备</th><th>SPC</th></tr></thead><tbody>
            ${d.cp.rows.map(row => `<tr><td class="mono">${row.seq}</td><td>${esc(row.char_name || row.char_id || '—')}</td><td>${esc(row.spec_text || '—')}</td><td>${esc(row.gauge_name || row.gauge_id || '—')}</td><td>${row.is_spc ? '<span class="badge b-ok">纳入</span>' : '<span class="dim">否</span>'}</td></tr>`).join('')}
          </tbody></table></div></div></section>` : ''}

        ${d.msa ? `<section class="card"><div class="card-h"><h3>MSA 计划与研究</h3><button class="btn sm ghost" data-open-module="msa">打开 MSA</button></div>
          <table class="t"><thead><tr><th>特性</th><th>测量设备</th><th>设计</th><th>状态</th><th>%GRR</th><th>判定</th></tr></thead><tbody>
            ${d.msa.plans.map(plan => `<tr><td>${esc(plan.char_name || plan.char_id)}</td><td>${esc(plan.gauge_id)}</td><td>${plan.parts}×${plan.operators}×${plan.trials}</td><td>${statusBadge(plan.status)}</td><td class="num">${fmt(plan.study_result)}</td><td>${plan.study_judgment ? statusBadge(plan.study_judgment) : '—'}</td></tr>`).join('') || '<tr><td colspan="6" class="dim">暂无 MSA 计划</td></tr>'}
          </tbody></table></section>` : ''}

        ${d.spc ? `<section class="card"><div class="card-h"><h3>初始过程能力</h3><button class="btn sm ghost" data-open-module="spc">打开 SPC</button></div>
          <table class="t"><thead><tr><th>特性</th><th>控制图</th><th class="num">Cpk</th><th class="num">Ppk</th><th>数据批次</th></tr></thead><tbody>
            ${d.spc.map(item => `<tr><td>${esc(item.char_name || item.mon_id)}</td><td>${esc(item.chart_type)}</td><td class="num">${fmt(item.stat?.cpk)}</td><td class="num">${fmt(item.stat?.ppk)}</td><td>${esc(item.dataset?.batch_no || '无数据')}</td></tr>`).join('') || '<tr><td colspan="5" class="dim">暂无已批准 SPC 监控项</td></tr>'}
          </tbody></table></section>` : ''}
      </div>

      <aside class="stack">
        <section class="card">
          <div class="card-h"><h3>系统取证结果</h3><span class="hint">${artifacts.length} 项</span></div>
          <div class="evidence-artifacts">
            ${artifacts.length ? artifacts.map(item => `<div class="evidence-artifact">
              <div><b>${esc(item.title)}</b><small>${esc(item.type)} ${item.version ? '· ' + esc(item.version) : ''}</small></div>
              <span>${statusBadge(item.status)}</span>
            </div>`).join('') : '<div class="empty">当前要素尚无自动取证对象</div>'}
          </div>
        </section>
        <section class="card">
          <div class="card-h"><h3>${mapping.sourceType === 'manual' ? '人工证据模板' : '补充人工证据'}</h3><button class="btn sm" id="ppapTemplateNew">上传 / 新建</button></div>
          <div class="card-b">
            ${templates.length ? templates.map(tpl => `<div class="evidence-template-row">
              <div><b>${esc(tpl.name)}</b><small>${esc(tpl.source.toUpperCase())} · ${esc(tpl.status)} · ${esc(tpl.updated_at || tpl.created_at)}</small></div>
              <button class="btn sm ghost" data-open-template="${esc(tpl.tpl_id)}">打开</button>
            </div>`).join('') : '<div class="empty" style="padding:16px">尚未建立该项的人工证据模板。可上传 PSW、AAR、CSR 清单等文件。</div>'}
          </div>
        </section>
        <section class="card">
          <div class="card-h"><h3>证据确认</h3><span class="hint">证据编号 / 文件 / 日期</span></div>
          <div class="card-b">
            <div class="row2">
              <div class="field"><label>适用性</label><select id="ppapApplicability">
                ${['适用', '不适用'].map(value => `<option ${value === (element.applicability || '适用') ? 'selected' : ''}>${value}</option>`).join('')}
              </select></div>
              <div class="field"><label>顾客豁免 / 不适用依据</label><input id="ppapWaiver" value="${esc(element.waiver_ref || '')}" placeholder="不适用时必须填写书面依据"></div>
            </div>
            <button class="btn ghost wide" id="ppapApplicabilitySave" style="margin-bottom:12px">保存适用性</button>
            <div class="field"><label>证据引用</label><textarea id="ppapEvidenceRef" rows="4" placeholder="例如：DFMEA r3 / 2026-10-30；全尺寸报告 CMM-2026-101">${esc(element.evidence || '')}</textarea></div>
            <div class="field"><label>备注 / 不适用理由</label><textarea id="ppapEvidenceNote" rows="3">${esc(element.note || '')}</textarea></div>
            <button class="btn wide" id="ppapEvidenceSave2">${element.status === '已完成' ? '更新证据' : '保存证据（待确认）'}</button>
          </div>
        </section>
      </aside>
    </div>`;

  $('#ppapEvidenceBack').onclick = () => go('ppap');
  const openTemplateUpload = () => openUpload({
    name: `${mapping.sourceLabel || element.name}证据`,
    phase: 4,
    docCode: d.templateCode,
    ppapNo: no,
  });
  $('#ppapEvidenceUpload').onclick = openTemplateUpload;
  if ($('#ppapTemplateNew')) $('#ppapTemplateNew').onclick = openTemplateUpload;
  $$('[data-open-doc]').forEach(button => button.onclick = () => openDoc(button.dataset.openDoc));
  $$('[data-open-stage-template]').forEach(button =>
    button.onclick = () => openTpl(button.dataset.openStageTemplate, no));
  $$('[data-open-template]').forEach(button => button.onclick = () => openTpl(button.dataset.openTemplate, no));
  $$('[data-open-module]').forEach(button => button.onclick = () => {
    const module = button.dataset.openModule;
    if (module === 'fmea') state.fmeaType = button.dataset.moduleArg || 'PFMEA';
    if (module === 'pfd') return goPfd('PROCESS');
    go(module);
  });
  // B-09：证据先保存为“待确认”，完成必须由质量角色另行确认
  const saveEvidence = async (status = '待确认') => {
    const evidence = $('#ppapEvidenceRef').value.trim();
    const note = $('#ppapEvidenceNote').value.trim();
    if (!evidence) return toast('请填写证据引用', 'err');
    try {
      await api('/ppap/' + no, { method: 'PATCH', body: { status, evidence, note } });
      toast(status === '已完成' ? 'PPAP 要素已确认完成' : '证据已保存为待确认，等待质量角色确认', 'ok');
      vPpapEvidence(no);
    } catch (e) { toast(e.message, 'err'); }
  };
  const nextEvidenceStatus = element.status === '已完成' ? '已完成' : '待确认';
  $('#ppapEvidenceSave').onclick = () => saveEvidence(nextEvidenceStatus);
  $('#ppapEvidenceSave2').onclick = () => saveEvidence(nextEvidenceStatus);
  if ($('#ppapEvidenceConfirm')) $('#ppapEvidenceConfirm').onclick = () => saveEvidence('已完成');
  if ($('#ppapApplicabilitySave')) $('#ppapApplicabilitySave').onclick = async () => {
    try {
      await api('/ppap/' + no, {
        method: 'PATCH',
        body: { applicability: $('#ppapApplicability').value, waiver_ref: $('#ppapWaiver').value.trim() },
      });
      toast('适用性已保存', 'ok');
      vPpapEvidence(no);
    } catch (e) { toast(e.message, 'err'); }
  };
}

async function vPpap() {
  await vPpapContent();
  await mountQualityToolLinks('ppap');
}

async function vPpapContent() {
  const d = await api('/ppap');
  const done = d.elements.filter(e => e.status === '已完成').length;
  const pct = d.elements.length ? Math.round((done / d.elements.length) * 100) : 0;
  const workflowByNo = new Map((d.workflow || []).map(item => [item.no, item]));
  const submission = d.submission || {};
  // B-10：按当前提交等级显示“必需/可选/不适用”，不再只展示固定 18 项
  const level = +submission.level || 3;
  const levelRequired = new Set((d.level_requirements || {})[String(level)] || []);
  const applicableElements = d.elements.filter(e => (e.applicability || '适用') !== '不适用');
  const levelTotal = applicableElements.filter(e => levelRequired.has(e.element_no)).length;
  const levelDone = applicableElements.filter(e =>
    levelRequired.has(e.element_no) && e.status === '已完成').length;
  state.ppapSubmissionId = submission.project_id || state.project;
  $('#viewSub').textContent = 'PPAP 18 项与 APQP 阶段及上游交付物联动初稿：系统提示证据来源，最终适用性和提交等级仍由质量人员确认';
  $('#view').innerHTML = `
    <div class="qt-toolbar" style="margin-bottom:12px">
      <div class="qt-toolbar-main"><span class="lbl">当前 PPAP 提交</span><b>Level ${submission.level || 3} · ${esc(submission.status || '准备中')}</b>
        <small>${esc(submission.customer || state.meta?.project?.customer || '')} · ${esc(submission.submission_reason || '提交原因待维护')} · ${done}/${d.elements.length} 项完成</small>
        <small><b>本等级需 ${levelTotal} 项，已齐 ${levelDone} 项</b> · 不适用 ${d.elements.filter(e => e.applicability === '不适用').length} 项</small></div>
      <div class="qt-toolbar-meta"><span class="qt-chip">${esc(submission.requested_by || '申请人待维护')}</span>
        <span class="qt-chip">${esc(submission.approved_by || '批准人待维护')}</span></div>
      <div class="qt-actions">
        <button class="btn sm ghost" id="ppapSubmissionEdit">维护提交信息</button>
        <button class="btn sm ghost" data-quality-export="ppap" data-export-fmt="docx">导出 Word</button>
        <button class="btn sm ghost" data-quality-export="ppap" data-export-fmt="xlsx">导出 Excel</button>
        <button class="btn" id="btnPkg">冻结基线并打包</button>
      </div>
    </div>
    <div class="grid g4" style="margin-bottom:14px">
      <div class="kpi ${pct === 100 ? 'ok' : 'warn'}"><div class="k">要素完成度</div><div class="v">${done}<small>/${d.elements.length}</small></div>${bar(pct, pct === 100 ? 'ok' : 'warn')}</div>
      <div class="kpi"><div class="k">提交等级</div><div class="v">L${submission.level || 3}</div><div class="d">${esc(submission.status || '准备中')}</div></div>
      <div class="kpi"><div class="k">可用基线</div><div class="v">${d.baselines.length}</div><div class="d">${esc(d.baselines[0]?.tag || '—')}</div></div>
      <div class="kpi"><div class="k">已生成包</div><div class="v">${d.packages.length}</div><div class="d">含清单哈希</div></div>
    </div>
    <div class="card" style="margin-bottom:14px">
      <div class="card-h"><h3>18 项要素清单</h3>
        <span class="hint">完成后必须填写证据引用</span></div>
      <div class="alert info" style="margin:12px 14px 0"><div><b>关联草案</b><br>“关联状态”来自 APQP、FMEA、PFD、CP、MSA、SPC 和检具台账，仅作为取证提示；标记 PPAP 要素完成时仍需人工确认适用性并填写证据。</div></div>
      <div class="tabs" style="margin:10px 14px 0">
        <div class="tab on" data-ppap-filter="all">全部 ${d.elements.length}</div>
        <div class="tab" data-ppap-filter="open">未完成 ${d.elements.filter(e => e.status !== '已完成').length}</div>
        <div class="tab" data-ppap-filter="review">待复核 ${d.elements.filter(e => e.status === '待复核').length}</div>
        <div class="tab" data-ppap-filter="na">不适用 ${d.elements.filter(e => (e.applicability || '适用') === '不适用').length}</div>
      </div>
      <div style="overflow:auto"><table class="t"><thead><tr><th style="width:40px">#</th><th style="min-width:160px">PPAP 要素</th><th style="width:78px">阶段</th><th style="min-width:180px">APQP / 上游对象</th><th>关联状态</th><th>PPAP状态</th><th>证据</th><th style="width:130px">操作</th></tr></thead><tbody>
        ${d.elements.map(e => {
          const wf = workflowByNo.get(e.element_no) || {};
          const inLevel = levelRequired.has(e.element_no);
          const notApplicable = (e.applicability || '适用') === '不适用';
          const levelBadge = notApplicable
            ? `<span class="badge b-gray" title="${esc(e.waiver_ref || '')}">不适用</span>`
            : inLevel ? '<span class="badge b-warn">本等级必需</span>' : '<span class="badge b-gray">本等级可选</span>';
          return `<tr data-ppap-row data-state="${e.status === '已完成' ? 'done' : e.status === '待复核' || e.status === '待确认' ? 'review' : notApplicable ? 'na' : 'open'}"><td class="mono">${e.element_no}</td><td><b>${esc(e.name)}</b> ${levelBadge}<div class="dim">${esc(wf.rule || '')}</div></td>
          <td><span class="chip">${esc(wf.phase || '—')}</span></td>
          <td>${esc(wf.sourceLabel || '—')}<div class="dim">${esc(wf.link_detail || '')} · ${esc(wf.owner || '')}</div></td>
          <td><span class="badge ${wf.linked_ready ? 'b-ok' : wf.linked_status === '进行中' ? 'b-warn' : 'b-gray'}">${esc(wf.linked_status || '待关联')}</span></td>
          <td>${statusBadge(e.status)}${e.confirmed_by ? `<div class="dim">${esc(e.confirmed_by)}</div>` : ''}</td><td class="dim">${esc(e.evidence || '—')}</td>
          <td><button class="btn sm ghost" data-open-ppap-evidence="${e.element_no}">证据工作台</button></td></tr>`;
        }).join('')}
      </tbody></table></div>
    </div>
    <div class="card">
      <div class="card-h"><h3>已生成的 PPAP 包</h3><span class="hint">清单哈希用于事后校验</span></div>
      <table class="t"><thead><tr><th>#</th><th>等级</th><th>基线</th><th>生成时间</th><th>文件数</th><th>清单哈希</th><th>ZIP</th></tr></thead><tbody>
        ${d.packages.length ? d.packages.map(p => `<tr><td>${p.pkg_id}</td><td>L${p.level}</td>
          <td class="mono">${esc(p.baseline_id || '—')}</td><td class="mono">${esc(p.created_at)}</td>
          <td>${p.file_count || JSON.parse(p.manifest).files.length}</td><td class="mono">${esc(String(p.pkg_hash || '').slice(0, 24))}…</td>
          <td>${p.zip_path ? `<a class="btn sm ghost" href="/api/ppap/packages/${p.pkg_id}/download?p=${encodeURIComponent(state.project)}">下载 ZIP</a>` : '<span class="dim">—</span>'}</td></tr>`).join('')
          : '<tr><td colspan="7" class="dim">尚未打包</td></tr>'}
      </tbody></table>
    </div>`;

  $$('[data-open-ppap-evidence]').forEach(button =>
    button.onclick = () => openPpapEvidence(button.dataset.openPpapEvidence));
  $$('[data-ppap-filter]').forEach(tab => tab.onclick = () => {
    $$('[data-ppap-filter]').forEach(item => item.classList.toggle('on', item === tab));
    const filter = tab.dataset.ppapFilter;
    $$('[data-ppap-row]').forEach(row => {
      const stateName = row.dataset.state;
      row.hidden = filter !== 'all' && !(filter === 'open' ? ['open', 'review'].includes(stateName) : stateName === filter);
    });
  });
  $('#ppapSubmissionEdit').onclick = () => {
    const drawer = $('#drawer');
    $('.drawer-box', drawer).innerHTML = `
      <div class="drawer-h"><div><h2>维护 PPAP 提交信息</h2><p>${esc(state.meta?.project?.name || '')} · 提交等级与 PSW 摘要</p></div>
        <button class="x" onclick="document.getElementById('drawer').classList.remove('open')" title="关闭">✕</button></div>
      <div class="drawer-b">
        <div class="row2">
          <div class="field"><label>提交等级</label><select id="ppsLevel">${[1,2,3,4,5].map(level => `<option value="${level}" ${+submission.level === level ? 'selected' : ''}>Level ${level}</option>`).join('')}</select></div>
          <div class="field"><label>提交状态</label><select id="ppsStatus">${['准备中','待批准','已批准','已提交','顾客已批准','需修订'].map(status => `<option ${submission.status === status ? 'selected' : ''}>${status}</option>`).join('')}</select></div>
        </div>
        <div class="field"><label>提交原因</label><input id="ppsReason" value="${esc(submission.submission_reason || '')}" placeholder="例如：新零件首次提交"></div>
        <div class="row2">
          <div class="field"><label>顾客</label><input id="ppsCustomer" value="${esc(submission.customer || state.meta?.project?.customer || '')}"></div>
          <div class="field"><label>组织</label><input id="ppsOrganization" value="${esc(submission.organization || '')}"></div>
        </div>
        <div class="row2">
          <div class="field"><label>零件版本</label><input id="ppsPartRevision" value="${esc(submission.part_revision || '')}"></div>
          <div class="field"><label>申请人 / 日期</label><input id="ppsRequestedBy" value="${esc(submission.requested_by || '')}" placeholder="申请人；日期：${esc(submission.requested_at || '')}"></div>
        </div>
        <div class="row2">
          <div class="field"><label>批准人</label><input id="ppsApprovedBy" value="${esc(submission.approved_by || '')}"></div>
          <div class="field"><label>批准日期</label><input id="ppsApprovedAt" type="date" value="${esc(submission.approved_at || '')}"></div>
        </div>
        <button class="btn wide" id="ppsSave">保存提交信息</button>
      </div>`;
    drawer.classList.add('open');
    $('#ppsSave').onclick = async () => {
      try {
        await api('/ppap/submission', { method: 'PATCH', body: {
          level: +$('#ppsLevel').value,
          status: $('#ppsStatus').value,
          submission_reason: $('#ppsReason').value.trim(),
          customer: $('#ppsCustomer').value.trim(),
          organization: $('#ppsOrganization').value.trim(),
          part_revision: $('#ppsPartRevision').value.trim(),
          requested_by: $('#ppsRequestedBy').value.trim(),
          requested_at: submission.requested_at || '',
          approved_by: $('#ppsApprovedBy').value.trim(),
          approved_at: $('#ppsApprovedAt').value,
        } });
        drawer.classList.remove('open');
        toast('PPAP 提交信息已保存', 'ok');
        vPpap();
      } catch (error) { toast(error.message, 'err'); }
    };
  };
  $('#btnPkg').onclick = async () => {
    try {
      // B-07：打包前选择“已有基线”或让服务端按语义冻结一份新基线，不再前端生成随机版本号
      const options = [
        { value: '', label: submission.baseline_id ? `沿用当前绑定基线 ${submission.baseline_id}` : '冻结新的 PPAP 提交基线（服务端生成版本号）' },
        ...d.baselines.map(baseline => ({
          value: baseline.baseline_id,
          label: `${baseline.tag} · ${baseline.version} · ${baseline.frozen_at}`,
        })),
      ];
      const result = await showFormDialog({
        title: '打包 PPAP',
        description: '包内清单与证据都取自所选基线；选择“新基线”时由服务端冻结并绑定到当前提交记录。',
        fields: [
          { key: 'baseline_id', label: '提交基线', type: 'select', value: submission.baseline_id || '', options },
          { key: 'note', label: '打包说明', placeholder: '可选' },
        ],
        confirmText: '开始打包',
      });
      if (!result) return;
      if (result.baseline_id) {
        await api('/ppap/submission', { method: 'PATCH', body: { baseline_id: result.baseline_id } });
      }
      const r = await api('/ppap/package', { method: 'POST', body: { level: +submission.level || 3 } });
      toast(`打包 ${r.files} 个文件，基线 ${r.baseline || submission.baseline_id || '自动冻结'}，ZIP 哈希 ${r.zip_hash.slice(0, 12)}…`, 'ok');
      vPpap();
    } catch (e) { toast(e.message, 'err'); }
  };
}

/* ------------------------------------------------------------------ 基线 */
async function vBaseline() {
  const d = await api('/baselines');
  const l = d.list;
  $('#viewSub').textContent = '基线 = 不可变快照 + 对象哈希。两个基线之间可做对象级 / 字段级差异对比';
  $('#view').innerHTML = `
    <div class="card" style="margin-bottom:14px">
      <div class="card-h"><h3>基线列表</h3><button class="btn" id="btnFreeze">冻结新基线</button></div>
      <table class="t"><thead><tr><th>标签</th><th>版本</th><th>对象数</th><th>对象类型</th><th>冻结时间</th><th>操作人</th><th>基线哈希</th><th>操作</th></tr></thead><tbody>
        ${l.map((b, index) => `<tr><td><b>${esc(b.tag)}</b></td><td class="mono">${esc(b.version)}</td><td>${b.items}</td>
          <td>${b.object_types || '—'}</td><td class="mono">${esc(b.frozen_at)}</td><td>${esc(b.frozen_by)}</td><td class="mono">${esc(b.hash.slice(0, 20))}…</td>
          <td class="nowrap"><button class="btn sm ghost" data-baseline-detail="${b.baseline_id}">查看</button>
            ${l[index + 1] ? `<button class="btn sm ghost" data-baseline-prev="${index}">与上一版对比</button>` : ''}</td></tr>`).join('')}
      </tbody></table>
    </div>
    <div class="card">
      <div class="card-h"><h3>差异对比</h3><span class="hint">红 = 删除 / 收紧，黄 = 修改，蓝 = 新增</span></div>
      <div class="card-b">
        <div class="row3" style="margin-bottom:12px">
          <div class="field"><label>基线 A</label><select id="dA">${l.map(b => `<option value="${b.baseline_id}">${esc(b.tag)} · ${esc(b.version)}</option>`).join('')}</select></div>
          <div class="field"><label>基线 B</label><select id="dB">${l.map((b, i) => `<option value="${b.baseline_id}" ${i === 0 ? 'selected' : ''}>${esc(b.tag)} · ${esc(b.version)}</option>`).join('')}</select></div>
          <div class="field" style="display:flex;align-items:flex-end"><button class="btn wide" id="btnDiff">对比</button></div>
        </div>
        <div id="diffOut"><div class="empty">选择两个基线后点击「对比」</div></div>
      </div>
    </div>`;

  $('#btnFreeze').onclick = async () => {
    const result = await showFormDialog({
      title: '冻结新基线',
      description: l.length
        ? '已有基线，本次冻结属于变更批准动作，需质量及以上角色；批准人取当前登录账号。'
        : '基线为不可变快照，用于版本对比和 PPAP 取证。',
      fields: [{ key: 'tag', label: '基线标签', value: '年度复审基线', required: true }],
      confirmText: '确认冻结',
    });
    if (!result) return;
    try {
      const r = await api('/baselines', { method: 'POST', body: {
        tag: result.tag.trim(), version: 'V1.' + (Date.now() % 90 + 10), note: '手动冻结',
      } });
      toast(`已冻结 ${r.id}，共 ${r.count} 个对象，哈希 ${r.hash.slice(0, 12)}…`, 'ok');
      vBaseline();
    } catch (e) { toast(e.message, 'err'); }
  };

  // B-06：一键对比“当前版 vs 上一版”
  $$('[data-baseline-prev]').forEach(button => button.onclick = () => {
    const index = +button.dataset.baselinePrev;
    const current = l[index];
    const previous = l[index + 1];
    if (!current || !previous) return;
    $('#dA').value = previous.baseline_id;
    $('#dB').value = current.baseline_id;
    $('#btnDiff').click();
  });

  $$('[data-baseline-detail]').forEach(button => button.onclick = async () => {
    const detail = await api('/baselines/' + encodeURIComponent(button.dataset.baselineDetail));
    const drawer = $('#drawer');
    $('.drawer-box', drawer).innerHTML = `
      <div class="drawer-h"><div><h2>${esc(detail.baseline.tag)} · ${esc(detail.baseline.version)}</h2><p>${esc(detail.baseline.baseline_id)} · ${detail.items.length} 个对象</p></div>
        <button class="x" onclick="document.getElementById('drawer').classList.remove('open')">✕</button></div>
      <div class="drawer-b"><table class="t"><thead><tr><th>对象类型</th><th>对象 ID</th><th>对象哈希</th></tr></thead><tbody>
        ${detail.items.map(item => `<tr><td>${esc(item.object_type)}</td><td class="mono">${esc(item.object_id)}</td><td class="mono">${esc(item.object_hash.slice(0, 20))}…</td></tr>`).join('')}
      </tbody></table></div>`;
    drawer.classList.add('open');
  });

  $('#btnDiff').onclick = async () => {
    const a = $('#dA').value, b = $('#dB').value;
    if (a === b) return toast('请选择两个不同的基线', 'err');
    const r = await api(`/baselines/diff?a=${a}&b=${b}`);
    if (!r.diff.length) { $('#diffOut').innerHTML = '<div class="alert info">两个基线完全一致（无对象级差异）</div>'; return; }
    $('#diffOut').innerHTML = `
      <div class="alert info" style="margin-bottom:10px">${r.a.tag} → ${r.b.tag}：${r.diff.length} 处差异（新增 ${r.diff.filter(x => x.type === 'ADD').length}、删除 ${r.diff.filter(x => x.type === 'DELETE').length}、修改 ${r.diff.filter(x => x.type === 'MODIFY').length}）</div>
      <table class="t"><thead><tr><th>对象</th><th>类型</th><th>字段级差异</th></tr></thead><tbody>
      ${r.diff.map(x => `<tr><td class="mono">${esc(x.object_type)} / ${esc(x.object_id)}</td>
        <td><span class="badge ${x.type === 'ADD' ? 'b-sc' : x.type === 'DELETE' ? 'b-bad' : 'b-warn'}">${x.type === 'ADD' ? '新增' : x.type === 'DELETE' ? '删除' : '修改'}</span></td>
        <td>${x.fields ? x.fields.map(f => `<span class="mod">${esc(f.field)}</span>：
          <span class="del">${esc(JSON.stringify(f.from))}</span> → <span class="add">${esc(JSON.stringify(f.to))}</span>
          ${f.dir === 'TIGHT' ? '<span class="badge b-bad">收紧</span>' : f.dir === 'LOOSE' ? '<span class="badge b-sc">放宽</span>' : ''}`).join('<br>') : '<span class="dim">—</span>'}</td></tr>`).join('')}
      </tbody></table>`;
  };
}

async function vExports() {
  const d = await api('/exports');
  $('#viewSub').textContent = '记录每次交付物、客户模板、PPAP ZIP 的导出人、时间、格式、基线和文件哈希';
  $('#view').innerHTML = `
    <div class="card"><div class="card-h"><h3>导出审计</h3><span class="hint">最近 ${d.list.length} 条</span></div>
      <table class="t"><thead><tr><th>时间</th><th>对象</th><th>格式</th><th>文件</th><th>基线</th><th>哈希</th><th>导出人</th></tr></thead><tbody>
        ${d.list.map(item => `<tr><td class="mono">${esc(item.exported_at)}</td>
          <td>${esc(item.object_type)}<div class="mono dim">${esc(item.object_id)}</div></td>
          <td><span class="tag">${esc(item.format)}</span></td><td>${esc(item.file_name)}</td>
          <td class="mono">${esc(item.baseline_id || '—')}</td><td class="mono">${esc(String(item.file_hash || '').slice(0, 24))}…</td>
          <td>${esc(item.exported_by || '—')}</td></tr>`).join('') || '<tr><td colspan="7" class="dim">暂无导出记录</td></tr>'}
      </tbody></table>
    </div>`;
}

/* ------------------------------------------------------------ 账号与权限 */
/** 角色默认权限点：只用于把勾选清单预填成角色当前值 */
function roleDefaultPerms(roles, role) {
  const def = (roles || []).find(item => item.role === role);
  return (def && def.permissions) || [];
}

/** 账号编辑抽屉：新增 / 编辑共用，口径与权限清单一致 */
function openUserDrawer(user, roles, onSaved, catalog = {}) {
  const drawer = $('#drawer');
  const isNew = !user;
  const catalogGroups = catalog.groups || [];
  const catalogPermissions = catalog.permissions || {};
  const roleOptions = roles.map(item =>
    `<option value="${esc(item.role)}" ${user && user.role === item.role ? 'selected' : ''}>${esc(item.name)}${item.legacy ? '（兼容角色）' : ''} · ${esc(item.department)}</option>`).join('');
  $('.drawer-box', drawer).innerHTML = `
    <div class="drawer-h"><div><h2>${isNew ? '新增账号' : `编辑账号 · ${esc(user.username)}`}</h2>
      <p>角色决定模块权限；部门与岗位用于显示与交付物归属核对。</p></div>
      <button class="x" onclick="document.getElementById('drawer').classList.remove('open')">✕</button></div>
    <div class="drawer-b">
      <div class="row2">
        <div class="field"><label>登录名</label>
          <input id="ufUsername" value="${esc(user ? user.username : '')}" ${isNew ? '' : 'readonly'}
            placeholder="字母开头，如 quality03"></div>
        <div class="field"><label>姓名 / 岗位名称</label>
          <input id="ufName" value="${esc(user ? user.display_name : '')}" placeholder="如：质量工程师 03"></div>
      </div>
      <div class="field"><label>角色</label><select id="ufRole">${roleOptions}</select></div>
      <div class="row2">
        <div class="field"><label>部门</label>
          <input id="ufDept" value="${esc(user ? user.department : '')}" placeholder="如：质量管理部"></div>
        <div class="field"><label>岗位</label>
          <input id="ufPosition" value="${esc(user ? user.position : '')}" placeholder="如：质量工程师"></div>
      </div>
      <div class="row2">
        <div class="field"><label>账号标记（可选）</label>
          <input id="ufFlags" value="${esc(user ? user.flags : '')}" placeholder="facility = 环境与设施编制权"></div>
        ${isNew ? `<div class="field"><label>初始口令（留空用统一初始口令）</label>
          <input id="ufPassword" placeholder="至少 6 位，留空即用 123456"></div>` : `<div class="field"><label>状态</label>
          <select id="ufStatus">
            <option ${user.status === '启用' ? 'selected' : ''}>启用</option>
            <option ${user.status === '停用' ? 'selected' : ''}>停用</option></select></div>`}
      </div>
      <div class="alert info" id="ufRoleHint"></div>

      <div class="perm-box">
        <div class="perm-box-head">
          <div><b>可执行权限</b>
            <div class="dim" id="ufPermMode">按角色默认</div></div>
          <div class="perm-box-actions">
            <label class="perm-mode"><input type="checkbox" id="ufCustomPerms"> 自定义</label>
            <button class="btn sm ghost" id="ufPermAll">全选</button>
            <button class="btn sm ghost" id="ufPermNone">清空</button>
            <button class="btn sm ghost" id="ufPermReset">恢复角色默认</button>
          </div>
        </div>
        <div class="perm-groups" id="ufPermGroups">
          ${(catalogGroups || []).map(group => `
            <div class="perm-group" data-group="${esc(group.name)}">
              <div class="perm-group-head">
                <label><input type="checkbox" data-perm-group="${esc(group.name)}"> ${esc(group.name)}</label>
                <span class="perm-group-count">0/${group.points.length}</span>
              </div>
              <div class="perm-group-items">
                ${group.points.map(point => `
                  <label class="perm-item">
                    <input type="checkbox" data-perm-point="${esc(point)}">
                    <span>${esc(catalogPermissions[point] || point)}</span>
                    <small class="mono" title="${esc(point)}">${esc(point)}</small>
                  </label>`).join('')}
              </div>
            </div>`).join('')}
        </div>
      </div>

      <div class="qt-actions" style="margin-top:12px">
        <button class="btn" id="ufSave">${isNew ? '创建账号' : '保存'}</button>
        <button class="btn ghost" onclick="document.getElementById('drawer').classList.remove('open')">取消</button>
      </div>
    </div>`;
  drawer.classList.add('open');

  const roleHint = () => {
    const def = roles.find(item => item.role === $('#ufRole').value) || {};
    $('#ufRoleHint').innerHTML = `默认部门「${esc(def.department || '—')}」；项目范围：${def.scope === 'all' ? '全部项目' : '仅参与项目'}；`
      + `权限点 ${def.permission_count || 0} 个${def.legacy ? '（兼容角色，保留原有可用范围）' : ''}。`;
    if (!$('#ufDept').value) $('#ufDept').value = def.department || '';
  };
  $('#ufRole').onchange = roleHint;
  roleHint();

  /* ---- 权限勾选 ---- */
  // 管理员恒为全权：勾选不参与判定；锁状态随角色下拉实时切换（新增账号时角色也可能是 admin）
  const isAdminAccount = () => $('#ufRole').value === 'admin';
  const permBoxes = () => $$('#ufPermGroups input[data-perm-point]');
  /** 角色默认权限 + 账号标记带来的权限（facility 标记 = 环境与设施编制权） */
  const defaultPerms = role => {
    const list = [...roleDefaultPerms(roles, role)];
    if (/\bfacility\b/.test(($('#ufFlags')?.value || '').trim())) list.push('facility.edit');
    return [...new Set(list)];
  };
  const syncGroupBoxes = () => {
    $$('#ufPermGroups .perm-group').forEach(card => {
      const boxes = $$('input[data-perm-point]', card);
      const checked = boxes.filter(box => box.checked).length;
      const groupBox = $('input[data-perm-group]', card);
      if (groupBox) {
        groupBox.checked = boxes.length > 0 && checked === boxes.length;
        groupBox.indeterminate = checked > 0 && checked < boxes.length;
      }
      card.classList.toggle('done', boxes.length > 0 && checked === boxes.length);
      const count = $('.perm-group-count', card);
      if (count) count.textContent = `${checked}/${boxes.length}`;
    });
    permBoxes().forEach(box => box.closest('.perm-item')?.classList.toggle('on', box.checked));
    const total = permBoxes().filter(box => box.checked).length;
    const mode = $('#ufPermMode');
    if (mode) {
      mode.textContent = isAdminAccount() ? '管理员账号始终拥有全部权限，勾选仅作参考'
        : $('#ufCustomPerms').checked ? `自定义：已勾选 ${total} 项，完全替代角色默认`
          : `按角色默认：${total} 项（改动任意一项即转为自定义）`;
    }
  };
  const applyPerms = perms => {
    const set = new Set(perms || []);
    permBoxes().forEach(box => { box.checked = set.has(box.dataset.permPoint); });
    syncGroupBoxes();
  };
  // 已有账号：有自定义权限就勾选并进入“自定义”，否则展示角色默认值
  const custom = Array.isArray(user?.perms) ? user.perms : null;
  $('#ufCustomPerms').checked = !!custom;
  applyPerms(custom || defaultPerms(user ? user.role : $('#ufRole').value));
  // 勾选始终可点；第一次手动改动就自动切到“自定义”，不必先去找那个开关
  const markCustom = () => { $('#ufCustomPerms').checked = true; };
  $('#ufCustomPerms').onchange = () => {
    if (!$('#ufCustomPerms').checked) applyPerms(defaultPerms($('#ufRole').value));
    syncGroupBoxes();
  };
  $('#ufRole').addEventListener('change', () => {
    if (!$('#ufCustomPerms').checked) applyPerms(defaultPerms($('#ufRole').value));
  });
  // facility 标记会额外带来「维护环境与设施」：标记改动后同步默认勾选
  $('#ufFlags')?.addEventListener('change', () => {
    if (!$('#ufCustomPerms').checked) applyPerms(defaultPerms($('#ufRole').value));
  });
  $('#ufPermAll').onclick = () => { markCustom(); permBoxes().forEach(box => { box.checked = true; }); syncGroupBoxes(); };
  $('#ufPermNone').onclick = () => { markCustom(); permBoxes().forEach(box => { box.checked = false; }); syncGroupBoxes(); };
  $('#ufPermReset').onclick = () => {
    $('#ufCustomPerms').checked = false;
    applyPerms(defaultPerms($('#ufRole').value));
  };
  permBoxes().forEach(box => box.onchange = () => { markCustom(); syncGroupBoxes(); });
  $$('#ufPermGroups input[data-perm-group]').forEach(groupBox => {
    groupBox.onchange = () => {
      markCustom();
      const group = catalogGroups.find(item => item.name === groupBox.dataset.permGroup);
      (group ? group.points : []).forEach(point => {
        const box = $(`#ufPermGroups input[data-perm-point="${point}"]`);
        if (box) box.checked = groupBox.checked;
      });
      syncGroupBoxes();
    };
  });
  // 管理员恒为全权：勾选不参与判定，禁用并说明，避免管理员误以为限制了超管
  const applyAdminLock = () => {
    const locked = isAdminAccount();
    permBoxes().forEach(box => { box.disabled = locked; });
    $$('#ufPermGroups input[data-perm-group]').forEach(box => { box.disabled = locked; });
    ['#ufPermAll', '#ufPermNone', '#ufPermReset', '#ufCustomPerms'].forEach(selector => {
      const el = $(selector);
      if (el) el.disabled = locked;
    });
    $('#ufPermGroups')?.classList.toggle('perm-locked', locked);
    if (locked) $('#ufCustomPerms').checked = false;
    syncGroupBoxes();
  };
  $('#ufRole').addEventListener('change', applyAdminLock);
  applyAdminLock();

  $('#ufSave').onclick = async () => {
    const body = {
      display_name: $('#ufName').value.trim(),
      role: $('#ufRole').value,
      department: $('#ufDept').value.trim(),
      position: $('#ufPosition').value.trim(),
      flags: $('#ufFlags').value.trim(),
      // 未勾“自定义”时传 null，表示按角色默认；管理员恒为全权，不写自定义清单
      perms: !isAdminAccount() && $('#ufCustomPerms').checked
        ? permBoxes().filter(box => box.checked).map(box => box.dataset.permPoint)
        : null,
    };
    try {
      if (isNew) {
        const username = $('#ufUsername').value.trim();
        const password = $('#ufPassword').value.trim();
        const result = await api('/admin/users', {
          method: 'POST', body: { ...body, username, password: password || undefined },
        });
        drawer.classList.remove('open');
        toast(`账号 ${result.username} 已创建；初始口令：${result.initial_password}，首次登录需改密`, 'ok');
      } else {
        await api('/admin/users/' + encodeURIComponent(user.user_id), {
          method: 'PATCH', body: { ...body, status: $('#ufStatus').value },
        });
        drawer.classList.remove('open');
        toast('账号已更新', 'ok');
      }
      if (onSaved) onSaved();
    } catch (error) { toast(error.message, 'err'); }
  };
}

async function vUsers() {
  if (!userCan('user.manage')) {
    $('#view').innerHTML = '<div class="alert bad">只有系统管理员可以管理账号与权限。</div>';
    return;
  }
  const [data, catalog] = await Promise.all([api('/admin/users'), api('/admin/roles')]);
  const roles = catalog.list || [];
  $('#viewSub').textContent = '按部门维护账号；可逐项勾选每个账号能执行的操作，不勾选则沿用角色默认。';
  const users = (data.list || []).slice();
  const departments = [...new Set(users.map(user => user.department || '未分配部门'))].sort();
  state.userFilter = state.userFilter || { q: '', dept: '' };

  const permSummary = user => {
    if (user.role === 'admin') return '<span class="badge b-ok">管理员全权</span>';
    if (Array.isArray(user.perms)) {
      return `<span class="badge b-ok">自定义 ${user.perms.length} 项</span>`;
    }
    const def = roles.find(item => item.role === user.role);
    return `<span class="dim">按角色 · ${def ? def.permission_count : 0} 项</span>`;
  };

  const renderRows = () => {
    const q = state.userFilter.q.trim().toLowerCase();
    const dept = state.userFilter.dept;
    const list = users.filter(user => (!dept || (user.department || '未分配部门') === dept)
      && (!q || `${user.username} ${user.display_name} ${user.position || ''} ${user.role_name}`.toLowerCase().includes(q)));
    const tbody = $('#userRows');
    if (!tbody) return;
    // 部门并入姓名单元格：单表 6 列才能在中等宽度下不横向滚动
    tbody.innerHTML = list.map(user => `<tr>
      <td class="mono nowrap">${esc(user.username)}</td>
      <td>${esc(user.display_name)}
        <div class="dim">${esc([user.department, user.position].filter(Boolean).join(' · ') || '—')}</div></td>
      <td class="nowrap">${esc(user.role_name)}${user.flags ? `<div class="dim">标记：${esc(user.flags)}</div>` : ''}</td>
      <td class="nowrap">${permSummary(user)}</td>
      <td class="nowrap">${user.status === '启用' ? '<span class="badge b-green">启用</span>' : '<span class="badge b-gray">停用</span>'}
        ${user.must_change_password ? '<div style="margin-top:3px"><span class="badge b-warn">待改密</span></div>' : ''}</td>
      <td class="nowrap">
        <button class="btn sm ghost" data-user-edit="${esc(user.user_id)}">编辑</button>
        <button class="btn sm ghost" data-user-reset="${esc(user.user_id)}">重置口令</button>
      </td></tr>`).join('') || '<tr><td colspan="6" class="dim">没有匹配的账号</td></tr>';
    bindRowActions();
  };
  const bindRowActions = () => {
    $$('[data-user-edit]').forEach(button => button.onclick = () => {
      const user = users.find(item => item.user_id === button.dataset.userEdit);
      if (user) openUserDrawer(user, roles, vUsers, catalog);
    });
    $$('[data-user-reset]').forEach(button => button.onclick = async () => {
      const user = users.find(item => item.user_id === button.dataset.userReset);
      if (!user) return;
      const ok = await showConfirmDialog('重置登录口令',
        `将把 ${user.username} 的口令重置为「${catalog.default_password || '123456'}」，`
        + '其所有会话立即失效，下次登录必须修改口令。',
        { confirmText: '确认重置' });
      if (!ok) return;
      try {
        const result = await api(`/admin/users/${encodeURIComponent(user.user_id)}/reset-password`, {
          method: 'POST', body: {},
        });
        toast(`口令已重置为 ${result.initial_password}`, 'ok');
        vUsers();
      } catch (error) { toast(error.message, 'err'); }
    });
  };

  $('#view').innerHTML = `
    <div class="pfd-commandbar">
      <div class="dim" style="font-size:12px;line-height:1.6">共 ${users.length} 个账号 · 编辑账号可逐项勾选权限，改动即时生效</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn ghost" id="btnRoleMatrix">角色权限说明</button>
        <button class="btn" id="btnNewUser">＋ 新增账号</button>
      </div>
    </div>
    <div class="alert info" style="margin-bottom:12px">
      所有账号都能查看全部页面；写操作按下列勾选授权，交付物还按目录归属校验编制岗位。
      管理层与内审员全局可见，其余账号只能访问所参与的项目。
    </div>
    <div class="card">
      <div class="card-h user-toolbar">
        <h3>全部账号 <span class="dim" style="font-weight:400">${users.length} 个</span></h3>
        <div class="user-toolbar-filters">
          <input id="userSearch" class="sel" placeholder="搜索登录名 / 姓名 / 岗位" value="${esc(state.userFilter.q)}">
          <select id="userDept" class="sel">
            <option value="">全部部门</option>
            ${departments.map(name => `<option ${state.userFilter.dept === name ? 'selected' : ''}>${esc(name)}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="user-table-wrap">
        <table class="t user-table"><thead><tr>
          <th>登录名</th><th>姓名 / 部门 · 岗位</th><th>角色</th><th>权限</th><th>状态</th><th>操作</th>
        </tr></thead><tbody id="userRows"></tbody></table>
      </div>
    </div>`;
  renderRows();
  $('#userSearch').oninput = event => {
    state.userFilter.q = event.target.value;
    renderRows();
  };
  $('#userDept').onchange = event => {
    state.userFilter.dept = event.target.value;
    renderRows();
  };

  $('#btnNewUser').onclick = () => openUserDrawer(null, roles, vUsers, catalog);

  $('#btnRoleMatrix').onclick = () => {
    const perms = catalog.permissions || {};
    const rows = roles.map(item => `<tr>
      <td>${esc(item.name)}<div class="dim mono">${esc(item.role)}</div></td>
      <td>${esc(item.department)}</td>
      <td>${item.scope === 'all' ? '全部项目' : '参与项目'}</td>
      <td class="num">${item.permission_count}</td></tr>`).join('');
    const drawer = $('#drawer');
    $('.drawer-box', drawer).innerHTML = `
      <div class="drawer-h"><div><h2>角色权限说明</h2>
        <p>每个角色可执行的动作由权限点控制，详见 docs/人员权限清单_v1.0.md。</p></div>
        <button class="x" onclick="document.getElementById('drawer').classList.remove('open')">✕</button></div>
      <div class="drawer-b">
        <div class="t-scroll"><table class="t"><thead><tr>
          <th>角色</th><th>部门</th><th>项目范围</th><th class="num">权限点</th>
        </tr></thead><tbody>${rows}</tbody></table></div>
        <p class="dim" style="margin-top:10px">共 ${Object.keys(perms).length} 个权限点。</p>
      </div>`;
    drawer.classList.add('open');
  };
}

async function vBackups() {
  const backups = await api('/admin/backups');
  $('#viewSub').textContent = '创建并查看本地数据库全量备份；当前版本未提供从备份恢复的操作。';
  $('#view').innerHTML = `
    <div class="pfd-commandbar">
      <div><h2>数据库备份</h2></div>
      <div style="display:flex;gap:8px">
        <button class="btn ghost" id="btnResync">重算交付物同步</button>
        <button class="btn" id="btnBackup">创建备份</button>
      </div>
    </div>
    <div class="alert info" style="margin-bottom:12px">启动时不再自动重算同步，避免掩盖真实状态漂移；需要时由管理员在此显式重算。恢复操作未实现，请勿直接覆盖运行中的数据库文件。</div>
    <div class="card"><div class="card-h"><h3>备份记录</h3><span class="hint">${backups.list.length} 个文件</span></div>
      <table class="t"><thead><tr><th>文件</th><th>大小</th><th>附件</th><th>生成时间</th></tr></thead><tbody>
        ${backups.list.map(item => `<tr><td class="mono">${esc(item.name)}</td><td>${Math.round(item.size / 1024)} KB</td>
          <td>${item.has_attachments ? '<span class="badge b-ok">含附件</span>' : '<span class="badge b-gray">仅数据库</span>'}</td>
          <td class="mono">${esc(item.created_at)}</td></tr>`).join('') || '<tr><td colspan="4" class="dim">暂无备份</td></tr>'}
      </tbody></table></div>`;
  $('#btnBackup').onclick = async () => {
    try {
      const result = await api('/admin/backup', { method: 'POST', body: { user: '管理员' } });
      toast('备份完成：' + result.name, 'ok');
      vBackups();
    } catch (e) { toast(e.message, 'err'); }
  };
  $('#btnResync').onclick = async () => {
    const ok = await showConfirmDialog('重算交付物同步',
      '将重新计算当前项目的交付物联动、CP/SPC/MSA 引用与冲突记录，并写入审计。是否继续？',
      { confirmText: '开始重算' });
    if (!ok) return;
    try {
      const result = await api('/admin/resync', { method: 'POST', body: { note: '管理员手动重算' } });
      const summary = result.summary || {};
      toast(`重算完成：新增 ${summary.created || 0}，更新 ${summary.updated || 0}，冲突 ${summary.conflicts || 0}`,
        summary.conflicts ? 'warn' : 'ok');
    } catch (e) { toast(e.message, 'err'); }
  };
}

/* ------------------------------------------------------------------ 启动 */
/** 修改本人口令；forced = 首次登录必须改，取消即退出登录 */
async function openChangePassword(forced = false) {
  const values = await showFormDialog({
    title: forced ? '首次登录：请先修改口令' : '修改我的口令',
    description: '一次性口令会一直留在初始口令文件里，请改成只有你知道的口令。',
    fields: [
      { key: 'current_password', label: '当前口令', type: 'password', required: true },
      { key: 'new_password', label: '新口令（至少 6 位，不能用初始口令）', type: 'password', required: true },
      { key: 'confirm', label: '再输一次新口令', type: 'password', required: true },
    ],
    confirmText: '保存口令',
    validate: v => v.new_password.length < 6 ? '新口令至少 6 位'
      : v.new_password !== v.confirm ? '两次输入的新口令不一致'
        : v.new_password === v.current_password ? '新口令不能与当前口令相同' : '',
  });
  if (!values) {
    if (!forced) return;
    await api('/auth/logout', { method: 'POST' }).catch(() => {});
    location.reload();
    return;
  }
  try {
    await api('/auth/change-password', { method: 'POST', body: values });
    state.user.must_change_password = false;
    toast('口令已修改', 'ok');
    if (forced) location.reload();
  } catch (error) {
    toast(error.message, 'err');
    if (forced) openChangePassword(true);
  }
}
$('#btnPassword').onclick = () => openChangePassword(false);
$('#btnRefresh').onclick = () => {
  if (state.view === 'ppapEvidence') return vPpapEvidence(state.ppapNo);
  if (state.view === 'apqp' && state.apqpPhase != null) return goApqpPhase(state.apqpPhase);
  go(state.view);
};
$('#role').onchange = () => {
  // S-10：角色由登录账号决定；写接口的权限校验在服务端执行
  toast('角色由登录账号决定；如需其他权限，请使用对应账号登录', 'err');
};
$('#relatedPreviewClose').onclick = closeRelatedPreview;
$('#relatedPreviewCopyAll').onclick = () => {
  if (relatedPreviewState) copyRelatedText(relatedPreviewText(relatedPreviewState));
};
$('#relatedPreview').addEventListener('click', event => {
  const version = event.target.closest('[data-preview-version]');
  if (version && relatedPreviewState) {
    openRelatedPreview(relatedPreviewState.code, version.dataset.previewVersion);
    return;
  }
  const sectionButton = event.target.closest('[data-preview-copy-section]');
  if (sectionButton && relatedPreviewState) {
    const section = relatedPreviewState.sections?.[+sectionButton.dataset.previewCopySection];
    if (section) copyRelatedText(relatedSectionText(section));
    return;
  }
  const fieldButton = event.target.closest('[data-preview-copy-field]');
  if (fieldButton && relatedPreviewState) {
    const [sectionIndex, fieldIndex] = fieldButton.dataset.previewCopyField.split(':').map(Number);
    const field = relatedPreviewState.sections?.[sectionIndex]?.fields?.[fieldIndex];
    if (field) copyRelatedText(`${field.label}：${relatedValueText(field.value)}`);
    return;
  }
  const tableButton = event.target.closest('[data-preview-copy-table]');
  if (tableButton && relatedPreviewState) {
    const [sectionIndex, fieldIndex] = tableButton.dataset.previewCopyTable.split(':').map(Number);
    const field = relatedPreviewState.sections?.[sectionIndex]?.fields?.[fieldIndex];
    if (field) copyRelatedText(relatedTableText(field));
    return;
  }
  const rowButton = event.target.closest('[data-preview-copy-row]');
  if (rowButton && relatedPreviewState) {
    const [sectionIndex, fieldIndex, rowIndex] = rowButton.dataset.previewCopyRow.split(':').map(Number);
    const field = relatedPreviewState.sections?.[sectionIndex]?.fields?.[fieldIndex];
    const row = field?.rows?.[rowIndex];
    if (row) copyRelatedText(row.map(relatedValueText).join('\t'));
    return;
  }
  const cell = event.target.closest('[data-preview-copy-cell]');
  if (cell && relatedPreviewState) {
    const [sectionIndex, fieldIndex, rowIndex, columnIndex] = cell.dataset.previewCopyCell.split(':').map(Number);
    const value = relatedPreviewState.sections?.[sectionIndex]?.fields?.[fieldIndex]?.rows?.[rowIndex]?.[columnIndex];
    copyRelatedText(relatedValueText(value));
  }
});
$('#drawer').onclick = e => { if (e.target.id === 'drawer') $('#drawer').classList.remove('open'); };
document.addEventListener('keydown', e => { if (e.key === 'Escape') $('#drawer').classList.remove('open'); });
let lastRouteDispatch = null;
function dispatchRouteHash() {
  // popstate 与 hashchange 常成对触发，同一哈希只分发一次
  if (location.hash === lastRouteDispatch) return;
  lastRouteDispatch = location.hash;
  const v = location.hash.slice(1);
  suppressRouteHistory = true;
  try {
    if (v === 'upload') { openUpload(); return; }
    if (v.startsWith('ppap/')) { openPpapEvidence(v.slice(5)); return; }
    if (v.startsWith('apqp/')) { goApqpPhase(+v.slice(5)); return; }
    if (v === 'pfd' || v.startsWith('pfd/')) { goPfd(v.split('/')[1]); return; }
    if (v.startsWith('doc/')) { openDoc(v.slice(4)); return; }
    if (v.startsWith('tpl/')) { openTpl(v.slice(4)); return; }
    if (v && v !== state.view && NAV.some(n => n.id === v)) { go(v); return; }
    // S-11：未知哈希给出明确提示，而不是静默停留在当前页
    if (v && !NAV.some(n => n.id === v)) toast(`页面不存在：${v}`, 'err');
  } finally {
    suppressRouteHistory = false;
  }
}
window.addEventListener('hashchange', dispatchRouteHash);
window.addEventListener('popstate', dispatchRouteHash);

/* S-17 补充：业务宽表统一包一层横向滚动容器。
 * 视图模板里手写的 `<div style="overflow:auto">` 继续有效；这里兜底其余直接放在卡片里的表格，
 * 避免窄屏下被 body 的 overflow-x:hidden 直接裁掉右侧列。 */
function wrapScrollableTables(root) {
  if (!root || root.nodeType !== 1) return;
  const tables = root.matches?.('table.t') ? [root] : [...root.querySelectorAll('table.t')];
  for (const table of tables) {
    const parent = table.parentElement;
    if (!parent || parent.classList.contains('t-scroll')) continue;
    const overflow = getComputedStyle(parent).overflowX;
    if (overflow === 'auto' || overflow === 'scroll') continue;
    const holder = document.createElement('div');
    holder.className = 't-scroll';
    parent.insertBefore(holder, table);
    holder.appendChild(table);
  }
}
let tableWrapPending = false;
const tableObserver = new MutationObserver(() => {
  // 自身插入包裹层也会触发回调，合并到微任务后统一处理，避免重复包裹
  if (tableWrapPending) return;
  tableWrapPending = true;
  queueMicrotask(() => {
    tableWrapPending = false;
    document.querySelectorAll('table.t').forEach(table => {
      const parent = table.parentElement;
      if (parent && !parent.classList.contains('t-scroll')
          && !['auto', 'scroll'].includes(getComputedStyle(parent).overflowX)) {
        wrapScrollableTables(table);
      }
    });
  });
});
tableObserver.observe(document.body, { childList: true, subtree: true });

boot();

/* ------------------------------------------------------------------ 工艺流程图：图片识别导入 */
async function openPfdOcr() {
  const drawer = $('#drawer');
  $('.drawer-box', drawer).innerHTML = `
    <div class="drawer-h">
      <div><h2>从图片识别工序</h2><p>上传工艺流程图，识别方框里的工序名 → 核对顺序后导入</p></div>
      <button class="x" onclick="document.getElementById('drawer').classList.remove('open')">✕</button>
    </div>
    <div class="drawer-b">
      <div id="pfdDrop" style="border:2px dashed #C9D4E3;border-radius:10px;padding:24px;text-align:center;cursor:pointer;background:#FBFCFE">
        <div style="font-size:26px">🖼</div>
        <div style="margin-top:6px;font-weight:600">在此粘贴图片（Ctrl+V）或点击选择</div>
        <div class="dim" style="font-size:11.5px;margin-top:4px">会识别图上的全部文字，箭头方向识别不出来，顺序需人工确认</div>
        <input type="file" id="pfdFile" accept="image/*" style="display:none">
      </div>
      <div id="pfdBody"></div>
    </div>`;
  drawer.classList.add('open');
  const drop = $('#pfdDrop');
  drop.onclick = () => $('#pfdFile').click();
  $('#pfdFile').onchange = e => { const f = e.target.files[0]; if (f) run(f); };
  drawer.onpaste = e => {
    for (const it of (e.clipboardData || {}).items || []) {
      if (it.type && it.type.startsWith('image/')) { run(it.getAsFile()); e.preventDefault(); return; }
    }
  };
  async function run(file) {
    const fr = new FileReader();
    fr.onload = async () => {
      const b64 = fr.result;
      $('#pfdBody').innerHTML = '<div class="dim" style="margin-top:12px">正在识别…</div>';
      try {
        const r = await api('/pfd/ocr', { method: 'POST', body: { imageBase64: b64 } });
        $('#pfdBody').innerHTML = `
          <div class="card" style="margin-top:12px">
            <div class="card-h"><h3>识别到 ${r.lines.length} 行文字</h3><span class="hint">每行一个工序，可删可改、可调顺序</span></div>
            <div class="card-b">
              <textarea id="pfdLines" rows="14" style="width:100%;font-size:12.5px;line-height:1.9;padding:10px;border:1px solid var(--line);border-radius:8px">${esc(r.lines.join('\n'))}</textarea>
              <div style="display:flex;gap:10px;align-items:center;margin-top:10px">
                <label class="dim" style="font-size:12px"><input type="radio" name="pfdMode" value="replace" checked> 替换现有工序</label>
                <label class="dim" style="font-size:12px"><input type="radio" name="pfdMode" value="append"> 追加</label>
                <button class="btn" id="pfdImport" style="margin-left:auto">导入为工序</button>
              </div>
            </div>
          </div>`;
        $('#pfdImport').onclick = async () => {
          const names = $('#pfdLines').value.split('\n').map(s => s.trim()).filter(Boolean);
          const mode = document.querySelector('input[name="pfdMode"]:checked').value;
          try {
            const res = await api('/steps/bulk', { method: 'POST', body: {
              names, mode, pfd_mode: state.pfdMode,
            } });
            toast(`已导入 ${res.count} 道工序`, 'ok');
            drawer.classList.remove('open');
            vPfd();
          } catch (e) {
            // P-07：替换会作废被 PFMEA 引用的工序，先列出影响面再由用户确认
            const steps = e.details?.referencing_steps || [];
            if (e.status !== 409 || !steps.length) { toast(e.message, 'err'); return; }
            const list = steps.map(item =>
              `${item.step_no || ''} ${item.name}（PFMEA 行 ${item.fmea_rows} 条${item.fmea_nodes ? `，结构关联 ${item.fmea_nodes} 处` : ''}）`
            ).join('；');
            const ok = await showConfirmDialog('批量替换会影响 PFMEA',
              `以下工序仍被 PFMEA 引用，替换后会被作废，相关 PFMEA 与控制计划将退回草稿：${list}`,
              { confirmText: '仍然替换', danger: true });
            if (!ok) return;
            try {
              const res = await api('/steps/bulk', { method: 'POST', body: {
                names, mode, pfd_mode: state.pfdMode, confirm_replace: true,
              } });
              toast(`已导入 ${res.count} 道工序`, 'ok');
              drawer.classList.remove('open');
              vPfd();
            } catch (err) { toast(err.message, 'err'); }
          }
        };
      } catch (e) {
        $('#pfdBody').innerHTML = `<div class="alert bad" style="margin-top:12px">${esc(e.message)}</div>`;
      }
    };
    fr.readAsDataURL(file);
  }
}
/* ------------------------------------------------------------------ S/O/D 评级表（AIAG-VDA 手册 P1/P2/P3） */
const RATINGS = {
  S: {
    title: '严重度 S（表 P1）',
    cols: ['S', '对您的工厂的影响', '对发运至工厂的影响', '对最终用户的影响'],
    rows: [
      ['10', '可能导致从事生产或组装作业的工人面临严重的健康和/或安全风险', '可能导致从事生产或组装作业的工人面临严重的健康和/或安全风险', '影响车辆操作安全性，驾驶员、乘客、交通参与者或行人的健康'],
      ['9', '可能导致厂内不符合法规', '可能导致厂内不符合法规', '不符合法规'],
      ['8', '生产运行 100% 受影响，产品不得不报废；可能导致厂内不符合法规，或工人慢性健康/安全风险', '生产线停工超过一个完整班次；可能停止发货；需现场返修或更换，且不符合法规', '在预期使用寿命内，失去正常驾驶所需的车辆主要功能'],
      ['7', '产品可能需分拣，其中一部分（少于 100%）会报废；主要过程有偏差；生产速度降低或增加劳动力', '生产线停工从 1 小时到一个完整班次；可能停止发货；需现场返修或更换', '在预期使用寿命内，降低正常驾驶所必需的车辆主要功能'],
      ['6', '100% 的产品可能需要线下返工后才能被接受', '生产线停工不超过一个小时', '失去车辆次要功能'],
      ['5', '部分产品可能需要线下返工后才能被接受', '少于 100% 受影响；极可能出现额外缺陷产品；需要分拣；生产线没有停工', '降低车辆次要功能'],
      ['4', '100% 的产品可能需要在工位上返工后才能继续加工', '缺陷产品触发重大反应计划；可能不会出现额外瑕疵产品；不需要分拣', '外观、声音、振动、粗糙度或触感令人非常不舒服'],
      ['3', '部分产品可能需要在工位上返工后才能继续加工', '缺陷产品触发次要反应计划；不需要分拣', '外观、声音、振动、粗糙度或触感令人中度不舒服'],
      ['2', '会导致过程、操作或操作人员的不方便', '缺陷产品不会触发反应计划；不需要分拣；需要向供应商反馈', '外观、声音、振动、粗糙度或触感令人略微不舒服'],
      ['1', '没有可察觉到的影响', '没有可察觉到的影响或没有影响', '没有可察觉到的影响'],
    ],
  },
  O: {
    title: '频度 O（表 P2）',
    cols: ['O', '对失效起因发生的预测', '控制类型', '预防控制的有效性'],
    rows: [
      ['10', '极高', '无', '没有预防控制'],
      ['9', '非常高', '行为控制', '预防控制在防止失效起因出现方面作用很小'],
      ['8', '', '', ''],
      ['7', '高', '行为或技术控制', '预防控制可以起到一定作用'],
      ['6', '', '', ''],
      ['5', '中', '', '预防控制可以起到有效的作用'],
      ['4', '', '', ''],
      ['3', '低', '最佳实践：行为或技术控制', '预防控制可以起到高度有效的作用'],
      ['2', '非常低', '', ''],
      ['1', '极低', '技术控制', '预防控制极其有效，失效模式不会因失效起因实际发生'],
    ],
  },
  D: {
    title: '探测度 D（表 P3）',
    cols: ['D', '探测能力', '探测方法成熟度', '探测机会'],
    rows: [
      ['10', '非常低', '尚未建立或没有已知的测试/检验方法', '不能或无法探测到失效模式'],
      ['9', '', '测试或检验方法不能探测到失效模式', '通过随机或不定时的审核很难探测到'],
      ['8', '低', '测试方法尚未经过实践证明有效可靠（量具 GR&R 接近边际值）', '人工检验（视觉、触觉、听觉）或人工测量'],
      ['7', '', '', '基于设备的探测（光学、蜂鸣器等半自动化）或检验设备'],
      ['6', '中', '测试方法已经实践证明有效可靠（GR&R 结果可接受）', '人工检验（含样本检验）或人工测量'],
      ['5', '', '', '基于设备的自动化探测，或检验设备'],
      ['4', '高', '已经实践证明有效可靠的系统', '自动化探测可在下游发现失效，避免进一步加工或流出'],
      ['3', '', '', '自动化探测在工位上发现失效，避免进一步加工'],
      ['2', '', '探测方法已经实践证明有效可靠', '以设备为基础的探测，可探测失效起因并避免失效模式'],
      ['1', '非常高', '根据设计或加工过程不会出现失效模式，或探测方法总是能探测到', ''],
    ],
  },
};

function openRating(kind, targetSel) {
  const t = RATINGS[kind];
  if (!t) return;
  const drawer = $('#drawer');
  $('.drawer-box', drawer).innerHTML = `
    <div class="drawer-h">
      <div><h2>${esc(t.title)}</h2><p>点击左侧分值即可填入当前行</p></div>
      <button class="x" onclick="document.getElementById('drawer').classList.remove('open')">✕</button>
    </div>
    <div class="drawer-b">
      <table class="t"><thead><tr>${t.cols.map(c => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>
        ${t.rows.map(r => `<tr data-rate="${r[0]}">
          <td class="mono" style="font-weight:700;cursor:pointer;color:var(--accent)">${r[0]}</td>
          ${r.slice(1).map(c => `<td class="dim" style="font-size:12px">${esc(c)}</td>`).join('')}
        </tr>`).join('')}
      </tbody></table>
      <div class="dim" style="font-size:11.5px;margin-top:10px">
        评级是团队相对评级，不同团队之间的分值不可直接比较（手册 P72）。表中空白处表示与上方分值同一档。
      </div>
    </div>`;
  drawer.classList.add('open');
  $('.drawer-box', drawer).querySelectorAll('[data-rate]').forEach(tr => {
    tr.onclick = () => {
      const v = tr.dataset.rate;
      const el = $(targetSel);
      if (el) { el.value = v; el.dispatchEvent(new Event('input')); }
      const back = $('#drawer');
      back.classList.remove('open');
      toast('已填入 ' + kind + ' = ' + v, 'ok');
    };
  });
}

/* ------------------------------------------------------------------ 4M 失效起因“激励问题”清单（手册 P53-54） */
const CAUSE_Q = {
  '人员': [
    '是否可能使用过程中可用的错误零件？',
    '零件是否可能被漏装？',
    '零件是否可能被错误地装载？',
    '零件从拿取到应用期间是否会损坏？',
    '是否可能使用错误材料？',
    '操作人员是否可能跳过某个步骤？',
  ],
  '设备': [
    '自动化过程是否可能中断？',
    '数据是否可能错误输入？',
    '机器是否可能绕过自动控制，在手动模式下运行？',
    '是否有计划来确定预防和探测控制措施？',
    '设备参数漂移是否会被发现？',
  ],
  '材料（间接）': [
    '是否可能过多 / 过少 / 没有材料使用？',
    '是否可能在错误位置使用材料？',
    '来料批次间是否存在差异？',
  ],
  '环境': [
    '任务所需的照明是否足够？',
    '过程中使用的零件是否被视为异物？',
    '温湿度、洁净度是否超出工艺窗口？',
  ],
};

function openCauses() {
  const drawer = $('#drawer');
  $('.drawer-box', drawer).innerHTML = `
    <div class="drawer-h">
      <div><h2>4M 失效起因 · 提问引导</h2><p>按 AIAG-VDA 手册 P53–54：用问题逼出具体起因，避免"设备精度不足"这类笼统写法</p></div>
      <button class="x" onclick="document.getElementById('drawer').classList.remove('open')">✕</button>
    </div>
    <div class="drawer-b">
      ${Object.entries(CAUSE_Q).map(([m, qs]) => `
        <div class="card" style="margin-bottom:10px">
          <div class="card-h"><h3 style="font-size:13px">${esc(m)}</h3><span class="hint">${qs.length} 问</span></div>
          <div class="card-b">
            ${qs.map(q => `<div style="padding:5px 0;border-bottom:1px dashed var(--line2);font-size:12.5px">· ${esc(q)}</div>`).join('')}
          </div>
        </div>`).join('')}
      <div class="alert warn">
        <div>起因描述要能指向具体控制：写「刻槽参数未锁定，换型后需人工重输」而不是「操作不当」；
        写「溅射靶材寿命超期未更换」而不是「设备老化」。</div>
      </div>
    </div>`;
  drawer.classList.add('open');
}

/* ------------------------------------------------------------------ PFMEA 表头（11 字段） */
const HEADER_FIELDS = [
  ['company', '公司名称'], ['address', '制造地址'], ['customer', '顾客名称'],
  ['model_year', '年型 / 项目'], ['project', '项目（PFMEA 项目名）'],
  ['start_date', 'PFMEA 开始日期'], ['rev_date', 'PFMEA 修订日期'],
  ['team', '跨职能团队'], ['fmea_id', 'PFMEA ID 编号'],
  ['process_owner', '过程职责（所有人）'], ['confidential', '保密等级'],
];

async function openHeader() {
  const d = await api('/fmea?type=' + state.fmeaType);
  const meta = JSON.parse(d.header.meta_json || '{}');
  const drawer = $('#drawer');
  $('.drawer-box', drawer).innerHTML = `
    <div class="drawer-h">
      <div><h2>${state.fmeaType} 表头</h2><p>手册 P13 要求的 11 项基本范围信息</p></div>
      <button class="x" onclick="document.getElementById('drawer').classList.remove('open')">✕</button>
    </div>
    <div class="drawer-b">
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
        ${HEADER_FIELDS.map(([k, label]) => `
          <div class="field"><label>${esc(label)}</label>
            <input id="hdr_${k}" value="${esc(meta[k] || '')}" placeholder="${esc(label)}"></div>`).join('')}
      </div>
      <button class="btn" id="hdrSave" style="margin-top:12px">保存表头</button>
    </div>`;
  drawer.classList.add('open');
  $('#hdrSave').onclick = async () => {
    const m = {};
    HEADER_FIELDS.forEach(([k]) => { const el = $('#hdr_' + k); if (el) m[k] = el.value.trim(); });
    try {
      await api('/fmea/header', { method: 'POST', body: { fmea_type: state.fmeaType, meta: m } });
      toast('表头已保存', 'ok');
      drawer.classList.remove('open');
      vFmea();
    } catch (e) { toast(e.message, 'err'); }
  };
}

/* ------------------------------------------------------------------ FMEA 报告（第七步） */
async function openReport() {
  let r;
  try { r = await api('/fmea/report?type=' + state.fmeaType); } catch (e) { return toast(e.message, 'err'); }
  const m = r.meta || {};
  const drawer = $('#drawer');
  const kv = (k, v) => `<div style="display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px dashed var(--line2);font-size:12.5px"><span class="dim">${esc(k)}</span><b>${esc(v || '—')}</b></div>`;
  $('.drawer-box', drawer).innerHTML = `
    <div class="drawer-h">
      <div><h2>${r.type} 报告</h2><p>第七步 结果文件化 · ${esc(r.project.name || '')}</p></div>
      <button class="x" onclick="document.getElementById('drawer').classList.remove('open')">✕</button>
    </div>
    <div class="drawer-b">
      <div class="card" style="margin-bottom:12px">
        <div class="card-h"><h3 style="font-size:13px">一、5T 与范围</h3></div>
        <div class="card-b">
          ${kv('目的（项目）', m.project || r.project.name)}
          ${kv('时间（开始 / 修订）', (m.start_date || '—') + ' / ' + (m.rev_date || '—'))}
          ${kv('团队', m.team)}
          ${kv('工具（方法）', r.header.ap_ver || 'AP-2019')}
          ${kv('公司 / 顾客', (m.company || '—') + ' / ' + (m.customer || '—'))}
          ${kv('PFMEA ID / 职责', (m.fmea_id || '—') + ' / ' + (m.process_owner || '—'))}
          ${kv('保密等级', m.confidential)}
        </div>
      </div>

      <div class="card" style="margin-bottom:12px">
        <div class="card-h"><h3 style="font-size:13px">二、分析范围</h3><span class="hint">结构三级 / 功能 / 失效</span></div>
        <div class="card-b">
          <div class="grid g4" style="gap:10px">
            <div class="kpi"><div class="k">过程项</div><div class="v">${r.scope.levels[0].count}</div></div>
            <div class="kpi"><div class="k">过程步骤</div><div class="v">${r.scope.levels[1].count}</div></div>
            <div class="kpi"><div class="k">工作要素</div><div class="v">${r.scope.levels[2].count}</div></div>
            <div class="kpi"><div class="k">功能</div><div class="v">${r.scope.functions}</div></div>
          </div>
          <div style="margin-top:10px">${kv('失效分析行', r.scope.rows)}${kv('待采用候选', r.scope.candidates)}</div>
        </div>
      </div>

      <div class="card" style="margin-bottom:12px">
        <div class="card-h"><h3 style="font-size:13px">三、风险分布</h3>
          <span class="hint">高 ${r.risk.counts.H} · 中 ${r.risk.counts.M} · 低 ${r.risk.counts.L}</span></div>
        <div class="card-b">
          ${r.risk.counts.H ? `<div class="alert ${r.risk.noDecision ? 'bad' : 'info'}">
            ${r.risk.noDecision ? `<b>${r.risk.noDecision} 条高 AP 失效尚无处置决定</b>，按手册必须给出决定或论证。` : '全部高 AP 失效均已登记处置决定。'}
          </div>` : '<div class="dim" style="font-size:12px">当前没有高 AP 失效。</div>'}
          ${r.risk.high.length ? `<table class="t" style="margin-top:8px"><thead><tr><th>行号</th><th>失效模式</th><th class="num">S</th><th class="num">O</th><th class="num">D</th><th>决定</th></tr></thead><tbody>
            ${r.risk.high.map(x => `<tr><td class="mono">${esc(x.row_id)}</td><td>${esc(x.fm || '')}</td>
              <td class="num">${x.s}</td><td class="num">${x.o}</td><td class="num">${x.d}</td>
              <td>${x.decision ? esc(x.decision) : '<span class="badge b-bad">缺决定</span>'}</td></tr>`).join('')}
          </tbody></table>` : ''}
        </div>
      </div>

      <div class="card" style="margin-bottom:12px">
        <div class="card-h"><h3 style="font-size:13px">四、措施状态</h3><span class="hint">共 ${r.actions.total} 条</span></div>
        <div class="card-b">
          ${Object.keys(r.actions.byStatus).length
            ? Object.entries(r.actions.byStatus).map(([k, v]) => kv(k, v + ' 条')).join('')
            : '<div class="dim" style="font-size:12px">尚未登记措施。</div>'}
        </div>
      </div>

      <div class="card">
        <div class="card-h"><h3 style="font-size:13px">五、遗留缺口</h3></div>
        <div class="card-b">
          ${kv('无功能的过程步骤', r.gaps.noFunction + ' 个')}
          ${kv('无失效分析的过程步骤', r.gaps.noRow + ' 个')}
          <div class="dim" style="font-size:11.5px;margin-top:8px">
            报告仅汇总系统内已有数据；手册要求报告不替代对 PFMEA 本身的评审。
          </div>
        </div>
      </div>
    </div>`;
  drawer.classList.add('open');
}

/* ------------------------------------------------------------------ 工序字典 */
async function vProcessDict() {
  const data = await api('/process-dict');
  const list = data.list || [];
  $('#viewSub').textContent = `共享工艺主数据 · ${list.filter(item => item.status === '生效').length} 项生效 · 被项目引用后保留项目内快照`;
  $('#view').innerHTML = `
    <div class="pfd-commandbar">
      <div><h2>工序字典</h2></div>
      <div class="fmea-mode-actions">
        <button class="btn ghost" id="processDictRefresh" title="刷新字典">刷新</button>
        <button class="btn" id="processDictAdd">＋ 新增工序</button>
      </div>
    </div>
    <section class="card process-dict-panel">
      <div class="process-dict-toolbar">
        <label class="process-dict-search"><span>查找</span><input id="processDictSearch" type="search" placeholder="编号或工序名称"></label>
        <label><span>类型</span><select id="processDictType">
          <option value="">全部类型</option>
          ${['制造', '工序', '检验', '特殊过程', '存储', '搬运'].map(type => `<option>${type}</option>`).join('')}
        </select></label>
        <label><span>状态</span><select id="processDictStatus">
          <option value="">全部状态</option><option value="生效">生效</option><option value="停用">停用</option>
        </select></label>
        <span class="process-dict-count" id="processDictCount"></span>
      </div>
      <div class="process-dict-scroll"><table class="t process-dict-table">
        <thead><tr><th>字典编号</th><th>标准工序名称</th><th>类型</th><th>默认设备 / 检具</th><th>生效日期</th><th>失效日期</th><th>状态</th><th>操作</th></tr></thead>
        <tbody>${list.map(item => `<tr data-process-dict="${esc(item.dict_id)}">
          <td><input data-pd-field="code" value="${esc(item.code)}"></td>
          <td><input data-pd-field="name" value="${esc(item.name)}"></td>
          <td><select data-pd-field="step_type">${['制造', '工序', '检验', '特殊过程', '存储', '搬运'].map(type =>
            `<option ${item.step_type === type ? 'selected' : ''}>${type}</option>`).join('')}</select></td>
          <td><input data-pd-field="default_equipment" value="${esc(item.default_equipment || '')}" placeholder="可留空"></td>
          <td><input data-pd-field="effective_from" type="date" value="${esc(item.effective_from || '')}"></td>
          <td><input data-pd-field="effective_to" type="date" value="${esc(item.effective_to || '')}"></td>
          <td><select data-pd-field="status"><option ${item.status === '生效' ? 'selected' : ''}>生效</option><option ${item.status === '停用' ? 'selected' : ''}>停用</option></select></td>
          <td><button class="btn sm" data-pd-save="${esc(item.dict_id)}">保存</button></td>
        </tr>`).join('')}</tbody>
      </table></div>
      <div class="process-dict-foot">从 PFD 引用时会复制工序名称、类型和默认设备；后续维护字典不会覆盖已建立或已发布的项目工序。</div>
    </section>`;

  const filterRows = () => {
    const query = $('#processDictSearch').value.trim().toLocaleLowerCase();
    const type = $('#processDictType').value;
    const status = $('#processDictStatus').value;
    let visible = 0;
    $$('[data-process-dict]').forEach(row => {
      const item = list.find(entry => entry.dict_id === row.dataset.processDict);
      const matches = (!query || `${item.code} ${item.name}`.toLocaleLowerCase().includes(query))
        && (!type || item.step_type === type)
        && (!status || item.status === status);
      row.hidden = !matches;
      if (matches) visible += 1;
    });
    $('#processDictCount').textContent = `${visible} / ${list.length} 项`;
  };
  ['processDictSearch', 'processDictType', 'processDictStatus'].forEach(id =>
    $('#' + id).addEventListener(id === 'processDictSearch' ? 'input' : 'change', filterRows));
  filterRows();
  $('#processDictRefresh').onclick = () => vProcessDict();
  $('#processDictAdd').onclick = () => openProcessDictForm();
  $$('[data-pd-save]').forEach(button => {
    button.onclick = async () => {
      const row = button.closest('[data-process-dict]');
      const body = {};
      row.querySelectorAll('[data-pd-field]').forEach(field => { body[field.dataset.pdField] = field.value; });
      button.disabled = true;
      try {
        await api('/process-dict/' + encodeURIComponent(button.dataset.pdSave), { method: 'PATCH', body });
        toast('工序字典已保存', 'ok');
        await vProcessDict();
      } catch (error) {
        button.disabled = false;
        toast(error.message, 'err');
      }
    };
  });
}

function openProcessDictForm() {
  const drawer = $('#drawer');
  $('.drawer-box', drawer).innerHTML = `
    <div class="drawer-h"><div><h2>新增工序字典</h2><p>新增后可在各项目的工艺流程图中引用。</p></div>
      <button class="x" aria-label="关闭" onclick="document.getElementById('drawer').classList.remove('open')">×</button></div>
    <div class="drawer-b process-dict-form">
      <label><span>字典编号</span><input id="pdCode" required placeholder="例如：OP-010"></label>
      <label><span>标准工序名称</span><input id="pdName" required placeholder="例如：激光划线"></label>
      <label><span>工序类型</span><select id="pdType">${['工序', '制造', '检验', '特殊过程', '存储', '搬运'].map(type => `<option>${type}</option>`).join('')}</select></label>
      <label><span>默认设备 / 检具</span><input id="pdEquipment" placeholder="可留空"></label>
      <div class="row2">
        <label><span>生效日期</span><input id="pdFrom" type="date" value="${new Date().toISOString().slice(0, 10)}"></label>
        <label><span>失效日期</span><input id="pdTo" type="date"></label>
      </div>
      <button class="btn" id="pdCreate">新增到工序字典</button>
    </div>`;
  drawer.classList.add('open');
  $('#pdCreate').onclick = async () => {
    const button = $('#pdCreate');
    button.disabled = true;
    try {
      await api('/process-dict', { method: 'POST', body: {
        code: $('#pdCode').value.trim(), name: $('#pdName').value.trim(),
        step_type: $('#pdType').value, default_equipment: $('#pdEquipment').value.trim(),
        effective_from: $('#pdFrom').value, effective_to: $('#pdTo').value || null,
      } });
      drawer.classList.remove('open');
      toast('工序字典已新增', 'ok');
      await vProcessDict();
    } catch (error) {
      button.disabled = false;
      toast(error.message, 'err');
    }
  };
}

/* ------------------------------------------------------------------ 产品族/系列字典 */
async function vProductDict() {
  const [familiesResult, seriesResult] = await Promise.all([
    api('/product-families'), api('/product-series'),
  ]);
  const families = familiesResult.list || [];
  const series = seriesResult.list || [];
  const activeFamilies = families.filter(item => item.status !== '作废');
  $('#viewSub').textContent = '产品手册目录维护：产品大类/类别作为上层，系列/型号作为下层；项目和特性按系列引用';
  $('#view').innerHTML = `
    <div class="pfd-commandbar">
      <div><h2>产品族 / 系列字典</h2></div>
      <div class="fmea-mode-actions">
        <button class="btn ghost" id="productDictRefresh">刷新</button>
        <button class="btn" id="productDictAddFamily">+ 新增产品类别</button>
        <button class="btn ghost" id="productDictAddSeries">+ 新增系列/型号</button>
      </div>
    </div>
    <section class="card">
      <div class="card-h"><h3>产品类别 / 系列 / 型号</h3>
        <span class="hint">${families.length} 个产品类别 · ${series.length} 个系列/型号</span></div>
      <div class="product-dict-scroll"><table class="t product-dict-table"><thead><tr>
        <th>层级 / 名称</th><th>编码</th><th>手册目录归属</th><th>状态</th><th>操作</th>
      </tr></thead><tbody>
        ${families.map(item => {
          const children = series.filter(child => child.family_id === item.family_id);
          return `<tr class="product-dict-family" data-family="${esc(item.family_id)}">
            <td><div class="product-dict-name">
              <button class="btn sm ghost product-dict-toggle" data-product-dict-toggle="${esc(item.family_id)}"
                aria-expanded="false" aria-label="${children.length ? '展开' : '暂无下级系列'}${esc(item.name)}"
                title="${children.length ? '展开产品类别' : '暂无下级系列'}" ${children.length ? '' : 'disabled'}>${children.length ? '+' : '·'}</button>
              <span class="badge b-gray">产品类别</span><b>${esc(item.name || '')}</b>
              <span class="dim product-dict-child-count">${children.length} 个系列</span>
            </div></td>
            <td class="mono">${esc(item.code || '—')}</td>
            <td>${esc(item.category || '—')}</td>
            <td>${statusBadge(item.status || '生效')}</td>
            <td><button class="btn sm ghost" data-pd-edit-family="${esc(item.family_id)}">编辑</button></td>
          </tr>${children.map(child => `<tr class="product-dict-series" data-series="${esc(child.series_id)}"
              data-series-family="${esc(item.family_id)}" hidden>
            <td><div class="product-dict-name product-dict-child">
              <span class="product-dict-branch" aria-hidden="true"></span>
              <span class="badge b-ok">系列 / 型号</span><b>${esc(child.name || '')}</b>
            </div></td>
            <td class="mono">${esc(child.code || '—')}</td>
            <td class="dim">${esc(item.category || '继承所属产品类别')}</td>
            <td>${statusBadge(child.status || '生效')}</td>
            <td><button class="btn sm ghost" data-pd-edit-series="${esc(child.series_id)}">编辑</button></td>
          </tr>`).join('')}`;
        }).join('')}
      </tbody></table></div>
      ${!families.length ? '<div class="empty">尚未建立产品类别</div>' : ''}
      <div class="card-b dim">产品类别控制固定分类；系列/型号可持续增加，例如 RX、RXG（国军标）、RXE（车规级）。新建项目也支持直接录入新系列/型号，并自动写入本表。</div>
    </section>`;
  $('#productDictRefresh').onclick = () => vProductDict();
  $('#productDictAddFamily').onclick = () => openProductDictForm('family', families);
  $('#productDictAddSeries').disabled = !activeFamilies.length;
  $('#productDictAddSeries').title = activeFamilies.length ? '' : '请先新增生效的产品类别';
  $('#productDictAddSeries').onclick = () => openProductDictForm('series', activeFamilies);
  $$('[data-product-dict-toggle]').forEach(button => button.onclick = () => {
    const familyId = button.dataset.productDictToggle;
    const expanded = button.getAttribute('aria-expanded') === 'true';
    button.setAttribute('aria-expanded', String(!expanded));
    button.textContent = expanded ? '+' : '−';
    button.title = expanded ? '展开产品类别' : '收起产品类别';
    button.setAttribute('aria-label', `${expanded ? '展开' : '收起'}${families.find(item => item.family_id === familyId)?.name || '产品类别'}`);
    $$('[data-series-family]').filter(row => row.dataset.seriesFamily === familyId)
      .forEach(row => { row.hidden = expanded; });
  });
  $$('[data-pd-edit-family]').forEach(button => button.onclick = () => {
    const item = families.find(row => row.family_id === button.dataset.pdEditFamily);
    if (item) openProductDictForm('family', families, item);
  });
  $$('[data-pd-edit-series]').forEach(button => button.onclick = () => {
    const item = series.find(row => row.series_id === button.dataset.pdEditSeries);
    if (item) openProductDictForm('series', families, item);
  });
}

function openProductDictForm(kind, families, item = null) {
  const drawer = $('#drawer');
  const isFamily = kind === 'family';
  const editing = !!item;
  $('.drawer-box', drawer).innerHTML = `
    <div class="drawer-h"><div><h2>${editing ? '编辑' : '新增'}${isFamily ? '产品类别' : '产品系列 / 型号'}</h2><p>产品手册目录可按实际产品继续维护。</p></div>
      <button class="x" onclick="document.getElementById('drawer').classList.remove('open')">×</button></div>
    <div class="drawer-b product-dict-form">
      ${isFamily ? '' : `<label><span>所属产品类别</span><select id="pdFamily">${families.map(family =>
        `<option value="${esc(family.family_id)}" ${family.family_id === item?.family_id ? 'selected' : ''}>${esc(family.code)} · ${esc(family.name)}</option>`).join('')}</select></label>`}
      <label><span>${isFamily ? '类别编码' : '系列 / 型号编码'}</span><input id="pdCode" required value="${esc(item?.code || '')}"></label>
      <label><span>标准名称</span><input id="pdName" required value="${esc(item?.name || '')}"></label>
      ${isFamily ? `<label><span>手册大类 / 目录归属</span><input id="pdCategory" value="${esc(item?.category || '')}" placeholder="通用类产品 / 特种类产品"></label>` : ''}
      ${editing ? `<label><span>状态</span><select id="pdStatus"><option ${item.status === '生效' ? 'selected' : ''}>生效</option><option ${item.status === '作废' ? 'selected' : ''}>作废</option></select></label>` : ''}
      <button class="btn" id="pdCreate">${editing ? '保存修改' : '新增'}</button>
    </div>`;
  drawer.classList.add('open');
  $('#pdCreate').onclick = async () => {
    const body = { code: $('#pdCode').value.trim(), name: $('#pdName').value.trim() };
    if (isFamily) body.category = $('#pdCategory').value.trim();
    else body.family_id = $('#pdFamily').value;
    if (editing) body.status = $('#pdStatus').value;
    const button = $('#pdCreate');
    button.disabled = true;
    try {
      const path = isFamily ? '/product-families' : '/product-series';
      await api(editing ? `${path}/${encodeURIComponent(isFamily ? item.family_id : item.series_id)}` : path, {
        method: editing ? 'PATCH' : 'POST', body,
      });
      drawer.classList.remove('open');
      toast(editing ? '产品字典已保存' : '产品字典已新增', 'ok');
      await vProductDict();
    } catch (error) {
      button.disabled = false;
      toast(error.message, 'err');
    }
  };
}

/* ------------------------------------------------------------------ 特性字典（增删改） */
async function vCharDict() {
  const [list, familiesResult, seriesResult, sourcesResult] = await Promise.all([
    api('/chars'), api('/product-families'), api('/product-series'), api('/character-sources'),
  ]);
  const families = familiesResult.list || [];
  const series = seriesResult.list || [];
  const sources = sourcesResult || {};
  const sourceRefs = [
    ...(sources.refs || []).map(item => ({ value: item.source_ref, label: `${item.source_ref} · ${item.source_type || '未分类'}` })),
    ...(sources.docs || []).map(item => ({ value: item.code, label: `${item.code} · ${item.name || '交付物'}` })),
    ...(sources.ecr || []).map(item => ({ value: item.code, label: `${item.code} · ${item.name || '工程变更'}` })),
  ].filter((item, index, arr) => item.value && item.value !== '—'
    && arr.findIndex(x => x.value === item.value) === index);
  const sourceList = sourceRefs.map(item => `<option value="${esc(item.value)}">${esc(item.label)}</option>`).join('');
  const scopeOptions = c => {
    const familyId = c.family_id || (families[0] || {}).family_id || '';
    const current = c.series_id ? 'series:' + c.series_id : 'family:' + familyId;
    return [
      ...families.map(family => {
        const value = 'family:' + family.family_id;
        return `<option value="${esc(value)}" ${value === current ? 'selected' : ''}>${esc(family.code)} 产品族通用</option>`;
      }),
      ...series.map(item => {
        const value = 'series:' + item.series_id;
        return `<option value="${esc(value)}" ${value === current ? 'selected' : ''}>${esc(item.code)} 系列专用</option>`;
      }),
    ].join('');
  };
  $('#viewSub').textContent = '特性主数据：产品特性(D) 出自图纸/规范，过程特性(P) 是工艺控制参数。适用范围区分产品族通用和产品系列专用，项目只引用同族或同系列特性。';
  const row = (c) => `<tr data-char="${c.char_id}">
    <td class="mono nowrap">${esc(c.char_id)}</td>
    <td><input data-f="name" value="${esc(c.name)}" style="width:100%;border:1px solid transparent;background:transparent"></td>
    <td style="width:180px"><input data-f="description" value="${esc(c.description || '')}" placeholder="简明定义" style="width:100%;border:1px solid transparent;background:transparent"></td>
    <td><span class="badge ${c.char_kind === 'PRODUCT' ? 'b-warn' : 'b-gray'}">${c.char_kind === 'PRODUCT' ? '产品特性' : '过程特性'}</span></td>
    <td style="width:150px"><select data-f="scope" style="width:100%;border:1px solid transparent;background:transparent">${scopeOptions(c)}</select></td>
    <td style="width:70px"><input data-f="target" value="${c.target ?? ''}" style="width:100%;border:1px solid transparent;background:transparent"></td>
    <td style="width:70px"><input data-f="unit" value="${esc(c.unit || '')}" style="width:100%;border:1px solid transparent;background:transparent"></td>
    <td style="width:70px"><input data-f="lsl" value="${c.lsl ?? ''}" style="width:100%;border:1px solid transparent;background:transparent"></td>
    <td style="width:70px"><input data-f="usl" value="${c.usl ?? ''}" style="width:100%;border:1px solid transparent;background:transparent"></td>
    <td style="width:110px"><input data-f="tol_text" value="${esc(c.tol_text || '')}" style="width:100%;border:1px solid transparent;background:transparent"></td>
    <td style="width:90px"><input data-f="special_symbol" value="${esc(c.special_symbol || '')}" placeholder="CC/SC" style="width:100%;border:1px solid transparent;background:transparent"></td>
    <td style="width:100px"><input data-f="domain" value="${esc(c.domain || '')}" placeholder="电气/尺寸" style="width:100%;border:1px solid transparent;background:transparent"></td>
    <td style="width:150px"><input data-f="source_type" list="charSourceTypesDict" value="${esc(c.source_type || '')}" placeholder="客户图纸/内部" style="width:100%;border:1px solid transparent;background:transparent"></td>
    <td style="width:150px"><input list="charSourceRefs" data-f="source_ref" value="${esc(c.source_ref || '')}" placeholder="选择或输入来源编号" style="width:100%;border:1px solid transparent;background:transparent"></td>
    <td class="nowrap" style="width:130px">
      <button class="btn sm ghost" data-save-char="${c.char_id}">存</button>
      <button class="btn sm ghost" data-del-char="${c.char_id}" style="color:#B91C1C;border-color:#F3C6C6">删</button>
    </td></tr>`;

  $('#view').innerHTML = `
    <div class="alert info" style="margin-bottom:12px"><div>
      <b>「来源类型 / 来源引用」是什么：</b>说明这个特性是<b>凭什么</b>定下来的，用于追溯与审核。
      来源类型是你选的一类依据（客户图纸、客户规范、AEC-Q200、内部试验…）；
      来源引用是那份依据的具体编号，可以直接从已有资料里挑：
      客户图纸号、国标/IEC 条款号、内部试验编号（DOE/PV）、或某份交付物（如 P1-06）、某个 ECR 编号。
      两栏都在本页直接填写，也可由 P1-11 / P2-11 交付物同步带入；留空表示来源待补充。
    </div></div>
    <div class="card">
      <div class="card-h"><h3>特性主数据</h3>
        <span class="hint">共 ${list.length} 条 · 单元格可直接编辑
          <button class="btn sm" onclick="addChar('PRODUCT')" style="margin-left:10px">＋产品特性</button>
          <button class="btn sm ghost" onclick="addChar('PROCESS')" style="margin-left:6px">＋过程特性</button>
        </span></div>
      <div style="overflow:auto">
      <table class="t" style="min-width:1650px"><thead><tr>
        <th style="width:110px">编号</th><th style="width:160px">名称</th><th style="width:180px">简明描述</th><th style="width:88px">类型</th><th style="width:150px">适用范围</th>
        <th>目标值</th><th>单位</th><th>下限</th><th>上限</th><th>公差文本</th><th>特殊特性</th><th>特性域</th>
        <th title="依据的类别：客户图纸 / 客户规范 / AEC-Q200 / 内部试验等">来源类型</th>
        <th title="依据的具体编号：图纸号、条款号、试验编号、交付物编号或 ECR 编号">来源引用</th><th>操作</th>
      </tr></thead><tbody>
        ${list.map(row).join('')}
      </tbody></table></div>
      <datalist id="charSourceRefs">${sourceList}</datalist>
      <datalist id="charSourceTypesDict">${(sources.source_types || CHAR_SOURCE_TYPES).map(type => `<option value="${esc(type)}"></option>`).join('')}</datalist>
      <div class="card-b dim" style="font-size:11.5px">
        编号由系统按类型自动生成（产品 CHR-D-xxxx / 过程 CHR-P-xxxx）。删除前需先解除 PFMEA 与 CP 中的引用。
      </div>
    </div>`;

  $$('[data-save-char]').forEach(b => b.onclick = async () => {
    const id = b.dataset.saveChar;
    const tr = document.querySelector(`[data-char="${id}"]`);
    const body = {};
    tr.querySelectorAll('[data-f]').forEach(el => {
      if (el.dataset.f === 'scope') {
        const [scopeType, scopeId] = el.value.split(':');
        if (scopeType === 'series') {
          const selectedSeries = series.find(item => item.series_id === scopeId);
          body.family_id = selectedSeries ? selectedSeries.family_id : '';
          body.series_id = scopeId;
        } else {
          body.family_id = scopeId;
          body.series_id = '';
        }
      } else {
        body[el.dataset.f] = el.value;
      }
    });
    try {
      const saved = await api('/chars/' + encodeURIComponent(id), { method: 'PATCH', body });
      toast(saved.source_warning || '已保存', saved.source_warning ? 'warn' : 'ok');
      vCharDict();
    } catch (e) { toast(e.message, 'err'); }
  });

  $$('[data-del-char]').forEach(b => {
    let armed = false;
    b.onclick = async () => {
      if (!armed) {
        armed = true; b.textContent = '确认?'; b.style.background = '#FEF2F2';
        setTimeout(() => { armed = false; b.textContent = '删'; b.style.background = ''; }, 5000);
        return;
      }
      try {
        await api('/chars/' + encodeURIComponent(b.dataset.delChar), { method: 'DELETE' });
        toast('已删除', 'ok'); vCharDict();
      } catch (e) { toast(e.message, 'err'); }
    };
  });
}

async function addChar(kind) {
  const [familiesResult, seriesResult, sources] = await Promise.all([
    api('/product-families'), api('/product-series'), api('/character-sources'),
  ]);
  const families = familiesResult.list || [];
  const series = seriesResult.list || [];
  // D-01：新增特性抽屉在自身作用域内构建来源列表，不能引用其他渲染函数的局部变量
  const sourceList = [
    ...(sources.refs || []).map(item => ({ value: item.source_ref, label: `${item.source_ref} · ${item.source_type || '未分类'}` })),
    ...(sources.docs || []).map(item => ({ value: item.code, label: `${item.code} · ${item.name || '交付物'}` })),
    ...(sources.ecr || []).map(item => ({ value: item.code, label: `${item.code} · ${item.name || '工程变更'}` })),
  ].filter((item, index, arr) => item.value && item.value !== '—'
    && arr.findIndex(x => x.value === item.value) === index)
    .map(item => `<option value="${esc(item.value)}">${esc(item.label)}</option>`).join('');
  const drawer = $('#drawer');
  $('.drawer-box', drawer).innerHTML = `
    <div class="drawer-h">
      <div><h2>新增${kind === 'PRODUCT' ? '产品' : '过程'}特性</h2><p>编号由系统自动生成</p></div>
      <button class="x" onclick="document.getElementById('drawer').classList.remove('open')">✕</button>
    </div>
    <div class="drawer-b">
      <div class="field"><label>用大白话描述这个${kind === 'PRODUCT' ? '产品' : '过程'}特性 <span style="color:#B91C1C">*</span></label>
        <textarea id="ncDraft" rows="3" placeholder="例如：激光划线后的槽深要控制在 21 微米，上下允许偏差 3 微米，太浅会掰不断，太深会伤基片"></textarea>
        <div style="display:flex;gap:8px;margin-top:7px;align-items:center">
          <button class="btn sm" id="ncAiName">AI 标准化特性名称</button>
          <span class="dim" style="font-size:11px">提取产品/过程的可测量属性，名称保持简短，不把动作写成特性。</span>
        </div>
        <div id="ncAiNote" class="dim" style="font-size:11px;margin-top:6px"></div>
      </div>
      <div class="field"><label>名称 <span style="color:#B91C1C">*</span></label><input id="ncName" placeholder="如：刻槽深度"></div>
      <div class="field"><label>简明描述</label><input id="ncDescription" placeholder="说明对象和可测量要求"></div>
      <div class="row3">
        <div class="field"><label>目标值</label><input id="ncTarget" placeholder="选填"></div>
        <div class="field"><label>单位</label><input id="ncUnit" placeholder="μm"></div>
        <div class="field"><label>下限</label><input id="ncLsl" placeholder="选填"></div>
      </div>
      <div class="row2">
        <div class="field"><label>上限</label><input id="ncUsl" placeholder="选填"></div>
        <div class="field"><label>特性域</label><input id="ncDomain" placeholder="电气 / 尺寸 / 环境"></div>
      </div>
      <div class="row3">
        <div class="field"><label>公差文本</label><input id="ncTol" placeholder="如 25±5 μm"></div>
        <div class="field"><label>特殊特性符号</label><input id="ncSym" placeholder="CC / SC / 留空"></div>
        <div class="field"><label>来源类型</label><input id="ncSourceType" list="charSourceTypes" placeholder="客户图纸 / 内部">
          <datalist id="charSourceTypes">${(sources.source_types || CHAR_SOURCE_TYPES).map(type => `<option value="${esc(type)}"></option>`).join('')}</datalist></div>
      </div>
      <div class="field"><label>适用范围</label><select id="ncScope">
        ${families.map(family => `<option value="family:${esc(family.family_id)}">${esc(family.code)} · ${esc(family.name)}（产品族通用）</option>`).join('')}
        ${series.map(item => `<option value="series:${esc(item.series_id)}">${esc(item.code)} · ${esc(item.name)}（系列专用）</option>`).join('')}
      </select></div>
      <div class="field"><label>来源引用</label><input id="ncSourceRef" list="charSourceRefs" placeholder="选择或输入图纸号 / 条款 / 试验编号"></div>
      <datalist id="charSourceRefs">${sourceList}</datalist>
      <button class="btn" id="ncSave">添加</button>
    </div>`;
  drawer.classList.add('open');
  $('#ncAiName').onclick = async () => {
    const draft = $('#ncDraft').value.trim();
    if (!draft) return toast('请先输入大白话描述', 'err');
    const note = $('#ncAiNote');
    note.textContent = '正在分析特性名称和参数…';
    try {
      const result = await api('/ai/character-name', {
        method: 'POST',
        body: { char_kind: kind, description: draft },
      });
      $('#ncName').value = result.name || '';
      $('#ncDescription').value = result.description || '';
      $('#ncUnit').value = result.unit || '';
      $('#ncTarget').value = result.target ?? '';
      $('#ncLsl').value = result.lsl ?? '';
      $('#ncUsl').value = result.usl ?? '';
      $('#ncTol').value = result.tol_text || '';
      $('#ncSym').value = result.special_symbol || '';
      $('#ncDomain').value = result.domain || '';
      note.textContent = result.note || '';
      toast(result.source === 'ai' ? 'AI 已标准化特性' : '已用本地规则生成，请复核', result.source === 'ai' ? 'ok' : 'err');
    } catch (e) {
      note.textContent = '失败：' + e.message;
    }
  };
  $('#ncSave').onclick = async () => {
    try {
      const r = await api('/chars', { method: 'POST', body: {
        name: $('#ncName').value.trim(), description: $('#ncDescription').value.trim(),
        char_kind: kind, unit: $('#ncUnit').value.trim(),
        target: $('#ncTarget').value, domain: $('#ncDomain').value.trim(),
        lsl: $('#ncLsl').value, usl: $('#ncUsl').value,
        tol_text: $('#ncTol').value.trim(), special_symbol: $('#ncSym').value.trim(),
        source_type: $('#ncSourceType').value.trim(), source_ref: $('#ncSourceRef').value.trim(),
        family_id: $('#ncScope').value.startsWith('series:')
          ? (series.find(item => item.series_id === $('#ncScope').value.slice(7)) || {}).family_id
          : $('#ncScope').value.slice(7),
        series_id: $('#ncScope').value.startsWith('series:') ? $('#ncScope').value.slice(7) : '',
      } });
      toast('已新增 ' + r.char_id, 'ok');
      drawer.classList.remove('open');
      vCharDict();
    } catch (e) { toast(e.message, 'err'); }
  };
}

function openQuickCharacter(kind, onCreated) {
  document.getElementById('quickCharModal')?.remove();
  const modal = document.createElement('div');
  modal.id = 'quickCharModal';
  modal.className = 'mini-modal-backdrop';
  modal.innerHTML = `
    <div class="mini-modal">
      <div class="drawer-h">
        <div><h2>新增${kind === 'PRODUCT' ? '产品' : '过程'}系列特性</h2>
          <p>${esc(state.meta.project.family_name || state.meta.project.family_id || '')} / ${esc(state.meta.project.series_name || state.meta.project.series_id || '')}</p></div>
        <button class="x" data-close>✕</button>
      </div>
      <div class="drawer-b">
        <div class="field"><label>用大白话描述</label>
          <textarea id="qcDraft" rows="3" placeholder="例如：划线槽深目标 21 μm，允许 ±3 μm，太浅会掰不断，太深会伤基片"></textarea></div>
        <div style="display:flex;gap:8px;align-items:center;margin-bottom:12px">
          <button class="btn sm" id="qcAi">AI 标准化</button>
          <span id="qcNote" class="dim" style="font-size:11px"></span>
        </div>
        <div class="row2">
          <div class="field"><label>特性名称 <span style="color:#B91C1C">*</span></label><input id="qcName"></div>
          <div class="field"><label>单位</label><input id="qcUnit"></div>
        </div>
        <div class="field"><label>简明描述</label><input id="qcDescription"></div>
        <div class="row3">
          <div class="field"><label>目标值</label><input id="qcTarget"></div>
          <div class="field"><label>下限</label><input id="qcLsl"></div>
          <div class="field"><label>上限</label><input id="qcUsl"></div>
        </div>
        <div class="row2">
          <div class="field"><label>公差文本</label><input id="qcTol"></div>
          <div class="field"><label>特殊特性符号</label><input id="qcSymbol" placeholder="CC / SC / SAFETY"></div>
        </div>
        <div class="alert info" style="font-size:11.5px;margin-bottom:12px">
          保存后会写入特性字典，并作为当前产品族/系列特性自动引入本项目。
        </div>
        <div style="display:flex;gap:8px">
          <button class="btn" id="qcSave">保存并选用</button>
          <button class="btn ghost" data-close>取消</button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(modal);
  const close = () => modal.remove();
  $$('[data-close]', modal).forEach(button => button.onclick = close);
  modal.onclick = event => { if (event.target === modal) close(); };
  const fillFromAi = async () => {
    const draft = $('#qcDraft', modal).value.trim();
    if (!draft) return toast('请先输入大白话描述', 'err');
    const note = $('#qcNote', modal);
    note.textContent = '正在标准化…';
    try {
      const result = await api('/ai/character-name', {
        method: 'POST', body: { char_kind: kind, description: draft },
      });
      $('#qcName', modal).value = result.name || '';
      $('#qcDescription', modal).value = result.description || '';
      $('#qcUnit', modal).value = result.unit || '';
      $('#qcTarget', modal).value = result.target ?? '';
      $('#qcLsl', modal).value = result.lsl ?? '';
      $('#qcUsl', modal).value = result.usl ?? '';
      $('#qcTol', modal).value = result.tol_text || '';
      $('#qcSymbol', modal).value = result.special_symbol || '';
      note.textContent = result.note || '';
      toast(result.source === 'ai' ? 'AI 已标准化' : '已用本地规则生成，请复核', result.source === 'ai' ? 'ok' : 'err');
    } catch (e) {
      note.textContent = '失败：' + e.message;
    }
  };
  $('#qcAi', modal).onclick = fillFromAi;
  $('#qcSave', modal).onclick = async () => {
    const name = $('#qcName', modal).value.trim();
    if (!name) return toast('特性名称不能为空', 'err');
    try {
      // D-04：一次接口在服务端事务中同时建立特性主数据与项目特性，避免半成品
      const created = await api('/chars', {
        method: 'POST',
        body: {
          name,
          description: $('#qcDescription', modal).value.trim(),
          char_kind: kind,
          unit: $('#qcUnit', modal).value.trim(),
          target: $('#qcTarget', modal).value,
          lsl: $('#qcLsl', modal).value,
          usl: $('#qcUsl', modal).value,
          tol_text: $('#qcTol', modal).value.trim(),
          special_symbol: $('#qcSymbol', modal).value.trim(),
          family_id: state.meta.project.family_id,
          series_id: state.meta.project.series_id,
          source_type: 'PFMEA 现场新增',
          source_ref: state.meta.project.project_id,
          import_project: true,
        },
      });
      toast(`已新增特性 ${created.char_id} 并引入当前项目`, 'ok');
      close();
      if (onCreated) onCreated(created.item || { char_id: created.char_id, name });
    } catch (e) {
      toast(e.message, 'err');
    }
  };
}

/* ------------------------------------------------------------------ AP 矩阵与等级规则 */
async function vApMatrix() {
  const data = await api('/ap-matrix');
  const summary = Object.fromEntries(data.summary.map(item => [item.ap, item.count]));
  const selectedS = Math.max(1, Math.min(10, Number(state.apMatrixSeverity) || 1));
  const slice = data.rows.filter(row => row.s === selectedS);
  const byD = new Map();
  slice.forEach(row => {
    if (!byD.has(row.d)) byD.set(row.d, new Map());
    byD.get(row.d).set(row.o, row.ap);
  });
  $('#viewSub').textContent = '全局 S/O/D 到 AP 判定矩阵 · FMEA 计算直接读取此规则 · 修改必须经质量批准';
  $('#view').innerHTML = `
    <div class="pfd-commandbar">
      <div><h2>AP 矩阵与等级规则</h2></div>
      <div class="fmea-mode-actions">
        <label class="ap-matrix-severity"><span>严重度 S</span><select id="apMatrixSeverity">
          ${Array.from({ length: 10 }, (_, index) => index + 1).map(value =>
            `<option value="${value}" ${value === selectedS ? 'selected' : ''}>S = ${value}</option>`).join('')}
        </select></label>
      </div>
    </div>
    <div class="grid g3 ap-matrix-summary">
      <div class="kpi bad"><div class="k">高优先级 H</div><div class="v">${summary.H || 0}</div><div class="d">需要优先采取措施</div></div>
      <div class="kpi warn"><div class="k">中优先级 M</div><div class="v">${summary.M || 0}</div><div class="d">评估措施必要性</div></div>
      <div class="kpi ok"><div class="k">低优先级 L</div><div class="v">${summary.L || 0}</div><div class="d">团队决定是否采取措施</div></div>
    </div>
    <section class="card ap-matrix-panel">
      <div class="card-h"><div><h3>严重度 S = ${selectedS} 的判定切片</h3>
        <span class="hint">列为发生度 O，行为探测度 D；单元格为系统判定的 AP 值</span></div></div>
      <div class="ap-matrix-scroll"><table class="ap-matrix-table">
        <thead><tr><th>D \\ O</th>${Array.from({ length: 10 }, (_, index) => `<th>O ${index + 1}</th>`).join('')}</tr></thead>
        <tbody>${Array.from({ length: 10 }, (_, dIndex) => {
          const d = dIndex + 1;
          return `<tr><th>D ${d}</th>${Array.from({ length: 10 }, (_, oIndex) => {
            const o = oIndex + 1;
            const ap = (byD.get(d) || new Map()).get(o) || '—';
            return `<td><button class="ap-matrix-cell ap-${String(ap).toLowerCase()}" data-ap-cell="${selectedS},${o},${d}"
              title="S=${selectedS}，O=${o}，D=${d}：AP ${ap}">${ap}</button></td>`;
          }).join('')}</tr>`;
        }).join('')}</tbody>
      </table></div>
      <div class="ap-matrix-legend"><span><i class="ap-dot h"></i>H 高</span><span><i class="ap-dot m"></i>M 中</span><span><i class="ap-dot l"></i>L 低</span></div>
      <div class="ap-matrix-foot">这是系统共享规则，变更会影响后续 FMEA 判定。现有 FMEA 记录不自动重算；请按变更管理评估已发布内容。</div>
    </section>`;
  $('#apMatrixSeverity').onchange = event => { state.apMatrixSeverity = +event.target.value; vApMatrix(); };
  const openEditor = async (s = selectedS, o = 1, d = 1) => {
    const drawer = $('#drawer');
    $('.drawer-box', drawer).innerHTML = `
      <div class="drawer-h"><div><h2>校对 AP 判定</h2><p>规则变更需质量批准，并写入项目审批记录。</p></div>
        <button class="x" aria-label="关闭" onclick="document.getElementById('drawer').classList.remove('open')">×</button></div>
      <div class="drawer-b ap-matrix-edit-form">
        <div class="alert info">S ${s} / O ${o} / D ${d}</div>
        <label><span>AP 值</span><select id="apMatrixNewValue">
          ${['H', 'M', 'L'].map(value => `<option ${value === (data.rows.find(row => row.s === s && row.o === o && row.d === d) || {}).ap ? 'selected' : ''}>${value}</option>`).join('')}
        </select></label>
        <label><span>质量批准人</span><input id="apMatrixApprover" placeholder="请输入批准人"></label>
        <label><span>变更说明</span><textarea id="apMatrixNote" rows="3" placeholder="说明变更依据"></textarea></label>
        <button class="btn" id="apMatrixSave">提交校对</button>
      </div>`;
    drawer.classList.add('open');
    $('#apMatrixSave').onclick = async event => {
      const button = event.currentTarget;
      const approvedBy = $('#apMatrixApprover').value.trim();
      if (!approvedBy) return toast('请填写质量批准人', 'err');
      button.disabled = true;
      try {
        const result = await api('/ap-matrix', { method: 'PATCH', body: {
          rows: [{ s, o, d, ap: $('#apMatrixNewValue').value }],
          approved_by: approvedBy, user: '质量工程师', note: $('#apMatrixNote').value.trim() || 'AP 矩阵校对',
        } });
        drawer.classList.remove('open');
        toast(`已更新 ${result.updated} 格 AP，并记录审批`, 'ok');
        await vApMatrix();
      } catch (error) {
        button.disabled = false;
        toast(error.message, 'err');
      }
    };
  };
  $$('[data-ap-cell]').forEach(button => button.onclick = () => {
    const [s, o, d] = button.dataset.apCell.split(',').map(Number);
    openEditor(s, o, d);
  });
}
