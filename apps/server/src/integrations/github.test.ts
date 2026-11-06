// Port of the tests in server/src/integrations/github.rs.
import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as worktree from "../git/worktree.ts";
import * as testing from "../testing.ts";
import { check_name, check_repo, clone, create, folder, gh_error, graphql_repo, is_clone_of, latest_first, repo, search_query } from "./github.ts";
import { fake_gh_create, fake_github } from "./github/tests.ts";

const rejects_with = async (p: Promise<any>, what: string) => {
  let err = "";
  await assert.rejects(p, (e: any) => {
    err = e.message;
    return true;
  });
  assert.ok(err.includes(what), err);
  return err;
};

test("a_clone_that_fails_is_taken_away_but_gh_failing_after_a_whole_one_keeps_it", async () => {
  const github = fake_github();
  const gh = join(github, "gh");
  const dest = (name: string) => join(github, "clones", name);
  assert.equal(await clone(gh, null, "o/r", dest("r")), true);
  assert.equal(readFileSync(join(dest("r"), "README"), "utf8"), "r");
  // A clone that's there already is taken as it is, without cloning.
  assert.equal(await clone("/bin/false", null, "o/r", dest("r")), false);

  // Git keeps a clone whose checkout failed, which isn't whole: it goes, from a new
  // folder or an empty one, so asking again doesn't find it.
  await rejects_with(clone(gh, null, "o/checkout-fails", dest("checkout")), "checkout failed");
  assert.ok(!existsSync(dest("checkout")));
  mkdirSync(dest("empty"), { recursive: true });
  await assert.rejects(clone(gh, null, "o/checkout-fails", dest("empty")));
  assert.equal(readdirSync(dest("empty")).length, 0, "the empty folder stays, empty");
  await rejects_with(clone(gh, null, "o/checkout-fails", dest("checkout")), "checkout failed");

  // gh failing once the clone is whole (a fork's parent it couldn't fetch) leaves it.
  assert.equal(await clone(gh, null, "o/upstream-fails", dest("upstream")), true);
  assert.equal(readFileSync(join(dest("upstream"), "README"), "utf8"), "upstream-fails");
  // And nothing's taken away when gh can't clone it at all.
  await assert.rejects(clone(gh, null, "o/missing", dest("missing")));
  await rejects_with(clone("/nonexistent/gh", null, "o/r", dest("no-gh")), "isn't installed");
});

test("creates_a_repository_for_a_folder", async () => {
  const fake = fake_gh_create();
  const gh = join(fake, "gh");
  const log = () => {
    try {
      return readFileSync(join(fake, "create.log"), "utf8");
    } catch {
      return "";
    }
  };
  const git = (dir: string, args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-C", dir, ...args], { stdio: "ignore" });

  // A folder that isn't there: made a git repository, with the repository private and no push (nothing to push).
  const fresh = join(fake, "projects/new");
  assert.deepEqual(await create(gh, null, fresh, "o", "new", true), { full_name: "o/new", pushed: false, push_error: null });
  assert.ok(existsSync(join(fresh, ".git")));
  assert.ok(log().includes("repo create o/new --private --source"), log());
  assert.ok(!log().includes("--push"));
  assert.equal((await worktree.git(fresh, ["remote", "get-url", "origin"])).stdout.trim(), "https://github.com/o/new.git");

  // A repository with commits is pushed, and a public one says so. Without an owner gh picks it.
  const old = join(fake, "old");
  mkdirSync(old, { recursive: true });
  git(old, ["init", "-q"]);
  writeFileSync(join(old, "f"), "x");
  git(old, ["add", "-A"]);
  git(old, ["commit", "-qm", "init"]);
  assert.deepEqual(await create(gh, null, old, null, "old", false), { full_name: "me/old", pushed: true, push_error: null });
  assert.ok(log().includes("repo create old --public --source"), log());
  assert.ok(log().includes("--push"));
  const pushed = await worktree.git(join(fake, "bare/old.git"), ["rev-list", "--all", "--count"]);
  assert.equal(pushed.stdout.trim(), "1");

  // A push that fails leaves the repository and the remote, and says so.
  const pf = join(fake, "pf");
  mkdirSync(pf, { recursive: true });
  git(pf, ["init", "-q"]);
  git(pf, ["commit", "-q", "--allow-empty", "-m", "init"]);
  const made = await create(gh, null, pf, "o", "push-fails", true);
  assert.ok(!made.pushed && made.push_error!.includes("Permission denied"));
  assert.equal(made.full_name, "o/push-fails");

  // A repository gh can't create leaves the folder as it was: a new folder is taken away, and a folder that wasn't a repository isn't one.
  const gone = join(fake, "gone/fails");
  await rejects_with(create(gh, null, gone, "o", "fails", true), "Name already exists");
  assert.ok(!existsSync(gone));
  const plain = join(fake, "plain");
  mkdirSync(plain, { recursive: true });
  writeFileSync(join(plain, "f"), "x");
  await assert.rejects(create(gh, null, plain, "o", "fails", true));
  assert.ok(!existsSync(join(plain, ".git")) && existsSync(join(plain, "f")));

  // A failure takes away only what this call made. A path that goes through a folder that isn't there
  // and back out (`missing/../valuable`) names the folder that is, with what's in it.
  const valuable = join(fake, "valuable");
  mkdirSync(valuable, { recursive: true });
  writeFileSync(join(valuable, "mine.txt"), "keep");
  await rejects_with(create(gh, null, `${fake}/missing/../valuable`, "o", "fails", true), "Name already exists");
  assert.equal(readFileSync(join(valuable, "mine.txt"), "utf8"), "keep");
  assert.ok(!existsSync(join(valuable, ".git")) && !existsSync(join(fake, "missing")));
  // Nor are the folders above a new one that were there.
  await rejects_with(create(gh, null, join(fake, "valuable/a/b"), "o", "fails", true), "Name already exists");
  assert.ok(!existsSync(join(valuable, "a")) && existsSync(join(valuable, "mine.txt")));

  // Another request making a folder in the same new folder keeps it when this one fails: only what this made goes.
  const shared = join(fake, "shared/new");
  const [a, b] = [join(shared, "a"), join(shared, "b")];
  const [failed, other] = await Promise.allSettled([
    create(gh, null, a, "o", "slow-fails", true),
    (async () => {
      await new Promise((r) => setTimeout(r, 300));
      const m = await create(gh, null, b, "o", "b", true);
      writeFileSync(join(b, "valuable.txt"), "keep");
      return m;
    })(),
  ]);
  assert.ok(failed.status === "rejected" && failed.reason.message.includes("Name already exists"));
  assert.equal(other.status, "fulfilled");
  assert.ok(existsSync(join(shared, "b/.git")) && existsSync(join(shared, "b/valuable.txt")));
  assert.ok(!existsSync(join(shared, "a")));

  // Git metadata git won't open (here a repository without its HEAD, as another owner's or a damaged one is) is neither
  // initialized over nor taken away, whether or not gh would have created the repository.
  const broken = join(fake, "broken");
  mkdirSync(broken, { recursive: true });
  git(broken, ["init", "-q"]);
  git(broken, ["commit", "-q", "--allow-empty", "-m", "init"]);
  renameSync(join(broken, ".git/HEAD"), join(broken, ".git/HEAD.saved"));
  const objects = () =>
    readdirSync(join(broken, ".git/objects"))
      .filter((n) => n.length === 2)
      .sort();
  const objects_before = objects();
  assert.ok(objects_before.length > 0);
  const before = log();
  for (const name of ["fails", "fine"]) {
    await rejects_with(create(gh, null, broken, "o", name, true), "has a .git that git can't use");
    assert.ok(existsSync(join(broken, ".git/HEAD.saved")) && !existsSync(join(broken, ".git/HEAD")), name);
    assert.deepEqual(objects(), objects_before, name);
  }
  assert.equal(log(), before);

  // A folder that isn't there inside a repository isn't left behind when it's turned down.
  await rejects_with(create(gh, null, join(old, "not/yet"), null, "yet", true), "is inside the repository");
  assert.ok(!existsSync(join(old, "not")));

  // Refused before gh runs: an origin already there, a folder inside a repository, a bad name.
  const before2 = log();
  await rejects_with(create(gh, null, old, null, "again", true), "already has a remote called origin");
  mkdirSync(join(old, "sub"), { recursive: true });
  await rejects_with(create(gh, null, join(old, "sub"), null, "sub", true), "is inside the repository");
  await assert.rejects(create(gh, null, join(fake, "bad"), "-o", "bad", true));
  assert.ok(!existsSync(join(fake, "bad")));
  assert.equal(log(), before2);
  await rejects_with(create("/nonexistent/gh", null, join(fake, "no-gh"), null, "x", true), "isn't installed");
  assert.ok(!existsSync(join(fake, "no-gh")));
});

test("repository_names_are_letters_digits_and_a_few_marks", () => {
  assert.equal(check_name(" my-repo_1.x "), "my-repo_1.x");
  for (const bad of ["", ".", "..", "a b", "a/b", "é", "a".repeat(101)]) assert.equal(check_name(bad), null, bad);
});

test("repositories_are_owner_and_name", () => {
  assert.equal(check_repo(" dire-kiwi/dkcode "), "dire-kiwi/dkcode");
  assert.equal(check_repo("o/r.git"), "o/r");
  assert.equal(check_repo("octo-org/.github"), "octo-org/.github");
  assert.equal(check_repo("me/my_repo.v2"), "me/my_repo.v2");
  for (const bad of ["", "dkcode", "o/", "/r", "o/r/x", "-o/r", ".o/r", "o/..", "o/.", "o/r x", "o/r;rm", "https://github.com/o/r", "github.com/o/r"]) {
    assert.equal(check_repo(bad), null, bad);
  }
});

test("searches_the_names_of_the_owners_repositories", () => {
  const owners = ["me", "acme"];
  assert.equal(search_query("dk", owners), "dk in:name fork:true user:me user:acme");
  // What's typed can't add qualifiers of its own.
  assert.equal(search_query('web app:x "q"', owners), "web app x q in:name fork:true user:me user:acme");
  assert.equal(search_query("jenkinsci/gitlab", owners), "gitlab in:name fork:true user:jenkinsci");
  assert.equal(search_query("jenkinsci/", owners), "in:name fork:true user:jenkinsci");
  assert.equal(search_query("/gitlab", owners), "gitlab in:name fork:true user:me user:acme");
  assert.equal(search_query("  ", owners), null);
  assert.equal(search_query("::", owners), null);
});

test("repositories_are_what_the_dialog_shows", () => {
  const r = {
    full_name: "o/r",
    name: "r",
    description: null,
    private: true,
    fork: false,
    archived: false,
    pushed_at: "2026-10-26T23:45:48Z",
    html_url: "https://github.com/o/r",
    owner: { login: "o" },
  };
  assert.deepEqual(repo(r), {
    full_name: "o/r",
    name: "r",
    description: null,
    private: true,
    fork: false,
    archived: false,
    pushed_at: "2026-10-26T23:45:48Z",
    url: "https://github.com/o/r",
  });
  assert.equal(repo({ name: "r" }), null);
  const node = {
    nameWithOwner: "o/r",
    name: "r",
    description: null,
    isPrivate: true,
    isFork: false,
    isArchived: false,
    pushedAt: "2026-10-26T23:45:48Z",
    url: "https://github.com/o/r",
  };
  assert.deepEqual(graphql_repo(node), repo(r));
});

test("lists_each_repository_once_most_recently_pushed_first", () => {
  const r = (name: string, pushed: string | null) => ({ full_name: name, pushed_at: pushed });
  const list = latest_first([r("me/old", "2024-01-01T00:00:00Z"), r("org/new", "2026-10-26T00:00:00Z"), r("me/empty", null), r("ORG/new", null)]);
  assert.deepEqual(
    list.map((r) => r.full_name),
    ["org/new", "me/old", "me/empty"],
  );
});

test("gh_errors_end_with_what_it_said_last", () => {
  assert.equal(gh_error(Buffer.from("")), "gh failed");
  assert.equal(gh_error(Buffer.from("1\n2\n\n3\n4\n5\n6\n7\n")), "2 3 4 5 6 7");
  // Why a clone failed is before git's advice.
  const ssh =
    "Cloning into '/tmp/x'...\ngit@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.\n\n" +
    "Please make sure you have the correct access rights\nand the repository exists.\nfailed to run git: exit status 128\n";
  assert.equal(
    gh_error(Buffer.from(ssh)),
    "git@github.com: Permission denied (publickey). fatal: Could not read from remote repository. Please make sure you have the correct " +
      "access rights and the repository exists. failed to run git: exit status 128",
  );
});

test("names_a_folder_the_same_before_and_after_it_is_made", () => {
  const tmp = testing.temp_dir();
  mkdirSync(join(tmp, "real"), { recursive: true });
  symlinkSync(join(tmp, "real"), join(tmp, "alias"));
  const dir = realpathSync(tmp);
  const paths = ["alias/new/r", "alias/new/r/", "real/new/r", "alias/new/x/../r", "alias/../real/new/r", "alias/new/../new/r", "missing/../alias/new/r"];
  const before = paths.map((p) => folder(`${dir}/${p}`));
  mkdirSync(join(dir, "real/new/r/x"), { recursive: true });
  mkdirSync(join(dir, "missing"), { recursive: true });
  paths.forEach((p, i) => {
    assert.equal(before[i], join(dir, "real/new/r"), `${p} before`);
    assert.equal(folder(`${dir}/${p}`), join(dir, "real/new/r"), `${p} after`);
  });
  // `..` after a symlink is its target's parent, as the filesystem has it.
  assert.equal(folder(`${dir}/alias/../missing`), join(dir, "missing"));
  assert.equal(folder(`${dir}/alias/new/r/../../../elsewhere`), join(dir, "elsewhere"));
});

test("finds_clones_of_a_repository_by_their_remotes", async () => {
  const dir = testing.temp_dir();
  const r = join(dir, "r");
  mkdirSync(join(r, "sub"), { recursive: true });
  assert.ok(!(await is_clone_of(r, "github.com", "o/r")), "not a repository");
  await worktree.git(r, ["init", "-q"]);
  assert.ok(!(await is_clone_of(r, "github.com", "o/r")), "no remotes");
  await worktree.git(r, ["remote", "add", "upstream", "git@github.com:parent/r.git"]);
  await worktree.git(r, ["remote", "add", "origin", "https://github.com/O/R.git"]);
  assert.ok(await is_clone_of(r, "github.com", "o/r"));
  assert.ok(await is_clone_of(r, "github.com", "parent/r"));
  assert.ok(!(await is_clone_of(r, "github.com", "o/other")));
  assert.ok(!(await is_clone_of(r, "ghe.example.com", "o/r")), "on another host");
  assert.ok(!(await is_clone_of(join(r, "sub"), "github.com", "o/r")), "a folder inside it");
});
