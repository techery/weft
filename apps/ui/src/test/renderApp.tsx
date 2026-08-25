import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createStore, Provider } from "jotai";
import { createAppRouter } from "~/app/router";

/**
 * Mounts the whole SPA against a fake daemon, on a memory history with its own Jotai store
 * and its own query cache — so nothing leaks between tests and each starts from a cold
 * fetch, which is the state a real page load is in.
 */
export function renderApp(initialPath = "/queue") {
  const store = createStore();
  const router = createAppRouter(createMemoryHistory({ initialEntries: [initialPath] }));
  const queryClient = new QueryClient({
    defaultOptions: {
      // No retries and no polling: a test asserting an error state should not wait for a
      // retry it never asked for, and a poll would make every assertion a race.
      queries: { retry: false, refetchInterval: false, staleTime: 0, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  const user = userEvent.setup();
  const utils = render(
    <QueryClientProvider client={queryClient}>
      <Provider store={store}>
        <RouterProvider router={router} />
      </Provider>
    </QueryClientProvider>,
  );
  return { ...utils, store, router, user, queryClient };
}
