// The pen tools (HA-285): list_pens, create_pen, update_pen and delete_pen, over a profile's pens (see db/pens.ts). A task
// goes into a pen with update_task's (or create_task's) `pen`.
import * as db from "../../db.ts";
import type { Shared } from "../../state.ts";
import * as pens_api from "../../api/pens.ts";
import { ToolError, is_own, type Ctx } from "../tools.ts";
import { pick_boards, project_key } from "./resolve.ts";

/** The boards a pen tool without `profile` works on: the caller's own, if it has one here, else every one it can use. */
function own_boards(s: Shared, ctx: Ctx, profile: string | null): db.Profile[] {
  const all = pick_boards(s, ctx, profile);
  return profile === null && all.some((b) => is_own(ctx, b)) ? all.filter((b) => is_own(ctx, b)) : all;
}

/** A pen as the tools return it: with its place among the profile's tabs, and its tasks. */
function pen_json(s: Shared, p: db.Pen, index: number, board: db.Profile): any {
  const projects = new Map(db.list_projects(s.db(), board.id).map((x) => [x.id, x.name]));
  return {
    id: p.id,
    name: p.name,
    hidden: p.hidden,
    index,
    profile: board.name,
    host: s.host_name,
    tasks: db.pen_tasks(s.db(), p.id).map((t) => ({
      key: `${project_key(s, t)}-${t.number}`,
      id: t.id,
      title: t.title,
      status: t.status,
      project: t.project_id ? (projects.get(t.project_id) ?? null) : null,
    })),
  };
}

function shown(s: Shared, p: db.Pen): any {
  const board = db.get_profile(s.db(), p.profile_id);
  if (!board) throw ToolError.not_found("profile");
  const index = db.list_pens(s.db(), p.profile_id).findIndex((x) => x.id === p.id);
  return pen_json(s, p, index, board);
}

/** The pen a call names (its id, or its name on the caller's boards: its own first). */
function resolve_pen(s: Shared, ctx: Ctx, r: string, profile: string | null): db.Pen {
  const bs = pick_boards(s, ctx, profile);
  const by_id = db.get_pen(s.db(), r);
  if (by_id && bs.some((b) => b.id === by_id.profile_id)) return by_id;
  const found = bs.map((b) => [b, db.pen_by_name(s.db(), b.id, r)] as const).filter(([, p]) => p !== null) as Array<[db.Profile, db.Pen]>;
  const own = found.find(([b]) => is_own(ctx, b));
  if (own) return own[1];
  if (!found.length) throw ToolError.not_found(`pen ${r}`);
  if (found.length > 1) throw ToolError.other(`pen ${r} is on more than one profile's board: pass profile (one of ${found.map(([b]) => b.name).join(", ")})`);
  return found[0][1];
}

/** A database's error as the tool's. */
function other(e: unknown): ToolError {
  if (e instanceof ToolError) return e;
  return ToolError.other(e instanceof Error ? e.message : String(e));
}

export function pen_tool(s: Shared, ctx: Ctx, tool: string, args: any, profile: string | null): any {
  switch (tool) {
    case "list_pens": {
      const out: any[] = [];
      for (const b of own_boards(s, ctx, profile)) db.list_pens(s.db(), b.id).forEach((p, i) => out.push(pen_json(s, p, i, b)));
      return out;
    }
    case "create_pen": {
      const board = own_boards(s, ctx, profile)[0];
      if (!board) throw ToolError.not_found("your profile's board");
      if (args.hidden != null && typeof args.hidden !== "boolean") throw ToolError.other("hidden must be true or false");
      let p: db.Pen;
      try {
        p = db.insert_pen(s.db(), board.id, args.name, args.hidden === true);
      } catch (e) {
        throw other(e);
      }
      pens_api.changed(s, board.id);
      return shown(s, p);
    }
    case "update_pen": {
      const p = resolve_pen(s, ctx, typeof args.pen === "string" ? args.pen : "", profile);
      let out: db.Pen | null;
      try {
        out = db.update_pen(s.db(), p.id, pens_api.pen_change(args));
      } catch (e) {
        throw other(e);
      }
      if (!out) throw ToolError.not_found(`pen ${args.pen}`);
      pens_api.changed(s, p.profile_id);
      return shown(s, out);
    }
    case "delete_pen": {
      const p = resolve_pen(s, ctx, typeof args.pen === "string" ? args.pen : "", profile);
      const tasks = db.pen_tasks(s.db(), p.id).length;
      pens_api.removed(s, p);
      return { deleted: p.name, tasks_left_in_no_pen: tasks };
    }
  }
  throw ToolError.other(`unknown tool ${tool}`);
}
