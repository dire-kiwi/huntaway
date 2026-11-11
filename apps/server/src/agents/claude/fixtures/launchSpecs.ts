// What huntaway's agent/runner/launch.ts (and runs.ts `start`) wrote for a Claude run in each case of launch.test.ts:
// the arguments, the environment it added, spec.json, prompt, awaited, mcp.json and mcp-run.json, recorded by running
// the old launch under node with a stand-in ia-shim. Ids, folders and the secret are replaced by placeholders (RUN,
// TASK, /data, /repo, SECRET, PROMPT). The board server's tool list is its names only. Generated: don't edit by hand.

export const launchGoldens: Readonly<Record<string, LaunchGolden>> = {
  "a task's first run": {
    "promptText": "# WEB-1: Fix it\n\n---\n\nStart working on this task.\n\nhello\n",
    "manifest": {
      "initializeResult": {
        "protocolVersion": "2025-11-25",
        "capabilities": {
          "tools": {}
        },
        "serverInfo": {
          "name": "huntaway",
          "version": "0.1.0"
        },
        "instructions": "Tools for the Huntaway board, a kanban board where each task is worked by its own Claude agent. The board has a profile for each Claude login (e.g. work, personal), each with its own projects and tasks. Besides your own profile's, you can use the boards of the profiles that let your agents in (each profile chooses which, in Settings → Profiles). list_projects shows every project you can use, labelled with its profile and host. The other tools take a project or task from any of them by id or key; an unqualified key means your own profile's board first, and one used on several other boards must be qualified as <profile>:<key> (e.g. work:SD-3) or with the profile argument. A task created in another profile's project runs under that profile's Claude login. Don't create a project the user refers to as if it existed: if list_projects doesn't show it, it may be on a profile's board you can't use, so ask the user. To split a piece of work into smaller tasks that are each reviewed and merged on their own and then land together, create them with merges_into that task (new subprojects can't be made any more); group related tasks, across projects too, in a pen."
      },
      "toolsListResult": {
        "tools": [
          {
            "name": "request_user_input"
          },
          {
            "name": "finish_work"
          },
          {
            "name": "track_work"
          },
          {
            "name": "untrack_work"
          },
          {
            "name": "list_tracked_work"
          },
          {
            "name": "wait"
          },
          {
            "name": "background_wait"
          },
          {
            "name": "list_projects"
          },
          {
            "name": "list_tasks"
          },
          {
            "name": "get_task"
          },
          {
            "name": "get_task_field"
          },
          {
            "name": "create_task"
          },
          {
            "name": "update_task"
          },
          {
            "name": "delete_task"
          },
          {
            "name": "list_pens"
          },
          {
            "name": "create_pen"
          },
          {
            "name": "update_pen"
          },
          {
            "name": "delete_pen"
          },
          {
            "name": "send_to_task"
          },
          {
            "name": "get_project"
          },
          {
            "name": "update_project"
          },
          {
            "name": "create_project"
          },
          {
            "name": "list_automations"
          },
          {
            "name": "create_automation"
          },
          {
            "name": "update_automation"
          },
          {
            "name": "delete_automation"
          },
          {
            "name": "run_automation"
          },
          {
            "name": "list_workflows"
          },
          {
            "name": "create_workflow"
          },
          {
            "name": "update_workflow"
          },
          {
            "name": "delete_workflow"
          },
          {
            "name": "run_workflow"
          }
        ]
      }
    },
    "task": {
      "kind": "task",
      "merging": false,
      "session_id": null
    },
    "expected": {
      "program": "claude",
      "args": [
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
        "--input-format",
        "stream-json",
        "--replay-user-messages",
        "--append-system-prompt-file",
        "/data/runs/RUN/system-prompt.md",
        "--permission-mode",
        "default",
        "--permission-prompt-tool",
        "stdio",
        "--settings",
        "{\"hooks\":{\"PreToolUse\":[{\"matcher\":\"Bash\",\"hooks\":[{\"type\":\"command\",\"command\":\"'/opt/huntaway/bin/huntaway' gh-hook\",\"timeout\":10}]}]}}",
        "--allowedTools",
        "mcp__huntaway",
        "mcp__docs",
        "mcp__gh__pr_view",
        "mcp__gh__pr_list",
        "mcp__gh__pr_checks",
        "mcp__gh__pr_diff",
        "mcp__gh__issue_view",
        "mcp__gh__issue_list",
        "mcp__gh__run_list",
        "mcp__gh__run_view",
        "--model",
        "opus",
        "--effort",
        "high",
        "--add-dir",
        "/tmp/ha-0/TASKTMP",
        "--mcp-config",
        "/data/runs/RUN/mcp.json"
      ],
      "env": {
        "CLAUDE_CODE_ENABLE_TASKS": "0",
        "CLAUDE_CODE_ENABLE_TODO_TOOLS": "1",
        "HUNTAWAY_TASK_ID": "TASK",
        "MCP_TOOL_TIMEOUT": "86400000",
        "TMPDIR": "/tmp/ha-0/TASKTMP"
      },
      "cwd": "/repo",
      "spec": {
        "args": [
          "-p",
          "--output-format",
          "stream-json",
          "--verbose",
          "--include-partial-messages",
          "--input-format",
          "stream-json",
          "--replay-user-messages",
          "--append-system-prompt-file",
          "/data/runs/RUN/system-prompt.md",
          "--permission-mode",
          "default",
          "--permission-prompt-tool",
          "stdio",
          "--settings",
          "{\"hooks\":{\"PreToolUse\":[{\"matcher\":\"Bash\",\"hooks\":[{\"type\":\"command\",\"command\":\"'/opt/huntaway/bin/huntaway' gh-hook\",\"timeout\":10}]}]}}",
          "--allowedTools",
          "mcp__huntaway",
          "mcp__docs",
          "mcp__gh__pr_view",
          "mcp__gh__pr_list",
          "mcp__gh__pr_checks",
          "mcp__gh__pr_diff",
          "mcp__gh__issue_view",
          "mcp__gh__issue_list",
          "mcp__gh__run_list",
          "mcp__gh__run_view",
          "--model",
          "opus",
          "--effort",
          "high",
          "--add-dir",
          "/tmp/ha-0/TASKTMP",
          "--mcp-config",
          "/data/runs/RUN/mcp.json"
        ],
        "config_dir": null,
        "cwd": "/repo"
      },
      "prompt": "{\"type\":\"control_request\",\"request_id\":\"huntaway-init-RUN\",\"request\":{\"subtype\":\"initialize\",\"sdkMcpServers\":[\"huntaway\"],\"sdkMcpServerConfigs\":{\"huntaway\":{\"timeout\":86400000,\"disableAutoBackground\":true}},\"sdkMcpServerManifests\":{\"huntaway\":{\"initializeResult\":{\"protocolVersion\":\"2025-11-25\",\"capabilities\":{\"tools\":{}},\"serverInfo\":{\"name\":\"huntaway\",\"version\":\"0.1.0\"},\"instructions\":\"Tools for the Huntaway board, a kanban board where each task is worked by its own Claude agent. The board has a profile for each Claude login (e.g. work, personal), each with its own projects and tasks. Besides your own profile's, you can use the boards of the profiles that let your agents in (each profile chooses which, in Settings → Profiles). list_projects shows every project you can use, labelled with its profile and host. The other tools take a project or task from any of them by id or key; an unqualified key means your own profile's board first, and one used on several other boards must be qualified as <profile>:<key> (e.g. work:SD-3) or with the profile argument. A task created in another profile's project runs under that profile's Claude login. Don't create a project the user refers to as if it existed: if list_projects doesn't show it, it may be on a profile's board you can't use, so ask the user. To split a piece of work into smaller tasks that are each reviewed and merged on their own and then land together, create them with merges_into that task (new subprojects can't be made any more); group related tasks, across projects too, in a pen.\"},\"toolsListResult\":{\"tools\":[{\"name\":\"request_user_input\"},{\"name\":\"finish_work\"},{\"name\":\"track_work\"},{\"name\":\"untrack_work\"},{\"name\":\"list_tracked_work\"},{\"name\":\"wait\"},{\"name\":\"background_wait\"},{\"name\":\"list_projects\"},{\"name\":\"list_tasks\"},{\"name\":\"get_task\"},{\"name\":\"get_task_field\"},{\"name\":\"create_task\"},{\"name\":\"update_task\"},{\"name\":\"delete_task\"},{\"name\":\"list_pens\"},{\"name\":\"create_pen\"},{\"name\":\"update_pen\"},{\"name\":\"delete_pen\"},{\"name\":\"send_to_task\"},{\"name\":\"get_project\"},{\"name\":\"update_project\"},{\"name\":\"create_project\"},{\"name\":\"list_automations\"},{\"name\":\"create_automation\"},{\"name\":\"update_automation\"},{\"name\":\"delete_automation\"},{\"name\":\"run_automation\"},{\"name\":\"list_workflows\"},{\"name\":\"create_workflow\"},{\"name\":\"update_workflow\"},{\"name\":\"delete_workflow\"},{\"name\":\"run_workflow\"}]}}}}}\n{\"type\":\"user\",\"uuid\":\"PROMPT\",\"message\":{\"role\":\"user\",\"content\":\"# WEB-1: Fix it\\n\\n---\\n\\nStart working on this task.\\n\\nhello\\n\"}}\n",
      "awaited": "PROMPT",
      "input": true,
      "mcp": {
        "mcpServers": {
          "docs": {
            "headers": {
              "Authorization": "Bearer SECRET"
            },
            "type": "http",
            "url": "/api/mcp/RUN/docs"
          },
          "gh": {
            "headers": {
              "Authorization": "Bearer SECRET"
            },
            "timeout": 900000,
            "type": "http",
            "url": "/api/mcp/RUN/gh"
          }
        }
      },
      "mcpRun": {
        "cwd": "/repo",
        "github_account": null,
        "review": false,
        "in_process": true,
        "desktop": false
      }
    }
  },
  "a resumed session with a model and effort": {
    "promptText": "hello",
    "manifest": {
      "initializeResult": {
        "protocolVersion": "2025-11-25",
        "capabilities": {
          "tools": {}
        },
        "serverInfo": {
          "name": "huntaway",
          "version": "0.1.0"
        },
        "instructions": "Tools for the Huntaway board, a kanban board where each task is worked by its own Claude agent. The board has a profile for each Claude login (e.g. work, personal), each with its own projects and tasks. Besides your own profile's, you can use the boards of the profiles that let your agents in (each profile chooses which, in Settings → Profiles). list_projects shows every project you can use, labelled with its profile and host. The other tools take a project or task from any of them by id or key; an unqualified key means your own profile's board first, and one used on several other boards must be qualified as <profile>:<key> (e.g. work:SD-3) or with the profile argument. A task created in another profile's project runs under that profile's Claude login. Don't create a project the user refers to as if it existed: if list_projects doesn't show it, it may be on a profile's board you can't use, so ask the user. To split a piece of work into smaller tasks that are each reviewed and merged on their own and then land together, create them with merges_into that task (new subprojects can't be made any more); group related tasks, across projects too, in a pen."
      },
      "toolsListResult": {
        "tools": [
          {
            "name": "request_user_input"
          },
          {
            "name": "finish_work"
          },
          {
            "name": "track_work"
          },
          {
            "name": "untrack_work"
          },
          {
            "name": "list_tracked_work"
          },
          {
            "name": "wait"
          },
          {
            "name": "background_wait"
          },
          {
            "name": "list_projects"
          },
          {
            "name": "list_tasks"
          },
          {
            "name": "get_task"
          },
          {
            "name": "get_task_field"
          },
          {
            "name": "create_task"
          },
          {
            "name": "update_task"
          },
          {
            "name": "delete_task"
          },
          {
            "name": "list_pens"
          },
          {
            "name": "create_pen"
          },
          {
            "name": "update_pen"
          },
          {
            "name": "delete_pen"
          },
          {
            "name": "send_to_task"
          },
          {
            "name": "get_project"
          },
          {
            "name": "update_project"
          },
          {
            "name": "create_project"
          },
          {
            "name": "list_automations"
          },
          {
            "name": "create_automation"
          },
          {
            "name": "update_automation"
          },
          {
            "name": "delete_automation"
          },
          {
            "name": "run_automation"
          },
          {
            "name": "list_workflows"
          },
          {
            "name": "create_workflow"
          },
          {
            "name": "update_workflow"
          },
          {
            "name": "delete_workflow"
          },
          {
            "name": "run_workflow"
          }
        ]
      }
    },
    "task": {
      "kind": "task",
      "merging": false,
      "session_id": "s1"
    },
    "expected": {
      "program": "claude",
      "args": [
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
        "--input-format",
        "stream-json",
        "--replay-user-messages",
        "--append-system-prompt-file",
        "/data/runs/RUN/system-prompt.md",
        "--permission-mode",
        "default",
        "--permission-prompt-tool",
        "stdio",
        "--settings",
        "{\"hooks\":{\"PreToolUse\":[{\"matcher\":\"Bash\",\"hooks\":[{\"type\":\"command\",\"command\":\"'/opt/huntaway/bin/huntaway' gh-hook\",\"timeout\":10}]}]}}",
        "--allowedTools",
        "mcp__huntaway",
        "mcp__docs",
        "mcp__gh__pr_view",
        "mcp__gh__pr_list",
        "mcp__gh__pr_checks",
        "mcp__gh__pr_diff",
        "mcp__gh__issue_view",
        "mcp__gh__issue_list",
        "mcp__gh__run_list",
        "mcp__gh__run_view",
        "--resume",
        "s1",
        "--model",
        "opus",
        "--effort",
        "max",
        "--add-dir",
        "/tmp/ha-0/TASKTMP",
        "--mcp-config",
        "/data/runs/RUN/mcp.json"
      ],
      "env": {
        "CLAUDE_CODE_ENABLE_TASKS": "0",
        "CLAUDE_CODE_ENABLE_TODO_TOOLS": "1",
        "HUNTAWAY_TASK_ID": "TASK",
        "MCP_TOOL_TIMEOUT": "86400000",
        "TMPDIR": "/tmp/ha-0/TASKTMP"
      },
      "cwd": "/repo",
      "spec": {
        "args": [
          "-p",
          "--output-format",
          "stream-json",
          "--verbose",
          "--include-partial-messages",
          "--input-format",
          "stream-json",
          "--replay-user-messages",
          "--append-system-prompt-file",
          "/data/runs/RUN/system-prompt.md",
          "--permission-mode",
          "default",
          "--permission-prompt-tool",
          "stdio",
          "--settings",
          "{\"hooks\":{\"PreToolUse\":[{\"matcher\":\"Bash\",\"hooks\":[{\"type\":\"command\",\"command\":\"'/opt/huntaway/bin/huntaway' gh-hook\",\"timeout\":10}]}]}}",
          "--allowedTools",
          "mcp__huntaway",
          "mcp__docs",
          "mcp__gh__pr_view",
          "mcp__gh__pr_list",
          "mcp__gh__pr_checks",
          "mcp__gh__pr_diff",
          "mcp__gh__issue_view",
          "mcp__gh__issue_list",
          "mcp__gh__run_list",
          "mcp__gh__run_view",
          "--resume",
          "s1",
          "--model",
          "opus",
          "--effort",
          "max",
          "--add-dir",
          "/tmp/ha-0/TASKTMP",
          "--mcp-config",
          "/data/runs/RUN/mcp.json"
        ],
        "config_dir": null,
        "cwd": "/repo"
      },
      "prompt": "{\"type\":\"control_request\",\"request_id\":\"huntaway-init-RUN\",\"request\":{\"subtype\":\"initialize\",\"sdkMcpServers\":[\"huntaway\"],\"sdkMcpServerConfigs\":{\"huntaway\":{\"timeout\":86400000,\"disableAutoBackground\":true}},\"sdkMcpServerManifests\":{\"huntaway\":{\"initializeResult\":{\"protocolVersion\":\"2025-11-25\",\"capabilities\":{\"tools\":{}},\"serverInfo\":{\"name\":\"huntaway\",\"version\":\"0.1.0\"},\"instructions\":\"Tools for the Huntaway board, a kanban board where each task is worked by its own Claude agent. The board has a profile for each Claude login (e.g. work, personal), each with its own projects and tasks. Besides your own profile's, you can use the boards of the profiles that let your agents in (each profile chooses which, in Settings → Profiles). list_projects shows every project you can use, labelled with its profile and host. The other tools take a project or task from any of them by id or key; an unqualified key means your own profile's board first, and one used on several other boards must be qualified as <profile>:<key> (e.g. work:SD-3) or with the profile argument. A task created in another profile's project runs under that profile's Claude login. Don't create a project the user refers to as if it existed: if list_projects doesn't show it, it may be on a profile's board you can't use, so ask the user. To split a piece of work into smaller tasks that are each reviewed and merged on their own and then land together, create them with merges_into that task (new subprojects can't be made any more); group related tasks, across projects too, in a pen.\"},\"toolsListResult\":{\"tools\":[{\"name\":\"request_user_input\"},{\"name\":\"finish_work\"},{\"name\":\"track_work\"},{\"name\":\"untrack_work\"},{\"name\":\"list_tracked_work\"},{\"name\":\"wait\"},{\"name\":\"background_wait\"},{\"name\":\"list_projects\"},{\"name\":\"list_tasks\"},{\"name\":\"get_task\"},{\"name\":\"get_task_field\"},{\"name\":\"create_task\"},{\"name\":\"update_task\"},{\"name\":\"delete_task\"},{\"name\":\"list_pens\"},{\"name\":\"create_pen\"},{\"name\":\"update_pen\"},{\"name\":\"delete_pen\"},{\"name\":\"send_to_task\"},{\"name\":\"get_project\"},{\"name\":\"update_project\"},{\"name\":\"create_project\"},{\"name\":\"list_automations\"},{\"name\":\"create_automation\"},{\"name\":\"update_automation\"},{\"name\":\"delete_automation\"},{\"name\":\"run_automation\"},{\"name\":\"list_workflows\"},{\"name\":\"create_workflow\"},{\"name\":\"update_workflow\"},{\"name\":\"delete_workflow\"},{\"name\":\"run_workflow\"}]}}}}}\n{\"type\":\"user\",\"uuid\":\"PROMPT\",\"message\":{\"role\":\"user\",\"content\":\"hello\"}}\n",
      "awaited": "PROMPT",
      "input": true,
      "mcp": {
        "mcpServers": {
          "docs": {
            "headers": {
              "Authorization": "Bearer SECRET"
            },
            "type": "http",
            "url": "/api/mcp/RUN/docs"
          },
          "gh": {
            "headers": {
              "Authorization": "Bearer SECRET"
            },
            "timeout": 900000,
            "type": "http",
            "url": "/api/mcp/RUN/gh"
          }
        }
      },
      "mcpRun": {
        "cwd": "/repo",
        "github_account": null,
        "review": false,
        "in_process": true,
        "desktop": false
      }
    }
  },
  "auto mode": {
    "promptText": "# WEB-1: Fix it\n\n---\n\nStart working on this task.\n\nhello\n",
    "manifest": {
      "initializeResult": {
        "protocolVersion": "2025-11-25",
        "capabilities": {
          "tools": {}
        },
        "serverInfo": {
          "name": "huntaway",
          "version": "0.1.0"
        },
        "instructions": "Tools for the Huntaway board, a kanban board where each task is worked by its own Claude agent. The board has a profile for each Claude login (e.g. work, personal), each with its own projects and tasks. Besides your own profile's, you can use the boards of the profiles that let your agents in (each profile chooses which, in Settings → Profiles). list_projects shows every project you can use, labelled with its profile and host. The other tools take a project or task from any of them by id or key; an unqualified key means your own profile's board first, and one used on several other boards must be qualified as <profile>:<key> (e.g. work:SD-3) or with the profile argument. A task created in another profile's project runs under that profile's Claude login. Don't create a project the user refers to as if it existed: if list_projects doesn't show it, it may be on a profile's board you can't use, so ask the user. To split a piece of work into smaller tasks that are each reviewed and merged on their own and then land together, create them with merges_into that task (new subprojects can't be made any more); group related tasks, across projects too, in a pen."
      },
      "toolsListResult": {
        "tools": [
          {
            "name": "request_user_input"
          },
          {
            "name": "finish_work"
          },
          {
            "name": "track_work"
          },
          {
            "name": "untrack_work"
          },
          {
            "name": "list_tracked_work"
          },
          {
            "name": "wait"
          },
          {
            "name": "background_wait"
          },
          {
            "name": "list_projects"
          },
          {
            "name": "list_tasks"
          },
          {
            "name": "get_task"
          },
          {
            "name": "get_task_field"
          },
          {
            "name": "create_task"
          },
          {
            "name": "update_task"
          },
          {
            "name": "delete_task"
          },
          {
            "name": "list_pens"
          },
          {
            "name": "create_pen"
          },
          {
            "name": "update_pen"
          },
          {
            "name": "delete_pen"
          },
          {
            "name": "send_to_task"
          },
          {
            "name": "get_project"
          },
          {
            "name": "update_project"
          },
          {
            "name": "create_project"
          },
          {
            "name": "list_automations"
          },
          {
            "name": "create_automation"
          },
          {
            "name": "update_automation"
          },
          {
            "name": "delete_automation"
          },
          {
            "name": "run_automation"
          },
          {
            "name": "list_workflows"
          },
          {
            "name": "create_workflow"
          },
          {
            "name": "update_workflow"
          },
          {
            "name": "delete_workflow"
          },
          {
            "name": "run_workflow"
          }
        ]
      }
    },
    "task": {
      "kind": "task",
      "merging": false,
      "session_id": null
    },
    "expected": {
      "program": "claude",
      "args": [
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
        "--input-format",
        "stream-json",
        "--replay-user-messages",
        "--append-system-prompt-file",
        "/data/runs/RUN/system-prompt.md",
        "--permission-mode",
        "auto",
        "--permission-prompt-tool",
        "stdio",
        "--settings",
        "{\"hooks\":{\"PreToolUse\":[{\"matcher\":\"Bash\",\"hooks\":[{\"type\":\"command\",\"command\":\"'/opt/huntaway/bin/huntaway' gh-hook\",\"timeout\":10}]}]}}",
        "--allowedTools",
        "mcp__huntaway__request_user_input",
        "mcp__huntaway__finish_work",
        "mcp__huntaway__track_work",
        "mcp__huntaway__untrack_work",
        "mcp__huntaway__list_tracked_work",
        "mcp__huntaway__background_wait",
        "mcp__huntaway__list_projects",
        "mcp__huntaway__list_tasks",
        "mcp__huntaway__get_task",
        "mcp__huntaway__get_task_field",
        "mcp__huntaway__create_task",
        "mcp__huntaway__update_task",
        "mcp__huntaway__delete_task",
        "mcp__huntaway__list_pens",
        "mcp__huntaway__create_pen",
        "mcp__huntaway__update_pen",
        "mcp__huntaway__delete_pen",
        "mcp__huntaway__send_to_task",
        "mcp__huntaway__get_project",
        "mcp__huntaway__update_project",
        "mcp__huntaway__create_project",
        "mcp__huntaway__list_automations",
        "mcp__huntaway__create_automation",
        "mcp__huntaway__update_automation",
        "mcp__huntaway__delete_automation",
        "mcp__huntaway__run_automation",
        "mcp__huntaway__list_workflows",
        "mcp__huntaway__create_workflow",
        "mcp__huntaway__update_workflow",
        "mcp__huntaway__delete_workflow",
        "mcp__huntaway__run_workflow",
        "mcp__docs",
        "mcp__gh__pr_view",
        "mcp__gh__pr_list",
        "mcp__gh__pr_checks",
        "mcp__gh__pr_diff",
        "mcp__gh__issue_view",
        "mcp__gh__issue_list",
        "mcp__gh__run_list",
        "mcp__gh__run_view",
        "--model",
        "opus",
        "--effort",
        "high",
        "--add-dir",
        "/tmp/ha-0/TASKTMP",
        "--mcp-config",
        "/data/runs/RUN/mcp.json"
      ],
      "env": {
        "CLAUDE_CODE_ENABLE_TASKS": "0",
        "CLAUDE_CODE_ENABLE_TODO_TOOLS": "1",
        "HUNTAWAY_TASK_ID": "TASK",
        "MCP_TOOL_TIMEOUT": "86400000",
        "TMPDIR": "/tmp/ha-0/TASKTMP"
      },
      "cwd": "/repo",
      "spec": {
        "args": [
          "-p",
          "--output-format",
          "stream-json",
          "--verbose",
          "--include-partial-messages",
          "--input-format",
          "stream-json",
          "--replay-user-messages",
          "--append-system-prompt-file",
          "/data/runs/RUN/system-prompt.md",
          "--permission-mode",
          "auto",
          "--permission-prompt-tool",
          "stdio",
          "--settings",
          "{\"hooks\":{\"PreToolUse\":[{\"matcher\":\"Bash\",\"hooks\":[{\"type\":\"command\",\"command\":\"'/opt/huntaway/bin/huntaway' gh-hook\",\"timeout\":10}]}]}}",
          "--allowedTools",
          "mcp__huntaway__request_user_input",
          "mcp__huntaway__finish_work",
          "mcp__huntaway__track_work",
          "mcp__huntaway__untrack_work",
          "mcp__huntaway__list_tracked_work",
          "mcp__huntaway__background_wait",
          "mcp__huntaway__list_projects",
          "mcp__huntaway__list_tasks",
          "mcp__huntaway__get_task",
          "mcp__huntaway__get_task_field",
          "mcp__huntaway__create_task",
          "mcp__huntaway__update_task",
          "mcp__huntaway__delete_task",
          "mcp__huntaway__list_pens",
          "mcp__huntaway__create_pen",
          "mcp__huntaway__update_pen",
          "mcp__huntaway__delete_pen",
          "mcp__huntaway__send_to_task",
          "mcp__huntaway__get_project",
          "mcp__huntaway__update_project",
          "mcp__huntaway__create_project",
          "mcp__huntaway__list_automations",
          "mcp__huntaway__create_automation",
          "mcp__huntaway__update_automation",
          "mcp__huntaway__delete_automation",
          "mcp__huntaway__run_automation",
          "mcp__huntaway__list_workflows",
          "mcp__huntaway__create_workflow",
          "mcp__huntaway__update_workflow",
          "mcp__huntaway__delete_workflow",
          "mcp__huntaway__run_workflow",
          "mcp__docs",
          "mcp__gh__pr_view",
          "mcp__gh__pr_list",
          "mcp__gh__pr_checks",
          "mcp__gh__pr_diff",
          "mcp__gh__issue_view",
          "mcp__gh__issue_list",
          "mcp__gh__run_list",
          "mcp__gh__run_view",
          "--model",
          "opus",
          "--effort",
          "high",
          "--add-dir",
          "/tmp/ha-0/TASKTMP",
          "--mcp-config",
          "/data/runs/RUN/mcp.json"
        ],
        "config_dir": null,
        "cwd": "/repo"
      },
      "prompt": "{\"type\":\"control_request\",\"request_id\":\"huntaway-init-RUN\",\"request\":{\"subtype\":\"initialize\",\"sdkMcpServers\":[\"huntaway\"],\"sdkMcpServerConfigs\":{\"huntaway\":{\"timeout\":86400000,\"disableAutoBackground\":true}},\"sdkMcpServerManifests\":{\"huntaway\":{\"initializeResult\":{\"protocolVersion\":\"2025-11-25\",\"capabilities\":{\"tools\":{}},\"serverInfo\":{\"name\":\"huntaway\",\"version\":\"0.1.0\"},\"instructions\":\"Tools for the Huntaway board, a kanban board where each task is worked by its own Claude agent. The board has a profile for each Claude login (e.g. work, personal), each with its own projects and tasks. Besides your own profile's, you can use the boards of the profiles that let your agents in (each profile chooses which, in Settings → Profiles). list_projects shows every project you can use, labelled with its profile and host. The other tools take a project or task from any of them by id or key; an unqualified key means your own profile's board first, and one used on several other boards must be qualified as <profile>:<key> (e.g. work:SD-3) or with the profile argument. A task created in another profile's project runs under that profile's Claude login. Don't create a project the user refers to as if it existed: if list_projects doesn't show it, it may be on a profile's board you can't use, so ask the user. To split a piece of work into smaller tasks that are each reviewed and merged on their own and then land together, create them with merges_into that task (new subprojects can't be made any more); group related tasks, across projects too, in a pen.\"},\"toolsListResult\":{\"tools\":[{\"name\":\"request_user_input\"},{\"name\":\"finish_work\"},{\"name\":\"track_work\"},{\"name\":\"untrack_work\"},{\"name\":\"list_tracked_work\"},{\"name\":\"wait\"},{\"name\":\"background_wait\"},{\"name\":\"list_projects\"},{\"name\":\"list_tasks\"},{\"name\":\"get_task\"},{\"name\":\"get_task_field\"},{\"name\":\"create_task\"},{\"name\":\"update_task\"},{\"name\":\"delete_task\"},{\"name\":\"list_pens\"},{\"name\":\"create_pen\"},{\"name\":\"update_pen\"},{\"name\":\"delete_pen\"},{\"name\":\"send_to_task\"},{\"name\":\"get_project\"},{\"name\":\"update_project\"},{\"name\":\"create_project\"},{\"name\":\"list_automations\"},{\"name\":\"create_automation\"},{\"name\":\"update_automation\"},{\"name\":\"delete_automation\"},{\"name\":\"run_automation\"},{\"name\":\"list_workflows\"},{\"name\":\"create_workflow\"},{\"name\":\"update_workflow\"},{\"name\":\"delete_workflow\"},{\"name\":\"run_workflow\"}]}}}}}\n{\"type\":\"user\",\"uuid\":\"PROMPT\",\"message\":{\"role\":\"user\",\"content\":\"# WEB-1: Fix it\\n\\n---\\n\\nStart working on this task.\\n\\nhello\\n\"}}\n",
      "awaited": "PROMPT",
      "input": true,
      "mcp": {
        "mcpServers": {
          "docs": {
            "headers": {
              "Authorization": "Bearer SECRET"
            },
            "type": "http",
            "url": "/api/mcp/RUN/docs"
          },
          "gh": {
            "headers": {
              "Authorization": "Bearer SECRET"
            },
            "timeout": 900000,
            "type": "http",
            "url": "/api/mcp/RUN/gh"
          }
        }
      },
      "mcpRun": {
        "cwd": "/repo",
        "github_account": null,
        "review": false,
        "in_process": true,
        "desktop": false
      }
    }
  },
  "bypass without rules": {
    "promptText": "# WEB-1: Fix it\n\n---\n\nStart working on this task.\n\nhello\n",
    "manifest": {
      "initializeResult": {
        "protocolVersion": "2025-11-25",
        "capabilities": {
          "tools": {}
        },
        "serverInfo": {
          "name": "huntaway",
          "version": "0.1.0"
        },
        "instructions": "Tools for the Huntaway board, a kanban board where each task is worked by its own Claude agent. The board has a profile for each Claude login (e.g. work, personal), each with its own projects and tasks. Besides your own profile's, you can use the boards of the profiles that let your agents in (each profile chooses which, in Settings → Profiles). list_projects shows every project you can use, labelled with its profile and host. The other tools take a project or task from any of them by id or key; an unqualified key means your own profile's board first, and one used on several other boards must be qualified as <profile>:<key> (e.g. work:SD-3) or with the profile argument. A task created in another profile's project runs under that profile's Claude login. Don't create a project the user refers to as if it existed: if list_projects doesn't show it, it may be on a profile's board you can't use, so ask the user. To split a piece of work into smaller tasks that are each reviewed and merged on their own and then land together, create them with merges_into that task (new subprojects can't be made any more); group related tasks, across projects too, in a pen."
      },
      "toolsListResult": {
        "tools": [
          {
            "name": "request_user_input"
          },
          {
            "name": "finish_work"
          },
          {
            "name": "track_work"
          },
          {
            "name": "untrack_work"
          },
          {
            "name": "list_tracked_work"
          },
          {
            "name": "wait"
          },
          {
            "name": "background_wait"
          },
          {
            "name": "list_projects"
          },
          {
            "name": "list_tasks"
          },
          {
            "name": "get_task"
          },
          {
            "name": "get_task_field"
          },
          {
            "name": "create_task"
          },
          {
            "name": "update_task"
          },
          {
            "name": "delete_task"
          },
          {
            "name": "list_pens"
          },
          {
            "name": "create_pen"
          },
          {
            "name": "update_pen"
          },
          {
            "name": "delete_pen"
          },
          {
            "name": "send_to_task"
          },
          {
            "name": "get_project"
          },
          {
            "name": "update_project"
          },
          {
            "name": "create_project"
          },
          {
            "name": "list_automations"
          },
          {
            "name": "create_automation"
          },
          {
            "name": "update_automation"
          },
          {
            "name": "delete_automation"
          },
          {
            "name": "run_automation"
          },
          {
            "name": "list_workflows"
          },
          {
            "name": "create_workflow"
          },
          {
            "name": "update_workflow"
          },
          {
            "name": "delete_workflow"
          },
          {
            "name": "run_workflow"
          }
        ]
      }
    },
    "task": {
      "kind": "task",
      "merging": false,
      "session_id": null
    },
    "expected": {
      "program": "claude",
      "args": [
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
        "--input-format",
        "stream-json",
        "--replay-user-messages",
        "--append-system-prompt-file",
        "/data/runs/RUN/system-prompt.md",
        "--permission-mode",
        "bypassPermissions",
        "--settings",
        "{\"hooks\":{\"PreToolUse\":[{\"matcher\":\"Bash\",\"hooks\":[{\"type\":\"command\",\"command\":\"'/opt/huntaway/bin/huntaway' gh-hook\",\"timeout\":10}]}]}}",
        "--allowedTools",
        "mcp__huntaway",
        "mcp__docs",
        "mcp__gh__pr_view",
        "mcp__gh__pr_list",
        "mcp__gh__pr_checks",
        "mcp__gh__pr_diff",
        "mcp__gh__issue_view",
        "mcp__gh__issue_list",
        "mcp__gh__run_list",
        "mcp__gh__run_view",
        "--model",
        "opus",
        "--effort",
        "high",
        "--add-dir",
        "/tmp/ha-0/TASKTMP",
        "--mcp-config",
        "/data/runs/RUN/mcp.json"
      ],
      "env": {
        "CLAUDE_CODE_ENABLE_TASKS": "0",
        "CLAUDE_CODE_ENABLE_TODO_TOOLS": "1",
        "HUNTAWAY_TASK_ID": "TASK",
        "MCP_TOOL_TIMEOUT": "86400000",
        "TMPDIR": "/tmp/ha-0/TASKTMP"
      },
      "cwd": "/repo",
      "spec": {
        "args": [
          "-p",
          "--output-format",
          "stream-json",
          "--verbose",
          "--include-partial-messages",
          "--input-format",
          "stream-json",
          "--replay-user-messages",
          "--append-system-prompt-file",
          "/data/runs/RUN/system-prompt.md",
          "--permission-mode",
          "bypassPermissions",
          "--settings",
          "{\"hooks\":{\"PreToolUse\":[{\"matcher\":\"Bash\",\"hooks\":[{\"type\":\"command\",\"command\":\"'/opt/huntaway/bin/huntaway' gh-hook\",\"timeout\":10}]}]}}",
          "--allowedTools",
          "mcp__huntaway",
          "mcp__docs",
          "mcp__gh__pr_view",
          "mcp__gh__pr_list",
          "mcp__gh__pr_checks",
          "mcp__gh__pr_diff",
          "mcp__gh__issue_view",
          "mcp__gh__issue_list",
          "mcp__gh__run_list",
          "mcp__gh__run_view",
          "--model",
          "opus",
          "--effort",
          "high",
          "--add-dir",
          "/tmp/ha-0/TASKTMP",
          "--mcp-config",
          "/data/runs/RUN/mcp.json"
        ],
        "config_dir": null,
        "cwd": "/repo"
      },
      "prompt": "{\"type\":\"control_request\",\"request_id\":\"huntaway-init-RUN\",\"request\":{\"subtype\":\"initialize\",\"sdkMcpServers\":[\"huntaway\"],\"sdkMcpServerConfigs\":{\"huntaway\":{\"timeout\":86400000,\"disableAutoBackground\":true}},\"sdkMcpServerManifests\":{\"huntaway\":{\"initializeResult\":{\"protocolVersion\":\"2025-11-25\",\"capabilities\":{\"tools\":{}},\"serverInfo\":{\"name\":\"huntaway\",\"version\":\"0.1.0\"},\"instructions\":\"Tools for the Huntaway board, a kanban board where each task is worked by its own Claude agent. The board has a profile for each Claude login (e.g. work, personal), each with its own projects and tasks. Besides your own profile's, you can use the boards of the profiles that let your agents in (each profile chooses which, in Settings → Profiles). list_projects shows every project you can use, labelled with its profile and host. The other tools take a project or task from any of them by id or key; an unqualified key means your own profile's board first, and one used on several other boards must be qualified as <profile>:<key> (e.g. work:SD-3) or with the profile argument. A task created in another profile's project runs under that profile's Claude login. Don't create a project the user refers to as if it existed: if list_projects doesn't show it, it may be on a profile's board you can't use, so ask the user. To split a piece of work into smaller tasks that are each reviewed and merged on their own and then land together, create them with merges_into that task (new subprojects can't be made any more); group related tasks, across projects too, in a pen.\"},\"toolsListResult\":{\"tools\":[{\"name\":\"request_user_input\"},{\"name\":\"finish_work\"},{\"name\":\"track_work\"},{\"name\":\"untrack_work\"},{\"name\":\"list_tracked_work\"},{\"name\":\"wait\"},{\"name\":\"background_wait\"},{\"name\":\"list_projects\"},{\"name\":\"list_tasks\"},{\"name\":\"get_task\"},{\"name\":\"get_task_field\"},{\"name\":\"create_task\"},{\"name\":\"update_task\"},{\"name\":\"delete_task\"},{\"name\":\"list_pens\"},{\"name\":\"create_pen\"},{\"name\":\"update_pen\"},{\"name\":\"delete_pen\"},{\"name\":\"send_to_task\"},{\"name\":\"get_project\"},{\"name\":\"update_project\"},{\"name\":\"create_project\"},{\"name\":\"list_automations\"},{\"name\":\"create_automation\"},{\"name\":\"update_automation\"},{\"name\":\"delete_automation\"},{\"name\":\"run_automation\"},{\"name\":\"list_workflows\"},{\"name\":\"create_workflow\"},{\"name\":\"update_workflow\"},{\"name\":\"delete_workflow\"},{\"name\":\"run_workflow\"}]}}}}}\n{\"type\":\"user\",\"uuid\":\"PROMPT\",\"message\":{\"role\":\"user\",\"content\":\"# WEB-1: Fix it\\n\\n---\\n\\nStart working on this task.\\n\\nhello\\n\"}}\n",
      "awaited": "PROMPT",
      "input": true,
      "mcp": {
        "mcpServers": {
          "docs": {
            "headers": {
              "Authorization": "Bearer SECRET"
            },
            "type": "http",
            "url": "/api/mcp/RUN/docs"
          },
          "gh": {
            "headers": {
              "Authorization": "Bearer SECRET"
            },
            "timeout": 900000,
            "type": "http",
            "url": "/api/mcp/RUN/gh"
          }
        }
      },
      "mcpRun": {
        "cwd": "/repo",
        "github_account": null,
        "review": false,
        "in_process": true,
        "desktop": false
      }
    }
  },
  "plan mode with minimal effort": {
    "promptText": "# WEB-1: Fix it\n\n---\n\nStart working on this task.\n\nhello\n",
    "manifest": {
      "initializeResult": {
        "protocolVersion": "2025-11-25",
        "capabilities": {
          "tools": {}
        },
        "serverInfo": {
          "name": "huntaway",
          "version": "0.1.0"
        },
        "instructions": "Tools for the Huntaway board, a kanban board where each task is worked by its own Claude agent. The board has a profile for each Claude login (e.g. work, personal), each with its own projects and tasks. Besides your own profile's, you can use the boards of the profiles that let your agents in (each profile chooses which, in Settings → Profiles). list_projects shows every project you can use, labelled with its profile and host. The other tools take a project or task from any of them by id or key; an unqualified key means your own profile's board first, and one used on several other boards must be qualified as <profile>:<key> (e.g. work:SD-3) or with the profile argument. A task created in another profile's project runs under that profile's Claude login. Don't create a project the user refers to as if it existed: if list_projects doesn't show it, it may be on a profile's board you can't use, so ask the user. To split a piece of work into smaller tasks that are each reviewed and merged on their own and then land together, create them with merges_into that task (new subprojects can't be made any more); group related tasks, across projects too, in a pen."
      },
      "toolsListResult": {
        "tools": [
          {
            "name": "request_user_input"
          },
          {
            "name": "finish_work"
          },
          {
            "name": "track_work"
          },
          {
            "name": "untrack_work"
          },
          {
            "name": "list_tracked_work"
          },
          {
            "name": "wait"
          },
          {
            "name": "background_wait"
          },
          {
            "name": "list_projects"
          },
          {
            "name": "list_tasks"
          },
          {
            "name": "get_task"
          },
          {
            "name": "get_task_field"
          },
          {
            "name": "create_task"
          },
          {
            "name": "update_task"
          },
          {
            "name": "delete_task"
          },
          {
            "name": "list_pens"
          },
          {
            "name": "create_pen"
          },
          {
            "name": "update_pen"
          },
          {
            "name": "delete_pen"
          },
          {
            "name": "send_to_task"
          },
          {
            "name": "get_project"
          },
          {
            "name": "update_project"
          },
          {
            "name": "create_project"
          },
          {
            "name": "list_automations"
          },
          {
            "name": "create_automation"
          },
          {
            "name": "update_automation"
          },
          {
            "name": "delete_automation"
          },
          {
            "name": "run_automation"
          },
          {
            "name": "list_workflows"
          },
          {
            "name": "create_workflow"
          },
          {
            "name": "update_workflow"
          },
          {
            "name": "delete_workflow"
          },
          {
            "name": "run_workflow"
          }
        ]
      }
    },
    "task": {
      "kind": "task",
      "merging": false,
      "session_id": null
    },
    "expected": {
      "program": "claude",
      "args": [
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
        "--input-format",
        "stream-json",
        "--replay-user-messages",
        "--append-system-prompt-file",
        "/data/runs/RUN/system-prompt.md",
        "--permission-mode",
        "plan",
        "--permission-prompt-tool",
        "stdio",
        "--settings",
        "{\"hooks\":{\"PreToolUse\":[{\"matcher\":\"Bash\",\"hooks\":[{\"type\":\"command\",\"command\":\"'/opt/huntaway/bin/huntaway' gh-hook\",\"timeout\":10}]}]}}",
        "--allowedTools",
        "mcp__huntaway",
        "mcp__docs",
        "mcp__gh__pr_view",
        "mcp__gh__pr_list",
        "mcp__gh__pr_checks",
        "mcp__gh__pr_diff",
        "mcp__gh__issue_view",
        "mcp__gh__issue_list",
        "mcp__gh__run_list",
        "mcp__gh__run_view",
        "--model",
        "opus",
        "--effort",
        "low",
        "--add-dir",
        "/tmp/ha-0/TASKTMP",
        "--mcp-config",
        "/data/runs/RUN/mcp.json"
      ],
      "env": {
        "CLAUDE_CODE_ENABLE_TASKS": "0",
        "CLAUDE_CODE_ENABLE_TODO_TOOLS": "1",
        "HUNTAWAY_TASK_ID": "TASK",
        "MCP_TOOL_TIMEOUT": "86400000",
        "TMPDIR": "/tmp/ha-0/TASKTMP"
      },
      "cwd": "/repo",
      "spec": {
        "args": [
          "-p",
          "--output-format",
          "stream-json",
          "--verbose",
          "--include-partial-messages",
          "--input-format",
          "stream-json",
          "--replay-user-messages",
          "--append-system-prompt-file",
          "/data/runs/RUN/system-prompt.md",
          "--permission-mode",
          "plan",
          "--permission-prompt-tool",
          "stdio",
          "--settings",
          "{\"hooks\":{\"PreToolUse\":[{\"matcher\":\"Bash\",\"hooks\":[{\"type\":\"command\",\"command\":\"'/opt/huntaway/bin/huntaway' gh-hook\",\"timeout\":10}]}]}}",
          "--allowedTools",
          "mcp__huntaway",
          "mcp__docs",
          "mcp__gh__pr_view",
          "mcp__gh__pr_list",
          "mcp__gh__pr_checks",
          "mcp__gh__pr_diff",
          "mcp__gh__issue_view",
          "mcp__gh__issue_list",
          "mcp__gh__run_list",
          "mcp__gh__run_view",
          "--model",
          "opus",
          "--effort",
          "low",
          "--add-dir",
          "/tmp/ha-0/TASKTMP",
          "--mcp-config",
          "/data/runs/RUN/mcp.json"
        ],
        "config_dir": null,
        "cwd": "/repo"
      },
      "prompt": "{\"type\":\"control_request\",\"request_id\":\"huntaway-init-RUN\",\"request\":{\"subtype\":\"initialize\",\"sdkMcpServers\":[\"huntaway\"],\"sdkMcpServerConfigs\":{\"huntaway\":{\"timeout\":86400000,\"disableAutoBackground\":true}},\"sdkMcpServerManifests\":{\"huntaway\":{\"initializeResult\":{\"protocolVersion\":\"2025-11-25\",\"capabilities\":{\"tools\":{}},\"serverInfo\":{\"name\":\"huntaway\",\"version\":\"0.1.0\"},\"instructions\":\"Tools for the Huntaway board, a kanban board where each task is worked by its own Claude agent. The board has a profile for each Claude login (e.g. work, personal), each with its own projects and tasks. Besides your own profile's, you can use the boards of the profiles that let your agents in (each profile chooses which, in Settings → Profiles). list_projects shows every project you can use, labelled with its profile and host. The other tools take a project or task from any of them by id or key; an unqualified key means your own profile's board first, and one used on several other boards must be qualified as <profile>:<key> (e.g. work:SD-3) or with the profile argument. A task created in another profile's project runs under that profile's Claude login. Don't create a project the user refers to as if it existed: if list_projects doesn't show it, it may be on a profile's board you can't use, so ask the user. To split a piece of work into smaller tasks that are each reviewed and merged on their own and then land together, create them with merges_into that task (new subprojects can't be made any more); group related tasks, across projects too, in a pen.\"},\"toolsListResult\":{\"tools\":[{\"name\":\"request_user_input\"},{\"name\":\"finish_work\"},{\"name\":\"track_work\"},{\"name\":\"untrack_work\"},{\"name\":\"list_tracked_work\"},{\"name\":\"wait\"},{\"name\":\"background_wait\"},{\"name\":\"list_projects\"},{\"name\":\"list_tasks\"},{\"name\":\"get_task\"},{\"name\":\"get_task_field\"},{\"name\":\"create_task\"},{\"name\":\"update_task\"},{\"name\":\"delete_task\"},{\"name\":\"list_pens\"},{\"name\":\"create_pen\"},{\"name\":\"update_pen\"},{\"name\":\"delete_pen\"},{\"name\":\"send_to_task\"},{\"name\":\"get_project\"},{\"name\":\"update_project\"},{\"name\":\"create_project\"},{\"name\":\"list_automations\"},{\"name\":\"create_automation\"},{\"name\":\"update_automation\"},{\"name\":\"delete_automation\"},{\"name\":\"run_automation\"},{\"name\":\"list_workflows\"},{\"name\":\"create_workflow\"},{\"name\":\"update_workflow\"},{\"name\":\"delete_workflow\"},{\"name\":\"run_workflow\"}]}}}}}\n{\"type\":\"user\",\"uuid\":\"PROMPT\",\"message\":{\"role\":\"user\",\"content\":\"# WEB-1: Fix it\\n\\n---\\n\\nStart working on this task.\\n\\nhello\\n\"}}\n",
      "awaited": "PROMPT",
      "input": true,
      "mcp": {
        "mcpServers": {
          "docs": {
            "headers": {
              "Authorization": "Bearer SECRET"
            },
            "type": "http",
            "url": "/api/mcp/RUN/docs"
          },
          "gh": {
            "headers": {
              "Authorization": "Bearer SECRET"
            },
            "timeout": 900000,
            "type": "http",
            "url": "/api/mcp/RUN/gh"
          }
        }
      },
      "mcpRun": {
        "cwd": "/repo",
        "github_account": null,
        "review": false,
        "in_process": true,
        "desktop": false
      }
    }
  },
  "a merging task": {
    "promptText": "# WEB-1: Fix it\n\n---\n\nStart working on this task.\n\nhello\n",
    "manifest": {
      "initializeResult": {
        "protocolVersion": "2025-11-25",
        "capabilities": {
          "tools": {}
        },
        "serverInfo": {
          "name": "huntaway",
          "version": "0.1.0"
        },
        "instructions": "Tools for the Huntaway board, a kanban board where each task is worked by its own Claude agent. The board has a profile for each Claude login (e.g. work, personal), each with its own projects and tasks. Besides your own profile's, you can use the boards of the profiles that let your agents in (each profile chooses which, in Settings → Profiles). list_projects shows every project you can use, labelled with its profile and host. The other tools take a project or task from any of them by id or key; an unqualified key means your own profile's board first, and one used on several other boards must be qualified as <profile>:<key> (e.g. work:SD-3) or with the profile argument. A task created in another profile's project runs under that profile's Claude login. Don't create a project the user refers to as if it existed: if list_projects doesn't show it, it may be on a profile's board you can't use, so ask the user. To split a piece of work into smaller tasks that are each reviewed and merged on their own and then land together, create them with merges_into that task (new subprojects can't be made any more); group related tasks, across projects too, in a pen."
      },
      "toolsListResult": {
        "tools": [
          {
            "name": "request_user_input"
          },
          {
            "name": "finish_work"
          },
          {
            "name": "track_work"
          },
          {
            "name": "untrack_work"
          },
          {
            "name": "list_tracked_work"
          },
          {
            "name": "wait"
          },
          {
            "name": "background_wait"
          },
          {
            "name": "list_projects"
          },
          {
            "name": "list_tasks"
          },
          {
            "name": "get_task"
          },
          {
            "name": "get_task_field"
          },
          {
            "name": "create_task"
          },
          {
            "name": "update_task"
          },
          {
            "name": "delete_task"
          },
          {
            "name": "list_pens"
          },
          {
            "name": "create_pen"
          },
          {
            "name": "update_pen"
          },
          {
            "name": "delete_pen"
          },
          {
            "name": "send_to_task"
          },
          {
            "name": "get_project"
          },
          {
            "name": "update_project"
          },
          {
            "name": "create_project"
          },
          {
            "name": "list_automations"
          },
          {
            "name": "create_automation"
          },
          {
            "name": "update_automation"
          },
          {
            "name": "delete_automation"
          },
          {
            "name": "run_automation"
          },
          {
            "name": "list_workflows"
          },
          {
            "name": "create_workflow"
          },
          {
            "name": "update_workflow"
          },
          {
            "name": "delete_workflow"
          },
          {
            "name": "run_workflow"
          }
        ]
      }
    },
    "task": {
      "kind": "task",
      "merging": true,
      "session_id": null
    },
    "expected": {
      "program": "claude",
      "args": [
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
        "--input-format",
        "stream-json",
        "--replay-user-messages",
        "--append-system-prompt-file",
        "/data/runs/RUN/system-prompt.md",
        "--permission-mode",
        "default",
        "--permission-prompt-tool",
        "stdio",
        "--settings",
        "{\"hooks\":{\"PreToolUse\":[{\"matcher\":\"Bash\",\"hooks\":[{\"type\":\"command\",\"command\":\"'/opt/huntaway/bin/huntaway' gh-hook\",\"timeout\":10}]}]}}",
        "--allowedTools",
        "mcp__huntaway",
        "mcp__docs",
        "mcp__gh__pr_view",
        "mcp__gh__pr_list",
        "mcp__gh__pr_checks",
        "mcp__gh__pr_diff",
        "mcp__gh__issue_view",
        "mcp__gh__issue_list",
        "mcp__gh__run_list",
        "mcp__gh__run_view",
        "mcp__gh__pr_merge",
        "--model",
        "opus",
        "--effort",
        "high",
        "--add-dir",
        "/tmp/ha-0/TASKTMP",
        "--mcp-config",
        "/data/runs/RUN/mcp.json"
      ],
      "env": {
        "CLAUDE_CODE_ENABLE_TASKS": "0",
        "CLAUDE_CODE_ENABLE_TODO_TOOLS": "1",
        "HUNTAWAY_TASK_ID": "TASK",
        "MCP_TOOL_TIMEOUT": "86400000",
        "TMPDIR": "/tmp/ha-0/TASKTMP"
      },
      "cwd": "/repo",
      "spec": {
        "args": [
          "-p",
          "--output-format",
          "stream-json",
          "--verbose",
          "--include-partial-messages",
          "--input-format",
          "stream-json",
          "--replay-user-messages",
          "--append-system-prompt-file",
          "/data/runs/RUN/system-prompt.md",
          "--permission-mode",
          "default",
          "--permission-prompt-tool",
          "stdio",
          "--settings",
          "{\"hooks\":{\"PreToolUse\":[{\"matcher\":\"Bash\",\"hooks\":[{\"type\":\"command\",\"command\":\"'/opt/huntaway/bin/huntaway' gh-hook\",\"timeout\":10}]}]}}",
          "--allowedTools",
          "mcp__huntaway",
          "mcp__docs",
          "mcp__gh__pr_view",
          "mcp__gh__pr_list",
          "mcp__gh__pr_checks",
          "mcp__gh__pr_diff",
          "mcp__gh__issue_view",
          "mcp__gh__issue_list",
          "mcp__gh__run_list",
          "mcp__gh__run_view",
          "mcp__gh__pr_merge",
          "--model",
          "opus",
          "--effort",
          "high",
          "--add-dir",
          "/tmp/ha-0/TASKTMP",
          "--mcp-config",
          "/data/runs/RUN/mcp.json"
        ],
        "config_dir": null,
        "cwd": "/repo"
      },
      "prompt": "{\"type\":\"control_request\",\"request_id\":\"huntaway-init-RUN\",\"request\":{\"subtype\":\"initialize\",\"sdkMcpServers\":[\"huntaway\"],\"sdkMcpServerConfigs\":{\"huntaway\":{\"timeout\":86400000,\"disableAutoBackground\":true}},\"sdkMcpServerManifests\":{\"huntaway\":{\"initializeResult\":{\"protocolVersion\":\"2025-11-25\",\"capabilities\":{\"tools\":{}},\"serverInfo\":{\"name\":\"huntaway\",\"version\":\"0.1.0\"},\"instructions\":\"Tools for the Huntaway board, a kanban board where each task is worked by its own Claude agent. The board has a profile for each Claude login (e.g. work, personal), each with its own projects and tasks. Besides your own profile's, you can use the boards of the profiles that let your agents in (each profile chooses which, in Settings → Profiles). list_projects shows every project you can use, labelled with its profile and host. The other tools take a project or task from any of them by id or key; an unqualified key means your own profile's board first, and one used on several other boards must be qualified as <profile>:<key> (e.g. work:SD-3) or with the profile argument. A task created in another profile's project runs under that profile's Claude login. Don't create a project the user refers to as if it existed: if list_projects doesn't show it, it may be on a profile's board you can't use, so ask the user. To split a piece of work into smaller tasks that are each reviewed and merged on their own and then land together, create them with merges_into that task (new subprojects can't be made any more); group related tasks, across projects too, in a pen.\"},\"toolsListResult\":{\"tools\":[{\"name\":\"request_user_input\"},{\"name\":\"finish_work\"},{\"name\":\"track_work\"},{\"name\":\"untrack_work\"},{\"name\":\"list_tracked_work\"},{\"name\":\"wait\"},{\"name\":\"background_wait\"},{\"name\":\"list_projects\"},{\"name\":\"list_tasks\"},{\"name\":\"get_task\"},{\"name\":\"get_task_field\"},{\"name\":\"create_task\"},{\"name\":\"update_task\"},{\"name\":\"delete_task\"},{\"name\":\"list_pens\"},{\"name\":\"create_pen\"},{\"name\":\"update_pen\"},{\"name\":\"delete_pen\"},{\"name\":\"send_to_task\"},{\"name\":\"get_project\"},{\"name\":\"update_project\"},{\"name\":\"create_project\"},{\"name\":\"list_automations\"},{\"name\":\"create_automation\"},{\"name\":\"update_automation\"},{\"name\":\"delete_automation\"},{\"name\":\"run_automation\"},{\"name\":\"list_workflows\"},{\"name\":\"create_workflow\"},{\"name\":\"update_workflow\"},{\"name\":\"delete_workflow\"},{\"name\":\"run_workflow\"}]}}}}}\n{\"type\":\"user\",\"uuid\":\"PROMPT\",\"message\":{\"role\":\"user\",\"content\":\"# WEB-1: Fix it\\n\\n---\\n\\nStart working on this task.\\n\\nhello\\n\"}}\n",
      "awaited": "PROMPT",
      "input": true,
      "mcp": {
        "mcpServers": {
          "docs": {
            "headers": {
              "Authorization": "Bearer SECRET"
            },
            "type": "http",
            "url": "/api/mcp/RUN/docs"
          },
          "gh": {
            "headers": {
              "Authorization": "Bearer SECRET"
            },
            "timeout": 900000,
            "type": "http",
            "url": "/api/mcp/RUN/gh"
          }
        }
      },
      "mcpRun": {
        "cwd": "/repo",
        "github_account": null,
        "review": false,
        "in_process": true,
        "desktop": false
      }
    }
  },
  "a compaction": {
    "promptText": "/compact keep the API notes",
    "manifest": {
      "initializeResult": {
        "protocolVersion": "2025-11-25",
        "capabilities": {
          "tools": {}
        },
        "serverInfo": {
          "name": "huntaway",
          "version": "0.1.0"
        },
        "instructions": "Tools for the Huntaway board, a kanban board where each task is worked by its own Claude agent. The board has a profile for each Claude login (e.g. work, personal), each with its own projects and tasks. Besides your own profile's, you can use the boards of the profiles that let your agents in (each profile chooses which, in Settings → Profiles). list_projects shows every project you can use, labelled with its profile and host. The other tools take a project or task from any of them by id or key; an unqualified key means your own profile's board first, and one used on several other boards must be qualified as <profile>:<key> (e.g. work:SD-3) or with the profile argument. A task created in another profile's project runs under that profile's Claude login. Don't create a project the user refers to as if it existed: if list_projects doesn't show it, it may be on a profile's board you can't use, so ask the user. To split a piece of work into smaller tasks that are each reviewed and merged on their own and then land together, create them with merges_into that task (new subprojects can't be made any more); group related tasks, across projects too, in a pen."
      },
      "toolsListResult": {
        "tools": [
          {
            "name": "request_user_input"
          },
          {
            "name": "finish_work"
          },
          {
            "name": "track_work"
          },
          {
            "name": "untrack_work"
          },
          {
            "name": "list_tracked_work"
          },
          {
            "name": "wait"
          },
          {
            "name": "background_wait"
          },
          {
            "name": "list_projects"
          },
          {
            "name": "list_tasks"
          },
          {
            "name": "get_task"
          },
          {
            "name": "get_task_field"
          },
          {
            "name": "create_task"
          },
          {
            "name": "update_task"
          },
          {
            "name": "delete_task"
          },
          {
            "name": "list_pens"
          },
          {
            "name": "create_pen"
          },
          {
            "name": "update_pen"
          },
          {
            "name": "delete_pen"
          },
          {
            "name": "send_to_task"
          },
          {
            "name": "get_project"
          },
          {
            "name": "update_project"
          },
          {
            "name": "create_project"
          },
          {
            "name": "list_automations"
          },
          {
            "name": "create_automation"
          },
          {
            "name": "update_automation"
          },
          {
            "name": "delete_automation"
          },
          {
            "name": "run_automation"
          },
          {
            "name": "list_workflows"
          },
          {
            "name": "create_workflow"
          },
          {
            "name": "update_workflow"
          },
          {
            "name": "delete_workflow"
          },
          {
            "name": "run_workflow"
          }
        ]
      }
    },
    "task": {
      "kind": "task",
      "merging": false,
      "session_id": "s1"
    },
    "expected": {
      "program": "claude",
      "args": [
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
        "--append-system-prompt-file",
        "/data/runs/RUN/system-prompt.md",
        "--permission-mode",
        "default",
        "--settings",
        "{\"hooks\":{\"PreToolUse\":[{\"matcher\":\"Bash\",\"hooks\":[{\"type\":\"command\",\"command\":\"'/opt/huntaway/bin/huntaway' gh-hook\",\"timeout\":10}]}]}}",
        "--allowedTools",
        "mcp__huntaway",
        "mcp__docs",
        "mcp__gh__pr_view",
        "mcp__gh__pr_list",
        "mcp__gh__pr_checks",
        "mcp__gh__pr_diff",
        "mcp__gh__issue_view",
        "mcp__gh__issue_list",
        "mcp__gh__run_list",
        "mcp__gh__run_view",
        "--resume",
        "s1",
        "--model",
        "opus",
        "--effort",
        "high",
        "--add-dir",
        "/tmp/ha-0/TASKTMP",
        "--mcp-config",
        "/data/runs/RUN/mcp.json"
      ],
      "env": {
        "CLAUDE_CODE_ENABLE_TASKS": "0",
        "CLAUDE_CODE_ENABLE_TODO_TOOLS": "1",
        "HUNTAWAY_TASK_ID": "TASK",
        "MCP_TOOL_TIMEOUT": "86400000",
        "TMPDIR": "/tmp/ha-0/TASKTMP"
      },
      "cwd": "/repo",
      "spec": {
        "args": [
          "-p",
          "--output-format",
          "stream-json",
          "--verbose",
          "--include-partial-messages",
          "--append-system-prompt-file",
          "/data/runs/RUN/system-prompt.md",
          "--permission-mode",
          "default",
          "--settings",
          "{\"hooks\":{\"PreToolUse\":[{\"matcher\":\"Bash\",\"hooks\":[{\"type\":\"command\",\"command\":\"'/opt/huntaway/bin/huntaway' gh-hook\",\"timeout\":10}]}]}}",
          "--allowedTools",
          "mcp__huntaway",
          "mcp__docs",
          "mcp__gh__pr_view",
          "mcp__gh__pr_list",
          "mcp__gh__pr_checks",
          "mcp__gh__pr_diff",
          "mcp__gh__issue_view",
          "mcp__gh__issue_list",
          "mcp__gh__run_list",
          "mcp__gh__run_view",
          "--resume",
          "s1",
          "--model",
          "opus",
          "--effort",
          "high",
          "--add-dir",
          "/tmp/ha-0/TASKTMP",
          "--mcp-config",
          "/data/runs/RUN/mcp.json"
        ],
        "config_dir": null,
        "cwd": "/repo"
      },
      "prompt": "/compact keep the API notes",
      "awaited": null,
      "input": false,
      "mcp": {
        "mcpServers": {
          "docs": {
            "headers": {
              "Authorization": "Bearer SECRET"
            },
            "type": "http",
            "url": "/api/mcp/RUN/docs"
          },
          "gh": {
            "headers": {
              "Authorization": "Bearer SECRET"
            },
            "timeout": 900000,
            "type": "http",
            "url": "/api/mcp/RUN/gh"
          },
          "huntaway": {
            "headers": {
              "Authorization": "Bearer SECRET"
            },
            "timeout": 86400000,
            "type": "http",
            "url": "/api/mcp/RUN/huntaway"
          }
        }
      },
      "mcpRun": {
        "cwd": "/repo",
        "github_account": null,
        "review": false,
        "in_process": false,
        "desktop": false
      }
    }
  },
  "a labelled task": {
    "promptText": "# WEB-1: Fix it\n\n---\n\nStart working on this task.\n\nhello\n",
    "manifest": {
      "initializeResult": {
        "protocolVersion": "2025-11-25",
        "capabilities": {
          "tools": {}
        },
        "serverInfo": {
          "name": "huntaway",
          "version": "0.1.0"
        },
        "instructions": "Tools for the Huntaway board, a kanban board where each task is worked by its own Claude agent. The board has a profile for each Claude login (e.g. work, personal), each with its own projects and tasks. Besides your own profile's, you can use the boards of the profiles that let your agents in (each profile chooses which, in Settings → Profiles). list_projects shows every project you can use, labelled with its profile and host. The other tools take a project or task from any of them by id or key; an unqualified key means your own profile's board first, and one used on several other boards must be qualified as <profile>:<key> (e.g. work:SD-3) or with the profile argument. A task created in another profile's project runs under that profile's Claude login. Don't create a project the user refers to as if it existed: if list_projects doesn't show it, it may be on a profile's board you can't use, so ask the user. To split a piece of work into smaller tasks that are each reviewed and merged on their own and then land together, create them with merges_into that task (new subprojects can't be made any more); group related tasks, across projects too, in a pen."
      },
      "toolsListResult": {
        "tools": [
          {
            "name": "request_user_input"
          },
          {
            "name": "finish_work"
          },
          {
            "name": "track_work"
          },
          {
            "name": "untrack_work"
          },
          {
            "name": "list_tracked_work"
          },
          {
            "name": "wait"
          },
          {
            "name": "background_wait"
          },
          {
            "name": "list_projects"
          },
          {
            "name": "list_tasks"
          },
          {
            "name": "get_task"
          },
          {
            "name": "get_task_field"
          },
          {
            "name": "create_task"
          },
          {
            "name": "update_task"
          },
          {
            "name": "delete_task"
          },
          {
            "name": "list_pens"
          },
          {
            "name": "create_pen"
          },
          {
            "name": "update_pen"
          },
          {
            "name": "delete_pen"
          },
          {
            "name": "send_to_task"
          },
          {
            "name": "get_project"
          },
          {
            "name": "update_project"
          },
          {
            "name": "create_project"
          },
          {
            "name": "list_automations"
          },
          {
            "name": "create_automation"
          },
          {
            "name": "update_automation"
          },
          {
            "name": "delete_automation"
          },
          {
            "name": "run_automation"
          },
          {
            "name": "list_workflows"
          },
          {
            "name": "create_workflow"
          },
          {
            "name": "update_workflow"
          },
          {
            "name": "delete_workflow"
          },
          {
            "name": "run_workflow"
          }
        ]
      }
    },
    "task": {
      "kind": "task",
      "merging": false,
      "session_id": null
    },
    "expected": {
      "program": "claude",
      "args": [
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
        "--input-format",
        "stream-json",
        "--replay-user-messages",
        "--append-system-prompt-file",
        "/data/runs/RUN/system-prompt.md",
        "--permission-mode",
        "default",
        "--permission-prompt-tool",
        "stdio",
        "--settings",
        "{\"hooks\":{\"PreToolUse\":[{\"matcher\":\"Bash\",\"hooks\":[{\"type\":\"command\",\"command\":\"'/opt/huntaway/bin/huntaway' gh-hook\",\"timeout\":10}]}]}}",
        "--allowedTools",
        "mcp__huntaway",
        "mcp__docs",
        "mcp__gh__pr_view",
        "mcp__gh__pr_list",
        "mcp__gh__pr_checks",
        "mcp__gh__pr_diff",
        "mcp__gh__issue_view",
        "mcp__gh__issue_list",
        "mcp__gh__run_list",
        "mcp__gh__run_view",
        "--model",
        "opus",
        "--effort",
        "high",
        "--add-dir",
        "/data/documents/TASK",
        "--add-dir",
        "/tmp/ha-0/TASKTMP",
        "--mcp-config",
        "/data/runs/RUN/mcp.json"
      ],
      "env": {
        "CLAUDE_CODE_ENABLE_TASKS": "0",
        "CLAUDE_CODE_ENABLE_TODO_TOOLS": "1",
        "HUNTAWAY_TASK_ID": "TASK",
        "MCP_TOOL_TIMEOUT": "86400000",
        "TMPDIR": "/tmp/ha-0/TASKTMP"
      },
      "cwd": "/repo",
      "spec": {
        "args": [
          "-p",
          "--output-format",
          "stream-json",
          "--verbose",
          "--include-partial-messages",
          "--input-format",
          "stream-json",
          "--replay-user-messages",
          "--append-system-prompt-file",
          "/data/runs/RUN/system-prompt.md",
          "--permission-mode",
          "default",
          "--permission-prompt-tool",
          "stdio",
          "--settings",
          "{\"hooks\":{\"PreToolUse\":[{\"matcher\":\"Bash\",\"hooks\":[{\"type\":\"command\",\"command\":\"'/opt/huntaway/bin/huntaway' gh-hook\",\"timeout\":10}]}]}}",
          "--allowedTools",
          "mcp__huntaway",
          "mcp__docs",
          "mcp__gh__pr_view",
          "mcp__gh__pr_list",
          "mcp__gh__pr_checks",
          "mcp__gh__pr_diff",
          "mcp__gh__issue_view",
          "mcp__gh__issue_list",
          "mcp__gh__run_list",
          "mcp__gh__run_view",
          "--model",
          "opus",
          "--effort",
          "high",
          "--add-dir",
          "/data/documents/TASK",
          "--add-dir",
          "/tmp/ha-0/TASKTMP",
          "--mcp-config",
          "/data/runs/RUN/mcp.json"
        ],
        "config_dir": null,
        "cwd": "/repo"
      },
      "prompt": "{\"type\":\"control_request\",\"request_id\":\"huntaway-init-RUN\",\"request\":{\"subtype\":\"initialize\",\"sdkMcpServers\":[\"huntaway\"],\"sdkMcpServerConfigs\":{\"huntaway\":{\"timeout\":86400000,\"disableAutoBackground\":true}},\"sdkMcpServerManifests\":{\"huntaway\":{\"initializeResult\":{\"protocolVersion\":\"2025-11-25\",\"capabilities\":{\"tools\":{}},\"serverInfo\":{\"name\":\"huntaway\",\"version\":\"0.1.0\"},\"instructions\":\"Tools for the Huntaway board, a kanban board where each task is worked by its own Claude agent. The board has a profile for each Claude login (e.g. work, personal), each with its own projects and tasks. Besides your own profile's, you can use the boards of the profiles that let your agents in (each profile chooses which, in Settings → Profiles). list_projects shows every project you can use, labelled with its profile and host. The other tools take a project or task from any of them by id or key; an unqualified key means your own profile's board first, and one used on several other boards must be qualified as <profile>:<key> (e.g. work:SD-3) or with the profile argument. A task created in another profile's project runs under that profile's Claude login. Don't create a project the user refers to as if it existed: if list_projects doesn't show it, it may be on a profile's board you can't use, so ask the user. To split a piece of work into smaller tasks that are each reviewed and merged on their own and then land together, create them with merges_into that task (new subprojects can't be made any more); group related tasks, across projects too, in a pen.\"},\"toolsListResult\":{\"tools\":[{\"name\":\"request_user_input\"},{\"name\":\"finish_work\"},{\"name\":\"track_work\"},{\"name\":\"untrack_work\"},{\"name\":\"list_tracked_work\"},{\"name\":\"wait\"},{\"name\":\"background_wait\"},{\"name\":\"list_projects\"},{\"name\":\"list_tasks\"},{\"name\":\"get_task\"},{\"name\":\"get_task_field\"},{\"name\":\"create_task\"},{\"name\":\"update_task\"},{\"name\":\"delete_task\"},{\"name\":\"list_pens\"},{\"name\":\"create_pen\"},{\"name\":\"update_pen\"},{\"name\":\"delete_pen\"},{\"name\":\"send_to_task\"},{\"name\":\"get_project\"},{\"name\":\"update_project\"},{\"name\":\"create_project\"},{\"name\":\"list_automations\"},{\"name\":\"create_automation\"},{\"name\":\"update_automation\"},{\"name\":\"delete_automation\"},{\"name\":\"run_automation\"},{\"name\":\"list_workflows\"},{\"name\":\"create_workflow\"},{\"name\":\"update_workflow\"},{\"name\":\"delete_workflow\"},{\"name\":\"run_workflow\"}]}}}}}\n{\"type\":\"user\",\"uuid\":\"PROMPT\",\"message\":{\"role\":\"user\",\"content\":\"# WEB-1: Fix it\\n\\n---\\n\\nStart working on this task.\\n\\nhello\\n\"}}\n",
      "awaited": "PROMPT",
      "input": true,
      "mcp": {
        "mcpServers": {
          "docs": {
            "headers": {
              "Authorization": "Bearer SECRET"
            },
            "type": "http",
            "url": "/api/mcp/RUN/docs"
          },
          "gh": {
            "headers": {
              "Authorization": "Bearer SECRET"
            },
            "timeout": 900000,
            "type": "http",
            "url": "/api/mcp/RUN/gh"
          }
        }
      },
      "mcpRun": {
        "cwd": "/repo",
        "github_account": null,
        "review": false,
        "in_process": true,
        "desktop": false
      }
    }
  },
  "a review thread": {
    "promptText": "hello",
    "manifest": {
      "initializeResult": {
        "protocolVersion": "2025-11-25",
        "capabilities": {
          "tools": {}
        },
        "serverInfo": {
          "name": "huntaway",
          "version": "0.1.0"
        },
        "instructions": "Tools for the Huntaway board, a kanban board where each task is worked by its own Claude agent. The board has a profile for each Claude login (e.g. work, personal), each with its own projects and tasks. Besides your own profile's, you can use the boards of the profiles that let your agents in (each profile chooses which, in Settings → Profiles). list_projects shows every project you can use, labelled with its profile and host. The other tools take a project or task from any of them by id or key; an unqualified key means your own profile's board first, and one used on several other boards must be qualified as <profile>:<key> (e.g. work:SD-3) or with the profile argument. A task created in another profile's project runs under that profile's Claude login. Don't create a project the user refers to as if it existed: if list_projects doesn't show it, it may be on a profile's board you can't use, so ask the user. To split a piece of work into smaller tasks that are each reviewed and merged on their own and then land together, create them with merges_into that task (new subprojects can't be made any more); group related tasks, across projects too, in a pen."
      },
      "toolsListResult": {
        "tools": [
          {
            "name": "request_user_input"
          },
          {
            "name": "wait"
          },
          {
            "name": "background_wait"
          },
          {
            "name": "list_projects"
          },
          {
            "name": "list_tasks"
          },
          {
            "name": "get_task"
          },
          {
            "name": "get_task_field"
          },
          {
            "name": "get_project"
          },
          {
            "name": "submit_review"
          }
        ]
      }
    },
    "task": {
      "kind": "review",
      "merging": false,
      "session_id": null
    },
    "expected": {
      "program": "claude",
      "args": [
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
        "--input-format",
        "stream-json",
        "--replay-user-messages",
        "--append-system-prompt-file",
        "/data/runs/RUN/system-prompt.md",
        "--permission-mode",
        "default",
        "--permission-prompt-tool",
        "stdio",
        "--settings",
        "{\"hooks\":{\"PreToolUse\":[{\"matcher\":\"Bash\",\"hooks\":[{\"type\":\"command\",\"command\":\"'/opt/huntaway/bin/huntaway' gh-hook\",\"timeout\":10}]}]}}",
        "--allowedTools",
        "mcp__huntaway",
        "mcp__docs",
        "mcp__gh__pr_view",
        "mcp__gh__pr_list",
        "mcp__gh__pr_checks",
        "mcp__gh__pr_diff",
        "mcp__gh__issue_view",
        "mcp__gh__issue_list",
        "mcp__gh__run_list",
        "mcp__gh__run_view",
        "Read",
        "Grep",
        "Glob",
        "Skill",
        "Agent",
        "Task",
        "Bash(git diff:*)",
        "Bash(git log:*)",
        "Bash(git show:*)",
        "Bash(git status:*)",
        "Bash(git merge-base:*)",
        "Bash(git rev-parse:*)",
        "Bash(gh pr view:*)",
        "Bash(gh pr diff:*)",
        "Bash(gh pr list:*)",
        "Bash(gh pr checks:*)",
        "--disallowedTools",
        "Edit Write NotebookEdit mcp__gh__pr_create mcp__gh__pr_comment mcp__gh__pr_edit mcp__gh__pr_merge mcp__gh__issue_create mcp__gh__issue_comment mcp__gh__api mcp__gh__gh mcp__gh__git_push",
        "--model",
        "opus",
        "--effort",
        "high",
        "--add-dir",
        "/tmp/ha-0/TASKTMP",
        "--mcp-config",
        "/data/runs/RUN/mcp.json"
      ],
      "env": {
        "CLAUDE_CODE_ENABLE_TASKS": "0",
        "CLAUDE_CODE_ENABLE_TODO_TOOLS": "1",
        "HUNTAWAY_TASK_ID": "TASK",
        "MCP_TOOL_TIMEOUT": "86400000",
        "TMPDIR": "/tmp/ha-0/TASKTMP"
      },
      "cwd": "/repo",
      "spec": {
        "args": [
          "-p",
          "--output-format",
          "stream-json",
          "--verbose",
          "--include-partial-messages",
          "--input-format",
          "stream-json",
          "--replay-user-messages",
          "--append-system-prompt-file",
          "/data/runs/RUN/system-prompt.md",
          "--permission-mode",
          "default",
          "--permission-prompt-tool",
          "stdio",
          "--settings",
          "{\"hooks\":{\"PreToolUse\":[{\"matcher\":\"Bash\",\"hooks\":[{\"type\":\"command\",\"command\":\"'/opt/huntaway/bin/huntaway' gh-hook\",\"timeout\":10}]}]}}",
          "--allowedTools",
          "mcp__huntaway",
          "mcp__docs",
          "mcp__gh__pr_view",
          "mcp__gh__pr_list",
          "mcp__gh__pr_checks",
          "mcp__gh__pr_diff",
          "mcp__gh__issue_view",
          "mcp__gh__issue_list",
          "mcp__gh__run_list",
          "mcp__gh__run_view",
          "Read",
          "Grep",
          "Glob",
          "Skill",
          "Agent",
          "Task",
          "Bash(git diff:*)",
          "Bash(git log:*)",
          "Bash(git show:*)",
          "Bash(git status:*)",
          "Bash(git merge-base:*)",
          "Bash(git rev-parse:*)",
          "Bash(gh pr view:*)",
          "Bash(gh pr diff:*)",
          "Bash(gh pr list:*)",
          "Bash(gh pr checks:*)",
          "--disallowedTools",
          "Edit Write NotebookEdit mcp__gh__pr_create mcp__gh__pr_comment mcp__gh__pr_edit mcp__gh__pr_merge mcp__gh__issue_create mcp__gh__issue_comment mcp__gh__api mcp__gh__gh mcp__gh__git_push",
          "--model",
          "opus",
          "--effort",
          "high",
          "--add-dir",
          "/tmp/ha-0/TASKTMP",
          "--mcp-config",
          "/data/runs/RUN/mcp.json"
        ],
        "config_dir": null,
        "cwd": "/repo"
      },
      "prompt": "{\"type\":\"control_request\",\"request_id\":\"huntaway-init-RUN\",\"request\":{\"subtype\":\"initialize\",\"sdkMcpServers\":[\"huntaway\"],\"sdkMcpServerConfigs\":{\"huntaway\":{\"timeout\":86400000,\"disableAutoBackground\":true}},\"sdkMcpServerManifests\":{\"huntaway\":{\"initializeResult\":{\"protocolVersion\":\"2025-11-25\",\"capabilities\":{\"tools\":{}},\"serverInfo\":{\"name\":\"huntaway\",\"version\":\"0.1.0\"},\"instructions\":\"Tools for the Huntaway board, a kanban board where each task is worked by its own Claude agent. The board has a profile for each Claude login (e.g. work, personal), each with its own projects and tasks. Besides your own profile's, you can use the boards of the profiles that let your agents in (each profile chooses which, in Settings → Profiles). list_projects shows every project you can use, labelled with its profile and host. The other tools take a project or task from any of them by id or key; an unqualified key means your own profile's board first, and one used on several other boards must be qualified as <profile>:<key> (e.g. work:SD-3) or with the profile argument. A task created in another profile's project runs under that profile's Claude login. Don't create a project the user refers to as if it existed: if list_projects doesn't show it, it may be on a profile's board you can't use, so ask the user. To split a piece of work into smaller tasks that are each reviewed and merged on their own and then land together, create them with merges_into that task (new subprojects can't be made any more); group related tasks, across projects too, in a pen.\"},\"toolsListResult\":{\"tools\":[{\"name\":\"request_user_input\"},{\"name\":\"wait\"},{\"name\":\"background_wait\"},{\"name\":\"list_projects\"},{\"name\":\"list_tasks\"},{\"name\":\"get_task\"},{\"name\":\"get_task_field\"},{\"name\":\"get_project\"},{\"name\":\"submit_review\"}]}}}}}\n{\"type\":\"user\",\"uuid\":\"PROMPT\",\"message\":{\"role\":\"user\",\"content\":\"hello\"}}\n",
      "awaited": "PROMPT",
      "input": true,
      "mcp": {
        "mcpServers": {
          "docs": {
            "headers": {
              "Authorization": "Bearer SECRET"
            },
            "type": "http",
            "url": "/api/mcp/RUN/docs"
          },
          "gh": {
            "headers": {
              "Authorization": "Bearer SECRET"
            },
            "timeout": 900000,
            "type": "http",
            "url": "/api/mcp/RUN/gh"
          }
        }
      },
      "mcpRun": {
        "cwd": "/repo",
        "github_account": null,
        "review": true,
        "in_process": true,
        "desktop": false
      }
    }
  },
  "a scratch task": {
    "promptText": "# T-0: Fix it\n\n---\n\nStart working on this task.\n\nhello\n",
    "manifest": {
      "initializeResult": {
        "protocolVersion": "2025-11-25",
        "capabilities": {
          "tools": {}
        },
        "serverInfo": {
          "name": "huntaway",
          "version": "0.1.0"
        },
        "instructions": "Tools for the Huntaway board, a kanban board where each task is worked by its own Claude agent. The board has a profile for each Claude login (e.g. work, personal), each with its own projects and tasks. Besides your own profile's, you can use the boards of the profiles that let your agents in (each profile chooses which, in Settings → Profiles). list_projects shows every project you can use, labelled with its profile and host. The other tools take a project or task from any of them by id or key; an unqualified key means your own profile's board first, and one used on several other boards must be qualified as <profile>:<key> (e.g. work:SD-3) or with the profile argument. A task created in another profile's project runs under that profile's Claude login. Don't create a project the user refers to as if it existed: if list_projects doesn't show it, it may be on a profile's board you can't use, so ask the user. To split a piece of work into smaller tasks that are each reviewed and merged on their own and then land together, create them with merges_into that task (new subprojects can't be made any more); group related tasks, across projects too, in a pen."
      },
      "toolsListResult": {
        "tools": [
          {
            "name": "request_user_input"
          },
          {
            "name": "finish_work"
          },
          {
            "name": "track_work"
          },
          {
            "name": "untrack_work"
          },
          {
            "name": "list_tracked_work"
          },
          {
            "name": "wait"
          },
          {
            "name": "background_wait"
          },
          {
            "name": "list_projects"
          },
          {
            "name": "list_tasks"
          },
          {
            "name": "get_task"
          },
          {
            "name": "get_task_field"
          },
          {
            "name": "create_task"
          },
          {
            "name": "update_task"
          },
          {
            "name": "delete_task"
          },
          {
            "name": "list_pens"
          },
          {
            "name": "create_pen"
          },
          {
            "name": "update_pen"
          },
          {
            "name": "delete_pen"
          },
          {
            "name": "send_to_task"
          },
          {
            "name": "get_project"
          },
          {
            "name": "update_project"
          },
          {
            "name": "create_project"
          },
          {
            "name": "list_automations"
          },
          {
            "name": "create_automation"
          },
          {
            "name": "update_automation"
          },
          {
            "name": "delete_automation"
          },
          {
            "name": "run_automation"
          },
          {
            "name": "list_workflows"
          },
          {
            "name": "create_workflow"
          },
          {
            "name": "update_workflow"
          },
          {
            "name": "delete_workflow"
          },
          {
            "name": "run_workflow"
          }
        ]
      }
    },
    "task": {
      "kind": "task",
      "merging": false,
      "session_id": null
    },
    "expected": {
      "program": "claude",
      "args": [
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
        "--input-format",
        "stream-json",
        "--replay-user-messages",
        "--append-system-prompt-file",
        "/data/runs/RUN/system-prompt.md",
        "--permission-mode",
        "default",
        "--permission-prompt-tool",
        "stdio",
        "--settings",
        "{\"hooks\":{\"PreToolUse\":[{\"matcher\":\"Bash\",\"hooks\":[{\"type\":\"command\",\"command\":\"'/opt/huntaway/bin/huntaway' gh-hook\",\"timeout\":10}]}]}}",
        "--allowedTools",
        "mcp__huntaway",
        "mcp__docs",
        "mcp__gh__pr_view",
        "mcp__gh__pr_list",
        "mcp__gh__pr_checks",
        "mcp__gh__pr_diff",
        "mcp__gh__issue_view",
        "mcp__gh__issue_list",
        "mcp__gh__run_list",
        "mcp__gh__run_view",
        "--model",
        "opus",
        "--effort",
        "high",
        "--add-dir",
        "/tmp/ha-0/TASKTMP",
        "--mcp-config",
        "/data/runs/RUN/mcp.json"
      ],
      "env": {
        "CLAUDE_CODE_ENABLE_TASKS": "0",
        "CLAUDE_CODE_ENABLE_TODO_TOOLS": "1",
        "HUNTAWAY_TASK_ID": "TASK",
        "MCP_TOOL_TIMEOUT": "86400000",
        "TMPDIR": "/tmp/ha-0/TASKTMP"
      },
      "cwd": "/data/profiles/2aa06063-514e-4f16-9759-19a2db28d7c4/scratch",
      "spec": {
        "args": [
          "-p",
          "--output-format",
          "stream-json",
          "--verbose",
          "--include-partial-messages",
          "--input-format",
          "stream-json",
          "--replay-user-messages",
          "--append-system-prompt-file",
          "/data/runs/RUN/system-prompt.md",
          "--permission-mode",
          "default",
          "--permission-prompt-tool",
          "stdio",
          "--settings",
          "{\"hooks\":{\"PreToolUse\":[{\"matcher\":\"Bash\",\"hooks\":[{\"type\":\"command\",\"command\":\"'/opt/huntaway/bin/huntaway' gh-hook\",\"timeout\":10}]}]}}",
          "--allowedTools",
          "mcp__huntaway",
          "mcp__docs",
          "mcp__gh__pr_view",
          "mcp__gh__pr_list",
          "mcp__gh__pr_checks",
          "mcp__gh__pr_diff",
          "mcp__gh__issue_view",
          "mcp__gh__issue_list",
          "mcp__gh__run_list",
          "mcp__gh__run_view",
          "--model",
          "opus",
          "--effort",
          "high",
          "--add-dir",
          "/tmp/ha-0/TASKTMP",
          "--mcp-config",
          "/data/runs/RUN/mcp.json"
        ],
        "config_dir": null,
        "cwd": "/data/profiles/2aa06063-514e-4f16-9759-19a2db28d7c4/scratch"
      },
      "prompt": "{\"type\":\"control_request\",\"request_id\":\"huntaway-init-RUN\",\"request\":{\"subtype\":\"initialize\",\"sdkMcpServers\":[\"huntaway\"],\"sdkMcpServerConfigs\":{\"huntaway\":{\"timeout\":86400000,\"disableAutoBackground\":true}},\"sdkMcpServerManifests\":{\"huntaway\":{\"initializeResult\":{\"protocolVersion\":\"2025-11-25\",\"capabilities\":{\"tools\":{}},\"serverInfo\":{\"name\":\"huntaway\",\"version\":\"0.1.0\"},\"instructions\":\"Tools for the Huntaway board, a kanban board where each task is worked by its own Claude agent. The board has a profile for each Claude login (e.g. work, personal), each with its own projects and tasks. Besides your own profile's, you can use the boards of the profiles that let your agents in (each profile chooses which, in Settings → Profiles). list_projects shows every project you can use, labelled with its profile and host. The other tools take a project or task from any of them by id or key; an unqualified key means your own profile's board first, and one used on several other boards must be qualified as <profile>:<key> (e.g. work:SD-3) or with the profile argument. A task created in another profile's project runs under that profile's Claude login. Don't create a project the user refers to as if it existed: if list_projects doesn't show it, it may be on a profile's board you can't use, so ask the user. To split a piece of work into smaller tasks that are each reviewed and merged on their own and then land together, create them with merges_into that task (new subprojects can't be made any more); group related tasks, across projects too, in a pen.\"},\"toolsListResult\":{\"tools\":[{\"name\":\"request_user_input\"},{\"name\":\"finish_work\"},{\"name\":\"track_work\"},{\"name\":\"untrack_work\"},{\"name\":\"list_tracked_work\"},{\"name\":\"wait\"},{\"name\":\"background_wait\"},{\"name\":\"list_projects\"},{\"name\":\"list_tasks\"},{\"name\":\"get_task\"},{\"name\":\"get_task_field\"},{\"name\":\"create_task\"},{\"name\":\"update_task\"},{\"name\":\"delete_task\"},{\"name\":\"list_pens\"},{\"name\":\"create_pen\"},{\"name\":\"update_pen\"},{\"name\":\"delete_pen\"},{\"name\":\"send_to_task\"},{\"name\":\"get_project\"},{\"name\":\"update_project\"},{\"name\":\"create_project\"},{\"name\":\"list_automations\"},{\"name\":\"create_automation\"},{\"name\":\"update_automation\"},{\"name\":\"delete_automation\"},{\"name\":\"run_automation\"},{\"name\":\"list_workflows\"},{\"name\":\"create_workflow\"},{\"name\":\"update_workflow\"},{\"name\":\"delete_workflow\"},{\"name\":\"run_workflow\"}]}}}}}\n{\"type\":\"user\",\"uuid\":\"PROMPT\",\"message\":{\"role\":\"user\",\"content\":\"# T-0: Fix it\\n\\n---\\n\\nStart working on this task.\\n\\nhello\\n\"}}\n",
      "awaited": "PROMPT",
      "input": true,
      "mcp": {
        "mcpServers": {
          "docs": {
            "headers": {
              "Authorization": "Bearer SECRET"
            },
            "type": "http",
            "url": "/api/mcp/RUN/docs"
          },
          "gh": {
            "headers": {
              "Authorization": "Bearer SECRET"
            },
            "timeout": 900000,
            "type": "http",
            "url": "/api/mcp/RUN/gh"
          }
        }
      },
      "mcpRun": {
        "cwd": "/data/profiles/2aa06063-514e-4f16-9759-19a2db28d7c4/scratch",
        "github_account": null,
        "review": false,
        "in_process": true,
        "desktop": false
      }
    }
  },
  "a config with its own folder and a proxy": {
    "promptText": "# WEB-1: Fix it\n\n---\n\nStart working on this task.\n\nhello\n",
    "manifest": {
      "initializeResult": {
        "protocolVersion": "2025-11-25",
        "capabilities": {
          "tools": {}
        },
        "serverInfo": {
          "name": "huntaway",
          "version": "0.1.0"
        },
        "instructions": "Tools for the Huntaway board, a kanban board where each task is worked by its own Claude agent. The board has a profile for each Claude login (e.g. work, personal), each with its own projects and tasks. Besides your own profile's, you can use the boards of the profiles that let your agents in (each profile chooses which, in Settings → Profiles). list_projects shows every project you can use, labelled with its profile and host. The other tools take a project or task from any of them by id or key; an unqualified key means your own profile's board first, and one used on several other boards must be qualified as <profile>:<key> (e.g. work:SD-3) or with the profile argument. A task created in another profile's project runs under that profile's Claude login. Don't create a project the user refers to as if it existed: if list_projects doesn't show it, it may be on a profile's board you can't use, so ask the user. To split a piece of work into smaller tasks that are each reviewed and merged on their own and then land together, create them with merges_into that task (new subprojects can't be made any more); group related tasks, across projects too, in a pen."
      },
      "toolsListResult": {
        "tools": [
          {
            "name": "request_user_input"
          },
          {
            "name": "finish_work"
          },
          {
            "name": "track_work"
          },
          {
            "name": "untrack_work"
          },
          {
            "name": "list_tracked_work"
          },
          {
            "name": "wait"
          },
          {
            "name": "background_wait"
          },
          {
            "name": "list_projects"
          },
          {
            "name": "list_tasks"
          },
          {
            "name": "get_task"
          },
          {
            "name": "get_task_field"
          },
          {
            "name": "create_task"
          },
          {
            "name": "update_task"
          },
          {
            "name": "delete_task"
          },
          {
            "name": "list_pens"
          },
          {
            "name": "create_pen"
          },
          {
            "name": "update_pen"
          },
          {
            "name": "delete_pen"
          },
          {
            "name": "send_to_task"
          },
          {
            "name": "get_project"
          },
          {
            "name": "update_project"
          },
          {
            "name": "create_project"
          },
          {
            "name": "list_automations"
          },
          {
            "name": "create_automation"
          },
          {
            "name": "update_automation"
          },
          {
            "name": "delete_automation"
          },
          {
            "name": "run_automation"
          },
          {
            "name": "list_workflows"
          },
          {
            "name": "create_workflow"
          },
          {
            "name": "update_workflow"
          },
          {
            "name": "delete_workflow"
          },
          {
            "name": "run_workflow"
          }
        ]
      }
    },
    "task": {
      "kind": "task",
      "merging": false,
      "session_id": null
    },
    "expected": {
      "program": "claude",
      "args": [
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
        "--input-format",
        "stream-json",
        "--replay-user-messages",
        "--append-system-prompt-file",
        "/data/runs/RUN/system-prompt.md",
        "--permission-mode",
        "default",
        "--permission-prompt-tool",
        "stdio",
        "--settings",
        "{\"hooks\":{\"PreToolUse\":[{\"matcher\":\"Bash\",\"hooks\":[{\"type\":\"command\",\"command\":\"'/opt/huntaway/bin/huntaway' gh-hook\",\"timeout\":10}]}]}}",
        "--allowedTools",
        "mcp__huntaway",
        "mcp__docs",
        "mcp__gh__pr_view",
        "mcp__gh__pr_list",
        "mcp__gh__pr_checks",
        "mcp__gh__pr_diff",
        "mcp__gh__issue_view",
        "mcp__gh__issue_list",
        "mcp__gh__run_list",
        "mcp__gh__run_view",
        "--model",
        "opus",
        "--effort",
        "high",
        "--add-dir",
        "/tmp/ha-0/TASKTMP",
        "--mcp-config",
        "/data/runs/RUN/mcp.json"
      ],
      "env": {
        "ANTHROPIC_API_KEY": "",
        "ANTHROPIC_AUTH_TOKEN": "k-123",
        "ANTHROPIC_BASE_URL": "https://proxy.example/v1",
        "CLAUDE_CODE_ENABLE_TASKS": "0",
        "CLAUDE_CODE_ENABLE_TODO_TOOLS": "1",
        "CLAUDE_CONFIG_DIR": "/home/me/.claude-work",
        "HUNTAWAY_TASK_ID": "TASK",
        "MCP_TOOL_TIMEOUT": "86400000",
        "TMPDIR": "/tmp/ha-0/TASKTMP"
      },
      "cwd": "/repo",
      "spec": {
        "args": [
          "-p",
          "--output-format",
          "stream-json",
          "--verbose",
          "--include-partial-messages",
          "--input-format",
          "stream-json",
          "--replay-user-messages",
          "--append-system-prompt-file",
          "/data/runs/RUN/system-prompt.md",
          "--permission-mode",
          "default",
          "--permission-prompt-tool",
          "stdio",
          "--settings",
          "{\"hooks\":{\"PreToolUse\":[{\"matcher\":\"Bash\",\"hooks\":[{\"type\":\"command\",\"command\":\"'/opt/huntaway/bin/huntaway' gh-hook\",\"timeout\":10}]}]}}",
          "--allowedTools",
          "mcp__huntaway",
          "mcp__docs",
          "mcp__gh__pr_view",
          "mcp__gh__pr_list",
          "mcp__gh__pr_checks",
          "mcp__gh__pr_diff",
          "mcp__gh__issue_view",
          "mcp__gh__issue_list",
          "mcp__gh__run_list",
          "mcp__gh__run_view",
          "--model",
          "opus",
          "--effort",
          "high",
          "--add-dir",
          "/tmp/ha-0/TASKTMP",
          "--mcp-config",
          "/data/runs/RUN/mcp.json"
        ],
        "config_dir": "~/.claude-work",
        "cwd": "/repo"
      },
      "prompt": "{\"type\":\"control_request\",\"request_id\":\"huntaway-init-RUN\",\"request\":{\"subtype\":\"initialize\",\"sdkMcpServers\":[\"huntaway\"],\"sdkMcpServerConfigs\":{\"huntaway\":{\"timeout\":86400000,\"disableAutoBackground\":true}},\"sdkMcpServerManifests\":{\"huntaway\":{\"initializeResult\":{\"protocolVersion\":\"2025-11-25\",\"capabilities\":{\"tools\":{}},\"serverInfo\":{\"name\":\"huntaway\",\"version\":\"0.1.0\"},\"instructions\":\"Tools for the Huntaway board, a kanban board where each task is worked by its own Claude agent. The board has a profile for each Claude login (e.g. work, personal), each with its own projects and tasks. Besides your own profile's, you can use the boards of the profiles that let your agents in (each profile chooses which, in Settings → Profiles). list_projects shows every project you can use, labelled with its profile and host. The other tools take a project or task from any of them by id or key; an unqualified key means your own profile's board first, and one used on several other boards must be qualified as <profile>:<key> (e.g. work:SD-3) or with the profile argument. A task created in another profile's project runs under that profile's Claude login. Don't create a project the user refers to as if it existed: if list_projects doesn't show it, it may be on a profile's board you can't use, so ask the user. To split a piece of work into smaller tasks that are each reviewed and merged on their own and then land together, create them with merges_into that task (new subprojects can't be made any more); group related tasks, across projects too, in a pen.\"},\"toolsListResult\":{\"tools\":[{\"name\":\"request_user_input\"},{\"name\":\"finish_work\"},{\"name\":\"track_work\"},{\"name\":\"untrack_work\"},{\"name\":\"list_tracked_work\"},{\"name\":\"wait\"},{\"name\":\"background_wait\"},{\"name\":\"list_projects\"},{\"name\":\"list_tasks\"},{\"name\":\"get_task\"},{\"name\":\"get_task_field\"},{\"name\":\"create_task\"},{\"name\":\"update_task\"},{\"name\":\"delete_task\"},{\"name\":\"list_pens\"},{\"name\":\"create_pen\"},{\"name\":\"update_pen\"},{\"name\":\"delete_pen\"},{\"name\":\"send_to_task\"},{\"name\":\"get_project\"},{\"name\":\"update_project\"},{\"name\":\"create_project\"},{\"name\":\"list_automations\"},{\"name\":\"create_automation\"},{\"name\":\"update_automation\"},{\"name\":\"delete_automation\"},{\"name\":\"run_automation\"},{\"name\":\"list_workflows\"},{\"name\":\"create_workflow\"},{\"name\":\"update_workflow\"},{\"name\":\"delete_workflow\"},{\"name\":\"run_workflow\"}]}}}}}\n{\"type\":\"user\",\"uuid\":\"PROMPT\",\"message\":{\"role\":\"user\",\"content\":\"# WEB-1: Fix it\\n\\n---\\n\\nStart working on this task.\\n\\nhello\\n\"}}\n",
      "awaited": "PROMPT",
      "input": true,
      "mcp": {
        "mcpServers": {
          "docs": {
            "headers": {
              "Authorization": "Bearer SECRET"
            },
            "type": "http",
            "url": "/api/mcp/RUN/docs"
          },
          "gh": {
            "headers": {
              "Authorization": "Bearer SECRET"
            },
            "timeout": 900000,
            "type": "http",
            "url": "/api/mcp/RUN/gh"
          }
        }
      },
      "mcpRun": {
        "cwd": "/repo",
        "github_account": null,
        "review": false,
        "in_process": true,
        "desktop": false
      }
    }
  },
  "the assistant, with the default approval rules": {
    "promptText": "hello",
    "manifest": {
      "initializeResult": {
        "protocolVersion": "2025-11-25",
        "capabilities": {
          "tools": {}
        },
        "serverInfo": {
          "name": "huntaway",
          "version": "0.1.0"
        },
        "instructions": "Tools for the Huntaway board, a kanban board where each task is worked by its own Claude agent. The board has a profile for each Claude login (e.g. work, personal), each with its own projects and tasks. Besides your own profile's, you can use the boards of the profiles that let your agents in (each profile chooses which, in Settings → Profiles). list_projects shows every project you can use, labelled with its profile and host. The other tools take a project or task from any of them by id or key; an unqualified key means your own profile's board first, and one used on several other boards must be qualified as <profile>:<key> (e.g. work:SD-3) or with the profile argument. A task created in another profile's project runs under that profile's Claude login. Don't create a project the user refers to as if it existed: if list_projects doesn't show it, it may be on a profile's board you can't use, so ask the user. To split a piece of work into smaller tasks that are each reviewed and merged on their own and then land together, create them with merges_into that task (new subprojects can't be made any more); group related tasks, across projects too, in a pen."
      },
      "toolsListResult": {
        "tools": [
          {
            "name": "request_user_input"
          },
          {
            "name": "finish_work"
          },
          {
            "name": "track_work"
          },
          {
            "name": "untrack_work"
          },
          {
            "name": "list_tracked_work"
          },
          {
            "name": "wait"
          },
          {
            "name": "background_wait"
          },
          {
            "name": "list_projects"
          },
          {
            "name": "list_tasks"
          },
          {
            "name": "get_task"
          },
          {
            "name": "get_task_field"
          },
          {
            "name": "create_task"
          },
          {
            "name": "update_task"
          },
          {
            "name": "delete_task"
          },
          {
            "name": "list_pens"
          },
          {
            "name": "create_pen"
          },
          {
            "name": "update_pen"
          },
          {
            "name": "delete_pen"
          },
          {
            "name": "send_to_task"
          },
          {
            "name": "get_project"
          },
          {
            "name": "update_project"
          },
          {
            "name": "create_project"
          },
          {
            "name": "list_automations"
          },
          {
            "name": "create_automation"
          },
          {
            "name": "update_automation"
          },
          {
            "name": "delete_automation"
          },
          {
            "name": "run_automation"
          },
          {
            "name": "list_workflows"
          },
          {
            "name": "create_workflow"
          },
          {
            "name": "update_workflow"
          },
          {
            "name": "delete_workflow"
          },
          {
            "name": "run_workflow"
          }
        ]
      }
    },
    "task": {
      "kind": "task",
      "merging": false,
      "session_id": null
    },
    "expected": {
      "program": "claude",
      "args": [
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
        "--input-format",
        "stream-json",
        "--replay-user-messages",
        "--append-system-prompt-file",
        "/data/runs/RUN/system-prompt.md",
        "--permission-mode",
        "default",
        "--permission-prompt-tool",
        "stdio",
        "--settings",
        "{\"hooks\":{\"PreToolUse\":[{\"matcher\":\"Bash\",\"hooks\":[{\"type\":\"command\",\"command\":\"'/opt/huntaway/bin/huntaway' gh-hook\",\"timeout\":10}]},{\"matcher\":\"^(?:[mM][cC][pP]__[gG][oO][oO][gG][lL][eE](?:__[\\\\s\\\\S]*)?)$\",\"hooks\":[{\"type\":\"command\",\"command\":\"'/opt/huntaway/bin/huntaway' approval-hook '[{\\\"tool\\\":\\\"mcp__google__search*\\\",\\\"decision\\\":\\\"allow\\\"},{\\\"tool\\\":\\\"mcp__google__get*\\\",\\\"decision\\\":\\\"allow\\\"},{\\\"tool\\\":\\\"mcp__google__list*\\\",\\\"decision\\\":\\\"allow\\\"},{\\\"tool\\\":\\\"mcp__google__read*\\\",\\\"decision\\\":\\\"allow\\\"},{\\\"tool\\\":\\\"mcp__google__check*\\\",\\\"decision\\\":\\\"allow\\\"},{\\\"tool\\\":\\\"mcp__google__query*\\\",\\\"decision\\\":\\\"allow\\\"},{\\\"tool\\\":\\\"mcp__google__*draft*\\\",\\\"decision\\\":\\\"allow\\\"},{\\\"tool\\\":\\\"mcp__google__*send*\\\",\\\"decision\\\":\\\"ask\\\"},{\\\"tool\\\":\\\"mcp__google__create*event*\\\",\\\"decision\\\":\\\"ask\\\"},{\\\"tool\\\":\\\"mcp__google__modify*event*\\\",\\\"decision\\\":\\\"ask\\\"},{\\\"tool\\\":\\\"mcp__google__update*event*\\\",\\\"decision\\\":\\\"ask\\\"},{\\\"tool\\\":\\\"mcp__google__delete*event*\\\",\\\"decision\\\":\\\"ask\\\"},{\\\"tool\\\":\\\"mcp__google__*share*\\\",\\\"decision\\\":\\\"ask\\\"},{\\\"tool\\\":\\\"mcp__google__*add*permission*\\\",\\\"decision\\\":\\\"ask\\\"},{\\\"tool\\\":\\\"mcp__google__*update*permission*\\\",\\\"decision\\\":\\\"ask\\\"},{\\\"tool\\\":\\\"mcp__google__*remove*permission*\\\",\\\"decision\\\":\\\"ask\\\"},{\\\"tool\\\":\\\"mcp__google__set*permission*\\\",\\\"decision\\\":\\\"ask\\\"},{\\\"tool\\\":\\\"mcp__google__*message*label*\\\",\\\"decision\\\":\\\"ask\\\"},{\\\"tool\\\":\\\"mcp__google__manage*\\\",\\\"decision\\\":\\\"ask\\\"},{\\\"tool\\\":\\\"mcp__google__update*file*\\\",\\\"decision\\\":\\\"ask\\\"},{\\\"tool\\\":\\\"mcp__google__create*filter*\\\",\\\"decision\\\":\\\"ask\\\"},{\\\"tool\\\":\\\"mcp__google__*transfer*\\\",\\\"decision\\\":\\\"ask\\\"},{\\\"tool\\\":\\\"mcp__google__*trash*\\\",\\\"decision\\\":\\\"never\\\"},{\\\"tool\\\":\\\"mcp__google__*delete*mail*\\\",\\\"decision\\\":\\\"never\\\"},{\\\"tool\\\":\\\"mcp__google__*mail*delete*\\\",\\\"decision\\\":\\\"never\\\"},{\\\"tool\\\":\\\"mcp__google__*delete*message*\\\",\\\"decision\\\":\\\"never\\\"},{\\\"tool\\\":\\\"mcp__google__*delete*file*\\\",\\\"decision\\\":\\\"never\\\"},{\\\"tool\\\":\\\"mcp__google__*delete*drive*\\\",\\\"decision\\\":\\\"never\\\"},{\\\"tool\\\":\\\"mcp__google__*drive*delete*\\\",\\\"decision\\\":\\\"never\\\"}]' || { [ $? -eq 2 ] || echo 'The user'\\\\''s approval rules couldn'\\\\''t be checked for this call (their hook failed), so it was refused. Don'\\\\''t try another way to do the same thing: tell the user the rules'\\\\'' hook isn'\\\\''t working.' >&2; exit 2; }\",\"timeout\":30}]}]}}",
        "--allowedTools",
        "mcp__huntaway",
        "mcp__docs",
        "mcp__gh__pr_view",
        "mcp__gh__pr_list",
        "mcp__gh__pr_checks",
        "mcp__gh__pr_diff",
        "mcp__gh__issue_view",
        "mcp__gh__issue_list",
        "mcp__gh__run_list",
        "mcp__gh__run_view",
        "--model",
        "opus",
        "--effort",
        "high",
        "--add-dir",
        "/tmp/ha-0/TASKTMP",
        "--mcp-config",
        "/data/runs/RUN/mcp.json"
      ],
      "env": {
        "CLAUDE_CODE_ENABLE_TASKS": "0",
        "CLAUDE_CODE_ENABLE_TODO_TOOLS": "1",
        "HUNTAWAY_TASK_ID": "TASK",
        "MCP_TOOL_TIMEOUT": "86400000",
        "TMPDIR": "/tmp/ha-0/TASKTMP"
      },
      "cwd": "/data/assistants/TASK",
      "spec": {
        "args": [
          "-p",
          "--output-format",
          "stream-json",
          "--verbose",
          "--include-partial-messages",
          "--input-format",
          "stream-json",
          "--replay-user-messages",
          "--append-system-prompt-file",
          "/data/runs/RUN/system-prompt.md",
          "--permission-mode",
          "default",
          "--permission-prompt-tool",
          "stdio",
          "--settings",
          "{\"hooks\":{\"PreToolUse\":[{\"matcher\":\"Bash\",\"hooks\":[{\"type\":\"command\",\"command\":\"'/opt/huntaway/bin/huntaway' gh-hook\",\"timeout\":10}]},{\"matcher\":\"^(?:[mM][cC][pP]__[gG][oO][oO][gG][lL][eE](?:__[\\\\s\\\\S]*)?)$\",\"hooks\":[{\"type\":\"command\",\"command\":\"'/opt/huntaway/bin/huntaway' approval-hook '[{\\\"tool\\\":\\\"mcp__google__search*\\\",\\\"decision\\\":\\\"allow\\\"},{\\\"tool\\\":\\\"mcp__google__get*\\\",\\\"decision\\\":\\\"allow\\\"},{\\\"tool\\\":\\\"mcp__google__list*\\\",\\\"decision\\\":\\\"allow\\\"},{\\\"tool\\\":\\\"mcp__google__read*\\\",\\\"decision\\\":\\\"allow\\\"},{\\\"tool\\\":\\\"mcp__google__check*\\\",\\\"decision\\\":\\\"allow\\\"},{\\\"tool\\\":\\\"mcp__google__query*\\\",\\\"decision\\\":\\\"allow\\\"},{\\\"tool\\\":\\\"mcp__google__*draft*\\\",\\\"decision\\\":\\\"allow\\\"},{\\\"tool\\\":\\\"mcp__google__*send*\\\",\\\"decision\\\":\\\"ask\\\"},{\\\"tool\\\":\\\"mcp__google__create*event*\\\",\\\"decision\\\":\\\"ask\\\"},{\\\"tool\\\":\\\"mcp__google__modify*event*\\\",\\\"decision\\\":\\\"ask\\\"},{\\\"tool\\\":\\\"mcp__google__update*event*\\\",\\\"decision\\\":\\\"ask\\\"},{\\\"tool\\\":\\\"mcp__google__delete*event*\\\",\\\"decision\\\":\\\"ask\\\"},{\\\"tool\\\":\\\"mcp__google__*share*\\\",\\\"decision\\\":\\\"ask\\\"},{\\\"tool\\\":\\\"mcp__google__*add*permission*\\\",\\\"decision\\\":\\\"ask\\\"},{\\\"tool\\\":\\\"mcp__google__*update*permission*\\\",\\\"decision\\\":\\\"ask\\\"},{\\\"tool\\\":\\\"mcp__google__*remove*permission*\\\",\\\"decision\\\":\\\"ask\\\"},{\\\"tool\\\":\\\"mcp__google__set*permission*\\\",\\\"decision\\\":\\\"ask\\\"},{\\\"tool\\\":\\\"mcp__google__*message*label*\\\",\\\"decision\\\":\\\"ask\\\"},{\\\"tool\\\":\\\"mcp__google__manage*\\\",\\\"decision\\\":\\\"ask\\\"},{\\\"tool\\\":\\\"mcp__google__update*file*\\\",\\\"decision\\\":\\\"ask\\\"},{\\\"tool\\\":\\\"mcp__google__create*filter*\\\",\\\"decision\\\":\\\"ask\\\"},{\\\"tool\\\":\\\"mcp__google__*transfer*\\\",\\\"decision\\\":\\\"ask\\\"},{\\\"tool\\\":\\\"mcp__google__*trash*\\\",\\\"decision\\\":\\\"never\\\"},{\\\"tool\\\":\\\"mcp__google__*delete*mail*\\\",\\\"decision\\\":\\\"never\\\"},{\\\"tool\\\":\\\"mcp__google__*mail*delete*\\\",\\\"decision\\\":\\\"never\\\"},{\\\"tool\\\":\\\"mcp__google__*delete*message*\\\",\\\"decision\\\":\\\"never\\\"},{\\\"tool\\\":\\\"mcp__google__*delete*file*\\\",\\\"decision\\\":\\\"never\\\"},{\\\"tool\\\":\\\"mcp__google__*delete*drive*\\\",\\\"decision\\\":\\\"never\\\"},{\\\"tool\\\":\\\"mcp__google__*drive*delete*\\\",\\\"decision\\\":\\\"never\\\"}]' || { [ $? -eq 2 ] || echo 'The user'\\\\''s approval rules couldn'\\\\''t be checked for this call (their hook failed), so it was refused. Don'\\\\''t try another way to do the same thing: tell the user the rules'\\\\'' hook isn'\\\\''t working.' >&2; exit 2; }\",\"timeout\":30}]}]}}",
          "--allowedTools",
          "mcp__huntaway",
          "mcp__docs",
          "mcp__gh__pr_view",
          "mcp__gh__pr_list",
          "mcp__gh__pr_checks",
          "mcp__gh__pr_diff",
          "mcp__gh__issue_view",
          "mcp__gh__issue_list",
          "mcp__gh__run_list",
          "mcp__gh__run_view",
          "--model",
          "opus",
          "--effort",
          "high",
          "--add-dir",
          "/tmp/ha-0/TASKTMP",
          "--mcp-config",
          "/data/runs/RUN/mcp.json"
        ],
        "config_dir": null,
        "cwd": "/data/assistants/TASK"
      },
      "prompt": "{\"type\":\"control_request\",\"request_id\":\"huntaway-init-RUN\",\"request\":{\"subtype\":\"initialize\",\"sdkMcpServers\":[\"huntaway\"],\"sdkMcpServerConfigs\":{\"huntaway\":{\"timeout\":86400000,\"disableAutoBackground\":true}},\"sdkMcpServerManifests\":{\"huntaway\":{\"initializeResult\":{\"protocolVersion\":\"2025-11-25\",\"capabilities\":{\"tools\":{}},\"serverInfo\":{\"name\":\"huntaway\",\"version\":\"0.1.0\"},\"instructions\":\"Tools for the Huntaway board, a kanban board where each task is worked by its own Claude agent. The board has a profile for each Claude login (e.g. work, personal), each with its own projects and tasks. Besides your own profile's, you can use the boards of the profiles that let your agents in (each profile chooses which, in Settings → Profiles). list_projects shows every project you can use, labelled with its profile and host. The other tools take a project or task from any of them by id or key; an unqualified key means your own profile's board first, and one used on several other boards must be qualified as <profile>:<key> (e.g. work:SD-3) or with the profile argument. A task created in another profile's project runs under that profile's Claude login. Don't create a project the user refers to as if it existed: if list_projects doesn't show it, it may be on a profile's board you can't use, so ask the user. To split a piece of work into smaller tasks that are each reviewed and merged on their own and then land together, create them with merges_into that task (new subprojects can't be made any more); group related tasks, across projects too, in a pen.\"},\"toolsListResult\":{\"tools\":[{\"name\":\"request_user_input\"},{\"name\":\"finish_work\"},{\"name\":\"track_work\"},{\"name\":\"untrack_work\"},{\"name\":\"list_tracked_work\"},{\"name\":\"wait\"},{\"name\":\"background_wait\"},{\"name\":\"list_projects\"},{\"name\":\"list_tasks\"},{\"name\":\"get_task\"},{\"name\":\"get_task_field\"},{\"name\":\"create_task\"},{\"name\":\"update_task\"},{\"name\":\"delete_task\"},{\"name\":\"list_pens\"},{\"name\":\"create_pen\"},{\"name\":\"update_pen\"},{\"name\":\"delete_pen\"},{\"name\":\"send_to_task\"},{\"name\":\"get_project\"},{\"name\":\"update_project\"},{\"name\":\"create_project\"},{\"name\":\"list_automations\"},{\"name\":\"create_automation\"},{\"name\":\"update_automation\"},{\"name\":\"delete_automation\"},{\"name\":\"run_automation\"},{\"name\":\"list_workflows\"},{\"name\":\"create_workflow\"},{\"name\":\"update_workflow\"},{\"name\":\"delete_workflow\"},{\"name\":\"run_workflow\"}]}}}}}\n{\"type\":\"user\",\"uuid\":\"PROMPT\",\"message\":{\"role\":\"user\",\"content\":\"hello\"}}\n",
      "awaited": "PROMPT",
      "input": true,
      "mcp": {
        "mcpServers": {
          "docs": {
            "headers": {
              "Authorization": "Bearer SECRET"
            },
            "type": "http",
            "url": "/api/mcp/RUN/docs"
          },
          "gh": {
            "headers": {
              "Authorization": "Bearer SECRET"
            },
            "timeout": 900000,
            "type": "http",
            "url": "/api/mcp/RUN/gh"
          }
        }
      },
      "mcpRun": {
        "cwd": "/data/assistants/TASK",
        "github_account": null,
        "review": false,
        "in_process": true,
        "desktop": false
      }
    }
  },
  "the assistant in bypass, with rules that ask and refuse": {
    "promptText": "hello",
    "manifest": {
      "initializeResult": {
        "protocolVersion": "2025-11-25",
        "capabilities": {
          "tools": {}
        },
        "serverInfo": {
          "name": "huntaway",
          "version": "0.1.0"
        },
        "instructions": "Tools for the Huntaway board, a kanban board where each task is worked by its own Claude agent. The board has a profile for each Claude login (e.g. work, personal), each with its own projects and tasks. Besides your own profile's, you can use the boards of the profiles that let your agents in (each profile chooses which, in Settings → Profiles). list_projects shows every project you can use, labelled with its profile and host. The other tools take a project or task from any of them by id or key; an unqualified key means your own profile's board first, and one used on several other boards must be qualified as <profile>:<key> (e.g. work:SD-3) or with the profile argument. A task created in another profile's project runs under that profile's Claude login. Don't create a project the user refers to as if it existed: if list_projects doesn't show it, it may be on a profile's board you can't use, so ask the user. To split a piece of work into smaller tasks that are each reviewed and merged on their own and then land together, create them with merges_into that task (new subprojects can't be made any more); group related tasks, across projects too, in a pen."
      },
      "toolsListResult": {
        "tools": [
          {
            "name": "request_user_input"
          },
          {
            "name": "finish_work"
          },
          {
            "name": "track_work"
          },
          {
            "name": "untrack_work"
          },
          {
            "name": "list_tracked_work"
          },
          {
            "name": "wait"
          },
          {
            "name": "background_wait"
          },
          {
            "name": "list_projects"
          },
          {
            "name": "list_tasks"
          },
          {
            "name": "get_task"
          },
          {
            "name": "get_task_field"
          },
          {
            "name": "create_task"
          },
          {
            "name": "update_task"
          },
          {
            "name": "delete_task"
          },
          {
            "name": "list_pens"
          },
          {
            "name": "create_pen"
          },
          {
            "name": "update_pen"
          },
          {
            "name": "delete_pen"
          },
          {
            "name": "send_to_task"
          },
          {
            "name": "get_project"
          },
          {
            "name": "update_project"
          },
          {
            "name": "create_project"
          },
          {
            "name": "list_automations"
          },
          {
            "name": "create_automation"
          },
          {
            "name": "update_automation"
          },
          {
            "name": "delete_automation"
          },
          {
            "name": "run_automation"
          },
          {
            "name": "list_workflows"
          },
          {
            "name": "create_workflow"
          },
          {
            "name": "update_workflow"
          },
          {
            "name": "delete_workflow"
          },
          {
            "name": "run_workflow"
          }
        ]
      }
    },
    "task": {
      "kind": "task",
      "merging": false,
      "session_id": null
    },
    "expected": {
      "program": "claude",
      "args": [
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
        "--input-format",
        "stream-json",
        "--replay-user-messages",
        "--append-system-prompt-file",
        "/data/runs/RUN/system-prompt.md",
        "--permission-mode",
        "bypassPermissions",
        "--permission-prompt-tool",
        "stdio",
        "--settings",
        "{\"hooks\":{\"PreToolUse\":[{\"matcher\":\"Bash\",\"hooks\":[{\"type\":\"command\",\"command\":\"'/opt/huntaway/bin/huntaway' gh-hook\",\"timeout\":10}]},{\"matcher\":\"*\",\"hooks\":[{\"type\":\"command\",\"command\":\"'/opt/huntaway/bin/huntaway' approval-hook '[{\\\"tool\\\":\\\"Bash\\\",\\\"decision\\\":\\\"ask\\\"},{\\\"tool\\\":\\\"WebFetch\\\",\\\"decision\\\":\\\"never\\\"},{\\\"tool\\\":\\\"mcp__github__*\\\",\\\"decision\\\":\\\"ask\\\"}]' || { [ $? -eq 2 ] || echo 'The user'\\\\''s approval rules couldn'\\\\''t be checked for this call (their hook failed), so it was refused. Don'\\\\''t try another way to do the same thing: tell the user the rules'\\\\'' hook isn'\\\\''t working.' >&2; exit 2; }\",\"timeout\":30}]}]}}",
        "--allowedTools",
        "mcp__huntaway",
        "mcp__docs",
        "mcp__gh__pr_view",
        "mcp__gh__pr_list",
        "mcp__gh__pr_checks",
        "mcp__gh__pr_diff",
        "mcp__gh__issue_view",
        "mcp__gh__issue_list",
        "mcp__gh__run_list",
        "mcp__gh__run_view",
        "--disallowedTools",
        "WebFetch",
        "--model",
        "opus",
        "--effort",
        "high",
        "--add-dir",
        "/tmp/ha-0/TASKTMP",
        "--mcp-config",
        "/data/runs/RUN/mcp.json"
      ],
      "env": {
        "CLAUDE_CODE_ENABLE_TASKS": "0",
        "CLAUDE_CODE_ENABLE_TODO_TOOLS": "1",
        "HUNTAWAY_TASK_ID": "TASK",
        "MCP_TOOL_TIMEOUT": "86400000",
        "TMPDIR": "/tmp/ha-0/TASKTMP"
      },
      "cwd": "/data/assistants/TASK",
      "spec": {
        "args": [
          "-p",
          "--output-format",
          "stream-json",
          "--verbose",
          "--include-partial-messages",
          "--input-format",
          "stream-json",
          "--replay-user-messages",
          "--append-system-prompt-file",
          "/data/runs/RUN/system-prompt.md",
          "--permission-mode",
          "bypassPermissions",
          "--permission-prompt-tool",
          "stdio",
          "--settings",
          "{\"hooks\":{\"PreToolUse\":[{\"matcher\":\"Bash\",\"hooks\":[{\"type\":\"command\",\"command\":\"'/opt/huntaway/bin/huntaway' gh-hook\",\"timeout\":10}]},{\"matcher\":\"*\",\"hooks\":[{\"type\":\"command\",\"command\":\"'/opt/huntaway/bin/huntaway' approval-hook '[{\\\"tool\\\":\\\"Bash\\\",\\\"decision\\\":\\\"ask\\\"},{\\\"tool\\\":\\\"WebFetch\\\",\\\"decision\\\":\\\"never\\\"},{\\\"tool\\\":\\\"mcp__github__*\\\",\\\"decision\\\":\\\"ask\\\"}]' || { [ $? -eq 2 ] || echo 'The user'\\\\''s approval rules couldn'\\\\''t be checked for this call (their hook failed), so it was refused. Don'\\\\''t try another way to do the same thing: tell the user the rules'\\\\'' hook isn'\\\\''t working.' >&2; exit 2; }\",\"timeout\":30}]}]}}",
          "--allowedTools",
          "mcp__huntaway",
          "mcp__docs",
          "mcp__gh__pr_view",
          "mcp__gh__pr_list",
          "mcp__gh__pr_checks",
          "mcp__gh__pr_diff",
          "mcp__gh__issue_view",
          "mcp__gh__issue_list",
          "mcp__gh__run_list",
          "mcp__gh__run_view",
          "--disallowedTools",
          "WebFetch",
          "--model",
          "opus",
          "--effort",
          "high",
          "--add-dir",
          "/tmp/ha-0/TASKTMP",
          "--mcp-config",
          "/data/runs/RUN/mcp.json"
        ],
        "config_dir": null,
        "cwd": "/data/assistants/TASK"
      },
      "prompt": "{\"type\":\"control_request\",\"request_id\":\"huntaway-init-RUN\",\"request\":{\"subtype\":\"initialize\",\"sdkMcpServers\":[\"huntaway\"],\"sdkMcpServerConfigs\":{\"huntaway\":{\"timeout\":86400000,\"disableAutoBackground\":true}},\"sdkMcpServerManifests\":{\"huntaway\":{\"initializeResult\":{\"protocolVersion\":\"2025-11-25\",\"capabilities\":{\"tools\":{}},\"serverInfo\":{\"name\":\"huntaway\",\"version\":\"0.1.0\"},\"instructions\":\"Tools for the Huntaway board, a kanban board where each task is worked by its own Claude agent. The board has a profile for each Claude login (e.g. work, personal), each with its own projects and tasks. Besides your own profile's, you can use the boards of the profiles that let your agents in (each profile chooses which, in Settings → Profiles). list_projects shows every project you can use, labelled with its profile and host. The other tools take a project or task from any of them by id or key; an unqualified key means your own profile's board first, and one used on several other boards must be qualified as <profile>:<key> (e.g. work:SD-3) or with the profile argument. A task created in another profile's project runs under that profile's Claude login. Don't create a project the user refers to as if it existed: if list_projects doesn't show it, it may be on a profile's board you can't use, so ask the user. To split a piece of work into smaller tasks that are each reviewed and merged on their own and then land together, create them with merges_into that task (new subprojects can't be made any more); group related tasks, across projects too, in a pen.\"},\"toolsListResult\":{\"tools\":[{\"name\":\"request_user_input\"},{\"name\":\"finish_work\"},{\"name\":\"track_work\"},{\"name\":\"untrack_work\"},{\"name\":\"list_tracked_work\"},{\"name\":\"wait\"},{\"name\":\"background_wait\"},{\"name\":\"list_projects\"},{\"name\":\"list_tasks\"},{\"name\":\"get_task\"},{\"name\":\"get_task_field\"},{\"name\":\"create_task\"},{\"name\":\"update_task\"},{\"name\":\"delete_task\"},{\"name\":\"list_pens\"},{\"name\":\"create_pen\"},{\"name\":\"update_pen\"},{\"name\":\"delete_pen\"},{\"name\":\"send_to_task\"},{\"name\":\"get_project\"},{\"name\":\"update_project\"},{\"name\":\"create_project\"},{\"name\":\"list_automations\"},{\"name\":\"create_automation\"},{\"name\":\"update_automation\"},{\"name\":\"delete_automation\"},{\"name\":\"run_automation\"},{\"name\":\"list_workflows\"},{\"name\":\"create_workflow\"},{\"name\":\"update_workflow\"},{\"name\":\"delete_workflow\"},{\"name\":\"run_workflow\"}]}}}}}\n{\"type\":\"user\",\"uuid\":\"PROMPT\",\"message\":{\"role\":\"user\",\"content\":\"hello\"}}\n",
      "awaited": "PROMPT",
      "input": true,
      "mcp": {
        "mcpServers": {
          "docs": {
            "headers": {
              "Authorization": "Bearer SECRET"
            },
            "type": "http",
            "url": "/api/mcp/RUN/docs"
          },
          "gh": {
            "headers": {
              "Authorization": "Bearer SECRET"
            },
            "timeout": 900000,
            "type": "http",
            "url": "/api/mcp/RUN/gh"
          }
        }
      },
      "mcpRun": {
        "cwd": "/data/assistants/TASK",
        "github_account": null,
        "review": false,
        "in_process": true,
        "desktop": false
      }
    }
  }
}

export interface LaunchGolden {
  readonly promptText: string
  readonly manifest: { readonly initializeResult: unknown; readonly toolsListResult: { readonly tools: ReadonlyArray<unknown> } }
  readonly task: { readonly kind: "task" | "review"; readonly merging: boolean; readonly session_id: string | null }
  readonly expected: {
    readonly program: string
    readonly args: ReadonlyArray<string>
    readonly env: Readonly<Record<string, string>>
    readonly cwd: string
    readonly spec: { readonly args: ReadonlyArray<string>; readonly config_dir: string | null; readonly cwd: string }
    readonly prompt: string
    readonly awaited: string | null
    readonly input: boolean
    readonly mcp: unknown
    readonly mcpRun: unknown
  }
}
