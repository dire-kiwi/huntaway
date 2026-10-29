import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/jetbrains-mono/wght.css";
import { captureTokenFromUrl, fetchOpenToken } from "./api";
import { App } from "./App";
import "./index.css";

captureTokenFromUrl();

fetchOpenToken().finally(() =>
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  ),
);
