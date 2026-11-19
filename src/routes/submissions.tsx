import { releaseStandard } from "../agent-standards";
import { createTwoFilesPatch } from "diff";
import { Hono } from "hono";
import { canManageProject, requireUser } from "../auth";
import type { AppEnv, Ctx } from "../auth";
import { Form, page } from "../csrf";
import { getSkill, getVersion } from "../db/queries";
import { skillPath } from "../paths";
import { archiveBytes, approveSkill, SubmissionError } from "../submissions";
import type { Submission } from "../submissions";
import { readZip } from "../skills/zip";
import { Button, ConfirmDelete, Layout, PageHead, Panel } from "../views/layout";

export const submissionRoutes = new Hono<AppEnv>();
const FROM = "FROM submissions s JOIN users u ON u.id = s.author_id";
const SUMMARY = "s.id, s.project, s.kind, s.slug, s.name, s.author_id, u.username, s.base_version";

async function lookup(c: Ctx) {
  const id = Number(c.req.param("id"));
  if (!Number.isSafeInteger(id) || id < 1) return null;
  const entry = await c.env.DB.prepare(`SELECT s.*, u.username ${FROM} WHERE s.id = ?`).bind(id).first<Submission>();
  return entry && canManageProject(c.get("user"), entry.project) ? entry : null;
}

submissionRoutes.get("/submissions", requireUser, async c => {
  const user = c.get("user");
  const { results } = await c.env.DB.prepare(`SELECT ${SUMMARY} ${FROM}
     WHERE s.author_id = ?1 OR ?2 = 'admin' OR EXISTS (
       SELECT 1 FROM memberships m WHERE m.user_id = ?1 AND m.project = s.project AND m.role = 'admin'
     ) ORDER BY s.id DESC`).bind(user.id, user.role).all<Submission>();
  return page(c, <Layout title="提交与审核" user={user}>
    <PageHead title="提交与审核">{results.some(item => String(item.id) === c.req.query("submitted") && item.author_id === user.id)
      ? <span role="status">已提交，等待项目管理员审核。</span> : "查看待审核的技能和 Agent 规范。"}</PageHead>
    <Panel title="待审核" flush>
      {results.length ? <ul class="cf-list">{results.map(item => <li class="cf-row">
        <div class="cf-row-main">
          {canManageProject(user, item.project)
            ? <a href={`/submissions/${item.id}`}>{item.name}</a> : <strong>{item.name}</strong>}
          <p class="cf-hint">{item.kind === "agent" ? "AGENTS.md" : item.base_version ? `更新 v${item.base_version}` : "新技能"} · {item.project} · {item.username}</p>
        </div>
        <code>{item.author_id}-{item.id}</code>
      </li>)}</ul> : <p class="cf-empty">暂无待审核的提交。</p>}
    </Panel>
  </Layout>);
});

async function review(c: Ctx) {
  const entry = await lookup(c);
  if (!entry) return c.notFound();
  const current = entry.kind === "skill" ? await getSkill(c.env.DB, entry.project, entry.slug) : null;
  const latest = current ? await getVersion(c.env.DB, current.project, current.slug, current.latest_version) : null;
  const base = latest ? await c.env.BUCKET.get(latest.r2_key) : null;
  const before = base ? await readZip(new Uint8Array(await base.arrayBuffer())) : new Map<string, Uint8Array>();
  if (latest && !before.has("SKILL.md")) before.set("SKILL.md", new TextEncoder().encode(latest.skill_md));
  const after = entry.kind === "skill" ? await readZip(archiveBytes(entry))
    : new Map([["AGENTS.md", new TextEncoder().encode(entry.markdown)]]);
  const file = c.req.query("file") ?? (entry.kind === "skill" ? "SKILL.md" : "AGENTS.md");
  const left = before.get(file);
  const right = after.get(file);
  const names = [...new Set([...before.keys(), ...after.keys()])].sort();
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
  function patch() {
    if (!left && !right) return "";
    if ((left?.length ?? 0) + (right?.length ?? 0) > 400_000) return "文件较大，请下载归档查看完整内容。";
    try {
      const oldText = left ? decoder.decode(left) : "";
      const newText = right ? decoder.decode(right) : "";
      if (oldText.includes("\0") || newText.includes("\0")) return "二进制文件，请下载归档查看。";
      if (oldText === newText) return "文件内容一致。";
      return createTwoFilesPatch(`现行版/${file}`, `提交版/${file}`, oldText, newText, "", "", { timeout: 250 })
        ?? "差异较大，请下载归档查看完整内容。";
    } catch {
      return "二进制文件，请下载归档查看。";
    }
  }
  const diff = patch();
  const stale = entry.kind === "skill" && entry.base_version !== (current?.latest_version ?? 0);
  return page(c, <Layout title={entry.name} user={c.get("user")}>
    <a href="/submissions">← 提交与审核</a>
    <PageHead title={entry.name} error={stale ? "线上版本已变化，请让提交者合并现行版本后重新提交。" : undefined}>
      {entry.project} · {entry.username} · <code>{entry.author_id}-{entry.id}</code>
      {!current && <p class="cf-hint">发布后{entry.visibility === "public" ? "公开可见" : "项目成员可见"}</p>}
    </PageHead>
    <Panel title="版本差异" aside={entry.kind === "skill" && <a href={`/submissions/${entry.id}/archive`}>下载提交归档</a>}>
      {current && <p class="cf-hint"><a href={skillPath(current)}>查看现行 v{current.latest_version}</a></p>}
      <ul class="ws-file-list">{names.map(name => <li>
        <a aria-current={name === file ? "page" : undefined} href={`?file=${encodeURIComponent(name)}`}>{name}</a>
        <span class="cf-hint">{!before.has(name) ? " 新增" : !after.has(name) ? " 删除" :
          equalBytes(before.get(name)!, after.get(name)!) ? " 无变化" : " 修改"}</span>
      </li>)}</ul>
      <pre class="ws-diff">{diff.split("\n").map(line =>
        <span class={line.startsWith("+") ? "ws-added" : line.startsWith("-") ? "ws-removed" : undefined}>{line}{"\n"}</span>,
      )}</pre>
    </Panel>
    <div class="ws-actions">
      {!stale && <Form action={`/submissions/${entry.id}/approve`}><Button>审核通过并发布</Button></Form>}
      <ConfirmDelete label="删除提交" confirm="确认删除" action={`/submissions/${entry.id}/reject`}>
        将永久删除这份待审核提交。
      </ConfirmDelete>
    </div>
  </Layout>);
}

function equalBytes(left: Uint8Array, right: Uint8Array) {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

submissionRoutes.get("/submissions/:id", requireUser, review);
submissionRoutes.get("/submissions/:id/archive", requireUser, async c => {
  const entry = await lookup(c);
  if (!entry || entry.kind !== "skill") return c.notFound();
  return new Response(new Uint8Array(archiveBytes(entry)), { headers: {
    "Content-Type": "application/zip", "Cache-Control": "private, no-store",
    "Content-Disposition": `attachment; filename="${entry.author_id}-${entry.id}.zip"`,
  } });
});
submissionRoutes.post("/submissions/:id/reject", requireUser, async c => {
  const entry = await lookup(c);
  if (!entry) return c.notFound();
  await c.env.DB.prepare("DELETE FROM submissions WHERE id = ?").bind(entry.id).run();
  return c.redirect("/submissions", 303);
});

submissionRoutes.post("/submissions/:id/approve", requireUser, async c => {
  const entry = await lookup(c);
  if (!entry) return c.notFound();
  try {
    const path = entry.kind === "skill" ? skillPath(await approveSkill(c.env, entry))
      : await releaseStandard(c.env.DB, entry, entry);
    return c.redirect(path, 303);
  } catch (error) {
    if (error instanceof SubmissionError) return c.text(error.message, error.status);
    throw error;
  }
});
