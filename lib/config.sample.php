<?php
/**
 * 数据库配置示例。
 *
 * 使用方法：把本文件复制一份改名成 config.php，再改成你自己的数据库信息。
 *   Linux/macOS:  cp lib/config.sample.php lib/config.php
 *   Windows:      copy lib\config.sample.php lib\config.php
 *
 * 注意：config.php 已被 .gitignore 忽略，不要把它提交到公开仓库。
 */
date_default_timezone_set('Asia/Shanghai');

define('DB_HOST', '127.0.0.1');
define('DB_PORT', '3306');
define('DB_NAME', 'exam');        // 数据库名，首次访问会自动创建
define('DB_USER', 'root');
define('DB_PASS', '');            // ← 改成你的数据库密码（phpstudy 默认是 root）
define('DB_CHARSET', 'utf8mb4');
