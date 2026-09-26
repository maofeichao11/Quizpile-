# Quizpile 服务器部署说明（宝塔 / 通用 Linux）

## 一、环境要求

| 组件 | 版本 | 说明 |
| --- | --- | --- |
| PHP | 7.0+（推荐 7.4 / 8.0） | 必须开启 `pdo_mysql`、`mbstring` |
| MySQL | 5.6+（或 MariaDB 10+） | 首次访问自动建库建表 |
| Web | Nginx 或 Apache | 伪静态：无需 rewrite |

项目**不需要** Composer、不需要命令行常驻进程。

## 二、宝塔部署步骤

1. **装环境**：软件商店 → 安装 Nginx + PHP（选版本）+ MySQL
2. **建站点**：网站 → 添加站点 → 填域名（或先用服务器 IP）→ 数据库选 MySQL 并创建 → 记下**数据库名/用户名/密码**
3. **上传代码**：把 `exam/` 里的全部文件上传到站点根目录，**注意不要上传 `phpMyAdmin4.8.5` 之类的额外目录**
4. **改配置**：编辑 `lib/config.php`
   ```php
   define('DB_HOST', '127.0.0.1');
   define('DB_PORT', '3306');
   define('DB_NAME', '你的数据库名');
   define('DB_USER', '你的数据库用户');
   define('DB_PASS', '你的数据库密码');
   ```
5. **设权限**：`uploads/` 必须可写
   ```bash
   chown -R www:www /www/wwwroot/你的站点/uploads
   find /www/wwwroot/你的站点 -type d -exec chmod 755 {} \;
   find /www/wwwroot/你的站点 -type f -exec chmod 644 {} \;
   ```
6. **加防护**：
   - Nginx：把 `deploy/nginx.conf.example` 的内容插进站点配置的 `server {}` 内
   - Apache：项目已自带 `lib/.htaccess`、`tools/.htaccess`、`tests/.htaccess`、`uploads/.htaccess`，确认面板开启了「允许 .htaccess」即可
7. **访问站点**：首次打开会自动创建数据表。用 `admin` 登录，**登录后第一件事是改密码**
8. **（可选）SSL**：站点设置 → SSL → Let's Encrypt 申请证书并开启强制 HTTPS

## 三、从本地迁移数据

1. 本地 phpMyAdmin 导出 `exam` 数据库 → 宝塔 phpMyAdmin 导入
2. `uploads/` 整个目录打包上传（题目图片）
3. 题库 JSON（如誉天导出的 `1.json`）不用迁移，直接在新站「批量导入 → 誉天 JSON」即可

## 四、验证部署

```bash
# 冒烟测试（服务器上也能跑，会自建临时账号并自动清理）
TK_ADMIN_PASS=<管理员密码> php tests/api_smoke.php http://你的域名/api.php
```
输出结尾 `结果: 通过 44 项，失败 0 项` 即为正常。

## 五、常见问题

| 现象 | 排查 |
| --- | --- |
| 页面提示「数据库连接失败」 | 检查 MySQL 是否启动、`lib/config.php` 账号密码、数据库是否已创建 |
| 500 错误 | 宝塔 → 站点 → 日志 → 错误日志；多为目录权限或 PHP 版本过低 |
| 图片上传失败 | `uploads/` 目录属主是否为 `www`，以及 PHP `upload_max_filesize` 是否 ≥ 5M |
| 登录后报 CSRF | 确认只用一个域名访问（IP 和域名混用会因 cookie 域不同触发），硬刷新一次即可 |
| 时间显示差 8 小时 | `lib/config.php` 里已设 `Asia/Shanghai`，若服务器时区异常可再 `date.timezone` 设一次 |
| 想禁止外网访问 | 宝塔 → 站点 → 设置 → 访问限制，或加密码访问 |

## 六、备份

宝塔 → 计划任务：
- 每日备份数据库（选对应库）
- 每周备份网站目录（含 `uploads/`）

也可以用「导出 → JSON」做题库逻辑备份。
