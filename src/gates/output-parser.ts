export interface ParserResult {
  failingTests: string[];
  parserName: string;
  parserVersion?: string;
}

export interface OutputParser {
  parse(stdout: string, stderr: string): ParserResult;
}
