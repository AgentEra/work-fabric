export interface GitHubRepositoryRef {
  readonly owner: string;
  readonly name: string;
}

export interface GitHubEvidenceMeta {
  readonly provider: "github";
  readonly fetched_at: string;
  readonly installation_id_hash: string;
  readonly api_version: string;
  readonly query_scope: readonly string[];
  readonly complete: boolean;
  readonly next_cursor?: string;
}

type GitHubCompleteEvidence = GitHubEvidenceMeta & {
  readonly complete: true;
};

type GitHubIncompleteEvidence = GitHubEvidenceMeta & {
  readonly complete: false;
};

export type GitHubPage<T> =
  | {
      readonly state: "empty";
      readonly items: readonly [];
      readonly evidence: GitHubCompleteEvidence;
    }
  | {
      readonly state: "complete";
      readonly items: readonly [T, ...T[]];
      readonly evidence: GitHubCompleteEvidence;
    }
  | {
      readonly state: "truncated";
      readonly items: readonly [T, ...T[]];
      readonly evidence: GitHubIncompleteEvidence;
    };

export interface GitHubIdentityRecord {
  readonly app_id: string;
  readonly slug: string;
  readonly name: string;
  readonly url: string;
  readonly owner: string | null;
  readonly installation_repository_count: number;
}

export interface GitHubRepositoryRecord {
  readonly repository: GitHubRepositoryRef;
  readonly url: string;
  readonly description: string | null;
  readonly visibility: "public" | "private" | "internal";
  readonly archived: boolean;
  readonly default_branch: string;
  readonly topics: readonly string[];
  readonly pushed_at: string | null;
  readonly updated_at: string;
}

export interface GitHubPullRequestRecord {
  readonly repository: GitHubRepositoryRef;
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly author: string | null;
  readonly draft: boolean;
  readonly base_branch: string;
  readonly head_branch: string;
  readonly head_sha: string;
  readonly assignees: readonly string[];
  readonly requested_reviewers: readonly string[];
  readonly labels: readonly string[];
  readonly mergeable: boolean | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly reference?: string;
  readonly body_preview?: string;
  readonly body_truncated?: boolean;
}

export interface GitHubReviewRecord {
  readonly repository: GitHubRepositoryRef;
  readonly pull_request_number: number;
  readonly id: string;
  readonly actor: string | null;
  readonly state: string;
  readonly submitted_at: string | null;
  readonly body_preview: string;
  readonly body_truncated: boolean;
  readonly url: string;
}

export interface GitHubCommentRecord {
  readonly repository: GitHubRepositoryRef;
  readonly pull_request_number: number;
  readonly id: string;
  readonly actor: string | null;
  readonly comment_type: "issue" | "review";
  readonly created_at: string;
  readonly updated_at: string;
  readonly body_preview: string;
  readonly body_truncated: boolean;
  readonly url: string;
}

export interface GitHubChangedFileRecord {
  readonly repository: GitHubRepositoryRef;
  readonly pull_request_number: number;
  readonly path: string;
  readonly status: string;
  readonly additions: number;
  readonly deletions: number;
  readonly changes: number;
  readonly url: string;
}

export interface GitHubCommitRecord {
  readonly repository: GitHubRepositoryRef;
  readonly sha: string;
  readonly subject: string;
  readonly author_name: string | null;
  readonly author_login: string | null;
  readonly verified: boolean | null;
  readonly timestamp: string | null;
  readonly url: string;
}

export interface GitHubCheckRecord {
  readonly name: string;
  readonly status: string;
  readonly conclusion: string | null;
  readonly started_at: string | null;
  readonly completed_at: string | null;
  readonly url: string | null;
}

export interface GitHubCheckSummary {
  readonly repository: GitHubRepositoryRef;
  readonly ref: string;
  readonly aggregate_state: "pending" | "success" | "failure" | "neutral" | "unknown";
  readonly checks: readonly GitHubCheckRecord[];
}

export interface GitHubWorkflowRunRecord {
  readonly repository: GitHubRepositoryRef;
  readonly id: string;
  readonly workflow_name: string;
  readonly run_number: number;
  readonly event: string;
  readonly branch: string | null;
  readonly head_sha: string;
  readonly actor: string | null;
  readonly status: string;
  readonly conclusion: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly url: string;
}

export interface GitHubApiPageInput {
  readonly page_size: number;
  readonly cursor?: string;
}

export interface GitHubApiPage<T> {
  readonly items: readonly T[];
  readonly next_cursor?: string;
}

export type GitHubPullRequestListTarget =
  | { readonly repository: GitHubRepositoryRef }
  | { readonly repositories: readonly GitHubRepositoryRef[] }
  | { readonly owner: string };

export interface GitHubApiPullRequestListInput extends GitHubApiPageInput {
  readonly target: GitHubPullRequestListTarget;
  readonly state?: "open" | "closed" | "all";
  readonly author?: string;
  readonly reviewer?: string;
  readonly assignee?: string;
  readonly labels?: readonly string[];
  readonly draft?: boolean;
  readonly base_branch?: string;
  readonly updated_since?: string;
}

export interface GitHubApiPullRequestSearchInput
  extends GitHubApiPullRequestListInput {}

export interface GitHubApiPullRequestPageInput extends GitHubApiPageInput {
  readonly repository: GitHubRepositoryRef;
  readonly pull_request_number: number;
}

export interface GitHubApiWorkflowRunListInput extends GitHubApiPageInput {
  readonly repository: GitHubRepositoryRef;
  readonly branch?: string;
  readonly event?: string;
  readonly status?: string;
}

export interface GitHubApiCommitListInput extends GitHubApiPageInput {
  readonly repository: GitHubRepositoryRef;
  readonly ref?: string;
  readonly since?: string;
  readonly until?: string;
}

export interface GitHubReadApi {
  getIdentity(signal: AbortSignal): Promise<GitHubIdentityRecord>;
  listRepositories(input: GitHubApiPageInput, signal: AbortSignal): Promise<GitHubApiPage<GitHubRepositoryRecord>>;
  getRepository(repository: GitHubRepositoryRef, signal: AbortSignal): Promise<GitHubRepositoryRecord>;
  listPullRequests(input: GitHubApiPullRequestListInput, signal: AbortSignal): Promise<GitHubApiPage<GitHubPullRequestRecord>>;
  searchPullRequests(input: GitHubApiPullRequestSearchInput, signal: AbortSignal): Promise<GitHubApiPage<GitHubPullRequestRecord>>;
  getPullRequest(repository: GitHubRepositoryRef, number: number, signal: AbortSignal): Promise<GitHubPullRequestRecord>;
  listReviews(input: GitHubApiPullRequestPageInput, signal: AbortSignal): Promise<GitHubApiPage<GitHubReviewRecord>>;
  listIssueComments(input: GitHubApiPullRequestPageInput, signal: AbortSignal): Promise<GitHubApiPage<GitHubCommentRecord>>;
  listReviewComments(input: GitHubApiPullRequestPageInput, signal: AbortSignal): Promise<GitHubApiPage<GitHubCommentRecord>>;
  listFiles(input: GitHubApiPullRequestPageInput, signal: AbortSignal): Promise<GitHubApiPage<GitHubChangedFileRecord>>;
  listPullRequestCommits(input: GitHubApiPullRequestPageInput, signal: AbortSignal): Promise<GitHubApiPage<GitHubCommitRecord>>;
  getChecks(repository: GitHubRepositoryRef, ref: string, signal: AbortSignal): Promise<GitHubCheckSummary>;
  listWorkflowRuns(input: GitHubApiWorkflowRunListInput, signal: AbortSignal): Promise<GitHubApiPage<GitHubWorkflowRunRecord>>;
  listCommits(input: GitHubApiCommitListInput, signal: AbortSignal): Promise<GitHubApiPage<GitHubCommitRecord>>;
}
