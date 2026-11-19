# 使用和审核

## 获取资源

在 Skills 详情页复制 WeSkills CLI 安装命令，也可以下载指定历史版本。项目视图保留 Skillsgist 的整项目客户端和兼容的 registry 协议。Skillsgist 客户端安装的目录需要通过 WeSkills CLI 安装后才能获得自动更新所需的本地清单。

在「Agent 规范」按名称和描述搜索，预览规范并下载 `AGENTS.md`。把文件放在目标项目的工作区根目录。

## 提交技能

```bash
# 提交一个已有安装来源的本地目录
weskills upload --dir .agents/skills/release-notes

# 提交一个新技能
weskills upload --server https://skills.example.com --project engineering --dir ./new-skill --json
```

目录根部需要有带 YAML 元数据的 `SKILL.md`，至少提供 `name` 和 `description`。网页同样支持单个 Markdown 文件、ZIP、tar.gz 和直接粘贴。每份上传压缩后最多 2 MB，解包最多 8 MB、200 个文件。

项目管理员提交后直接发布。其他项目成员的提交使用 `员工ID-提交序号` 标识，进入「提交与审核」。现行版会保留到审核通过。提交后可以在审核列表查看待处理记录。CI 可以使用个人 API token 上传。私有资源拉取可用项目安装密钥、对应项目的设备 token 或具备访问权限的个人 API token。给 `WESKILLS_TOKEN` 赋值时同时显式设置 `--server` 或 `WESKILLS_SERVER`。

## 审核

项目管理员在「提交与审核」选择记录。技能审核页支持按文件查看新增、修改和删除，较大文件和二进制文件可通过归档下载查看。批准后系统生成新的线上版本号，将 `version` 和 `contributor` 写入 `SKILL.md` 的 YAML，并记一次贡献。批准新 Agent 规范后，规范进入其项目的目录。

上传时基于本地安装版本进行检查。遇到线上版本变化时，先参考新归档把改动合并进本地目录，再运行 `weskills upload --dir ... --rebase` 提交。审核员批准时也会校验现行版；过期提交可删除后由员工重新提交。

系统在缺少二级标题「更新规范」时向上传的 `SKILL.md` 尾部添加说明。带有 `.weskills.json` 的本地安装目录可以按说明运行静默同步。连续使用同一版本时只查询版本元数据。发现新版本且目录完整时，CLI 校验归档摘要并替换目录。

## 统计口径

排行榜每项展示前 20 名。两个下载榜按资源累计下载次数排序，并使用资源的可见范围。贡献榜统计有权限的项目里，经审核后合并为现行版的 Skills 提交数，包含新技能和更新版本。管理员直发与 Agent 规范审批不计入 Skills 合并次数。
