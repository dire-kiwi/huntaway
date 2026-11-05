# T3 Code and several Claude subscriptions

Part of the [T3 Code and Huntaway](README.md) notes (task HA-166). The question was how Theo (Theo Browne,
t3.gg, T3 Code's author) uses several Claude subscriptions in T3 Code.

Sources: Theo's own setup guide, T3 Code's docs, its source (`pingdotgg/t3code`, `origin/main` at `3368dd70f`,
2026-11-03) and its issue tracker. Nothing was built or run. Two of Theo's X posts and the video are known only
through search-result summaries (marked "not read directly").

## In short

**Theo doesn't put his Claude subscriptions in T3 Code.** He keeps them in a self-hosted proxy
([CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI), which he forked) on an always-on box at home, and points
Claude Code at the proxy. T3 Code is just one more client of that, through the machine's normal Claude Code config.

T3 Code does support a second or third account natively (one "provider instance" per Claude config directory), and
documents it for a work/personal pair. It has no automatic switching between accounts and its maintainers say
they don't want one.

## What Theo says and does

- **FAQ, "Can I add a bunch of accounts for one provider?"** (`docs/user/faq.md`, written in Theo's voice): *"I
  don't think T3 Code is the right place to manage a pile of accounts. If we add an auto-switcher, we are risking
  TOS bans for our users."* A separate work account is fine (two instances). For a bigger pool, "manage them
  outside T3 Code with a self-hosted proxy like CLIProxyAPI", with a video of "6 Claude subs and 3 Codex subs" and
  a guide.
- **Setup guide**, [gist `t3dotgg/59a521d2ee8d70aaf90e280c175072af`](https://gist.github.com/t3dotgg/59a521d2ee8d70aaf90e280c175072af)
  ("How I manage 7 Claude and 3 Codex accounts across 12+ computers"; the video is
  [D8PikZ1KhUo](https://www.youtube.com/watch?v=D8PikZ1KhUo), not watched):
  - All accounts sign in on **one always-on home machine** running CLIProxyAPI (`-claude-login` per account;
    tokens saved in `~/.cli-proxy-api`). Not a VPS, not a VPN: he says Anthropic is aggressive about datacenter-IP
    sign-ins and about the same account being used from many IPs at once.
  - Every other machine uses it as an API endpoint over Tailscale. Claude Code gets it by
    `env.ANTHROPIC_BASE_URL` and `env.ANTHROPIC_AUTH_TOKEN` (the proxy's access key) in `~/.claude/settings.json`,
    or in a second config dir (`CLAUDE_CONFIG_DIR=~/.claude-hub`) to leave the normal install alone. Codex gets a
    `model_provider` entry.
  - His reasons: Claude Code auth "breaks every 2 to 3 days", so one place keeps it fresh instead of five laptops
    fighting over it; and traffic comes from one residential IP.
  - **Routing**: config `routing.strategy: round-robin` with `session-affinity: true` (TTL 1h), because prompt
    caches are per account and a thread that hops accounts re-pays cache writes. He **forked** the proxy to add
    **soonest-reset-first** routing (burn the account whose limit resets soonest, since unused quota is lost at
    reset). Upstream has per-account `priority` and `weight`, which isn't the same.
  - Benching an account: `"disabled": true` in its auth JSON, no restart. With one account for a provider, a limit
    has nowhere to go.
  - **His two hard rules**: don't serve other people's traffic with the subs; use Claude models through the subs
    only in Claude Code over the proxy, nothing else. He says that across 30+ Claude accounts (his and friends')
    one friend was banned twice (a VPN sign-up with someone else's business card; reinstated), and "this might be
    against the terms of service".
  - **T3 Code and the hub**: T3 Code runs providers on the environment's machine with that machine's CLI config, so
    if Claude Code there points at the hub, so does Claude in T3 Code. Optionally add the hub under
    *Settings > Providers > Usage providers* (URL and management key) to see its pooled limits on the Usage page.
- **Posts on X** (not read directly, from search summaries): one in June 2026 warning that multi-account on the
  *Claude desktop app* "is NOT VIABLE" (switching means a hard log-out and losing sessions, where the CLI can just
  `/login` in another tab); a later one telling people with several accounts "don't put them all in T3 Code",
  CLIProxy is trivial, he forked it, and it shares his "7 Claude subs and 3 Codex subs across 12 computers" with
  "less random signouts".
- **Maintainer reply** on the 2026-05 request for automatic failover (issue #2471, closed): it can be done today by
  adding two Claude providers, but they're "not sure how okay anthropic are with this so we're not encouraging it as
  a first party feature". A later auto-failover PR was reportedly closed as needing "stronger recovery semantics and
  a separate design" (not verified).

## What T3 Code supports itself

**Provider instances.** Each instance of the Claude driver is a separate account/configuration, with its own binary
path, `CLAUDE_CONFIG_DIR` path, launch arguments, environment variables (can hold sensitive values), models and accent
colour. Work is routed by instance "so two accounts using the same driver do not share mutable session or catalog
state" (`docs/internals/providers.md`).

**Setup for a second account** (`docs/user/providers-claude.md`): `mkdir ~/.claude_personal`, run
`CLAUDE_CONFIG_DIR=~/.claude_personal claude auth login` on the environment's machine, add an instance in
*Settings > Providers* with that path. An empty path means Claude Code's normal directory. It sets only
`CLAUDE_CONFIG_DIR`, not `HOME`, so macOS Keychain logins stay reachable (an earlier version of the docs used `HOME`
and left accounts looking logged out: PR #4835, issue #4696). Instances can also differ only in environment (an API
key, `ANTHROPIC_BASE_URL`), which is how the OpenRouter and "other routers" recipes work, each with its own config
dir.

**How it is launched** (`apps/server/src/provider/Drivers/ClaudeHome.ts`, `ClaudeDriver.ts`): the home path becomes
`CLAUDE_CONFIG_DIR` in the child's environment. Resolution order: the instance's path, then an inherited
`CLAUDE_CONFIG_DIR`, then `~/.claude`. It also strips variables that would make the child think it belongs to an
outer Claude Code session (`CLAUDECODE`, `CLAUDE_CODE_SESSION_ID`, …). Claude is driven through the Claude Agent SDK
`query()` on the installed `claude` binary, so each account's own login, settings, skills and history are read from
its config dir.

**Switching a thread to another account** (`ProviderSessionTransitionPolicy.ts`): each instance has a *continuation
key*, `claude:home:<resolved config dir>`. Same key (same config dir, different instance, e.g. one with different
env): the session is restarted and resumed with the same Claude session. Different key (a real second account):
`create_with_handoff`, which starts a fresh session on the other account with a budgeted summary of the history
(16k tokens by default), shown in the thread as "Context handoff". The docs say it plainly: *"Existing threads can
switch only between Claude instances with the same config directory… Claude does not have Codex's shared-home and
shadow-home arrangement."* (Codex can have two logins share one home and continue the same thread.) The model picker
on a thread lists the other instances, on web, desktop and mobile.

**Limits.** Claude usage-limit stops are classified (from `rate_limit_event` frames or the 429 text) and the thread
shows **Limited**, with the window and reset time. The user then retries after the reset, switches to another
instance (manually), uses **Resume at reset** (schedules a continuation; *Settings > Threads > Resume after usage
limits* makes it default), or **Snooze until reset**. There is also a project/global **fallback model** setting
(`fallbackModelSelection`, an instance plus model) for when the default provider runs out. Nothing moves a running
thread to another account by itself.

**Usage page** (`docs/user/usage.md`):
- Token and cost history is read from each instance's `<config dir>/projects` transcripts, including disabled
  instances; instances that share a history directory count once. Costs are API-equivalent estimates, not bills.
- *Usage > Limits* pools every subscription account it can see per provider (across environments and hubs) into one
  bar per window (5-hour, weekly, per-model weekly), one segment per account, ordered by next 5-hour refill. The same
  account on several environments counts once. Per account: plan, where it's signed in, reset time. Claude reads come
  from Anthropic's usage endpoint with the account's token; **reset credits** can be redeemed from the UI
  (`claudeResetCredits.ts` reads `.credentials.json` and the `oauthAccount` organization). That doesn't work on macOS,
  where the login is in the Keychain. API-key and `ANTHROPIC_AUTH_TOKEN`-proxy accounts report no subscription limits.
- A **CLIProxyAPI hub** can be added as a usage source (`apps/server/src/usage/cliproxyApi.ts`): T3 calls the hub's
  management API (`v0/management/auth-files`, then `api-call` to fetch each account's Claude/Codex usage) with the
  management key, and shows those accounts in the same pool. The hub supplies *information only*: "configure the
  provider separately to send agent requests through the hub".
- The thread details card can show the current account's remaining limits.

**Subagents.** T3's own subagents (`delegate_task`) can run on any instance and the UI shows an account badge on
them.

## Rough edges seen in the tracker

Open issues from a quick search, to show where the multi-account feature is still thin:
- #29676: after re-login the old account and its limits show for minutes. #18762: account switches aren't synced across devices.
- #28872: mobile can't add a Claude instance or re-log (instances can only be added on web/desktop). Maintainers
  couldn't reproduce the picker part; the reporter's second instance simply wasn't configured.
- #30408: a parent in *Auto* can't move its *Full access* subagents to another account (blocked as a permission
  escalation), so they stay stranded on the exhausted account. The reporter's "normal recovery" is moving to a second account.
- #19807, #15967, #13053: Limits for a second Claude account failing or blanking (the usage endpoint is probed on
  every refresh and 429s); the latter two are closed. #28142, #24531, #11880: pooled accounts that share an email or
  initials are merged or can't be told apart.
- #16000: switching instance kills live subagents. #16565: switching back leaves a stale MCP credential.

## Reading it

1. **Theo's pooling is outside the app, by design.** The proxy is the account manager (login refresh, session
   affinity, routing, cooldown/benching); T3 Code only displays it. The reasons given are ban risk and keeping auth
   in one place and one IP.
2. **Everything T3 Code does natively is per config dir**, with a manual switch and a context handoff, which is
   weaker than the same-session switch (and, for Codex, the shadow home).
3. **The ideas worth noting for Huntaway** (it already has per-config logins, per-profile/project config choice and
   per-config plan limits; see [huntaway-features.md](huntaway-features.md)):
   - **Pooled limits across configs**: one number per window rather than a list per config.
   - **Limit-aware recovery**: a limited thread offering "switch to the other config" with a handoff, or "resume at
     reset". Huntaway can't continue the same Claude session across config dirs either; a task's session lives
     under one config dir.
   - **Soonest-reset-first, with affinity**: if tasks were ever spread over several configs automatically, Theo's
     two lessons are to keep a task on one account (prompt caches are per account) and to pick the account whose
     limit resets first.
   - **Outside-the-app option**: a config whose `settings.json` `env` sets `ANTHROPIC_BASE_URL` and
     `ANTHROPIC_AUTH_TOKEN` is how Theo's hub works with Claude Code. As Huntaway runs Claude Code with
     `CLAUDE_CONFIG_DIR`, a config like that should work as is, but that wasn't tried here.
   - **ToS**: both Theo and the T3 maintainers treat automatic account rotation as a ban risk and avoid shipping
     it. I didn't look for Anthropic's own wording on several subscriptions, so check it before building anything
     that rotates accounts.

## Not verified

- The two X posts and the video content, and that the auto-failover PR was closed for those reasons: from search
  summaries only.
- Nothing in T3 Code was run; behaviour is as read from docs, code and issues. The local clone at
  `~/personal/t3code` is older than the commit read here (`git show origin/main:…`); its working tree wasn't changed.
- That Huntaway works unchanged against a CLIProxyAPI hub.
