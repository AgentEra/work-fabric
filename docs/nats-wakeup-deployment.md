# NATS Wakeup acceleration deployment

NATS JetStream is an optional reaction-speed accelerator for Work Fabric's
internal partition Wakeups. It is not a source of Handoff truth, a work queue
for participants, a scheduler or an Agent runtime. Journal, Outbox, projection
checkpoints, delivery positions, readiness catalog and leases remain in the
authoritative database. Database polling must stay enabled in every topology.

## Resources and payload boundary

The production Adapter publishes a closed-shape
`workfabric.partition-wakeup.v1` metadata payload of at most 4,096 bytes. It
contains only Wakeup, Exchange, Tenant and Partition IDs, one of the four
mechanical work kinds, an observed position and a timestamp. Context, prompts,
instructions, Handoff content, results, artifacts, evidence and credentials
are rejected by the codec.

Subjects have this form:

```text
<prefix>.<key-id>.<HMAC-SHA256 tenant token>.<work-kind>
```

Raw Tenant IDs never enter subjects. A durable pull consumer has exact filter
subjects for its explicit Tenant assignment. A deployment may assign 1–250
Tenants to one homogeneous Worker group; the resulting filter set is bounded
to 4–1,000 subjects.

## Topology configuration

Example `nats-wakeup.json`:

```json
{
  "stream": "WF_WAKEUP",
  "consumer": "wf_runtime_east",
  "subject_prefix": "workfabric.cluster.wakeup.v1",
  "subject_key_id": "key1",
  "allowed_tenant_ids": ["tenant_01"],
  "max_age_seconds": 900,
  "max_bytes": 268435456,
  "replicas": 3,
  "ack_wait_seconds": 30,
  "max_deliver": 5,
  "max_ack_pending": 1024,
  "max_waiting": 32
}
```

The subject key is a 32–128 byte random secret encoded as canonical base64url.
It is read only from `WORK_FABRIC_NATS_SUBJECT_KEY`; it must not be written to
the JSON file, command line, logs or metrics.

```sh
export WORK_FABRIC_NATS_SUBJECT_KEY='<base64url secret>'

# Default is plan and never mutates.
npm run nats:wakeup-topology -- \
  --connection-string "$NATS_MANAGEMENT_URL" \
  --config /absolute/path/nats-wakeup.json --plan

# Fails if any create/update is still required.
npm run nats:wakeup-topology -- \
  --connection-string "$NATS_MANAGEMENT_URL" \
  --config /absolute/path/nats-wakeup.json --verify

# The only mutating mode. It creates or compatibly updates; never deletes/purges.
npm run nats:wakeup-topology -- \
  --connection-string "$NATS_MANAGEMENT_URL" \
  --config /absolute/path/nats-wakeup.json --apply
```

The stream uses Limits retention, file storage, discard-old, a 4,096-byte
message limit, bounded age/bytes, a 120-second duplicate window and 1–5
replicas. The consumer uses explicit Ack, deliver-new, instant replay and
bounded Ack wait, deliveries, pending Acks and waiting pulls. Existing subject
namespace, retention or storage drift fails closed because safe repair would
require replacement; Work Fabric never deletes those resources automatically.

## Credentials and network security

Use separate deployment identities:

- topology identity: inspect/create/update only the named stream and consumer;
- runtime Publisher identity: publish only the configured Wakeup namespace;
- runtime Consumer identity: bind/pull/Ack only the configured durable consumer.

Runtime identities must not have JetStream delete or purge permission.
TLS trust, client certificates, NKeys/JWTs, credential rotation, server URLs
and connection creation belong to the deployment. `service-node`, Cluster SPI
and Cluster Runtime do not read ambient NATS credentials and contain no NATS
dependency. The technology-specific Adapter receives an already-authenticated
`NatsConnection`; connection drain remains deployment-owned.

## Subject-key rotation and Tenant assignment

Rotate the HMAC subject key by choosing a new `subject_key_id`, applying the new
filter set, and rolling Worker groups onto the new key. Do not reuse an ID for
different key bytes. A temporary hint gap is safe because database polling
continues. Remove old filters/resources only through a separately reviewed
deployment operation after every old runtime is gone; Work Fabric never does
this automatically.

Tenant assignment is authenticated deployment configuration, not user input
or Broker discovery. Different Tenant groups should use distinct durable
consumer names. Every Worker sharing a durable name must use the same prefix,
key ID, key bytes and Tenant set; run `--verify` before starting the group.

## Degradation, recovery and shutdown

Publish timeout/disconnect/no-responder returns `retryable_failure`. Pull
failure rejects with the stable `wakeup_transport_unavailable` code. Neither
outcome blocks bounded readiness scans. Lost and expired hints are recovered
from database state; duplicate/stale hints are coalesced by the Host queue and
authoritative owner checkpoint.

Monitor only fixed outcomes and aggregate rates: publish retryable rate, pull
retryable rate, poison termination count, queue pressure, catalog scan health,
turn latency and projection/delivery lag. Never label telemetry with Tenant,
Partition, subject, stream, consumer, Wakeup/Event/Handoff ID, URL, credential
or payload. NATS account/stream metrics remain deployment monitoring data.

Shutdown order:

1. stop new API/Connector ingress as appropriate for the deployment;
2. drain the Cluster Host, which aborts intake and bounds active turns;
3. close the NATS Wakeup Adapter;
4. drain/close the deployment-owned NATS connection;
5. stop database/storage dependencies.

Old hints may expire under `max_age` without repair. They contain no authority;
retention is intentionally finite. Stream or consumer deletion is an explicit
operator decision after confirming database polling and all Worker groups.

## Verification

```sh
npm run verify:nats
npm run verify:nats:release
npm run check:cluster-boundaries
npm run check:sensitive-observability
npm run nats:release -- npm run benchmark:wakeup -- \
  --messages 1000 --publishers 4 --consumers 4 --samples 3
```

The release runner downloads the exact official NATS Server 2.12.1 archive,
verifies its `SHA256SUMS` entry, starts a temporary JetStream server, runs the
command and removes the temporary resources. See the recorded
[Wakeup transport baseline](performance-nats-wakeup-baseline.md).
