<?php
/**
 * 数据层：MySQL（PDO）。首次访问自动建库、建表。
 */
require __DIR__ . '/config.php';

function db(): PDO
{
    static $pdo = null;
    if ($pdo instanceof PDO) {
        return $pdo;
    }

    $dsn = 'mysql:host=' . DB_HOST . ';port=' . DB_PORT . ';charset=' . DB_CHARSET;
    try {
        $pdo = new PDO($dsn, DB_USER, DB_PASS, array(
            PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            PDO::ATTR_EMULATE_PREPARES   => false,
            PDO::ATTR_TIMEOUT            => 5,
        ));
    } catch (PDOException $e) {
        throw new RuntimeException(
            '连接 MySQL 失败：' . $e->getMessage() .
            '　请先在 phpstudy 中启动 MySQL，并确认 lib/config.php 里的账号密码正确。'
        );
    }

    $pdo->exec('CREATE DATABASE IF NOT EXISTS `' . DB_NAME . '` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci');
    $pdo->exec('USE `' . DB_NAME . '`');
    migrate($pdo);
    return $pdo;
}

function table_has_column(PDO $pdo, string $table, string $col): bool
{
    try {
        // 用 information_schema 判断（SHOW COLUMNS ... LIKE ? 在服务端预编译下不被支持）
        $st = $pdo->prepare("SELECT COUNT(*) FROM information_schema.COLUMNS
                             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?");
        $st->execute(array($table, $col));
        return ((int) $st->fetchColumn()) > 0;
    } catch (PDOException $e) {
        return false;
    }
}

function add_column_if_missing(PDO $pdo, string $table, string $col, string $ddl): void
{
    if (!table_has_column($pdo, $table, $col)) {
        $pdo->exec("ALTER TABLE `$table` ADD COLUMN $ddl");
    }
}

function index_exists(PDO $pdo, string $table, string $index): bool
{
    try {
        $st = $pdo->prepare("SELECT COUNT(*) FROM information_schema.STATISTICS
                             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?");
        $st->execute(array($table, $index));
        return ((int) $st->fetchColumn()) > 0;
    } catch (PDOException $e) {
        return false;
    }
}

function add_index_if_missing(PDO $pdo, string $table, string $index, string $cols): void
{
    if (!index_exists($pdo, $table, $index)) {
        try {
            $pdo->exec("ALTER TABLE `$table` ADD INDEX `$index` ($cols)");
        } catch (PDOException $e) {
            /* 索引已存在等情况忽略 */
        }
    }
}

function migrate(PDO $pdo): void
{
    $pdo->exec("CREATE TABLE IF NOT EXISTS `banks` (
        `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
        `name` VARCHAR(200) NOT NULL,
        `description` VARCHAR(500) NOT NULL DEFAULT '',
        `created_at` DATETIME NOT NULL,
        PRIMARY KEY (`id`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");

    $pdo->exec("CREATE TABLE IF NOT EXISTS `questions` (
        `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
        `bank_id` INT UNSIGNED NOT NULL DEFAULT 0,
        `type` VARCHAR(20) NOT NULL DEFAULT 'single',
        `stem` TEXT NOT NULL,
        `options` TEXT NOT NULL,
        `answer` TEXT NOT NULL,
        `analysis` TEXT NOT NULL,
        `tags` VARCHAR(200) NOT NULL DEFAULT '',
        `created_at` DATETIME NOT NULL,
        `updated_at` DATETIME NOT NULL,
        PRIMARY KEY (`id`),
        KEY `idx_bank` (`bank_id`),
        KEY `idx_type` (`type`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");

    $pdo->exec("CREATE TABLE IF NOT EXISTS `records` (
        `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
        `question_id` INT UNSIGNED NOT NULL,
        `correct` TINYINT(1) NOT NULL DEFAULT 0,
        `user_answer` TEXT NOT NULL,
        `mode` VARCHAR(20) NOT NULL DEFAULT 'practice',
        `created_at` DATETIME NOT NULL,
        PRIMARY KEY (`id`),
        KEY `idx_question` (`question_id`),
        KEY `idx_created` (`created_at`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");

    $pdo->exec("CREATE TABLE IF NOT EXISTS `exams` (
        `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
        `bank_id` INT UNSIGNED NOT NULL DEFAULT 0,
        `name` VARCHAR(200) NOT NULL DEFAULT '',
        `total` INT NOT NULL DEFAULT 0,
        `score` DECIMAL(5,1) NOT NULL DEFAULT 0,
        `right_count` INT NOT NULL DEFAULT 0,
        `duration` INT NOT NULL DEFAULT 0,
        `used_seconds` INT NOT NULL DEFAULT 0,
        `detail` TEXT NOT NULL,
        `created_at` DATETIME NOT NULL,
        PRIMARY KEY (`id`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");

    // ---- 用户体系 ----
    $pdo->exec("CREATE TABLE IF NOT EXISTS `users` (
        `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
        `username` VARCHAR(64) NOT NULL,
        `password_hash` VARCHAR(255) NOT NULL,
        `nickname` VARCHAR(64) NOT NULL DEFAULT '',
        `created_at` DATETIME NOT NULL,
        PRIMARY KEY (`id`),
        UNIQUE KEY `uk_username` (`username`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");

    // ---- 题库市场：用户添加的他人题库 ----
    $pdo->exec("CREATE TABLE IF NOT EXISTS `bank_members` (
        `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
        `user_id` INT UNSIGNED NOT NULL,
        `bank_id` INT UNSIGNED NOT NULL,
        `added_at` DATETIME NOT NULL,
        PRIMARY KEY (`id`),
        UNIQUE KEY `uk_user_bank` (`user_id`, `bank_id`),
        KEY `idx_bank` (`bank_id`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");

    // ---- 归属 / 公开 / 分享密码字段（平滑升级旧库） ----
    add_column_if_missing($pdo, 'banks', 'owner_id', '`owner_id` INT UNSIGNED NOT NULL DEFAULT 0, ADD KEY `idx_owner` (`owner_id`)');
    add_column_if_missing($pdo, 'banks', 'is_public', '`is_public` TINYINT(1) NOT NULL DEFAULT 0');
    add_column_if_missing($pdo, 'banks', 'share_password', "`share_password` VARCHAR(100) NOT NULL DEFAULT ''");
    add_column_if_missing($pdo, 'banks', 'share_desc', "`share_desc` VARCHAR(500) NOT NULL DEFAULT ''");
    add_column_if_missing($pdo, 'banks', 'shared_at', '`shared_at` DATETIME NULL');
    add_column_if_missing($pdo, 'users', 'is_admin', '`is_admin` TINYINT(1) NOT NULL DEFAULT 0');
    add_column_if_missing($pdo, 'users', 'settings', "`settings` TEXT NULL");

    // 回收站（软删除）
    add_column_if_missing($pdo, 'banks', 'deleted_at', '`deleted_at` DATETIME NULL');
    add_column_if_missing($pdo, 'questions', 'deleted_at', '`deleted_at` DATETIME NULL');
    // 章节（用于按章节组卷）
    add_column_if_missing($pdo, 'questions', 'chapter', "`chapter` VARCHAR(200) NOT NULL DEFAULT '', ADD KEY `idx_chapter` (`chapter`)");
    // 考试后是否允许看解析
    add_column_if_missing($pdo, 'exams', 'show_analysis', '`show_analysis` TINYINT(1) NOT NULL DEFAULT 1');

    // 登录失败限流
    $pdo->exec("CREATE TABLE IF NOT EXISTS `login_attempts` (
        `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
        `username` VARCHAR(64) NOT NULL,
        `ip` VARCHAR(45) NOT NULL DEFAULT '',
        `fails` INT UNSIGNED NOT NULL DEFAULT 0,
        `last_at` DATETIME NOT NULL,
        `locked_until` DATETIME NULL,
        PRIMARY KEY (`id`),
        UNIQUE KEY `uk_user_ip` (`username`, `ip`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");

    // 收藏 / 标记疑问题
    $pdo->exec("CREATE TABLE IF NOT EXISTS `question_flags` (
        `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
        `user_id` INT UNSIGNED NOT NULL,
        `question_id` INT UNSIGNED NOT NULL,
        `created_at` DATETIME NOT NULL,
        PRIMARY KEY (`id`),
        UNIQUE KEY `uk_uq` (`user_id`, `question_id`),
        KEY `idx_q` (`question_id`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");

    // 答题记录查询索引
    add_index_if_missing($pdo, 'records', 'idx_uq', '`user_id`, `question_id`, `id`');
    add_column_if_missing($pdo, 'records', 'user_id', '`user_id` INT UNSIGNED NOT NULL DEFAULT 0, ADD KEY `idx_user` (`user_id`)');
    add_column_if_missing($pdo, 'exams', 'user_id', '`user_id` INT UNSIGNED NOT NULL DEFAULT 0, ADD KEY `idx_user2` (`user_id`)');

    // ---- 默认管理员（首次启用用户体系时创建，旧数据统一归属给它） ----
    $adminId = (int) $pdo->query("SELECT `id` FROM `users` WHERE `username`='admin'")->fetchColumn();
    if (!$adminId) {
        $pdo->prepare('INSERT INTO `users` (`username`,`password_hash`,`nickname`,`created_at`) VALUES (?,?,?,?)')
            ->execute(array('admin', password_hash('admin123', PASSWORD_BCRYPT), '管理员', now_str()));
        $adminId = (int) $pdo->lastInsertId();
    }
    // 管理员账号拥有后台管理权限
    $pdo->exec("UPDATE `users` SET `is_admin`=1 WHERE `username`='admin'");
    $pdo->exec('UPDATE `banks` SET `owner_id`=' . $adminId . ' WHERE `owner_id`=0');
    $pdo->exec('UPDATE `records` SET `user_id`=' . $adminId . ' WHERE `user_id`=0');
    $pdo->exec('UPDATE `exams` SET `user_id`=' . $adminId . ' WHERE `user_id`=0');

    // 默认题库：首次使用时给一个示例题库
    $count = (int) $pdo->query('SELECT COUNT(*) FROM `banks`')->fetchColumn();
    if ($count === 0) {
        $pdo->prepare('INSERT INTO `banks` (`name`, `description`, `owner_id`, `created_at`) VALUES (?, ?, ?, ?)')
            ->execute(array('示例题库', '导入你的题库前，可以先在这里试着添加几道题', $adminId, now_str()));
    }
}

function now_str(): string
{
    return date('Y-m-d H:i:s');
}

function q(string $sql, array $params = array()): array
{
    $st = db()->prepare($sql);
    $st->execute($params);
    return $st->fetchAll();
}

function q_one(string $sql, array $params = array()): ?array
{
    $rows = q($sql, $params);
    return $rows[0] ?? null;
}

function exec_sql(string $sql, array $params = array()): void
{
    db()->prepare($sql)->execute($params);
}
