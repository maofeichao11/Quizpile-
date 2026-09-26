<?php
/**
 * 命令行修改用户密码（管理员忘记密码时也能用）。
 * 用法：php tools/set_password.php <用户名> <新密码>
 */
require __DIR__ . '/../lib/db.php';

$user = isset($argv[1]) ? trim($argv[1]) : '';
$pass = isset($argv[2]) ? (string) $argv[2] : '';

if ($user === '' || $pass === '') {
    echo "用法: php tools/set_password.php <用户名> <新密码>\n";
    exit(1);
}
if (strlen($pass) < 6) {
    echo "密码至少 6 位\n";
    exit(1);
}

$row = q_one('SELECT `id` FROM `users` WHERE `username`=?', array($user));
if (!$row) {
    echo "用户不存在: $user\n";
    exit(1);
}

exec_sql('UPDATE `users` SET `password_hash`=? WHERE `id`=?', array(
    password_hash($pass, PASSWORD_BCRYPT),
    (int) $row['id'],
));
echo "已更新用户 [$user] 的密码\n";
