import { Hono } from "hono";
import { canAccessProject, requireManagedSkill, requireUser, userFromApiToken } from "../auth";
import type { AppEnv, Ctx } from "../auth";
import { API_PREFIX, page } from "../csrf";
import { getVersion, getViewer, getSkill, listProjects } from "../db/queries";
import { messages } from "../i18n";
import { issue, issueText } from "../i18n/issues";
import type { VersionRow, Viewer } from "../db/queries";
import { skillPath } from "../paths";
import { repackWithSkillMd, unchangedError } from "../publish";
import { bearerAccess } from "../bearer";
import { submitSkill, SubmissionError } from "../submissions";
import { UploadError } from "../skills/normalize";
import { EditSkillPage, NewSkillPage, UploadVersionPage } from "../views/publish";

export const publishRoutes = new Hono<AppEnv>();

function visibilityOf(value: unknown): "public" | "private" | undefined {
  if (value === undefined) return undefined;
  return value === "public" ? "public" : "private";
}

function withLf(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

function publishFailure(err: unknown): (UploadError | SubmissionError) | null {
  return err instanceof UploadError || err instanceof SubmissionError ? err : null;
}

/** The paths a text-only edit carries over untouched — everything but SKILL.md. */
function siblingPaths(latest: VersionRow): string[] {
  return (JSON.parse(latest.files) as Array<{ path: string }>)
    .map((f) => f.path)
    .filter((path) => path !== "SKILL.md");
}

async function bytesFromForm(body: Record<string, unknown>): Promise<Uint8Array> {
  const file = body.file;
  if (file instanceof File && file.size > 0) {
    return new Uint8Array(await file.arrayBuffer());
  }
  const markdown = typeof body.markdown === "string" ? withLf(body.markdown).trim() : "";
  if (markdown) return new TextEncoder().encode(`${markdown}\n`);
  throw new UploadError(issue("nothingToPublish"));
}

function chosenProject(user: Viewer, value: unknown): string {
  if (typeof value === "string" && value !== "") return value;
  if (user.memberships.length === 1) return user.memberships[0].project;
  throw new UploadError(user.memberships.length === 0 ? issue("noProjectToPublish") : issue("chooseProject"));
}

export async function projectsFor(c: Ctx) {
  const user = c.get("user");
  return (await listProjects(c.env.DB)).filter(project => canAccessProject(user, project.slug));
}

function skillResult(c: Ctx, result: Awaited<ReturnType<typeof submitSkill>>) {
  if ("pending" in result) return c.redirect(`/submissions?submitted=${result.id}`, 303);
  return c.redirect(skillPath(result), 302);
}

function failureText(c: Ctx, error: UploadError | SubmissionError) {
  return error instanceof UploadError ? issueText(messages(c), error.issue) : error.message;
}

publishRoutes.get("/new", requireUser, async (c) => {
  const projects = await projectsFor(c);
  const wanted = c.req.query("project");
  const project = projects.some((p) => p.slug === wanted) ? wanted : undefined;
  return page(c, <NewSkillPage user={c.get("user")} projects={projects} project={project} />);
});

publishRoutes.post("/new", requireUser, async (c) => {
  const user = c.get("user");
  const body = await c.req.parseBody();
  const markdown = typeof body.markdown === "string" ? body.markdown : undefined;
  const selected = typeof body.project === "string" ? body.project : undefined;
  try {
    const bytes = await bytesFromForm(body);
    const result = await submitSkill(c.env, user, bytes, {
      project: chosenProject(user, body.project),
      visibility: visibilityOf(body.visibility),
    });
    if ("unchanged" in result && result.unchanged) {
      const latest = await getVersion(c.env.DB, result.project, result.slug, result.version);
      if (latest) throw unchangedError(latest);
    }
    return skillResult(c, result);
  } catch (err) {
    const failure = publishFailure(err);
    if (!failure) throw err;
    return page(
      c,
      <NewSkillPage
        user={user}
        projects={await projectsFor(c)}
        project={selected}
        error={failureText(c, failure)}
        markdown={markdown}
      />,
      failure.status,
    );
  }
});

publishRoutes.get("/p/:project/s/:slug/edit", requireUser, async (c) => {
  const guard = await requireManagedSkill(c, c.req.param("project"), c.req.param("slug"), "edit");
  if (!guard.ok) return guard.response;
  const { skill } = guard;
  const latest = await getVersion(c.env.DB, skill.project, skill.slug, skill.latest_version);
  if (!latest) return c.notFound();
  return page(
    c,
    <EditSkillPage user={c.get("user")} skill={skill} markdown={latest.skill_md} files={siblingPaths(latest)} />,
  );
});

publishRoutes.post("/p/:project/s/:slug/edit", requireUser, async (c) => {
  const user = c.get("user");
  const guard = await requireManagedSkill(c, c.req.param("project"), c.req.param("slug"), "edit");
  if (!guard.ok) return guard.response;
  const { skill } = guard;
  const latest = await getVersion(c.env.DB, skill.project, skill.slug, skill.latest_version);
  if (!latest) return c.notFound();
  const body = await c.req.parseBody();
  const markdown = typeof body.markdown === "string" ? body.markdown : "";
  try {
    const text = withLf(markdown).trim();
    if (!text) throw new UploadError(issue("emptySkillMd"));
    if (text === withLf(latest.skill_md).trim()) throw unchangedError(latest);
    // This page can only change SKILL.md; the other files come from the previous version's archive.
    const bytes = await repackWithSkillMd(c.env, latest, `${text}\n`);
    const result = await submitSkill(c.env, user, bytes, {
      project: skill.project, expectedSlug: skill.slug, baseVersion: latest.version,
    });
    return skillResult(c, result);
  } catch (err) {
    const failure = publishFailure(err);
    if (!failure) throw err;
    return page(
      c,
      <EditSkillPage
        user={user}
        skill={skill}
        markdown={markdown}
        files={siblingPaths(latest)}
        error={failureText(c, failure)}
      />,
      failure.status,
    );
  }
});

publishRoutes.get("/p/:project/s/:slug/upload", requireUser, async (c) => {
  const skill = await getSkill(c.env.DB, c.req.param("project"), c.req.param("slug"));
  if (!skill || !canAccessProject(c.get("user"), skill.project)) return c.notFound();
  return page(c, <UploadVersionPage user={c.get("user")} skill={skill} />);
});

publishRoutes.post("/p/:project/s/:slug/upload", requireUser, async (c) => {
  const user = c.get("user");
  const skill = await getSkill(c.env.DB, c.req.param("project"), c.req.param("slug"));
  if (!skill || !canAccessProject(c.get("user"), skill.project)) return c.notFound();
  const body = await c.req.parseBody();
  try {
    const file = body.file;
    if (!(file instanceof File) || file.size === 0) {
      throw new UploadError(issue("chooseArchive"));
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    const result = await submitSkill(c.env, user, bytes, {
      project: skill.project, expectedSlug: skill.slug, baseVersion: skill.latest_version,
    });
    if ("unchanged" in result && result.unchanged) {
      const latest = await getVersion(c.env.DB, skill.project, skill.slug, result.version);
      if (latest) throw unchangedError(latest);
    }
    return skillResult(c, result);
  } catch (err) {
    const failure = publishFailure(err);
    if (!failure) throw err;
    return page(c, <UploadVersionPage user={user} skill={skill} error={failureText(c, failure)} />, failure.status);
  }
});

async function publishFromApi(c: Ctx, project: string, slug: string): Promise<Response> {
  const user = await projectAccount(c, project);
  if (!user) return c.json({ error: "authentication_required" }, 401);
  const bytes = new Uint8Array(await c.req.arrayBuffer());
  try {
    const result = await submitSkill(c.env, user, bytes, {
      project,
      expectedSlug: slug,
      visibility: visibilityOf(c.req.query("visibility")),
      baseVersion: c.req.query("base") === undefined ? undefined : Number(c.req.query("base")),
    });
    return c.json(result, "pending" in result ? 202 : result.unchanged ? 200 : 201);
  } catch (err) {
    const failure = publishFailure(err);
    if (!failure) throw err;
    return c.json({ error: failure instanceof UploadError ? failure.code : "submission_failed", message: failure.message }, failure.status);
  }
}

publishRoutes.put(`${API_PREFIX}projects/:project/skills/:slug`, (c) =>
  publishFromApi(c, c.req.param("project"), c.req.param("slug")),
);

export async function projectAccount(c: Ctx, project: string) {
  const apiUser = await userFromApiToken(c);
  if (apiUser) return apiUser;
  const access = await bearerAccess(c);
  return access.kind === "login" && access.projects.includes(project)
    ? getViewer(c.env.DB, access.userId)
    : null;
}

publishRoutes.get(`${API_PREFIX}projects/:project/skills/:slug`, async c => {
  const { project, slug } = c.req.param();
  const skill = await getSkill(c.env.DB, project, slug);
  const account = await projectAccount(c, project);
  const access = account ? null : await bearerAccess(c);
  const allowed = account ? canAccessProject(account, project)
    : access?.kind === "install_key" && access.project === project;
  if (!skill || (!allowed && skill.visibility !== "public")) return c.notFound();
  const latest = await getVersion(c.env.DB, project, slug, skill.latest_version);
  if (!latest) return c.notFound();
  c.header("Cache-Control", "private, no-store");
  return c.json({
    version: latest.version, digest: latest.digest,
    url: `/p/${project}/d/${slug}/${latest.digest.slice(7)}.zip`,
  });
});
