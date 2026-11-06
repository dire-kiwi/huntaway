// HA-182: the server's promises are awaited or handled. One that rejects with nothing to handle it is logged rather than
// ending the server (see src/crash.ts), but whatever it was doing stops there, so each one is handled where it's made:
// awaited, `.catch`ed, or run with util.ts's `background`, which logs what it throws. There's no ESLint here, so this is
// typescript-eslint's no-floating-promises and no-misused-promises (the void-return case), with tsrs's checker API (its
// `tsrs/sync`, the TypeScript 7 API, which runs the checker in a tsrs process and asks it over a pipe).
import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, relative } from "node:path";
import * as ts from "tsrs/ast";
import { API, TypeFlags, type Type } from "tsrs/sync";

const ROOT = dirname(fileURLToPath(new URL("../tsconfig.json", import.meta.url)));

/** Where in the server's own sources (not its tests) a promise is left unhandled, as `file:line what`. */
export function floating_promises(root = ROOT): string[] {
  using api = new API({ cwd: root });
  const cfg = api.parseConfigFile(`${root}/tsconfig.json`);
  const files = cfg.fileNames.filter((f) => f.startsWith(`${root}/src/`) && !f.endsWith(".test.ts"));
  const program = api.createProgram(files, cfg.options);
  const tc = program.getProject().checker;
  const is_promise = (t: Type): boolean => {
    t = tc.getNonNullableType(t);
    if (t.isUnionType()) return t.getTypes().some(is_promise);
    const then = t.getProperty("then");
    return !!then && (!!then.valueDeclaration || then.declarations.length > 0) && tc.getTypeOfSymbol(then).getCallSignatures().length > 0;
  };
  /** `p.catch(…)` or `p.then(…, …)`: what `p` rejects with is handled. */
  const handled_call = (e: ts.Expression): boolean => {
    while (ts.isParenthesizedExpression(e)) e = e.expression;
    if (!ts.isCallExpression(e) || !ts.isPropertyAccessExpression(e.expression)) return false;
    const name = e.expression.name.text;
    return name === "catch" || (name === "then" && e.arguments.length >= 2);
  };
  /** A function whose body is one handled call (`() => p.catch(…)`), so calling it leaves nothing to handle. */
  const handled_fn = (n: ts.Node): boolean => {
    if (ts.isIdentifier(n)) {
      const d = tc.getSymbolAtLocation(n)?.valueDeclaration?.resolve();
      return !!d && ts.isVariableDeclaration(d) && !!d.initializer && handled_fn(d.initializer);
    }
    return (ts.isArrowFunction(n) && !ts.isBlock(n.body) && handled_call(n.body)) || (ts.isParenthesizedExpression(n) && handled_fn(n.expression));
  };
  const found: string[] = [];
  for (const file of files) {
    const sf = program.getSourceFile(file)!;
    const at = (n: ts.Node) => `${relative(root, sf.fileName)}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1}`;
    const visit = (n: ts.Node) => {
      // A promise made and dropped (`void p` too: it says the result doesn't matter, but a rejection still does).
      if (ts.isExpressionStatement(n)) {
        let e = n.expression;
        if (ts.isVoidExpression(e)) e = e.expression;
        // Kept (`x = p`): whoever reads it handles it.
        const kept = ts.isBinaryExpression(e) && e.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && e.operatorToken.kind <= ts.SyntaxKind.LastAssignment;
        if (
          !kept &&
          !ts.isAwaitExpression(e) &&
          is_promise(tc.getTypeAtLocation(e)) &&
          !handled_call(e) &&
          !(ts.isCallExpression(e) && handled_fn(e.expression))
        )
          found.push(`${at(n)} not awaited or handled: ${n.getText().split("\n")[0].slice(0, 100)}`);
      }
      // An async function given where a function returning nothing goes (a timer, an event's listener), so whatever
      // calls it drops its promise.
      const parent = n.parent as ts.Node | undefined;
      const as_arg = !!parent && ts.isCallOrNewExpression(parent) && !!parent.arguments?.includes(n as ts.Expression);
      const as_value =
        !!parent &&
        ((ts.isPropertyAssignment(parent) && parent.initializer === n) ||
          (ts.isBinaryExpression(parent) && parent.right === n && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken));
      if ((as_arg || as_value) && !ts.isCallExpression(n) && !handled_fn(n)) {
        const own = tc.getTypeAtLocation(n).getCallSignatures();
        if (own.length && own.every((sig) => is_promise(tc.getReturnTypeOfSignature(sig)))) {
          const ctx = tc.getContextualType(n as ts.Expression);
          const want = ctx
            ? tc
                .getNonNullableType(ctx)
                .getCallSignatures()
                .map((sig) => tc.getReturnTypeOfSignature(sig))
            : [];
          if (want.length && want.every((t) => !!(t.flags & TypeFlags.Void)))
            found.push(
              `${at(n)} async function where its promise is dropped: ${(as_arg ? (parent as ts.CallExpression).expression : parent!).getText().split("\n")[0].slice(0, 80)}`,
            );
        }
      }
      n.forEachChild(visit);
    };
    visit(sf);
  }
  return found;
}

test("every_promise_is_awaited_or_handled", () => {
  const found = floating_promises();
  assert.deepEqual(found, [], `run these with util.ts's background(), or await or .catch them:\n${found.join("\n")}`);
});
