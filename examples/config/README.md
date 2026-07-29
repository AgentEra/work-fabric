# Global configuration examples

`service-feishu.yaml` is the runnable SQLite-local profile for the built-in
Feishu collaboration-channel plugin. Work Fabric reads the file named by
`WORK_FABRIC_CONFIG`; configuration consumers depend on the Provider-backed
configuration service, not on YAML itself.

All declared secrets use exact `${ENVIRONMENT_VARIABLE}` references. Literal
secrets are rejected unless `service.development_mode` is explicitly `true`.
The YAML Provider accepts one bounded JSON-compatible document and rejects
duplicate keys, aliases, custom tags, multiple documents and excessive depth.

The local Authority adapter is exact-resource and default-deny. The example
permits the mapped Feishu user to create an Intake Handoff. Add exact Handoff
rules for local experiments after the Handoff ID is known, or replace the local
Authority adapter with the deployment policy used by your Agent Runtime.

The example also declares one static Feishu chat and one canonical Subscription.
Replace the `*-example` tenant, bot, user and chat identifiers before use. Static
subscriptions are trusted deployment bootstrap state; event audience checks
still run for every delivery, and participant-managed subscription changes keep
using the public Authority-protected API.

`local-feishu-assistant.bundle.yaml` also enables independent Message,
Document and Calendar Provider Citizens. The Calendar block contains identity
only: calendar IDs and defaults are dynamic Provider state. Bootstrap with
`npm run feishu-calendar:admin -- create-and-bind ...` or `bind-existing ...`.
The command reads `WORK_FABRIC_ENV_FILE`, `WORK_FABRIC_CONFIG` and
`WORK_FABRIC_ADMIN_PRINCIPAL_ID`, and never accepts credentials as flags.
