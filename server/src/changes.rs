//! Whether an agent's tool call changed code, so its task has something to review. Edits count,
//! and so do shell commands that commit, push, open a pull request or write files (in-place
//! edits, redirects, copies and the like), except to scratch places such as /tmp.
//!
//! This reads commands, not what they did, so it can't see files a script writes from its own
//! code (`python3 -c '...'`, a script file). That's accepted: such a task can still be reviewed
//! with Review now, and treating every script as a change would review most tasks again.

use serde_json::Value;

/// Whether a tool call, given its result (`tool_result` block) if it has one, changed code. An
/// edit is all or nothing, so it only did if it succeeded. A shell command may have written
/// files before it failed or was cut short, so it did unless it was denied and never ran.
pub fn changes_code(tool_use: &Value, result: Option<&Value>) -> bool {
    match tool_use["name"].as_str().unwrap_or("") {
        "Edit" | "MultiEdit" | "Write" | "NotebookEdit" | "ApplyPatch" => result.is_some_and(|r| r["is_error"] != true),
        "Bash" => !result.is_some_and(denied) && command_changes_code(tool_use["input"]["command"].as_str().unwrap_or(""), 0),
        _ => false,
    }
}

/// Whether a tool call's result says it was denied, so it never ran.
fn denied(result: &Value) -> bool {
    const DENIALS: &[&str] = &["The command was declined.", "The user denied this action.", crate::permissions::DONT_ASK_DENIAL];
    let text = match &result["content"] {
        Value::String(s) => s.clone(),
        Value::Array(parts) => parts.iter().filter_map(|p| p["text"].as_str()).collect::<Vec<_>>().join("\n"),
        _ => String::new(),
    };
    result["is_error"] == true && DENIALS.iter().any(|d| text.contains(d))
}

/// A shell token: a word (unquoted) or an operator.
#[derive(Debug, PartialEq)]
enum Token {
    Word(String),
    /// A control operator (`;`, `&&`, `|`, `(`, newline, ...), which ends a simple command.
    Control,
    /// An output redirect (`>`, `>>`, `2>`, `&>`): the next word is where it writes.
    Output,
    /// An input redirect or here-document (`<`, `<<`, `<<<`): the next word is what it reads
    /// (a here-document's delimiter).
    Input,
    /// A here-document's body, data for the command it's given to (after the line it starts on).
    HereDoc(String),
}

/// Split a shell command into words and operators, removing quotes and escapes.
fn tokenize(command: &str) -> Vec<Token> {
    let mut tokens = Vec::new();
    let mut word = String::new();
    // Whether there's a word in progress (it may be empty, as in `''`).
    let mut in_word = false;
    let mut chars = command.chars().peekable();
    // Here-documents started on the current line: the index of their `Input` token, and whether
    // their body's leading tabs are stripped (`<<-`).
    let mut heredocs: Vec<(usize, bool)> = Vec::new();
    let end_word = |tokens: &mut Vec<Token>, word: &mut String, in_word: &mut bool| {
        if *in_word {
            tokens.push(Token::Word(std::mem::take(word)));
            *in_word = false;
        }
    };
    while let Some(c) = chars.next() {
        match c {
            '\'' => {
                in_word = true;
                for c in chars.by_ref() {
                    if c == '\'' {
                        break;
                    }
                    word.push(c);
                }
            }
            '"' => {
                in_word = true;
                while let Some(c) = chars.next() {
                    match c {
                        '"' => break,
                        '\\' if chars.peek().is_some_and(|n| "\"\\$`\n".contains(*n)) => word.extend(chars.next()),
                        c => word.push(c),
                    }
                }
            }
            '\\' => {
                in_word = true;
                match chars.next() {
                    Some('\n') | None => {}
                    Some(n) => word.push(n),
                }
            }
            '#' if !in_word => {
                // A comment, to the end of the line.
                while chars.peek().is_some_and(|n| *n != '\n') {
                    chars.next();
                }
            }
            '>' => {
                // `2>`, `&>`: the digits or `&` before it are the redirect's, not a word.
                if in_word && (word == "&" || word.chars().all(|c| c.is_ascii_digit())) {
                    word.clear();
                    in_word = false;
                }
                end_word(&mut tokens, &mut word, &mut in_word);
                while chars.peek().is_some_and(|n| *n == '>' || *n == '|') {
                    chars.next();
                }
                if chars.peek() == Some(&'&') {
                    // `>&2` duplicates a descriptor rather than writing a file.
                    chars.next();
                    while chars.peek().is_some_and(|n| n.is_ascii_digit() || *n == '-') {
                        chars.next();
                    }
                    continue;
                }
                tokens.push(Token::Output);
            }
            '<' => {
                end_word(&mut tokens, &mut word, &mut in_word);
                let mut n = 1;
                while chars.peek() == Some(&'<') {
                    chars.next();
                    n += 1;
                }
                if n == 2 {
                    let strip_tabs = chars.next_if_eq(&'-').is_some();
                    heredocs.push((tokens.len(), strip_tabs));
                }
                tokens.push(Token::Input);
            }
            ';' | '&' | '|' | '(' | ')' | '\n' => {
                if c == '&' && chars.peek() == Some(&'>') {
                    end_word(&mut tokens, &mut word, &mut in_word);
                    word.push('&');
                    in_word = true;
                    continue;
                }
                end_word(&mut tokens, &mut word, &mut in_word);
                if c == '\n' {
                    // The bodies of the line's here-documents follow it, each up to its delimiter.
                    for (at, strip_tabs) in std::mem::take(&mut heredocs) {
                        let Some(Token::Word(delimiter)) = tokens.get(at + 1) else { continue };
                        let delimiter = delimiter.clone();
                        let mut body = String::new();
                        while chars.peek().is_some() {
                            let line: String = chars.by_ref().take_while(|c| *c != '\n').collect();
                            let line = if strip_tabs { line.trim_start_matches('\t') } else { line.as_str() };
                            if line == delimiter {
                                break;
                            }
                            body.push_str(line);
                            body.push('\n');
                        }
                        tokens.push(Token::HereDoc(body));
                    }
                }
                if tokens.last() != Some(&Token::Control) {
                    tokens.push(Token::Control);
                }
            }
            c if c.is_whitespace() => end_word(&mut tokens, &mut word, &mut in_word),
            // `$'…'` is quoted with escapes (ANSI-C quoting), and `$"…"` is quoted like `"…"`.
            '$' if chars.peek() == Some(&'\'') => {
                in_word = true;
                chars.next();
                word.push_str(&ansi_c_quoted(&mut chars));
            }
            '$' if chars.peek() == Some(&'"') => in_word = true,
            c => {
                in_word = true;
                word.push(c);
                // `$$` is a variable, so a quote after it isn't `$'…'` or `$"…"`.
                if c == '$' {
                    word.extend(chars.next_if_eq(&'$'));
                }
            }
        }
    }
    end_word(&mut tokens, &mut word, &mut in_word);
    tokens
}

/// The text of an ANSI-C quoted string (`$'…'`) after its opening quote, up to its closing one,
/// with its escapes (`\'`, `\x68`, `\150`, `\u0068`, `\n`, `\cA`, …) decoded as bash decodes them.
fn ansi_c_quoted(chars: &mut impl Iterator<Item = char>) -> String {
    let mut out = String::new();
    let mut chars = chars.peekable();
    while let Some(c) = chars.next() {
        match c {
            '\'' => break,
            '\\' => {
                let Some(e) = chars.next() else { break };
                let mut number = |radix: u32, max: usize, mut n: Option<u32>| {
                    for _ in 0..max {
                        let Some(d) = chars.peek().and_then(|d| d.to_digit(radix)) else { break };
                        chars.next();
                        n = Some(n.unwrap_or(0) * radix + d);
                    }
                    n
                };
                let code = match e {
                    'a' => Some(7),
                    'b' => Some(8),
                    'e' | 'E' => Some(27),
                    'f' => Some(12),
                    'n' => Some(10),
                    'r' => Some(13),
                    't' => Some(9),
                    'v' => Some(11),
                    '\\' | '\'' | '"' | '?' => Some(e as u32),
                    '0'..='7' => number(8, 2, e.to_digit(8)),
                    'x' => number(16, 2, None),
                    'u' => number(16, 4, None),
                    'U' => number(16, 8, None),
                    'c' => chars.next().map(|x| x.to_ascii_uppercase() as u32 & 0x1f),
                    _ => None,
                };
                match code {
                    Some(code) => out.push(char::from_u32(code).unwrap_or(char::REPLACEMENT_CHARACTER)),
                    // Not an escape (`\q`, `\x` without digits): the backslash stays.
                    None => {
                        out.push('\\');
                        out.push(e);
                    }
                }
            }
            c => out.push(c),
        }
    }
    // A NUL ends the string's text (bash's strings are C strings), though not its quotes.
    out.split('\0').next().unwrap_or_default().to_string()
}

/// Commands that run the command after them (with their options).
const WRAPPERS: &[&str] = &["sudo", "env", "builtin", "time", "nice", "nohup", "command", "exec", "timeout", "xargs", "stdbuf"];

/// A wrapper's options that take a value (`env -u NAME`, `timeout -s TERM`): its short ones,
/// by letter, and its long ones.
fn value_options(wrapper: &str) -> (&'static str, &'static [&'static str]) {
    match wrapper {
        "sudo" => ("ugCDhprtTU", &["--user", "--group", "--close-from", "--chdir", "--host", "--prompt", "--role", "--type", "--command-timeout", "--other-user"]),
        "env" => ("uCS", &["--unset", "--chdir", "--split-string"]),
        "time" => ("fo", &["--format", "--output"]),
        "nice" => ("n", &["--adjustment"]),
        "exec" => ("a", &[]),
        "timeout" => ("sk", &["--signal", "--kill-after"]),
        "xargs" => ("adEILnPs", &["--arg-file", "--delimiter", "--max-args", "--max-procs", "--max-chars", "--max-lines", "--process-slot-var"]),
        "stdbuf" => ("ioe", &["--input", "--output", "--error"]),
        _ => ("", &[]),
    }
}

/// A wrapper's option at `words[i]` (`-u`, `-Eu`, `-uroot`, `--user`, `--user=root`): how many
/// words it takes up (two when its value is the next word), and the option taking a value, with
/// that value, if one does. In a cluster of short options, the first one taking a value takes
/// the rest of the word, or the next word if it's last.
fn wrapper_option<'a>(wrapper: &str, words: &[&'a str], i: usize) -> (usize, Option<(String, &'a str)>) {
    let word = words[i];
    let (short, long) = value_options(wrapper);
    if word.starts_with("--") {
        return match word.split_once('=') {
            Some((name, value)) if long.contains(&name) => (1, Some((name.to_string(), value))),
            None if long.contains(&word) => (2, words.get(i + 1).map(|v| (word.to_string(), *v))),
            _ => (1, None),
        };
    }
    let cluster = &word[1..];
    for (at, c) in cluster.char_indices() {
        if short.contains(c) {
            let rest = &cluster[at + c.len_utf8()..];
            let option = format!("-{c}");
            return if rest.is_empty() { (2, words.get(i + 1).map(|v| (option, *v))) } else { (1, Some((option, rest))) };
        }
    }
    (1, None)
}

/// Git subcommands that change a repository's files or history, or a remote's.
const GIT_CHANGES: &[&str] = &["commit", "push", "apply", "am", "cherry-pick", "merge", "rebase", "revert", "mv", "rm"];

/// Whether a shell command changes code. `depth` limits how deep `bash -c '...'` is followed.
fn command_changes_code(command: &str, depth: u32) -> bool {
    let tokens = tokenize(command);
    let mut words: Vec<&str> = Vec::new();
    let mut heredocs: Vec<&str> = Vec::new();
    let mut tokens = tokens.iter().peekable();
    loop {
        match tokens.next() {
            Some(Token::Word(w)) => words.push(w),
            Some(Token::HereDoc(body)) => heredocs.push(body),
            Some(Token::Output) => match tokens.next() {
                Some(Token::Word(target)) if !scratch(target) => return true,
                _ => {}
            },
            Some(Token::Input) => {
                tokens.next_if(|t| matches!(t, Token::Word(_)));
            }
            Some(Token::Control) | None => {
                if simple_command_changes_code(&words, &heredocs, depth) {
                    return true;
                }
                words.clear();
                heredocs.clear();
                if tokens.peek().is_none() {
                    return false;
                }
            }
        }
    }
}

/// Whether a shell command runs `program` (by name, wherever it's installed) in any of its simple
/// commands, including command substitutions (`$(…)` and backticks, quoted or not), after reserved
/// words (`if`, `!`, `do`, …) and wrappers such as `env`, and in scripts given to a shell.
pub fn runs_program(command: &str, program: &str) -> bool {
    runs(command, program, 0)
}

/// Reserved words that can come before a simple command's program.
const RESERVED: &[&str] = &["if", "then", "else", "elif", "while", "until", "do", "!", "{"];

fn runs(command: &str, program: &str, depth: u32) -> bool {
    let found = substitutions(command);
    // A substitution that never ends is a syntax error to bash, but one it may read differently
    // (where its end is hard to tell): it doesn't pass.
    if found.unclosed || (depth < 3 && found.bodies.iter().any(|body| runs(body, program, depth + 1))) {
        return true;
    }
    let tokens = tokenize(command);
    let mut words: Vec<&str> = Vec::new();
    let mut heredocs: Vec<&str> = Vec::new();
    let mut tokens = tokens.iter().peekable();
    loop {
        match tokens.next() {
            Some(Token::Word(w)) => words.push(w),
            Some(Token::HereDoc(body)) => heredocs.push(body),
            Some(Token::Output) | Some(Token::Input) => {
                tokens.next_if(|t| matches!(t, Token::Word(_)));
            }
            Some(Token::Control) | None => {
                let mut split = Vec::new();
                let i = command_index(&words, &mut split);
                if depth < 3 && split.iter().any(|script| runs(script, program, depth + 1)) {
                    return true;
                }
                let name = words.get(i).map(|w| basename(w));
                let args = words.get(i + 1..).unwrap_or_default();
                let found = match name {
                    Some(n) if n == program => true,
                    Some("bash" | "sh" | "zsh") if depth < 3 => shell_scripts(args, &heredocs).iter().any(|script| runs(script, program, depth + 1)),
                    // `eval` runs its arguments, joined, as a script.
                    Some("eval") if depth < 3 => runs(&args.join(" "), program, depth + 1),
                    _ => false,
                };
                if found {
                    return true;
                }
                words.clear();
                heredocs.clear();
                if tokens.peek().is_none() {
                    return false;
                }
            }
        }
    }
}

/// The commands in a shell command's substitutions, `$(…)` and `` `…` ``, where bash expands
/// them: outside single quotes (double quotes don't stop them) and comments, and in here-documents
/// whose delimiter isn't quoted. A substitution's own text is read the same way, so its end is
/// the `)` bash would end it at, not one in quotes, a comment or a here-document.
fn substitutions(command: &str) -> Found {
    let chars: Vec<char> = command.chars().collect();
    let mut out = Found::default();
    scan_substitutions(&chars, &mut 0, Scan::Script, &mut out);
    out
}

/// What `substitutions` finds: the commands in them, and whether one never ends.
#[derive(Default, Debug)]
struct Found {
    bodies: Vec<String>,
    unclosed: bool,
}

/// What `scan_substitutions` reads.
#[derive(Clone, Copy, PartialEq)]
enum Scan {
    /// Shell code, to its end.
    Script,
    /// The inside of a `$(`, up to the `)` that closes it.
    Substitution,
    /// An expanded here-document's body, where quotes and `#` are only text.
    HereDoc,
}

/// Read `chars` from `*pos`, adding the substitutions found to `out`, and leave `*pos` after what
/// was read (after the closing `)` for a `Scan::Substitution`).
fn scan_substitutions(chars: &[char], pos: &mut usize, scan: Scan, out: &mut Found) {
    let mut double = false;
    // Parentheses opened inside a substitution (subshells, `$((…))`), which its `)` isn't.
    let mut depth = 0;
    // Whether the next character starts a word (where `#` starts a comment).
    let mut word_start = true;
    // Here-documents started on the current line: their delimiter, whether their body is
    // expanded (the delimiter isn't quoted), and whether their lines' leading tabs are stripped.
    let mut heredocs: Vec<(String, bool, bool)> = Vec::new();
    // The word being read, unquoted (quotes make it no keyword), and whether it's where a command
    // starts, to follow `case … in … esac`: for each case open, whether its `in` has come; and
    // whether a pattern is being read, whose `)` doesn't close anything.
    let mut word = String::new();
    let mut at_command = true;
    let mut cases: Vec<bool> = Vec::new();
    let mut pattern = false;
    // Whether the word being read is a pattern's first (where `esac` is the keyword, not after
    // `|`), and whether the last word was `time` (whose options a command can follow too).
    let mut pattern_first = false;
    let mut after_time = false;
    let next = |pos: &mut usize| {
        let c = chars.get(*pos).copied();
        *pos += 1;
        c
    };
    while let Some(c) = next(pos) {
        let mut starts_word = false;
        if !double && (c.is_whitespace() || ";&|()<>".contains(c)) {
            let w = std::mem::take(&mut word);
            match w.as_str() {
                "case" if at_command && !pattern => cases.push(false),
                "in" if cases.last() == Some(&false) => {
                    cases.pop();
                    cases.push(true);
                    (pattern, pattern_first) = (true, true);
                }
                // As an argument, or a pattern's after `|`, it's just a word.
                "esac" if !cases.is_empty() && (if pattern { pattern_first } else { at_command }) => {
                    cases.pop();
                    pattern = false;
                }
                _ => {}
            }
            if !w.is_empty() {
                // A command can follow a reserved word or prefix only where that word started one:
                // as an argument (`echo do`), it's just a word.
                let prefix = RESERVED.contains(&w.as_str()) || ["then", "do", "else", "elif", "!", "time", "coproc"].contains(&w.as_str());
                let time_option = after_time && w.starts_with('-');
                after_time = at_command && (w == "time" || time_option);
                at_command = at_command && (prefix || time_option);
                pattern_first = false;
            }
            // In a pattern, `|` separates its alternatives.
            if c == '\n' || ";&()".contains(c) || (c == '|' && !pattern) {
                at_command = true;
            }
        }
        match c {
            '\\' => {
                word.push(c);
                *pos += 1;
            }
            // `$$` is a variable, not the start of `$(` or `$'`.
            '$' if chars.get(*pos) == Some(&'$') => {
                word.push_str("$$");
                *pos += 1;
            }
            '$' if chars.get(*pos) == Some(&'(') => {
                word.push(c);
                *pos += 1;
                let start = *pos;
                scan_substitutions(chars, pos, Scan::Substitution, out);
                let body: String = chars[start..(*pos - 1).clamp(start, chars.len())].iter().collect();
                // `case` syntax is the easiest to misread where a substitution ends, so with what
                // may be one in it (`case` and `esac`), the rest of the command is read as part of
                // it too.
                let words: Vec<&str> = body.split(|c: char| !c.is_ascii_alphanumeric() && c != '_').collect();
                if words.contains(&"case") && words.contains(&"esac") {
                    out.bodies.push(chars[start.min(chars.len())..].iter().collect());
                }
                out.bodies.push(body);
            }
            '`' => {
                word.push(c);
                let (mut body, mut closed) = (String::new(), false);
                while let Some(c) = next(pos) {
                    match c {
                        '`' => {
                            closed = true;
                            break;
                        }
                        '\\' => body.extend(next(pos)),
                        c => body.push(c),
                    }
                }
                out.unclosed |= !closed;
                out.bodies.push(body);
            }
            _ if scan == Scan::HereDoc => {}
            // `$'…'` may have escaped quotes (`\'`) in it.
            '$' if !double && chars.get(*pos) == Some(&'\'') => {
                word.push_str("$'");
                *pos += 1;
                ansi_c_at(chars, pos);
            }
            '\'' if !double => {
                word.push(c);
                while next(pos).is_some_and(|c| c != '\'') {}
            }
            '"' => {
                word.push(c);
                double = !double;
            }
            '#' if !double && word_start => {
                while chars.get(*pos).is_some_and(|n| *n != '\n') {
                    *pos += 1;
                }
            }
            // A pattern may start with `(` too.
            '(' if !double && scan == Scan::Substitution => {
                if !pattern {
                    depth += 1;
                }
                starts_word = true;
            }
            ')' if !double && scan == Scan::Substitution => {
                if pattern {
                    pattern = false;
                } else if depth == 0 {
                    return;
                } else {
                    depth -= 1;
                }
                starts_word = true;
            }
            '<' if !double && chars.get(*pos) == Some(&'<') => {
                *pos += 1;
                // `<<<` is a here-string, a word like any other.
                if chars.get(*pos) == Some(&'<') {
                    *pos += 1;
                } else {
                    let strip_tabs = chars.get(*pos) == Some(&'-');
                    if strip_tabs {
                        *pos += 1;
                    }
                    while chars.get(*pos).is_some_and(|c| *c == ' ' || *c == '\t') {
                        *pos += 1;
                    }
                    // The delimiter is a word, quotes removed: quoted, it may have spaces in it.
                    let (mut delimiter, mut quoted) = (String::new(), false);
                    while let Some(&n) = chars.get(*pos).filter(|n| !n.is_whitespace() && !";&|()<>".contains(**n)) {
                        *pos += 1;
                        match n {
                            '$' if chars.get(*pos) == Some(&'\'') => {
                                quoted = true;
                                *pos += 1;
                                delimiter.push_str(&ansi_c_at(chars, pos));
                            }
                            // `$"…"` is quoted like `"…"`.
                            '$' if chars.get(*pos) == Some(&'"') => {}
                            '\'' => {
                                quoted = true;
                                while let Some(c) = next(pos).filter(|c| *c != '\'') {
                                    delimiter.push(c);
                                }
                            }
                            '"' => {
                                quoted = true;
                                while let Some(c) = next(pos).filter(|c| *c != '"') {
                                    match c {
                                        '\\' => delimiter.extend(next(pos)),
                                        c => delimiter.push(c),
                                    }
                                }
                            }
                            '\\' => {
                                quoted = true;
                                delimiter.extend(next(pos));
                            }
                            n => delimiter.push(n),
                        }
                    }
                    heredocs.push((delimiter, !quoted, strip_tabs));
                }
            }
            '\n' if !double => {
                // The bodies of the line's here-documents follow it, each up to its delimiter.
                for (delimiter, expanded, strip_tabs) in std::mem::take(&mut heredocs) {
                    let mut body: Vec<char> = Vec::new();
                    while *pos < chars.len() {
                        let end = chars[*pos..].iter().position(|c| *c == '\n').map_or(chars.len(), |n| *pos + n);
                        let line: String = chars[*pos..end].iter().collect();
                        *pos = end + 1;
                        if (if strip_tabs { line.trim_start_matches('\t') } else { line.as_str() }) == delimiter {
                            break;
                        }
                        body.extend(line.chars());
                        body.push('\n');
                    }
                    if expanded {
                        scan_substitutions(&body, &mut 0, Scan::HereDoc, out);
                    }
                }
                starts_word = true;
            }
            c if !double && (c.is_whitespace() || ";&|".contains(c)) => {
                // `;;`, `;&` and `;;&` end a case's command list: a pattern comes next.
                if c == ';' && matches!(chars.get(*pos), Some(';' | '&')) && cases.last() == Some(&true) {
                    (pattern, pattern_first) = (true, true);
                }
                starts_word = true;
            }
            c => {
                if !double {
                    word.push(c);
                }
            }
        }
        word_start = starts_word;
    }
    // The input ended before the substitution's `)`.
    if scan == Scan::Substitution {
        out.unclosed = true;
    }
}

/// `ansi_c_quoted` on `chars` from `*pos`, leaving `*pos` after the closing quote.
fn ansi_c_at(chars: &[char], pos: &mut usize) -> String {
    let mut rest = chars[(*pos).min(chars.len())..].iter().copied();
    let text = ansi_c_quoted(&mut rest);
    *pos = chars.len() - rest.len();
    text
}

/// Where the program is in a simple command's words as bash runs them: after reserved words,
/// pipeline prefixes (`time [-p]`, `!`, `coproc`), variable assignments and wrappers, in any
/// order (`time ! gh`, `env X=1 gh`). See `program_index` for `split`.
fn command_index(words: &[&str], split: &mut Vec<String>) -> usize {
    let mut i = 0;
    loop {
        let before = i;
        while let Some(w) = words.get(i) {
            if RESERVED.contains(w) || *w == "coproc" {
                i += 1;
            } else if *w == "time" {
                i += 1;
                while words.get(i).is_some_and(|w| *w == "-p" || *w == "--") {
                    i += 1;
                }
            } else {
                break;
            }
        }
        i += program_index(&words[i..], split);
        if i == before {
            return i;
        }
    }
}

/// Where the program is in a simple command's words: after variable assignments and wrappers
/// such as `timeout 900`. The commands `env -S` is given to split are added to `split`.
fn program_index(words: &[&str], split: &mut Vec<String>) -> usize {
    let mut i = 0;
    while let Some(w) = words.get(i) {
        let assignment = w.split_once('=').is_some_and(|(name, _)| !name.is_empty() && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_'));
        if assignment {
            i += 1;
        } else if WRAPPERS.contains(&basename(w)) {
            let wrapper = basename(w);
            i += 1;
            // Its options (and their values), and the durations, priorities and assignments some take.
            while let Some(w) = words.get(i) {
                if *w == "--" {
                    i += 1;
                    break;
                } else if w.starts_with('-') && w.len() > 1 {
                    let (taken, value) = wrapper_option(wrapper, words, i);
                    if let (true, Some((option, command))) = (wrapper == "env", value) {
                        if option == "-S" || option == "--split-string" {
                            split.push(format!("env {command}"));
                        }
                    }
                    // An option missing its value (`env -u`) takes up what's left.
                    i = (i + taken).min(words.len());
                } else if w.chars().next().is_some_and(|c| c.is_ascii_digit()) || w.contains('=') {
                    i += 1;
                } else {
                    break;
                }
            }
        } else {
            break;
        }
    }
    i
}

/// Whether one simple command (its words, without redirects, and the here-documents it's given)
/// changes code. A here-document is only read as a script when it's given to a shell.
fn simple_command_changes_code(words: &[&str], heredocs: &[&str], depth: u32) -> bool {
    let i = program_index(words, &mut Vec::new());
    let Some(name) = words.get(i).map(|w| basename(w)) else { return false };
    let args = &words[i + 1..];
    let operands = || args.iter().filter(|a| !a.starts_with('-'));
    match name {
        "git" => GIT_CHANGES.contains(&git_subcommand(args)),
        "gh" => args.starts_with(&["pr", "create"]),
        "sed" | "perl" => args.iter().any(|a| a.starts_with("--in-place") || (a.starts_with('-') && !a.starts_with("--") && in_place_flag(a))),
        "patch" => true,
        "tee" | "touch" | "rm" | "rmdir" | "mkdir" | "truncate" => operands().any(|a| !scratch(a)),
        "cp" | "mv" | "install" | "ln" | "rsync" => operands().next_back().is_some_and(|a| !scratch(a)),
        "bash" | "sh" | "zsh" if depth < 3 => shell_scripts(args, heredocs).iter().any(|script| command_changes_code(script, depth + 1)),
        _ => false,
    }
}

/// The scripts a shell runs, given its arguments and here-documents: its `-c` script, or else
/// what it reads from a here-document.
fn shell_scripts<'a>(args: &[&'a str], heredocs: &[&'a str]) -> Vec<&'a str> {
    match args.iter().position(|a| a.starts_with('-') && !a.starts_with("--") && a.contains('c')) {
        Some(p) => args.get(p + 1).copied().into_iter().collect(),
        None => heredocs.to_vec(),
    }
}

/// Whether a short-option cluster for sed or perl edits in place: `-i`, `-i.bak`, `-pi`, `-Ei`.
fn in_place_flag(arg: &str) -> bool {
    arg[1..].chars().take_while(|c| c.is_ascii_alphabetic()).any(|c| c == 'i')
}

fn basename(word: &str) -> &str {
    word.rsplit('/').next().unwrap_or(word)
}

/// Whether a path is a scratch place whose writes aren't code changes.
fn scratch(path: &str) -> bool {
    ["/dev/", "/tmp/", "/var/tmp/", "$TMPDIR", "${TMPDIR"].iter().any(|p| path.starts_with(p)) || path == "/tmp"
}

/// The subcommand in a git command's arguments, after its options (such as `-C <dir>`).
fn git_subcommand<'a>(args: &[&'a str]) -> &'a str {
    let mut i = 0;
    while i < args.len() {
        match args[i] {
            "-C" | "-c" | "--git-dir" | "--work-tree" | "--namespace" => i += 2,
            a if a.starts_with('-') => i += 1,
            a => return a,
        }
    }
    ""
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

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
}
