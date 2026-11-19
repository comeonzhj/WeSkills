import { randomHex, skillScope } from "./auth";
import type { Viewer } from "./db/queries";
import { mergeStatements, SubmissionError } from "./submissions";
import type { Submission } from "./submissions";

export interface AgentStandard {
  id: string;
  project: string;
  project_name: string;
  name: string;
  description: string;
  markdown: string;
  visibility: "private" | "public";
  download_count: number;
  created_at: number;
}

export const agentPath = (id: string) => `/agents/${id}`;

export async function listStandards(db: D1Database, viewer: Viewer | null, q = "", ranked = false) {
  const scope = skillScope(viewer);
  const filter = scope.kind === "all" ? "1" : scope.kind === "public" ? "a.visibility = 'public'"
    : "(a.visibility = 'public' OR EXISTS (SELECT 1 FROM memberships m WHERE m.project = a.project AND m.user_id = ?2))";
  const { results } = await db.prepare(`SELECT a.id, a.project, p.name AS project_name, a.name, a.description,
    a.visibility, a.download_count, a.created_at FROM agent_standards a JOIN projects p ON p.slug = a.project
    WHERE ${filter} AND (a.name LIKE ?1 OR a.description LIKE ?1)
    ORDER BY ${ranked ? "a.download_count DESC, a.name, a.id LIMIT 20" : "a.created_at DESC"}`)
    .bind(`%${q}%`, ...scope.kind === "member" ? [scope.userId] : []).all<Omit<AgentStandard, "markdown">>();
  return results;
}

export async function releaseStandard(db: D1Database, item: {
  project: string; name: string; description: string; markdown: string; visibility: AgentStandard["visibility"]; author_id: string;
}, entry?: Submission) {
  const id = randomHex(10);
  const insert = db.prepare(`INSERT INTO agent_standards (id, project, name, description, markdown, visibility, author_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).bind(id, item.project, item.name, item.description, item.markdown, item.visibility, item.author_id, Date.now());
  try {
    const merge = entry ? mergeStatements(db, entry) : null;
    if (merge) await db.batch([merge[0], insert, merge[1]]);
    else await insert.run();
  } catch (error) {
    if (/UNIQUE constraint|no longer matches/i.test(String(error))) {
      throw new SubmissionError("该项目已有同名规范，或提交已经处理。", 409);
    }
    throw error;
  }
  return agentPath(id);
}

export const getStandard = (db: D1Database, id: string) => db.prepare(`SELECT a.*, p.name AS project_name
  FROM agent_standards a JOIN projects p ON p.slug = a.project WHERE a.id = ?`).bind(id).first<AgentStandard>();
