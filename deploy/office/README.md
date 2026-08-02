# Office ARM64 image

This image packages the current single-node Work Fabric office pilot: the
Fabric HTTP service, Feishu collaboration Channel, daily-assistant Agent and
Feishu capability Provider. It preserves the existing module boundaries; the
container only composes the modules and does not move business decisions into
Fabric.

Build the pinned ARM64 image from the repository root:

```bash
docker build \
  --platform linux/arm64 \
  --tag agently/work-fabric:0.1.0-office.1 \
  --file deploy/office/Dockerfile \
  .
```

Export it for the offline office VM:

```bash
docker image save \
  --output /absolute/path/work-fabric-0.1.0-office.1-arm64.tar \
  agently/work-fabric:0.1.0-office.1
```

The image contains no credentials or runtime state. At runtime mount a mode
`0600` environment file at `/run/secrets/work-fabric.env` and a persistent
volume at `/app/var`. The default deployment listener is `0.0.0.0:8787`
inside the container; Compose must publish it only to a VM loopback address.

This is a single-node SQLite pilot, not a high-availability deployment. A
clustered production deployment should use the existing storage SPI with the
PostgreSQL adapter and deployment-owned identity/authority composition.

The office container is the exclusive owner of the real Feishu long
connection for its application credentials. Local development while this
deployment is active must use `npm run local:debug:start`, whose dedicated
bundle contains no Feishu Channel or Provider. Do not run a second
`local:feishu:start` with the same Feishu application.

The image health check verifies the HTTP Service, Daily Assistant and Feishu
Capability Provider processes as one deployment composition. A live Fabric
port with a dead Agent or Provider is unhealthy. The SDK treats server
heartbeat traffic as a healthy SSE connection, so periodic idle-window closes
do not consume the consecutive reconnect-failure budget.
