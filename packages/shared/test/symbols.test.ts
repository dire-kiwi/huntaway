import { assert, describe, it } from "vite-plus/test"
import { definesName, isName, isSymbolName, occurrences, outline, wordAt } from "../src/symbols.ts"

// HE-79: the Code tab's search-based symbols.

describe("symbols", () => {
  it("a symbol's name: a name's characters, not a keyword", () => {
    for (const s of ["foo", "Foo_bar", "$el", "_", "naïve", "x1"]) assert.isTrue(isSymbolName(s), s)
    for (const s of ["", "1x", "a-b", "if", "return", "const", "a.b", "x".repeat(201)]) assert.isFalse(isSymbolName(s), s)
    // Keywords of only some languages are names.
    for (const s of ["type", "match", "of", "from", "register", "delete", "select", "module", "default", "self"]) assert.isTrue(isSymbolName(s), s)
    // The server looks any name up; the client decides what's a keyword.
    assert.isTrue(isName("if"))
    assert.isFalse(isName("a b"))
  })

  it("the word clicked, and where a name is in a line", () => {
    const line = "  const fooBar = baz(fooBar.$x) // if"
    assert.deepStrictEqual(wordAt(line, 10), { name: "fooBar", start: 8 })
    assert.deepStrictEqual(wordAt(line, 8), { name: "fooBar", start: 8 })
    assert.deepStrictEqual(wordAt(line, 14), { name: "fooBar", start: 8 })
    assert.deepStrictEqual(wordAt(line, 29), { name: "$x", start: 28 })
    assert.isNull(wordAt(line, 15))
    assert.isNull(wordAt(line, 4), "a keyword")
    assert.isNull(wordAt(line, line.length), "a keyword at the end")
    assert.deepStrictEqual(occurrences(line, "fooBar"), [8, 21])
    // A member's name, a keyword elsewhere: `Option.match`, `Effect.catch`, `Foo::new`.
    assert.deepStrictEqual(wordAt("Option.match(x)", 9), { name: "match", start: 7 })
    assert.deepStrictEqual(wordAt("  Effect.catch((e) => e)", 11), { name: "catch", start: 9 })
    assert.deepStrictEqual(wordAt("Foo::new()", 6), { name: "new", start: 5 })
    assert.isNull(wordAt("} catch (e) {", 4))
    assert.deepStrictEqual(occurrences("fooBarX fooBar_ $fooBar fooBar", "fooBar"), [24])
    assert.deepStrictEqual(occurrences("a $x b$x", "$x"), [2])
  })

  it("the lines that define a name, in each language", () => {
    const defines: ReadonlyArray<readonly [string, string, string]> = [
      ["a.ts", "export function parse(text: string) {", "parse"],
      ["a.ts", "export async function* parse() {", "parse"],
      ["a.ts", "export const parse = (s: string) => s", "parse"],
      ["a.ts", "  let parse = 1", "parse"],
      ["a.ts", "export class Parser extends Base {", "Parser"],
      ["a.ts", "export interface Parser {", "Parser"],
      ["a.ts", "export type Parser = string", "Parser"],
      ["a.ts", "enum Color {", "Color"],
      ["a.ts", "  async parse<T>(text: string): Promise<T> {", "parse"],
      ["a.ts", "  private readonly parse = () => 1", "parse"],
      ["a.ts", "  readonly parse: (s: string) => number", "parse"],
      ["a.py", "def parse(text):", "parse"],
      ["a.py", "class Parser(Base):", "Parser"],
      ["a.py", "PARSER = Parser()", "PARSER"],
      ["a.rb", "  def self.parse(text)", "parse"],
      ["a.rs", "pub fn parse(text: &str) -> Ast {", "parse"],
      ["a.rs", "pub(crate) struct Parser {", "Parser"],
      ["a.rs", "    let mut parser = Parser::new();", "parser"],
      ["a.rs", "static LIMIT: usize = 5;", "LIMIT"],
      ["a.go", "func Parse(text string) (*Ast, error) {", "Parse"],
      ["a.go", "func (p *Parser) Parse(text string) error {", "Parse"],
      ["a.go", "type Parser struct {", "Parser"],
      ["a.c", "static int parse(const char *text)", "parse"],
      ["a.c", "#define LIMIT 5", "LIMIT"],
      ["a.cpp", "void Parser::parse(const std::string& text) {", "parse"],
      ["A.java", "  public static Ast parse(String text) {", "parse"],
      ["Makefile", "CFLAGS := -O2", "CFLAGS"],
      ["a.sh", "LIMIT=5", "LIMIT"],
    ]
    for (const [path, line, name] of defines) assert.isTrue(definesName(line, name, path), `${path}: ${line}`)
    const uses: ReadonlyArray<readonly [string, string, string]> = [
      ["a.ts", 'import { parse } from "./parse"', "parse"],
      ["a.ts", 'export { parse } from "./parse"', "parse"],
      ["a.ts", "  const ast = parse(text)", "parse"],
      ["a.ts", '  describe("parse", () => {', "describe"],
      ["a.ts", "  parse(text)", "parse"],
      ["a.ts", "if (parse(text)) {", "parse"],
      ["a.ts", "  if (x === parse) {", "parse"],
      ["a.ts", "  parse = other", "parse"],
      ["a.py", "    return parse(text)", "parse"],
      ["a.py", "from parser import parse", "parse"],
      ["a.rs", "use crate::parser::parse;", "parse"],
      ["a.c", "  return parse(text);", "parse"],
      ["a.c", "int parse(const char *text);", "parse"],
      ["a.c", '#include "parse.h"', "parse"],
      ["a.ts", "int parse(text)", "parse"],
      ["a.ts", "// export function parse(text) {", "parse"],
      ["a.ts", " * class Parser {", "Parser"],
      ["a.py", "# def parse(text):", "parse"],
    ]
    for (const [path, line, name] of uses) assert.isFalse(definesName(line, name, path), `${path}: ${line}`)
  })

  it("a file's outline: its definitions, but not a function's locals", () => {
    const text = [
      'import { x } from "y"',
      "// const notThis = 1",
      "export const LIMIT = 5",
      "export class Parser {",
      "  private readonly depth = 0",
      "  parse(text: string): Ast {",
      "    const ast = make()",
      "    if (ast) {",
      "      return ast",
      "    }",
      "  }",
      "}",
      "function helper() {}",
      "export function register(a) {",
      "export const match = 1",
    ].join("\n")
    assert.deepStrictEqual(
      outline(text, "a.ts").map((e) => [e.name, e.line, e.depth]),
      [
        ["LIMIT", 3, 0],
        ["Parser", 4, 0],
        ["depth", 5, 2],
        ["parse", 6, 2],
        ["helper", 13, 0],
        ["register", 14, 0],
        ["match", 15, 0],
      ],
    )
    assert.deepStrictEqual(
      outline("static int parse(void)\n{\n  int n = 0;\n  return n;\n}\n", "a.c").map((e) => e.name),
      ["parse"],
    )
  })
})
