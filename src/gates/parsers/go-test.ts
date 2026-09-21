import { OutputParser, ParserResult } from "../output-parser.js";

export class GoTestParser implements OutputParser {
  parse(stdout: string, stderr: string): ParserResult {
    const failingTests: string[] = [];
    const lines = (stdout + "\n" + stderr).split("\n");
    for (const line of lines) {
      const match = line.match(/^--- FAIL:\s+([^\s]+)/);
      if (match && match[1]) {
        failingTests.push(match[1].trim());
      }
    }
    return {
      failingTests,
      parserName: "go-test",
    };
  }
}
