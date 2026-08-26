import { Outlet, useRouterState } from "@tanstack/react-router";
import type { NavKey } from "~/components/organisms/TopBar";
import { AppShell } from "~/components/templates/AppShell";

function navKeyFor(pathname: string): NavKey {
  if (pathname.startsWith("/runs")) return "runs";
  if (pathname.startsWith("/workflows")) return "workflows";
  if (pathname.startsWith("/settings")) return "settings";
  return "queue";
}

export function RootLayout() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  return (
    <AppShell active={navKeyFor(pathname)} hideHeader={pathname.startsWith("/runs/")}>
      <Outlet />
    </AppShell>
  );
}
