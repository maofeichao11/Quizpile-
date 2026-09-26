<?php
require __DIR__ . '/lib/db.php';

$error = null;
$banks = array();
$totalQuestions = 0;
try {
    db();
    $banks = q('SELECT b.*, (SELECT COUNT(*) FROM questions WHERE bank_id=b.id) AS qcount FROM banks b ORDER BY b.id');
    $totalQuestions = (int) q_one('SELECT COUNT(*) AS c FROM questions')['c'];
} catch (Throwable $e) {
    $error = $e->getMessage();
}

if ($error !== null) {
    header('Content-Type: text/html; charset=utf-8');
    echo '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>数据库未就绪</title>';
    echo '<style>body{font-family:"Microsoft YaHei",sans-serif;background:#f4f6fb;margin:0;padding:40px;color:#1f2937}';
    echo '.box{max-width:640px;margin:0 auto;background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:24px;box-shadow:0 1px 3px rgba(16,24,40,.06)}';
    echo 'h2{margin-top:0;color:#dc2626}code{background:#f3f4f6;padding:2px 6px;border-radius:4px}';
    echo 'ol{line-height:1.9;padding-left:20px}.msg{background:#fef2f2;border:1px solid #fecaca;color:#991b1b;padding:10px 12px;border-radius:6px;font-size:13px;margin:12px 0}</style></head><body>';
    echo '<div class="box"><h2>数据库连接失败</h2><div class="msg">' . htmlspecialchars($error, ENT_QUOTES, 'UTF-8') . '</div>';
    echo '<p>请按以下步骤检查：</p><ol>';
    echo '<li>在 <b>phpstudy</b> 里启动 <b>MySQL</b>（需要 5.5 以上版本）</li>';
    echo '<li>打开 <code>exam/lib/config.php</code>，确认 <code>DB_USER</code> / <code>DB_PASS</code> / <code>DB_PORT</code> 与 phpstudy 中的一致<br>（phpstudy 默认：root / root，端口 3306）</li>';
    echo '<li>保存后刷新本页，系统会自动创建数据库 <code>exam</code> 和数据表</li>';
    echo '</ol></div></body></html>';
    exit;
}

$v = @filemtime(__DIR__ . '/assets/style.css');
$jv = @filemtime(__DIR__ . '/assets/app.js');
?>
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Quizpile · 智能题库与刷题组卷</title>
<link rel="stylesheet" href="assets/style.css?v=<?= $v ?>">
    <script>document.documentElement.dataset.theme = localStorage.getItem('qv-theme') || 'light';</script>
</head>
<body>
<button class="menu-toggle" id="menu-toggle" aria-label="菜单">
    <span></span><span></span><span></span>
</button>
<header class="topbar">
    <div class="topbar-inner">
            <span class="topbar-brand">Quizpile</span>
            <div class="topbar-right">
                <button class="theme-toggle" id="theme-toggle" data-act="theme-toggle" title="切换深色 / 浅色" aria-label="切换主题"></button>
                <span class="topbar-user" id="topbar-user"></span>
            </div>
    </div>
</header>
<div class="nav-backdrop" id="nav-backdrop"></div>
<div class="layout">
    <aside class="sidebar" id="sidebar">
        <div class="logo">
            <div class="logo-mark">QV</div>
            <div class="logo-text">
                <span class="logo-name">Quizpile</span>
                <span class="logo-sub">智能题库 · 刷题 · 组卷</span>
            </div>
        </div>
        <button class="theme-toggle" id="theme-toggle-side" data-act="theme-toggle" title="切换深色 / 浅色" aria-label="切换主题"></button>
        <div class="nav-group">
            <div class="nav-group__title">内容</div>
            <div class="nav-item active" data-nav="banks"><svg class="nav-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5"/><path d="M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/></svg><span>题库管理</span><span class="cnt" id="cnt-banks">0</span></div>
            <div class="nav-item" data-nav="market"><svg class="nav-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 7h12l-1 13H7z"/><path d="M9 7a3 3 0 0 1 6 0"/></svg><span>题库市场</span></div>
        </div>
        <div class="nav-group">
            <div class="nav-group__title">学习</div>
            <div class="nav-item" data-nav="practice"><svg class="nav-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20h4L18 10l-4-4L4 16z"/><path d="M14 6l4 4"/></svg><span>刷题练习</span></div>
            <div class="nav-item" data-nav="exam"><svg class="nav-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4a3 3 0 0 1 6 0"/><path d="M9 13l2 2 4-4"/></svg><span>模拟考试</span></div>
            <div class="nav-item" data-nav="wrong"><svg class="nav-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="8"/><path d="M12 8v5"/><path d="M12 16h.01"/></svg><span>错题本</span></div>
            <div class="nav-item" data-nav="stats"><svg class="nav-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 20V10M10 20V4M15 20v-7M20 20v-11"/></svg><span>学习统计</span></div>
        </div>
        <div class="nav-group">
            <div class="nav-group__title">系统</div>
            <div class="nav-item" data-nav="trash"><svg class="nav-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg><span>回收站</span></div>
            <div class="nav-item" data-nav="settings"><svg class="nav-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3.2"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1"/></svg><span>设置</span></div>
            <div class="nav-item" data-nav="admin" id="nav-admin" style="display:none"><svg class="nav-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z"/></svg><span>管理后台</span></div>
        </div>
        <div class="user-box" id="user-box"></div>
    </aside>
    <main class="main">
        <div id="view"></div>
    </main>
</div>
<div id="modal-root"></div>
<div class="toast" id="toast"><span class="toast-ico"></span><span class="toast-msg"></span></div>
<script src="assets/app.js?v=<?= $jv ?>"></script>
</body>
</html>
