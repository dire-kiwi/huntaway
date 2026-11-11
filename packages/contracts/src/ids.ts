import { Schema } from "effect"

// Branded ids (docs/plan/03-domain.md): a function that wants a project's id does not take a task's. Brands are erased
// on the wire. All ids are UUID v4 text made by the server, except where the old data has another form (a host's id
// and a token are 32 hex characters).

export const HostId = Schema.String.pipe(Schema.brand("HostId"))
export type HostId = typeof HostId.Type
export const ProfileId = Schema.String.pipe(Schema.brand("ProfileId"))
export type ProfileId = typeof ProfileId.Type
export const ProjectId = Schema.String.pipe(Schema.brand("ProjectId"))
export type ProjectId = typeof ProjectId.Type
/** Also the id of the task's thread. */
export const TaskId = Schema.String.pipe(Schema.brand("TaskId"))
export type TaskId = typeof TaskId.Type
export const RunId = Schema.String.pipe(Schema.brand("RunId"))
export type RunId = typeof RunId.Type
export const AgentConfigId = Schema.String.pipe(Schema.brand("AgentConfigId"))
export type AgentConfigId = typeof AgentConfigId.Type
export const PenId = Schema.String.pipe(Schema.brand("PenId"))
export type PenId = typeof PenId.Type
export const AutomationId = Schema.String.pipe(Schema.brand("AutomationId"))
export type AutomationId = typeof AutomationId.Type
export const WorkflowId = Schema.String.pipe(Schema.brand("WorkflowId"))
export type WorkflowId = typeof WorkflowId.Type
export const WorkflowRunId = Schema.String.pipe(Schema.brand("WorkflowRunId"))
export type WorkflowRunId = typeof WorkflowRunId.Type
export const DocId = Schema.String.pipe(Schema.brand("DocId"))
export type DocId = typeof DocId.Type
/** The other host's `HostId`. */
export const LinkId = Schema.String.pipe(Schema.brand("LinkId"))
export type LinkId = typeof LinkId.Type
export const DeviceId = Schema.String.pipe(Schema.brand("DeviceId"))
export type DeviceId = typeof DeviceId.Type
export const RequestId = Schema.String.pipe(Schema.brand("RequestId"))
export type RequestId = typeof RequestId.Type
export const CallId = Schema.String.pipe(Schema.brand("CallId"))
export type CallId = typeof CallId.Type
export const AttachmentId = Schema.String.pipe(Schema.brand("AttachmentId"))
export type AttachmentId = typeof AttachmentId.Type
