export type ConsoleLocale = "en" | "zh-CN";

export const LOCALE_STORAGE_KEY = "work-fabric-console-locale";

export interface ConsoleMessages {
  readonly brandSubtitle: string;
  readonly navigationHandoffs: string;
  readonly navigationOperations: string;
  readonly primaryNavigation: string;
  readonly partition: string;
  readonly open: string;
  readonly footer: string;
  readonly language: string;
  readonly loading: string;
  readonly loadErrorTitle: string;
  readonly unknownError: string;
  readonly retry: string;
  readonly fatalTitle: string;
  readonly recoveryDenied: string;
  readonly recoveryResultPrefix: string;
  readonly responsibilityEyebrow: string;
  readonly responsibilityTitle: string;
  readonly current: string;
  readonly eventsBehind: string;
  readonly observed: string;
  readonly handoff: string;
  readonly state: string;
  readonly responsible: string;
  readonly priority: string;
  readonly updated: string;
  readonly noHandoffsTitle: string;
  readonly noHandoffsDescription: string;
  readonly unassigned: string;
  readonly handoffDetail: string;
  readonly publicTimeline: string;
  readonly noProjectedEvents: string;
  readonly via: string;
  readonly connections: string;
  readonly noProjectedRelationships: string;
  readonly operationsEyebrow: string;
  readonly operationsTitle: string;
  readonly projection: string;
  readonly unknown: string;
  readonly noStatusReturned: string;
  readonly observedLag: string;
  readonly eventsAwaitingProjection: string;
  readonly execution: string;
  readonly external: string;
  readonly externalExecutionDescription: string;
  readonly subscription: string;
  readonly event: string;
  readonly connector: string;
  readonly inspect: string;
  readonly delivery: string;
  readonly position: string;
  readonly attempt: string;
  readonly outcome: string;
  readonly when: string;
  readonly noMatchingFacts: string;
  readonly deadLetters: string;
  readonly connectorIngress: string;
  readonly ingress: string;
  readonly safeReason: string;
  readonly discrepancies: string;
  readonly id: string;
  readonly status: string;
  readonly boundedAudit: string;
  readonly principal: string;
  readonly operation: string;
  readonly recoveryTitle: string;
  readonly recoveryDescription: string;
  readonly expectedVersion: string;
  readonly reasonCode: string;
  readonly recoveryConfirmation: string;
  readonly requestRebuild: string;
}

const en: ConsoleMessages = {
  brandSubtitle: "connection console",
  navigationHandoffs: "Handoffs",
  navigationOperations: "Operations",
  primaryNavigation: "Primary",
  partition: "Partition",
  open: "Open",
  footer: "Protocol facts, handoffs and operational visibility. Participant execution stays external.",
  language: "Language",
  loading: "Loading connection facts…",
  loadErrorTitle: "Unable to load Work Fabric facts",
  unknownError: "Unknown error",
  retry: "Retry",
  fatalTitle: "Console unavailable",
  recoveryDenied: "Recovery denied",
  recoveryResultPrefix: "Recovery",
  responsibilityEyebrow: "Responsibility map",
  responsibilityTitle: "Current handoffs",
  current: "Current",
  eventsBehind: "events behind",
  observed: "Observed",
  handoff: "Handoff",
  state: "State",
  responsible: "Responsible",
  priority: "Priority",
  updated: "Updated",
  noHandoffsTitle: "No handoffs in this partition",
  noHandoffsDescription: "Connected participants have not transferred responsibility here yet.",
  unassigned: "Unassigned",
  handoffDetail: "Handoff detail",
  publicTimeline: "Public timeline",
  noProjectedEvents: "No projected events.",
  via: "via",
  connections: "Connections",
  noProjectedRelationships: "No projected relationships.",
  operationsEyebrow: "Operational visibility",
  operationsTitle: "Connection health",
  projection: "Projection",
  unknown: "Unknown",
  noStatusReturned: "No status returned",
  observedLag: "Observed lag",
  eventsAwaitingProjection: "events awaiting visibility projection",
  execution: "Execution",
  external: "external",
  externalExecutionDescription: "Work Fabric does not run participant work",
  subscription: "Subscription",
  event: "Event",
  connector: "Connector",
  inspect: "Inspect",
  delivery: "Delivery",
  position: "Position",
  attempt: "Attempt",
  outcome: "Outcome",
  when: "When",
  noMatchingFacts: "No matching facts.",
  deadLetters: "Dead letters",
  connectorIngress: "Connector ingress",
  ingress: "Ingress",
  safeReason: "Safe reason",
  discrepancies: "Discrepancies",
  id: "ID",
  status: "Status",
  boundedAudit: "Bounded audit",
  principal: "Principal",
  operation: "Operation",
  recoveryTitle: "Explicit projection recovery",
  recoveryDescription: "Records one authorized rebuild request. It does not decide when a rebuild is needed.",
  expectedVersion: "Expected version",
  reasonCode: "Reason code",
  recoveryConfirmation: "I confirm this bounded recovery request",
  requestRebuild: "Request rebuild",
};

const zhCn: ConsoleMessages = {
  brandSubtitle: "协作连接控制台",
  navigationHandoffs: "交接",
  navigationOperations: "运维",
  primaryNavigation: "主导航",
  partition: "分区",
  open: "打开",
  footer: "展示协议事实、交接与运维可见性。参与方的实际执行始终发生在 Work Fabric 之外。",
  language: "语言",
  loading: "正在加载协作连接事实…",
  loadErrorTitle: "无法加载 Work Fabric 事实",
  unknownError: "未知错误",
  retry: "重试",
  fatalTitle: "控制台不可用",
  recoveryDenied: "恢复请求被拒绝",
  recoveryResultPrefix: "恢复请求",
  responsibilityEyebrow: "责任视图",
  responsibilityTitle: "当前交接",
  current: "已同步",
  eventsBehind: "个事件延迟",
  observed: "观测时间",
  handoff: "交接",
  state: "状态",
  responsible: "责任主体",
  priority: "优先级",
  updated: "更新时间",
  noHandoffsTitle: "此分区暂无交接",
  noHandoffsDescription: "已连接的参与方尚未在此处移交责任。",
  unassigned: "未分配",
  handoffDetail: "交接详情",
  publicTimeline: "公开时间线",
  noProjectedEvents: "暂无已投影事件。",
  via: "经由",
  connections: "协作关系",
  noProjectedRelationships: "暂无已投影关系。",
  operationsEyebrow: "运维可见性",
  operationsTitle: "连接健康状态",
  projection: "投影",
  unknown: "未知",
  noStatusReturned: "未返回状态",
  observedLag: "观测延迟",
  eventsAwaitingProjection: "个等待可见性投影的事件",
  execution: "执行位置",
  external: "外部",
  externalExecutionDescription: "Work Fabric 不执行参与方的实际工作",
  subscription: "订阅",
  event: "事件",
  connector: "连接器",
  inspect: "查看",
  delivery: "投递",
  position: "位置",
  attempt: "尝试次数",
  outcome: "结果",
  when: "时间",
  noMatchingFacts: "没有匹配的事实。",
  deadLetters: "死信",
  connectorIngress: "连接器入口",
  ingress: "入口",
  safeReason: "安全原因",
  discrepancies: "差异",
  id: "ID",
  status: "状态",
  boundedAudit: "有界审计",
  principal: "主体",
  operation: "操作",
  recoveryTitle: "显式投影恢复",
  recoveryDescription: "记录一条经过授权的重建请求，但不替代外部运维方判断是否需要重建。",
  expectedVersion: "预期版本",
  reasonCode: "原因代码",
  recoveryConfirmation: "我确认提交这条有界恢复请求",
  requestRebuild: "请求重建",
};

type DisplayGroup = "lifecycle" | "priority" | "event" | "relationship" | "state" | "outcome";

const displays: Record<ConsoleLocale, Record<DisplayGroup, Readonly<Record<string, string>>>> = {
  en: {
    lifecycle: {
      offered: "offered", accepted: "accepted", declined: "declined", expired: "expired",
      cancelled: "cancelled", result_returned: "result returned", verified: "verified",
      rework_requested: "rework requested", transferred: "transferred", closed: "closed",
      target_resolution_pending: "target resolution pending", target_unavailable: "target unavailable",
    },
    priority: { low: "low", normal: "normal", high: "high", urgent: "urgent" },
    event: {
      offered: "offered", accepted: "accepted", declined: "declined", expired: "expired",
      cancelled: "cancelled", status_reported: "status reported", result_returned: "result returned",
      verified: "verified", rework_requested: "rework requested", transferred: "transferred", closed: "closed",
    },
    relationship: {
      responsibility: "responsibility", target: "target", thread_membership: "thread membership",
      parent_child: "parent child",
    },
    state: {
      current: "current", lagging: "lagging", rebuilding: "rebuilding", unknown: "unknown",
      pending: "pending", processing: "processing", completed: "completed", dead_letter: "dead letter",
    },
    outcome: {
      succeeded: "succeeded", failed: "failed", denied: "denied", conflicted: "conflicted",
      retryable: "retryable", not_found: "not found",
    },
  },
  "zh-CN": {
    lifecycle: {
      offered: "已发起", accepted: "已接受", declined: "已拒绝", expired: "已过期",
      cancelled: "已取消", result_returned: "结果已返回", verified: "已验收",
      rework_requested: "已要求返工", transferred: "已转交", closed: "已关闭",
      target_resolution_pending: "等待目标解析", target_unavailable: "目标不可用",
    },
    priority: { low: "低", normal: "普通", high: "高", urgent: "紧急" },
    event: {
      offered: "已发起", accepted: "已接受", declined: "已拒绝", expired: "已过期",
      cancelled: "已取消", status_reported: "已报告状态", result_returned: "已返回结果",
      verified: "已验收", rework_requested: "已要求返工", transferred: "已转交", closed: "已关闭",
    },
    relationship: {
      responsibility: "责任关系", target: "目标关系", thread_membership: "协作线程",
      parent_child: "父子交接",
    },
    state: {
      current: "已同步", lagging: "有延迟", rebuilding: "重建中", unknown: "未知",
      pending: "待处理", processing: "处理中", completed: "已完成", dead_letter: "死信",
    },
    outcome: {
      succeeded: "成功", failed: "失败", denied: "已拒绝", conflicted: "冲突",
      retryable: "可重试", not_found: "未找到",
    },
  },
};

export interface ConsolePresentation {
  readonly locale: ConsoleLocale;
  readonly text: Readonly<ConsoleMessages>;
  formatDate(value: string): string;
  display(group: DisplayGroup, value: string): string;
}

export function resolveLocale(stored: string | null, browserLanguages: readonly string[]): ConsoleLocale {
  if (stored === "en" || stored === "zh-CN") return stored;
  return browserLanguages.some((language) => language.toLowerCase().startsWith("zh"))
    ? "zh-CN"
    : "en";
}

export function readLocale(
  storage: Pick<Storage, "getItem"> | undefined,
  browserLanguages: readonly string[],
): ConsoleLocale {
  try {
    return resolveLocale(storage?.getItem(LOCALE_STORAGE_KEY) ?? null, browserLanguages);
  } catch {
    return resolveLocale(null, browserLanguages);
  }
}

export function saveLocale(
  storage: Pick<Storage, "setItem"> | undefined,
  locale: ConsoleLocale,
): void {
  try {
    storage?.setItem(LOCALE_STORAGE_KEY, locale);
  } catch {
    // UI preference persistence is best-effort.
  }
}

export function createPresentation(locale: ConsoleLocale): ConsolePresentation {
  const formatter = new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "medium",
  });
  return Object.freeze({
    locale,
    text: Object.freeze(locale === "zh-CN" ? zhCn : en),
    formatDate(value: string) {
      const timestamp = Date.parse(value);
      return Number.isFinite(timestamp) ? formatter.format(timestamp) : value;
    },
    display(group: DisplayGroup, value: string) {
      return displays[locale][group][value] ?? value;
    },
  });
}
