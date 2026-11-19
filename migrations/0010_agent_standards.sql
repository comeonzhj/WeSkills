CREATE TABLE agent_standards (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL REFERENCES projects(slug),
  name TEXT NOT NULL COLLATE NOCASE,
  description TEXT NOT NULL,
  markdown TEXT NOT NULL,
  visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('public', 'private')),
  author_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  download_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  UNIQUE (project, name)
);
CREATE INDEX agent_standards_downloads ON agent_standards(download_count DESC);
