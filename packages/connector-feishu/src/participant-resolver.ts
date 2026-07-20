import type {
  ConnectorIngressClaim,
  ConnectorResolvedIdentity,
} from "@work-fabric/connector-spi";

export type FeishuParticipantResolution =
  | {
      readonly kind: "resolved";
      readonly identity: ConnectorResolvedIdentity;
      readonly representation_grant?: string;
    }
  | { readonly kind: "denied"; readonly reason_code: string }
  | { readonly kind: "temporarily_unavailable"; readonly reason_code: string };

export interface FeishuParticipantResolver {
  resolve(input: {
    readonly claim: ConnectorIngressClaim;
    readonly external_subject_id: string;
    readonly external_subject_type: "human";
  }): Promise<FeishuParticipantResolution>;
}
