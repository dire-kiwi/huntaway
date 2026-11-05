// The board's API: a file per resource, as the server's api/ has. `createClient` makes a client for one board, with
// every call; the types and helpers are exported alongside. It's plain TypeScript, with no DOM: the app it runs in
// (the web board, the mobile app) says where the board is and keeps its token (see ClientAdapter).
import { type ClientAdapter, createHttp } from "./http";
import { hostsApi } from "./hosts";
import { pushApi } from "./push";
import { devicesApi } from "./devices";
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
import { workflowsApi } from "./workflows";
import { assistantApi } from "./assistant";
import { approvalRulesApi } from "./approvalRules";
import { telegramApi } from "./telegram";

export { ApiError, type ClientAdapter, type Fetch, type FetchResponse, type KeyValueStorage } from "./http";
export * from "./hosts";
export * from "./push";
export * from "./devices";
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
export * from "./workflows";
export * from "./assistant";
export * from "./approvalRules";
export * from "./telegram";

/** A client for one board: its calls, and its token. An app with several boards makes one for each. */
export function createClient(adapter: ClientAdapter) {
  const http = createHttp(adapter);
  const { getToken, setToken, isOpenBoard, shouldFetchOpenToken, fetchOpenToken, setUnauthorizedHandler, wsUrl } = http;
  return {
    getToken,
    setToken,
    isOpenBoard,
    shouldFetchOpenToken,
    fetchOpenToken,
    setUnauthorizedHandler,
    wsUrl,
    ...hostsApi(http),
    ...pushApi(http),
    ...devicesApi(http),
    ...profilesApi(http),
    ...claudeConfigsApi(http),
    ...githubApi(http),
    ...projectsApi(http),
    ...agentToolsApi(http),
    ...analyticsApi(http),
    ...tasksApi(http),
    ...threadApi(http),
    ...gitApi(http),
    ...terminalApi(http),
    ...approvalsApi(http),
    ...automationsApi(http),
    ...serverApi(http),
    ...workflowsApi(http),
    ...assistantApi(http),
    ...approvalRulesApi(http),
    ...telegramApi(http),
  };
}

export type Client = ReturnType<typeof createClient>;
