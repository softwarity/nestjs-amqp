# Contributing

Thanks for considering a contribution to `@softwarity/nestjs-amqp`.

## Local setup

```bash
git clone https://github.com/softwarity/nestjs-amqp.git
cd nestjs-amqp
npm ci
npm test
npm run build
```

The test suites need **Node.js ≥ 24.9**: NestJS 12 ships as ESM only, and Jest loads it through its `require(esm)` support (the `test` scripts pass `--experimental-vm-modules` for you).

## Running against a real broker

Start RabbitMQ 4.x locally (it ships AMQP 1.0 natively, no plugin needed):

```bash
docker run -d --name rabbitmq -p 5672:5672 -p 15672:15672 \
  rabbitmq:4-management
```

Declare the queues you intend to use (a stream for replies, work queues for your handlers) either via the Management UI (http://localhost:15672, `guest`/`guest`) or by mounting a `definitions.json`.

## Code style

- TypeScript strict mode, 2-space indent, single quotes, trailing commas.
- Comments explain *why*, not *what*. Don't restate the code.
- `npm run lint` must pass with 0 errors.
- `npm test` must pass.

## Releasing

Releases go through the [`softwarity/release-flow`](https://github.com/softwarity/release-flow) action. Never bump the version or write a version heading by hand.

1. Describe every change under `## NEXT RELEASE` in `RELEASE_NOTES.md`.
2. **Actions → Create Tag/Release → Run workflow**, then pick `patch` / `minor` / `major`.
3. The workflow checks the npm token, lints, tests and builds. Then release-flow bumps `package.json`, renames `## NEXT RELEASE` to the new version, tags `vX.Y.Z`, publishes the GitHub Release from those notes and reopens an empty `## NEXT RELEASE`.
4. The tag triggers `tag.yml`, which lints, tests, builds and runs `npm publish`.

The tag is pushed with the `PAT_TOKEN` secret: a push made with the default `GITHUB_TOKEN` would not trigger `tag.yml`.

### npm token

The repository must have an `NPM_TOKEN` secret set in **Settings → Secrets and variables → Actions**. Create it on npmjs.com under **Access Tokens → Granular Access Token**, scoped to `@softwarity/nestjs-amqp` with publish permission.
