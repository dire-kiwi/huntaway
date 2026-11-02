// The board's API: a file per resource, as the server's api/ has. `api` has every call; the types and helpers are
// exported alongside.
import { hostsApi } from "./hosts";
import { pushApi } from "./push";
import { profilesApi } from "./profiles";
import { claudeConfigsApi } from "./claudeConfigs";
import { githubApi } from "./github";
import { projectsApi } from "./projects";
import { agentToolsApi } from "./agentTools";
import { analyticsApi } from "./analytics";
import { tasksApi } from "./tasks";
import { threadApi } from "./thread";
import { gitApi } from "./git";
import { terminalApi } from "./terminal";
import { approvalsApi } from "./approvals";
import { automationsApi } from "./automations";
import { serverApi } from "./server";

export { ApiError, captureTokenFromUrl, fetchOpenToken, getToken, isOpenBoard, setToken, setUnauthorizedHandler, shouldFetchOpenToken, wsUrl } from "./http";
export * from "./hosts";
export * from "./push";
export * from "./profiles";
export * from "./claudeConfigs";
export * from "./github";
export * from "./projects";
export * from "./agentTools";
export * from "./analytics";
export * from "./tasks";
export * from "./thread";
export * from "./git";
export * from "./terminal";
export * from "./approvals";
export * from "./automations";
export * from "./server";

export const api = {
  ...hostsApi,
  ...pushApi,
  ...profilesApi,
  ...claudeConfigsApi,
  ...githubApi,
  ...projectsApi,
  ...agentToolsApi,
  ...analyticsApi,
  ...tasksApi,
  ...threadApi,
  ...gitApi,
  ...terminalApi,
  ...approvalsApi,
  ...automationsApi,
  ...serverApi,
};
