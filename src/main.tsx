import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { PreviewHostBridge } from "@/components/preview-host-bridge";
import { WorkZone } from "@/components/zone/work-zone";
import "./styles.css";

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <PreviewHostBridge />
      <WorkZone />
    </StrictMode>,
  );
}
