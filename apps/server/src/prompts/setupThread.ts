// What a project's setup thread's agent is asked to do (huntaway's api/thread.ts `setup_instructions`): make the
// project's folder a git repository with a commit, so its tasks can have worktrees. Its task's description. Plan task 4.1.

export interface SetupThreadFacts {
  readonly repo_path: string
  readonly is_git: boolean
}

export const setupThread = (p: SetupThreadFacts): string => {
  const now = !p.is_git ? "It isn't a git repository yet." : "It's a git repository, but it has no commits yet (or the branch checked out has none)."
  return (
    `Huntaway runs each of this project's tasks in a git worktree of its own, on a branch of its own, so several agents can ` +
    `work on the project at once without getting in each other's way. For that, the project's folder \`${p.repo_path}\` has to be the top ` +
    `folder of a git repository, with a commit checked out for the tasks' branches to start from. ${now} Until it is, the ` +
    `board shows this thread in place of the project's tasks.\n\n` +
    `Help me get it ready:\n\n` +
    `1. Look at what's in the folder and tell me briefly what you find. If it's inside another git repository (such as a ` +
    `home folder kept in git), say so, and ask me before making a repository of its own in it.\n` +
    `2. If it isn't a repository yet, run \`git init\` there (with \`main\` as the branch, unless I say otherwise).\n` +
    `3. Before the first commit, add a \`.gitignore\` for what shouldn't be committed, such as dependencies, build output, ` +
    `local environment files and secrets. Ask me when you're unsure whether something belongs in the repository.\n` +
    `4. Make the first commit.\n` +
    `5. Ask me whether to put the repository on GitHub (or another remote), and if I want to, set that up and push.\n\n` +
    `Ask me before anything that's hard to undo, such as deleting or moving files, rewriting history or pushing. Once the ` +
    `repository has a commit, the board shows the project's tasks again, and new tasks get their own worktrees. End with ` +
    `a short summary of what you set up.`
  )
}
