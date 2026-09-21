import { OutputParser, ParserResult } from "../output-parser.js";

export class JestParser implements OutputParser {
  parse(stdout: string, stderr: string): ParserResult {
    const failingTests: string[] = [];
    const out = stdout + "\n" + stderr;
    const lines = out.split("\n");
    for (const line of lines) {
      const match = line.match(/FAIL\s+(.*)/);
      if (match && match[1]) {
        failingTests.push(match[1].trim());
      }
    }
    return {
      failingTests,
      parserName: "jest",
    };
  }
}
