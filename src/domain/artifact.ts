export type ArtifactKind =
  | "stdout"
  | "stderr"
  | "patch"
  | "manifest"
  | "digest"
  | "result"
  | "events"
  | "plan"
  | "custom";

export interface ArtifactMetadata {
  id: string;
  kind: ArtifactKind;
  byte_size: number;
  sha256: string;
  mime_type: string;
  created_at: string;
  relative_path: string;
  task_id?: string;
  gate_id?: string;
  attempt?: number;
  has_secrets?: boolean;
  is_binary?: boolean;
}
