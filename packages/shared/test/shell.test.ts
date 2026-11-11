import { assert, describe, it } from "vite-plus/test"
import { commandChangesCode, runsProgram, substitutions, tokenize } from "../src/shell.ts"

// huntaway's git/changes/tests.test.ts (the Rust server's git/changes/tests.rs): the commands are its, in the same
// order. Its tool-call cases (an edit is all or nothing, a denied command never ran) go with `changesCode`, the git
// area's, which reads a tool call and its result and asks `commandChangesCode` about a Bash command.

const YES = [
  "gh pr view",
  "a && gh x",
  "x | gh y",
  "env -i B=1 gh",
  "sudo -E /opt/bin/gh",
  "`gh pr list`",
  "(gh x)",
  "sh <<EOF\ngh pr view\nEOF\n",
  'echo "$(gh pr view 3)"',
  "echo `gh pr view 3`",
  'echo "x `gh pr view 3` y"',
  "echo $(echo $(gh api user))",
  "if gh pr view 3; then echo yes; fi",
  "if ! gh auth status; then exit 1; fi",
  "while true; do gh run list; done",
  "for p in 1 2; do gh pr view $p; done",
  "{ gh pr view; }",
  "x=$(gh pr view --json url)",
  "env -u GH_TOKEN gh api user",
  "timeout -s TERM 30 gh api user",
  "timeout --signal TERM -k 5 30 gh api user",
  "sudo -u ivan gh pr view",
  "sudo -Eu ivan -- gh pr view",
  "xargs -I {} gh pr view {}",
  "nice -n 5 gh pr list",
  "cat <<EOF\nsee $(gh pr view 3)\nEOF\n",
  "cat <<-EOF\n\t`gh pr view 3`\n\tEOF\n",
  '# list them\necho "$(gh pr list)"',
  "sudo -uroot gh api user",
  "sudo -u 用户 gh api user",
  "sudo -u用户 gh api user",
  "env -S 'gh api user'",
  "env -S'gh api user'",
  "env --split-string='-i gh api user'",
  "env -C/tmp/项目 gh api user",
  "echo \"$(printf ')'; gh api user)\"",
  'echo "$(echo ")"; gh api user)"',
  "cat <<'END DOC'\nliteral\nEND DOC\necho \"$(gh api user)\"",
  'cat <<"END DOC"\nliteral $(x)\nEND DOC\ngh pr view',
  'echo "$(echo ok # )\ngh api user)"',
  "echo \"$(cat <<'EOF'\n)\nEOF\ngh api user)\"",
  'echo "$( (echo a) ; gh api user)"',
  'echo "$(echo $((1 + 2)); gh api user)"',
  'echo "$(echo "$(gh api user)")"',
  'echo "$(case x in x) gh api user;; esac)"',
  'echo "$(case x in y) echo esac;; x) gh api user;; esac)"',
  'echo "$(case x in x) echo esac;;& *) gh api user;; esac)"',
  'echo "$(case x in x|esac) gh api user;; esac)"',
  'echo "$(time case x in x) gh api user;; esac)"',
  'echo "$(time -p case x in x) echo ok;; esac; gh api user)"',
  'echo "$(coproc case x in x) echo ok;; esac; gh api user)"',
  "echo \"$(echo time case x in x) ' $(gh api user) '\"",
  "echo \"$(echo do case x in x) ' $(gh api user) '\"",
  "echo \"$(echo ! case x in x) ' $(gh api user) '\"",
  "echo \"$(echo if case x in x) ' $(gh api user) '\"",
  "coproc gh api user",
  "time ! gh api user",
  "time -p ! gh api user",
  "! time gh api user",
  'echo "$(time ! gh api user)"',
  'echo "$(echo x"',
  "echo `echo x",
  'echo "$(case x in x) echo ok;; esac; gh api user)"',
  'echo "$(case x in (x|y) echo ok;; *) echo no;; esac; gh api user)"',
  'echo "$(case $(echo x) in\n  x) echo "$(case y in y) echo;; esac)" ;;\nesac; gh api user)"',
  "env -u; gh api user",
  "timeout --signal; gh api user",
  "sudo -u; gh api user",
  "echo $'it\\'s fine'; gh api user",
  "echo $'it\\'s fine' \"$(gh api user)\"",
  "$'gh' api user",
  "$'g\\x68' api user",
  "$'\\147\\150' api user",
  "$'\\u0067h' api user",
  "$'gh\\0junk' api user",
  '$"gh" api user',
  "cat <<$'EOF'\nx\nEOF\ngh api user",
  'cat <<$"EOF"\nx\nEOF\ngh api user',
  "echo \"$(echo $'a\\')' ; gh api user)\"",
  "builtin command gh api user",
  "builtin exec gh api user",
  "eval gh api user",
  "eval 'gh api user'",
  'eval "echo x; gh api user"',
]

const NO = [
  "ghq get",
  "echo gh",
  "git log --grep gh",
  "cat <<EOF\ngh pr view\nEOF\n",
  "# gh pr view",
  "'echo gh'",
  "echo 'run $(gh pr view) later'",
  'echo "gh pr view"',
  "if test -f gh; then echo gh; fi",
  "echo $((1 + 2))",
  "# `gh pr view 3`\necho ok",
  "echo ok # $(gh pr view 3)",
  "cat <<'EOF'\nUse `gh pr view 3` to inspect the PR.\nEOF\n",
  'cat <<"EOF" > notes.md\nRun $(gh pr view) later\nEOF\necho done',
  "cat <<\\EOF\n`gh x`\nEOF\n",
  "cat <<'EOF'\nit's $(gh pr view)\nEOF\n",
  "echo a#b",
  "timeout -s TERM 30 cargo test gh",
  "env -C/tmp/项目 pwd",
  "sudo -u 用户 ls gh",
  "env -S 'echo gh'",
  "cat <<'END DOC'\nsee $(gh pr view)\nEND DOC\necho done",
  'echo "$(echo ok # gh api user\n)"',
  "echo \"$(cat <<'EOF'\n$(gh api user)\nEOF\n)\"",
  "echo \"$(case x in x) echo gh;; esac)\" 'gh api user'",
  'echo "$(echo case in x) gh"',
  "env -u; echo gh",
  "echo $'it\\'s gh api user'",
  "echo $'$(gh api user)'",
  "echo $'`gh api user`'",
  "$'g\\x68x' api user",
  "echo $$'$(gh api user)'",
  "builtin echo gh",
  "eval echo gh",
]

const bash = (command: string) => commandChangesCode(command)
const words = (c: string) => tokenize(c).flatMap((t) => (t.t === "Word" ? [t.w] : []))

describe("the shell reader", () => {
  it("substitutions end where bash ends them", () => {
    // Each `$(…)` as bash reads it, whatever the rest of the command would make of it.
    const cases: ReadonlyArray<readonly [string, string]> = [
      ['echo "$(case x in y) echo esac;; x) gh;; esac) tail"', "case x in y) echo esac;; x) gh;; esac"],
      ['echo "$(case x in x|esac) gh;; esac)"', "case x in x|esac) gh;; esac"],
      ['echo "$(time -p case x in x) a;; esac; b)"', "time -p case x in x) a;; esac; b"],
      ['echo "$(case x in (x) a;; esac) $(b)"', "case x in (x) a;; esac"],
      ['echo "$(echo case in x) $(b)"', "echo case in x"],
      ["echo \"$(echo time case x in x) ' $(b) '\"", "echo time case x in x"],
      ['echo "$(echo do case x in x) $(b)"', "echo do case x in x"],
    ]
    for (const [command, body] of cases) {
      const found = substitutions(command)
      assert.isTrue(!found.unclosed && found.bodies.some((b) => b === body), `${command}: ${JSON.stringify(found)}`)
    }
  })

  it("finds the programs a command runs", () => {
    for (const c of YES) assert.isTrue(runsProgram(c, "gh"), c)
    for (const c of NO) assert.isFalse(runsProgram(c, "gh"), c)
  })

  it("commits, pushes and new pull requests change code", () => {
    // Wrappers' option values can be any text (this used to panic).
    assert.isTrue(!bash("env -C/tmp/项目 pwd") && !bash("sudo -u用户 ls"))
    assert.isTrue(bash("env -C/tmp/项目 git commit -am fix"))
    assert.isTrue(bash("cd ../deploy && git add -A && git commit -m 'Pin images'"))
    assert.isTrue(bash("git -C /src/deploy push -u origin x"))
    assert.isTrue(bash("git -C '/src/deploy repo' commit -am fix"))
    assert.isTrue(bash("git -c user.name='Huntaway' commit -am fix"))
    assert.isTrue(bash('git -c "user.name=Huntaway" -C /src/x commit -am fix'))
    assert.isTrue(bash("timeout 60 git push"))
    assert.isTrue(bash("gh pr create --fill"))
    assert.isTrue(bash("bash -lc 'cd /src/x && git commit -am fix'"))
    assert.isFalse(bash("git status && git log --oneline -5"))
    assert.isFalse(bash("git log --grep 'git commit'"))
    assert.isFalse(bash("gh pr view 4 --json url"))
    assert.isFalse(bash("echo 'git commit' # git push"))
    // A command that failed may have written first: the git area's `changesCode` asks about it all the same.
    assert.isTrue(bash("sed -i 's/old/new/' /src/deploy/src/main.rs && false"))
  })

  it("shell writes change code, except to scratch places", () => {
    assert.isTrue(bash("sed -i 's/old/new/' /src/deploy/src/main.rs"))
    assert.isTrue(bash("sed -Ei.bak 's/a/b/' x.rs"))
    assert.isTrue(bash("perl -pi -e 's/a/b/' x.rs"))
    assert.isTrue(bash("echo hi > /src/deploy/README.md"))
    assert.isTrue(bash("cat >> notes.md <<'EOF'\nhi\nEOF"))
    assert.isTrue(bash("printf x | tee src/a.rs"))
    assert.isTrue(bash("patch -p1 < fix.diff"))
    assert.isTrue(bash("cp /tmp/a.rs /src/deploy/a.rs"))
    assert.isFalse(bash("sed -n '1,20p' src/main.rs"))
    assert.isFalse(bash("timeout 900 cargo test > /tmp/test.log 2>&1; tail -30 /tmp/test.log"))
    assert.isFalse(bash("ls 2>/dev/null || echo none >&2"))
    assert.isFalse(bash("grep -rn 'a > b' src"))
    assert.isFalse(bash("cp a.rs /tmp/a.rs && rm -rf /tmp/x"))
    assert.isFalse(bash("cargo build &>/dev/null"))
  })

  it("here-documents are data unless given to a shell", () => {
    assert.isFalse(bash("cat <<'EOF'\ngit commit -am x\nrm -rf src\na > b\nEOF"))
    assert.isFalse(bash("gh pr comment 4 --body-file - <<-EOF\n\tgit push\n\tEOF\necho done"))
    assert.isTrue(bash("cat <<EOF\ngit commit\nEOF\ngit push"))
    assert.isTrue(bash("cat > /src/deploy/a.yml <<'EOF'\nkey: value\nEOF"))
    assert.isTrue(bash("bash <<'EOF'\ncd /src/deploy\ngit commit -am x\nEOF"))
    assert.isFalse(bash("git log --format=%s <<< 'git commit'"))
  })

  it("quotes and escapes are removed", () => {
    assert.deepStrictEqual(words(`a 'b c' "d \\"e\\"" f\\ g ''`), ["a", "b c", 'd "e"', "f g", ""])
    assert.deepStrictEqual(tokenize("a&&b 2>x"), [{ t: "Word", w: "a" }, { t: "Control" }, { t: "Word", w: "b" }, { t: "Output" }, { t: "Word", w: "x" }])
  })
})
