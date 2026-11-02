//! Where a gh command goes: the hosts and repositories its arguments name, read with the help of
//! gh's own help.

use super::*;

/// A repository's host, given as `HOST/OWNER/REPO` or a URL (`OWNER/REPO` has none).
pub(super) fn repo_host(r: &str) -> Option<String> {
    let parts: Vec<&str> = r.trim().split('/').collect();
    match parts[..] {
        [host, _, _] => Some(host.to_string()),
        _ => url_host(r),
    }
}

/// gh options whose value is where a command goes: a host, or a repository (see `repo_host`).
const TARGET_OPTIONS: &[&str] = &["--hostname", "--repo", "--source", "--branch-repo"];

/// What gh's help says about one of its commands.
#[derive(Clone, Debug, Default, PartialEq)]
pub(super) struct CommandHelp {
    /// How many words name it (`pr view` is two).
    pub(super) path: usize,
    /// Its options: short name, long name, and whether it takes a value.
    pub(super) options: Vec<(Option<char>, String, bool)>,
    /// Its arguments as its usage has them (`[<number> | <url> | <branch>]`, `<files>...`).
    pub(super) arguments: Vec<String>,
}

impl CommandHelp {
    /// Parse `gh <command> --help`.
    pub(super) fn parse(help: &str) -> Option<CommandHelp> {
        let mut lines = help.lines();
        lines.by_ref().find(|l| l.trim() == "USAGE")?;
        let usage = lines.next()?.trim().strip_prefix("gh ")?;
        let path = usage.split_whitespace().take_while(|w| !w.starts_with(['<', '[', '{'])).count();
        let rest: String = usage.split_whitespace().skip(path).collect::<Vec<_>>().join(" ");
        // Its groups at the top level, `[<number> | <url>]`, `<files>...`, up to `[flags]` and `--`.
        let mut arguments = Vec::new();
        let (mut group, mut depth) = (String::new(), 0);
        for c in rest.chars().chain([' ']) {
            match c {
                '[' | '{' | '<' => depth += 1,
                ']' | '}' | '>' => depth -= 1,
                _ => {}
            }
            if c == ' ' && depth == 0 {
                let g = std::mem::take(&mut group);
                if g == "[flags]" || g.starts_with("[--") || g == "--" {
                    break;
                }
                if !g.is_empty() {
                    arguments.push(g);
                }
            } else {
                group.push(c);
            }
        }
        let mut options = Vec::new();
        for line in help.lines() {
            let line = line.trim_start();
            if !line.starts_with('-') {
                continue;
            }
            // `-q, --jq expression   Filter …`: its names, then its value's, before the description.
            let words: Vec<&str> = line.split("  ").next().unwrap_or_default().split_whitespace().collect();
            let names: Vec<&str> = words.iter().map(|w| w.trim_end_matches(',')).take_while(|w| w.starts_with('-')).collect();
            let Some(long) = names.iter().find(|n| n.starts_with("--")) else { continue };
            let short = names.iter().find(|n| !n.starts_with("--")).and_then(|n| n.chars().nth(1));
            options.push((short, long.to_string(), words.len() > names.len()));
        }
        Some(CommandHelp { path, options, arguments })
    }

    /// The hosts `args` (gh's arguments, the command first) name where the command goes (see
    /// `Account::check_targets`).
    pub(super) fn targets(&self, args: &[&str]) -> Vec<String> {
        let mut hosts = Vec::new();
        let mut target_option = |long: &str, value: &str| {
            if long == "--hostname" {
                hosts.push(value.trim().to_ascii_lowercase());
            } else if TARGET_OPTIONS.contains(&long) {
                hosts.extend(repo_host(value));
            }
        };
        let (mut i, mut words, mut dashes) = (0, 0, false);
        let mut positional = Vec::new();
        while let Some(&a) = args.get(i) {
            i += 1;
            if dashes || !a.starts_with('-') || a == "-" {
                positional.push(a);
                continue;
            }
            if a == "--" {
                dashes = true;
            } else if let Some(long) = a.strip_prefix("--") {
                let (name, attached) = match long.split_once('=') {
                    Some((name, value)) => (format!("--{name}"), Some(value)),
                    None => (a.to_string(), None),
                };
                let takes = self.options.iter().any(|(_, l, v)| *l == name && *v);
                let value = attached.or_else(|| takes.then(|| args.get(i).copied()).flatten());
                if takes && attached.is_none() {
                    i += 1;
                }
                if let Some(v) = value {
                    target_option(&name, v);
                }
            } else {
                // A cluster of short options: the first taking a value takes the rest, or the next word.
                for (at, c) in a.char_indices().skip(1) {
                    let Some((_, long, true)) = self.options.iter().find(|(s, _, _)| *s == Some(c)) else { continue };
                    let rest = &a[at + c.len_utf8()..];
                    let value = if rest.is_empty() {
                        i += 1;
                        args.get(i - 1).copied()
                    } else {
                        Some(rest.strip_prefix('=').unwrap_or(rest))
                    };
                    if let Some(v) = value {
                        target_option(long, v);
                    }
                    break;
                }
            }
        }
        for a in positional.into_iter().skip(self.path) {
            let argument = self.arguments.get(words).or(self.arguments.last().filter(|g| g.ends_with("..."))).map(|g| g.to_ascii_lowercase());
            words += 1;
            let Some(argument) = argument else { continue };
            let repository = argument.contains("repo");
            if repository || argument.contains("url") || argument.contains("endpoint") {
                hosts.extend(url_host(a).or_else(|| if repository { positional_host(a) } else { None }));
            }
        }
        hosts
    }
}

/// The top-level commands of gh whose help `command_help` reads (not aliases or extensions,
/// whose `--help` may run something).
const GH_COMMANDS: &[&str] = &[
    "agent-task", "api", "attestation", "auth", "browse", "cache", "codespace", "cs", "discussion", "extension", "ext", "gist", "gpg-key",
    "issue", "label", "org", "pr", "project", "release", "repo", "ruleset", "run", "search", "secret", "ssh-key", "status", "variable",
    "workflow",
];

/// The help of the gh command `args` run (`gh pr view --help`), kept for the next time.
pub(super) fn command_help(args: &[&str]) -> Option<CommandHelp> {
    static CACHE: std::sync::Mutex<Vec<(String, Option<CommandHelp>)>> = std::sync::Mutex::new(Vec::new());
    let command = *args.first().filter(|c| GH_COMMANDS.contains(c))?;
    let sub = args.get(1).filter(|s| !s.is_empty() && s.chars().all(|c| c.is_ascii_lowercase() || c == '-'));
    let key = format!("{command} {}", sub.copied().unwrap_or_default());
    if let Some((_, help)) = CACHE.lock().unwrap().iter().find(|(k, _)| *k == key) {
        return help.clone();
    }
    let mut cmd = std::process::Command::new(gh_program());
    cmd.arg(command).args(sub).arg("--help").env("GH_NO_UPDATE_NOTIFIER", "1").env("NO_COLOR", "1").stdin(Stdio::null()).stderr(Stdio::null());
    let help = cmd.output().ok().filter(|o| o.status.success()).and_then(|o| CommandHelp::parse(&String::from_utf8_lossy(&o.stdout)));
    CACHE.lock().unwrap().push((key, help.clone()));
    help
}

/// The hosts a gh command's arguments name, read without its help: `--hostname`, `--repo`'s
/// host, and every other argument's that's a URL or a repository on a host of its own, but the
/// values of `CONTENT_OPTIONS`.
pub(super) fn fallback_targets(args: &[&str]) -> Vec<String> {
    let mut hosts: Vec<String> = Vec::new();
    let api = args.first() == Some(&"api");
    let mut i = 0;
    while let Some(&a) = args.get(i) {
        // Texts, fields and the like aren't where the command goes, whatever is in them.
        if let Some(taken) = content_option(a, api) {
            i += taken;
            continue;
        }
        let value = |flag: &str| match a.strip_prefix(flag) {
            Some("") => args.get(i + 1).copied(),
            Some(v) => v.strip_prefix('=').or(if flag.starts_with("--") { None } else { Some(v) }),
            None => None,
        };
        if let Some(h) = value("--hostname") {
            hosts.push(h.to_string());
        } else if let Some(r) = value("--repo").or_else(|| value("-R")) {
            hosts.extend(repo_host(r));
        } else {
            hosts.extend(url_host(a).or_else(|| positional_host(a)));
        }
        i += 1;
    }
    hosts
}

/// gh's options whose values are content (texts, fields, headers, output formats), not where
/// the command goes: long ones, short ones in any command, and short ones in `gh api`'s (where
/// `-f` is `--raw-field`; elsewhere it may be a flag without a value, such as `--force`).
const CONTENT_OPTIONS: &[&str] = &[
    "--body", "--body-file", "--title", "--field", "--raw-field", "--header", "--jq", "--template", "--input", "--notes", "--notes-file",
    "--subject", "--search", "--label", "--add-label", "--remove-label",
];
const CONTENT_SHORT: &str = "btqF";
const API_CONTENT_SHORT: &str = "fH";

/// How many arguments a content option at `arg` takes up (two when its value is the next one),
/// if it is one (see `CONTENT_OPTIONS`).
fn content_option(arg: &str, api: bool) -> Option<usize> {
    if let Some(long) = arg.strip_prefix("--") {
        let (name, value) = match long.split_once('=') {
            Some((name, _)) => (name, true),
            None => (long, false),
        };
        return CONTENT_OPTIONS.contains(&format!("--{name}").as_str()).then_some(if value { 1 } else { 2 });
    }
    let letter = arg.strip_prefix('-')?.chars().next()?;
    let short = CONTENT_SHORT.contains(letter) || (api && API_CONTENT_SHORT.contains(letter));
    short.then_some(if arg.chars().count() == 2 { 2 } else { 1 })
}

/// The host an argument of a gh command (or a push URL) names when it's a repository on a host
/// of its own: `HOST/OWNER/REPO[/…]` (a host has a `.` or a port in it, so `OWNER/REPO` and API
/// paths don't count), or `[USER@]HOST:PATH` as git has it. Without a user, the host needs a `.`,
/// so search qualifiers (`repo:o/r`, `is:open`) and SSH aliases (`github-work:o/r`, the host's
/// own way to pick an SSH identity) don't count.
fn positional_host(arg: &str) -> Option<String> {
    if arg.starts_with(['-', '.', '/', '~']) || arg.contains(char::is_whitespace) {
        return None;
    }
    if let Some((user_host, _)) = arg.split_once(':').filter(|(h, _)| !h.contains('/')) {
        let (user, host) = match user_host.rsplit_once('@') {
            Some((user, host)) => (Some(user), host),
            None => (None, user_host),
        };
        let hostname = !host.is_empty() && host.chars().all(|c| c.is_ascii_alphanumeric() || ".-".contains(c));
        return (hostname && (user.is_some() || host.contains('.'))).then(|| host.to_ascii_lowercase());
    }
    let parts: Vec<&str> = arg.split('/').collect();
    let host = parts[0];
    let hostname = host.chars().all(|c| c.is_ascii_alphanumeric() || ".-:".contains(c));
    (hostname && parts.len() >= 3 && parts[1..3].iter().all(|p| !p.is_empty()) && (host.contains('.') || host.contains(':')))
        .then(|| host.split(':').next().unwrap_or(host).to_ascii_lowercase())
}
