import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./style.css";
import "./monaco/environment.ts";
import { applyAppChrome } from "./themes/appearance";
import { BUILTIN_THEMES } from "./themes/registry";
import App from "./App.tsx";

// Applied synchronously, before the first paint, so the app shell never flashes unstyled.
applyAppChrome(BUILTIN_THEMES[0]);

createRoot(document.getElementById("app")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
