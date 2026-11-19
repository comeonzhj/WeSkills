import { canAccessProject, canManageProject, randomHex } from "./auth";
import { getProject, getSkill, getVersion, insertVersion, setVisibility } from "./db/queries";
import type { Viewer } from "./db/queries";
import { RENDER_REVISION, renderSkillMd } from "./render/markdown";
import { normalizeUpload } from "./skills/normalize";
import type { NormalizedSkill } from "./skills/normalize";
import { ensureUpdateRule, stampContribution } from "./skills/update-rule";
import type { Env } from "./types";

export class SubmissionError extends Error {
  constructor(message: string, readonly status: 400 | 403 | 404 | 409 = 400) { super(message); }
}

export interface Submission {
  id: number;
  project: string;
  kind: "skill" | "agent";
  slug: string;
  name: string;
  description: string;
  author_id: string;
  username: string;
  base_version: number;
  visibility: "public" | "private";
  markdown: string;
  archive: ArrayBuffer | Uint8Array | number[] | null;
  created_at: number;
}

export function stage(db: D1Database, user: Viewer, item: {
  project: string; kind: Submission["kind"]; slug: string; name: string; description: string;
  baseVersion: number; visibility?: Submission["visibility"]; markdown: string; archive?: Uint8Array;
}) {
  return db.prepare(`INSERT INTO submissions
    (project, kind, slug, name, description, author_id, base_version, visibility, markdown, archive, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`)
    .bind(item.project, item.kind, item.slug, item.name, item.description, user.id, item.baseVersion,
      item.visibility ?? "private", item.markdown, item.archive ? new Uint8Array(item.archive).buffer : null, Date.now())
    .first<{ id: number }>().then(row => ({ pending: true as const, id: row!.id, version: `${user.id}-${row!.id}` }));
}

export function mergeStatements(db: D1Database, entry: Submission): [D1PreparedStatement, D1PreparedStatement] {
  return [
    db.prepare("INSERT INTO contributions VALUES (?, ?, ?, ?, ?)")
      .bind(entry.id, entry.project, entry.author_id, entry.kind, Date.now()),
    db.prepare("DELETE FROM submissions WHERE id = ?").bind(entry.id),
  ];
}

export async function submitSkill(env: Env, user: Viewer, bytes: Uint8Array, opts: {
  project: string; expectedSlug?: string; visibility?: Submission["visibility"]; baseVersion?: number;
}) {
  if (!canAccessProject(user, opts.project) || !await getProject(env.DB, opts.project)) {
    throw new SubmissionError("Project access required", 403);
  }
  const normalized = await normalizeUpload(bytes, ensureUpdateRule);
  if (opts.expectedSlug && opts.expectedSlug !== normalized.name) throw new SubmissionError("Skill name does not match");
  const existing = await getSkill(env.DB, opts.project, normalized.name);
  const baseVersion = existing?.latest_version ?? 0;
  if (opts.baseVersion !== undefined && opts.baseVersion !== baseVersion) {
    throw new SubmissionError("The published version has changed. Reconcile the local edits before uploading.", 409);
  }
  const latest = existing ? await getVersion(env.DB, opts.project, normalized.name, baseVersion) : null;
  if (latest?.digest === normalized.digest) {
    if (canManageProject(user, opts.project)) {
      if (!await env.BUCKET.head(latest.r2_key)) await env.BUCKET.put(latest.r2_key, normalized.zip);
      if (opts.visibility) await setVisibility(env.DB, opts.project, normalized.name, opts.visibility);
    }
    return { project: opts.project, slug: normalized.name, version: baseVersion, digest: latest.digest, unchanged: true };
  }
  if (canManageProject(user, opts.project)) {
    return releaseSkill(env, { ...opts, baseVersion }, normalized, user.id, existing?.id);
  }
  return stage(env.DB, user, { ...opts, kind: "skill", slug: normalized.name, name: normalized.name,
    description: normalized.description, baseVersion, markdown: normalized.skillMd, archive: normalized.zip });
}

async function releaseSkill(env: Env, opts: {
  project: string; visibility?: Submission["visibility"]; baseVersion: number;
}, normalized: NormalizedSkill, authorId: string, skillId = randomHex(8), entry?: Submission) {
  const version = opts.baseVersion + 1;
  const key = `artifacts/${skillId}/${version}-${randomHex(8)}.zip`;
  const html = await renderSkillMd(normalized.skillMd);
  await env.BUCKET.put(key, normalized.zip, { httpMetadata: { contentType: "application/zip" } });
  try {
    const merge = entry ? mergeStatements(env.DB, entry) : null;
    const visibility = !entry && opts.visibility
      ? env.DB.prepare("UPDATE skills SET visibility = ? WHERE id = ?").bind(opts.visibility, skillId)
      : null;
    await insertVersion(env.DB, {
      skillId, project: opts.project, slug: normalized.name, digest: normalized.digest, size: normalized.zip.byteLength,
      name: normalized.name, description: normalized.description, skill_md: normalized.skillMd, html,
      html_rev: RENDER_REVISION, files: JSON.stringify(normalized.files), authorId, visibility: opts.visibility ?? "private",
    }, { version, key, before: merge ? [merge[0]] : [], after: merge ? [merge[1]] : visibility ? [visibility] : [] });
  } catch (error) {
    await env.BUCKET.delete(key);
    if (/UNIQUE constraint|no longer matches/i.test(String(error))) {
      throw new SubmissionError("The published version or submission has changed", 409);
    }
    throw error;
  }
  return { project: opts.project, slug: normalized.name, version, digest: normalized.digest, unchanged: false, files: normalized.files };
}

export async function approveSkill(env: Env, entry: Submission) {
  const existing = await getSkill(env.DB, entry.project, entry.slug);
  const baseVersion = existing?.latest_version ?? 0;
  if (entry.base_version !== baseVersion) throw new SubmissionError("The published version or submission has changed", 409);
  const normalized = await normalizeUpload(archiveBytes(entry), markdown => stampContribution(markdown, entry.author_id, baseVersion + 1), true);
  return releaseSkill(env, { project: entry.project, visibility: entry.visibility, baseVersion },
    normalized, entry.author_id, existing?.id, entry);
}

export function archiveBytes(entry: Submission): Uint8Array {
  if (!entry.archive) throw new SubmissionError("Missing archive", 404);
  return new Uint8Array(entry.archive instanceof ArrayBuffer ? entry.archive : Uint8Array.from(entry.archive));
}
