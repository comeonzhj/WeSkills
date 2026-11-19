# 通过 SSH 部署

本机安装 Node.js 24+、npm、SSH 客户端和 curl。目标云主机需要 Linux、systemd、curl、OpenSSL 和可通过 SSH 登录的 root 或具备免交互 sudo 权限的用户。缺少 Node 24+ 时，脚本会为 x86_64 和 arm64 下载 Node 24，校验包的 SHA-256，并安装到 WeSkills 的私有目录。

## HTTPS 域名

将域名解析到目标服务器。服务器需要有正在运行的 Nginx、Certbot 和可从公网访问的 80、443 端口。脚本支持常规 Nginx 的 `/etc/nginx/conf.d` 和宝塔 Nginx 的站点目录。

```bash
./deploy/ssh.sh SERVER_IP SSH_USER /absolute/path/to/ssh-key skills.example.com
```

脚本创建 `weskills.service`，监听 `127.0.0.1:8787`，写入该域名专用的虚拟主机，并使用 Certbot webroot 签发证书。通过 `WESKILLS_PORT=18878` 可以在首次部署时指定空闲端口。脚本检测已配置的同名站点，在 Nginx 配置通过检查后才重载，并在启动或 HTTPS 验证失败时恢复先前的服务切换和站点配置。

省略域名可使用 SSH 隧道访问。

```bash
./deploy/ssh.sh SERVER_IP SSH_USER /absolute/path/to/ssh-key
ssh -i /absolute/path/to/ssh-key -N -L 8787:127.0.0.1:8787 SSH_USER@SERVER_IP
```

## 初始化管理员

首次部署自动生成初始化口令。以服务器管理员账号通过 SSH 读取 `/etc/weskills/server.env` 中的 `SETUP_TOKEN`，然后打开 `/setup`。输入口令并创建管理员账号。完成后初始化入口自动关闭。

## 升级与运维

- 用同一部署命令升级。服务启动时自动应用新增迁移。
- 数据位于 `/var/lib/weskills`，包含 SQLite 数据库和 Skills 归档。升级前可暂停 WeSkills 服务，对该目录和 `/etc/weskills/server.env` 一起备份。配置中包含会话签名密钥，按服务器凭证管理。
- 服务日志可通过 `journalctl -u weskills` 查看。部署后用目标域名的 `/healthz` 验证路由。
- 版本构建位于 `/opt/weskills/releases`。脚本回退可执行版本时，已应用的数据库迁移仍会保留。需要回退数据库时使用升级前备份。
- Certbot 在续签该域名证书后通过专用钩子校验并重载同一 Nginx。
