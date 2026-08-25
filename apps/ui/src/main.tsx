import "~/styles/global.css";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { router } from "~/app/router";

const container = document.getElementById("root");
if (!container) throw new Error("missing #root");

/**
 * One retry, and no refetch on focus. This talks to a daemon on loopback: a failure is
 * almost always the daemon being gone rather than a flaky network, and retrying hard just
 * delays saying so. Windows regain focus constantly while watching a run, and the lists
 * already poll.
 */
const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 1_000 },
  },
});

createRoot(container).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
