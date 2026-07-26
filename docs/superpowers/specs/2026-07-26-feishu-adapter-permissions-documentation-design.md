# Feishu Adapter Permission Baseline Documentation Design

## Objective

Create one durable permission baseline for the Feishu adapter that tells an
operator exactly which Feishu permissions and platform settings are required
for each currently implemented capability. The baseline must be complete
without encouraging permissions that Work Fabric does not use.

## Source of truth

The permission matrix is derived from:

1. Feishu APIs and event types referenced by the current adapter,
   connector, plugin, and directory-evidence implementations;
2. current Feishu Open Platform documentation;
3. observed production responses from the local end-to-end verification,
   including field-level response trimming when an employment-information
   permission is absent.

The runtime code determines whether a capability is in scope. Product ideas or
future connector capabilities do not make a permission part of the baseline.

## Document location and navigation

Add `docs/guides/feishu-adapter-permissions.md` as the canonical permission
baseline. Link to it from:

- `docs/guides/feishu-collaboration-channel.md`;
- the Feishu section of the repository `README.md`.

The existing collaboration-channel guide keeps workflow and configuration
instructions. It must not duplicate the complete permission matrix.

## Permission classification

Every entry is classified by capability, not as one flat install-time list:

- **Common prerequisite**: platform configuration required by every supported
  application-bot deployment.
- **Required**: needed for the minimum supported group-mention flow.
- **Conditionally required**: needed only when a named feature is enabled,
  such as bot direct messages, outbound replies, or
  `all_internal_members`.
- **Configuration only**: event subscription, callback, visibility, release,
  or approval work that is required but is not an API scope.
- **Not required**: commonly confused permissions that current code does not
  call or consume.

The document must distinguish application-bot API permissions from custom
group-bot Webhook capabilities. Work Fabric uses a Feishu application bot;
custom group-bot Webhook URLs are not an alternative inbound transport for
this adapter.

## Capability matrix

For each current capability, record:

- Work Fabric feature and configuration switch;
- Feishu event or OpenAPI endpoint;
- exact scope code and Chinese display name;
- whether it is required or conditional;
- transport applicability: long connection, Webhook, or both;
- necessary non-scope configuration;
- expected failure or field-trimming behavior when absent;
- a safe verification method.

The baseline covers:

1. receiving `im.message.receive_v1` for group mentions;
2. receiving bot direct messages;
3. sending text and interactive-card messages through
   `POST /open-apis/im/v1/messages`;
4. resolving tenant directory membership through
   `GET /open-apis/contact/v3/users/batch`;
5. receiving card actions through the currently supported Webhook path;
6. tenant access-token acquisition, which uses application credentials but
   does not require a separate business scope.

The directory section explicitly records both:

- `contact:contact.base:readonly`;
- `contact:user.employee:readonly`.

It explains that the first scope can return a matching user while Feishu still
removes `status`; Work Fabric intentionally fails closed until the employment
scope provides `status.is_activated` and `status.is_exited`.

## Operational checklist

The document includes a copyable least-privilege checklist for:

- group-mention intake only;
- group-mention intake with outbound receipts;
- full current local scenario with internal-member wildcard admission.

It also covers application-bot enablement, event subscription, transport
selection, application release, administrator approval, bot availability,
directory visibility, and post-release validation.

No secret value, raw user identifier, tenant token, or message content may be
included in examples or diagnostics.

## Maintenance rule

Any change that adds or removes a Feishu OpenAPI endpoint, event type, returned
field dependency, or transport mode must update the permission baseline in the
same change. The matrix is documentation, not an authorization source used by
the runtime.

## Validation

Before delivery:

- cross-check every listed permission against a current code path;
- link permission claims to Feishu documentation where available;
- verify that no unimplemented permission is presented as required;
- verify all repository links;
- scan for secrets and placeholder text;
- run Markdown and repository diff checks available in the project.

