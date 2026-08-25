import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import { render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createStore, Provider } from "jotai";
import { createAppRouter } from "~/app/router";

/**
 * Mounts the whole SPA on a memory history with a fresh Jotai store, so each
 * test starts from the daemon's initial state.
 */
export function renderApp(initialPath = "/queue") {
  const store = createStore();
  const router = createAppRouter(createMemoryHistory({ initialEntries: [initialPath] }));
  const user = userEvent.setup();
  const utils = render(
    <Provider store={store}>
      <RouterProvider router={router} />
    </Provider>,
  );
  return { ...utils, store, router, user };
}
