export type GithubErrorCode =
  | 'auth' // token missing, expired, or lacking the needed scope
  | 'not-found' // repo, branch, or blob does not exist for this token
  | 'rate-limit'
  | 'conflict' // ref moved under us; caller should re-sync and retry
  | 'too-large' // blob exceeds what the API will return inline
  | 'network'
  | 'unknown';

export class GithubApiError extends Error {
  public readonly code: GithubErrorCode;
  public readonly status: number | undefined;
  /** Unix seconds when a rate limit lifts; only set when `code` is 'rate-limit'. */
  public readonly retryAt: number | undefined;

  constructor(
    code: GithubErrorCode,
    message: string,
    options: { status?: number; retryAt?: number; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = 'GithubApiError';
    this.code = code;
    this.status = options.status;
    this.retryAt = options.retryAt;
  }
}

export function isGithubApiError(error: unknown): error is GithubApiError {
  return error instanceof GithubApiError;
}
