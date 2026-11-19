CREATE INDEX submissions_author_queue ON submissions(author_id, id DESC);
CREATE INDEX submissions_project_queue ON submissions(project, id DESC);
