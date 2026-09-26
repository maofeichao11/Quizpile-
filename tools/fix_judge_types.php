<?php
/**
 * 一次性修正：把「选项恰好为 对/错（或 正确/错误）」的单选题重标为判断题。
 * 只改 type 字段，不动题目 id 和答题记录。
 */
require __DIR__ . '/../lib/db.php';
require __DIR__ . '/../lib/question.php';

$bankId = isset($argv[1]) ? (int) $argv[1] : 0;
$log = array();

$banks = q('SELECT id, name FROM `banks` ORDER BY id');
if (!$bankId) {
    // 未指定题库时，修正所有题库
    foreach ($banks as $b) {
        $log = array_merge($log, fix_bank((int) $b['id'], $b['name']));
    }
} else {
    $b = q_one('SELECT id, name FROM `banks` WHERE id=?', array($bankId));
    if ($b) $log = array_merge($log, fix_bank($bankId, $b['name']));
    else $log[] = '题库不存在: ' . $bankId;
}

$log[] = '完成。';
header('Content-Type: text/plain; charset=utf-8');
echo implode("\n", $log);

function fix_bank($bankId, $name)
{
    $log = array();
    $log[] = "题库[$bankId] $name：开始检查...";
    $rows = q("SELECT id, type, options FROM `questions` WHERE bank_id=?", array($bankId));
    $fixed = 0;
    foreach ($rows as $r) {
        if ($r['type'] !== 'single') continue;
        $opts = decode_json_field($r['options']);
        if (count($opts) !== 2) continue;
        $k0 = judge_word_kind($opts[0]['text']);
        $k1 = judge_word_kind($opts[1]['text']);
        if ($k0 !== null && $k1 !== null && $k0 !== $k1) {
            exec_sql("UPDATE `questions` SET `type`='judge', `updated_at`=? WHERE `id`=?",
                array(now_str(), $r['id']));
            $fixed++;
        }
    }
    $log[] = "  重标为判断题: $fixed 道";
    return $log;
}
