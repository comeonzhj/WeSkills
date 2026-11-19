CREATE TABLE submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project TEXT NOT NULL REFERENCES projects(slug) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('skill', 'agent')),
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  author_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  base_version INTEGER NOT NULL,
  visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('public', 'private')),
  markdown TEXT NOT NULL,
  archive BLOB,
  created_at INTEGER NOT NULL
);
CREATE INDEX submissions_project ON submissions(project, created_at DESC);

CREATE TABLE contributions (
  submission_id INTEGER PRIMARY KEY,
  project TEXT NOT NULL REFERENCES projects(slug) ON DELETE CASCADE,
  author_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  merged_at INTEGER NOT NULL
);
CREATE INDEX contributions_project ON contributions(project, author_id);

CREATE TRIGGER require_pending_merge BEFORE INSERT ON contributions
WHEN NOT EXISTS (
  SELECT 1 FROM submissions s
  WHERE s.id = NEW.submission_id
    AND (s.kind = 'agent' OR s.base_version = COALESCE((
      SELECT sk.latest_version FROM skills sk WHERE sk.project = s.project AND sk.slug = s.slug
    ), 0))
)
BEGIN
  SELECT RAISE(ABORT, 'submission no longer matches published version');
END;
