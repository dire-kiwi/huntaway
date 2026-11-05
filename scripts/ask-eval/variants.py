"""Wordings of the agents' instructions on asking the user (`ask_and_finish` in server-ts/src/agent/runner/prompt.ts)
that eval.py tries. Each replaces that paragraph of a case's system prompt; `{done}` is what the summary is of, as the
case's prompt says it. `baseline` is the wording the board had when the case ran (left as it is). A variant in
TOOL_VARIANTS also changes request_user_input's description (a function of the board's)."""

ASK = (
    "If you are blocked or need a decision or information from the user, call `request_user_input` with your question "
    "(and its `options`, when the choices are known), then end your turn. The task is flagged \"Needs attention\", and "
    "the user's reply resumes this conversation."
)
FINISH = 'When you finish, end with a concise summary of {done}; the task then moves to "In review".'

VARIANTS = {
    "baseline": None,
    # The current wording, with a check of the last message before the turn ends.
    "end_check": (
        f"{ASK}\n\n{FINISH}\n\n"
        "Before you end a turn, look at your last message: if it asks the user something you need answered before you can go on "
        "(which way to go, whether to go ahead, information or access only they have, approval of a plan or design), call "
        "`request_user_input` with it rather than leaving the question in your summary. Offers of optional extras (\"I can also…\", "
        "\"want me to open a follow-up task?\") aren't questions you're waiting on: leave them in the summary."
    ),
    # One sentence more than the current wording.
    "one_line": (
        f"{ASK}\n\n{FINISH} A task in \"In review\" is taken to be finished, so if your summary asks a question the user has to "
        "answer before you can carry on, call `request_user_input` with it instead."
    ),
    # The two ways a turn ends, as a choice.
    "two_ways": (
        "End each turn in one of two ways:\n"
        "- Waiting for the user: when you can't go on without an answer, decision, approval or information from the user (a choice "
        "between ways forward, whether to go ahead, a plan or design to approve before you start the work, a credential or other "
        "information only they have), call `request_user_input` with your question (and its `options`, when the choices are known), "
        "then end your turn. The task is flagged \"Needs attention\", and the user's reply resumes this conversation. A question "
        "left at the end of a summary doesn't flag it.\n"
        "- Finished: end with a concise summary of {done}; the task then moves to \"In review\", which means the work is done and "
        "ready to check. You can offer optional follow-ups there, as they don't hold the work up."
    ),
    # A firm rule about the last message.
    "must_rule": (
        f"{ASK}\n\n{FINISH}\n\n"
        "You must call `request_user_input` before you end a turn whose last message needs something from the user before the "
        "task can go on: a question or choice for them, a plan or design to approve, whether to go ahead with a step (a merge, "
        "a deletion, a release), or something only they can do or give you (a credential, a setting, a command run as them). "
        "This holds wherever it is in the message, even in the middle of a report of what you did. Only leave it out when "
        "everything the user asked for is done and all you offer is extra."
    ),
    # Why it matters: how the user reads the board.
    "columns": (
        f"{ASK}\n\n{FINISH}\n\n"
        "The user works from the board's columns, often hours later: they open \"Needs attention\" for the tasks that wait on "
        "them, and \"In review\" when they have time to check finished work. A question in a summary sits in \"In review\" "
        "unseen, so the task stalls. So whenever the task can't go on without the user (an answer, a choice, approval of a plan or "
        "a step, a credential or an action only they can take), call `request_user_input`, even if you've also done part of the "
        "work and are reporting it. Offers of optional extras, once the work is done, can stay in the summary."
    ),
}

# What request_user_input's description says on top of the board's: when to use it, where the model picks its tools.
WHEN = (
    " Use it whenever your turn ends needing something from the user before the task can go on (an answer, a choice, approval "
    "of a plan or a step, a credential or an action only they can take), even if your final message also reports work done: "
    "a question left in a summary moves the task to 'In review', where it looks finished. Not for offers of optional extras "
    "once the work is done."
)
VARIANTS["tool_when"] = None
VARIANTS["columns_tool"] = VARIANTS["columns"]
VARIANTS["two_ways_tool"] = VARIANTS["two_ways"]
TOOL_VARIANTS = {name: (lambda d: d + WHEN) for name in ("tool_when", "columns_tool", "two_ways_tool")}

# must_rule, with the exception for offers spelled out.
VARIANTS["must_rule2"] = (
    f"{ASK}\n\n{FINISH}\n\n"
    "You must call `request_user_input` before you end a turn whose last message needs something from the user before the "
    "task can go on: a question or choice for them, a plan or design to approve, whether to go ahead with a step (a merge, "
    "a deletion, a release), or something only they can do or give you (a credential, a setting, a command run as them). "
    "This holds wherever it is in the message, even in the middle of a report of what you did. The one exception is an offer "
    "of something extra once everything the user asked for is done (\"I can also…\", \"want me to add…?\"), which they can "
    "take up or ignore: leave that in the summary."
)
VARIANTS["must_rule_tool"] = VARIANTS["must_rule"]
TOOL_VARIANTS["must_rule_tool"] = lambda d: d + WHEN
