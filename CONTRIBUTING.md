# Contributing to WeSkills

Use Node.js 24+ and run `npm ci`. Copy `.env.example` to `.env`, set a session secret, and start the service with `npm run dev`. The first account is created at `/setup`.

Run `npm run typecheck` and `npm test` before opening a pull request. The production integration test starts a disposable Node server and database, then exercises the CLI and web workflows. To substitute local test Skills for the generated fixtures, set `WESKILLS_FIXTURES` to an absolute directory holding `Interaction-PRD` and `PM-Make`.

Keep database changes in new numbered SQL migrations. New web mutations should use the session CSRF form helper or the project-authorized bearer API. The source tree includes Skillsgist's Worker test harness for reference and protocol compatibility work.

The CLI npm package lives in `cli/` and uses its own version and lightweight dependencies. Use `npm pack ./cli --dry-run` to inspect the package and `npm run verify:cli` to exercise the client against the Node server.
