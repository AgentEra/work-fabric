# PostgreSQL Storage Adapter

`@work-fabric/adapter-storage-postgres` persists Exchange authority and runtime state behind the existing SPI.

It provides:

- atomic event, command and outbox commits;
- projection checkpoints and immutable first-write failures;
- tenant-scoped subscriptions;
- cursor delivery positions, active-delivery CAS, attempts and dead letters;
- fenced outbox and worker leases.

The adapter never executes a participant's work. It records handoffs, statuses, receipts and delivery facts while people, Agents and external systems continue executing in their own environments.

Use `EXCHANGE_AUTHORITY_MIGRATION`, `RUNTIME_STATE_MIGRATION`,
`RUNTIME_STATE_HARDENING_MIGRATION` and the common tenant migration with the shared migration runner.
