import { OutputParser, ParserResult } from "../output-parser.js";

export class NodeTapParser implements OutputParser {
  parse(stdout: string, stderr: string): ParserResult {
    const failingTests: string[] = [];
    const lines = (stdout + "\n" + stderr).split("\n");
    for (const line of lines) {
      if (line.match(/^not ok\s+\d+\s+(.*)/)) {
        const match = line.match(/^not ok\s+\d+\s+(.*)/);
        if (match && match[1]) failingTests.push(match[1].trim());
      }
    }
    return {
      failingTests,
      parserName: "tap",
    };
  }
}
