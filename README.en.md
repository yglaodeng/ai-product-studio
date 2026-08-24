# AI Product Studio

A local-first, human-in-the-loop AI workflow prototype that connects task understanding, project scope, approval-gated execution, verification, and traceable result delivery.

[中文说明](./README.md) · [Roadmap](./ROADMAP.md) · [Report an issue](https://github.com/yglaodeng/ai-product-studio/issues)

![AI Product Studio public project map](./docs/product-map.jpg)

## Why this project exists

AI automation becomes risky when task interpretation, authorization, project boundaries, execution, and verification are treated as separate conversations. AI Product Studio makes those stages visible and requires a human approval gate before execution.

## Core workflow

1. Understand a task and its intended project.
2. Produce a reviewable draft with explicit boundaries.
3. Wait for human confirmation.
4. Dispatch only to a registered project and allowed scope.
5. Preserve execution and verification results.
6. Return a traceable final status, including failures and retries.

## Safety principles

- The user is the only source of authorization.
- General discussion and system tests do not become executable tasks automatically.
- A draft must be approved before dispatch.
- Tasks can enter only registered projects and allowed execution scopes.
- Failed attempts remain visible; retries create new execution records.
- Conversation URLs, browser state, local paths, and task history are not published.

## Quick start

```bash
npm install
npm run build
APS_HOST=127.0.0.5 APS_PORT=8005 node server.mjs
```

Open `http://127.0.0.5:8005/`.

First-time setup requires your own conversation target and exact browser-window location. Never store cookies, tokens, or browser session data in the repository.

## Verification

```bash
npm run typecheck
node scripts/test-aps005.mjs
node scripts/test-aps006.mjs
node scripts/test-aps008.mjs
node scripts/test-controlled-development.mjs
node scripts/test-read-only-inspection.mjs
node scripts/test-collaboration-target.mjs
node scripts/test-writeback.mjs
```

The scripts isolate runtime data and example workspaces under `/private/tmp`.

## Public-repository boundaries

- The public project map includes only the three published projects.
- The repository contains no real conversation URL, task history, checkpoint, execution record, or local absolute path.
- Scheduled background monitoring is outside the public version; collaboration starts manually.
- Claude and Gemini are shown as unconnected and are not claimed as available integrations.

## Contributing

Read [CONTRIBUTING.md](./CONTRIBUTING.md) before opening an issue or pull request. Planned work and known boundaries are listed in [ROADMAP.md](./ROADMAP.md).

## License

[MIT](./LICENSE)
