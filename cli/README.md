# WeSkills CLI

Install, update, and submit Skills from a [WeSkills registry](https://github.com/comeonzhj/WeSkills).

```sh
npm install -g weskills
weskills login --server https://skills.example.com --project engineering
weskills pull --server https://skills.example.com --project engineering --skill release-notes
weskills sync --dir .agents/skills/release-notes
weskills upload --dir .agents/skills/release-notes
```

Omit `--skill` to install all visible Skills in a project. Installations go into `.agents/skills/`. Use `--dir` to specify a single Skill's directory or the parent directory for a project install.

Pull, sync, and upload are quiet by default. Use `--json` to see results. Sync preserves local edits. In CI, use an explicitly configured server with `WESKILLS_TOKEN` for a project install key or account token.
