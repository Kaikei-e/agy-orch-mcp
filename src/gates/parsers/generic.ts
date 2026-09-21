import { OutputParser, ParserResult } from "../output-parser.js";

export class GenericParser implements OutputParser {
  parse(stdout: string, stderr: string): ParserResult {
    const failingTests: string[] = [];
    const lines = (stdout + "\n" + stderr).split("\n");
    for (const line of lines) {
      if (line.match(/error|fail|exception/i)) {
        if (failingTests.length < 10) {
          failingTests.push(line.trim());
        }
      }
    }
    return {
      failingTests,
      parserName: "generic",
    };
  }
}
