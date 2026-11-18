import type { ChangedFile, ChangedSymbol } from "./diff.ts";
import type { Rule } from "./rules.ts";

export interface ContextItem {
  id: string;
  kind: "definition" | "caller" | "callee" | "type" | "test" | "config" | "similar" | "rule";
  file: string;
  startLine: number;
  endLine: number;
  text: string;
  score: number;
  tokens: number;
  reason: string;
}

export interface ReviewUnit {
  id: string;
  file: ChangedFile;
  symbol: ChangedSymbol;
  context: ContextItem[];
  rules: Rule[];
}
