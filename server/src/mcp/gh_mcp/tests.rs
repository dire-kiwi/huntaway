use super::*;

fn args(tool: &str, a: Value) -> Vec<String> {
    command(tool, &a).unwrap().args
}

#[test]
fn every_tool_builds_and_read_only_ones_exist() {
    let names: Vec<String> = tools().as_array().unwrap().iter().map(|t| t["name"].as_str().unwrap().to_string()).collect();
    let mut listed: Vec<&str> = READ_ONLY.iter().chain(WRITES).copied().collect();
    listed.sort();
    let mut sorted = names.clone();
    sorted.sort();
    assert_eq!(listed, sorted, "every tool is in READ_ONLY or WRITES");
    for t in tools().as_array().unwrap() {
        let read_only = READ_ONLY.contains(&t["name"].as_str().unwrap());
        assert_eq!(t["annotations"]["readOnlyHint"], read_only, "{}", t["name"]);
    }
    let full = json!({"pr": "3", "repo": "o/r", "issue": "4", "body": "b", "title": "t", "run_id": "5", "endpoint": "user", "args": ["status"]});
    for n in &names {
        assert!(command(n, &full).is_ok(), "{n}");
    }
}

#[test]
fn builds_commands() {
    assert_eq!(args("pr_create", json!({})), ["pr", "create", "--fill"]);
    let create = command("pr_create", &json!({"title": "Fix it", "body": "- one\n", "base": "master", "draft": true, "repo": "o/r"})).unwrap();
    assert_eq!(create.args, ["pr", "create", "--title=Fix it", "--body=- one\n", "--base=master", "--draft"]);
    assert_eq!(create.repo.as_deref(), Some("o/r"));
    // gh api has no --repo: the repository goes in GH_REPO, as for every gh command.
    let api = command("api", &json!({"endpoint": "repos/{owner}/{repo}/pulls", "repo": "cli/cli"})).unwrap();
    assert_eq!((api.args, api.repo.as_deref()), (vec!["api".to_string(), "repos/{owner}/{repo}/pulls".into()], Some("cli/cli")));
    assert!(command("pr_create", &json!({"body": "x"})).is_err());
    // pr_merge always passes --repo (resolved by `run`), so gh leaves local branches alone.
    assert_eq!(
        args("pr_merge", json!({"pr": "12", "repo": "o/r", "delete_branch": true})),
        ["pr", "merge", "12", "--repo=o/r", "--merge", "--delete-branch"]
    );
    assert!(command("pr_merge", &json!({"pr": "12"})).is_err());
    assert!(command("pr_merge", &json!({"pr": "feature", "repo": "o/r"})).is_err());
    assert!(command("pr_edit", &json!({"pr": "1"})).is_err());
    assert_eq!(args("pr_edit", json!({"body": ""})), ["pr", "edit", "--body="]);
    assert_eq!(args("pr_edit", json!({"pr": "1", "title": "T"})), ["pr", "edit", "1", "--title=T"]);
    assert_eq!(command("pr_checks", &json!({})).unwrap().ok_codes, [0, 8]);
    assert_eq!(
        args("api", json!({"endpoint": "repos/{owner}/{repo}/issues", "fields": {"title": "@x"}, "paginate": true})),
        ["api", "repos/{owner}/{repo}/issues", "--raw-field", "title=@x", "--paginate"]
    );
    assert_eq!(args("api", json!({"endpoint": "graphql", "fields": {"n": 2}})), ["api", "graphql", "--field", "n=2"]);
    assert!(command("api", &json!({"endpoint": "x", "fields": {"a": [1]}})).is_err());
    assert!(command("run_view", &json!({"run_id": "1; rm"})).is_err());
    assert!(command("gh", &json!({"args": []})).is_err());
    // Nor what would show the account's token, or change what later gh commands run.
    for refused in [
        &["auth", "token"][..],
        &["auth", "status", "--show-token"],
        &["--help", "auth", "token"],
        &["extension", "install", "o/gh-x"],
        &["ext", "install", "o/gh-x"],
        &["alias", "set", "co", "!sh -c x"],
        &["config", "set", "editor", "x"],
        &["-R", "o/r", "auth", "token"],
        &["config", "get", "-h", "github.com", "oauth_token"],
        &["config", "get", "oauth_token", "--host=github.com"],
        &["config", "get", "-hgithub.com", "user"],
        &["config", "get", "oauth_token"],
        &["config", "--host=github.com", "get", "oauth_token"],
        &["config", "-hgithub.com", "get", "oauth_token"],
        &["config", "--host", "github.com", "get", "oauth_token"],
        &["config", "--help", "get", "-h", "github.com", "user"],
        &["alias", "--help", "set", "co", "!sh"],
    ] {
        let err = command("gh", &json!({"args": refused})).unwrap_err().to_string();
        assert!(err.contains("isn't available to agents") || err.contains("put gh's command first") || err.contains("put the subcommand"), "{refused:?}: {err}");
    }
    for allowed in [&["release", "list"][..], &["--version"], &["alias", "list"], &["config", "get", "editor"], &["issue", "create", "--title", "auth"]] {
        assert!(command("gh", &json!({"args": allowed})).is_ok(), "{allowed:?}");
    }
    let push = command("git_push", &json!({"repo": "ignored"})).unwrap();
    assert_eq!((push.program, push.args), ("git", vec!["push".to_string(), "-u".into(), "origin".into(), "HEAD".into()]));
    assert_eq!(command("git_push", &json!({"branch": "ia/x-1_fix.it"})).unwrap().args, ["push", "-u", "origin", "ia/x-1_fix.it"]);
    // A branch name, not a refspec that would push (or force-push) another ref.
    for bad in ["+HEAD:refs/heads/master", "HEAD:master", ":master", "-f", "a b", "a..b", "x^", "*", "+master", "a[b", "@", "a@{1}", "a/.b", "a.lock", "a/", "a.", "a//b", "a\tb"] {
        assert!(command("git_push", &json!({"branch": bad})).is_err(), "{bad:?}");
    }
    for good in ["feature/c++", "HEAD", "v1.2", "a@b", "x+"] {
        assert_eq!(command("git_push", &json!({"branch": good})).unwrap().args, ["push", "-u", "origin", good]);
    }
}

#[test]
fn reads_accounts() {
    let a = |s: &str| Account::parse(s).map(|a| (a.host, a.login));
    assert_eq!(a(" octocat "), Some(("github.com".into(), "octocat".into())));
    assert_eq!(a("GHE.example.com/me_corp"), Some(("ghe.example.com".into(), "me_corp".into())));
    assert_eq!(Account::parse("ghe.example.com/me").unwrap().to_string(), "ghe.example.com/me");
    assert_eq!(Account::parse("github.com/octocat").unwrap().to_string(), "octocat");
    for bad in ["", "-x", "a b", "a/b/c", "/x", "x/", "o;rm", "--user=x"] {
        assert_eq!(a(bad), None, "{bad}");
    }
    let status = json!({"hosts": {
        "github.com": [{"login": "me", "active": true, "state": "success"}, {"login": "work-me", "active": false, "state": "error"}],
        "ghe.example.com": [{"login": "me", "active": true, "state": "success"}]
    }});
    let list = accounts_from_status(&status);
    let names: Vec<(&str, bool, bool)> = list.iter().map(|a| (a["account"].as_str().unwrap(), a["active"] == true, a["ok"] == true)).collect();
    assert_eq!(names, [("ghe.example.com/me", true, true), ("me", true, true), ("work-me", false, false)]);
}

#[test]
fn gh_acts_as_the_account_and_no_other() {
    use std::os::unix::fs::PermissionsExt;
    for (account, host) in [("me", "github.com"), ("acme.ghe.com/me", "acme.ghe.com"), ("ghe.example.com/me", "ghe.example.com")] {
        let mut cmd = tokio::process::Command::new("gh");
        cmd.env("GH_TOKEN", "ambient").env("GITHUB_TOKEN", "ambient").env("GH_ENTERPRISE_TOKEN", "ambient").env("GH_HOST", "elsewhere").env("GH_REPO", "evil.example.com/o/r");
        let env = Account::parse(account).unwrap().env("tok_123").unwrap();
        env.apply(&mut cmd);
        // What the command's environment ends up as: None for a variable removed.
        let vars: std::collections::BTreeMap<String, Option<String>> =
            cmd.as_std().get_envs().map(|(k, v)| (k.to_string_lossy().into_owned(), v.map(|v| v.to_string_lossy().into_owned()))).collect();
        let get = |k: &str| vars.get(k).cloned().flatten();
        assert_eq!(get("GH_HOST").as_deref(), Some(host), "{account}");
        // No token in the environment, nor an inherited repository.
        for v in TOKEN_VARS.iter().chain(&["GH_REPO"]) {
            assert!(vars.contains_key(*v) && get(v).is_none(), "{account} {v}");
        }
        if cfg!(target_os = "linux") {
            // Nor the keyring's logins.
            assert_eq!(get("DBUS_SESSION_BUS_ADDRESS").as_deref(), Some("disabled:"));
        }
        // A login for the account's host only, readable by this user only.
        let dir = std::path::PathBuf::from(get("GH_CONFIG_DIR").unwrap());
        let hosts = std::fs::read_to_string(dir.join("hosts.yml")).unwrap();
        assert!(hosts.starts_with(&format!("\"{host}\":\n")) && hosts.matches("tok_123").count() == 2 && hosts.lines().filter(|l| !l.starts_with(' ')).count() == 1, "{hosts}");
        assert_eq!(std::fs::metadata(&dir).unwrap().permissions().mode() & 0o777, 0o700);
        assert_eq!(std::fs::metadata(dir.join("hosts.yml")).unwrap().permissions().mode() & 0o777, 0o600);
        drop(env);
        assert!(!dir.exists(), "{account}");
    }
}

#[test]
fn gh_sends_the_token_to_the_accounts_host_only() {
    crate::testing::run(async || {
        // Where real gh sends requests, and with what Authorization header (gh's debug output
        // shows whether there's a token). `.invalid` names never resolve, so nothing leaves.
        let requests = async |args: &[&str]| -> Option<Vec<(String, bool)>> {
            let env = Account::parse("ghe.invalid/me").unwrap().env("tok_123").unwrap();
            let mut cmd = tokio::process::Command::new("gh");
            cmd.args(args).env("GH_DEBUG", "api").env("GH_PROMPT_DISABLED", "1").current_dir(&env.dir).stdin(Stdio::null());
            env.apply(&mut cmd);
            let out = tokio::time::timeout(Duration::from_secs(20), cmd.output()).await.ok()?.ok()?;
            let log = String::from_utf8_lossy(&out.stderr).into_owned();
            let mut found = Vec::new();
            for (i, line) in log.lines().enumerate() {
                if let Some(url) = line.strip_prefix("* Request to ") {
                    let token = log.lines().skip(i + 1).take_while(|l| !l.starts_with("* ")).any(|l| l.starts_with("> Authorization: token"));
                    found.push((url_host(url).unwrap_or_default(), token));
                }
            }
            Some(found)
        };
        // Without gh, there's nothing to check.
        let Some(own) = requests(&["api", "user"]).await else { return };
        assert_eq!(own, [("ghe.invalid".to_string(), true)]);
        for args in [&["api", "https://evil.invalid/user"][..], &["repo", "clone", "evil.invalid:o/r"], &["repo", "view", "evil.invalid/o/r"], &["api", "--hostname", "evil.invalid", "user"]] {
            let sent = requests(args).await.unwrap();
            assert!(!sent.is_empty() && sent.iter().all(|(host, token)| host == "evil.invalid" && !token), "{args:?}: {sent:?}");
        }
    })
}

/// Parts of gh 2.102's help for some of its commands.
const HELP: &[(&str, &str)] = &[
    ("pr view", r#"USAGE
  gh pr view [<number> | <url> | <branch>] [flags]

FLAGS
  -c, --comments          View pull request comments
  -q, --jq expression     Filter JSON output using a jq expression
      --json fields       Output JSON with the specified fields
  -w, --web               Open a pull request in the browser

INHERITED FLAGS
  -R, --repo [HOST/]OWNER/REPO   Select another repository using the [HOST/]OWNER/REPO format
"#),
    ("issue comment", r#"USAGE
  gh issue comment {<number> | <url>} [flags]

FLAGS
  -b, --body text        The comment body text
  -F, --body-file file   Read body text from file
  -e, --editor           Skip prompts and open the text editor to write the body in

INHERITED FLAGS
  -R, --repo [HOST/]OWNER/REPO   Select another repository using the [HOST/]OWNER/REPO format
"#),
    ("issue transfer", r#"USAGE
  gh issue transfer {<number> | <url>} <destination-repo> [flags]

INHERITED FLAGS
  -R, --repo [HOST/]OWNER/REPO   Select another repository using the [HOST/]OWNER/REPO format
"#),
    ("repo edit", r#"USAGE
  gh repo edit [<repository>] [flags]

FLAGS
      --add-topic strings                        Add repository topic
  -d, --description string                       Description of the repository
      --enable-wiki                              Enable wiki in the repository
  -h, --homepage URL                             Repository home page URL
      --template                                 Make the repository available as a template repository
"#),
    ("search code", r#"USAGE
  gh search code <query> [flags]

FLAGS
  -q, --jq expression      Filter JSON output using a jq expression
  -R, --repo OWNER/REPO    Filter on repository, in OWNER/REPO format
  -w, --web                Open the search query in the web browser
"#),
    ("api", r#"USAGE
  gh api <endpoint> [flags]

FLAGS
  -F, --field key=value          Add a typed parameter in key=value format
  -H, --header key:value         Add a HTTP request header in key:value format
      --hostname string          The GitHub hostname for the request (default "github.com")
  -i, --include                  Include HTTP response status line and headers in the output
  -X, --method string            The HTTP method for the request (default "GET")
      --paginate                 Make additional HTTP requests to fetch all pages of results
  -f, --raw-field key=value      Add a string parameter in key=value format
"#),
    ("repo clone", r#"USAGE
  gh repo clone <repository> [<directory>] [-- <gitflags>...]

FLAGS
  -u, --upstream-remote-name string   Upstream remote name when cloning a fork (default "upstream")
"#),
    ("repo sync", r#"USAGE
  gh repo sync [<destination-repository>] [flags]

FLAGS
  -b, --branch string   Branch to sync (default [default branch])
      --force           Hard reset the branch of the destination repository to match the source repository
  -s, --source string   Source repository
"#),
    ("release upload", r#"USAGE
  gh release upload <tag> <files>... [flags]

FLAGS
      --clobber   Delete and re-upload existing assets of the same name
"#),
];

#[test]
fn reads_gh_help() {
    let help = |command: &str| CommandHelp::parse(HELP.iter().find(|(c, _)| *c == command).unwrap().1).unwrap();
    let pr_view = help("pr view");
    assert_eq!((pr_view.path, pr_view.arguments.as_slice()), (2, &["[<number> | <url> | <branch>]".to_string()][..]));
    assert!(pr_view.options.contains(&(Some('q'), "--jq".into(), true)) && pr_view.options.contains(&(Some('c'), "--comments".into(), false)));
    assert!(pr_view.options.contains(&(Some('R'), "--repo".into(), true)) && pr_view.options.contains(&(None, "--json".into(), true)));
    assert_eq!(help("repo clone").arguments, ["<repository>", "[<directory>]"]);
    assert_eq!(help("release upload").arguments, ["<tag>", "<files>..."]);
    assert_eq!((help("api").path, help("api").arguments.as_slice()), (1, &["<endpoint>".to_string()][..]));
    assert_eq!(CommandHelp::parse("no usage here"), None);
}

#[test]
fn gh_checks_where_a_command_goes_and_not_what_it_says() {
    let check = |account: &str, args: &[&str], repo: Option<&str>| {
        let help = HELP.iter().find(|(c, _)| args.join(" ").starts_with(c)).and_then(|(_, h)| CommandHelp::parse(h)).unwrap();
        Account::parse(account).unwrap().check_targets_with(args, repo, Some(&help)).is_ok()
    };
    let ghe = "ghe.example.com/me";
    // A repository's homepage and description, search queries, comments, fields and headers.
    for args in [
        &["repo", "edit", "o/r", "--homepage", "https://example.com"][..],
        &["repo", "edit", "o/r", "-h", "https://example.com", "-d", "Mirror of https://example.com/a/b"],
        &["repo", "edit", "--description=see example.com/a/b", "ghe.example.com/o/r"],
        &["search", "code", "https://example.com", "--repo", "o/r"],
        &["search", "code", "example.com/a/b", "evil.example.com:o/r"],
        &["issue", "comment", "1", "--repo", "o/r", "--body", "https://example.com"],
        &["issue", "comment", "-b", "github.com/o/r", "https://ghe.example.com/o/r/issues/1"],
        &["api", "repos/o/r/issues", "--raw-field", "title=CI failure", "-f", "body=.github/workflows/test.yml"],
        &["api", "-H", "Referer: https://example.com", "-F", "url=https://example.com", "repos/o/r/hooks"],
        &["api", "evil.example.com/o/r"],
        &["pr", "view", "--json", "url", "https://ghe.example.com/o/r/pull/1"],
        &["repo", "clone", "ghe.example.com/o/r", "build.d/a/b", "--", "--depth", "https://example.com/x/y"],
        &["release", "upload", "v1", "dist.d/o/r", "https://example.com"],
    ] {
        assert!(check(ghe, args, None), "{args:?}");
    }
    // Where the command goes: its endpoint, pull request, issue or repository, and target options.
    for args in [
        &["repo", "edit", "github.com/o/r", "--homepage", "https://ghe.example.com"][..],
        &["repo", "edit", "--enable-wiki", "https://github.com/o/r"],
        &["repo", "edit", "--template", "github.com/o/r"],
        &["search", "code", "x", "--repo", "github.com/o/r"],
        &["issue", "comment", "--body", "hi", "https://github.com/o/r/issues/1"],
        &["issue", "comment", "-e", "https://github.com/o/r/issues/1"],
        &["issue", "comment", "1", "-Rgithub.com/o/r"],
        &["issue", "transfer", "1", "github.com/o/r"],
        &["issue", "transfer", "1", "git@github.com:o/r.git"],
        &["api", "-f", "x=1", "https://evil.example.com/user"],
        &["api", "--hostname=github.com", "user"],
        &["api", "--paginate", "https://api.github.com/user"],
        &["pr", "view", "-c", "https://github.com/o/r/pull/1"],
        &["pr", "view", "--web", "--", "https://github.com/o/r/pull/1"],
        &["repo", "clone", "evil.example.com:o/r"],
        &["repo", "sync", "--force", "github.com/o/r"],
        &["repo", "sync", "-s", "github.com/o/r"],
        &["repo", "sync", "--source=https://github.com/o/r"],
    ] {
        assert!(!check(ghe, args, None), "{args:?}");
    }
    assert!(!check(ghe, &["pr", "view", "1"], Some("github.com/o/r")));
    assert!(check("me", &["api", "https://gist.github.com/x", "-f", "a=https://ghe.example.com"], None));
}

#[test]
fn gh_reads_its_own_help_for_the_check() {
    // With gh's real help, where there's a gh.
    if std::process::Command::new(gh_program()).arg("--version").output().is_err() {
        return;
    }
    let account = Account::parse("me").unwrap();
    for args in [&["repo", "edit", "o/r", "--homepage", "https://example.com"][..], &["search", "code", "https://example.com", "--repo", "o/r"]] {
        account.check_targets(args, None).unwrap();
    }
    assert!(account.check_targets(&["pr", "view", "https://evil.example.com/o/r/pull/1"], None).is_err());
    assert!(account.check_targets(&["repo", "edit", "evil.example.com/o/r", "--homepage", "https://github.com"], None).is_err());
}

#[test]
fn gh_only_reaches_the_accounts_host() {
    let check = |account: &str, args: &[&str], repo: Option<&str>| {
        // Without gh's help, as when there's no gh (see gh_checks_where_a_command_goes_and_not_what_it_says).
        Account::parse(account).unwrap().check_targets_with(args, repo, None).is_ok()
    };
    let ghe = "ghe.example.com/me";
    assert!(check(ghe, &["api", "user"], Some("o/r")));
    assert!(check(ghe, &["api", "https://ghe.example.com/api/v3/user"], None));
    assert!(check(ghe, &["pr", "view", "https://ghe.example.com/o/r/pull/3"], Some("ghe.example.com/o/r")));
    // Another host's login (from the keyring), or this token sent to another host.
    assert!(!check(ghe, &["api", "https://api.github.com/user"], None));
    assert!(!check(ghe, &["api", "https://evil.example.com/user"], None));
    assert!(!check(ghe, &["api", "HTTPS://user@Evil.example.com:443/x"], None));
    assert!(!check(ghe, &["api", "--hostname", "github.com", "user"], None));
    assert!(!check(ghe, &["api", "--hostname=github.com", "user"], None));
    assert!(!check(ghe, &["pr", "list", "-R", "github.com/o/r"], None));
    assert!(!check(ghe, &["pr", "list", "-Rgithub.com/o/r"], None));
    assert!(!check(ghe, &["pr", "list", "--repo=github.com/o/r"], None));
    assert!(!check(ghe, &["pr", "view", "1"], Some("github.com/o/r")));
    assert!(!check(ghe, &["pr", "view", "https://github.com/o/r/pull/3"], None));
    // github.com accounts reach github.com and its API; text that isn't a target is left alone.
    assert!(check("me", &["api", "https://api.github.com/user", "--raw-field", "body=see https://evil.example.com"], Some("o/r")));
    assert!(check("me", &["pr", "list", "-R", "o/r"], None));
    assert!(!check("me", &["api", "https://api.acme.ghe.com/user"], None));
    assert!(check("acme.ghe.com/me", &["api", "https://api.acme.ghe.com/user"], None));
    // Repositories as arguments of their own (gh repo view, clone, fork, extension install, …).
    assert!(!check(ghe, &["repo", "view", "evil.example.com/o/r", "--json", "name"], None));
    assert!(!check(ghe, &["repo", "clone", "github.com/o/r"], None));
    assert!(!check(ghe, &["repo", "clone", "git@github.com:o/r.git"], None));
    assert!(!check(ghe, &["extension", "install", "evil.example.com:8443/o/gh-x"], None));
    assert!(!check(ghe, &["repo", "clone", "evil.invalid:o/r"], None));
    assert!(check(ghe, &["search", "issues", "repo:o/r", "is:open", "author:me"], None));
    assert!(check(ghe, &["api", "graphql", "-f", "query=query { repository(owner: \"o\") { id } }", "-f", "q=repo:o/r"], None));
    assert!(check(ghe, &["repo", "clone", "ghe.example.com:o/r"], None));
    assert!(check(ghe, &["repo", "view", "o/r", "--json", "name,url"], None));
    assert!(check(ghe, &["repo", "view", "o/r"], None));
    // What issues, comments and fields say isn't where they go.
    assert!(check(ghe, &["api", "repos/o/r/issues", "--raw-field", "title=CI failure", "--raw-field", "body=.github/workflows/test.yml"], None));
    assert!(check(ghe, &["issue", "comment", "1", "--repo", "o/r", "--body", "https://example.com"], None));
    assert!(check(ghe, &["issue", "create", "-t", "github.com/o/r is down", "-b", "see https://github.com/o/r", "--label=github.com/x/y"], None));
    assert!(check(ghe, &["api", "-f", "url=https://example.com", "-H", "Referer: https://example.com", "repos/o/r/hooks", "-q", ".url"], None));
    assert!(check(ghe, &["pr", "create", "--body=https://example.com", "-bhttps://example.com", "--title", "evil.example.com/o/r"], None));
    assert!(check(ghe, &["api", "repos/o/r/contents/x", "--field", "path=docs.d/a/b"], None));
    // But the destination is still checked after them.
    assert!(!check(ghe, &["api", "-f", "x=1", "https://evil.example.com/user"], None));
    assert!(!check(ghe, &["issue", "comment", "--body", "hi", "https://github.com/o/r/issues/1"], None));
    assert!(!check(ghe, &["issue", "comment", "1", "--body=hi", "--repo", "github.com/o/r"], None));
    assert!(!check(ghe, &["repo", "sync", "-f", "github.com/o/r"], None));
    assert!(check(ghe, &["repo", "clone", "ghe.example.com/o/r", "./dir/a.b/c"], None));
    assert!(check(ghe, &["api", "repos/o/r/contents/docs.d/a/b"], None));
    // Pushes: remotes on the account's host, over HTTPS or SSH (the host's SSH keys).
    assert!(check("me", &["https://github.com/o/r.git"], None));
    assert!(check("me", &["git@github.com:o/r.git"], None));
    assert!(check("me", &["ssh://git@github.com/o/r.git"], None));
    assert!(check("me", &["../local/repo.git"], None));
    assert!(!check("me", &["https://gitlab.com/o/r.git"], None));
    assert!(!check("me", &["git@gitlab.com:o/r.git"], None));
    assert!(!check("me", &["ssh://git@gitlab.com/o/r.git"], None));
    assert!(!check("me", &["gitlab.com:o/r.git"], None));
    assert!(check("me", &["github.com:o/r.git"], None));
    assert!(check("me", &["github-work:o/r.git"], None));
}

#[test]
fn a_waits_shell_gets_gh_through_gh_run_and_no_token() {
    let shim_dir = crate::testing::temp_dir().join("shim");
    let env = Account::parse("ghe.example.com/me").unwrap().env("tok").unwrap();
    let vars = match env.shell_env(std::path::Path::new("/opt/it's/huntaway"), &shim_dir) {
        Ok(vars) => vars,
        // Without gh there's nothing to put in front of it.
        Err(e) => return assert!(format!("{e:#}").contains("gh isn't installed"), "{e:#}"),
    };
    let get = |k: &str| vars.iter().find(|(n, _)| *n == k).map(|(_, v)| v.clone());
    assert!(get("PATH").unwrap().starts_with(&format!("{}:", shim_dir.display())));
    assert_eq!(get(ACCOUNT_ENV).as_deref(), Some("ghe.example.com/me"));
    let real = get("IA_GH_BIN").unwrap();
    assert!(!real.starts_with(&crate::util::path_str(&shim_dir)) && real.ends_with("/gh"), "{real}");
    // The token stays with gh-run.
    assert!(vars.iter().all(|(k, v)| !TOKEN_VARS.contains(k) && v != "tok"));
    let shim = std::fs::read_to_string(shim_dir.join("gh")).unwrap();
    assert_eq!(shim, "#!/bin/sh\nexec '/opt/it'\\''s/huntaway' gh-run \"$@\"\n");
    assert_eq!(std::os::unix::fs::PermissionsExt::mode(&std::fs::metadata(shim_dir.join("gh")).unwrap().permissions()) & 0o777, 0o755);
    std::fs::remove_dir_all(&shim_dir).ok();
}

#[test]
fn pushes_are_checked_at_every_url_git_would_push_to() {
    crate::testing::run(async || {
        let dir = crate::testing::temp_dir();
        let git = |args: &[&str]| {
            let ok = std::process::Command::new("git").args(args).current_dir(&dir).env("GIT_CONFIG_NOSYSTEM", "1").status().unwrap().success();
            assert!(ok, "git {args:?}");
        };
        git(&["init", "-q"]);
        git(&["remote", "add", "origin", "https://github.com/o/r.git"]);
        git(&["remote", "add", "two", "git@github.com:o/r.git"]);
        git(&["config", "--add", "remote.two.pushurl", "git@github.com:o/r.git"]);
        git(&["config", "--add", "remote.two.pushurl", "https://evil.example.com/o/r.git"]);
        git(&["remote", "add", "rewritten", "https://ghe.example.com/o/r.git"]);
        git(&["config", "url.https://evil.example.com/.pushInsteadOf", "https://ghe.example.com/"]);
        // Logins in a URL, which git would use instead of the account's token.
        git(&["remote", "add", "login", "https://other:other-token@github.com/o/r.git"]);
        git(&["remote", "add", "user", "https://other@github.com/o/r.git"]);
        git(&["remote", "add", "ssh-user", "ssh://git@github.com/o/r.git"]);
        let me = Account::parse("me").unwrap();
        let checked = async |remote: &str| match push_urls(Some(&dir), remote).await {
            Some(urls) => me.check_git_urls(&urls).map_err(|e| e.to_string()),
            None => Err("no remote".into()),
        };
        assert_eq!(checked("origin").await, Ok(()));
        // Every push URL, and as git rewrites it.
        assert!(checked("two").await.unwrap_err().contains("not evil.example.com"));
        assert!(checked("rewritten").await.unwrap_err().contains("not evil.example.com"));
        assert!(checked("login").await.unwrap_err().contains("has a login in it"));
        assert!(checked("user").await.unwrap_err().contains("has a login in it"));
        assert_eq!(checked("ssh-user").await, Ok(()));
        // A URL isn't a remote's name: git would rewrite it too.
        assert_eq!(checked("https://github.com/o/r.git").await, Err("no remote".into()));
        assert_eq!(checked("--all").await, Err("no remote".into()));
        std::fs::remove_dir_all(&dir).ok();
    })
}

#[test]
fn pushes_send_no_configured_authorization_header() {
    crate::testing::run(async || {
        // A server that records the Authorization headers git sends, and asks for a login.
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
        let recorded = seen.clone();
        let server = tokio::spawn(async move {
            use tokio::io::AsyncReadExt;
            while let Ok((mut conn, _)) = listener.accept().await {
                let mut request = Vec::new();
                let mut buf = [0u8; 4096];
                while !request.windows(4).any(|w| w == b"\r\n\r\n") {
                    match conn.read(&mut buf).await {
                        Ok(0) | Err(_) => break,
                        Ok(n) => request.extend_from_slice(&buf[..n]),
                    }
                }
                let text = String::from_utf8_lossy(&request).to_string();
                let found: Vec<String> = text.lines().filter(|l| l.to_ascii_lowercase().starts_with("authorization:")).map(String::from).collect();
                recorded.lock().unwrap().extend(found);
                let reply = "HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm=\"x\"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
                let _ = conn.write_all(reply.as_bytes()).await;
            }
        });
        let dir = crate::testing::temp_dir();
        let url = format!("http://127.0.0.1:{port}/o/r.git");
        let other = "Authorization: Basic b3RoZXI6b3RoZXItdG9rZW4="; // other:other-token
        let git = |args: &[&str]| std::process::Command::new("git").args(args).current_dir(&dir).status().unwrap();
        git(&["init", "-q"]);
        // Set for every URL, for the server, and for the repository's path.
        for key in ["http.extraHeader".to_string(), format!("http.http://127.0.0.1:{port}/.extraHeader"), format!("http.{url}.extraHeader")] {
            git(&["config", &key, other]);
        }
        let send = async |resets: &[String]| {
            seen.lock().unwrap().clear();
            let mut c = tokio::process::Command::new("git");
            c.args(resets).args(["-c", "credential.helper=", "ls-remote", &url]).current_dir(&dir);
            c.env("GIT_TERMINAL_PROMPT", "0").env("GIT_ASKPASS", "/bin/false").stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
            let _ = tokio::time::timeout(Duration::from_secs(20), c.status()).await;
            seen.lock().unwrap().clone()
        };
        // The test sees configured headers...
        assert!(send(&[]).await.iter().any(|h| h.contains("b3RoZXI6")));
        // ...and git_push's resets leave none.
        let resets = extra_header_resets(Some(&dir)).await;
        let sent = send(&resets).await;
        assert!(sent.iter().all(|h| !h.contains("b3RoZXI6")), "{sent:?} with {resets:?}");
        server.abort();
        std::fs::remove_dir_all(&dir).ok();
    })
}

#[test]
fn fetches_use_only_the_selected_accounts_https_credentials() {
    crate::testing::run(async || {
        use std::os::unix::fs::PermissionsExt;
        let dir = crate::testing::temp_dir();
        let gh = dir.join("gh");
        std::fs::write(&gh, "#!/bin/sh\n[ \"$*\" = 'auth token --hostname=ghe.example.com --user=chosen' ] || exit 1\nprintf test-token\n").unwrap();
        std::fs::set_permissions(&gh, std::fs::Permissions::from_mode(0o755)).unwrap();
        TEST_GH_PROGRAM.set(Some(crate::util::path_str(&gh)));
        let git = |args: &[&str]| {
            assert!(std::process::Command::new("git").args(args).current_dir(&dir).status().unwrap().success());
        };
        git(&["init", "-q"]);
        git(&["remote", "add", "origin", "https://alias/o/r.git"]);
        git(&["config", "url.https://ghe.example.com/.insteadOf", "https://alias/"]);
        git(&["config", "credential.helper", "!f() { echo username=wrong; echo password=wrong; }; f"]);
        git(&["config", "http.extraHeader", "Authorization: wrong"]);
        let mut cmd = tokio::process::Command::new("git");
        cmd.current_dir(&dir);
        authenticate_fetch(&mut cmd, &dir, "origin", Some("ghe.example.com/chosen")).await.unwrap();
        assert!(cmd.as_std().get_args().any(|a| a == "http.extraheader="));
        cmd.args(["credential", "fill"]).stdin(Stdio::piped()).stdout(Stdio::piped());
        let mut child = cmd.spawn().unwrap();
        child.stdin.take().unwrap().write_all(b"protocol=https\nhost=ghe.example.com\n\n").await.unwrap();
        let out = child.wait_with_output().await.unwrap();
        assert!(out.status.success());
        let credentials = String::from_utf8(out.stdout).unwrap();
        assert!(credentials.contains("username=x-access-token\npassword=test-token"), "{credentials}");
        // No account selected leaves git's own authentication alone.
        let mut cmd = tokio::process::Command::new("git");
        authenticate_fetch(&mut cmd, &dir, "origin", None).await.unwrap();
        assert_eq!(cmd.as_std().get_args().count(), 0);
        // A missing login is an error, never the active account or the configured helper.
        let mut cmd = tokio::process::Command::new("git");
        assert!(authenticate_fetch(&mut cmd, &dir, "origin", Some("ghe.example.com/missing")).await.is_err());
        // SSH, local remotes and unrelated HTTPS hosts don't need gh at all.
        for url in ["git@github-work:o/r.git", "/tmp/local.git", "https://elsewhere.example/o/r.git"] {
            git(&["remote", "set-url", "origin", url]);
            let mut cmd = tokio::process::Command::new("git");
            authenticate_fetch(&mut cmd, &dir, "origin", Some("ghe.example.com/missing")).await.unwrap();
            assert_eq!(cmd.as_std().get_args().count(), 0);
            assert_eq!(cmd.as_std().get_envs().count(), 0);
        }
        TEST_GH_PROGRAM.set(None);
        std::fs::remove_dir_all(&dir).ok();
    })
}

#[test]
fn pushes_with_the_accounts_token_over_https() {
    crate::testing::run(async || {
        // What credentials git would use: only ours for the account's host, whatever helper
        // the user has (here a global one, as `gh auth setup-git` adds), and theirs elsewhere.
        let home = crate::testing::temp_dir();
        let fill = async |host: &str, extra: &[String]| {
            let mut c = tokio::process::Command::new("git");
            c.env("HOME", &home).env("XDG_CONFIG_HOME", &home).env("GIT_CONFIG_NOSYSTEM", "1").env("IA_GH_GIT_TOKEN", "tok123");
            c.args(["-c", "credential.helper=!f() { echo username=theirs; echo password=other; }; f"]).args(extra);
            c.args(["credential", "fill"]).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
            let mut child = c.spawn().unwrap();
            child.stdin.take().unwrap().write_all(format!("protocol=https\nhost={host}\n\n").as_bytes()).await.unwrap();
            String::from_utf8(child.wait_with_output().await.unwrap().stdout).unwrap()
        };
        let config = Account::parse("octocat").unwrap().git_config();
        let ours = fill("github.com", &config).await;
        assert!(ours.contains("username=x-access-token\n") && ours.contains("password=tok123\n"), "{ours}");
        assert!(fill("gitlab.com", &config).await.contains("password=other\n"));
        std::fs::remove_dir_all(&home).ok();
    })
}

#[test]
fn the_hook_turns_away_gh_in_bash() {
    let call = |tool: &str, command: &str| hook_denial(&json!({"tool_name": tool, "tool_input": {"command": command}}));
    for c in ["gh pr view 3", "cd /x && gh pr create --fill", "GH_TOKEN=x /usr/bin/gh api user", "echo $(gh pr list)", "timeout 60 gh run watch", "bash -c 'gh pr checks'",
        "env -u; gh api user", "$'g\\x68' api user", "builtin command gh api user", "eval 'gh api user'"] {
        assert!(call("Bash", c).is_some_and(|r| r.contains("mcp__gh__pr_view")), "{c}");
    }
    for c in ["git push -u origin x", "grep -r gh src", "echo gh", "ls ~/.config/gh", "cargo test gh_mcp"] {
        assert_eq!(call("Bash", c), None, "{c}");
    }
    assert_eq!(call("Read", "gh pr view"), None);
    assert_eq!(hook_denial(&json!({})), None);
}

// HA-86: a merge waiting for approval could go through the gh tool or the API instead.
#[test]
fn knows_which_calls_merge() {
    let gh = |args: &[&str]| merges("gh", &json!({"args": args}));
    assert!(merges("pr_merge", &json!({"pr": "1"})));
    assert!(gh(&["pr", "merge", "1", "--squash"]) && gh(&["--help", "pr", "merge"]));
    // With flags between the command and its subcommand.
    assert!(gh(&["pr", "--repo=o/r", "merge", "1", "--merge"]) && gh(&["pr", "-R", "o/r", "merge", "1"]));
    assert!(gh(&["api", "--method", "PUT", "repos/o/r/pulls/1/merge"]));
    assert!(gh(&["api", "-X", "PUT", "repos/o/r/pulls/1/merge"]));
    assert!(gh(&["api", "graphql", "-f", "query=mutation { mergePullRequest(input: {}) { clientMutationId } }"]));
    assert!(merges("api", &json!({"endpoint": "repos/o/r/pulls/1/merge", "method": "PUT"})));
    assert!(merges("api", &json!({"endpoint": "graphql", "fields": {"query": "mutation { enablePullRequestAutoMerge(input: {}) { clientMutationId } }"}})));
    // A request read from a file could be anything (HA-86 review).
    assert!(gh(&["api", "graphql", "--method", "POST", "--input", "/x/payload.json"]) && gh(&["api", "graphql", "--input=/x/p.json"]));
    assert!(gh(&["api", "graphql", "-F", "query=@/x/query.graphql"]) && gh(&["api", "graphql", "--field=query=@q"]));
    // As could one that mentions merging, so it waits too, even if it only reads.
    assert!(merges("api", &json!({"endpoint": "repos/o/r/pulls/1/merge"})));
    // Anything else doesn't.
    assert!(!gh(&["api", "repos/o/r/pulls/1"]) && !gh(&["api", "graphql", "-f", "query={ viewer { login } }", "-F", "n=1"]));
    assert!(!merges("api", &json!({"endpoint": "repos/o/r/issues", "fields": {"body": "@someone"}})));
    assert!(!gh(&["pr", "view", "1"]) && !merges("pr_view", &json!({"pr": "1"})) && !merges("pr_checks", &json!({"pr": "merge"})));
}

// HA-86 review: `pr --repo=o/r merge` got past the check and merged while approval was pending.
#[test]
fn a_merge_the_board_hasnt_approved_never_runs_gh() {
    crate::testing::run(async || {
        use std::os::unix::fs::PermissionsExt;
        let dir = crate::testing::temp_dir();
        let (gh, ran) = (dir.join("gh"), dir.join("ran"));
        std::fs::write(&gh, format!("#!/bin/sh\necho \"$*\" >> '{}'\n", ran.display())).unwrap();
        std::fs::set_permissions(&gh, std::fs::Permissions::from_mode(0o755)).unwrap();
        TEST_GH_PROGRAM.set(Some(crate::util::path_str(&gh)));
        let board = axum::Router::new()
            .route("/api/internal/merge-gate/{run}", axum::routing::get(|| async { axum::Json(json!({"blocked": "Merging is disabled: not approved"})) }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, board).await });
        TEST_BOARD.set(Some([url, "t".into(), "r".into()]));
        let calls = [
            ("gh", json!({"args": ["pr", "--repo=o/r", "merge", "1", "--merge"]})),
            ("gh", json!({"args": ["pr", "-R", "o/r", "merge", "1"]})),
            ("gh", json!({"args": ["pr", "merge", "1", "--repo", "o/r"]})),
            ("api", json!({"endpoint": "repos/o/r/pulls/1/merge", "method": "PUT"})),
            ("gh", json!({"args": ["api", "graphql", "--method", "POST", "--input", "/x/payload.json"]})),
            ("gh", json!({"args": ["api", "graphql", "-F", "query=@/x/query.graphql"]})),
            ("pr_merge", json!({"pr": "https://github.com/o/r/pull/1"})),
        ];
        for (tool, a) in calls {
            let (text, failed) = run(tool, &a).await.unwrap();
            assert!(failed && text.contains("not approved"), "{tool} {a}: {text}");
        }
        assert!(!ran.exists(), "gh ran: {}", std::fs::read_to_string(&ran).unwrap_or_default());
        // What doesn't merge runs.
        assert!(!run("gh", &json!({"args": ["pr", "view", "1", "--repo", "o/r"]})).await.unwrap().1);
        assert!(ran.exists());
        TEST_BOARD.set(None);
        TEST_GH_PROGRAM.set(None);
        server.abort();
        std::fs::remove_dir_all(&dir).ok();
    })
}

#[test]
fn reads_pr_urls() {
    assert_eq!(pr_from_url("https://github.com/o/r/pull/12\n"), Some(("12".into(), "o/r".into())));
    assert_eq!(pr_from_url("https://ghe.example.com/o/r/pull/3"), Some(("3".into(), "ghe.example.com/o/r".into())));
    assert_eq!(pr_from_url("https://github.com/o/r/issues/3"), None);
    assert_eq!(pr_from_url("no pull request"), None);
}

#[test]
fn clips_long_output() {
    assert_eq!(clip("short"), "short");
    let long = "é".repeat(MAX_OUTPUT);
    let c = clip(&long);
    assert!(c.len() < long.len() && c.contains("bytes cut"));
}

#[test]
fn runs_gh_and_reports_failures() {
    crate::testing::run(async || {
        // An unknown command fails without touching GitHub (if gh is installed at all).
        if let Ok((text, failed)) = run("gh", &json!({"args": ["no-such-command"]})).await {
            assert!(failed, "{text}");
        }
        let resp = handle(json!({"jsonrpc": "2.0", "id": 1, "method": "tools/list"})).await.unwrap();
        assert!(resp["result"]["tools"].as_array().unwrap().len() > 10);
        assert!(handle(json!({"jsonrpc": "2.0", "method": "notifications/initialized"})).await.is_none());
    })
}
