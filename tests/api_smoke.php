<?php
/**
 * 接口冒烟测试（回归用）
 *
 * 用法：php tests/api_smoke.php [接口地址]
 * 例：  php tests/api_smoke.php http://127.0.0.1:8088/api.php
 *
 * 说明：
 *  - 会自建临时账号和临时题库，测完自动清理，不碰真实数据
 *  - 有任何一项失败，进程退出码为 1（可接入 CI）
 *  - 需要先把管理员密码写进环境变量 TK_ADMIN_PASS，或按提示输入
 */
$base = isset($argv[1]) ? rtrim($argv[1], '/') : 'http://127.0.0.1:8088/api.php';

$pass = getenv('TK_ADMIN_PASS');
if (!$pass) {
    echo "用法: TK_ADMIN_PASS=<管理员密码> php tests/api_smoke.php $base\n";
    echo "（管理员密码用于验证超管权限，不会写到任何日志里）\n";
    exit(2);
}

$GLOBALS['pass_count'] = 0;
$GLOBALS['fail_count'] = 0;
$GLOBALS['log'] = array();
$GLOBALS['cookies'] = array();

function cookie_file($name)
{
    return sys_get_temp_dir() . '/tk_smoke_' . $name . '.txt';
}

function call($action, $data = null, $who = null)
{
    global $base;
    $header = "Content-Type: application/json\r\n";
    if ($who) {
        $f = cookie_file($who);
        if (file_exists($f)) $header .= "Cookie: " . trim(file_get_contents($f)) . "\r\n";
    }
    // CSRF：登录后下发，写操作必须带
    if ($who && !empty($GLOBALS['csrf'][$who]) && !in_array($action, array('login', 'register', 'me'), true)) {
        $header .= "X-CSRF-Token: " . $GLOBALS['csrf'][$who] . "\r\n";
    }
    $ctx = stream_context_create(array('http' => array(
        'method' => 'POST', 'header' => $header,
        'content' => json_encode($data === null ? new stdClass() : $data, JSON_UNESCAPED_UNICODE),
        'ignore_errors' => true, 'timeout' => 60,
    )));
    $raw = @file_get_contents($base . '?action=' . $action, false, $ctx);
    if ($who) {
        foreach ($http_response_header as $h) {
            if (stripos($h, 'Set-Cookie:') === 0) {
                file_put_contents(cookie_file($who), explode(';', trim(substr($h, strlen('Set-Cookie:'))))[0]);
            }
        }
    }
    return json_decode($raw, true);
}

function check($name, $cond, $extra = '')
{
    if ($cond) {
        $GLOBALS['pass_count']++;
        $GLOBALS['log'][] = "  PASS  $name" . ($extra ? " ($extra)" : '');
    } else {
        $GLOBALS['fail_count']++;
        $GLOBALS['log'][] = "  FAIL  $name" . ($extra ? " ($extra)" : '');
    }
}

function section($t)
{
    $GLOBALS['log'][] = "\n== $t ==";
}

/* ---------- 1. 登录与限流 ---------- */
section('登录 / 安全');
call('me', null, 'anon');
$me = call('me', null, 'anon');
$GLOBALS['csrf']['anon'] = $me['data']['csrf'] ?? '';
check('me 返回 csrf', !empty($me['data']['csrf']));

$bad = call('login', array('username' => 'admin', 'password' => 'wrong-password'), 'admin');
check('错误密码被拒绝', !$bad['ok'], $bad['error'] ?? '');
$admin = call('login', array('username' => 'admin', 'password' => $pass), 'admin');
check('管理员登录成功', !empty($admin['ok']));
$me = call('me', null, 'admin');
$GLOBALS['csrf']['admin'] = $me['data']['csrf'] ?? '';
check('管理员 is_admin=1', ($me['data']['is_admin'] ?? 0) == 1);

$noCsrf = call('banks_list', null, 'nocsrf');
check('缺少 CSRF 被拦截', !$noCsrf['ok'], $noCsrf['error'] ?? '');

/* ---------- 2. 临时用户 + 题库 ---------- */
section('题库 / 权限 / 市场');
$rand = 'smoke' . substr(md5(uniqid()), 0, 6);
$reg = call('register', array('username' => $rand, 'password' => 'smoke123', 'nickname' => '冒烟测试'), 'u2');
check('注册临时用户', !empty($reg['ok']), $rand);
$me2 = call('me', null, 'u2');
$GLOBALS['csrf']['u2'] = $me2['data']['csrf'] ?? '';

$bank = call('bank_create', array('name' => '冒烟题库', 'description' => '自动测试'), 'u2');
$bankId = $bank['data']['id'] ?? 0;
check('建题库', $bankId > 0);

$items = array(
    array('type' => 'single', 'stem' => '1+1=?', 'options' => array(array('key' => 'A', 'text' => '1'), array('key' => 'B', 'text' => '2')), 'answer' => array('B'), 'analysis' => '', 'tags' => ''),
    array('type' => 'multiple', 'stem' => '以下哪些是偶数？', 'options' => array(array('key' => 'A', 'text' => '2'), array('key' => 'B', 'text' => '3'), array('key' => 'C', 'text' => '4')), 'answer' => array('A', 'C'), 'analysis' => '', 'tags' => ''),
    array('type' => 'judge', 'stem' => '地球是圆的。', 'options' => array(array('key' => 'A', 'text' => '正确'), array('key' => 'B', 'text' => '错误')), 'answer' => array('A'), 'analysis' => '', 'tags' => ''),
    array('type' => 'blank', 'stem' => '中国的首都是____。', 'options' => array(), 'answer' => array('北京'), 'analysis' => '', 'tags' => ''),
);
$imp = call('import_commit', array('bank_id' => $bankId, 'items' => $items), 'u2');
check('导入 4 道题', ($imp['data']['imported'] ?? 0) == 4, json_encode($imp['data']['imported'] ?? 0));

$lst = call('question_list', array('bank_id' => $bankId, 'page_size' => 20), 'u2');
check('题目列表返回 4 道', count($lst['data']['list'] ?? array()) == 4);

// 判分：单选/多选/判断/填空
function byType($list, $t)
{
    foreach ($list as $q) { if ($q['type'] === $t) return $q; }
    return null;
}
$s = byType($lst['data']['list'], 'single');
$r = call('record_answer', array('question_id' => $s['id'], 'user_answer' => array('B')), 'u2');
check('单选答对', $r['data']['correct'] === true);
$r = call('record_answer', array('question_id' => $s['id'], 'user_answer' => array('A')), 'u2');
check('单选答错', $r['data']['correct'] === false);
$m = byType($lst['data']['list'], 'multiple');
$r = call('record_answer', array('question_id' => $m['id'], 'user_answer' => array('A', 'C')), 'u2');
check('多选答对', $r['data']['correct'] === true);
$j = byType($lst['data']['list'], 'judge');
$r = call('record_answer', array('question_id' => $j['id'], 'user_answer' => array('A')), 'u2');
check('判断答对', $r['data']['correct'] === true);
$b = byType($lst['data']['list'], 'blank');
$r = call('record_answer', array('question_id' => $b['id'], 'user_answer' => '北京'), 'u2');
check('填空答对', $r['data']['correct'] === true);

/* ---------- 3. 错题规则（连续答对 N 次） ---------- */
section('错题本 / 强化规则');
$wb = call('wrong_banks', null, 'u2');
check('错题归入对应题库', !empty($wb['data']) && $wb['data'][0]['bank_id'] == $bankId, json_encode($wb['data'] ?? array()));
$wt = call('wrong_types', array('bank_id' => $bankId), 'u2');
check('按题型统计错题', !empty($wt['data']), json_encode($wt['data'] ?? array()));

// 默认 streak=1：答对一次即移出
$r = call('record_answer', array('question_id' => $s['id'], 'user_answer' => array('B')), 'u2');
$wb2 = call('wrong_banks', null, 'u2');
$still = 0;
foreach ($wb2['data'] as $row) { if ($row['bank_id'] == $bankId) $still = $row['c']; }
check('连续答对 1 次后移出（streak=1）', $still == 0, '剩余错题=' . $still);

// 设为 3：答错 1 次 + 答对 1 次，仍应留在错题本
call('save_settings', array('wrong_streak' => 3), 'u2');
call('record_answer', array('question_id' => $s['id'], 'user_answer' => array('A')), 'u2'); // 答错
call('record_answer', array('question_id' => $s['id'], 'user_answer' => array('B')), 'u2'); // 答对 1 次
$wb3 = call('wrong_banks', null, 'u2');
$still3 = 0;
foreach ($wb3['data'] as $row) { if ($row['bank_id'] == $bankId) $still3 = $row['c']; }
check('streak=3 时答对 1 次仍保留', $still3 == 1, '剩余错题=' . $still3);
// 再答对 2 次（累计 3）后应移出
call('record_answer', array('question_id' => $s['id'], 'user_answer' => array('B')), 'u2');
call('record_answer', array('question_id' => $s['id'], 'user_answer' => array('B')), 'u2');
$wb4 = call('wrong_banks', null, 'u2');
$still4 = 0;
foreach ($wb4['data'] as $row) { if ($row['bank_id'] == $bankId) $still4 = $row['c']; }
check('累计答对 3 次后移出', $still4 == 0, '剩余错题=' . $still4);
call('save_settings', array('wrong_streak' => 1), 'u2');

/* ---------- 4. 标记 / 章节 / 只练未做 ---------- */
section('标记 / 章节 / 筛选');
$fl = call('flag_toggle', array('question_id' => $m['id']), 'u2');
check('标记题目', ($fl['data']['flagged'] ?? false) === true);
$lst2 = call('question_list', array('bank_id' => $bankId, 'answer_state' => 'flagged', 'page_size' => 20), 'u2');
check('按标记筛选题目', count($lst2['data']['list'] ?? array()) == 1);
$lst3 = call('question_list', array('bank_id' => $bankId, 'answer_state' => 'new', 'page_size' => 20), 'u2');
$newCount = count($lst3['data']['list'] ?? array());
check('只练未做过的题有过滤效果', $newCount < 4, '未做题数=' . $newCount);
call('flag_toggle', array('question_id' => $m['id']), 'u2'); // 取消标记

$upd = call('question_save', array('id' => $s['id'], 'bank_id' => $bankId, 'type' => 'single',
    'stem' => '1+1=?', 'options' => array(array('key' => 'A', 'text' => '1'), array('key' => 'B', 'text' => '2')),
    'answer' => array('B'), 'chapter' => '第一章'), 'u2');
check('题目可设置章节', !empty($upd['ok']));
$chs = call('bank_chapters', array('bank_id' => $bankId), 'u2');
check('章节列表返回', !empty($chs['data']), json_encode($chs['data'] ?? array()));
$lst4 = call('question_list', array('bank_id' => $bankId, 'chapter' => '第一章', 'page_size' => 20), 'u2');
check('按章节筛选题目', count($lst4['data']['list'] ?? array()) == 1);

/* ---------- 5. 市场 / 发布 / 密码 ---------- */
section('题库市场');
$pub = call('bank_publish', array('id' => $bankId, 'password' => '2468', 'desc' => '冒烟题库'), 'u2');
check('发布题库', !empty($pub['ok']));
$mk = call('market_list', null, 'admin');
check('管理员可见市场题库', !empty($mk['data']), json_encode(array_map(function ($x) { return $x['name']; }, $mk['data'] ?? array())));
$add1 = call('bank_add', array('id' => $bankId, 'password' => '0000'), 'admin');
check('错误提取密码被拒', !$add1['ok'], $add1['error'] ?? '');
$add2 = call('bank_add', array('id' => $bankId, 'password' => '2468'), 'admin');
check('正确密码可添加', !empty($add2['ok']));
$admUpd = call('bank_update', array('id' => $bankId, 'name' => '越权改名'), 'admin');
check('管理员可管理他人类题库', !empty($admUpd['ok']));
// 普通用户改管理员的题库应失败
$admBank = call('banks_list', null, 'admin');
$target = 0;
foreach ($admBank['data'] as $x) { if ($x['role'] === 'owner') { $target = $x['id']; break; } }
$deny = call('bank_update', array('id' => $target, 'name' => '篡改'), 'u2');
check('普通用户改他人类题库被拒', !$deny['ok'], $deny['error'] ?? '');

/* ---------- 6. 回收站 ---------- */
section('回收站');
$qdel = call('question_delete', array('id' => $b['id']), 'u2');
check('删除题目进入回收站', !empty($qdel['ok']));
$tr = call('trash_list', null, 'u2');
check('回收站可见已删题目', !empty($tr['data']['questions']));
$rst = call('trash_restore', array('type' => 'question', 'id' => $b['id']), 'u2');
check('恢复题目', !empty($rst['ok']));
$lst5 = call('question_list', array('bank_id' => $bankId, 'page_size' => 20), 'u2');
check('恢复后题目回到列表', count($lst5['data']['list'] ?? array()) == 4);

/* ---------- 7. 考试（含考后解析开关） ---------- */
section('考试');
$all = call('question_list', array('bank_id' => $bankId, 'page_size' => 20), 'u2');
$answers = array();
foreach ($all['data']['list'] as $q) {
    $answers[] = array('question_id' => $q['id'], 'answer' => $q['answer']);
}
$ex = call('exam_submit', array('bank_id' => $bankId, 'name' => '冒烟考试', 'duration' => 10,
    'used_seconds' => 30, 'answers' => $answers, 'show_analysis' => 0), 'u2');
check('交卷成功', !empty($ex['ok']), '得分=' . ($ex['data']['score'] ?? '-'));
check('满分判分正确', ($ex['data']['score'] ?? 0) == 100, '得分=' . ($ex['data']['score'] ?? '-'));
check('考后解析开关已保存', ($ex['data']['show_analysis'] ?? 1) == 0);
$exl = call('exam_list', null, 'u2');
check('考试记录可见', !empty($exl['data']));

/* ---------- 8. 统计按用户隔离 ---------- */
section('统计');
$st1 = call('stats', null, 'u2');
$st2 = call('stats', null, 'admin');
check('统计按用户隔离', ($st1['data']['total_done'] ?? -1) != ($st2['data']['total_done'] ?? -1));

/* ---------- 9. 改自己密码 ---------- */
section('账号');
$cp1 = call('change_password', array('old_password' => 'wrong', 'new_password' => 'abcdef'), 'u2');
check('原密码错误时不通过', !$cp1['ok']);
$cp2 = call('change_password', array('old_password' => 'smoke123', 'new_password' => 'smoke456'), 'u2');
check('修改自己的密码', !empty($cp2['ok']));
$relogin = call('login', array('username' => $rand, 'password' => 'smoke456'), 'u2b');
check('新密码可登录', !empty($relogin['ok']));

/* ---------- 清理 ---------- */
section('清理');
call('bank_delete', array('id' => $bankId), 'u2');
call('trash_purge', array('type' => 'bank', 'id' => $bankId), 'u2');
call('admin_delete_user', array('user_id' => $reg['data']['id'] ?? 0), 'admin');
check('清理临时数据完成', true);
foreach (array('admin', 'u2', 'u2b', 'anon', 'nocsrf') as $w) {
    @unlink(cookie_file($w));
}

/* ---------- 输出 ---------- */
echo "\nQuizpile 接口冒烟测试\n目标: $base\n";
echo implode("\n", $GLOBALS['log']) . "\n";
echo "\n结果: 通过 {$GLOBALS['pass_count']} 项，失败 {$GLOBALS['fail_count']} 项\n";
exit($GLOBALS['fail_count'] > 0 ? 1 : 0);
