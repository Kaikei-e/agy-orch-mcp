export interface SemanticCompressorJob {
  kind:
    | "extract_root_cause"
    | "classify_test_failure"
    | "summarize_unresolved_decisions"
    | "summarize_changes";
  artifactIds: string[];
}

export interface SemanticCompressor {
  compress(job: SemanticCompressorJob): Promise<string | null>;
}

export class FallbackSemanticCompressor implements SemanticCompressor {
  async compress(_job: SemanticCompressorJob): Promise<string | null> {
    // Optional compressor defaults to deterministic fallback
    return null;
  }
}
