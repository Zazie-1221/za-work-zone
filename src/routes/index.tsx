import { createFileRoute } from "@tanstack/react-router";
import { WorkZone } from "@/components/zone/work-zone";

export const Route = createFileRoute("/")({ component: Home });

function Home() {
  return <WorkZone />;
}
