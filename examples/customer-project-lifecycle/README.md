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

The Console is optional. API clients and Agents use the same HTTP/TypeScript SDK
surface. Projector turns are explicit worker operations; the service does not
select a recipient, execute customer work, or decide the next workflow step.
