# Customer project lifecycle

This example is the runnable shell for a customer project moving from intent,
requirements and contract agreement through implementation handoffs, staged
acceptance, deployment and operations. Feishu documents, Feishu notifications,
a local Agent Runtime and Codex remain external participants; Work Fabric only
connects their identities, references, handoffs, state transfers and events.

1. Copy `config.example.json` outside source control and replace every value.
2. Add only explicit identity records and default-deny authority rules required
   by the participants in the scenario.
3. Set `WORK_FABRIC_CONFIG` to that file.
4. Run `npm run service:start` from the repository root.

To submit the complete Offer → Accept → Status → Result → Verify sequence only
through the public SDK, configure deployment-owned Authority rules for both
participants, then set `WORK_FABRIC_URL`, tenant/exchange IDs, human/Agent
tokens and run:

```sh
npm --workspace @work-fabric/example-customer-project-lifecycle run seed
```

The static local Authority adapter is deliberately exact-resource and
default-deny. A deployment that wants to accept newly generated Handoff IDs
must inject a policy adapter that authorizes from trusted participant and
Handoff facts; the example does not introduce wildcard production grants.

The Console is optional. API clients and Agents use the same HTTP/TypeScript SDK
surface. Projector turns are explicit worker operations; the service does not
select a recipient, execute customer work, or decide the next workflow step.
