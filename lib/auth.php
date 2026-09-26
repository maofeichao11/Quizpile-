<?php
/**
 * 登录态与权限控制。
 * 规则：题库归属于上传者（owner_id），只有本人可编辑/删除/导入；
 * 其他用户可以通过「题库市场」添加公开题库，但只有查看和练习权限。
 */
require_once __DIR__ . '/db.php';

function auth_start()
{
    if (session_status() === PHP_SESSION_NONE) {
        ini_set('session.cookie_httponly', '1');
        ini_set('session.use_strict_mode', '1');
        if (defined('PHP_VERSION_ID') && PHP_VERSION_ID >= 70300) {
            ini_set('session.cookie_samesite', 'Lax');
        }
        session_name('TKTSESS');
        session_start();
    }
}

function current_user()
{
    auth_start();
    if (empty($_SESSION['user_id'])) {
        return null;
    }
    static $cache = null;
    if ($cache !== null) {
        return $cache;
    }
    $u = q_one('SELECT `id`, `username`, `nickname`, `is_admin`, `settings`, `created_at` FROM `users` WHERE `id`=?', array((int) $_SESSION['user_id']));
    $cache = $u ? $u : null;
    return $cache;
}

function user_id()
{
    $u = current_user();
    return $u ? (int) $u['id'] : 0;
}

function require_user()
{
    $u = current_user();
    if (!$u) {
        fail('请先登录');
    }
    return $u;
}

/** 是否是管理员（拥有后台管理权限） */
function is_admin()
{
    $u = current_user();
    return $u ? ((int) ($u['is_admin'] ?? 0) === 1) : false;
}

function assert_admin()
{
    if (!is_admin()) {
        fail('没有权限：仅管理员可操作');
    }
}

function bank_row($bankId)
{
    return q_one('SELECT * FROM `banks` WHERE `id`=?', array((int) $bankId));
}

/** 是否是题库拥有者（可编辑/删除/导入） */
function bank_can_edit($bankId)
{
    if (is_admin()) return true;   // 管理员可管理全部题库
    $b = bank_row($bankId);
    if (!$b) return false;
    return (int) $b['owner_id'] === user_id();
}

/** 是否可以查看/练习（拥有者、已公开、或已添加到我的题库） */
function bank_can_view($bankId)
{
    if (is_admin()) return true;
    $b = bank_row($bankId);
    if (!$b) return false;
    if ((int) $b['owner_id'] === user_id()) return true;
    if ((int) $b['is_public'] === 1) return true;
    $m = q_one('SELECT `id` FROM `bank_members` WHERE `user_id`=? AND `bank_id`=?', array(user_id(), (int) $bankId));
    return (bool) $m;
}

function assert_bank_edit($bankId)
{
    if (!bank_can_edit($bankId)) {
        fail('没有权限操作这个题库（只有上传者本人可以修改）');
    }
}

function assert_bank_view($bankId)
{
    if (!bank_can_view($bankId)) {
        fail('没有权限访问这个题库');
    }
}

/** 当前用户可见的题库 id 列表（用于筛选题目/记录） */
function visible_bank_ids()
{
    static $ids = null;
    if ($ids !== null) return $ids;
    if (is_admin()) {
        // 管理员可见全部题库
        $rows = q('SELECT `id` FROM `banks`');
        $ids = array();
        foreach ($rows as $r) {
            $ids[] = (int) $r['id'];
        }
        return $ids ? $ids : array(0);
    }
    $uid = user_id();
    $rows = q(
        'SELECT `id` FROM `banks` WHERE `owner_id`=? OR `is_public`=1
         UNION
         SELECT `bank_id` FROM `bank_members` WHERE `user_id`=?',
        array($uid, $uid)
    );
    $ids = array();
    foreach ($rows as $r) {
        $ids[] = (int) $r['id'];
    }
    if (!$ids) $ids = array(0);
    return $ids;
}

function visible_bank_in()
{
    return implode(',', visible_bank_ids());
}

/* ---------------- 用户设置 ---------------- */
function user_settings()
{
    $u = current_user();
    $s = array('wrong_streak' => 1);
    if ($u && !empty($u['settings'])) {
        $d = json_decode($u['settings'], true);
        if (is_array($d)) $s = array_merge($s, $d);
    }
    $s['wrong_streak'] = max(1, min(10, (int) $s['wrong_streak']));
    return $s;
}

/** 连续答对多少次才移出错题本 */
function wrong_streak_need()
{
    $s = user_settings();
    return $s['wrong_streak'];
}

/**
 * 错题判定 SQL 片段（q 为 questions 表别名）：
 * 有答错记录，且最后一次答错之后的连续答对次数 < N
 */
function wrong_condition_sql($uid, $streak)
{
    return " EXISTS(SELECT 1 FROM records rw WHERE rw.question_id=q.id AND rw.user_id=$uid AND rw.correct=0)
             AND (SELECT COUNT(*) FROM records rc WHERE rc.question_id=q.id AND rc.user_id=$uid AND rc.correct=1
                  AND rc.id > (SELECT MAX(id) FROM records rl WHERE rl.question_id=q.id AND rl.user_id=$uid AND rl.correct=0)) < $streak ";
}

function client_ip()
{
    foreach (array('HTTP_X_FORWARDED_FOR', 'HTTP_CLIENT_IP', 'REMOTE_ADDR') as $k) {
        if (!empty($_SERVER[$k])) {
            $v = trim(explode(',', $_SERVER[$k])[0]);
            if ($v !== '') return mb_substr($v, 0, 45);
        }
    }
    return 'unknown';
}

/** 登录限流：返回剩余锁定秒数（0 表示可登录） */
function login_lock_left($username)
{
    $row = q_one('SELECT * FROM `login_attempts` WHERE `username`=? AND `ip`=?',
        array($username, client_ip()));
    if (!$row || empty($row['locked_until'])) return 0;
    $left = strtotime($row['locked_until']) - time();
    return $left > 0 ? $left : 0;
}

function login_fail($username)
{
    $ip  = client_ip();
    $now = now_str();
    $row = q_one('SELECT * FROM `login_attempts` WHERE `username`=? AND `ip`=?', array($username, $ip));
    if (!$row) {
        exec_sql('INSERT INTO `login_attempts` (`username`,`ip`,`fails`,`last_at`) VALUES (?,?,1,?)', array($username, $ip, $now));
        $fails = 1;
    } else {
        // 15 分钟内的失败才累计
        $fails = (strtotime($row['last_at']) > time() - 900) ? ((int) $row['fails'] + 1) : 1;
        exec_sql('UPDATE `login_attempts` SET `fails`=?, `last_at`=? WHERE `id`=?', array($fails, $now, $row['id']));
    }
    if ($fails >= 5) {
        $until = date('Y-m-d H:i:s', time() + 600);
        exec_sql('UPDATE `login_attempts` SET `locked_until`=? WHERE `username`=? AND `ip`=?', array($until, $username, $ip));
        return 600;
    }
    return 0;
}

function login_reset($username)
{
    exec_sql('DELETE FROM `login_attempts` WHERE `username`=? AND `ip`=?', array($username, client_ip()));
}

/* ---------------- CSRF ---------------- */
function csrf_token()
{
    auth_start();
    if (empty($_SESSION['csrf'])) {
        $_SESSION['csrf'] = bin2hex(random_bytes(16));
    }
    return $_SESSION['csrf'];
}

function assert_csrf()
{
    auth_start();
    $sent = '';
    if (!empty($_SERVER['HTTP_X_CSRF_TOKEN'])) {
        $sent = $_SERVER['HTTP_X_CSRF_TOKEN'];
    } elseif (isset($_POST['csrf'])) {
        $sent = $_POST['csrf'];
    }
    $want = isset($_SESSION['csrf']) ? $_SESSION['csrf'] : '';
    if ($want === '' || !hash_equals($want, $sent)) {
        fail('请求校验失败（CSRF），请刷新页面后重试');
    }
}

/** 题目所属题库是否可见 */
function question_visible($questionId)
{
    $q = q_one('SELECT `bank_id` FROM `questions` WHERE `id`=?', array((int) $questionId));
    if (!$q) return false;
    return bank_can_view($q['bank_id']);
}

/** 题目是否可编辑（所属题库为本人所有） */
function question_editable($questionId)
{
    $q = q_one('SELECT `bank_id` FROM `questions` WHERE `id`=?', array((int) $questionId));
    if (!$q) return false;
    return bank_can_edit($q['bank_id']);
}

function login_user($username, $password)
{
    $u = q_one('SELECT * FROM `users` WHERE `username`=? LIMIT 1', array($username));
    if (!$u || !password_verify($password, $u['password_hash'])) {
        throw new RuntimeException('用户名或密码不正确');
    }
    auth_start();
    // 登录成功后重建会话 ID（防会话固定），但保留 csrf token，避免前端刚拿到的 token 失效
    $csrf = isset($_SESSION['csrf']) ? $_SESSION['csrf'] : bin2hex(random_bytes(16));
    session_regenerate_id(true);
    $_SESSION['csrf'] = $csrf;
    $_SESSION['user_id'] = (int) $u['id'];
    return array(
        'id'       => (int) $u['id'],
        'username' => $u['username'],
        'nickname' => $u['nickname'],
        'is_admin' => (int) ($u['is_admin'] ?? 0),
    );
}

function public_user($u)
{
    return is_array($u) ? array(
        'id'       => (int) $u['id'],
        'username' => $u['username'],
        'nickname' => $u['nickname'],
        'is_admin' => (int) ($u['is_admin'] ?? 0),
    ) : null;
}
