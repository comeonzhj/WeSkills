import { Hono } from "hono";
import { agentPath, listStandards } from "../agent-standards";
import { currentUser, skillScope } from "../auth";
import type { AppEnv } from "../auth";
import { page } from "../csrf";
import { listSkills } from "../db/queries";
import type { Viewer } from "../db/queries";
import { skillPath } from "../paths";
import { Layout, PageHead, Panel } from "../views/layout";

export const rankingRoutes = new Hono<AppEnv>();

async function contributors(db: D1Database, user: Viewer | null) {
  if (!user) return [];
  const { results } = await db.prepare(`SELECT u.username, COUNT(*) AS count
    FROM contributions c JOIN users u ON u.id = c.author_id
    WHERE c.kind = 'skill' AND (?1 = 'admin' OR EXISTS (
      SELECT 1 FROM memberships m WHERE m.user_id = ?2 AND m.project = c.project
    ))
    GROUP BY u.id ORDER BY count DESC, u.username LIMIT 20`).bind(user.role, user.id)
    .all<{ username: string; count: number }>();
  return results;
}

function Ranking(props: {
  title: string; unit: string; rows: Array<{ name: string; count: number; href?: string }>;
}) {
  return <Panel title={props.title} flush>
    {props.rows.length ? <ol class="cf-list ws-ranking-list">{props.rows.map((row, index) => <li class="cf-row">
      <span class="ws-rank-position" aria-label={`第 ${index + 1} 名`}>{index + 1}</span>
      <div class="cf-row-main">{row.href ? <a href={row.href}>{row.name}</a> : row.name}</div>
      <span class="ws-number">{row.count} {props.unit}</span>
    </li>)}</ol> : <p class="cf-empty">暂无排行数据。</p>}
  </Panel>;
}

rankingRoutes.get("/rankings", async c => {
  const user = await currentUser(c);
  const [skills, agents, people] = await Promise.all([
    listSkills(c.env.DB, { scope: skillScope(user), ranked: true }),
    listStandards(c.env.DB, user, "", true),
    contributors(c.env.DB, user),
  ]);
  return page(c, <Layout title="排行榜" user={user}>
    <PageHead title="排行榜">按下载次数和获批上线的 Skills 提交数排序。</PageHead>
    <div class="ws-rankings">
      <Ranking title="Skills 下载榜" unit="次下载" rows={skills.map(skill => ({
        name: `${skill.slug} · ${skill.project_name}`, count: skill.download_count, href: skillPath(skill),
      }))} />
      <Ranking title="Agent 规范下载榜" unit="次下载" rows={agents.map(entry => ({
        name: `${entry.name} · ${entry.project_name}`, count: entry.download_count, href: agentPath(entry.id),
      }))} />
      <Ranking title="贡献度排行榜" unit="次获批" rows={people.map(person => ({ name: person.username, count: person.count }))} />
    </div>
  </Layout>);
});
