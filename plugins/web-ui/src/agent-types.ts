export interface AgentSelection {
  id: string;
  version: number;
  test?: true;
}
interface AgentFile {
  path: string;
  content: string;
  encoding?: "base64";
  mimetype?: string;
}
export interface AgentPackage {
  name: string;
  description: string;
  instructions: string;
  files: AgentFile[];
  allowedTools: string[] | null;
  requiredTools: string[];
  examples: Array<{ task: string; expected: string }>;
}
export interface AgentView {
  id: string;
  slug: string;
  ownerScopeId: string;
  createdBy: string;
  name: string;
  description: string;
  publishedVersion: number | null;
  deleted: boolean;
  available: boolean;
  canEdit: boolean;
  canManage: boolean;
  version: number;
  package: AgentPackage;
  revisions: Array<{ version: number; author: string; at: number; summary: string; publishedAt?: number }>;
  proposals: Array<{ id: string; author: string; text: string }>;
}
