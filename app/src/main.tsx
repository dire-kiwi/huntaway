import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/jetbrains-mono/wght.css";
import { captureTokenFromUrl, fetchOpenToken, getToken, shouldFetchOpenToken } from "./api";
import { App } from "./App";
import "./index.css";
import { setUpViewport } from "./narrow";

captureTokenFromUrl();
setUpViewport();

const render = () =>
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );

// With no token yet, a PR preview's open token signs in first. With one, the board shows at once, and a preview's open
// token is checked behind it (a rejected token asks for it again too: see App).
if (!getToken()) fetchOpenToken().finally(render);
else {
  render();
  if (shouldFetchOpenToken()) void fetchOpenToken();
}
