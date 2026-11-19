<img src="public/logo.png" width="64" height="64" alt="WeSkills">

# WeSkills

企业内部的 Skills 与 Agent 规范管理台。员工可以浏览团队资源、静默更新 Skills，并提交改进。项目管理员负责审核、发布和管理成员，实例管理员负责项目与账号管理。

## 快速开始

需要 Node.js 24+ 和 npm。

```bash
npm ci
cp .env.example .env
# 将 .env 中的 SESSION_SECRET 替换为 openssl rand -hex 32 的输出
npm run dev
```

打开 [本地初始化页面](http://127.0.0.1:8787/setup)，创建首个实例管理员。通过「项目」和「账号管理」添加项目与成员。

## 功能

| 功能 | 使用方式 |
| --- | --- |
| Skills | 搜索项目内可见技能，预览 Markdown，查看版本历史，下载归档或通过 CLI 安装 |
| 提交和审核 | 项目成员可提交新技能和更新。管理员逐文件查看与现行版的差异，审核通过后发布，也可删除待审核提交 |
| Agent 规范 | 浏览、搜索、提交和下载 `AGENTS.md`，将下载文件放入目标工作区根目录 |
| 排行榜 | 查看有权访问的 Skills 与 Agent 规范下载排行，以及可访问项目里的 Skills 合并贡献排行 |
| 账号与权限 | 实例管理员维护账号与项目，项目管理员维护成员、角色和资源，设备登录按所选项目授权 |

## CLI

从 GitHub 安装，或在源码目录运行 `npm install -g .`。

```bash
npm install -g git+https://github.com/comeonzhj/WeSkills.git
weskills login --server https://skills.example.com --project engineering
weskills pull --server https://skills.example.com --project engineering --skill release-notes
weskills sync --dir .agents/skills/release-notes
weskills upload --dir .agents/skills/release-notes
```

`pull`、`sync` 和 `upload` 成功时默认无输出。用 `--json` 查看结果，错误写入 stderr。默认安装到当前项目的 `.agents/skills/<skill>`，也可通过 `--dir` 指定目标。首次安装保存来源、版本和文件指纹。后续同步会自动更新未修改的目录，并保留检测到的本地修改。详见 [使用与审核](docs/usage.md)。

## 一键 SSH 部署

将下列命令中的地址、账号、密钥路径和域名替换成你的配置，可直接交给 Agent 执行。

```bash
./deploy/ssh.sh SERVER_IP SSH_USER /absolute/path/to/ssh-key skills.example.com
```

脚本在目标服务器安装独立的 systemd 服务，有域名时通过 Nginx 和 Let's Encrypt 提供 HTTPS。省略域名可使用 SSH 隧道。宝塔 Nginx 和常规 Nginx 的处理方式、初始化口令和升级方法见 [部署说明](docs/deploy.md)。

## 开发

```bash
npm run typecheck
npm test
```

- `src/routes/` 包含 Hono 路由，其中包括现有的项目、账号、设备认证和 registry 入口。
- `server/` 提供 Node 服务、SQLite 存储适配和本地归档存储。
- `migrations/` 包含按文件名依次应用的数据库迁移。
- `cli/` 包含设备登录、下载、更新和提交命令。
- `deploy/` 包含构建、SSH 传输和服务器安装脚本。
- `npm test` 在临时数据目录启动实际生产构建，验证设备登录、项目权限、CLI、审批、Agent 规范和排行。

## 致谢

WeSkills 基于 [Qsnh/skillsgist](https://github.com/Qsnh/skillsgist)，延续了项目成员管理、设备授权、Agent Skills 发现协议、归档与版本历史。感谢 Qsnh 和 Skillsgist 的贡献者。

本项目以 [MIT 许可证](LICENSE) 开源。
