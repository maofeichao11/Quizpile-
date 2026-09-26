<?php
/**
 * 清理 uploads 里没有被任何题目引用的图片。
 * 用法：
 *   php tools/cleanup_uploads.php           仅列出
 *   php tools/cleanup_uploads.php --delete  真正删除
 */
require __DIR__ . '/../lib/db.php';

$doDelete = in_array('--delete', $argv, true);
$dir = __DIR__ . '/../uploads';

// 收集所有题目正文里引用的图片
$used = array();
$rows = q("SELECT `stem`, `options`, `analysis` FROM `questions`");
foreach ($rows as $r) {
    $text = $r['stem'] . ' ' . $r['options'] . ' ' . $r['analysis'];
    if (preg_match_all('/!\[[^\]]*\]\(([^)\s]+)\)/u', $text, $m)) {
        foreach ($m[1] as $u) {
            $u = trim($u);
            if (strpos($u, 'uploads/') === 0) {
                $used[basename($u)] = true;
            }
        }
    }
}

$files = array();
$it = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($dir, FilesystemIterator::SKIP_DOTS));
foreach ($it as $f) {
    if (!$f->isFile()) continue;
    if (preg_match('/\.(jpg|jpeg|png|gif|webp|bmp)$/i', $f->getFilename())) {
        $files[] = $f->getPathname();
    }
}

$unused = array();
foreach ($files as $p) {
    if (!isset($used[basename($p)])) $unused[] = $p;
}

echo "图片总数: " . count($files) . "，被引用: " . count($used) . "，可清理: " . count($unused) . "\n";
foreach ($unused as $p) {
    echo ($doDelete ? "[删除] " : "[可删] ") . $p . "\n";
    if ($doDelete) @unlink($p);
}
echo $doDelete ? "清理完成\n" : "（未删除，加 --delete 才会真正删除）\n";
