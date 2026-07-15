export interface ProblemDetails {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly code: string;
  readonly instance?: string;
}

export function createProblemDetails(
  status: number,
  code: string,
  title: string,
  options: { readonly instance?: string } = {},
): ProblemDetails {
  return {
    type: `urn:work-fabric:problem:${code}`,
    title,
    status,
    code,
    ...(options.instance === undefined ? {} : { instance: options.instance }),
  };
}
