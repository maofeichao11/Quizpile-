/* 题库通 - 前端逻辑 */
'use strict';

const API = 'api.php';
// AI 导题库：不预置任何默认配置，仅在输入框里用「如 xxx」作示例提示
const AI_EG_BASE = '如 https://ark.cn-beijing.volces.com/api/v3';
const AI_EG_KEY = '如 ark-xxxxxxxx';
const AI_EG_MODEL = '如 deepseek-v4-1-flash-260910';
const TYPES = {
  single: '单选题', multiple: '多选题', judge: '判断题', blank: '填空题', essay: '简答题'
};

const state = {
  view: 'banks',
  user: null,        // 当前登录用户 {id, username, nickname}
  banks: [],         // 我的题库(role=owner) + 我添加的题库(role=member)
  market: [],        // 题库市场（当前页）
  marketPage: 1, marketTotal: 0, marketSize: 12,
  banksPage: 1,      // 我的题库网格分页（客户端）
  loaded: false,     // 市场数据是否已加载
  a: {},             // 管理后台数据
  bankId: -1,
  // 题库题目页
  q: { list: [], total: 0, page: 1, size: 20, type: '', keyword: '', checked: new Set() },
  // 练习
  p: { bankId: -1, mode: 'order', list: [], idx: 0, q: null, picked: [], answered: false, result: null, expected: '', expectedDisp: null, results: [], curOptions: [], optCache: {}, settings: { autoNext: false, recite: false, shuffle: false, showAnswer: true, instant: false } },
  // 考试
  e: { bankId: -1, count: 20, minutes: 30, list: [], idx: 0, answers: {}, timer: null, left: 0, result: null, shuffle: false, optCache: {}, curOptions: [], instant: false, instantRes: {} },
  csrf: '',            // CSRF token
  // 错题
  w: { list: [], bankId: -1, banks: [], types: [], loaded: false, total: 0, page: 1 },
  // 回收站
  t: { banks: [], questions: [], loaded: false },
  // 章节（当前设置里的题库章节列表）
  chapters: [],
  // 练习题筛选 & 考试组卷偏好
  pf: { state: 'all', chapter: '' },
};

/**
 * 清空所有「属于某个账号」的状态。
 * 切换账号（退出 / 登录 / 注册）时必须调用，否则会把上一个账号的
 * 设置（含 AI 配置）、题库、错题等显示给下一个账号。
 */
function resetUserState() {
  stopTimer();
  state.view = 'banks';
  state.user = null;
  state.banks = [];
  state.market = [];
  state.marketPage = 1; state.marketTotal = 0;
  state.banksPage = 1;
  state.loaded = false;
  state.a = {};
  state.bankId = -1;
  state.q = { list: [], total: 0, page: 1, size: 20, type: '', keyword: '', checked: new Set() };
  state.p = { bankId: -1, mode: 'order', list: [], idx: 0, q: null, picked: [], answered: false,
    result: null, expected: '', expectedDisp: null, results: [], curOptions: [], optCache: {},
    settings: { autoNext: false, recite: false, shuffle: false, showAnswer: true, instant: false } };
  state.e = { bankId: -1, count: 20, minutes: 30, list: [], idx: 0, answers: {}, timer: null,
    left: 0, result: null, shuffle: false, optCache: {}, curOptions: [], instant: false, instantRes: {} };
  state.w = { list: [], bankId: -1, banks: [], types: [], loaded: false, total: 0, page: 1 };
  state.t = { banks: [], questions: [], loaded: false };
  state.chapters = [];
  state.pf = { state: 'all', chapter: '' };
  state.settings = { wrong_streak: 1 };
}

/* ---------------- 工具 ---------------- */
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
/** 渲染富文本：转义后把 ![](url) 转成 <img>，并支持换行 */
function rt(s) {
  let t = esc(s);
  t = t.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (m, alt, url) => {
    const safe = /^(https?:\/\/|\.\/|uploads\/|\/)/i.test(url) ? url : '';
    if (!safe) return m;
    return '<img class="q-img" src="' + url + '" alt="' + alt + '" loading="lazy">';
  });
  return t;
}
function $(sel) { return document.querySelector(sel); }
/* 内联 SVG 图标：stroke 跟随 currentColor，跨平台渲染一致（比 emoji 可靠），且能随文字颜色变化 */
const ICONS = {
  banks:    '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5"/><path d="M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/>',
  market:   '<path d="M6 7h12l-1 13H7z"/><path d="M9 7a3 3 0 0 1 6 0"/>',
  practice: '<path d="M4 20h4L18 10l-4-4L4 16z"/><path d="M14 6l4 4"/>',
  exam:     '<rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4a3 3 0 0 1 6 0"/><path d="M9 13l2 2 4-4"/>',
  wrong:    '<circle cx="12" cy="12" r="8"/><path d="M12 8v5"/><path d="M12 16h.01"/>',
  stats:    '<path d="M5 20V10M10 20V4M15 20v-7M20 20v-11"/>',
  trash:    '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
  settings: '<circle cx="12" cy="12" r="3.2"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1"/>',
  admin:    '<path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z"/>',
  plus:     '<path d="M12 5v14M5 12h14"/>',
  check:    '<circle cx="12" cy="12" r="8"/><path d="M8 12l3 3 5-6"/>',
  x:        '<circle cx="12" cy="12" r="8"/><path d="M9 9l6 6M15 9l-6 6"/>',
  warn:     '<path d="M12 4l9 16H3z"/><path d="M12 10v4M12 17h.01"/>',
  lock:     '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  sparkle:  '<path d="M12 4l1.6 4.4L18 10l-4.4 1.6L12 16l-1.6-4.4L6 10l4.4-1.6z"/>',
  book:     '<path d="M12 6c-2-1.5-5-1.5-7 0v12c2-1.5 5-1.5 7 0 2-1.5 5-1.5 7 0V6c-2-1.5-5-1.5-7 0z"/><path d="M12 6v12"/>',
  cart:     '<path d="M6 7h12l-1 13H7z"/><path d="M9 7a3 3 0 0 1 6 0"/>',
  pen:      '<path d="M4 20h4L18 10l-4-4L4 16z"/><path d="M14 6l4 4"/>',
  trophy:   '<path d="M8 4h8v4a4 4 0 0 1-8 0z"/><path d="M8 5H5v2a3 3 0 0 0 3 3M16 5h3v2a3 3 0 0 1-3 3M10 12v4M14 12v4M9 20h6"/>',
  sun:      '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon:     '<path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z"/>'
};
function icon(name, size) {
  return '<svg class="ico" viewBox="0 0 24 24" width="' + (size || 18) + '" height="' + (size || 18) +
    '" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    (ICONS[name] || '') + '</svg>';
}
function loadingHTML(text) {
  return '<div class="card"><div class="loading"><span class="spinner"></span>' + (text || '加载中…') + '</div></div>';
}
function loadingSmHTML(text) {
  return '<div class="loading loading--sm"><span class="spinner"></span>' + (text || '加载中…') + '</div>';
}
function toast(msg, type) {
  const t = $('#toast');
  t.className = 'toast' + (type ? ' toast--' + type : '');
  const ico = t.querySelector('.toast-ico');
  const m = t.querySelector('.toast-msg');
  if (ico) ico.innerHTML = type ? icon(type === 'success' ? 'check' : type === 'error' ? 'x' : 'warn', 16) : '';
  if (m) m.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._t);
  t._t = setTimeout(() => t.classList.remove('show'), 2000);
}
toast.success = (m) => toast(m, 'success');
toast.error = (m) => toast(m, 'error');
toast.warn = (m) => toast(m, 'warn');

/** 主题切换：浅色为默认，存到 localStorage，靠 html[data-theme] 切换；
 *  不再自动跟随系统深色，避免手机系统开了深色就被强制变暗且无法切回 */
function applyThemeIcon() {
  const dark = document.documentElement.dataset.theme === 'dark';
  document.querySelectorAll('.theme-toggle').forEach(btn => {
    btn.innerHTML = icon(dark ? 'sun' : 'moon', 18) +
      '<span class="theme-toggle__label">' + (dark ? '浅色' : '深色') + '</span>';
    btn.title = dark ? '切换到浅色' : '切换到深色';
  });
}
function toggleTheme() {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem('qv-theme', next); } catch (e) {}
  applyThemeIcon();
}
/** 重新向服务端要一个 CSRF token（登录后会话 ID 会重建，需要刷新） */
async function refreshCsrf() {
  try {
    const r = await fetch(API + '?action=me', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
      credentials: 'same-origin'
    });
    const j = await r.json();
    if (j.ok && j.data && j.data.csrf) {
      state.csrf = j.data.csrf;
      // me 接口同时带回当前用户与其设置：顺手同步，避免切换账号后残留上一个账号的设置
      if (j.data.id) {
        state.user = j.data;
        if (j.data.settings) state.settings = j.data.settings;
      }
      return true;
    }
  } catch (e) { /* 忽略，交给调用方处理 */ }
  return false;
}

async function api(action, data) {
  return apiRequest(action, data, 0);
}

async function apiRequest(action, data, retried) {
  const headers = { 'Content-Type': 'application/json' };
  if (state.csrf) headers['X-CSRF-Token'] = state.csrf;
  const r = await fetch(API + '?action=' + action, {
    method: 'POST',
    headers,
    body: JSON.stringify(data || {}),
    credentials: 'same-origin'
  });
  let j;
  const raw = await r.text();
  try {
    j = JSON.parse(raw);
  } catch (e) {
    // 服务器返回了 HTML 错误页（多为单次请求过久被中断）——给出可读提示而不是 "Unexpected token '<'"
    const isHtml = /^\s*<(!doctype|html|br|\?xml)/i.test(raw);
    const msg = isHtml
      ? '服务器返回了异常页面（HTTP ' + r.status + '）：多半是这次请求耗时过久被中断，请重试，或把内容拆小一些再解析'
      : '服务器返回异常（HTTP ' + r.status + '）';
    toast(msg);
    throw new Error(msg);
  }

  // CSRF 失效（常见于登录后会话 ID 重建）：刷新 token 后自动重试一次
  if (!j.ok && retried === 0 && /CSRF|校验失败/.test(j.error || '')) {
    if (await refreshCsrf()) return apiRequest(action, data, 1);
  }
  if (!j.ok) { toast(j.error || '请求失败'); throw new Error(j.error || 'error'); }
  return j.data;
}
function fmtTime(sec) {
  const m = Math.floor(sec / 60), s = sec % 60;
  return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
}

/* ---------------- 弹窗 ---------------- */
function modal(title, bodyHtml, footHtml) {
  $('#modal-root').innerHTML =
    '<div class="mask"><div class="modal">' +
    '<div class="modal-head"><span>' + title + '</span><span class="spacer"></span>' +
    '<button class="btn btn-sm" data-close>关闭</button></div>' +
    '<div class="modal-body">' + bodyHtml + '</div>' +
    '<div class="modal-foot">' + (footHtml || '<button class="btn" data-close>取消</button>') + '</div>' +
    '</div></div>';
}
function closeModal() { $('#modal-root').innerHTML = ''; }
function confirmBox(title, text, onOk) {
  modal(title, '<div style="white-space:pre-wrap">' + esc(text) + '</div>',
    '<button class="btn" data-close>取消</button><button class="btn btn-danger" id="cf-ok">确定</button>');
  $('#cf-ok').onclick = () => { closeModal(); onOk(); };
}

/* ---------------- 路由 ---------------- */
document.addEventListener('click', e => {
  const nav = e.target.closest('[data-nav]');
  if (nav) {
    if (window.__closeDrawer) window.__closeDrawer();
    switchView(nav.dataset.nav);
    return;
  }
  const cl = e.target.closest('[data-close]');
  if (cl) { closeModal(); }
});
document.addEventListener('click', e => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const act = el.dataset.act, id = el.dataset.id ? +el.dataset.id : null;
  ACTIONS[act] && ACTIONS[act](id, el);
});

/** 当前题库是否由本人上传（可编辑） */
function bankEditable(bankId) {
  if (state.user && state.user.is_admin) return true;   // 管理员可管理所有题库
  const b = state.banks.find(x => +x.id === +bankId);   // 宽松比较：避免字符串/数字 id 失配
  return !!b && b.role === 'owner';
}

/** 移动端抽屉菜单 */
function initDrawer() {
  const btn = $('#menu-toggle');
  const side = $('#sidebar');
  const back = $('#nav-backdrop');
  if (!btn || !side || !back) return;

  const close = () => {
    side.classList.remove('open');
    back.classList.remove('show');
  };
  btn.onclick = () => {
    const open = !side.classList.contains('open');
    side.classList.toggle('open', open);
    back.classList.toggle('show', open);
  };
  back.onclick = close;
  // 点击菜单项后自动关闭
  side.addEventListener('click', e => {
    if (e.target.closest('[data-nav]')) close();
  });
  window.__closeDrawer = close;

  // 切换回桌面尺寸时复位
  window.addEventListener('resize', () => {
    if (window.innerWidth > 860) close();
  });
}

function renderUserBox() {
  const box = $('#user-box');
  const navAdmin = $('#nav-admin');
  const topUser = $('#topbar-user');
  if (topUser) {
    topUser.textContent = state.user ? (state.user.nickname || state.user.username) : '';
  }
  if (navAdmin) navAdmin.style.display = (state.user && state.user.is_admin) ? '' : 'none';
  if (!box) return;
  if (!state.user) {
    box.innerHTML = '';
    return;
  }
  box.innerHTML = '<div class="user-name">' + esc(state.user.nickname || state.user.username) + '</div>' +
    '<button class="btn btn-sm btn-block mt-2" data-act="logout">退出登录</button>';
}

function renderAuth() {
  const el = $('#view');
  el.innerHTML = '<div class="auth-wrap"><div class="card auth-card">' +
    '<div class="auth-brand"><div class="logo-mark">QV</div>' +
    '<div><h2 style="margin:0;font-size:20px">Quizpile</h2>' +
    '<div class="page-sub">智能题库 · 刷题 · 组卷</div></div></div>' +
    '<div class="page-sub mb-2">登录后管理自己的题库、刷题和考试</div>' +
    '<div class="auth-tabs"><div class="auth-tab active" data-authtab="login">登录</div>' +
    '<div class="auth-tab" data-authtab="register">注册</div></div>' +
    '<div class="field"><label>用户名</label><input class="input" id="au-name" autocomplete="username"></div>' +
    '<div class="field"><label>密码</label><input class="input" id="au-pass" type="password" autocomplete="current-password"></div>' +
    '<div class="field" id="au-nick-field" style="display:none"><label>昵称（可选）</label><input class="input" id="au-nick"></div>' +
    '<button class="btn btn-primary btn-block" id="au-submit">登录</button>' +
    '</div></div>';
  bindAuth();
}

function bindAuth() {
  let mode = 'login';
  const tabs = document.querySelectorAll('[data-authtab]');
  tabs.forEach(t => {
    t.onclick = () => {
      mode = t.dataset.authtab;
      tabs.forEach(x => x.classList.toggle('active', x === t));
      $('#au-submit').textContent = mode === 'login' ? '登录' : '注册';
      $('#au-nick-field').style.display = mode === 'register' ? '' : 'none';
      $('#au-pass').setAttribute('autocomplete', mode === 'login' ? 'current-password' : 'new-password');
    };
  });
  $('#au-submit').onclick = async () => {
    const name = $('#au-name').value.trim();
    const pass = $('#au-pass').value;
    if (!name || !pass) return toast('请输入用户名和密码');
    try {
      let res;
      if (mode === 'login') {
        res = await api('login', { username: name, password: pass });
      } else {
        res = await api('register', { username: name, password: pass, nickname: ($('#au-nick') || {}).value || '' });
      }
      // 登录成功：先清空上一个账号的全部残留状态，再装载新账号
      resetUserState();
      state.user = res;
      await refreshCsrf();          // 登录后会话 ID 会重建，取回最新 token（同时同步 user/settings）
      toast((mode === 'login' ? '欢迎回来，' : '注册成功，') + (res.nickname || res.username));
      await loadBanks();
      render();
      renderUserBox();
    } catch (e) { /* api 内已提示 */ }
  };
  const passEl = $('#au-pass');
  if (passEl) passEl.onkeydown = (e) => { if (e.key === 'Enter') $('#au-submit').click(); };
}

async function switchView(v) {
  if (!state.user) { toast('请先登录'); return; }
  stopTimer();
  state.view = v;
  document.querySelectorAll('[data-nav]').forEach(n => n.classList.toggle('active', n.dataset.nav === v));
  await loadBanks();
  render();
  await loadViewData();
}

async function loadViewData() {
  const v = state.view;
  if (v === 'stats') await loadStats();
  if (v === 'exam') await loadExamHistory();
  if (v === 'wrong') await loadWrong();
  if (v === 'market') await loadMarket();
  if (v === 'admin') await loadAdmin();
  if (v === 'trash') await loadTrash();
}

async function loadMarket() {
  const d = await api('market_list', { page: state.marketPage, page_size: 12 });
  state.market = d.list || [];
  state.marketTotal = d.total || 0;
  state.marketPage = d.page || 1;
  state.marketSize = d.size || 12;
  state.loaded = true;
  render();
}

/* ---------------- 管理后台（管理员） ---------------- */
function viewAdmin() {
  if (!state.a || !state.a.users) {
    return '<div class="page-head"><div><h2 class="page-title">管理后台</h2></div></div>' +
      loadingHTML();
  }
  const bankTotal = state.a.bankTotal || (state.a.banks || []).length;
  let h = '<div class="page-head"><div><h2 class="page-title">管理后台</h2>' +
    '<div class="page-sub">共 ' + state.a.users.length + ' 个用户，' + bankTotal + ' 个题库</div></div>' +
    '<div><button class="btn" data-act="admin-reload">刷新</button></div></div>';

  h += '<div class="card"><div class="card-title">用户列表</div>' +
    '<table class="tbl"><tr><th>ID</th><th>用户名</th><th>昵称</th><th>题库</th><th>题目</th><th>答题</th><th>考试</th><th>注册时间</th><th>操作</th></tr>';
  state.a.users.forEach(u => {
    h += '<tr><td>' + u.id + '</td><td>' + esc(u.username) +
      (u.is_admin == 1 ? ' <span class="tag tag-orange">管理员</span>' : '') + '</td>' +
      '<td>' + esc(u.nickname || '-') + '</td>' +
      '<td>' + u.bank_count + '</td><td>' + u.question_count + '</td><td>' + u.record_count + '</td><td>' + u.exam_count + '</td>' +
      '<td>' + esc((u.created_at || '').slice(0, 16)) + '</td>' +
      '<td><button class="btn btn-sm" data-act="admin-user-banks" data-id="' + u.id + '">查看题库</button> ' +
      '<button class="btn btn-sm" data-act="admin-user-pass" data-id="' + u.id + '">改密码</button> ' +
      (u.is_admin == 1 ? '' : '<button class="btn btn-sm btn-danger" data-act="admin-user-del" data-id="' + u.id + '">删除</button>') +
      '</td></tr>';
  });
  h += '</table></div>';

  h += '<div class="card"><div class="card-title">全部题库（可打开管理）</div>' +
    '<table class="tbl"><tr><th>ID</th><th>题库名</th><th>归属</th><th>题数</th><th>状态</th><th>操作</th></tr>';
  (state.a.banks || []).forEach(b => {
    h += '<tr><td>' + b.id + '</td><td>' + esc(b.name) + '</td>' +
      '<td>' + esc(b.owner_name || b.owner_username || '-') + '</td>' +
      '<td>' + b.qcount + '</td>' +
      '<td>' + (b.is_public == 1 ? '<span class="tag tag-green">已公开</span>' : '<span class="tag">私有</span>') +
      (b.share_password ? ' <span class="tag tag-orange">' + icon('lock', 14) + '</span>' : '') + '</td>' +
      '<td><button class="btn btn-sm" data-act="admin-bank-open" data-id="' + b.id + '">打开</button> ' +
      '<button class="btn btn-sm" data-act="admin-bank-publish" data-id="' + b.id + '">分享设置</button> ' +
      '<button class="btn btn-sm btn-danger" data-act="admin-bank-del" data-id="' + b.id + '">删除</button></td></tr>';
  });
  h += '</table>' + pagerBar(bankTotal, state.a.bankPage || 1, state.a.bankSize || 20, 'admin-bank-page') + '</div>';
  return h;
}

/* ---------------- 设置 ---------------- */
function viewSettings() {
  const s = state.settings || { wrong_streak: 1 };
  let h = '<div class="page-head"><div><h2 class="page-title">设置</h2>' +
    '<div class="page-sub">错题强化规则与账号安全</div></div></div>';

  h += '<div class="card"><div class="card-title">错题强化</div>' +
    '<div class="field"><label>连续答对几次才移出错题本（1-10）</label>' +
    '<div class="toolbar toolbar--flush">' +
    '<input class="input w-120" type="number" id="st-streak" min="1" max="10" value="' + s.wrong_streak + '">' +
    '<button class="btn btn-primary" data-act="st-save">保存</button>' +
    '</div></div>' +
    '<div class="note">设为 1 = 答对一次就移出（默认）；设为 3 = 要连续答对 3 次才移出，适合强化薄弱环节。</div>' +
    '</div>';

  const keySet = !!s.ai_key_set;
  const baseSet = !!s.ai_base, modelSet = !!s.ai_model;
  h += '<div class="card"><div class="card-title">AI 导题库配置</div>' +
    '<div class="ai-hint mb-3">' +
    '用于把 Word / Excel / PPT / 文本等格式不统一的题库交给大模型解析后导入。需自己填写 OpenAI 兼容的接口地址、API Key 与模型名（<b>没有内置默认值</b>）。<br>' +
    '每个账号<b>各自独立配置、互不可见</b>；Key 只写入你自己的账号，接口不会回显原文。</div>' +
    '<div class="form-grid">' +
    '<div class="field field-full"><label>接口地址（Base URL）</label>' +
    '<input class="input" id="ai-base" value="' + esc(s.ai_base || '') + '" placeholder="' + AI_EG_BASE + '"></div>' +
    '<div class="field"><label>API Key</label>' +
    '<input class="input" id="ai-key" type="password" value="" autocomplete="new-password" placeholder="' +
    (keySet ? '已配置，留空表示不修改' : AI_EG_KEY) + '"></div>' +
    '<div class="field"><label>模型名</label>' +
    '<input class="input" id="ai-model" value="' + esc(s.ai_model || '') + '" placeholder="' + AI_EG_MODEL + '"></div>' +
    '<div class="field-full"><div class="ai-hint">当前状态：接口地址 <b class="' + (baseSet ? 'c-green' : 'c-orange') + '">' +
    (baseSet ? '已填' : '未填') + '</b>　|　模型名 <b class="' + (modelSet ? 'c-green' : 'c-orange') + '">' +
    (modelSet ? '已填' : '未填') + '</b>　|　API Key <b class="' + (keySet ? 'c-green' : 'c-orange') + '">' +
    (keySet ? '已配置' : '未配置') + '</b>' +
    (keySet ? '（留空保存 = 保持原 Key 不变；出于安全考虑不再回显原文）' : '') + '</div></div>' +
    '<div class="field-full"><div class="toolbar toolbar--flush">' +
    '<button class="btn btn-primary" data-act="ai-save">保存配置</button> ' +
    '<button class="btn" data-act="ai-test">测试连接</button>' +
    (keySet ? ' <button class="btn btn-sm btn-danger" data-act="ai-clear-key">清除 Key</button>' : '') +
    '</div>' +
    '<div class="note" id="ai-test-msg"></div></div>' +
    '</div></div>';

  h += '<div class="card"><div class="card-title">修改我的密码</div><div class="form-grid">' +
    '<div class="field"><label>原密码</label><input class="input" id="sp-old" type="password"></div>' +
    '<div class="field"><label>新密码（至少 6 位）</label><input class="input" id="sp-new" type="password"></div>' +
    '<div class="field-full"><button class="btn btn-primary" data-act="st-pass">修改密码</button></div>' +
    '</div></div>';
  return h;
}

/* ---------------- 回收站 ---------------- */
function viewTrash() {
  if (!state.t.loaded) {
    return '<div class="page-head"><div><h2 class="page-title">回收站</h2></div></div>' +
      loadingHTML();
  }
  const b = state.t.banks || [];
  const q = state.t.questions || [];
  let h = '<div class="page-head"><div><h2 class="page-title">回收站</h2>' +
    '<div class="page-sub">删除的题库和题目会先到这里，可恢复或彻底删除</div></div>' +
    '<div><button class="btn" data-act="trash-reload">刷新</button></div></div>';

  h += '<div class="card"><div class="card-title">已删除的题库（' + b.length + '）</div>';
  if (!b.length) {
    h += '<div class="empty empty--sm">暂无</div>';
  } else {
    h += '<table class="tbl"><tr><th>题库</th><th>题数</th><th>删除时间</th><th>操作</th></tr>';
    b.forEach(x => {
      h += '<tr><td>' + esc(x.name) + '</td><td>' + x.qcount + '</td><td>' + esc((x.deleted_at || '').slice(0, 16)) + '</td>' +
        '<td><button class="btn btn-sm btn-primary" data-act="trash-restore" data-id="' + x.id + '">恢复</button> ' +
        '<button class="btn btn-sm btn-danger" data-act="trash-purge" data-id="' + x.id + '">彻底删除</button></td></tr>';
    });
    h += '</table>';
  }
  h += '</div>';

  h += '<div class="card"><div class="card-title">已删除的题目（' + (state.t.qTotal || q.length) + '）</div>';
  if (!q.length) {
    h += '<div class="empty empty--sm">暂无</div>';
  } else {
    h += '<table class="tbl"><tr><th>ID</th><th>所属题库</th><th>题型</th><th>题干</th><th>删除时间</th><th>操作</th></tr>';
    q.forEach(x => {
      h += '<tr><td>' + x.id + '</td><td>' + esc(x.bank_name || '-') + '</td><td>' + TYPES[x.type] + '</td>' +
        '<td>' + esc((x.stem || '').slice(0, 60)) + '</td><td>' + esc((x.deleted_at || '').slice(0, 16)) + '</td>' +
        '<td><button class="btn btn-sm btn-primary" data-act="trash-restore-q" data-id="' + x.id + '">恢复</button> ' +
        '<button class="btn btn-sm btn-danger" data-act="trash-purge-q" data-id="' + x.id + '">彻底删除</button></td></tr>';
    });
    h += '</table>' + pagerBar(state.t.qTotal || 0, state.t.qPage || 1, state.t.qSize || 30, 'trash-q-page');
  }
  h += '</div>';
  return h;
}

async function loadTrash() {
  const d = await api('trash_list', { page: state.t.qPage || 1, page_size: 30 });
  state.t.banks = d.banks || [];
  state.t.questions = d.questions || [];
  state.t.qTotal = d.q_total || 0;
  state.t.qPage = d.q_page || 1;
  state.t.qSize = d.q_size || 30;
  state.t.loaded = true;
  render();
}

async function loadAdmin() {
  const users = await api('admin_users');
  const b = await api('admin_banks', { page: state.a.bankPage || 1, page_size: 20 });
  state.a = {
    users,
    banks: b.list || [],
    bankTotal: b.total || 0,
    bankPage: b.page || 1,
    bankSize: b.size || 20
  };
  render();
}

async function loadBanks() {
  state.banks = await api('banks_list');
  const c = $('#cnt-banks');
  if (c) c.textContent = state.banks.length;
}

function render() {
  const v = state.view;
  const el = $('#view');
  if (v === 'banks') el.innerHTML = viewBanks();
  else if (v === 'market') el.innerHTML = viewMarket();
  else if (v === 'admin') el.innerHTML = viewAdmin();
  else if (v === 'settings') el.innerHTML = viewSettings();
  else if (v === 'trash') el.innerHTML = viewTrash();
  else if (v === 'questions') el.innerHTML = viewQuestions();
  else if (v === 'practice') el.innerHTML = viewPractice();
  else if (v === 'exam') el.innerHTML = viewExam();
  else if (v === 'wrong') el.innerHTML = viewWrong();
  else if (v === 'stats') el.innerHTML = loadingHTML();
  // 设置页需要加载各题型数量
  if ((v === 'practice' && !(state.p.list.length && state.p.q)) ||
      (v === 'exam' && !state.e.result && !(state.e.list.length))) {
    refreshTypeCounts();
  }
}

/* ---------------- 题库列表 ---------------- */
function viewBanks() {
  const mine  = state.banks.filter(b => b.role === 'owner');
  const added = state.banks.filter(b => b.role === 'member');
  const total = mine.reduce((a, b) => a + b.qcount, 0);

  let h = '<div class="page-head"><div><h2 class="page-title">题库管理</h2>' +
    '<div class="page-sub">我的题库 ' + mine.length + ' 个（共 ' + total + ' 道题），从市场添加 ' + added.length + ' 个</div></div>' +
    '<div><button class="btn btn-primary" data-act="bank-new">+ 新建题库</button></div></div>';

  // 题库网格分页（客户端，每页 12 个）
  const perPage = 12;
  const allMine = mine.slice();
  const mp = Math.max(1, Math.ceil(allMine.length / perPage));
  if (state.banksPage > mp) state.banksPage = mp;
  const mineShow = allMine.slice((state.banksPage - 1) * perPage, state.banksPage * perPage);

  h += '<div class="group-title">我的题库</div>';
  if (!mine.length) {
    h += '<div class="card"><div class="empty"><div class="big">' + icon('book', 40) + '</div>' +
      '<div>还没有自己的题库</div>' +
      '<div class="cta-row"><button class="btn btn-primary" data-act="bank-new">' + icon('plus', 16) + ' 新建题库</button>' +
      '<button class="btn" data-nav="market">去题库市场逛逛</button></div></div>';
  } else {
    h += '<div class="bank-grid">' + mineShow.map(b => bankCardHtml(b, true)).join('') + '</div>';
    h += pagerBar(allMine.length, state.banksPage, perPage, 'banks-page');
  }

  if (added.length) {
    h += '<div class="group-title">我添加的题库（来自市场，只读）</div>';
    h += '<div class="bank-grid">' + added.map(b => bankCardHtml(b, false)).join('') + '</div>';
  }
  return h;
}

function bankCardHtml(b, isOwner) {
  let h = '<div class="bank-card" data-act="bank-open" data-id="' + b.id + '">' +
    '<h4>' + esc(b.name) +
    (b.is_public == 1 ? ' <span class="tag tag-green">已公开</span>' : '') +
    (b.share_password ? ' <span class="tag tag-orange">' + icon('lock', 14) + '</span>' : '') +
    '</h4>' +
    '<p>' + esc(b.description || (isOwner ? '暂无描述' : ('来自 ' + (b.owner_name || '其他用户')))) + '</p>' +
    '<div class="foot"><span class="nowrap"><b>' + b.qcount + '</b> 题</span><span class="nowrap" style="gap:4px">';
  if (isOwner) {
    h += '<button class="btn btn-sm" data-act="bank-edit" data-id="' + b.id + '">编辑</button> ' +
      '<button class="btn btn-sm" data-act="bank-publish" data-id="' + b.id + '">' + (b.is_public == 1 ? '分享设置' : '发布') + '</button>';
  } else {
    h += '<span class="tag">' + esc(b.owner_name || '他人') + ' 上传</span> ' +
      '<button class="btn btn-sm btn-danger" data-act="bank-remove-mine" data-id="' + b.id + '">移除</button>';
  }
  h += '</span></div>' +
    '<div class="bank-date">' + esc((b.created_at || '').slice(0, 10)) + '</div></div>';
  return h;
}

function viewMarket() {
  let h = '<div class="page-head"><div><h2 class="page-title">题库市场</h2>' +
    '<div class="page-sub">添加别人发布的题库来练习；题库的编辑权限仍归原上传者所有</div></div>' +
    '<div><button class="btn" data-act="market-reload">刷新</button></div></div>';
  if (!state.loaded) {
    h += loadingHTML();
    return h;
  }
  if (!state.market.length) {
    h += '<div class="card"><div class="empty"><div class="big">' + icon('cart', 40) + '</div>还没有其他用户发布题库</div></div>';
    return h;
  }
  h += '<div class="bank-grid">';
  state.market.forEach(b => {
    h += '<div class="bank-card">' +
      '<h4>' + esc(b.name) +
      (b.has_password ? ' <span class="tag tag-orange">' + icon('lock', 14) + ' 密码</span>' : ' <span class="tag tag-green">公开</span>') +
      '</h4>' +
      '<p>' + esc(b.share_desc || b.description || '暂无简介') + '</p>' +
      '<div class="foot"><span>' + b.qcount + ' 题</span>' +
      '<span>' + (b.added
        ? '<span class="tag tag-blue">已添加</span>'
        : '<button class="btn btn-sm btn-primary" data-act="market-add" data-id="' + b.id + '">添加</button>') +
      '</span></div>' +
      '<div class="note mt-2">上传者：' + esc(b.owner_name || '未知') +
      '　' + esc((b.shared_at || b.created_at || '').slice(0, 10)) + '</div>' +
      '</div>';
  });
  h += '</div>';
  h += pagerBar(state.marketTotal, state.marketPage, state.marketSize, 'market-page');
  return h;
}

/* ---------------- 题目管理 ---------------- */
function viewQuestions() {
  const b = state.banks.find(x => +x.id === +state.bankId) || { name: '题库', id: state.bankId, role: 'member' };
  const canEdit = bankEditable(state.bankId);
  let h = '<div class="page-head"><div><h2 class="page-title">' + esc(b.name) +
    (canEdit ? '' : ' <span class="tag">只读</span>') + '</h2>' +
    '<div class="page-sub">共 ' + state.q.total + ' 道题' +
    (canEdit ? '' : '　（' + esc(b.owner_name || '他人') + ' 上传的题库，仅可查看和练习）') + '</div></div>' +
    '<div><button class="btn" data-act="q-back">← 返回题库</button> ' +
    (canEdit ? '<button class="btn btn-primary" data-act="q-new">+ 新增题目</button> ' +
      '<button class="btn" data-act="import-open">批量导入</button> ' +
      '<button class="btn ai-btn" data-act="ai-import-open">' + icon('sparkle', 16) + ' AI 导入</button> ' : '') +
    '<button class="btn" data-act="export-open">导出</button></div></div>';

  h += '<div class="card"><div class="toolbar">' +
    '<input class="input" id="f-kw" placeholder="搜索题干/标签" value="' + esc(state.q.keyword) + '">' +
    '<select class="select" id="f-type"><option value="">全部题型</option>' +
    Object.keys(TYPES).map(k => '<option value="' + k + '"' + (state.q.type === k ? ' selected' : '') + '>' + TYPES[k] + '</option>').join('') +
    '</select>' +
    '<button class="btn" data-act="q-search">搜索</button>' +
    '<span class="spacer"></span>' +
    (canEdit ? '<button class="btn btn-sm btn-danger" data-act="q-del-checked">删除选中</button>' : '') +
    '</div><div id="q-list">' + questionListHtml(canEdit) + '</div>' + pagerHtml() + '</div>';
  return h;
}

function questionListHtml(canEdit) {
  if (!state.q.list.length) {
    return '<div class="empty"><div class="big">' + icon('pen', 40) + '</div>' +
      '<div>这个题库还没有题目</div>' +
      (canEdit ? '<div class="cta-row"><button class="btn btn-primary" data-act="q-new">' + icon('plus', 16) + ' 添加题目</button>' +
      '<button class="btn ai-btn" data-act="ai-import-open">' + icon('sparkle', 16) + ' AI 导入</button>' +
      '<button class="btn" data-act="import-open">批量导入</button></div>' : '') +
      '</div>';
  }
  return state.q.list.map(q => {
    const ans = Array.isArray(q.answer) ? q.answer.join('') : q.answer;
    let h = '<div class="q-item"><div class="q-head">' +
      (canEdit ? '<input type="checkbox" data-check="' + q.id + '"' + (state.q.checked.has(q.id) ? ' checked' : '') + '>' : '') +
      '<div class="q-stem"><span class="tag tag-blue">' + TYPES[q.type] + '</span> ' + rt(q.stem) + '</div>' +
      (canEdit ? '<button class="btn btn-sm" data-act="q-edit" data-id="' + q.id + '">编辑</button> ' +
        '<button class="btn btn-sm btn-danger" data-act="q-del" data-id="' + q.id + '">删除</button>' : '') + '</div>';
    (q.options || []).forEach(o => {
      h += '<div class="q-opt' + (ans.indexOf(o.key) >= 0 ? ' correct' : '') + '">' + esc(o.key) + '. ' + rt(o.text) + '</div>';
    });
    if (q.type === 'blank' || q.type === 'essay') {
      h += '<div class="q-opt correct">参考答案：' + esc((q.answer || []).join(' / ')) + '</div>';
    }
    h += '<div class="q-meta"><span>正确答案：<b>' + esc(ans) + '</b></span>';
    if (q.tags) h += '<span class="tag">' + esc(q.tags) + '</span>';
    h += '</div>';
    if (q.analysis) h += '<div class="q-analysis">解析：' + rt(q.analysis) + '</div>';
    h += '</div>';
    return h;
  }).join('');
}

function pagerHtml() {
  if (state.q.total <= state.q.size) {
    return '<div class="pagination"><span class="tag">共 ' + state.q.total + ' 道</span></div>';
  }
  return pagerBar(state.q.total, state.q.page, state.q.size, 'q-page');
}

async function loadQuestions() {
  const d = await api('question_list', {
    bank_id: state.bankId, type: state.q.type, keyword: state.q.keyword,
    page: state.q.page, page_size: state.q.size
  });
  state.q.list = d.list; state.q.total = d.total;
  render();
}

/* ---------------- 题目编辑 ---------------- */
function editorHtml(q) {
  q = q || { type: 'single', stem: '', options: [{ key: 'A', text: '' }, { key: 'B', text: '' }], answer: [], analysis: '', tags: '', bank_id: state.bankId };
  const needOpt = q.type === 'single' || q.type === 'multiple';
  let h = '<input type="hidden" id="e-id" value="' + (q.id || '') + '">' +
    '<div class="row2"><div class="field"><label>所属题库</label><select class="select" id="e-bank">' +
    state.banks.map(b => '<option value="' + b.id + '"' + ((q.bank_id || state.bankId) === b.id ? ' selected' : '') + '>' + esc(b.name) + '</option>').join('') +
    '</select></div>' +
    '<div class="field"><label>题型</label><select class="select" id="e-type">' +
    Object.keys(TYPES).map(k => '<option value="' + k + '"' + (q.type === k ? ' selected' : '') + '>' + TYPES[k] + '</option>').join('') +
    '</select></div></div>' +
    '<div class="field"><label>题干</label><textarea class="input" id="e-stem" placeholder="请输入题干">' + esc(q.stem) + '</textarea></div>' +
    '<div id="e-opt-area"' + (needOpt ? '' : ' style="display:none"') + '>' +
    '<label class="note">选项</label><div id="e-opts">' +
    (q.options || []).map(o => optRow(o.key, o.text)).join('') +
    '</div><button class="btn btn-sm mb-3" id="e-add-opt">+ 添加选项</button></div>' +
    '<div class="field"><label>' + (q.type === 'blank' || q.type === 'essay' ? '参考答案（多个空用 | 分隔）' : '正确答案') + '</label>' +
    '<input class="input" id="e-answer" value="' + esc(Array.isArray(q.answer) ? q.answer.join(q.type === 'blank' || q.type === 'essay' ? '|' : '') : q.answer) + '">' +
    '<div class="note mt-1" id="e-answer-tip"></div></div>' +
    '<div class="field"><label>解析（可选）</label><textarea class="input" id="e-analysis">' + esc(q.analysis || '') + '</textarea></div>' +
    '<div class="field"><label>标签（可选，逗号分隔）</label><input class="input" id="e-tags" value="' + esc(q.tags || '') + '"></div>' +
    '<div class="field"><label>插入图片（题干、解析、选项都支持图片）</label>' +
    '<div class="toolbar mb-1">' +
    '<input type="file" class="input w-220" id="e-img-file" accept="image/*">' +
    '<button class="btn btn-sm btn-primary" id="e-img-up">上传并插入</button>' +
    '</div>' +
    '<div class="toolbar toolbar--flush">' +
    '<input class="input" id="e-img-url" placeholder="或填写图片外链 http://..." style="min-width:200px">' +
    '<button class="btn btn-sm" id="e-img-insert">插入链接</button>' +
    '</div>' +
    '<div class="note mt-2">' +
    '用法：先点一下要插入的输入框（题干/选项/解析），再点「上传并插入」，图片会插到光标处。单个文件不超过 5MB。</div>' +
    '</div>';
  return h;
}
function optRow(k, t) {
  return '<div class="opt-row"><input class="input key-in" value="' + esc(k) + '" data-opt-key>' +
    '<input class="input" value="' + esc(t || '') + '" data-opt-text placeholder="选项内容">' +
    '<button class="btn btn-sm" data-del-opt>删除</button></div>';
}

function bindEditor() {
  const typeSel = $('#e-type');
  typeSel.onchange = () => {
    const t = typeSel.value;
    $('#e-opt-area').style.display = (t === 'single' || t === 'multiple') ? '' : 'none';
    if (t === 'judge') {
      $('#e-answer-tip').textContent = '判断题：填 A（正确）或 B（错误）';
    } else if (t === 'blank' || t === 'essay') {
      $('#e-answer-tip').textContent = '多个空用 | 分隔，例如：北京|北平';
    } else if (t === 'multiple') {
      $('#e-answer-tip').textContent = '多选题：直接填选项字母，如 ABD';
    } else {
      $('#e-answer-tip').textContent = '单选题：填一个选项字母，如 B';
    }
  };
  typeSel.onchange();
  $('#e-add-opt').onclick = () => {
    const rows = document.querySelectorAll('#e-opts .opt-row');
    $('#e-opts').insertAdjacentHTML('beforeend', optRow(String.fromCharCode(65 + rows.length), ''));
  };
  document.querySelectorAll('[data-del-opt]').forEach(b => b.onclick = () => b.closest('.opt-row').remove());
  bindImageInsert();
}

/** 记住最后点击的输入框，图片插入到那里 */
function bindImageInsert() {
  document.querySelectorAll('.modal-body textarea.input, .modal-body input.input').forEach(el => {
    el.addEventListener('focus', () => { window._lastField = el.id; });
    el.addEventListener('click', () => { window._lastField = el.id; });
  });
  if (!window._lastField) window._lastField = 'e-stem';

  const insert = (url) => {
    const el = document.getElementById(window._lastField || 'e-stem');
    if (!el) {
      toast('请先点击要插入的输入框');
      return;
    }
    const md = '\n![](' + url + ')\n';
    const pos = (el.selectionStart === undefined || el.selectionStart === null) ? el.value.length : el.selectionStart;
    el.value = el.value.slice(0, pos) + md + el.value.slice(pos);
    el.focus();
    try { el.setSelectionRange(pos + md.length, pos + md.length); } catch (e) { /* noop */ }
    toast('已插入图片');
  };

  const up = $('#e-img-up');
  if (up) up.onclick = async () => {
    const fi = $('#e-img-file');
    if (!fi || !fi.files || !fi.files[0]) return toast('请先选择图片文件');
    const fd = new FormData();
    fd.append('file', fi.files[0]);
    try {
      const r = await fetch(API + '?action=upload', { method: 'POST', body: fd });
      const j = await r.json();
      if (!j.ok) return toast(j.error || '上传失败');
      insert(j.data.url);
      fi.value = '';
    } catch (e) {
      toast('上传失败：' + e.message);
    }
  };

  const ins = $('#e-img-insert');
  if (ins) ins.onclick = () => {
    const url = ($('#e-img-url') || {}).value || '';
    if (!/^https?:\/\//i.test(url.trim())) return toast('请填写以 http(s):// 开头的图片链接');
    insert(url.trim());
    $('#e-img-url').value = '';
  };
}

function collectEditor() {
  const type = $('#e-type').value;
  const rows = [...document.querySelectorAll('#e-opts .opt-row')];
  const options = rows.map(r => ({ key: r.querySelector('[data-opt-key]').value.trim(), text: r.querySelector('[data-opt-text]').value.trim() }));
  let raw = $('#e-answer').value.trim();
  let answer;
  if (type === 'blank' || type === 'essay') {
    answer = raw.split('|').map(s => s.trim()).filter(s => s);
  } else {
    answer = raw.replace(/[^A-Za-z]/g, '').toUpperCase().split('');
  }
  return {
    id: +$('#e-id').value || 0,
    bank_id: +$('#e-bank').value,
    type, stem: $('#e-stem').value.trim(),
    options, answer, analysis: $('#e-analysis').value.trim(), tags: $('#e-tags').value.trim()
  };
}

/* ---------------- 导入 ---------------- */
function importHtml() {
  return '<div class="field"><label>导入格式</label><select class="select" id="i-mode">' +
    '<option value="yutian">专用 JSON（YT）</option>' +
    '<option value="text">纯文本（直接粘贴题目）</option>' +
    '<option value="csv">CSV（Excel 可编辑）</option>' +
    '<option value="json">通用 JSON</option>' +
    '</select></div>' +
    '<div class="i-help" id="i-help"></div>' +
    '<div class="field"><label>题目内容（也可从文件读取）</label>' +
    '<textarea class="input textarea-lg" id="i-text" placeholder="【单选】中国的首都是哪个城市？&#10;A. 上海&#10;B. 北京&#10;C. 广州&#10;D. 深圳&#10;答案：B&#10;解析：常识题"></textarea></div>' +
    '<div class="toolbar"><input type="file" class="input w-260" id="i-file" accept=".txt,.csv,.json">' +
    '<button class="btn btn-sm" id="i-read">读取文件</button></div>' +
    '<div id="i-preview" style="max-height:300px;overflow:auto"></div>' +
    '<div class="note mt-2">' +
    '文本格式说明：题号或【题型】开头为新题；A. xxx 为选项；答案：B；解析：xxx；标签：xxx。判断题写「答案：对/错」，填空题写「答案：北京」。</div>';
}

/* ---------------- 通用分页条 ---------------- */
function pagerBar(total, page, size, act, maxBtns) {
  maxBtns = maxBtns || 7;
  const pages = Math.max(1, Math.ceil(total / size));
  if (pages <= 1) {
    // 只有一页时不显示分页条：居中一个「共 N 条」会孤零零飘在页面中间
    return total > 0 ? '<div class="list-count">共 ' + total + ' 条</div>' : '';
  }
  const dis = (c) => (c ? ' disabled' : '');
  let h = '<div class="pagination">';
  h += '<button class="btn btn-sm" data-act="' + act + '" data-id="1"' + dis(page === 1) + '>«</button>';
  h += '<button class="btn btn-sm" data-act="' + act + '" data-id="' + (page - 1) + '"' + dis(page === 1) + '>上一页</button>';
  let start = Math.max(1, page - Math.floor(maxBtns / 2));
  let end = Math.min(pages, start + maxBtns - 1);
  start = Math.max(1, end - maxBtns + 1);
  if (start > 1) h += '<span class="tag">…</span>';
  for (let i = start; i <= end; i++) {
    h += '<button class="btn btn-sm' + (i === page ? ' btn-primary' : '') + '" data-act="' + act + '" data-id="' + i + '">' + i + '</button>';
  }
  if (end < pages) h += '<span class="tag">…</span>';
  h += '<button class="btn btn-sm" data-act="' + act + '" data-id="' + (page + 1) + '"' + dis(page === pages) + '>下一页</button>';
  h += '<button class="btn btn-sm" data-act="' + act + '" data-id="' + pages + '"' + dis(page === pages) + '>»</button>';
  h += '<span class="tag">共 ' + total + ' 条 / ' + pages + ' 页</span>';
  h += '</div>';
  return h;
}

/* ---------------- 导入模板与格式说明 ---------------- */
const TP_YT = JSON.stringify([
  {
    id: 1, parentId: '（可选）题库分组ID', number: 1, type: '1',
    title: '<div>单选题题干，可内嵌图片：<img src="https://example.com/a.png" /></div>',
    optionA: '选项A', optionB: '选项B', optionC: '选项C', optionD: '选项D',
    optionE: null, optionF: null,
    answer: 'B', analysis: '（可选）解析'
  },
  {
    id: 2, number: 2, type: '2',
    title: '多选题题干（type=2，答案写多个字母）',
    optionA: '选项A', optionB: '选项B', optionC: '选项C', optionD: '选项D',
    optionE: null, optionF: null,
    answer: 'ABD', analysis: null
  },
  {
    id: 3, number: 3, type: '3',
    title: '填空题题干（type=3，没有选项，answer 填文本；多个空用 | 分隔）',
    optionA: null, optionB: null, optionC: null, optionD: null,
    optionE: null, optionF: null,
    answer: '北京', analysis: null
  },
  {
    id: 4, number: 4, type: '1',
    title: '判断题题干（选项写成 对/错 时会自动识别为判断题）',
    optionA: '对', optionB: '错',
    optionC: null, optionD: null, optionE: null, optionF: null,
    answer: 'A', analysis: null
  }
], null, 4);

const TP_TEXT = [
  '【单选】中国的首都是哪个城市？',
  'A. 上海',
  'B. 北京',
  'C. 广州',
  'D. 深圳',
  '答案：B',
  '解析：常识题',
  '标签：地理',
  '',
  '【多选】以下哪些属于一线城市？',
  'A. 北京',
  'B. 上海',
  'C. 拉萨',
  'D. 深圳',
  '答案：ABD',
  '',
  '地球是圆的。',
  '答案：对',
  '',
  '中国的全称是____。',
  '答案：中华人民共和国',
  '',
  '【简答】请简述 BGP 的工作原理。',
  '答案：通过建立 TCP 连接交换路由信息，言之有理即可'
].join('\n');

// CSV 模板：每个选项占一个单元格（A/B/C/D 列），至少填到「答案」列
const TP_CSV = [
  '题型,题干,A,B,C,D,答案,解析,标签,章节',
  '单选,1+1=?,1,2,,,B,基础算术,数学,第一章',
  '多选,以下哪些是偶数？,2,3,4,,AC,,数学,第一章',
  '判断,地球是圆的。,正确,错误,,,A,,常识,第二章',
  '填空,中国的首都是____。,,,,,北京,,地理,第二章',
  '简答,简述 TCP 三次握手。,,,,,SYN → SYN/ACK → ACK,,网络,第三章'
].join('\n');

const TP_JSON = JSON.stringify({
  questions: [
    { type: 'single', stem: '1+1=?', options: { A: '1', B: '2' }, answer: ['B'], analysis: '基础算术', tags: '数学' },
    { type: 'multiple', stem: '以下哪些是偶数？', options: { A: '2', B: '3', C: '4' }, answer: ['A', 'C'], analysis: '', tags: '数学' },
    { type: 'judge', stem: '地球是圆的。', answer: ['A'], analysis: '', tags: '常识' },
    { type: 'blank', stem: '中国的首都是____。', answer: ['北京'], analysis: '', tags: '地理' },
    { type: 'essay', stem: '简述 TCP 三次握手。', answer: ['SYN → SYN/ACK → ACK'], analysis: '', tags: '网络' }
  ]
}, null, 4);

const IMPORT_HELP = {
  yutian: {
    tpl: { name: 'YT题库模板.json', mime: 'application/json', text: TP_YT },
    title: '专用 JSON（YT）',
    desc: '题库系统导出的标准结构，上传 .json 文件时会自动识别，不用手动切换。',
    rules: [
      '<b>type</b>：<code>1</code>=单选、<code>2</code>=多选、<code>3</code>=填空',
      '选项字段为 <code>optionA</code>～<code>optionF</code>，没有的填空值 <code>null</code>',
      '<b>答案</b>：单选/多选写字母（如 <code>B</code>、<code>ABD</code>）；填空写文本',
      '选项只有「对 / 错」时<b>自动识别为判断题</b>（即使 type=1），并保留原始选项文字',
      '题干里 <code>&lt;img src="..."&gt;</code> 会自动转成图片显示；正文里类似 <code>&lt;10:1&gt;</code> 的文本会保留',
      '外面套一层也能识别：<code>{data:[...]}</code> / <code>{questions:[...]}</code> / <code>{list:[...]}</code>'
    ]
  },
  text: {
    tpl: { name: '导入模板.txt', mime: 'text/plain', text: TP_TEXT },
    title: '纯文本（直接粘贴）',
    desc: '最省事的格式，从 Word / 网页里复制题目直接粘贴即可。',
    rules: [
      '以「<b>答案：</b>」开头的行为本题答案；答案之后再出现新内容 = 下一题开始（<b>不需要题号</b>）',
      '选项写作 <code>A. xxx</code>、<code>A、xxx</code> 或 <code>(A) xxx</code>',
      '题型可省略：有选项=单选，2 个以上答案字母=多选，答案是「对/错/正确/错误」=判断，没选项=填空',
      '想要简答题请写 <code>【简答】</code>，否则会被当作填空题',
      '可选附加行：<code>解析：xxx</code>、<code>标签：xxx</code>',
      '填空题多个空用 <code>|</code> 分隔：<code>答案：北京|北平</code>'
    ]
  },
  csv: {
    tpl: { name: '导入模板.csv', mime: 'text/csv', text: TP_CSV, bom: true },
    title: 'CSV（Excel / WPS 可编辑）',
    desc: '每个选项占一个单元格（A/B/C/D 列），一行一道题。列顺序随意，中英文表头都认。',
    rules: [
      '列名：<code>题型</code>、<code>题干</code>、<code>A</code>、<code>B</code>、<code>C</code>、<code>D</code>、<code>答案</code>、<code>解析</code>、<code>标签</code>（可选再加 <code>章节</code>、<code>E</code>、<code>F</code>）',
      '<b>选项</b>：A 列填选项 A 的内容，B 列填选项 B……有多少个选项就填几列，用不到的留空',
      '<b>答案</b>：单选 <code>B</code>，多选 <code>AC</code>（多个字母连写），判断 <code>A</code>=正确 / <code>B</code>=错误，填空/简答直接写文字',
      '题型写法：单选 / 多选 / 判断 / 填空 / 简答（英文 single / multiple / judge / blank / essay 也认）；<b>不写题型也能自动判断</b>',
      '判断题：A、B 列填 <code>正确</code>、<code>错误</code>（或 <code>对</code>、<code>错</code>）会自动识别为判断题',
      icon('warn', 14) + ' <b>每行至少要填到「答案」列</b>：中间空的列也要保留逗号，否则后面的列会往前串位；<code>解析</code>、<code>标签</code>、<code>章节</code> 在最后，可以整列省略',
      '保存时选 <b>UTF-8（带 BOM）</b>，避免中文乱码'
    ]
  },
  json: {
    tpl: { name: '通用模板.json', mime: 'application/json', text: TP_JSON },
    title: '通用 JSON',
    desc: '自定义结构，适合从其它系统迁移或程序化生成。',
    rules: [
      '结构：<code>{ "questions": [ ... ] }</code>，也可以直接给数组',
      '字段：<code>type</code>、<code>stem</code>、<code>options</code>、<code>answer</code>、<code>analysis</code>、<code>tags</code>',
      '<code>options</code> 既可以是对象 <code>{"A":"1","B":"2"}</code>，也可以是数组 <code>[{"key":"A","text":"1"}]</code>',
      '判断题答案：<code>A</code>=正确、<code>B</code>=错误'
    ]
  }
};

function importHelpHtml(mode) {
  const h = IMPORT_HELP[mode] || IMPORT_HELP.text;
  let s = '<div class="i-help-box">' +
    '<div class="i-help-head"><b>' + h.title + '</b>' +
    '<button class="btn btn-sm btn-primary" id="i-tpl">下载导入模板</button></div>' +
    '<div class="i-help-desc">' + h.desc + '</div>' +
    '<ul class="i-help-list">' + h.rules.map(r => '<li>' + r + '</li>').join('') + '</ul>' +
    '</div>';
  return s;
}

function downloadTemplate(mode) {
  const t = (IMPORT_HELP[mode] || IMPORT_HELP.text).tpl;
  const blob = new Blob([(t.bom ? '\ufeff' : '') + t.text], { type: t.mime + ';charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = t.name;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  toast('已下载 ' + t.name);
}

function bindImport() {
  const modeSel = $('#i-mode');
  if (modeSel) {
    const renderHelp = () => {
      $('#i-help').innerHTML = importHelpHtml(modeSel.value);
      const btn = $('#i-tpl');
      if (btn) btn.onclick = () => downloadTemplate(modeSel.value);
    };
    modeSel.onchange = renderHelp;
    renderHelp();
  }
  $('#i-read').onclick = () => {
    const f = $('#i-file').files[0];
    if (!f) return toast('请先选择文件');
    const r = new FileReader();
    r.onload = () => {
      const text = r.result;
      $('#i-text').value = text;
      const ext = (f.name.split('.').pop() || '').toLowerCase();
      if (ext === 'json') {
        // 自动判断是不是誉天导出的 JSON（有 optionA / title / type=1|2|3 这些特征）
        let isYutian = false;
        try {
          const arr = JSON.parse(text.replace(/^\uFEFF/, ''));
          const first = Array.isArray(arr) ? arr[0] : (arr && (arr.data || arr.questions || arr.list || [])[0]);
          if (first && (('optionA' in first) || ('title' in first && 'answer' in first && 'type' in first))) {
            isYutian = true;
          }
        } catch (e) { /* 不是合法 JSON 就当作普通 JSON 处理 */ }
        $('#i-mode').value = isYutian ? 'yutian' : 'json';
        toast('已读取 ' + f.name + (isYutian ? '，识别为誉天格式' : ''));
      } else if (ext === 'csv') {
        $('#i-mode').value = 'csv';
        toast('已读取 ' + f.name);
      } else {
        $('#i-mode').value = 'text';
        toast('已读取 ' + f.name);
      }
    };
    r.readAsText(f, 'utf-8');
  };
  $('#i-parse').onclick = async () => {
    const text = $('#i-text').value;
    if (!text.trim()) return toast('请输入题目内容');
    try {
      const d = await api('import_preview', { text, mode: $('#i-mode').value });
      window._importItems = d.items;
      $('#i-preview').innerHTML = '<div class="panel"><b>解析到 ' + d.count + ' 道题</b>' +
        d.items.slice(0, 20).map(it => '<div class="mt-2">' +
          '<span class="tag tag-blue">' + TYPES[it.type] + '</span> ' + esc(it.stem.slice(0, 80)) +
          ' <span class="tag tag-green">答案：' + esc(it.answer.join('')) + '</span></div>').join('') +
        (d.count > 20 ? '<div class="note mt-2">… 其余 ' + (d.count - 20) + ' 题略</div>' : '') +
        '</div>';
      $('#i-commit').style.display = '';
    } catch (e) { /* 已在 api 中提示 */ }
  };
  $('#i-commit').onclick = async () => {
    const items = window._importItems;
    if (!items || !items.length) return toast('请先解析');
    const bankId = state.bankId > 0 ? state.bankId : 0;
    try {
      const d = await api('import_commit', { bank_id: bankId, items });
      toast('成功导入 ' + d.imported + ' 道题');
      closeModal();
      await loadBanks();
      if (state.view === 'questions') loadQuestions(); else render();
    } catch (e) { /* noop */ }
  };
}

/* ---------------- AI 导题库 ---------------- */
const AI_STEPS = n => '<div class="ai-steps">' +
  [1, 2, 3].map(i => '<span class="ai-step' + (i === n ? ' on' : (i < n ? ' done' : '')) + '">' +
    (i < n ? icon('check', 14) + ' ' : '') + i + '. ' + ['上传 / 粘贴', '解析预览与比对', '导入完成'][i - 1] + '</span>').join('') + '</div>';

/* --- 解析过程中的计时器与日志 --- */
let _aiTimer = null, _aiStart = 0, _aiLastStage = '';
function aiTimerStart() {
  aiTimerStop();
  _aiStart = Date.now();
  const tick = () => {
    const el = $('#ai-timer');
    if (!el) return;
    const s = Math.floor((Date.now() - _aiStart) / 1000);
    el.textContent = String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
  };
  tick();
  _aiTimer = setInterval(tick, 250);
}
function aiTimerStop() { if (_aiTimer) { clearInterval(_aiTimer); _aiTimer = null; } }

function aiLog(html) {
  const box = $('#ai-log');
  if (!box) return;
  const t = new Date();
  const ts = String(t.getHours()).padStart(2, '0') + ':' + String(t.getMinutes()).padStart(2, '0') + ':' + String(t.getSeconds()).padStart(2, '0');
  const line = document.createElement('div');
  line.className = 'ai-log-line';
  line.innerHTML = '<span class="ai-log-t">' + ts + '</span>' + html;
  box.appendChild(line);
  box.scrollTop = box.scrollHeight;
}
function aiStage(text) {
  _aiLastStage = text;
  const el = $('#ai-stage');
  if (el) el.innerHTML = '<span class="ai-spin"></span>' + text;
}

function aiRunBarHtml() {
  return '<div class="ai-runbar">' +
    '<span class="ai-timer-wrap">⏱ <b id="ai-timer">00:00</b></span>' +
    '<span id="ai-stage" class="ai-stage">准备中…</span></div>' +
    '<div class="ai-progress"><div class="ai-progress-bar"><i id="ai-pbar" style="width:0%"></i></div></div>' +
    '<div class="ai-log" id="ai-log"></div>' +
    '<div id="ai-result"></div>';
}
function aiSetProgress(pct) {
  const el = $('#ai-pbar');
  if (el) el.style.width = Math.max(0, Math.min(100, pct)) + '%';
}

/** 打开 AI 导入弹窗；未配置接口时提示前往设置 */
async function aiImportOpen() {
  if (!(state.view === 'questions' && state.bankId > 0 && bankEditable(state.bankId))) {
    return toast('只有题库上传者本人可以导入题目');
  }
  let cfg = {};
  try { cfg = await api('ai_config'); } catch (e) { return; }
  if (!cfg.ready) {
    const miss = (cfg.missing || []).length ? cfg.missing.join('、') : '接口地址、模型名、API Key';
    modal('尚未配置 AI 接口',
      '<div style="line-height:1.9">AI 导题库需要先配置大模型接口，当前还缺：<b class="c-red">' + esc(miss) + '</b>。<br>' +
      '请到左侧「设置 → AI 导题库配置」里填写并测试连接，再回来使用。</div>',
      '<button class="btn" data-close>知道了</button>' +
      '<button class="btn btn-primary" id="ai-goset">前往设置</button>');
    $('#ai-goset').onclick = () => { closeModal(); switchView('settings'); };
    return;
  }
  aiImportModal();
}

function aiImportModal() {
  modal('AI 导题库',
    '<div id="ai-msg">' + AI_STEPS(1) +
    '<div class="ai-tip">把格式不统一的题库文档交给 AI 解析：自动识别题型、拆分题干与选项、提取答案与解析，' +
    '解析结果会先给你预览比对，确认后再入库。</div>' +
    '<div class="field"><label>上传题库文件</label>' +
    '<input type="file" class="input" id="ai-file" accept=".docx,.xlsx,.pptx,.txt,.csv,.tsv,.md,.json,.html,.htm">' +
    '<div class="ai-hint">支持 .docx / .xlsx / .pptx / .txt / .csv / .md / .json（单文件 ≤ 30MB）。' +
    '旧版 .doc/.xls/.ppt 与 PDF 请先另存为新格式。</div></div>' +
    '<div class="field"><label>或直接粘贴题库内容</label>' +
    '<textarea class="input" id="ai-text" rows="6" placeholder="把题目文字粘贴到这里，AI 会同样解析…"></textarea></div>' +
    '</div>',
    '<button class="btn" data-close>取消</button>' +
    '<button class="btn btn-primary" id="ai-run">开始解析</button>' +
    '<button class="btn btn-success" id="ai-commit" style="display:none">确认导入</button>');

  const box = document.querySelector('.mask .modal');
  if (box) box.classList.add('modal-wide');
  $('#ai-run').onclick = aiRun;
}

/** 单块解析（带重试：请求中断/超时后再试，避免整批白跑） */
async function aiParseChunk(token, index, tries) {
  let lastErr = null;
  for (let k = 0; k < tries; k++) {
    try {
      return await api('ai_parse_chunk', { token: token, index: index });
    } catch (e) {
      lastErr = e;
      if (k < tries - 1) {
        aiLog('<b class="c-orange">第 ' + (index + 1) + ' 块失败</b>：' + esc(e.message || '') + '，1 秒后重试（' + (k + 2) + '/' + tries + '）');
        await new Promise(r => setTimeout(r, 1000));
      }
    }
  }
  throw lastErr || new Error('解析失败');
}

/** 上传（或粘贴）→ 逐块调用 AI 解析 → 与已有题目比对 → 展示预览 */
async function aiRun() {
  const fileEl = $('#ai-file');
  const file = fileEl && fileEl.files && fileEl.files[0];
  const pasted = (($('#ai-text') || {}).value || '').trim();
  if (!file && !pasted) return toast('请选择文件或粘贴内容');
  const runBtn = $('#ai-run');
  runBtn.disabled = true;
  const msg = $('#ai-msg');
  msg.innerHTML = AI_STEPS(1) + aiRunBarHtml();
  aiTimerStart();
  aiLog('开始处理：' + esc(file ? file.name : '粘贴内容'));

  try {
    aiStage('正在读取并提取文字…');
    let meta;
    if (file) {
      const fd = new FormData();
      fd.append('file', file);
      if (state.csrf) fd.append('csrf', state.csrf);
      const r = await fetch(API + '?action=ai_extract', { method: 'POST', body: fd, credentials: 'same-origin' });
      const raw = await r.text();
      let j;
      try { j = JSON.parse(raw); } catch (e) {
        throw new Error('读取文件时服务器返回异常页面（HTTP ' + r.status + '），请重试或改用粘贴方式');
      }
      if (!j.ok) { toast(j.error || '文件解析失败'); throw new Error(j.error); }
      meta = j.data;
    } else {
      meta = await api('ai_extract', { text: pasted });
    }
    aiLog('共提取到 <b>' + meta.chars + '</b> 字' + (meta.chunks ? '，切分为 <b>' + meta.chunks + '</b> 块' : ''));
    if (meta.warning) aiLog('<b class="c-orange">' + esc(meta.warning) + '</b>');

    let items = [];
    if (meta.local) {
      // JSON / CSV 等结构化内容已由本地规则精确解析，无需调用大模型
      items = meta.items || [];
      aiStage('结构化内容，已用本地规则识别');
      aiLog('<b class="c-green">识别为 ' + esc(meta.kind === 'yutian' ? '誉天 JSON' : (meta.kind === 'csv' ? 'CSV 表格' : '标准 JSON')) +
        '</b>，由本地规则直接解析出 <b>' + items.length + '</b> 道题（未消耗 AI）');
    } else {
      if (!meta.token) throw new Error('缺少解析会话，请重试');
      for (let i = 0; i < meta.chunks; i++) {
        aiStage('AI 正在解析第 ' + (i + 1) + ' / ' + meta.chunks + ' 块…');
        aiSetProgress(Math.round(i / meta.chunks * 100));
        aiLog('第 ' + (i + 1) + ' / ' + meta.chunks + ' 块：提交给模型…');
        const t0 = Date.now();
        const d = await aiParseChunk(meta.token, i, 3);
        items = items.concat(d.items || []);
        aiSetProgress(Math.round((i + 1) / meta.chunks * 100));
        aiLog('第 ' + (i + 1) + ' 块完成：得到 <b>' + ((d.items || []).length) + '</b> 道题，耗时 ' +
          ((Date.now() - t0) / 1000).toFixed(1) + ' 秒（累计 ' + items.length + ' 道）');
      }
    }
    if (!items.length) {
      aiTimerStop();
      aiStage('未解析到题目');
      aiLog('<b class="c-red">没有解析到题目</b>');
      $('#ai-result').innerHTML = '<div class="feedback no">没有从内容里解析到题目。' +
        '请检查文档是否包含题干/选项/答案，或把内容整理得更清楚一些后重试。</div>';
      runBtn.disabled = false;
      return;
    }

    aiStage('与题库已有题目比对…');
    aiSetProgress(100);
    aiLog('开始与题库已有题目比对…');
    let dups = {};
    try { dups = await api('ai_compare', { bank_id: state.bankId, items: items }); } catch (e) { dups = {}; }
    aiLog('比对完成：疑似重复 <b>' + Object.keys(dups).length + '</b> 道');
    aiTimerStop();
    aiLog('<b class="c-green">解析完成：共 ' + items.length + ' 道题</b>');
    aiShowPreview(items, dups, meta);
  } catch (e) {
    aiTimerStop();
    aiStage('解析失败');
    aiLog('<b class="c-red">解析失败：' + esc(e.message || '未知错误') + '</b>');
    const res = $('#ai-result');
    if (res) res.innerHTML = '<div class="feedback no">解析失败：' + esc(e.message || '未知错误') +
      '<br><span class="note">可再次点击「开始解析」重试；若内容很大，建议拆分成多个文件。</span></div>';
    runBtn.disabled = false;
  }
}

/** 第二步：解析结果预览 + 与题库已有题目比对 */
function aiShowPreview(items, dups, meta) {
  const dupIdx = new Set(Object.keys(dups).map(Number));
  const sel = new Set();
  items.forEach((it, i) => { if (!dupIdx.has(i) && !it.uncertain) sel.add(i); });
  window._ai = { items: items, sel: sel, dups: dups };

  const cost = _aiStart ? Math.floor((Date.now() - _aiStart) / 1000) : 0;
  const costTxt = String(Math.floor(cost / 60)).padStart(2, '0') + ':' + String(cost % 60).padStart(2, '0');
  const way = meta && meta.local
    ? '本地规则（' + (meta.kind === 'yutian' ? '誉天 JSON' : (meta.kind === 'csv' ? 'CSV' : 'JSON')) + '）'
    : 'AI 解析';
  let h = AI_STEPS(2);
  h += '<div class="ai-summary">' +
    '<span><b>' + esc((meta && meta.source) || '内容') + '</b></span>' +
    '<span>' + way + '</span>' +
    '<span>解析 <b>' + items.length + '</b> 道</span>' +
    '<span>疑似重复 <b class="c-orange">' + dupIdx.size + '</b> 道</span>' +
    '<span>答案存疑 <b class="c-orange">' + items.filter(x => x.uncertain).length + '</b> 道</span>' +
    '<span>已勾选 <b id="ai-sel-count">' + sel.size + '</b> 道</span>' +
    '<span class="c-green">耗时 ' + costTxt + '</span>' +
    '</div>' +
    '<div class="ai-hint">重复项与答案存疑项默认不勾选，确认无误后可手动勾选；取消勾选即可跳过某题。</div>' +
    '<div class="toolbar mb-2"><button class="btn btn-sm" id="ai-all">全选</button>' +
    '<button class="btn btn-sm" id="ai-none">全不选</button>' +
    '<button class="btn btn-sm" id="ai-onlynew">只选非重复</button>' +
    '<span class="spacer"></span><span class="ai-hint">共 ' + items.length + ' 道</span></div>' +
    '<div class="ai-preview">';

  items.forEach((it, i) => {
    const dup = dups[i];
    const tags = [];
    if (dup) tags.push('<span class="tag tag-orange">疑似重复</span>');
    if (it.uncertain) tags.push('<span class="tag tag-red">答案存疑</span>');
    const hasOpts = it.options && it.options.length;
    h += '<div class="ai-item' + (dup ? ' dup' : '') + (it.uncertain ? ' unsure' : '') + '">' +
      '<label class="ai-check"><input type="checkbox" data-ai="' + i + '"' + (sel.has(i) ? ' checked' : '') + '></label>' +
      '<div class="ai-body">' +
      '<div class="ai-head"><span class="tag tag-blue">' + (TYPES[it.type] || it.type) + '</span> ' +
      '<span class="ai-no">#' + (i + 1) + '</span> ' + tags.join(' ') + '</div>' +
      '<div class="ai-stem">' + rt(it.stem) + '</div>' +
      (hasOpts
        ? '<div class="ai-opts">' + it.options.map(o =>
            '<span class="ai-opt' + (it.answer.indexOf(o.key) >= 0 ? ' ok' : '') + '">' +
            esc(o.key) + '. ' + rt(o.text) + '</span>').join('') + '</div>' +
          '<div class="ai-ans">正确答案：<b>' + esc(it.answer.join('')) + '</b></div>'
        : '<div class="ai-ans">参考答案：<b>' + esc((it.answer || []).join(' / ') || '（未识别到答案）') + '</b></div>') +
      (it.analysis ? '<div class="ai-analysis">解析：' + rt(it.analysis) + '</div>' : '') +
      (it.chapter ? '<div class="ai-chapter">章节：' + esc(it.chapter) + '</div>' : '') +
      (dup ? '<div class="ai-dup">题库中已有相似题目：' + esc(String(dup.dup_stem || '').slice(0, 70)) +
        (dup.reason === 'exact' ? '　<span class="tag tag-red">完全相同</span>' : '　<span class="tag tag-orange">题干高度相似</span>') + '</div>' : '') +
      '</div></div>';
  });
  h += '</div>';

  $('#ai-msg').innerHTML = h;
  $('#ai-run').style.display = 'none';
  $('#ai-commit').style.display = '';
  document.querySelectorAll('#ai-file, #ai-text').forEach(el => { el.disabled = true; });

  const refresh = () => { $('#ai-sel-count').textContent = window._ai.sel.size; };
  const bindBox = i => {
    const cb = document.querySelector('#ai-msg [data-ai="' + i + '"]');
    if (cb) cb.onchange = () => { if (cb.checked) window._ai.sel.add(i); else window._ai.sel.delete(i); refresh(); };
  };
  items.forEach((it, i) => bindBox(i));
  $('#ai-all').onclick = () => { window._ai.sel = new Set(items.map((x, i) => i));
    document.querySelectorAll('#ai-msg [data-ai]').forEach(cb => { cb.checked = true; }); refresh(); };
  $('#ai-none').onclick = () => { window._ai.sel = new Set();
    document.querySelectorAll('#ai-msg [data-ai]').forEach(cb => { cb.checked = false; }); refresh(); };
  $('#ai-onlynew').onclick = () => {
    window._ai.sel = new Set();
    items.forEach((it, i) => { if (!dupIdx.has(i) && !it.uncertain) window._ai.sel.add(i); });
    document.querySelectorAll('#ai-msg [data-ai]').forEach(cb => { cb.checked = window._ai.sel.has(+cb.dataset.ai); });
    refresh();
  };
  $('#ai-commit').onclick = aiCommit;
}

/** 第三步：导入勾选的题目并展示结果（便于与原文档比对） */
async function aiCommit() {
  const st = window._ai;
  if (!st || !st.items) return;
  const chosen = st.items.filter((it, i) => st.sel.has(i));
  if (!chosen.length) return toast('请至少勾选一道题');
  const btn = $('#ai-commit');
  btn.disabled = true;
  try {
    const d = await api('import_commit', { bank_id: state.bankId, items: chosen });
    let h = AI_STEPS(3);
    h += '<div class="feedback ok"><b>成功导入 ' + d.imported + ' 道题</b>' +
      (d.imported < chosen.length ? '（' + (chosen.length - d.imported) + ' 道因缺题干或缺答案被跳过）' : '') + '</div>';
    h += '<div class="ai-hint">下面列出本次导入的题目，可与原始文档逐条比对；如发现错误可到题目列表里编辑或删除。</div>';
    h += '<div class="ai-preview">' + chosen.map((it, i) =>
      '<div class="ai-item"><div class="ai-body">' +
      '<div class="ai-head"><span class="tag tag-blue">' + (TYPES[it.type] || it.type) + '</span> ' +
      '<span class="ai-no">#' + (i + 1) + '</span></div>' +
      '<div class="ai-stem">' + rt(it.stem) + '</div>' +
      '<div class="ai-ans">答案：<b>' +
      esc(it.options && it.options.length ? it.answer.join('') : (it.answer || []).join(' / ')) + '</b></div>' +
      '</div></div>').join('') + '</div>';
    $('#ai-msg').innerHTML = h;
    $('#ai-commit').style.display = 'none';
    await loadBanks();
    await loadQuestions();
    toast('成功导入 ' + d.imported + ' 道题');
  } catch (e) {
    btn.disabled = false;
  }
}

/* ---------------- 练习 ---------------- */
function viewPractice() {
  if (state.p.list.length && state.p.q) return practiceRunHtml();
  let h = '<div class="page-head"><div><h2 class="page-title">刷题练习</h2>' +
    '<div class="page-sub">可按题型和数量选题，支持答题卡、选项乱序、背题模式</div></div></div>';
  h += '<div class="card"><div class="form-grid">' +
    '<div class="field"><label>选择题库</label>' +
    '<select class="select" id="p-bank">' + state.banks.map(b => '<option value="' + b.id + '"' + (state.p.bankId === b.id ? ' selected' : '') + '>' + esc(b.name) + '（' + b.qcount + ' 题）</option>').join('') + '</select></div>' +
    '<div class="field"><label>出题顺序</label><select class="select" id="p-mode">' +
    '<option value="order"' + (state.p.mode === 'order' ? ' selected' : '') + '>顺序练习</option>' +
    '<option value="random"' + (state.p.mode === 'random' ? ' selected' : '') + '>随机练习</option></select></div>' +
    '<div class="field field-full"><label>题型与数量（不勾选的题型不出）</label><div id="p-types">loadingSmHTML()</div></div>' +
    '<div class="field field-full"><label>筛选条件</label>' +
    '<div class="toolbar mb-2">' +
    '<select class="select" id="p-state">' +
    '<option value="all"' + (state.pf.state === 'all' ? ' selected' : '') + '>全部题目</option>' +
    '<option value="new"' + (state.pf.state === 'new' ? ' selected' : '') + '>只练没做过的题</option>' +
    '<option value="wrong"' + (state.pf.state === 'wrong' ? ' selected' : '') + '>只练错题</option>' +
    '<option value="flagged"' + (state.pf.state === 'flagged' ? ' selected' : '') + '>只练已标记的题</option>' +
    '<option value="done"' + (state.pf.state === 'done' ? ' selected' : '') + '>只练做过的题</option>' +
    '</select>' +
    '<select class="select" id="p-chapter"><option value="">全部章节</option>' +
    state.chapters.map(c => '<option value="' + esc(c.chapter) + '"' + (state.pf.chapter === c.chapter ? ' selected' : '') + '>' +
      esc(c.chapter) + '（' + c.c + '）</option>').join('') +
    '</select></div>' +
    '<div class="note">提示：「随练习」+「只练没做过的题」适合刷新题；章节可在题目编辑里填写</div>' +
    '</div>' +
    '<div class="field-full"><button class="btn btn-primary" data-act="p-start">开始练习</button></div>' +
    '</div></div>';
  return h;
}

/** 各题型数量行 */
function typeRowsHtml(rows, defaultCap) {
  const counts = {};
  (rows || []).forEach(r => { counts[r.type] = +r.c; });
  const order = ['single', 'multiple', 'judge', 'blank', 'essay'];
  let h = '';
  order.forEach(t => {
    const n = counts[t] || 0;
    if (!n) return;
    const def = defaultCap ? Math.min(defaultCap, n) : n;
    h += '<div class="setting-row">' +
      '<label class="ptype-label">' +
      '<input type="checkbox" data-ptype="' + t + '" checked> <span>' + TYPES[t] +
      ' <span class="muted">（' + n + ' 题）</span></span></label>' +
      '<input class="input w-80" type="number" min="0" max="' + n + '" value="' + def + '" data-pcount="' + t + '">' +
      '</div>';
  });
  if (!h) return '<div class="note">该题库还没有题目</div>';
  return '<div class="type-grid">' + h + '</div>';
}

/** 读取题型勾选与数量 */
function collectTypeSpecs(containerSel) {
  const box = $(containerSel);
  if (!box) return [];
  const specs = [];
  box.querySelectorAll('[data-ptype]').forEach(cb => {
    if (!cb.checked) return;
    const t = cb.dataset.ptype;
    const num = box.querySelector('[data-pcount="' + t + '"]');
    let c = num ? (+num.value || 0) : 0;
    const max = num ? (+num.max || 0) : 0;
    c = Math.max(0, Math.min(c, max));
    if (c > 0) specs.push({ type: t, count: c });
  });
  return specs;
}

/** 按题型+数量组装题目列表（random=是否每种题型内部随机抽取） */
async function composeQuestions(bankId, specs, random, filter) {
  const list = [];
  for (const s of specs) {
    const req = { bank_id: bankId, type: s.type, page_size: s.count, random: random ? 1 : 0, page: 1 };
    if (filter && filter.state && filter.state !== 'all') req.answer_state = filter.state;
    if (filter && filter.chapter) req.chapter = filter.chapter;
    const d = await api('question_list', req);
    let l = d.list || [];
    if (!random) l = l.slice().sort((a, b) => a.id - b.id);
    list.push.apply(list, l.slice(0, s.count));
  }
  return list;
}

/** Fisher–Yates 洗牌（返回新数组） */
function shuffle(a) {
  const b = a.slice();
  for (let i = b.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = b[i]; b[i] = b[j]; b[j] = t;
  }
  return b;
}

/**
 * 错题重考（错题优先）：按「题型与数量」配置抽题，
 * 每种题型错题优先占 80%，其余 20% 从非错题中随机抽取；
 * 错题不足时由非错题补足到配置数量。
 */
async function composeWrongPriority(bankId, specs, filter) {
  const list = [];
  const ch = filter && filter.chapter ? filter.chapter : '';
  for (const s of specs) {
    const N = s.count;
    if (N <= 0) continue;
    const wrongWant = Math.ceil(N * 0.8);   // 错题优先：目标 80%
    const deficit = N - wrongWant;          // 其余 20% 从非错题随机
    // 该题型全部错题（同时作为「错题集合」用于剔除）
    const wd = await api('question_list', { bank_id: bankId, type: s.type, answer_state: 'wrong', random: 1, page_size: 1000, page: 1, chapter: ch });
    const wrongPool = (wd.list || []).slice();
    const wrongIds = new Set(wrongPool.map(q => q.id));
    // 该题型全部题目，剔除错题后即「非错题」池
    const ad = await api('question_list', { bank_id: bankId, type: s.type, answer_state: 'all', random: 1, page_size: 1000, page: 1, chapter: ch });
    const otherPool = (ad.list || []).filter(q => !wrongIds.has(q.id));
    const w = shuffle(wrongPool).slice(0, wrongWant);
    const o = shuffle(otherPool).slice(0, deficit);
    list.push.apply(list, w.concat(o));
  }
  return list;
}

/** 刷新设置页里的题型数量面板 */
async function refreshTypeCounts() {
  if (state.view === 'practice') {
    const sel = $('#p-bank'), box = $('#p-types');
    if (!sel || !box) return;
    const rows = await api('bank_types', { bank_id: +sel.value });
    box.innerHTML = typeRowsHtml(rows, 0);
    try {
      state.chapters = await api('bank_chapters', { bank_id: +sel.value });
      const ch = $('#p-chapter');
      if (ch) {
        ch.innerHTML = '<option value="">全部章节</option>' +
          state.chapters.map(c => '<option value="' + esc(c.chapter) + '"' +
            (state.pf.chapter === c.chapter ? ' selected' : '') + '>' + esc(c.chapter) + '（' + c.c + '）</option>').join('');
      }
    } catch (e) { /* 忽略 */ }
  } else if (state.view === 'exam') {
    const sel = $('#e-bank'), box = $('#e-types');
    if (!sel || !box) return;
    const rows = await api('bank_types', { bank_id: +sel.value });
    box.innerHTML = typeRowsHtml(rows, 20);
    try {
      state.chapters = await api('bank_chapters', { bank_id: +sel.value });
      const ch = $('#e-chapter');
      if (ch) {
        ch.innerHTML = '<option value="">全部章节</option>' +
          state.chapters.map(c => '<option value="' + esc(c.chapter) + '">' + esc(c.chapter) + '（' + c.c + '）</option>').join('');
      }
    } catch (e) { /* 忽略 */ }
  }
}

async function startPractice() {
  const bankId = +$('#p-bank').value;
  const mode = $('#p-mode').value;
  const specs = collectTypeSpecs('#p-types');
  if (!specs.length) return toast('请至少勾选一种题型并设置数量');
  const stEl = $('#p-state'), chEl = $('#p-chapter');
  state.pf.state = stEl ? stEl.value : 'all';
  state.pf.chapter = chEl ? chEl.value : '';
  const list = await composeQuestions(bankId, specs, mode === 'random', state.pf);
  if (!list.length) return toast('没有可用的题目');
  state.p.bankId = bankId;
  state.p.mode = mode;
  state.p.list = list;
  state.p.idx = 0;
  state.p.q = null;
  state.p.picked = [];
  state.p.answered = false;
  state.p.result = null;
  state.p.expected = '';
  state.p.expectedDisp = null;
  state.p.results = new Array(list.length).fill(null);
  state.p.optCache = {};
  loadPracticeQuestion();
}

/** 构建当前题的显示选项；开启「选项乱序」时打乱顺序并重排字母 */
function buildOptions(q) {
  let opts = (q.options || []).slice();
  if (state.p.settings.shuffle && (q.type === 'single' || q.type === 'multiple') && opts.length > 1) {
    for (let i = opts.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const t = opts[i]; opts[i] = opts[j]; opts[j] = t;
    }
  }
  return opts.map((o, i) => ({ key: String.fromCharCode(65 + i), orig: o.key, text: o.text }));
}

/** 每题的显示选项缓存（保证来回翻题时乱序结果不变） */
function getOptions(q) {
  if (!state.p.optCache[q.id]) state.p.optCache[q.id] = buildOptions(q);
  return state.p.optCache[q.id];
}

/** 原始答案字母 -> 显示字母 */
function toDisplayKeys(origKeys) {
  const map = {};
  state.p.curOptions.forEach(o => { map[o.orig] = o.key; });
  return (origKeys || []).map(k => map[k] !== undefined ? map[k] : k);
}

/** 显示字母 -> 原始答案字母（提交给后端判分用） */
function toOrigKeys(dispKeys) {
  const map = {};
  state.p.curOptions.forEach(o => { map[o.key] = o.orig; });
  return (dispKeys || []).map(k => map[k] !== undefined ? map[k] : k);
}

function practiceCounts() {
  let right = 0, wrong = 0, pending = 0;
  state.p.results.forEach(r => {
    if (!r) return;
    if (r.correct === true) right++;
    else if (r.correct === false) wrong++;
    else pending++;
  });
  const done = right + wrong;
  return { right: right, wrong: wrong, pending: pending, acc: done ? Math.round(right / done * 10000) / 100 : 0 };
}

function settingRow(key, label) {
  return '<div class="setting-row"><span>' + label + '</span>' +
    '<label class="switch"><input type="checkbox" data-set="' + key + '"' + (state.p.settings[key] ? ' checked' : '') + '><span class="slider"></span></label></div>';
}

/** 切题后把视口带回题目顶部：否则手机上会停在上一题的滚动位置，看不到新题干 */
function scrollToQuestionTop() {
  try {
    window.scrollTo(0, 0);
    const main = document.querySelector('.main');
    if (main) main.scrollTop = 0;
    const view = document.querySelector('#view');
    if (view) view.scrollTop = 0;
  } catch (e) { /* 忽略 */ }
}

/** 只更新选项的选中样式，不再整页重绘（避免手机端闪屏、滚动位置跳动）。
    开启「立即判分」时，顺带给已选选项标出对错（多选题可继续勾选调整）。 */
function markPracticeOptions() {
  const box = $('#view .opt-list');
  if (!box) return render();
  const p = state.p, q = p.q;
  const correct = ((q && q.answer) || []).map(String);
  const map = {};
  (p.curOptions || []).forEach(o => { map[o.key] = o.orig; });
  const instant = p.settings.instant && !p.answered && !p.settings.recite;
  box.querySelectorAll('[data-act="p-pick"]').forEach(el => {
    const k = el.dataset.key;
    const picked = p.picked.indexOf(k) >= 0;
    el.classList.toggle('selected', picked);
    el.classList.remove('right', 'wrong');
    if (instant && picked) {
      const orig = map[k] !== undefined ? map[k] : k;
      el.classList.add(correct.indexOf(String(orig)) >= 0 ? 'right' : 'wrong');
    }
  });
}

/** 考试页同理：只更新选中态 */
function markExamOptions() {
  const e = state.e, q = e.list[e.idx];
  const box = $('#view .opt-list');
  if (!box || !q) return render();
  const arr = e.answers[q.id] || [];
  box.querySelectorAll('[data-act="e-pick"]').forEach(el => {
    el.classList.toggle('selected', arr.indexOf(el.dataset.key) >= 0);
  });
}

function loadPracticeQuestion() {
  const p = state.p;
  p.q = p.list[p.idx];
  const r = p.results[p.idx];
  p.picked = r ? r.picked.slice() : [];
  p.answered = !!r;
  p.result = r ? r.correct : null;
  p.expected = r ? r.expected : '';
  p.expectedDisp = r ? r.expectedDisp : null;
  p.curOptions = getOptions(p.q);
  p.flagged = !!(p.q && p.q.flagged);
  render();
  scrollToQuestionTop();
}

function practiceRunHtml() {
  const p = state.p, q = p.q;
  const opts = p.curOptions;
  const counts = practiceCounts();
  const isRecite = p.settings.recite && !p.answered;
  const hasOptions = q.type === 'single' || q.type === 'multiple' || q.type === 'judge';
  const expectedDisp = (p.answered && p.expectedDisp) ? p.expectedDisp : (isRecite ? toDisplayKeys(q.answer) : []);

  let h = '<div class="practice-layout"><div class="p-left"><div class="card">';

  h += '<div class="toolbar mb-3">' +
    '<span class="tag tag-blue">' + TYPES[q.type] + '</span>' +
    '<span class="tag">' + (p.idx + 1) + ' / ' + p.list.length + ' 题</span>' +
    (p.flagged ? '<span class="tag tag-orange">已标记</span>' : '') +
    '<span class="spacer"></span>' +
    '<button class="btn btn-sm ' + (p.flagged ? '' : 'btn-primary') + '" data-act="p-flag">' +
    (p.flagged ? '取消标记' : '标记疑问题') + '</button> ' +
    '<button class="btn btn-sm" data-act="p-quit">退出练习</button></div>';

  h += '<div class="q-box">' + rt(q.stem) + '</div>';

  if (hasOptions) {
    h += '<div class="opt-list' + (q.type === 'multiple' ? ' multi' : '') + '">' + opts.map(o => {
      let cls = '';
      if (p.answered) {
        if (p.settings.showAnswer && expectedDisp.indexOf(o.key) >= 0) cls = ' right';
        else if (p.picked.indexOf(o.key) >= 0) cls = ' wrong';
      } else if (isRecite) {
        if (expectedDisp.indexOf(o.key) >= 0) cls = ' right';
      } else if (p.picked.indexOf(o.key) >= 0) cls = ' selected';
      return '<div class="opt' + cls + '" data-act="p-pick" data-key="' + esc(o.key) + '"><span class="key">' + esc(o.key) + '</span><span>' + rt(o.text) + '</span></div>';
    }).join('') + '</div>';
  } else if (q.type === 'blank') {
    h += '<input class="input" id="p-blank" placeholder="请输入答案"' + (p.answered || isRecite ? ' disabled' : '') + ' value="' + esc(p.picked[0] || '') + '">';
  } else {
    h += '<textarea class="input" id="p-blank" placeholder="请输入你的作答"' + (p.answered || isRecite ? ' disabled' : '') + '>' + esc(p.picked[0] || '') + '</textarea>';
  }

  if (p.answered && p.result === null) {
    h += '<div class="feedback warn"><b>简答题</b>请自评：' +
      '<button class="btn btn-sm btn-success" data-act="p-self" data-id="1">正确</button> ' +
      '<button class="btn btn-sm btn-danger" data-act="p-self" data-id="0">错误</button></div>';
  } else if (p.answered && p.settings.showAnswer) {
    h += '<div class="feedback ' + (p.result ? 'ok' : 'no') + '"><b>' + (p.result ? '回答正确' : '回答错误') + '</b>' +
      (p.result ? '' : '　正确答案：' + esc(hasOptions ? expectedDisp.join('') : p.expected)) + '</div>';
  } else if (p.answered) {
    h += '<div class="feedback info">已提交，结果已记入答题卡（设置中可开启直接显示答案）</div>';
  }
  if (isRecite) {
    const ansText = hasOptions ? expectedDisp.join('') : (q.answer || []).join(' / ');
    h += '<div class="feedback ok"><b>背题模式</b>　绿色为正确答案：' + esc(ansText || '—') + '</div>';
  }
  if ((p.answered || isRecite) && q.analysis && (p.settings.showAnswer || isRecite)) {
    h += '<div class="q-analysis">解析：' + rt(q.analysis) + '</div>';
  }

  h += '<div class="toolbar toolbar--top">' +
    '<button class="btn" data-act="p-prev"' + (p.idx === 0 ? ' disabled' : '') + '>← 上一题</button>';
  if (!p.answered && !isRecite) {
    h += '<button class="btn btn-primary" data-act="p-submit">提交答案</button>';
  } else {
    h += '<button class="btn btn-primary" data-act="p-next">' + (p.idx + 1 >= p.list.length ? '完成练习' : '下一题 →') + '</button>';
  }
  h += '</div></div></div>'; /* 关闭 toolbar、卡片、左栏 .p-left */

  /* 右侧：答题卡 + 设置 */
  h += '<div class="p-right"><div class="card"><div class="card-title">答题卡<span class="spacer"></span>' +
    '<a href="javascript:void(0)" data-act="p-restart">重新练习</a></div>' +
    '<div class="ans-grid">' + p.list.map((qq, i) => {
      const r = p.results[i];
      let cls = '';
      if (r) cls = r.correct === true ? ' right' : (r.correct === false ? ' wrong' : ' pending');
      if (i === p.idx) cls += ' current';
      if (p.list[i] && p.list[i].flagged) cls += ' flagged';
      return '<div class="ans-cell' + cls + '" data-act="p-go" data-id="' + i + '" title="第' + (i + 1) + '题">' + (i + 1) + '</div>';
    }).join('') + '</div>' +
    '<div class="ans-stats">' +
    '<div class="ans-stat"><span class="dot dot-g"></span>答对: <b class="c-green">' + counts.right + '</b> 题</div>' +
    '<div class="ans-stat"><span class="dot dot-r"></span>答错: <b class="c-red">' + counts.wrong + '</b> 题</div>' +
    '<div class="ans-stat">正确率: <b>' + counts.acc + '%</b></div>' +
    (counts.pending ? '<div class="ans-stat">待自评: <b class="c-orange">' + counts.pending + '</b> 题</div>' : '') +
    '</div></div>';

  h += '<div class="card"><div class="card-title">设置</div>' +
    settingRow('instant', '点击选项立即判分（选择题）') +
    settingRow('autoNext', '答对自动下一题') +
    settingRow('recite', '背题模式') +
    settingRow('shuffle', '选项乱序') +
    settingRow('showAnswer', '答题后直接显示答案') +
    '</div></div></div>';
  return h;
}

async function submitPractice() {
  const p = state.p, q = p.q;
  let userDisp, userOrig;
  if (q.type === 'blank' || q.type === 'essay') {
    userDisp = (($('#p-blank') || {}).value || '').trim();
    if (!userDisp) return toast('请输入答案');
    p.picked = [userDisp];
    userOrig = userDisp;
  } else {
    if (!p.picked.length) return toast('请选择答案');
    userDisp = p.picked.slice();
    userOrig = toOrigKeys(userDisp);
  }

  if (q.type === 'essay') {
    p.answered = true;
    p.result = null;
    p.expected = (q.answer || []).join(' / ');
    p.expectedDisp = null;
    p.results[p.idx] = { picked: p.picked.slice(), correct: null, expectedDisp: null, expected: p.expected };
    return render();
  }

  const d = await api('record_answer', { question_id: q.id, user_answer: userOrig, mode: 'practice' });
  p.answered = true;
  p.result = d.correct;
  p.expected = d.expected;
  p.expectedDisp = q.type === 'blank' ? null : toDisplayKeys(String(d.expected).split(''));
  p.results[p.idx] = { picked: p.picked.slice(), correct: d.correct, expectedDisp: p.expectedDisp, expected: d.expected };
  render();

  if (d.correct && p.settings.autoNext && p.idx + 1 < p.list.length) {
    setTimeout(() => {
      if (state.p.idx === p.idx && state.p.answered) { state.p.idx++; loadPracticeQuestion(); }
    }, 700);
  }
}

/* ---------------- 考试 ---------------- */
function viewExam() {
  if (state.e.list.length && !state.e.result) return examRunHtml();
  if (state.e.result) return examResultHtml();
  let h = '<div class="page-head"><div><h2 class="page-title">模拟考试</h2>' +
    '<div class="page-sub">限时组卷、自动判分、错题自动入册</div></div></div>';
  h += '<div class="card"><div class="form-grid">' +
    '<div class="field"><label>题库</label><select class="select" id="e-bank">' +
    state.banks.map(b => '<option value="' + b.id + '"' + (state.e.bankId === b.id ? ' selected' : '') + '>' + esc(b.name) + '（' + b.qcount + ' 题）</option>').join('') + '</select></div>' +
    '<div class="field"><label>组卷方式</label><select class="select" id="e-source">' +
    '<option value="types">按题型与数量</option>' +
    '<option value="wrong">错题重考（错题优先·占 80%）</option>' +
    '<option value="flagged">标记题重考（只考标记过的题）</option>' +
    '</select></div>' +
    '<div class="field field-full"><label>题型与数量（每种题型随机抽取）</label><div id="e-types">loadingSmHTML()</div></div>' +
    '<div class="field"><label>章节（可选，空=全部）</label>' +
    '<select class="select" id="e-chapter"><option value="">全部章节</option></select></div>' +
    '<div class="field"><label>考试时长（分钟，0=不限时）</label><input class="input" type="number" id="e-min" value="' + state.e.minutes + '" min="0"></div>' +
    '<div class="setting-row setting-row--plain"><span>点击选项立即判分（选择题）</span>' +
    '<label class="switch"><input type="checkbox" id="e-instant"' + (state.e.instant ? ' checked' : '') + '><span class="slider"></span></label></div>' +
    '<div class="setting-row setting-row--plain"><span>选项乱序（打乱每题选项顺序）</span>' +
    '<label class="switch"><input type="checkbox" id="e-shuffle"' + (state.e.shuffle ? ' checked' : '') + '><span class="slider"></span></label></div>' +
    '<div class="setting-row setting-row--plain"><span>交卷后显示正确答案与解析</span>' +
    '<label class="switch"><input type="checkbox" id="e-analysis"' + (state.e.showAnalysis === false ? '' : ' checked') + '><span class="slider"></span></label></div>' +
    '<div class="field-full mt-3"><button class="btn btn-primary" data-act="e-start">开始考试</button></div>' +
    '</div></div>';
  h += examHistoryHtml();
  return h;
}

async function loadExamHistory() {
  const list = await api('exam_list');
  if (state.view === 'exam') {
    const box = $('#exam-history');
    if (box) box.innerHTML = historyRows(list);
  }
}

function historyRows(list) {
  if (!list.length) return '<div class="empty empty--sm">还没有考试记录</div>';
  return '<table class="tbl">' +
    '<tr><th>名称</th><th>题库</th><th>得分</th><th>用时</th><th>时间</th><th></th></tr>' +
    list.map(e => '<tr><td>' + esc(e.name) + '</td>' +
      '<td>' + esc(e.bank_name || '-') + '</td>' +
      '<td><b class="' + (e.score >= 60 ? 'c-green' : 'c-red') + '">' + e.score + ' 分</b></td>' +
      '<td>' + fmtTime(e.used_seconds) + '</td>' +
      '<td>' + esc((e.created_at || '').slice(5, 16)) + '</td>' +
      '<td><button class="btn btn-sm" data-act="e-detail" data-id="' + e.id + '">查看</button> ' +
      '<button class="btn btn-sm btn-danger" data-act="e-del" data-id="' + e.id + '">删除</button></td></tr>').join('') +
    '</table>';
}

function examHistoryHtml() {
  return '<div class="card"><div class="card-title">历史成绩</div><div id="exam-history">' + loadingSmHTML() + '</div></div>';
}

async function startExam() {
  const bankId = +$('#e-bank').value;
  const minutes = Math.max(0, +$('#e-min').value || 0);
  const shuffleEl = $('#e-shuffle');
  const shuffle = !!(shuffleEl && shuffleEl.checked);
  const instantEl = $('#e-instant');
  const instant = !!(instantEl && instantEl.checked);
  const analysisEl = $('#e-analysis');
  const showAnalysis = analysisEl ? !!analysisEl.checked : true;
  const sourceEl = $('#e-source');
  const source = sourceEl ? sourceEl.value : 'types';
  const chEl = $('#e-chapter');
  const chapter = chEl ? chEl.value : '';

  let list = [];
  if (source === 'wrong') {
    // 错题重考（错题优先）：按「题型与数量」配置抽题，错题占 80%、其余 20% 从非错题随机
    const specs = collectTypeSpecs('#e-types');
    if (!specs.length) return toast('请至少勾选一种题型并设置数量');
    list = await composeWrongPriority(bankId, specs, { chapter });
    if (!list.length) return toast('这个题库可抽的题目不足，请调整题型数量或章节');
  } else if (source === 'flagged') {
    // 标记题重考：从当前题库的标记题中抽
    const d = await api('question_list', { bank_id: bankId, page_size: 500, random: 1, page: 1, answer_state: 'flagged', chapter: chapter });
    list = d.list || [];
    if (!list.length) return toast('还没有标记过题目');
  } else {
    const specs = collectTypeSpecs('#e-types');
    if (!specs.length) return toast('请至少勾选一种题型并设置数量');
    list = await composeQuestions(bankId, specs, true, { chapter });
  }
  if (!list.length) return toast('没有可用的题目');
  state.e.showAnalysis = showAnalysis;
  state.e.bankId = bankId;
  state.e.minutes = minutes;
  state.e.list = list;
  state.e.idx = 0;
  state.e.answers = {};
  state.e.result = null;
  state.e.shuffle = shuffle;
  state.e.instant = instant;
  state.e.instantRes = {};
  state.e.optCache = {};
  state.e.curOptions = [];
  state.e.left = minutes * 60;
  state.e.timer = null;
  state.e.startedAt = Date.now();
  loadExamQuestion();
  startTimer();
}

/** 考试中：构建显示选项（支持乱序并重排字母） */
function eBuildOptions(q) {
  let opts = (q.options || []).slice();
  if (state.e.shuffle && (q.type === 'single' || q.type === 'multiple') && opts.length > 1) {
    for (let i = opts.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const t = opts[i]; opts[i] = opts[j]; opts[j] = t;
    }
  }
  return opts.map((o, i) => ({ key: String.fromCharCode(65 + i), orig: o.key, text: o.text }));
}

function eGetOptions(q) {
  if (!state.e.optCache[q.id]) state.e.optCache[q.id] = eBuildOptions(q);
  return state.e.optCache[q.id];
}

/** 显示字母 -> 原始字母（交卷判分用） */
function eOrigAnswer(q, ans) {
  if (!Array.isArray(ans) || !ans.length) return ans;
  const map = {};
  eGetOptions(q).forEach(o => { map[o.key] = o.orig; });
  return ans.map(k => map[k] !== undefined ? map[k] : k);
}

/** 原始答案 -> 显示字母（结果页展示用） */
function eDispAnswer(q, ansStr) {
  if (ansStr === undefined || ansStr === null || ansStr === '') return ansStr;
  if (q.type === 'blank' || q.type === 'essay') return ansStr;
  const map = {};
  eGetOptions(q).forEach(o => { map[o.orig] = o.key; });
  return String(ansStr).split(',').map(k => k.split('').map(c => map[c] || c).join('')).join(',');
}

function loadExamQuestion() {
  const e = state.e;
  if (!e.list.length) return;
  e.curOptions = eGetOptions(e.list[e.idx]);
  render();
  scrollToQuestionTop();
}

function startTimer() {
  stopTimer();
  if (!state.e.minutes) return;
  state.e.timer = setInterval(() => {
    state.e.left--;
    const t = $('#exam-timer');
    if (t) {
      t.textContent = fmtTime(Math.max(0, state.e.left));
      if (state.e.left <= 60) t.classList.add('danger');
    }
    if (state.e.left <= 0) { stopTimer(); submitExam(true); }
  }, 1000);
}
function stopTimer() { if (state.e && state.e.timer) { clearInterval(state.e.timer); state.e.timer = null; } }

/** 正确选项的「显示字母」（考虑选项乱序） */
function eCorrectDispKeys(q) {
  const map = {};
  eGetOptions(q).forEach(o => { map[o.orig] = o.key; });
  return (q.answer || []).map(k => map[String(k)] !== undefined ? map[String(k)] : String(k));
}

function examRunHtml() {
  const e = state.e, q = e.list[e.idx];
  const opts = e.curOptions || [];
  const picked = e.answers[q.id] || [];
  const instantRes = e.instant ? e.instantRes[q.id] : null;
  const expectedDisp = instantRes ? eCorrectDispKeys(q) : [];
  const doneCount = e.list.filter(qq => (e.answers[qq.id] || []).length).length;

  let h = '<div class="exam-bar">' +
    '<span class="timer" id="exam-timer">' + (e.minutes ? fmtTime(Math.max(0, e.left)) : '不限时') + '</span>' +
    '<span class="tag">第 ' + (e.idx + 1) + ' / ' + e.list.length + ' 题</span>' +
    '<span class="tag tag-blue">' + TYPES[q.type] + '</span>' +
    '<span class="spacer"></span>' +
    '<button class="btn" data-act="e-prev">上一题</button>' +
    '<button class="btn" data-act="e-next">下一题</button>' +
    '<button class="btn btn-primary" data-act="e-submit">交卷</button></div>';

  h += '<div class="practice-layout exam-layout"><div class="p-left"><div class="card">';
  h += '<div class="q-box">' + rt(q.stem) + '</div>';

  if (q.type === 'single' || q.type === 'multiple' || q.type === 'judge') {
    h += '<div class="opt-list' + (q.type === 'multiple' ? ' multi' : '') + '">' + opts.map(o => {
      let cls = picked.indexOf(o.key) >= 0 ? ' selected' : '';
      if (instantRes) {
        if (expectedDisp.indexOf(o.key) >= 0) cls = ' right';
        else if (picked.indexOf(o.key) >= 0) cls = ' wrong';
        else cls = '';
      }
      return '<div class="opt' + cls + '" data-act="e-pick" data-key="' + esc(o.key) + '">' +
        '<span class="key">' + esc(o.key) + '</span><span>' + rt(o.text) + '</span></div>';
    }).join('') + '</div>';
  } else if (q.type === 'blank') {
    h += '<input class="input" id="e-blank" value="' + esc(picked[0] || '') + '" placeholder="请输入答案">';
  } else {
    h += '<textarea class="input" id="e-blank" placeholder="请作答">' + esc(picked[0] || '') + '</textarea>';
  }

  if (instantRes) {
    if (q.type === 'multiple') {
      h += '<div class="feedback info">' +
        '<b>多选</b>　绿色为正确选项、红色为你选错的项；可继续勾选调整，交卷后按最终选择判分</div>';
    } else {
      h += '<div class="feedback ' + (instantRes.correct ? 'ok' : 'no') + '"><b>' +
        (instantRes.correct ? '回答正确' : '回答错误') + '</b>' +
        (instantRes.correct ? '' : '　正确答案：' + esc(expectedDisp.join(''))) + '</div>';
    }
  }

  h += '<div class="toolbar toolbar--top">' +
    '<button class="btn" data-act="e-prev"' + (e.idx === 0 ? ' disabled' : '') + '>← 上一题</button>' +
    '<button class="btn" data-act="e-next"' + (e.idx >= e.list.length - 1 ? ' disabled' : '') + '>下一题 →</button>' +
    '</div></div></div>'; /* card, p-left */

  /* 右侧：答题卡（考试中不显示对错，只显示作答状态） */
  h += '<div class="p-right"><div class="card"><div class="card-title">答题卡</div>' +
    '<div class="ans-grid">' + e.list.map((qq, i) => {
      const done = (e.answers[qq.id] || []).length > 0;
      return '<div class="ans-cell' + (done ? ' done' : '') + (i === e.idx ? ' current' : '') + '" data-act="e-go" data-id="' + i + '">' + (i + 1) + '</div>';
    }).join('') + '</div>' +
    '<div class="ans-stats">' +
    '<div class="ans-stat"><span class="dot" style="background:var(--primary)"></span>已答: <b>' + doneCount + '</b> 题</div>' +
    '<div class="ans-stat">剩余: <b class="c-orange">' + (e.list.length - doneCount) + '</b> 题</div>' +
    '<div class="ans-stat">共 ' + e.list.length + ' 题</div>' +
    '</div>' +
    '<div class="mt-3"><button class="btn btn-primary btn-block" data-act="e-submit">交卷</button></div>' +
    '<div class="note mt-2">提示：交卷后才能看到正确答案与解析</div>' +
    '</div></div></div>'; /* p-right, practice-layout */
  return h;
}

async function submitExam(auto) {
  const e = state.e;
  saveExamInput();
  const answers = e.list.map(q => ({ question_id: q.id, answer: eOrigAnswer(q, e.answers[q.id] || '') }));
  const used = Math.round((Date.now() - e.startedAt) / 1000);
  const d = await api('exam_submit', {
    bank_id: e.bankId, name: '模拟考试', duration: e.minutes, used_seconds: used, answers,
    show_analysis: (e.showAnalysis === false ? 0 : 1)
  });
  d.detail = d.detail || [];
  d.show_analysis = (e.showAnalysis === false ? 0 : 1);
  stopTimer();
  e.result = d;
  e.result.used = used;
  render();
  if (auto) toast('考试时间到，已自动交卷');
}

function examResultHtml() {
  const r = state.e.result;
  const detail = r.detail || [];
  const showAns = (r.show_analysis === undefined || r.show_analysis === null) ? 1 : (r.show_analysis ? 1 : 0);
  let right = 0, wrong = 0, pending = 0;
  detail.forEach(d => {
    if (d.correct === 1 || d.correct === true) right++;
    else if (d.correct === 0 || d.correct === false) wrong++;
    else pending++;
  });
  const acc = (right + wrong) ? Math.round(right / (right + wrong) * 10000) / 100 : 0;

  let h = '<div class="page-head"><div><h2 class="page-title">考试成绩</h2></div>' +
    '<button class="btn" data-act="e-back">返回</button></div>';

  h += '<div class="practice-layout exam-layout"><div class="p-left">';
  h += '<div class="card text-center">' +
    '<div class="score-hero ' + (r.score >= 60 ? 'c-green' : 'c-red') + '">' + r.score + '</div>' +
    '<div class="page-sub">答对 ' + right + ' / ' + detail.length + ' 题　用时 ' + fmtTime(r.used) + '</div>' +
    '<button class="btn btn-primary mt-3" data-act="e-again">再来一次</button></div>';

  h += '<div class="card"><div class="card-title">答题详情</div>';
  detail.forEach((d, i) => {
    const q = state.e.list.find(x => x.id === d.question_id);
    if (!q) return;
    const userTxt = eDispAnswer(q, d.user);
    const expTxt = eDispAnswer(q, d.expected);
    h += '<div class="q-item" id="ans-' + i + '"><div class="q-head"><div class="q-stem">' + (i + 1) + '. <span class="tag tag-blue">' + TYPES[q.type] + '</span> ' + rt(q.stem) + '</div>' +
      (d.correct === null ? '<span class="tag tag-orange">待自评</span>' : (d.correct ? '<span class="tag tag-green">正确</span>' : '<span class="tag tag-red">错误</span>')) +
      '</div><div class="q-meta"><span>你的答案：' + esc(userTxt || '（未答）') + '</span>' +
      (showAns ? '<span>正确答案：' + esc(expTxt) + '</span>' : '<span class="tag">本次考试不显示答案</span>') +
      (d.correct === null ? '<button class="btn btn-sm btn-success" data-act="e-self" data-id="' + q.id + '">自评正确</button>' : '') + '</div>' +
      (showAns && q.analysis ? '<div class="q-analysis">解析：' + rt(q.analysis) + '</div>' : '') + '</div>';
  });
  h += '</div></div>'; /* p-left */

  /* 右侧：答题卡（绿=对、红=错、橙=待自评），点击跳到对应题目 */
  h += '<div class="p-right"><div class="card"><div class="card-title">答题卡</div>' +
    '<div class="ans-grid">' + detail.map((d, i) => {
      let cls = '';
      if (d.correct === 1 || d.correct === true) cls = ' right';
      else if (d.correct === 0 || d.correct === false) cls = ' wrong';
      else cls = ' pending';
      return '<a class="ans-cell' + cls + '" href="#ans-' + i + '">' + (i + 1) + '</a>';
    }).join('') + '</div>' +
    '<div class="ans-stats">' +
    '<div class="ans-stat"><span class="dot dot-g"></span>答对: <b class="c-green">' + right + '</b> 题</div>' +
    '<div class="ans-stat"><span class="dot dot-r"></span>答错: <b class="c-red">' + wrong + '</b> 题</div>' +
    '<div class="ans-stat">正确率: <b>' + acc + '%</b></div>' +
    (pending ? '<div class="ans-stat">待自评: <b class="c-orange">' + pending + '</b> 题</div>' : '') +
    '</div></div></div></div>'; /* p-right, practice-layout */
  return h;
}

/* ---------------- 错题本 ---------------- */
const WTYPE_STYLE = {
  single:   { bg: '#2563eb', ch: '单' },
  multiple: { bg: '#16a34a', ch: '多' },
  judge:    { bg: '#d97706', ch: '判' },
  blank:    { bg: '#7c3aed', ch: '填' },
  essay:    { bg: '#0d9488', ch: '答' }
};

function viewWrong() {
  if (state.w.bankId > 0) return wrongDetailHtml();
  return wrongBanksHtml();
}

/** 错题本一级：按题库分类 */
function wrongBanksHtml() {
  let h = '<div class="page-head"><div><h2 class="page-title">错题本</h2>' +
    '<div class="page-sub">按题库查看错题，答对一次后自动移出</div></div>' +
    '<div><button class="btn" data-act="w-reload">刷新</button> ' +
    '<button class="btn btn-danger" data-act="w-clear">清空全部错题</button></div></div>';
  h += '<div class="card">';
  if (!state.w.loaded) {
    h += loadingHTML();
  } else if (!state.w.banks.length) {
    h += '<div class="empty"><div class="big">' + icon('trophy', 40) + '</div>暂无错题，保持住</div>';
  } else {
    h += '<div class="bank-grid">';
    state.w.banks.forEach(b => {
      h += '<div class="bank-card" data-act="w-open-bank" data-id="' + b.bank_id + '">' +
        '<h4>' + esc(b.name) + '</h4>' +
        '<p>有 ' + b.c + ' 道题待重新练习</p>' +
        '<div class="foot"><span class="nowrap"><b class="c-red">' + b.c + '</b> 道错题</span>' +
        '<span class="nowrap"><button class="btn btn-sm btn-primary" data-act="w-open-bank" data-id="' + b.bank_id + '">进入</button></span></div></div>';
    });
    h += '</div>';
  }
  return h + '</div>';
}

/** 错题本二级：题库内的题型分类卡片 + 错题列表 */
function wrongDetailHtml() {
  const b = state.banks.find(x => x.id === state.w.bankId) || { name: '题库' };
  let h = '<div class="page-head"><div><h2 class="page-title">' + esc(b.name) + ' · 错题</h2>' +
    '<div class="page-sub">选择题型开始练习，或直接浏览下方错题列表</div></div>' +
    '<div><button class="btn" data-act="w-back">← 返回错题本</button> ' +
    '<button class="btn" data-act="w-reload">刷新</button> ' +
    '<button class="btn btn-danger" data-act="w-clear-bank">清空本题库错题</button></div></div>';

  h += '<div class="card"><div class="card-title">题型分类</div>';
  if (!state.w.types || !state.w.types.length) {
    h += '<div class="empty empty--sm">该题库暂无错题</div>';
  } else {
    h += '<div class="wtype-grid">';
    state.w.types.forEach(t => {
      const st = WTYPE_STYLE[t.type] || { bg: '#6b7280', ch: '?' };
      h += '<div class="wtype-card"><div class="wtype-icon" style="background:' + st.bg + '">' + st.ch + '</div>' +
        '<div class="info"><b>' + TYPES[t.type] + '</b><span>' + t.c + ' 道错题</span></div>' +
        '<button class="btn btn-sm btn-primary" data-act="w-practice-type" data-id="' + t.type + '">练习</button></div>';
    });
    h += '</div>';
    const total = state.w.types.reduce((a, t) => a + t.c, 0);
    h += '<div class="toolbar toolbar--top"><span class="spacer"></span>' +
      '<button class="btn" data-act="w-practice-all">全部练习（' + total + ' 题）</button></div>';
  }
  h += '</div>';

  h += '<div class="card"><div class="card-title">错题列表（' + state.w.list.length + ' 道）</div>';
  if (!state.w.list.length) {
    h += '<div class="empty empty--sm">暂无错题</div>';
  } else {
    state.w.list.forEach(q => {
      const ans = (q.answer || []).join('');
      h += '<div class="q-item"><div class="q-head"><div class="q-stem">' +
        '<span class="tag tag-blue">' + TYPES[q.type] + '</span> ' + rt(q.stem) + '</div>' +
        '<button class="btn btn-sm" data-act="w-practice" data-id="' + q.id + '">重做</button> ' +
        '<button class="btn btn-sm btn-danger" data-act="w-remove" data-id="' + q.id + '">移除</button></div>';
      (q.options || []).forEach(o => {
        h += '<div class="q-opt' + (ans.indexOf(o.key) >= 0 ? ' correct' : '') + '">' + esc(o.key) + '. ' + rt(o.text) + '</div>';
      });
      if (q.type === 'blank' || q.type === 'essay') {
        h += '<div class="q-opt correct">参考答案：' + esc((q.answer || []).join(' / ')) + '</div>';
      }
      const need = q.streak_need || 1;
      const got = q.right_streak || 0;
      h += '<div class="q-meta"><span>正确答案：<b>' + esc(ans) + '</b></span>' +
        '<span>累计练习 ' + (q.done_count || 0) + ' 次</span>' +
        '<span class="tag tag-orange">还需连续答对 ' + Math.max(0, need - got) + ' 次（目标 ' + need + '）</span>' +
        (q.flagged ? '<span class="tag">已标记</span>' : '') + '</div>';
      if (q.analysis) h += '<div class="q-analysis">解析：' + rt(q.analysis) + '</div>';
      h += '</div>';
    });
    h += pagerBar(state.w.total, state.w.page, 50, 'w-page');
  }
  return h + '</div>';
}

async function loadWrong() {
  if (state.w.bankId > 0) {
    const d = await api('wrong_list', { bank_id: state.w.bankId, page: state.w.page, page_size: 50 });
    let t = [];
    try { t = await api('wrong_types', { bank_id: state.w.bankId }); } catch (e) { /* 忽略 */ }
    state.w.list = d.list || [];
    state.w.total = d.total || 0;
    state.w.streakNeed = d.streak_need || 1;
    state.w.types = t;
    state.w.loaded = true;
  } else {
    state.w.banks = await api('wrong_banks');
    state.w.loaded = true;
  }
  if (state.view === 'wrong') render();
}

/** 拉取某题库的全部错题（跨分页，最大 200/页，循环翻页直到取完） */
async function fetchWrongQuestions(bankId) {
  const all = [];
  let page = 1;
  while (true) {
    const d = await api('wrong_list', { bank_id: bankId, page: page, page_size: 200 });
    const list = d.list || [];
    for (const q of list) all.push(q);
    if (list.length === 0 || all.length >= (d.total || 0)) break;
    page++;
  }
  return all;
}

async function startWrongPractice(list) {
  if (!list.length) return toast('没有可练习的错题');
  state.p.bankId = list[0].bank_id;
  state.p.mode = 'order';
  state.p.list = list.slice();
  state.p.idx = 0;
  state.p.q = null;
  state.p.picked = [];
  state.p.answered = false;
  state.p.result = null;
  state.p.expected = '';
  state.p.expectedDisp = null;
  state.p.results = new Array(list.length).fill(null);
  state.p.optCache = {};
  state.view = 'practice';
  document.querySelectorAll('[data-nav]').forEach(n => n.classList.toggle('active', n.dataset.nav === 'practice'));
  loadPracticeQuestion();
}

/* ---------------- 统计 ---------------- */
async function loadStats() {
  const s = await api('stats');
  let h = '<div class="page-head"><div><h2 class="page-title">学习统计</h2></div></div>';
  h += '<div class="stat-grid">' +
    card(s.total_questions, '题目总数') + card(s.total_done, '累计答题') +
    card(s.accuracy + '%', '总正确率') + card(s.wrong_count, '错题数') +
    card(s.exam_count, '考试次数') + card(s.avg_score, '考试平均分') + '</div>';

  h += '<div class="card"><div class="card-title">近 14 天答题量</div><div class="bars">' +
    s.daily.map(d => {
      const max = Math.max(1, ...s.daily.map(x => x.count));
      const hgt = Math.round(d.count / max * 110);
      return '<div style="flex:1"><div class="bar" style="height:' + hgt + 'px"><span>' + (d.count || '') + '</span></div>' +
        '<div class="bar-label">' + d.date.slice(5) + '</div></div>';
    }).join('') + '</div></div>';

  h += '<div class="card"><div class="card-title">题型分布</div>';
  const typeTotal = Object.values(s.by_type).reduce((a, b) => a + b, 0) || 1;
  Object.keys(s.by_type).forEach(k => {
    const pct = Math.round(s.by_type[k] / typeTotal * 100);
    h += '<div class="mb-2"><div class="row-line"><span>' + TYPES[k] + '</span>' +
      '<span class="spacer"></span><span class="muted">' + s.by_type[k] + ' 题（' + pct + '%）</span></div>' +
      '<div class="progress-bar mt-1"><i style="width:' + pct + '%"></i></div></div>';
  });
  h += '</div>';

  h += '<div class="card"><div class="card-title">各题库题量</div>';
  s.banks.forEach(b => {
    const pct = s.total_questions ? Math.round(b.qcount / s.total_questions * 100) : 0;
    h += '<div class="mb-2"><div class="row-line"><span>' + esc(b.name) + '</span>' +
      '<span class="spacer"></span><span class="muted">' + b.qcount + ' 题</span></div>' +
      '<div class="progress-bar mt-1"><i style="width:' + pct + '%"></i></div></div>';
  });
  h += '</div>';
  $('#view').innerHTML = h;
}
function card(num, label) {
  return '<div class="stat-card"><div class="num">' + esc(num) + '</div><div class="label">' + label + '</div></div>';
}

/* ---------------- 动作表 ---------------- */
const ACTIONS = {
  'theme-toggle': () => toggleTheme(),
  /* 题库 */
  'bank-new': () => {
    modal('新建题库',
      '<div class="field"><label>题库名称</label><input class="input" id="b-name" placeholder="如：会计基础"><div class="field-error" id="b-name-err"></div></div>' +
      '<div class="field"><label>描述（可选）</label><input class="input" id="b-desc"></div>' +
      '<div class="ai-hint">创建后会直接进入该题库，可立刻新增题目、批量导入或 AI 导入。</div>',
      '<button class="btn" data-close>取消</button><button class="btn btn-primary" id="b-save">创建并进入</button>');
    const submit = async () => {
      const nameEl = $('#b-name');
      const errEl = $('#b-name-err');
      const name = (nameEl.value || '').trim();
      if (!name) {
        nameEl.classList.add('is-error');
        if (errEl) { errEl.textContent = '请输入题库名称'; errEl.classList.add('show'); }
        nameEl.focus();
        return;
      }
      nameEl.classList.remove('is-error');
      if (errEl) errEl.classList.remove('show');
      try {
        const d = await api('bank_create', { name: name, description: ($('#b-desc').value || '').trim() });
        closeModal();
        await loadBanks();
        toast('已创建：' + name);
        // 创建后直接打开新题库，省掉一步点击
        if (d && d.id) ACTIONS['bank-open'](d.id);
        else render();
      } catch (e) {
        toast('创建失败：' + (e && e.message ? e.message : e), 'error');
      }
    };
    $('#b-save').onclick = submit;
    const nameEl = $('#b-name');
    if (nameEl) {
      nameEl.focus();
      nameEl.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); submit(); } };
    }
  },
  'bank-open': (id) => {
    state.bankId = +id;   // 统一成数字：接口返回的 id 可能是字符串，而列表里是数字
    state.q = { list: [], total: 0, page: 1, size: 20, type: '', keyword: '', checked: new Set() };
    state.view = 'questions';
    document.querySelectorAll('[data-nav]').forEach(n => n.classList.toggle('active', n.dataset.nav === 'banks'));
    loadQuestions();
  },
  'bank-edit': async (id) => {
    const b = state.banks.find(x => x.id === id);
    modal('编辑题库',
      '<div class="field"><label>名称</label><input class="input" id="b-name" value="' + esc(b.name) + '"></div>' +
      '<div class="field"><label>描述</label><input class="input" id="b-desc" value="' + esc(b.description || '') + '"></div>',
      '<button class="btn" data-close>取消</button>' +
      '<button class="btn btn-danger" id="b-del">删除题库</button>' +
      '<button class="btn btn-primary" id="b-save">保存</button>');
    $('#b-save').onclick = async () => {
      await api('bank_update', { id, name: $('#b-name').value.trim(), description: $('#b-desc').value.trim() });
      closeModal(); await loadBanks(); render(); toast('已保存');
    };
    $('#b-del').onclick = () => confirmBox('删除题库', '将同时删除该题库下的所有题目，确定吗？', async () => {
      await api('bank_delete', { id });
      await loadBanks(); render(); toast('已删除');
    });
  },
  'q-back': () => switchView('banks'),
  'logout': () => {
    api('logout').catch(() => {});
    resetUserState();               // 彻底清空，避免下个账号看到上一个账号的设置/题库
    renderUserBox();
    renderAuth();
  },

  /* 设置 */
  'st-save': async () => {
    const n = Math.max(1, Math.min(10, +($('#st-streak').value || 1)));
    const s = await api('save_settings', { wrong_streak: n });
    state.settings = s;
    toast('已保存：连续答对 ' + n + ' 次移出错题本');
    render();
  },
  'st-pass': async () => {
    const oldEl = $('#sp-old'), newEl = $('#sp-new');
    const oldErr = $('#sp-old-err'), newErr = $('#sp-new-err');
    const old = oldEl.value, np = newEl.value;
    let ok = true;
    if (!old) { oldEl.classList.add('is-error'); oldErr.textContent = '请输入原密码'; oldErr.classList.add('show'); ok = false; }
    else { oldEl.classList.remove('is-error'); oldErr.classList.remove('show'); }
    if (!np) { newEl.classList.add('is-error'); newErr.textContent = '请输入新密码'; newErr.classList.add('show'); ok = false; }
    else if (np.length < 6) { newEl.classList.add('is-error'); newErr.textContent = '新密码至少 6 位'; newErr.classList.add('show'); ok = false; }
    else { newEl.classList.remove('is-error'); newErr.classList.remove('show'); }
    if (!ok) return;
    try {
      await api('change_password', { old_password: old, new_password: np });
      oldEl.value = ''; newEl.value = '';
      oldEl.classList.remove('is-error'); newEl.classList.remove('is-error');
      oldErr.classList.remove('show'); newErr.classList.remove('show');
      toast.success('密码已修改');
    } catch (e) {
      toast.error(e.message || '密码修改失败');
    }
  },

  /* 回收站 */
  'trash-reload': () => loadTrash(),
  'trash-restore': async (id) => {
    await api('trash_restore', { type: 'bank', id });
    await loadTrash(); await loadBanks(); toast('已恢复题库');
  },
  'trash-purge': (id) => confirmBox('彻底删除', '题库及其所有题目将被永久删除，不可恢复。确定吗？', async () => {
    await api('trash_purge', { type: 'bank', id });
    await loadTrash(); await loadBanks(); toast('已彻底删除');
  }),
  'trash-restore-q': async (id) => {
    await api('trash_restore', { type: 'question', id });
    await loadTrash(); toast('已恢复题目');
  },
  'trash-purge-q': (id) => confirmBox('彻底删除', '题目将被永久删除（含答题记录），不可恢复。确定吗？', async () => {
    await api('trash_purge', { type: 'question', id });
    await loadTrash(); toast('已彻底删除');
  }),

  /* 分页 */
  'market-page': (p) => { state.marketPage = p; loadMarket(); },
  'banks-page': (p) => { state.banksPage = p; render(); },
  'admin-bank-page': (p) => { state.a = state.a || {}; state.a.bankPage = p; loadAdmin(); },
  'trash-q-page': (p) => { state.t.qPage = p; loadTrash(); },

  /* 管理后台 */
  'admin-reload': () => loadAdmin(),
  'admin-user-banks': async (id) => {
    const list = await api('admin_user_banks', { user_id: id });
    const u = (state.a.users || []).find(x => x.id === id) || {};
    let body = '<div class="muted mb-2">用户：' + esc(u.nickname || u.username || id) + '</div>';
    if (!list.length) {
      body += '<div class="empty empty--sm">该用户还没有题库</div>';
    } else {
      body += '<table class="tbl"><tr><th>ID</th><th>题库名</th><th>题数</th><th>关系</th><th>状态</th></tr>';
      list.forEach(b => {
        body += '<tr><td>' + b.id + '</td><td>' + esc(b.name) + '</td><td>' + b.qcount + '</td>' +
          '<td>' + (b.role === 'owner' ? '本人上传' : '从市场添加') + '</td>' +
          '<td>' + (b.is_public == 1 ? '<span class="tag tag-green">已公开</span>' : '<span class="tag">私有</span>') + '</td></tr>';
      });
      body += '</table>';
    }
    modal('用户题库', body, '<button class="btn" data-close>关闭</button>');
  },
  'admin-user-pass': (id) => {
    const u = (state.a.users || []).find(x => x.id === id) || {};
    modal('修改密码',
      '<div class="field"><label>用户：' + esc(u.username || id) + '（' + esc(u.nickname || '') + '）</label>' +
      '<input class="input" id="ap-pass" type="password" placeholder="新密码（至少 6 位）"></div>',
      '<button class="btn" data-close>取消</button><button class="btn btn-primary" id="ap-save">保存</button>');
    $('#ap-save').onclick = async () => {
      const p = ($('#ap-pass').value || '').trim();
      if (p.length < 6) return toast('新密码至少 6 位');
      await api('admin_set_password', { user_id: id, password: p });
      closeModal(); toast('密码已更新');
    };
  },
  'admin-user-del': (id) => {
    const u = (state.a.users || []).find(x => x.id === id) || {};
    confirmBox('删除用户', '将删除用户「' + (u.username || id) + '」及其上传的题库、题目、答题记录和考试记录，且不可恢复。确定吗？', async () => {
      await api('admin_delete_user', { user_id: id });
      await loadAdmin(); toast('已删除用户');
    });
  },
  'admin-bank-open': (id) => {
    const b = (state.a.banks || []).find(x => x.id === id);
    if (!b) return;
    // 管理员以「可编辑」身份打开任意题库
    state.banks = state.banks.filter(x => x.id !== id);
    state.banks.push(Object.assign({}, b, { role: 'owner' }));
    state.bankId = id;
    state.q = { list: [], total: 0, page: 1, size: 20, type: '', keyword: '', checked: new Set() };
    state.view = 'questions';
    document.querySelectorAll('[data-nav]').forEach(n => n.classList.toggle('active', n.dataset.nav === 'banks'));
    loadQuestions();
  },
  'admin-bank-publish': (id) => ACTIONS['bank-publish'](id),
  'admin-bank-del': (id) => {
    const b = (state.a.banks || []).find(x => x.id === id) || {};
    confirmBox('删除题库', '将删除题库「' + (b.name || id) + '」及其下所有题目，且不可恢复。确定吗？', async () => {
      await api('bank_delete', { id });
      await loadAdmin(); await loadBanks(); toast('已删除题库');
    });
  },

  /* 题库市场 */
  'market-reload': () => loadMarket(),
  'market-add': (id) => {
    const b = state.market.find(x => x.id === id);
    if (!b) return;
    if (!b.has_password) {
      return doAddBank(id, '');
    }
    modal('需要提取密码',
      '<div class="field"><label>题库「' + esc(b.name) + '」设置了提取密码</label>' +
      '<input class="input" id="mk-pass" type="password" placeholder="请输入提取密码"></div>',
      '<button class="btn" data-close>取消</button><button class="btn btn-primary" id="mk-ok">添加</button>');
    $('#mk-ok').onclick = () => doAddBank(id, ($('#mk-pass').value || ''));
  },
  'bank-remove-mine': (id) => confirmBox('移除题库', '从「我的题库」中移除这个题库？题库本身不会被删除。', async () => {
    await api('bank_remove_mine', { id });
    await loadBanks(); render(); toast('已移除');
  }),
  'bank-publish': (id) => {
    const b = state.banks.find(x => x.id === id);
    if (!b) return;
    const pub = b.is_public == 1;
    modal('发布到题库市场',
      '<div class="setting-row"><span>公开这个题库（其他用户可在市场看到并添加）</span>' +
      '<label class="switch"><input type="checkbox" id="pb-on"' + (pub ? ' checked' : '') + '><span class="slider"></span></label></div>' +
      '<div class="field mt-2"><label>提取密码（留空表示无需密码）</label>' +
      '<input class="input" id="pb-pass" value="' + esc(b.share_password || '') + '" placeholder="可留空"></div>' +
      '<div class="field"><label>简介（展示在市场卡片上）</label>' +
      '<input class="input" id="pb-desc" value="' + esc(b.share_desc || '') + '" placeholder="如：HCIE 数通真题，含图"></div>' +
      '<div class="note">注意：别人添加后只能查看和练习，编辑/删除权限仍然只属于你。</div>',
      '<button class="btn" data-close>取消</button>' +
      (pub ? '<button class="btn btn-danger" id="pb-off">取消发布</button>' : '') +
      '<button class="btn btn-primary" id="pb-save">保存</button>');
    $('#pb-save').onclick = async () => {
      if (!$('#pb-on').checked) {
        await api('bank_unpublish', { id });
      } else {
        await api('bank_publish', { id, password: ($('#pb-pass').value || '').trim(), desc: ($('#pb-desc').value || '').trim() });
      }
      closeModal(); await loadBanks(); render(); toast('已保存');
    };
    const off = $('#pb-off');
    if (off) off.onclick = async () => {
      await api('bank_unpublish', { id });
      closeModal(); await loadBanks(); render(); toast('已取消发布');
    };
  },
  'q-new': () => {
    modal('新增题目', editorHtml(null),
      '<button class="btn" data-close>取消</button><button class="btn btn-primary" id="q-save">保存</button>');
    bindEditor();
    $('#q-save').onclick = saveQuestion;
  },
  'q-edit': async (id) => {
    const q = await api('question_get', { id });
    modal('编辑题目', editorHtml(q),
      '<button class="btn" data-close>取消</button><button class="btn btn-primary" id="q-save">保存</button>');
    bindEditor();
    $('#q-save').onclick = saveQuestion;
  },
  'q-del': (id) => confirmBox('删除题目', '确定删除这道题吗？', async () => {
    await api('question_delete', { id }); loadQuestions(); toast('已删除');
  }),
  'q-del-checked': () => {
    if (!state.q.checked.size) return toast('请先勾选题目');
    confirmBox('批量删除', '将删除选中的 ' + state.q.checked.size + ' 道题', async () => {
      await api('question_batch_delete', { ids: [...state.q.checked] });
      state.q.checked = new Set(); loadQuestions(); toast('已删除');
    });
  },
  'q-search': () => {
    state.q.keyword = ($('#f-kw') || {}).value || '';
    state.q.type = ($('#f-type') || {}).value || '';
    state.q.page = 1; loadQuestions();
  },
  'q-page': (p) => { state.q.page = p; loadQuestions(); },

  /* AI 导题库 */
  'ai-import-open': () => aiImportOpen(),
  'ai-save': async () => {
    const base = ($('#ai-base') || {}).value || '';
    const key = (($('#ai-key') || {}).value || '').trim();
    const model = ($('#ai-model') || {}).value || '';
    const payload = { base: base, model: model };
    if (key !== '') payload.key = key;   // 留空 = 不修改（Key 不回显，也不清空）
    const d = await api('ai_config_save', payload);
    state.settings = state.settings || {};
    state.settings.ai_base = base;
    state.settings.ai_model = model;
    state.settings.ai_key_set = !!(d && d.has_key);
    render();
    if (d && d.has_key) toast(key !== '' ? 'AI 配置已保存' : '已保存（Key 保持不变）');
    else toast('已保存，但还没配置 API Key，AI 导入暂不可用');
  },
  'ai-clear-key': () => confirmBox('清除 API Key',
    '将从你的账号中删除已保存的 API Key，AI 导入会立即不可用（题库和题目不受影响）。确定吗？', async () => {
      const d = await api('ai_config_save', { clear_key: 1 });
      state.settings = state.settings || {};
      state.settings.ai_key_set = !!(d && d.has_key);
      render();
      toast('已清除 API Key');
    }),
  'ai-test': async () => {
    const box = $('#ai-test-msg');
    if (box) box.innerHTML = '<span class="muted">正在测试连接…</span>';
    try {
      await api('ai_config_test', {
        base: ($('#ai-base') || {}).value || '',
        key: ($('#ai-key') || {}).value || '',
        model: ($('#ai-model') || {}).value || '',
      });
      if (box) box.innerHTML = '<span class="c-green">' + icon('check', 14) + ' 连接成功，接口可用</span>';
    } catch (e) {
      if (box) box.innerHTML = '<span class="c-red">' + icon('x', 14) + ' ' + esc(e.message || '连接失败') + '</span>';
    }
  },
  'import-open': () => {
    // 只在题库内部的题目页使用，导入目标就是当前题库
    if (!(state.view === 'questions' && state.bankId > 0)) return toast('请先进入要导入的题库');
    if (!bankEditable(state.bankId)) return toast('只有题库上传者本人可以导入题目');
    modal('批量导入题目', importHtml(),
      '<button class="btn" data-close>取消</button>' +
      '<button class="btn" id="i-parse">解析预览</button>' +
      '<button class="btn btn-primary" id="i-commit" style="display:none">确认导入</button>');
    bindImport();
  },
  'export-open': () => {
    modal('导出题库',
      '<div class="field"><label>导出格式</label><select class="select" id="x-fmt">' +
      '<option value="txt">纯文本（可再次导入）</option><option value="csv">CSV（Excel 可打开）</option>' +
      '<option value="json">JSON（备份/迁移）</option></select></div>',
      '<button class="btn" data-close>取消</button><button class="btn btn-primary" id="x-go">导出</button>');
    $('#x-go').onclick = () => {
      window.location.href = API + '?action=export&bank_id=' + state.bankId + '&format=' + $('#x-fmt').value;
      closeModal();
    };
  },

  /* 练习 */
  'p-start': () => startPractice(),
  'p-pick': (id, el) => {
    const p = state.p, k = el.dataset.key;
    if (p.answered || p.settings.recite) return;
    if (p.q.type === 'multiple') {
      const i = p.picked.indexOf(k);
      if (i >= 0) p.picked.splice(i, 1); else p.picked.push(k);
    } else {
      p.picked = [k];
    }
    // 「点击选项立即判分」：单选/判断点一下就是完整答案，直接提交判分
    if (p.settings.instant && (p.q.type === 'single' || p.q.type === 'judge')) {
      return submitPractice();
    }
    markPracticeOptions();
  },
  'p-submit': () => submitPractice(),
  'p-flag': async () => {
    const p = state.p;
    if (!p.q) return;
    try {
      const r = await api('flag_toggle', { question_id: p.q.id });
      p.flagged = !!r.flagged;
      p.q.flagged = p.flagged;
      if (state.w.list && state.w.list.length) {
        const w = state.w.list.find(x => x.id === p.q.id);
        if (w) w.flagged = p.flagged;
      }
      render();
      toast(p.flagged ? '已标记为疑问题' : '已取消标记');
    } catch (e) { /* 已提示 */ }
  },
  'p-prev': () => {
    const p = state.p;
    if (p.idx > 0) { p.idx--; loadPracticeQuestion(); }
  },
  'p-go': (i) => {
    if (i !== state.p.idx) { state.p.idx = i; loadPracticeQuestion(); }
  },
  'p-restart': () => {
    const p = state.p;
    p.results = new Array(p.list.length).fill(null);
    p.idx = 0;
    p.optCache = {};
    loadPracticeQuestion();
    toast('已重新开始本组练习');
  },
  'p-self': (ok) => {
    const p = state.p;
    const r = p.results[p.idx] || { picked: p.picked.slice(), expectedDisp: null, expected: (p.q.answer || []).join(' / ') };
    r.correct = !!ok;
    p.results[p.idx] = r;
    p.result = !!ok;
    api('record_answer', { question_id: p.q.id, user_answer: p.picked[0], mode: 'practice', self_ok: ok ? 1 : 0 });
    render();
    if (ok && p.settings.autoNext && p.idx + 1 < p.list.length) {
      setTimeout(() => {
        if (state.p.idx === p.idx && state.p.answered) { state.p.idx++; loadPracticeQuestion(); }
      }, 700);
    }
  },
  'p-next': () => {
    const p = state.p;
    if (p.idx + 1 >= p.list.length) {
      const c = practiceCounts();
      toast('本次练习完成：答对 ' + c.right + ' 题，答错 ' + c.wrong + ' 题，正确率 ' + c.acc + '%');
      p.list = []; p.q = null; p.results = []; p.optCache = {};
      return render();
    }
    p.idx++; loadPracticeQuestion();
  },
  'p-quit': () => { state.p.list = []; state.p.q = null; state.p.results = []; state.p.optCache = {}; render(); },

  /* 考试 */
  'e-start': () => startExam(),
  'e-pick': (id, el) => {
    const e = state.e, q = e.list[e.idx], k = el.dataset.key;
    const isChoice = q.type === 'single' || q.type === 'multiple' || q.type === 'judge';
    // 单选/判断判过分即锁定；多选可继续调整
    if (e.instant && e.instantRes[q.id] && q.type !== 'multiple') return;
    let arr = e.answers[q.id] || [];
    if (q.type === 'multiple') {
      const i = arr.indexOf(k);
      if (i >= 0) arr.splice(i, 1); else arr.push(k);
    } else {
      arr = [k];
    }
    e.answers[q.id] = arr;
    // 「点击选项立即判分」：点一下即出对错（仅前端提示，交卷仍按答案统一判分）
    if (e.instant && isChoice) {
      const expected = (q.answer || []).map(String).slice().sort().join(',');
      const got = eOrigAnswer(q, arr).map(String).slice().sort().join(',');
      e.instantRes[q.id] = { correct: expected === got };
      return render();
    }
    markExamOptions();
  },
  'e-prev': () => { const e = state.e; saveExamInput(); if (e.idx > 0) { e.idx--; loadExamQuestion(); } },
  'e-next': () => { const e = state.e; saveExamInput(); if (e.idx < e.list.length - 1) { e.idx++; loadExamQuestion(); } },
  'e-go': (i) => { saveExamInput(); if (i !== state.e.idx) { state.e.idx = i; loadExamQuestion(); } },
  'e-submit': () => confirmBox('交卷', '确定现在交卷吗？', () => submitExam(false)),
  'e-self': async (qid) => {
    const r = await api('exam_selfcheck', { exam_id: state.e.result.id, question_id: qid, correct: 1 });
    state.e.result.score = r.score; state.e.result.right = r.right;
    const d = state.e.result.detail.find(x => x.question_id === qid);
    if (d) d.correct = 1;
    render(); toast('已自评');
  },
  'e-back': () => { state.e.result = null; state.e.list = []; render(); loadExamHistory(); },
  'e-again': () => { state.e.result = null; state.e.list = []; render(); },
  'e-detail': async (id) => {
    const list = await api('exam_list');
    const ex = list.find(x => x.id === id);
    if (!ex) return;
    state.e.result = { id: ex.id, score: ex.score, right: ex.right_count, total: ex.total, used: ex.used_seconds, detail: ex.detail };
    state.e.list = [];
    // 历史记录按原始选项顺序展示（不套用本次考试的乱序设置）
    state.e.shuffle = false;
    state.e.optCache = {};
    for (const d of ex.detail) {
      const exists = state.e.list.find(x => x.id === d.question_id);
      if (!exists) {
        try {
          const q = await api('question_get', { id: d.question_id });
          state.e.list.push(q);
        } catch (e) { /* 题目可能已删除 */ }
      }
    }
    render();
  },
  'e-del': (id) => confirmBox('删除记录', '确定删除这条考试记录吗？', async () => {
    await api('exam_delete', { id }); loadExamHistory(); toast('已删除');
  }),

  /* 错题 */
  'w-reload': () => loadWrong(),
  'w-page': (p) => { state.w.page = p; loadWrong(); },
  'w-open-bank': (id) => {
    state.w.bankId = id;
    state.w.page = 1;
    state.w.loaded = false;
    state.w.list = [];
    state.w.types = [];
    loadWrong();
  },
  'w-back': () => {
    state.w.bankId = -1;
    state.w.page = 1;
    state.w.loaded = false;
    loadWrong();
  },
  'w-clear': () => confirmBox('清空错题本', '将清除所有题库的错题记录，题目本身不会删除。确定吗？', async () => {
    await api('wrong_clear', {}); state.w.bankId = -1; state.w.loaded = false; await loadWrong(); toast('已清空');
  }),
  'w-clear-bank': () => confirmBox('清空本题库错题', '将清除该题库的错题记录，题目本身不会删除。确定吗？', async () => {
    await api('wrong_clear', { bank_id: state.w.bankId });
    state.w.loaded = false; await loadWrong(); toast('已清空');
  }),
  'w-remove': (id) => {
    api('wrong_clear', { question_id: id }).then(() => {
      state.w.list = state.w.list.filter(x => x.id !== id);
      loadWrong();
      toast('已移出错题本');
    });
  },
  'w-practice': (id) => {
    const q = state.w.list.find(x => x.id === id);
    if (!q) return;
    startWrongPractice([q]);
  },
  'w-practice-type': async (id, el) => {
    const type = (el && el.dataset.id) || '';   // data-id 是题型字符串，分发器会转数字，必须从 el 取原文
    toast('正在准备错题…');
    const all = await fetchWrongQuestions(state.w.bankId);
    startWrongPractice(all.filter(x => x.type === type));
  },
  'w-practice-all': async () => {
    toast('正在准备错题…');
    const all = await fetchWrongQuestions(state.w.bankId);
    startWrongPractice(all);
  }
};

function saveExamInput() {
  const e = state.e, q = e.list[e.idx];
  if (!q) return;
  if (q.type === 'blank' || q.type === 'essay') {
    const el = $('#e-blank');
    if (el && el.value.trim()) e.answers[q.id] = [el.value.trim()];
  }
}

async function doAddBank(id, password) {
  try {
    await api('bank_add', { id, password });
    closeModal();
    toast('已添加到我的题库');
    await loadBanks();
    render();
  } catch (e) { /* api 内已提示 */ }
}

async function saveQuestion() {
  const data = collectEditor();
  if (!data.stem) return toast('题干不能为空');
  if (!data.answer.length) return toast('请填写答案');
  await api('question_save', data);
  closeModal();
  if (state.view === 'questions') loadQuestions(); else { await loadBanks(); render(); }
  toast('已保存');
}

/* ---------------- 初始化 ---------------- */
document.addEventListener('change', e => {
  if (e.target.id === 'p-bank' || e.target.id === 'e-bank') {
    refreshTypeCounts();
    return;
  }
  const s = e.target.closest('[data-set]');
  if (s) {
    const k = s.dataset.set;
    state.p.settings[k] = s.checked;
    if (k === 'shuffle') {
      // 重新生成所有题的选项顺序（当前未作答的题会重排）
      state.p.optCache = {};
      loadPracticeQuestion();
    } else if (k === 'recite') {
      if (!state.p.answered) { state.p.picked = []; state.p.result = null; state.p.expected = ''; state.p.expectedDisp = null; }
      render();
    }
    return;
  }
  const c = e.target.closest('[data-check]');
  if (c) {
    const id = +c.dataset.check;
    if (c.checked) state.q.checked.add(id); else state.q.checked.delete(id);
  }
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeModal();
  if (state.view === 'practice' && state.p.q) {
    if (e.key === 'Enter' && !state.p.answered && !state.p.settings.recite) { e.preventDefault(); submitPractice(); }
    else if (e.key === ' ' && (state.p.answered || state.p.settings.recite)) { e.preventDefault(); ACTIONS['p-next'](); }
  }
});

(async function init() {
  initDrawer();
  applyThemeIcon();
  let user = null;
  try {
    user = await api('me');
  } catch (e) {
    user = null;
  }
  if (!user || !user.csrf) {
    // me 可能因旧会话状态没返回 token，再取一次
    await refreshCsrf();
    try { user = await api('me'); } catch (e) { user = null; }
  }
  state.csrf = (user && user.csrf) || state.csrf || '';
  state.user = (user && user.id) ? user : null;
  if (!state.user) {
    renderUserBox();
    renderAuth();
    return;
  }
  state.settings = user.settings || { wrong_streak: 1 };
  renderUserBox();
  await loadBanks();
  render();
})();

window.__examHooks = { loadExamHistory };
