import { Hono } from "hono";
import { raw } from "hono/html";
import { agentPath, getStandard, listStandards, releaseStandard } from "../agent-standards";
import { canAccessProject, canManageProject, canView, currentUser, requireUser } from "../auth";
import type { AppEnv, Ctx } from "../auth";
import { Form, page } from "../csrf";
import { getProject, listProjects } from "../db/queries";
import { renderMarkdown } from "../render/markdown";
import { stage, SubmissionError } from "../submissions";
import { SearchForm } from "../views/skills";
import { Button, ConfirmDelete, Field, Layout, PageHead, Panel, Select } from "../views/layout";

export const agentRoutes = new Hono<AppEnv>();

agentRoutes.get("/agents", async c => {
  const user = await currentUser(c);
  const q = c.req.query("q")?.slice(0, 200) ?? "";
  const entries = await listStandards(c.env.DB, user, q);
  return page(c, <Layout title="Agent 规范中心" user={user}>
    <PageHead title="Agent 规范中心" aside={user && <a href="/agents/new" class="cf-btn cf-btn-primary">上传规范</a>}>
      浏览团队的 AGENTS.md，下载后放到项目工作区根目录。
    </PageHead>
    <div class="ws-agent-search"><SearchForm action="/agents" q={q} label="搜索规范名称和描述" /></div>
    <Panel title="规范目录" flush>
      {entries.length ? <ul class="ws-queue">{entries.map(entry => <li>
        <span class="ws-queue-type">AGENTS.md</span>
        <div class="ws-queue-entry">
          <a href={agentPath(entry.id)}>{entry.name}</a>
          <span>{entry.description} · {entry.project_name}</span>
        </div>
        <span class="ws-number">{entry.download_count} 次下载</span>
      </li>)}</ul> : <p class="cf-empty">{q ? "没有找到匹配的规范。" : "暂无可见规范。"}</p>}
    </Panel>
  </Layout>);
});

async function uploadPage(c: Ctx, values: { name?: string; description?: string; project?: string; error?: string } = {}, status?: 400 | 403 | 409) {
  const user = c.get("user");
  const projects = (await listProjects(c.env.DB)).filter(project => canAccessProject(user, project.slug));
  return page(c, <Layout title="上传 Agent 规范" user={user}>
    <div class="cf-narrow">
      <PageHead title="上传 Agent 规范" error={values.error}>选择项目并上传 AGENTS.md。</PageHead>
      {projects.length ? <Form action="/agents/new" enctype="multipart/form-data" pending="正在提交…" class="cf-frame cf-form">
        <div class="cf-form-section cf-stack">
          <Field name="name" label="规范名称" value={values.name} />
          <Field name="description" label="规范描述" value={values.description} />
          <Select name="project" label="所属项目">{projects.map(project =>
            <option value={project.slug} selected={project.slug === values.project}>{project.name}</option>,
          )}</Select>
          <label class="cf-field"><span>AGENTS.md</span>
            <input type="file" name="file" accept=".md,text/markdown" class="cf-file" required />
          </label>
          <Select name="visibility" label="可见范围">
            <option value="private">项目成员</option>
            <option value="public">所有访问者</option>
          </Select>
        </div>
        <div class="cf-form-foot"><Button>提交规范</Button></div>
      </Form> : <Panel><p>加入项目后即可提交规范。</p></Panel>}
    </div>
  </Layout>, status);
}

agentRoutes.get("/agents/new", requireUser, c => uploadPage(c));
agentRoutes.post("/agents/new", requireUser, async c => {
  const body = await c.req.parseBody();
  const user = c.get("user");
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const description = typeof body.description === "string" ? body.description.trim() : "";
  const project = typeof body.project === "string" ? body.project : "";
  const visibility = body.visibility === "public" ? "public" : "private";
  try {
    if (!canAccessProject(user, project) || !await getProject(c.env.DB, project)) throw new SubmissionError("无权向此项目提交。", 403);
    if (!name || name.length > 100 || !description || description.length > 1024) throw new SubmissionError("请输入规范名称和描述，名称最多 100 字，描述最多 1024 字。");
    if (!(body.file instanceof File) || body.file.name.toUpperCase() !== "AGENTS.MD" || body.file.size > 512 * 1024) {
      throw new SubmissionError("请选择不超过 512 KB 的 AGENTS.md 文件。");
    }
    let markdown: string;
    try { markdown = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(await body.file.arrayBuffer()); }
    catch { throw new SubmissionError("请使用 UTF-8 编码的 AGENTS.md。"); }
    if (!markdown.trim() || markdown.includes("\0")) throw new SubmissionError("AGENTS.md 需要包含有效的文本。");
    const item = { project, name, description, markdown, visibility } as const;
    if (canManageProject(user, project)) {
      return c.redirect(await releaseStandard(c.env.DB, { ...item, author_id: user.id }), 303);
    }
    const entry = await stage(c.env.DB, user, { ...item, kind: "agent", slug: name, baseVersion: 0 });
    return c.redirect(`/submissions?submitted=${entry.id}`, 303);
  } catch (error) {
    if (!(error instanceof SubmissionError)) throw error;
    if (error.status === 404) return c.notFound();
    return uploadPage(c, { name, description, project, error: error.message }, error.status);
  }
});

agentRoutes.get("/agents/:id", async c => {
  const user = await currentUser(c);
  const entry = await getStandard(c.env.DB, c.req.param("id"));
  if (!entry || !canView(user, entry)) return c.notFound();
  const path = agentPath(entry.id);
  const manage = user && canManageProject(user, entry.project);
  return page(c, <Layout title={entry.name} user={user}>
    <a href="/agents">← Agent 规范中心</a>
    <PageHead title={entry.name} aside={<a href={`${path}/download`} class="cf-btn cf-btn-primary">下载 AGENTS.md</a>}>
      <p>{entry.description}</p>
      <p class="cf-hint">{entry.project_name} · {entry.download_count} 次下载 · {entry.visibility === "public" ? "公开" : "项目可见"}</p>
    </PageHead>
    <Panel title="AGENTS.md"><article class="skill-doc">{raw(await renderMarkdown(entry.markdown))}</article></Panel>
    {manage ? <div class="ws-actions">
      <Form action={`${path}/visibility`}><Button variant="outline">设为{entry.visibility === "public" ? "项目可见" : "公开"}</Button></Form>
      <ConfirmDelete action={`${path}/delete`} label="删除规范" confirm="确认删除">将永久删除此规范。</ConfirmDelete>
    </div> : null}
  </Layout>);
});

agentRoutes.get("/agents/:id/download", async c => {
  const user = await currentUser(c);
  const entry = await getStandard(c.env.DB, c.req.param("id"));
  if (!entry || !canView(user, entry)) return c.notFound();
  if (c.req.method === "GET") await c.env.DB.prepare("UPDATE agent_standards SET download_count = download_count + 1 WHERE id = ?")
    .bind(entry.id).run();
  return new Response(entry.markdown, { headers: {
    "Content-Type": "text/markdown; charset=utf-8",
    "Content-Disposition": 'attachment; filename="AGENTS.md"',
    "Cache-Control": "private, no-store",
  } });
});

for (const action of ["visibility", "delete"] as const) {
  agentRoutes.post(`/agents/:id/${action}`, requireUser, async c => {
    const entry = await getStandard(c.env.DB, c.req.param("id"));
    if (!entry || !canManageProject(c.get("user"), entry.project)) return c.notFound();
    if (action === "delete") {
      await c.env.DB.prepare("DELETE FROM agent_standards WHERE id = ?").bind(entry.id).run();
      return c.redirect("/agents", 303);
    }
    await c.env.DB.prepare("UPDATE agent_standards SET visibility = ? WHERE id = ?")
      .bind(entry.visibility === "public" ? "private" : "public", entry.id).run();
    return c.redirect(agentPath(entry.id), 303);
  });
}
