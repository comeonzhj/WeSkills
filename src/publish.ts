import type { VersionRow } from "./db/queries";
import { issue } from "./i18n/issues";
import { UploadError } from "./skills/normalize";
import { readZip, writeZip } from "./skills/zip";
import type { Env } from "./types";

export function unchangedError(latest: VersionRow): UploadError {
  return new UploadError(issue("unchanged", latest.version, latest.slug));
}

export async function repackWithSkillMd(
  env: Env,
  latest: VersionRow,
  skillMd: string,
): Promise<Uint8Array> {
  const bytes = new TextEncoder().encode(skillMd);
  const files = JSON.parse(latest.files) as Array<{ path: string }>;
  if (!files.some((f) => f.path !== "SKILL.md")) return bytes;

  const object = await env.BUCKET.get(latest.r2_key);
  if (!object) {
    throw new UploadError(issue("archiveMissing", latest.version));
  }

  const entries = await readZip(new Uint8Array(await object.arrayBuffer()));
  entries.set("SKILL.md", bytes);
  return writeZip([...entries].map(([path, data]) => ({ path, data })));
}
