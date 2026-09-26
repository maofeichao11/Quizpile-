<?php
/**
 * JSON 接口层。所有请求： api.php?action=xxx
 */
require __DIR__ . '/lib/db.php';
require __DIR__ . '/lib/question.php';
require __DIR__ . '/lib/auth.php';
require __DIR__ . '/lib/ai.php';

header('Content-Type: application/json; charset=utf-8');
header('X-Content-Type-Options: nosniff');

// 接口一律返回 JSON：把 PHP 的告警/致命错误也转成 JSON，
// 避免前端拿到 "<html>..." 这类错误页而报 "Unexpected token '<'"
ini_set('display_errors', '0');
error_reporting(E_ALL);
ob_start();

register_shutdown_function(function () {
    $e = error_get_last();
    if ($e && in_array($e['type'], array(E_ERROR, E_PARSE, E_CORE_ERROR, E_COMPILE_ERROR), true)) {
        while (ob_get_level() > 0) { ob_end_clean(); }
        if (!headers_sent()) header('Content-Type: application/json; charset=utf-8');
        echo json_encode(array('ok' => false, 'error' => '服务器内部错误：' . $e['message']), JSON_UNESCAPED_UNICODE);
    }
});

/** 清掉缓冲区里可能的告警输出，保证 JSON 完整 */
function flush_noise()
{
    while (ob_get_level() > 0) { ob_end_clean(); }
}

function out($data, $ok = true)
{
    flush_noise();
    echo json_encode(array('ok' => $ok, 'data' => $data), JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

function fail($msg)
{
    flush_noise();
    echo json_encode(array('ok' => false, 'error' => $msg), JSON_UNESCAPED_UNICODE);
    exit;
}

function param($key, $default = null)
{
    if (isset($_POST[$key])) return $_POST[$key];
    if (isset($_GET[$key])) return $_GET[$key];
    return $default;
}

function body()
{
    $raw = file_get_contents('php://input');
    $data = json_decode($raw, true);
    return is_array($data) ? $data : array();
}

function arg($key, $default = null)
{
    $b = body();
    if (isset($b[$key])) return $b[$key];
    return param($key, $default);
}

function int_arg($key, $default = 0)
{
    return (int) arg($key, $default);
}

function str_arg($key, $default = '')
{
    return trim((string) arg($key, $default));
}

/**
 * 对外输出的用户设置：**剔除 AI Key**，只留一个「是否已配置」的标记。
 * Key 属于敏感凭据，只允许单向写入，不再随任何接口原文下发。
 */
function public_settings($s)
{
    $out = is_array($s) ? $s : array();
    $has = isset($out['ai_key']) && trim((string) $out['ai_key']) !== '';
    unset($out['ai_key']);
    $out['ai_key_set'] = $has;
    return $out;
}

/** 题目必须属于本人可编辑的题库，否则报错 */
function question_editable_or_fail($questionId)
{
    if (!question_editable($questionId)) {
        fail('没有权限修改这道题目（只有题库上传者本人可以）');
    }
}

function json_out_question(array $row)
{
    $row['options'] = decode_json_field($row['options']);
    $row['answer']  = decode_json_field($row['answer']);
    $row['type_name'] = type_name($row['type']);
    return $row;
}

$action = str_arg('action', param('action', ''));
if ($action === '') {
    fail('缺少 action 参数');
}

// 需要登录才能访问的接口（登录/注册/查询自身除外）
$publicActions = array('login', 'register', 'me');
if (!in_array($action, $publicActions, true) && !current_user()) {
    fail('请先登录');
}
// CSRF 校验（登录/注册/查询自身不需要）
if (!in_array($action, $publicActions, true)) {
    assert_csrf();
}

try {
    switch ($action) {

        /* ---------------- 管理后台（仅管理员） ---------------- */
        case 'admin_users':
            assert_admin();
            $rows = q('SELECT u.id, u.username, u.nickname, u.is_admin, u.created_at,
                        (SELECT COUNT(*) FROM banks b WHERE b.owner_id=u.id AND b.deleted_at IS NULL) AS bank_count,
                        (SELECT COUNT(*) FROM questions q JOIN banks b2 ON b2.id=q.bank_id WHERE b2.owner_id=u.id) AS question_count,
                        (SELECT COUNT(*) FROM records r WHERE r.user_id=u.id) AS record_count,
                        (SELECT COUNT(*) FROM exams e WHERE e.user_id=u.id) AS exam_count
                       FROM users u ORDER BY u.id');
            out($rows);

        case 'admin_user_banks':
            assert_admin();
            $uid = int_arg('user_id');
            $owned = q('SELECT b.id, b.name, b.is_public, "owner" AS role,
                         (SELECT COUNT(*) FROM questions WHERE bank_id=b.id AND deleted_at IS NULL) AS qcount
                        FROM banks b WHERE b.owner_id=? AND b.deleted_at IS NULL ORDER BY b.id', array($uid));
            $added = q('SELECT b.id, b.name, b.is_public, "member" AS role,
                         (SELECT COUNT(*) FROM questions WHERE bank_id=b.id AND deleted_at IS NULL) AS qcount
                        FROM bank_members m JOIN banks b ON b.id=m.bank_id
                        WHERE m.user_id=? AND b.deleted_at IS NULL ORDER BY b.id', array($uid));
            out(array_merge($owned, $added));

        case 'admin_set_password':
            assert_admin();
            $uid  = int_arg('user_id');
            $pass = (string) arg('password', '');
            if (strlen($pass) < 6) fail('新密码至少 6 位');
            if (!q_one('SELECT id FROM users WHERE id=?', array($uid))) fail('用户不存在');
            exec_sql('UPDATE users SET password_hash=? WHERE id=?', array(password_hash($pass, PASSWORD_BCRYPT), $uid));
            out(true);

        case 'admin_delete_user':
            assert_admin();
            $uid = int_arg('user_id');
            if ($uid === user_id()) fail('不能删除当前登录的管理员自己');
            $banks = q('SELECT id FROM banks WHERE owner_id=?', array($uid));
            foreach ($banks as $b) {
                exec_sql('DELETE FROM questions WHERE bank_id=?', array($b['id']));
                exec_sql('DELETE FROM bank_members WHERE bank_id=?', array($b['id']));
            }
            exec_sql('DELETE FROM banks WHERE owner_id=?', array($uid));
            exec_sql('DELETE FROM bank_members WHERE user_id=?', array($uid));
            exec_sql('DELETE FROM records WHERE user_id=?', array($uid));
            exec_sql('DELETE FROM exams WHERE user_id=?', array($uid));
            exec_sql('DELETE FROM users WHERE id=?', array($uid));
            out(true);

        case 'admin_banks':
            assert_admin();
            $page = max(1, int_arg('page', 1));
            $size = min(100, max(1, int_arg('page_size', 20)));
            $off  = ($page - 1) * $size;
            // 回收站里的题库（deleted_at 非空）不算进后台列表，总数口径保持一致，否则翻页会出现空页
            $total = (int) q_one('SELECT COUNT(*) AS c FROM banks WHERE deleted_at IS NULL')['c'];
            $rows = q('SELECT b.*, u.nickname AS owner_name, u.username AS owner_username,
                        (SELECT COUNT(*) FROM questions WHERE bank_id=b.id AND deleted_at IS NULL) AS qcount
                       FROM banks b LEFT JOIN users u ON u.id=b.owner_id
                       WHERE b.deleted_at IS NULL
                       ORDER BY b.id DESC LIMIT ' . $size . ' OFFSET ' . $off);
            out(array('total' => $total, 'page' => $page, 'size' => $size, 'list' => $rows));

        /* ---------------- 登录注册 ---------------- */
        case 'register':
            $username = str_arg('username');
            $password = (string) arg('password', '');
            $nickname = str_arg('nickname');
            if (strlen($username) < 3 || strlen($username) > 32) fail('用户名长度为 3-32 个字符');
            if (!preg_match('/^[A-Za-z0-9_\x{4e00}-\x{9fa5}]+$/u', $username)) fail('用户名只能包含中英文、数字和下划线');
            if (strlen($password) < 6) fail('密码至少 6 位');
            if ($nickname === '') $nickname = $username;
            if (q_one('SELECT id FROM `users` WHERE `username`=?', array($username))) fail('该用户名已被注册');

            exec_sql('INSERT INTO `users` (`username`,`password_hash`,`nickname`,`created_at`) VALUES (?,?,?,?)', array(
                $username,
                password_hash($password, PASSWORD_BCRYPT),
                $nickname,
                now_str(),
            ));
            $uid = (int) db()->lastInsertId();
            auth_start();
            $_SESSION['user_id'] = $uid;
            out(array('id' => $uid, 'username' => $username, 'nickname' => $nickname, 'is_admin' => 0));

        case 'login':
            $name = str_arg('username');
            $left = login_lock_left($name);
            if ($left > 0) {
                fail('密码错误次数过多，请 ' . ceil($left / 60) . ' 分钟后再试');
            }
            try {
                $u = login_user($name, (string) arg('password', ''));
            } catch (Throwable $e) {
                $lock = login_fail($name);
                if ($lock > 0) {
                    fail('密码错误次数过多，账号已锁定 10 分钟');
                }
                throw $e;
            }
            login_reset($name);
            out($u);

        case 'logout':
            auth_start();
            $_SESSION = array();
            if (ini_get('session.use_cookies')) {
                $p = session_get_cookie_params();
                setcookie(session_name(), '', time() - 42000, $p['path'], $p['domain'], $p['secure'], $p['httponly']);
            }
            session_destroy();
            out(true);

        case 'me':
            $u = public_user(current_user());
            if ($u) {
                $u['settings'] = public_settings(user_settings());
                $u['csrf'] = csrf_token();
            } else {
                // 未登录也先下发一个 token，供登录表单使用
                $u = array('csrf' => csrf_token());
            }
            out($u);

        case 'save_settings':
            $uid = user_id();
            $cur = user_settings();
            foreach (array('wrong_streak') as $k) {
                if (arg($k, null) !== null) $cur[$k] = (int) arg($k);
            }
            $cur['wrong_streak'] = max(1, min(10, (int) $cur['wrong_streak']));
            exec_sql('UPDATE `users` SET `settings`=? WHERE `id`=?', array(json_encode($cur, JSON_UNESCAPED_UNICODE), $uid));
            out(public_settings($cur));   // 回显里不带 AI Key

        case 'change_password':
            $old = (string) arg('old_password', '');
            $new = (string) arg('new_password', '');
            $row = q_one('SELECT * FROM `users` WHERE `id`=?', array(user_id()));
            if (!$row || !password_verify($old, $row['password_hash'])) fail('原密码不正确');
            if (strlen($new) < 6) fail('新密码至少 6 位');
            exec_sql('UPDATE `users` SET `password_hash`=? WHERE `id`=?', array(password_hash($new, PASSWORD_BCRYPT), user_id()));
            out(true);

        /* ---------------- 题库 ---------------- */
        case 'banks_list':
            $uid = user_id();
            // 我上传的题库
            $rows = q('SELECT b.*, u.nickname AS owner_name,
                        (SELECT COUNT(*) FROM questions WHERE bank_id=b.id AND deleted_at IS NULL) AS qcount,
                        "owner" AS role, 0 AS added
                       FROM banks b LEFT JOIN users u ON u.id=b.owner_id
                       WHERE b.owner_id=? AND b.deleted_at IS NULL ORDER BY b.id', array($uid));
            // 我从市场添加的题库
            $added = q('SELECT b.*, u.nickname AS owner_name, m.added_at,
                        (SELECT COUNT(*) FROM questions WHERE bank_id=b.id AND deleted_at IS NULL) AS qcount,
                        "member" AS role, 1 AS added
                       FROM bank_members m
                       JOIN banks b ON b.id=m.bank_id
                       LEFT JOIN users u ON u.id=b.owner_id
                       WHERE m.user_id=? AND b.deleted_at IS NULL ORDER BY m.id', array($uid));
            out(array_merge($rows, $added));

        case 'market_list':
            $uid   = user_id();
            $page  = max(1, int_arg('page', 1));
            $size  = min(60, max(1, int_arg('page_size', 12)));
            $off   = ($page - 1) * $size;
            $where = 'b.is_public=1 AND b.owner_id<>:uid AND b.deleted_at IS NULL';
            $total = (int) q_one('SELECT COUNT(*) AS c FROM banks b WHERE ' . $where, array('uid' => $uid))['c'];
            $rows = q('SELECT b.id, b.name, b.description, b.owner_id, b.is_public, b.share_desc, b.created_at, b.shared_at,
                        u.nickname AS owner_name,
                        (b.share_password <> "") AS has_password,
                        (SELECT COUNT(*) FROM questions WHERE bank_id=b.id AND deleted_at IS NULL) AS qcount,
                        EXISTS(SELECT 1 FROM bank_members m WHERE m.bank_id=b.id AND m.user_id=:uid2) AS added
                       FROM banks b LEFT JOIN users u ON u.id=b.owner_id
                       WHERE ' . $where . '
                       ORDER BY b.shared_at DESC, b.id DESC
                       LIMIT ' . $size . ' OFFSET ' . $off,
                array('uid' => $uid, 'uid2' => $uid));
            foreach ($rows as &$r) {
                $r['has_password'] = (bool) $r['has_password'];
                $r['added'] = (bool) $r['added'];
            }
            unset($r);
            out(array('total' => $total, 'page' => $page, 'size' => $size, 'list' => $rows));

        case 'bank_publish':
            $id   = int_arg('id');
            $pass = (string) arg('password', '');
            $desc = str_arg('desc');
            assert_bank_edit($id);
            if ($pass !== '' && strlen($pass) > 40) fail('分享密码过长（最多 40 位）');
            exec_sql('UPDATE banks SET is_public=1, share_password=?, share_desc=?, shared_at=? WHERE id=?',
                array($pass, $desc, now_str(), $id));
            out(true);

        case 'bank_unpublish':
            $id = int_arg('id');
            assert_bank_edit($id);
            exec_sql('UPDATE banks SET is_public=0 WHERE id=?', array($id));
            out(true);

        case 'bank_add':
            $id   = int_arg('id');
            $pass = (string) arg('password', '');
            $b    = bank_row($id);
            if (!$b) fail('题库不存在');
            if ((int) $b['is_public'] !== 1) fail('该题库未公开');
            if ((int) $b['owner_id'] === user_id()) fail('这是你自己的题库');
            if ($b['share_password'] !== '' && !hash_equals($b['share_password'], $pass)) {
                fail('提取密码不正确');
            }
            exec_sql('INSERT IGNORE INTO bank_members (user_id, bank_id, added_at) VALUES (?,?,?)',
                array(user_id(), $id, now_str()));
            out(true);

        case 'bank_remove_mine':
            $id = int_arg('id');
            exec_sql('DELETE FROM bank_members WHERE user_id=? AND bank_id=?', array(user_id(), $id));
            out(true);

        case 'bank_create':
            $name = str_arg('name');
            if ($name === '') fail('题库名称不能为空');
            exec_sql('INSERT INTO banks (name, description, owner_id, created_at) VALUES (?, ?, ?, ?)',
                array($name, str_arg('description'), user_id(), now_str()));
            // 注意：lastInsertId() 返回字符串，而题库列表里的 id 是 int（原生预处理），
            // 前端用 === 比较会失配，导致新建后进入被误判为「他人题库/只读」。这里统一成 int。
            out(array('id' => (int) db()->lastInsertId()));

        case 'bank_update':
            $id = int_arg('id');
            assert_bank_edit($id);
            exec_sql('UPDATE banks SET name=?, description=? WHERE id=?',
                array(str_arg('name'), str_arg('description'), $id));
            out(true);

        case 'bank_delete':
            $id = int_arg('id');
            assert_bank_edit($id);
            // 软删除：题库和题目都进回收站
            $now = now_str();
            exec_sql('UPDATE `questions` SET `deleted_at`=? WHERE `bank_id`=? AND `deleted_at` IS NULL', array($now, $id));
            exec_sql('UPDATE `banks` SET `deleted_at`=? WHERE `id`=?', array($now, $id));
            out(true);

        case 'trash_list':
            $uid  = user_id();
            $page = max(1, int_arg('page', 1));
            $size = min(100, max(1, int_arg('page_size', 30)));
            $off  = ($page - 1) * $size;
            $banks = q('SELECT b.*, u.nickname AS owner_name,
                         (SELECT COUNT(*) FROM questions WHERE bank_id=b.id AND deleted_at IS NOT NULL) AS qcount
                        FROM banks b LEFT JOIN users u ON u.id=b.owner_id
                        WHERE b.deleted_at IS NOT NULL' . (is_admin() ? '' : ' AND b.owner_id=' . $uid) . '
                        ORDER BY b.deleted_at DESC LIMIT 200');
            $qWhere = 'q.deleted_at IS NOT NULL' . (is_admin() ? '' : ' AND b.owner_id=' . $uid);
            $qTotal = (int) q_one('SELECT COUNT(*) AS c FROM questions q JOIN banks b ON b.id=q.bank_id WHERE ' . $qWhere)['c'];
            $questions = q('SELECT q.id, q.bank_id, q.type, q.stem, q.deleted_at, b.name AS bank_name
                            FROM questions q JOIN banks b ON b.id=q.bank_id
                            WHERE ' . $qWhere . '
                            ORDER BY q.deleted_at DESC LIMIT ' . $size . ' OFFSET ' . $off);
            out(array(
                'banks'     => $banks,
                'questions' => $questions,
                'q_total'   => $qTotal,
                'q_page'    => $page,
                'q_size'    => $size,
            ));

        case 'trash_restore':
            $type = str_arg('type');       // bank | question
            $id   = int_arg('id');
            if ($type === 'bank') {
                assert_bank_edit($id);
                exec_sql('UPDATE `banks` SET `deleted_at`=NULL WHERE `id`=?', array($id));
                exec_sql('UPDATE `questions` SET `deleted_at`=NULL WHERE `bank_id`=? AND `deleted_at` IS NOT NULL', array($id));
            } else {
                question_editable_or_fail($id);
                exec_sql('UPDATE `questions` SET `deleted_at`=NULL WHERE `id`=?', array($id));
            }
            out(true);

        case 'trash_purge':
            $type = str_arg('type');
            $id   = int_arg('id');
            if ($type === 'bank') {
                assert_bank_edit($id);
                exec_sql('DELETE FROM `questions` WHERE `bank_id`=? AND `deleted_at` IS NOT NULL', array($id));
                exec_sql('DELETE FROM `records` WHERE `question_id` IN (SELECT id FROM questions WHERE bank_id=? AND deleted_at IS NOT NULL)', array($id));
                exec_sql('DELETE FROM `bank_members` WHERE `bank_id`=?', array($id));
                exec_sql('DELETE FROM `banks` WHERE `id`=?', array($id));
            } else {
                question_editable_or_fail($id);
                exec_sql('DELETE FROM `records` WHERE `question_id`=?', array($id));
                exec_sql('DELETE FROM `question_flags` WHERE `question_id`=?', array($id));
                exec_sql('DELETE FROM `questions` WHERE `id`=?', array($id));
            }
            out(true);

        case 'bank_chapters':
            $bankId = int_arg('bank_id');
            assert_bank_view($bankId);
            $rows = q("SELECT `chapter`, COUNT(*) AS c FROM `questions`
                       WHERE `bank_id`=? AND `deleted_at` IS NULL AND `chapter`<>''
                       GROUP BY `chapter` ORDER BY c DESC", array($bankId));
            out($rows);

        case 'bank_types':
            $bankId = int_arg('bank_id', 0);
            $rows = q('SELECT type, COUNT(*) AS c FROM questions WHERE bank_id=? GROUP BY type', array($bankId));
            $map = array();
            foreach ($rows as $r) {
                $map[] = array('type' => $r['type'], 'c' => (int) $r['c']);
            }
            out($map);

        /* ---------------- 题目 ---------------- */
        case 'question_list':
            $bankId  = int_arg('bank_id', -1);
            $type    = str_arg('type', '');
            $keyword = str_arg('keyword', '');
            $page    = max(1, int_arg('page', 1));
            $size    = min(1000, max(1, int_arg('page_size', 20)));
            $random  = int_arg('random', 0);

            $where = array('`deleted_at` IS NULL');
            $args  = array();
            if ($bankId >= 0) {
                assert_bank_view($bankId);
                $where[] = 'bank_id = ?';
                $args[] = $bankId;
            } else {
                // 不限题库时，只能看自己有权限的题库
                $where[] = 'bank_id IN (' . visible_bank_in() . ')';
            }
            if ($type !== '') { $where[] = 'type = ?'; $args[] = $type; }
            if ($keyword !== '') {
                $where[] = '(stem LIKE ? OR tags LIKE ?)';
                $args[] = '%' . $keyword . '%';
                $args[] = '%' . $keyword . '%';
            }
            // 章节筛选（逗号分隔多个章节）
            $chapter = str_arg('chapter', '');
            if ($chapter !== '') {
                $cs = explode(',', $chapter);
                $ph = array();
                foreach ($cs as $c) {
                    if (trim($c) === '') continue;
                    $ph[] = '?';
                    $args[] = trim($c);
                }
                if ($ph) $where[] = 'chapter IN (' . implode(',', $ph) . ')';
            }
            // 答题状态筛选
            $state = str_arg('answer_state', 'all');
            $uid   = user_id();
            if ($state === 'new') {
                $where[] = "NOT EXISTS(SELECT 1 FROM records r WHERE r.question_id=q.id AND r.user_id=$uid)";
            } elseif ($state === 'done') {
                $where[] = "EXISTS(SELECT 1 FROM records r WHERE r.question_id=q.id AND r.user_id=$uid)";
            } elseif ($state === 'wrong') {
                $where[] = '(' . wrong_condition_sql($uid, wrong_streak_need()) . ')';
            } elseif ($state === 'flagged') {
                $where[] = "EXISTS(SELECT 1 FROM question_flags f WHERE f.question_id=q.id AND f.user_id=$uid)";
            }
            $wsql = $where ? ('WHERE ' . implode(' AND ', $where)) : '';

            $total = (int) q_one('SELECT COUNT(*) AS c FROM `questions` q ' . $wsql, $args)['c'];

            // MySQL 的随机排序是 RAND()（SQLite 才是 RANDOM()）
            $order = $random ? 'ORDER BY RAND()' : 'ORDER BY id DESC';
            $offset = ($page - 1) * $size;
            $rows = q("SELECT q.* FROM `questions` q $wsql $order LIMIT $size OFFSET $offset", $args);
            $rows = array_map('json_out_question', $rows);

            out(array(
                'total' => $total,
                'page'  => $page,
                'size'  => $size,
                'list'  => $rows,
            ));

        case 'question_get':
            $row = q_one('SELECT * FROM questions WHERE id=? AND deleted_at IS NULL', array(int_arg('id')));
            if (!$row) fail('题目不存在');
            assert_bank_view($row['bank_id']);
            out(json_out_question($row));

        case 'question_save':
            $id      = int_arg('id', 0);
            $bankId  = int_arg('bank_id', 0);
            $type    = str_arg('type', 'single');
            $stem    = str_arg('stem');
            if ($stem === '') fail('题干不能为空');

            $options = arg('options', array());
            $options = is_array($options) ? array_values(array_filter($options, function ($o) {
                return is_array($o) && trim((string) $o['text']) !== '';
            })) : array();
            $clean = array();
            foreach ($options as $i => $o) {
                $clean[] = array(
                    'key'  => isset($o['key']) && $o['key'] !== '' ? strtoupper((string) $o['key']) : chr(65 + $i),
                    'text' => trim((string) $o['text']),
                );
            }

            $answer = arg('answer', array());
            if (!is_array($answer)) {
                $answer = array($answer);
            }
            $answer = array_values(array_filter(array_map('trim', array_map('strval', $answer)), function ($x) { return $x !== ''; }));
            if ($type !== 'blank' && $type !== 'essay') {
                $answer = array_map('strtoupper', $answer);
            }
            if ($type === 'judge') {
                $clean = array(
                    array('key' => 'A', 'text' => '正确'),
                    array('key' => 'B', 'text' => '错误'),
                );
            }
            if (empty($answer)) fail('答案不能为空');

            // 权限：新增需对目标题库有编辑权；编辑需对原题所属题库有编辑权
            if ($id > 0) {
                $old = q_one('SELECT bank_id FROM questions WHERE id=?', array($id));
                if (!$old) fail('题目不存在');
                assert_bank_edit($old['bank_id']);
            } else {
                assert_bank_edit($bankId);
            }

            $fields = array(
                $bankId, $type, $stem,
                json_encode($clean, JSON_UNESCAPED_UNICODE),
                json_encode($answer, JSON_UNESCAPED_UNICODE),
                str_arg('analysis'),
                str_arg('tags'),
                str_arg('chapter'),
                now_str(),
            );

            if ($id > 0) {
                exec_sql('UPDATE questions SET bank_id=?, type=?, stem=?, options=?, answer=?, analysis=?, tags=?, chapter=?, updated_at=? WHERE id=?',
                    array_merge($fields, array($id)));
                out(array('id' => $id));
            }
            exec_sql('INSERT INTO questions (bank_id, type, stem, options, answer, analysis, tags, chapter, created_at, updated_at)
                      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                array_merge($fields, array($fields[8])));
            out(array('id' => db()->lastInsertId()));

        case 'question_delete':
            $qid = int_arg('id');
            question_editable_or_fail($qid);
            exec_sql('UPDATE `questions` SET `deleted_at`=? WHERE `id`=?', array(now_str(), $qid));
            out(true);

        case 'question_batch_delete':
            $ids = arg('ids', array());
            if (!is_array($ids) || !$ids) fail('请选择要删除的题目');
            foreach ($ids as $one) {
                question_editable_or_fail((int) $one);
            }
            $in = implode(',', array_fill(0, count($ids), '?'));
            $ids = array_map('intval', $ids);
            exec_sql("UPDATE `questions` SET `deleted_at`=? WHERE id IN ($in)", array_merge(array(now_str()), $ids));
            out(true);

        case 'question_move':
            $ids = arg('ids', array());
            $to  = int_arg('bank_id');
            if (!is_array($ids) || !$ids) fail('请选择题目');
            assert_bank_edit($to);
            foreach ($ids as $one) {
                question_editable_or_fail((int) $one);
            }
            $in  = implode(',', array_fill(0, count($ids), '?'));
            $ids = array_map('intval', $ids);
            exec_sql("UPDATE questions SET bank_id=? WHERE id IN ($in)", array_merge(array($to), $ids));
            out(true);

        /* ---------------- 图片上传 ---------------- */
        case 'upload':
            if (empty($_FILES['file'])) {
                fail('请选择要上传的图片');
            }
            $f = $_FILES['file'];
            if (is_array($f['error'])) {
                fail('一次只能上传一张图片');
            }
            if ($f['error'] !== UPLOAD_ERR_OK) {
                $map = array(
                    UPLOAD_ERR_INI_SIZE   => '图片超过 upload_max_filesize 限制',
                    UPLOAD_ERR_FORM_SIZE  => '图片超过表单限制',
                    UPLOAD_ERR_PARTIAL    => '图片只上传了一部分',
                    UPLOAD_ERR_NO_FILE    => '没有选择文件',
                );
                fail(isset($map[$f['error']]) ? $map[$f['error']] : ('上传失败，错误码 ' . $f['error']));
            }
            if ($f['size'] > 5 * 1024 * 1024) {
                fail('图片大小不能超过 5MB');
            }
            $ext = strtolower(pathinfo($f['name'], PATHINFO_EXTENSION));
            if (!in_array($ext, array('jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'), true)) {
                fail('仅支持 jpg / png / gif / webp / bmp 格式');
            }
            $info = @getimagesize($f['tmp_name']);
            if (!$info) {
                fail('这不是有效的图片文件');
            }
            $sub  = date('Ym');
            $dir  = __DIR__ . '/uploads/' . $sub;
            if (!is_dir($dir) && !@mkdir($dir, 0777, true)) {
                fail('无法创建上传目录，请检查 uploads 目录写权限');
            }
            $name = date('dHis') . '_' . mt_rand(1000, 9999) . '.' . $ext;
            if (!move_uploaded_file($f['tmp_name'], $dir . '/' . $name)) {
                fail('保存图片失败，请检查 uploads 目录写权限');
            }
            out(array('url' => 'uploads/' . $sub . '/' . $name, 'size' => $f['size']));

        /* ---------------- 导入 / 导出 ---------------- */
        case 'import_preview':
            $text = arg('text', '');
            $mode = str_arg('mode', 'text'); // text | csv | json
            if ($mode === 'json') {
                $items = parse_questions_json($text);
            } elseif ($mode === 'csv') {
                $items = parse_questions_csv($text);
            } elseif ($mode === 'yutian') {
                $items = parse_questions_yutian($text);
            } else {
                $items = parse_questions_text($text);
            }
            if (!$items) fail('没有解析到任何题目，请检查格式');
            out(array('count' => count($items), 'items' => $items));

        case 'import_commit':
            $bankId = int_arg('bank_id', 0);
            assert_bank_edit($bankId);
            $items  = arg('items', array());
            if (!is_array($items) || !$items) fail('没有要导入的题目');
            $now = now_str();
            $st  = db()->prepare('INSERT INTO questions (bank_id, type, stem, options, answer, analysis, tags, chapter, created_at, updated_at)
                                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
            $n = 0;
            foreach ($items as $it) {
                $stem = trim((string) $it['stem']);
                $answer = isset($it['answer']) ? $it['answer'] : array();
                if (!is_array($answer)) $answer = array($answer);
                $answer = array_values(array_filter(array_map('strval', $answer), function ($x) { return trim($x) !== ''; }));
                if ($stem === '' || !$answer) continue;
                $st->execute(array(
                    $bankId,
                    isset($it['type']) ? $it['type'] : 'single',
                    $stem,
                    json_encode(isset($it['options']) && is_array($it['options']) ? $it['options'] : array(), JSON_UNESCAPED_UNICODE),
                    json_encode($answer, JSON_UNESCAPED_UNICODE),
                    isset($it['analysis']) ? (string) $it['analysis'] : '',
                    isset($it['tags']) ? (string) $it['tags'] : '',
                    isset($it['chapter']) ? (string) $it['chapter'] : '',
                    $now, $now,
                ));
                $n++;
            }
            out(array('imported' => $n));

        case 'export':
            $bankId = int_arg('bank_id', -1);
            $fmt    = str_arg('format', 'json');
            if ($bankId >= 0) {
                assert_bank_view($bankId);
                $where = 'WHERE deleted_at IS NULL AND bank_id=' . (int) $bankId;
            } else {
                $where = 'WHERE deleted_at IS NULL AND bank_id IN (' . visible_bank_in() . ')';
            }
            $rows   = q('SELECT * FROM questions ' . $where . ' ORDER BY id');
            $rows   = array_map('json_out_question', $rows);

            if ($fmt === 'csv') {
                header('Content-Type: text/csv; charset=utf-8');
                header('Content-Disposition: attachment; filename="questions.csv"');
                $fp = fopen('php://output', 'w');
                fwrite($fp, "\xEF\xBB\xBF");
                fputcsv($fp, array('type', 'stem', 'A', 'B', 'C', 'D', 'answer', 'analysis', 'tags'));
                foreach ($rows as $r) {
                    $opts = array('', '', '', '');
                    foreach ($r['options'] as $i => $o) {
                        if ($i < 4) $opts[$i] = $o['text'];
                    }
                    fputcsv($fp, array(
                        $r['type'], $r['stem'], $opts[0], $opts[1], $opts[2], $opts[3],
                        implode('|', $r['answer']), $r['analysis'], $r['tags'],
                    ));
                }
                fclose($fp);
                exit;
            }

            if ($fmt === 'txt') {
                header('Content-Type: text/plain; charset=utf-8');
                header('Content-Disposition: attachment; filename="questions.txt"');
                foreach ($rows as $r) {
                    echo '【' . $r['type_name'] . '】' . $r['stem'] . "\n";
                    foreach ($r['options'] as $o) {
                        echo $o['key'] . '. ' . $o['text'] . "\n";
                    }
                    echo '答案：' . implode('', $r['answer']) . "\n";
                    if ($r['analysis'] !== '') echo '解析：' . $r['analysis'] . "\n";
                    echo "\n";
                }
                exit;
            }

            header('Content-Type: application/json; charset=utf-8');
            header('Content-Disposition: attachment; filename="questions.json"');
            echo json_encode(array('questions' => $rows), JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT);
            exit;

        /* ---------------- AI 导题库 ---------------- */
        case 'ai_config':
            // 只回配置项与「是否已配齐」，**绝不回传 Key 原文**（任何人都拿不到，包括本人页面刷新时）
            $cfg = ai_user_config();
            $chk = ai_config_check($cfg);
            out(array(
                'base'    => $cfg['base'],
                'model'   => $cfg['model'],
                'has_key' => $cfg['key'] !== '',
                'ready'   => $chk['ready'],
                'missing' => $chk['missing'],
            ));

        case 'ai_config_save':
            $cur = user_settings();
            if (arg('base', null) !== null)  $cur['ai_base']  = trim((string) arg('base', ''));
            if (arg('model', null) !== null) $cur['ai_model'] = trim((string) arg('model', ''));
            // Key 只单向写入：填了才更新；留空表示不修改；要清空需显式传 clear_key=1
            $newKey = arg('key', null);
            if ($newKey !== null && trim((string) $newKey) !== '') {
                $cur['ai_key'] = trim((string) $newKey);
            } elseif (int_arg('clear_key', 0) === 1) {
                $cur['ai_key'] = '';
            }
            exec_sql('UPDATE `users` SET `settings`=? WHERE `id`=?', array(json_encode($cur, JSON_UNESCAPED_UNICODE), user_id()));
            // 注意：current_user() 有静态缓存，这里必须用刚写入的 $cur 判断，不能回读
            $hasKey = isset($cur['ai_key']) && trim((string) $cur['ai_key']) !== '';
            out(array('has_key' => $hasKey));

        case 'ai_config_test':
            $cfg = ai_user_config();
            if (arg('base', null) !== null)  $cfg['base']  = trim((string) arg('base', ''));
            if (arg('model', null) !== null) $cfg['model'] = trim((string) arg('model', ''));
            if (arg('key', null) !== null && trim((string) arg('key', '')) !== '') $cfg['key'] = trim((string) arg('key', ''));
            $chk = ai_config_check($cfg);
            if (!$chk['ready']) fail($chk['msg']);
            @set_time_limit(90);
            try {
                ai_test_connection($cfg['base'], $cfg['key'], $cfg['model']);
            } catch (Exception $e) {
                fail('连接失败：' . $e->getMessage());
            }
            out(true);

        case 'ai_extract':
            $srcName = '粘贴的内容';
            $ext     = '';
            try {
                $hasFile = !empty($_FILES['file']) && (int) $_FILES['file']['error'] !== UPLOAD_ERR_NO_FILE;
                if ($hasFile) {
                    $f = $_FILES['file'];
                    if ((int) $f['error'] !== UPLOAD_ERR_OK) fail('文件上传失败（错误码 ' . $f['error'] . '）');
                    if ($f['size'] > 30 * 1024 * 1024) fail('文件不能超过 30MB');
                    $ext     = strtolower(pathinfo($f['name'], PATHINFO_EXTENSION));
                    $srcName = $f['name'];
                    $text    = ai_extract_text($f['tmp_name'], $ext);
                } else {
                    $text = (string) arg('text', '');
                }
            } catch (Exception $e) {
                fail($e->getMessage());
            }
            if (trim($text) === '') fail('请上传文件，或把题库内容粘贴到输入框');
            $warn = '';
            if (mb_strlen($text, 'UTF-8') > AI_MAX_CHARS) {
                $text = mb_substr($text, 0, AI_MAX_CHARS, 'UTF-8');
                $warn = '内容较长，只解析了前 ' . AI_MAX_CHARS . ' 字，建议拆分后再导入';
            }
            // 结构化内容（JSON / CSV）先本地精确解析，命中就不调用模型：更快、更准、不花钱
            $local = ai_try_local_parse($text, $ext);
            if ($local && $local['items']) {
                out(array(
                    'token'   => '',
                    'chars'   => mb_strlen($text, 'UTF-8'),
                    'chunks'  => 0,
                    'source'  => $srcName,
                    'warning' => $warn,
                    'local'   => true,
                    'kind'    => $local['kind'],
                    'items'   => $local['items'],
                ));
            }
            $token  = ai_store_text($text);
            $chunks = ai_split_chunks($text);
            out(array(
                'token'  => $token,
                'chars'  => mb_strlen($text, 'UTF-8'),
                'chunks' => count($chunks),
                'source' => $srcName,
                'warning' => $warn,
                'local'  => false,
            ));

        case 'ai_parse_chunk':
            $token = preg_replace('/[^a-zA-Z0-9_]/', '', str_arg('token'));
            $idx   = max(0, int_arg('index', 0));
            if ($token === '') fail('缺少解析会话，请重新上传文件');
            $cfg = ai_user_config();
            $chk = ai_config_check($cfg);
            if (!$chk['ready']) fail($chk['msg']);
            try {
                $text   = ai_load_text($token);
                $chunks = ai_split_chunks($text);
                if (!isset($chunks[$idx])) fail('分块超出范围（共 ' . count($chunks) . ' 块）');
                @set_time_limit(AI_TIMEOUT + 30);
                $content = ai_chat($cfg['base'], $cfg['key'], $cfg['model'], ai_messages($chunks[$idx]));
            } catch (Exception $e) {
                fail($e->getMessage());
            }
            $items = ai_normalize_items(ai_decode_json($content));
            out(array(
                'index'  => $idx,
                'chunks' => count($chunks),
                'items'  => $items,
                'empty'  => !$items,
            ));

        case 'ai_compare':
            $bankId = int_arg('bank_id', 0);
            if ($bankId > 0) assert_bank_view($bankId);
            $items = arg('items', array());
            if (!is_array($items)) $items = array();
            out($bankId > 0 ? ai_find_duplicates($bankId, $items) : array());

        /* ---------------- 答题记录 / 错题本 ---------------- */
        case 'record_answer':
            $qid = int_arg('question_id');
            $row = q_one('SELECT * FROM questions WHERE id=? AND deleted_at IS NULL', array($qid));
            if (!$row) fail('题目不存在');
            assert_bank_view($row['bank_id']);
            $user  = arg('user_answer', '');
            $mode  = str_arg('mode', 'practice');
            $res   = grade_answer($row, $user);
            $correct = $res['correct'] === null ? 0 : ($res['correct'] ? 1 : 0);
            if ($res['correct'] === null && int_arg('self_ok', 0)) {
                $correct = 1;
            }
            exec_sql('INSERT INTO records (question_id, user_id, correct, user_answer, mode, created_at) VALUES (?,?,?,?,?,?)', array(
                $qid, user_id(), $correct,
                is_array($user) ? implode(',', $user) : (string) $user,
                $mode, now_str(),
            ));
            out(array(
                'correct'  => $res['correct'],
                'expected' => $res['expected'],
                'record_id' => db()->lastInsertId(),
            ));

        case 'wrong_list':
            $bankId = int_arg('bank_id', -1);
            $uid    = user_id();
            $page   = max(1, int_arg('page', 1));
            $size   = min(200, max(1, int_arg('page_size', 50)));
            $offset = ($page - 1) * $size;
            if ($bankId >= 0) {
                assert_bank_view($bankId);
                $w = 'AND q.bank_id=' . (int) $bankId;
            } else {
                $w = 'AND q.bank_id IN (' . visible_bank_in() . ')';
            }
            $cond = " q.deleted_at IS NULL AND (" . wrong_condition_sql($uid, wrong_streak_need()) . ") $w ";
            $total = (int) q_one("SELECT COUNT(*) AS c FROM questions q WHERE $cond")['c'];
            $rows = q("SELECT q.*,
                        (SELECT COUNT(*) FROM records r WHERE r.question_id=q.id AND r.user_id=$uid) AS done_count,
                        (SELECT created_at FROM records r WHERE r.question_id=q.id AND r.user_id=$uid ORDER BY r.id DESC LIMIT 1) AS last_at,
                        (SELECT COUNT(*) FROM records rc WHERE rc.question_id=q.id AND rc.user_id=$uid AND rc.correct=1
                          AND rc.id > (SELECT MAX(id) FROM records rl WHERE rl.question_id=q.id AND rl.user_id=$uid AND rl.correct=0)) AS right_streak,
                        EXISTS(SELECT 1 FROM question_flags f WHERE f.question_id=q.id AND f.user_id=$uid) AS flagged
                       FROM questions q
                       WHERE $cond
                       ORDER BY last_at DESC
                       LIMIT $size OFFSET $offset");
            $list = array_map('json_out_question', $rows);
            foreach ($list as &$it) {
                $it['right_streak'] = (int) $it['right_streak'];
                $it['flagged'] = (bool) $it['flagged'];
                $it['streak_need'] = wrong_streak_need();
            }
            unset($it);
            out(array('total' => $total, 'page' => $page, 'size' => $size, 'list' => $list, 'streak_need' => wrong_streak_need()));

        case 'flag_toggle':
            $qid = int_arg('question_id');
            if (!question_visible($qid)) fail('题目不存在或无权访问');
            $uid = user_id();
            $has = q_one('SELECT id FROM question_flags WHERE user_id=? AND question_id=?', array($uid, $qid));
            if ($has) {
                exec_sql('DELETE FROM question_flags WHERE user_id=? AND question_id=?', array($uid, $qid));
                out(array('flagged' => false));
            }
            exec_sql('INSERT INTO question_flags (user_id, question_id, created_at) VALUES (?,?,?)', array($uid, $qid, now_str()));
            out(array('flagged' => true));

        case 'wrong_banks':
            // 各题库的错题数量（按「最后一次答错后连续答对次数 < N」判定）
            $uid = user_id();
            $rows = q("SELECT q.bank_id, b.name, COUNT(*) AS c
                       FROM questions q JOIN banks b ON b.id=q.bank_id
                       WHERE q.deleted_at IS NULL AND b.deleted_at IS NULL
                         AND q.bank_id IN (" . visible_bank_in() . ")
                         AND (" . wrong_condition_sql($uid, wrong_streak_need()) . ")
                       GROUP BY q.bank_id, b.name ORDER BY c DESC");
            out($rows);

        case 'wrong_types':
            // 某题库内各题型的错题数量
            $bankId = int_arg('bank_id');
            assert_bank_view($bankId);
            $uid = user_id();
            $rows = q("SELECT q.type, COUNT(*) AS c FROM questions q
                       WHERE q.bank_id=? AND q.deleted_at IS NULL
                         AND (" . wrong_condition_sql($uid, wrong_streak_need()) . ")
                       GROUP BY q.type", array($bankId));
            out($rows);

        case 'wrong_clear':
            $qid = int_arg('question_id', 0);
            $bid = int_arg('bank_id', 0);
            if ($qid > 0) {
                exec_sql('DELETE FROM records WHERE question_id=? AND user_id=?', array($qid, user_id()));
            } elseif ($bid > 0) {
                assert_bank_view($bid);
                exec_sql('DELETE FROM records WHERE user_id=? AND correct=0
                          AND question_id IN (SELECT id FROM questions WHERE bank_id=?)', array(user_id(), $bid));
            } else {
                exec_sql('DELETE FROM records WHERE correct=0 AND user_id=?', array(user_id()));
            }
            out(true);

        /* ---------------- 考试 ---------------- */
        case 'exam_submit':
            $bankId   = int_arg('bank_id', 0);
            $name     = str_arg('name', '模拟考试');
            $duration = int_arg('duration', 0);
            $used     = int_arg('used_seconds', 0);
            $answers  = arg('answers', array());
            if (!is_array($answers) || !$answers) fail('没有作答内容');

            $detail = array();
            $right  = 0;
            $graded = 0;
            foreach ($answers as $a) {
                $qid = (int) $a['question_id'];
                $row = q_one('SELECT * FROM questions WHERE id=?', array($qid));
                if (!$row) continue;
                if (!bank_can_view($row['bank_id'])) continue;
                $user = isset($a['answer']) ? $a['answer'] : '';
                $res  = grade_answer($row, $user);
                $correct = $res['correct'];
                if ($correct !== null) {
                    $graded++;
                    if ($correct) $right++;
                }
                $detail[] = array(
                    'question_id' => $qid,
                    'user'        => is_array($user) ? implode(',', $user) : (string) $user,
                    'correct'     => $correct === null ? null : ($correct ? 1 : 0),
                    'expected'    => $res['expected'],
                    'type'        => $row['type'],
                );
                exec_sql('INSERT INTO records (question_id, user_id, correct, user_answer, mode, created_at) VALUES (?,?,?,?,?,?)', array(
                    $qid, user_id(), $correct ? 1 : 0,
                    is_array($user) ? implode(',', $user) : (string) $user,
                    'exam', now_str(),
                ));
            }
            $total = count($detail);
            $score = $graded > 0 ? round($right / $graded * 100, 1) : 0;
            $showAnalysis = int_arg('show_analysis', 1) ? 1 : 0;

            exec_sql('INSERT INTO exams (bank_id, user_id, name, total, score, right_count, duration, used_seconds, detail, show_analysis, created_at)
                      VALUES (?,?,?,?,?,?,?,?,?,?,?)', array(
                $bankId, user_id(), $name, $total, $score, $right, $duration, $used,
                json_encode($detail, JSON_UNESCAPED_UNICODE), $showAnalysis, now_str(),
            ));
            out(array('id' => db()->lastInsertId(), 'score' => $score, 'right' => $right, 'total' => $total,
                'detail' => $detail, 'show_analysis' => $showAnalysis));

        case 'exam_selfcheck':
            $eid = int_arg('exam_id');
            $qid = int_arg('question_id');
            $ok  = int_arg('correct', 0) ? 1 : 0;
            $exam = q_one('SELECT * FROM exams WHERE id=? AND user_id=?', array($eid, user_id()));
            if (!$exam) fail('考试记录不存在');
            $detail = decode_json_field($exam['detail'], array());
            foreach ($detail as &$d) {
                if ((int) $d['question_id'] === $qid) {
                    $d['correct'] = $ok;
                }
            }
            unset($d);
            $right = 0;
            $graded = 0;
            foreach ($detail as $d) {
                if ($d['correct'] === null) continue;
                $graded++;
                if ($d['correct']) $right++;
            }
            $score = $graded > 0 ? round($right / $graded * 100, 1) : 0;
            exec_sql('UPDATE exams SET detail=?, score=?, right_count=? WHERE id=?', array(
                json_encode($detail, JSON_UNESCAPED_UNICODE), $score, $right, $eid,
            ));
            out(array('score' => $score, 'right' => $right, 'graded' => $graded));

        case 'exam_list':
            $rows = q('SELECT e.*, b.name AS bank_name FROM exams e LEFT JOIN banks b ON b.id=e.bank_id
                       WHERE e.user_id=? ORDER BY e.id DESC LIMIT 50', array(user_id()));
            foreach ($rows as &$r) {
                $r['show_analysis'] = (int) $r['show_analysis'];
            }
            unset($r);
            foreach ($rows as &$r) {
                $r['detail'] = decode_json_field($r['detail'], array());
            }
            unset($r);
            out($rows);

        case 'exam_delete':
            exec_sql('DELETE FROM exams WHERE id=? AND user_id=?', array(int_arg('id'), user_id()));
            out(true);

        /* ---------------- 统计 ---------------- */
        case 'stats':
            $uid = user_id();
            // 自己的题库 + 添加到市场的题库
            $banks = q("SELECT b.id, b.name, (SELECT COUNT(*) FROM questions WHERE bank_id=b.id AND deleted_at IS NULL) AS qcount
                        FROM banks b WHERE b.owner_id=? AND b.deleted_at IS NULL
                        UNION
                        SELECT b.id, b.name, (SELECT COUNT(*) FROM questions WHERE bank_id=b.id AND deleted_at IS NULL)
                        FROM bank_members m JOIN banks b ON b.id=m.bank_id WHERE m.user_id=? AND b.deleted_at IS NULL
                        ORDER BY id", array($uid, $uid));
            $vis = visible_bank_in();
            $byType = array();
            foreach (q("SELECT type, COUNT(*) AS c FROM questions WHERE deleted_at IS NULL AND bank_id IN ($vis) GROUP BY type") as $r) {
                $byType[$r['type']] = (int) $r['c'];
            }
            $totalQ     = (int) q_one("SELECT COUNT(*) AS c FROM questions WHERE deleted_at IS NULL AND bank_id IN ($vis)")['c'];
            $totalDone  = (int) q_one('SELECT COUNT(*) AS c FROM records WHERE user_id=?', array($uid))['c'];
            $totalRight = (int) q_one('SELECT COUNT(*) AS c FROM records WHERE user_id=? AND correct=1', array($uid))['c'];
            $wrongCount = (int) q_one('SELECT COUNT(DISTINCT question_id) AS c FROM records WHERE user_id=? AND correct=0
                            AND question_id NOT IN (SELECT question_id FROM records WHERE user_id=? AND correct=1)',
                            array($uid, $uid))['c'];
            $examCount  = (int) q_one('SELECT COUNT(*) AS c FROM exams WHERE user_id=?', array($uid))['c'];
            $avgScore   = (float) q_one('SELECT AVG(score) AS s FROM exams WHERE user_id=?', array($uid))['s'];

            // 近 14 天答题量
            $days = array();
            for ($i = 13; $i >= 0; $i--) {
                $d = date('Y-m-d', strtotime("-{$i} days"));
                $c = (int) q_one('SELECT COUNT(*) AS c FROM records WHERE user_id=? AND created_at LIKE ?', array($uid, $d . '%'))['c'];
                $days[] = array('date' => $d, 'count' => $c);
            }

            out(array(
                'total_questions' => $totalQ,
                'total_done'      => $totalDone,
                'total_right'     => $totalRight,
                'accuracy'        => $totalDone ? round($totalRight / $totalDone * 100, 1) : 0,
                'wrong_count'     => $wrongCount,
                'exam_count'      => $examCount,
                'avg_score'       => round($avgScore, 1),
                'by_type'         => $byType,
                'banks'           => $banks,
                'daily'           => $days,
            ));

        default:
            fail('未知操作：' . $action);
    }
} catch (Throwable $e) {
    fail('服务器错误：' . $e->getMessage());
}
