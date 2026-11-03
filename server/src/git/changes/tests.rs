use super::*;
use serde_json::{Value, json};

/// `changes_code` for a stored tool_use block and its tool_result block, if it has one, as a
/// thread's history has them (converted into a tool_call item).
fn changes_code(tool_use: &Value, result: Option<&Value>) -> bool {
    let mut call = tool_use.clone();
    call["type"] = json!("tool_use");
    call["id"] = json!("t");
    let message = |id: i64, data: Value| crate::db::Message { id, task_id: "t".into(), kind: "claude".into(), data, created_at: "2026-01-01T00:00:00Z".into() };
    let mut messages = vec![message(1, json!({"type": "assistant", "message": {"content": [call]}}))];
    if let Some(r) = result {
        let mut r = r.clone();
        r["type"] = json!("tool_result");
        r["tool_use_id"] = json!("t");
        messages.push(message(2, json!({"type": "user", "message": {"content": [r]}})));
    }
    let h = crate::threads::history::from_messages(&crate::testing::task(&crate::testing::state()), &messages).unwrap();
    let [call] = h.tool_calls().collect::<Vec<_>>()[..] else { panic!("one call") };
    super::changes_code(call)
}

#[test]
fn substitutions_end_where_bash_ends_them() {
    // Each `$(…)` as bash reads it, whatever the rest of the command would make of it.
    for (command, body) in [
        ("echo \"$(case x in y) echo esac;; x) gh;; esac) tail\"", "case x in y) echo esac;; x) gh;; esac"),
        ("echo \"$(case x in x|esac) gh;; esac)\"", "case x in x|esac) gh;; esac"),
        ("echo \"$(time -p case x in x) a;; esac; b)\"", "time -p case x in x) a;; esac; b"),
        ("echo \"$(case x in (x) a;; esac) $(b)\"", "case x in (x) a;; esac"),
        ("echo \"$(echo case in x) $(b)\"", "echo case in x"),
        ("echo \"$(echo time case x in x) ' $(b) '\"", "echo time case x in x"),
        ("echo \"$(echo do case x in x) $(b)\"", "echo do case x in x"),
    ] {
        let found = substitutions(command);
        assert!(!found.unclosed && found.bodies.iter().any(|b| b == body), "{command}: {found:?}");
    }
}

#[test]
fn finds_the_programs_a_command_runs() {
    for c in [
        "gh pr view",
        "a && gh x",
        "x | gh y",
        "env -i B=1 gh",
        "sudo -E /opt/bin/gh",
        "`gh pr list`",
        "(gh x)",
        "sh <<EOF\ngh pr view\nEOF\n",
        // Substitutions in double quotes and backticks, and reserved words before the program.
        "echo \"$(gh pr view 3)\"",
        "echo `gh pr view 3`",
        "echo \"x `gh pr view 3` y\"",
        "echo $(echo $(gh api user))",
        "if gh pr view 3; then echo yes; fi",
        "if ! gh auth status; then exit 1; fi",
        "while true; do gh run list; done",
        "for p in 1 2; do gh pr view $p; done",
        "{ gh pr view; }",
        "x=$(gh pr view --json url)",
        // Wrappers' options and their values.
        "env -u GH_TOKEN gh api user",
        "timeout -s TERM 30 gh api user",
        "timeout --signal TERM -k 5 30 gh api user",
        "sudo -u ivan gh pr view",
        "sudo -Eu ivan -- gh pr view",
        "xargs -I {} gh pr view {}",
        "nice -n 5 gh pr list",
        // Substitutions in an expanded here-document, and after a comment's line.
        "cat <<EOF\nsee $(gh pr view 3)\nEOF\n",
        "cat <<-EOF\n\t`gh pr view 3`\n\tEOF\n",
        "# list them\necho \"$(gh pr list)\"",
        // Attached option values, env's split string, and quoting inside substitutions and
        // here-document delimiters.
        "sudo -uroot gh api user",
        "sudo -u 用户 gh api user",
        "sudo -u用户 gh api user",
        "env -S 'gh api user'",
        "env -S'gh api user'",
        "env --split-string='-i gh api user'",
        "env -C/tmp/项目 gh api user",
        "echo \"$(printf ')'; gh api user)\"",
        "echo \"$(echo \")\"; gh api user)\"",
        "cat <<'END DOC'\nliteral\nEND DOC\necho \"$(gh api user)\"",
        "cat <<\"END DOC\"\nliteral $(x)\nEND DOC\ngh pr view",
        // A `)` in a comment or a here-document inside a substitution doesn't end it.
        "echo \"$(echo ok # )\ngh api user)\"",
        "echo \"$(cat <<'EOF'\n)\nEOF\ngh api user)\"",
        "echo \"$( (echo a) ; gh api user)\"",
        "echo \"$(echo $((1 + 2)); gh api user)\"",
        "echo \"$(echo \"$(gh api user)\")\"",
        // Nor does a case pattern's.
        "echo \"$(case x in x) gh api user;; esac)\"",
        // `esac` as an argument or a later alternative, and `case` after `time`.
        "echo \"$(case x in y) echo esac;; x) gh api user;; esac)\"",
        "echo \"$(case x in x) echo esac;;& *) gh api user;; esac)\"",
        "echo \"$(case x in x|esac) gh api user;; esac)\"",
        "echo \"$(time case x in x) gh api user;; esac)\"",
        "echo \"$(time -p case x in x) echo ok;; esac; gh api user)\"",
        "echo \"$(coproc case x in x) echo ok;; esac; gh api user)\"",
        // Reserved words and prefixes as arguments, before a `case` argument.
        "echo \"$(echo time case x in x) ' $(gh api user) '\"",
        "echo \"$(echo do case x in x) ' $(gh api user) '\"",
        "echo \"$(echo ! case x in x) ' $(gh api user) '\"",
        "echo \"$(echo if case x in x) ' $(gh api user) '\"",
        // Pipeline prefixes before the program.
        "coproc gh api user",
        "time ! gh api user",
        "time -p ! gh api user",
        "! time gh api user",
        "echo \"$(time ! gh api user)\"",
        // A substitution that never ends doesn't pass.
        "echo \"$(echo x\"",
        "echo `echo x",
        "echo \"$(case x in x) echo ok;; esac; gh api user)\"",
        "echo \"$(case x in (x|y) echo ok;; *) echo no;; esac; gh api user)\"",
        "echo \"$(case $(echo x) in\n  x) echo \"$(case y in y) echo;; esac)\" ;;\nesac; gh api user)\"",
        // A wrapper's option missing its value, before another command.
        "env -u; gh api user",
        "timeout --signal; gh api user",
        "sudo -u; gh api user",
        // ANSI-C and locale quoting.
        "echo $'it\\'s fine'; gh api user",
        "echo $'it\\'s fine' \"$(gh api user)\"",
        "$'gh' api user",
        "$'g\\x68' api user",
        "$'\\147\\150' api user",
        "$'\\u0067h' api user",
        "$'gh\\0junk' api user",
        "$\"gh\" api user",
        "cat <<$'EOF'\nx\nEOF\ngh api user",
        "cat <<$\"EOF\"\nx\nEOF\ngh api user",
        "echo \"$(echo $'a\\')' ; gh api user)\"",
        // `builtin`, and `eval`.
        "builtin command gh api user",
        "builtin exec gh api user",
        "eval gh api user",
        "eval 'gh api user'",
        "eval \"echo x; gh api user\"",
    ] {
        assert!(runs_program(c, "gh"), "{c}");
    }
    for c in [
        "ghq get",
        "echo gh",
        "git log --grep gh",
        "cat <<EOF\ngh pr view\nEOF\n",
        "# gh pr view",
        "'echo gh'",
        "echo 'run $(gh pr view) later'",
        "echo \"gh pr view\"",
        "if test -f gh; then echo gh; fi",
        "echo $((1 + 2))",
        // Comments and quoted here-documents aren't expanded.
        "# `gh pr view 3`\necho ok",
        "echo ok # $(gh pr view 3)",
        "cat <<'EOF'\nUse `gh pr view 3` to inspect the PR.\nEOF\n",
        "cat <<\"EOF\" > notes.md\nRun $(gh pr view) later\nEOF\necho done",
        "cat <<\\EOF\n`gh x`\nEOF\n",
        "cat <<'EOF'\nit's $(gh pr view)\nEOF\n",
        "echo a#b",
        "timeout -s TERM 30 cargo test gh",
        "env -C/tmp/项目 pwd",
        "sudo -u 用户 ls gh",
        "env -S 'echo gh'",
        "cat <<'END DOC'\nsee $(gh pr view)\nEND DOC\necho done",
        "echo \"$(echo ok # gh api user\n)\"",
        "echo \"$(cat <<'EOF'\n$(gh api user)\nEOF\n)\"",
        "echo \"$(case x in x) echo gh;; esac)\" 'gh api user'",
        "echo \"$(echo case in x) gh\"",
        "env -u; echo gh",
        "echo $'it\\'s gh api user'",
        "echo $'$(gh api user)'",
        "echo $'`gh api user`'",
        "$'g\\x68x' api user",
        "echo $$'$(gh api user)'",
        "builtin echo gh",
        "eval echo gh",
    ] {
        assert!(!runs_program(c, "gh"), "{c}");
    }
}

fn bash(c: &str) -> bool {
    let ok = json!({"type": "tool_result", "tool_use_id": "t", "content": "", "is_error": false});
    changes_code(&json!({"type": "tool_use", "id": "t", "name": "Bash", "input": {"command": c}}), Some(&ok))
}

#[test]
fn edits_change_code_and_reads_dont() {
    let ok = json!({"is_error": false});
    assert!(changes_code(&json!({"name": "Edit", "input": {}}), Some(&ok)));
    assert!(changes_code(&json!({"name": "ApplyPatch", "input": {}}), Some(&ok)));
    assert!(!changes_code(&json!({"name": "Read", "input": {"file_path": "a"}}), Some(&ok)));
}

#[test]
fn failed_edits_dont_change_code_but_failed_shell_writes_may_have() {
    let call = |name: &str, command: &str| json!({"name": name, "input": {"command": command}});
    let failed = |text: &str| json!({"is_error": true, "content": text});
    assert!(!changes_code(&call("ApplyPatch", ""), Some(&failed("The change was declined."))));
    assert!(!changes_code(&call("Edit", ""), Some(&failed("String to replace not found"))));
    assert!(!changes_code(&call("Write", ""), None));
    let write = call("Bash", "sed -i 's/old/new/' /src/deploy/src/main.rs && false");
    assert!(changes_code(&write, Some(&failed("(exit code 1)"))));
    assert!(changes_code(&write, Some(&json!({"is_error": true, "content": [{"type": "text", "text": "Exit code 1"}]}))));
    assert!(changes_code(&write, None));
    assert!(!changes_code(&write, Some(&failed("The command was declined."))));
    assert!(!changes_code(&write, Some(&failed("The user denied this action."))));
}

#[test]
fn commits_pushes_and_new_prs_change_code() {
    // Wrappers' option values can be any text (this used to panic).
    assert!(!bash("env -C/tmp/项目 pwd") && !bash("sudo -u用户 ls"));
    assert!(bash("env -C/tmp/项目 git commit -am fix"));
    assert!(bash("cd ../deploy && git add -A && git commit -m 'Pin images'"));
    assert!(bash("git -C /src/deploy push -u origin x"));
    assert!(bash("git -C '/src/deploy repo' commit -am fix"));
    assert!(bash("git -c user.name='Huntaway' commit -am fix"));
    assert!(bash("git -c \"user.name=Huntaway\" -C /src/x commit -am fix"));
    assert!(bash("timeout 60 git push"));
    assert!(bash("gh pr create --fill"));
    assert!(bash("bash -lc 'cd /src/x && git commit -am fix'"));
    assert!(!bash("git status && git log --oneline -5"));
    assert!(!bash("git log --grep 'git commit'"));
    assert!(!bash("gh pr view 4 --json url"));
    assert!(!bash("echo 'git commit' # git push"));
}

#[test]
fn shell_writes_change_code_except_to_scratch_places() {
    assert!(bash("sed -i 's/old/new/' /src/deploy/src/main.rs"));
    assert!(bash("sed -Ei.bak 's/a/b/' x.rs"));
    assert!(bash("perl -pi -e 's/a/b/' x.rs"));
    assert!(bash("echo hi > /src/deploy/README.md"));
    assert!(bash("cat >> notes.md <<'EOF'\nhi\nEOF"));
    assert!(bash("printf x | tee src/a.rs"));
    assert!(bash("patch -p1 < fix.diff"));
    assert!(bash("cp /tmp/a.rs /src/deploy/a.rs"));
    assert!(!bash("sed -n '1,20p' src/main.rs"));
    assert!(!bash("timeout 900 cargo test > /tmp/test.log 2>&1; tail -30 /tmp/test.log"));
    assert!(!bash("ls 2>/dev/null || echo none >&2"));
    assert!(!bash("grep -rn 'a > b' src"));
    assert!(!bash("cp a.rs /tmp/a.rs && rm -rf /tmp/x"));
    assert!(!bash("cargo build &>/dev/null"));
}

#[test]
fn here_documents_are_data_unless_given_to_a_shell() {
    assert!(!bash("cat <<'EOF'\ngit commit -am x\nrm -rf src\na > b\nEOF"));
    assert!(!bash("gh pr comment 4 --body-file - <<-EOF\n\tgit push\n\tEOF\necho done"));
    assert!(bash("cat <<EOF\ngit commit\nEOF\ngit push"));
    assert!(bash("cat > /src/deploy/a.yml <<'EOF'\nkey: value\nEOF"));
    assert!(bash("bash <<'EOF'\ncd /src/deploy\ngit commit -am x\nEOF"));
    assert!(!bash("git log --format=%s <<< 'git commit'"));
}

#[test]
fn quotes_and_escapes_are_removed() {
    let words = |c: &str| tokenize(c).into_iter().filter_map(|t| if let Token::Word(w) = t { Some(w) } else { None }).collect::<Vec<_>>();
    assert_eq!(words(r#"a 'b c' "d \"e\"" f\ g ''"#), ["a", "b c", "d \"e\"", "f g", ""]);
    assert_eq!(tokenize("a&&b 2>x"), [Token::Word("a".into()), Token::Control, Token::Word("b".into()), Token::Output, Token::Word("x".into())]);
}
