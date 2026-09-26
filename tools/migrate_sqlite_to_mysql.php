<?php
/**
 * 一次性迁移工具：把旧的 SQLite 数据(data/exam.db) 导入到 MySQL。
 * 用法（命令行）：php tools/migrate_sqlite_to_mysql.php
 * 迁移完成后旧的 data/exam.db 可以自行删除。
 */
require __DIR__ . '/../lib/db.php';

$sqliteFile = __DIR__ . '/../data/exam.db';
$log = array();

if (!file_exists($sqliteFile)) {
    $log[] = '未找到旧的 SQLite 文件：' . $sqliteFile . '（无需迁移）';
    output($log);
    exit;
}
if (!extension_loaded('pdo_sqlite')) {
    $log[] = '未开启 pdo_sqlite 扩展，无法读取旧数据';
    output($log);
    exit;
}

$src = new PDO('sqlite:' . $sqliteFile);
$src->setAttribute(PDO::ATTR_DEFAULT_FETCH_MODE, PDO::FETCH_ASSOC);
$dst = db();

$dst->exec('SET FOREIGN_KEY_CHECKS=0');

// 1. 题库
$banks = $src->query('SELECT * FROM banks ORDER BY id')->fetchAll();
$bankCount = 0;
foreach ($banks as $b) {
    $exists = q_one('SELECT id FROM `banks` WHERE id=?', array($b['id']));
    if ($exists) continue;
    exec_sql('INSERT INTO `banks` (`id`,`name`,`description`,`created_at`) VALUES (?,?,?,?)',
        array($b['id'], $b['name'], $b['description'], $b['created_at']));
    $bankCount++;
}
$log[] = '题库：导入 ' . $bankCount . ' 个（原有 ' . count($banks) . ' 个）';

// 2. 题目
$questions = $src->query('SELECT * FROM questions ORDER BY id')->fetchAll();
$qCount = 0;
foreach ($questions as $qrow) {
    $exists = q_one('SELECT id FROM `questions` WHERE id=?', array($qrow['id']));
    if ($exists) continue;
    exec_sql('INSERT INTO `questions` (`id`,`bank_id`,`type`,`stem`,`options`,`answer`,`analysis`,`tags`,`created_at`,`updated_at`)
              VALUES (?,?,?,?,?,?,?,?,?,?)',
        array(
            $qrow['id'], $qrow['bank_id'], $qrow['type'], $qrow['stem'], $qrow['options'],
            $qrow['answer'], $qrow['analysis'], $qrow['tags'], $qrow['created_at'], $qrow['updated_at'],
        ));
    $qCount++;
}
$log[] = '题目：导入 ' . $qCount . ' 道（原有 ' . count($questions) . ' 道）';

// 3. 答题记录
$records = $src->query('SELECT * FROM records ORDER BY id')->fetchAll();
$rCount = 0;
foreach ($records as $r) {
    $exists = q_one('SELECT id FROM `records` WHERE id=?', array($r['id']));
    if ($exists) continue;
    exec_sql('INSERT INTO `records` (`id`,`question_id`,`correct`,`user_answer`,`mode`,`created_at`) VALUES (?,?,?,?,?,?)',
        array($r['id'], $r['question_id'], $r['correct'], $r['user_answer'], $r['mode'], $r['created_at']));
    $rCount++;
}
$log[] = '答题记录：导入 ' . $rCount . ' 条（原有 ' . count($records) . ' 条）';

// 4. 考试记录
$exams = $src->query('SELECT * FROM exams ORDER BY id')->fetchAll();
$eCount = 0;
foreach ($exams as $e) {
    $exists = q_one('SELECT id FROM `exams` WHERE id=?', array($e['id']));
    if ($exists) continue;
    exec_sql('INSERT INTO `exams` (`id`,`bank_id`,`name`,`total`,`score`,`right_count`,`duration`,`used_seconds`,`detail`,`created_at`)
              VALUES (?,?,?,?,?,?,?,?,?,?)',
        array(
            $e['id'], $e['bank_id'], $e['name'], $e['total'], $e['score'],
            $e['right_count'], $e['duration'], $e['used_seconds'], $e['detail'], $e['created_at'],
        ));
    $eCount++;
}
$log[] = '考试记录：导入 ' . $eCount . ' 条（原有 ' . count($exams) . ' 条）';

$dst->exec('SET FOREIGN_KEY_CHECKS=1');
$log[] = '迁移完成。旧文件 data/exam.db 已不再使用，可自行删除。';

output($log);

function output(array $lines)
{
    if (PHP_SAPI === 'cli') {
        echo implode("\n", $lines) . "\n";
    } else {
        header('Content-Type: text/html; charset=utf-8');
        echo '<meta charset="utf-8"><div style="font-family:Microsoft YaHei,sans-serif;padding:24px;line-height:2">' .
            implode('<br>', array_map(function ($s) { return htmlspecialchars($s, ENT_QUOTES, 'UTF-8'); }, $lines)) .
            '</div>';
    }
}
