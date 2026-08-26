# @techery/weft-design-system

Reusable Weft React primitives for the manager and workflow-authored `.ui.tsx` views.

```tsx
import { Button, TextArea, WeftTheme } from "@techery/weft-design-system";

export function Review() {
  return <WeftTheme><main><TextArea /><Button variant="primary" size="medium">Continue</Button></main></WeftTheme>;
}
```

`WeftTheme` emits the tokens, reset, and component styles as a `<style>` element. This keeps the package usable in Weft's sandboxed workflow UI compiler, where authored CSS imports remain intentionally unsupported. Use one `WeftTheme` at the root of each custom view. The raw `weftStyles` string is also exported from `@techery/weft-design-system/styles` for advanced hosts.

The complete Phosphor React icon catalog is exported from `@techery/weft-design-system/icons`:

```tsx
import { ArrowRightIcon } from "@techery/weft-design-system/icons";

<ArrowRightIcon weight="fill" size={16} aria-hidden="true" />;
```
