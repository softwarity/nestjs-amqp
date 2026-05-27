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

Releases are tag-driven via GitHub Actions.

1. Bump the version in `package.json` and update `CHANGELOG.md`.
2. Commit: `git commit -am "chore: release vX.Y.Z"`
3. Tag: `git tag vX.Y.Z`
4. Push: `git push && git push --tags`

The `release.yml` workflow runs `npm publish --provenance --access public` and creates a GitHub release with auto-generated notes.

### npm token

The repository must have an `NPM_TOKEN` secret set in **Settings → Secrets and variables → Actions**. Create it on npmjs.com under **Access Tokens → Granular Access Token**, scoped to `@softwarity/nestjs-amqp` with publish permission.
