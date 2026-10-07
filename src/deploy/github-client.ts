export class GitHubError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface GitHubIdentity {
  id: number;
  login: string;
}

export interface GitHubRepository {
  id: number;
  full_name: string;
  private: boolean;
  default_branch: string;
  description: string | null;
  permissions?: { push?: boolean; admin?: boolean; maintain?: boolean };
}

export interface GitHubFile {
  path: string;
  sha: string;
  mode: string;
  type: string;
}

export interface GitHubPullRequest {
  number: number;
  html_url: string;
  state: string;
  merged_at: string | null;
  merge_commit_sha: string | null;
  user: GitHubIdentity;
  head: { ref: string; sha: string };
  base: { ref: string; sha: string };
}

export function createGitHubClient(token: string, transport: typeof fetch = fetch) {
  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await transport(`https://api.github.com${path}`, {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "content-type": "application/json",
        "x-github-api-version": "2022-11-28",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      let message = `GitHub returned ${response.status}. Refresh and review before retrying.`;
      if (response.status === 401)
        message = "GitHub authorization expired or was revoked. Reconnect in Keychain → Linked accounts → GitHub.";
      if (response.status === 403)
        message =
          "GitHub denied this action. Check repository permissions, branch protection, and organization policy.";
      throw new GitHubError(response.status, message);
    }
    if (response.status === 204) return undefined as T;
    return response.json() as Promise<T>;
  }
  return {
    request,
    async identity() {
      const user = await request<GitHubIdentity>("GET", "/user");
      return { id: user.id, login: user.login };
    },
    repository: (repo: string) => request<GitHubRepository>("GET", `/repos/${repo}`),
    async head(repo: string, branch: string): Promise<string | null> {
      try {
        return (
          await request<{ object: { sha: string } }>(
            "GET",
            `/repos/${repo}/git/ref/heads/${encodeURIComponent(branch)}`,
          )
        ).object.sha;
      } catch (error) {
        if (error instanceof GitHubError && error.status === 404) return null;
        throw error;
      }
    },
    async tree(repo: string, sha: string): Promise<{ treeSha: string; files: GitHubFile[] }> {
      const commit = await request<{ tree: { sha: string } }>(
        "GET",
        `/repos/${repo}/git/commits/${encodeURIComponent(sha)}`,
      );
      const tree = await request<{ tree: GitHubFile[]; truncated: boolean }>(
        "GET",
        `/repos/${repo}/git/trees/${commit.tree.sha}?recursive=1`,
      );
      if (tree.truncated) throw new Error("Repository tree is too large to review safely.");
      return { treeSha: commit.tree.sha, files: tree.tree.filter((f) => f.type !== "tree") };
    },
  };
}
