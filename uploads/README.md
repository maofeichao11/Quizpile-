# 上传目录安全说明（Nginx 用户请手动加规则）

本目录存放题目图片，**不应**被当作脚本执行。

## Apache
已自带 `.htaccess`（禁止 PHP 执行 + 禁止目录列表），无需额外操作。

## Nginx（phpstudy 切成 Nginx 时请手动加）
在站点配置的 `server {}` 里加入：

```
location ^~ /exam/uploads/ {
    location ~ \.(php|php3|php4|php5|php7|pht|phtml|pl|py|cgi|sh)$ { deny all; }
    autoindex off;
}
```

改完记得重启 Nginx。

## 清理无用图片
题目删除后，它引用的图片文件仍会留在磁盘上。可用工具清理（只删没有被任何题目引用的文件，默认只列出不删）：

```
php tools/cleanup_uploads.php          # 仅列出可清理的文件
php tools/cleanup_uploads.php --delete # 真正删除
```
