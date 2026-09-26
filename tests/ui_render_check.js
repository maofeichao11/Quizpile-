/**
 * 前端渲染自检（回归用）
 *
 * 本项目的页面是「JS 字符串拼 HTML」，很容易写出标签不闭合、或卡片宽度写死之类的低级问题。
 * 这个脚本给 app.js 套一层最小 DOM 桩，把每个页面渲染出来，检查：
 *   1) 渲染过程不抛异常
 *   2) <div> 开闭标签数量一致
 *   3) 表单卡统一使用 .form-grid、卡片内不再写死 max-width
 *
 * 用法（需要 Node.js）：
 *   node tests/ui_render_check.js            # 默认读 ../assets/app.js
 *   node tests/ui_render_check.js <app.js>   # 指定文件
 *
 * 失败时退出码为 1，可接入 CI。
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const file = process.argv[2] || path.join(__dirname, '..', 'assets', 'app.js');
const code = fs.readFileSync(file, 'utf8');

/* ---------------- 最小 DOM 桩 ---------------- */
function fakeEl() {
    return {
        style: {}, dataset: {}, files: [], value: '', checked: false, textContent: '', innerHTML: '',
        classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
        appendChild() {}, removeChild() {}, addEventListener() {}, removeEventListener() {},
        setAttribute() {}, getAttribute: () => null, insertAdjacentHTML() {},
        focus() {}, click() {}, remove() {}, scrollTo() {}, contains: () => false,
        querySelector: () => null, querySelectorAll: () => [], closest: () => null,
    };
}

const sandbox = {
    document: {
        querySelector: () => fakeEl(),
        querySelectorAll: () => [],
        createElement: () => fakeEl(),
        addEventListener: () => {},
        body: fakeEl(), documentElement: fakeEl(), getElementById: () => fakeEl(),
    },
    window: {
        addEventListener: () => {}, scrollTo: () => {},
        innerWidth: 1440, innerHeight: 900, location: { href: '', reload() {} },
    },
    fetch: () => Promise.resolve({
        ok: true, status: 200,
        text: () => Promise.resolve('{"ok":false,"error":"stub"}'),
        json: () => Promise.resolve({ ok: false }),
    }),
    FormData: function () {}, FileReader: function () {},
    console, setTimeout, clearTimeout, setInterval: () => 0, clearInterval: () => {},
    Math, Date, JSON, String, Number, Boolean, Array, Object, RegExp, Error, Promise, Set, Map,
    parseInt, parseFloat, isNaN, encodeURIComponent, decodeURIComponent,
};
sandbox.globalThis = sandbox;

// app.js 是 'use strict' 且用 const 声明 state，不会挂到 context 上，
// 所以在同一个作用域末尾追加一段导出垫片，才能真正拿到 state 和各 view 函数。
const shim = '\n;globalThis.__app = { state: state, viewBanks: viewBanks, viewMarket: viewMarket,'
    + ' viewSettings: viewSettings, viewPractice: viewPractice, viewExam: viewExam,'
    + ' viewWrong: viewWrong, viewTrash: viewTrash, viewAdmin: viewAdmin,'
    + ' viewQuestions: viewQuestions, historyRows: historyRows, pagerBar: pagerBar,'
    + ' typeRowsHtml: typeRowsHtml };\n';

const ctx = vm.createContext(sandbox);
try {
    vm.runInContext(code + shim, ctx, { filename: file });
} catch (e) {
    console.log('  FAIL  加载 app.js 失败: ' + e.message);
    process.exit(1);
}
const app = ctx.__app;
if (!app || !app.state) {
    console.log('  FAIL  没能取到 app 内部状态（垫片可能需要跟着 app.js 调整）');
    process.exit(1);
}

/* ---------------- 造点数据，页面才有内容可渲染 ---------------- */
const st = app.state;
st.user = { id: 1, username: 'admin', nickname: '管理员', is_admin: 1 };
st.csrf = 'x';
st.settings = { wrong_streak: 1, ai_key_set: true, ai_base: '', ai_model: '' };
st.banks = [
    { id: 5, name: 'hcie', qcount: 841, role: 'owner', description: 'HCIE', created_at: '2026-09-23' },
    { id: 6, name: '别人的题库', qcount: 12, role: 'member', owner_name: '张三' },
];
st.banksPage = 1;
st.market = [{ id: 5, name: 'hcie', qcount: 841, has_password: 1, owner_name: '管理员', added: 1, shared_at: '2026-09-23 14:00' }];
st.marketTotal = 1; st.marketPage = 1;
st.q = {
    list: [{ id: 1, type: 'single', stem: '题干', options: [{ key: 'A', text: '1' }], answer: ['A'] }],
    total: 1, page: 1, size: 20, type: '', keyword: '', checked: new Set(),
};
st.bankId = 5;
st.a = {
    users: [{ id: 1, username: 'admin', nickname: '管理员', is_admin: 1, bank_count: 1, question_count: 1, record_count: 1, exam_count: 1, created_at: '2026-09-23' }],
    banks: [{ id: 5, name: 'hcie', qcount: 841, is_public: 1, owner_name: '管理员' }],
    bankTotal: 1, bankPage: 1, bankSize: 20,
};
st.t = {
    banks: [{ id: 9, name: 'x', qcount: 1, deleted_at: '2026-09-23' }],
    questions: [{ id: 1, bank_name: 'hcie', type: 'single', stem: 'a', deleted_at: '2026-09-23' }],
    loaded: true,
};
st.w = { list: [], banks: [{ bank_id: 5, name: 'hcie', c: 81 }], types: [{ type: 'single', c: 20 }], loaded: true, total: 0, page: 1, bankId: -1 };
st.chapters = [{ chapter: '第一章', c: 10 }];
st.e = { list: [], result: null, bankId: 5, minutes: 30, shuffle: false, instant: false, showAnalysis: true };
st.p = {
    list: [], q: null, bankId: 5, mode: 'order',
    settings: { instant: false, autoNext: false, recite: false, shuffle: false, showAnswer: true },
};

/* ---------------- 检查 ---------------- */
let fail = 0;
function render(name, fn) {
    let html;
    try {
        html = fn();
    } catch (e) {
        console.log('  FAIL  ' + name + ' 抛异常: ' + e.message);
        fail++;
        return '';
    }
    if (typeof html !== 'string') {
        console.log('  FAIL  ' + name + ' 未返回字符串');
        fail++;
        return '';
    }
    const open = (html.match(/<div\b/g) || []).length;
    const close = (html.match(/<\/div>/g) || []).length;
    if (open === close) {
        console.log('  PASS  ' + name + '   <div>=' + open);
    } else {
        console.log('  FAIL  ' + name + '   <div>=' + open + ' </div>=' + close + '  ← 标签不闭合');
        fail++;
    }
    return html;
}

console.log('== 页面渲染 + 标签闭合 ==');
render('题库管理', () => app.viewBanks());
render('题库市场', () => app.viewMarket());
render('设置', () => app.viewSettings());
render('刷题练习', () => app.viewPractice());
render('模拟考试', () => app.viewExam());
render('错题本', () => app.viewWrong());
render('回收站', () => app.viewTrash());
render('管理后台', () => app.viewAdmin());
render('题目列表', () => app.viewQuestions());
render('考试历史表格', () => app.historyRows([{ id: 1, name: '模拟考试', bank_name: 'hcie', score: 60, used_seconds: 120, created_at: '2026-09-23 14:28' }]));
render('分页条（单页）', () => app.pagerBar(1, 1, 20, 'x'));
render('分页条（多页）', () => app.pagerBar(500, 3, 20, 'x'));

// 防「空数据下假通过」：确认渲染结果里真的出现了造好的数据
const probe = app.viewBanks() + app.viewMarket();
if (probe.indexOf('hcie') >= 0) {
    console.log('  PASS  测试数据已生效（页面里渲染出了测试题库）');
} else {
    console.log('  FAIL  测试数据没生效，说明 state 没拿到，上面的检查是空的');
    fail++;
}

console.log('');
console.log('== 布局约定 ==');
const pages = { '刷题练习': app.viewPractice(), '模拟考试': app.viewExam(), '设置': app.viewSettings() };
Object.keys(pages).forEach(n => {
    const h = pages[n];
    const grid = /class="card">\s*<div class="(card-title">[^<]*<\/div><div class=")?form-grid"/.test(h);
    console.log((grid ? '  PASS  ' : '  FAIL  ') + n + ' 表单使用 .form-grid 两列栅格');
    if (!grid) fail++;
    const hardWidth = /style="max-width:\s*\d+px/.test(h);
    console.log((hardWidth ? '  FAIL  ' : '  PASS  ') + n + ' 卡片内没有写死的 max-width');
    if (hardWidth) fail++;
});

// 题型行必须包在 .type-grid 里（两列排，数量框才不会被推到屏幕最右边）
const tr = app.typeRowsHtml([{ type: 'single', c: 342 }, { type: 'multiple', c: 277 }], 20);
const trOk = /class="type-grid"/.test(tr) && (tr.match(/<div\b/g) || []).length === (tr.match(/<\/div>/g) || []).length;
console.log((trOk ? '  PASS  ' : '  FAIL  ') + '题型行使用 .type-grid 两列排布');
if (!trOk) fail++;

console.log('');
console.log(fail ? ('存在 ' + fail + ' 项问题') : '全部通过（' + 12 + ' 个页面）');
process.exit(fail ? 1 : 0);
