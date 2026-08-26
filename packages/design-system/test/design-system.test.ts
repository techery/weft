import { isValidElement, type ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { Button, TextField, Toggle, Toolbar, WeftTheme, weftStyles } from "../src/index.ts";
import { ArrowRightIcon } from "../src/icons.ts";

describe("design-system primitives", () => {
  it("exports semantic toolbar and Phosphor icons", () => {
    const toolbar = Toolbar({ "aria-label": "Actions", children: "content" });

    expect(toolbar.props).toMatchObject({ role: "toolbar", className: "weft-toolbar" });
    expect(ArrowRightIcon).toBeDefined();
  });

  it("composes button variants, sizes, and consumer classes without losing native props", () => {
    const onClick = vi.fn();
    const button = Button({
      variant: "primary",
      size: "mediumWide",
      round: true,
      className: "consumer-class",
      disabled: true,
      onClick,
      children: "Continue",
    });

    expect(button.type).toBe("button");
    expect(button.props).toMatchObject({
      type: "button",
      disabled: true,
      onClick,
      children: "Continue",
      className: "weft-button weft-button--primary weft-button--mediumWide weft-button--round consumer-class",
    });

    const outline = Button({ variant: "outline", size: "xSmall", children: "Back" });
    expect(outline.props.className).toContain("weft-button--outline");
  });

  it("keeps field and toggle accessibility semantics", () => {
    const field = TextField({ "aria-label": "Branch", scale: "settings" });
    const toggle = Toggle({ on: true, label: "Watch run", onToggle: vi.fn() });

    expect(field.props).toMatchObject({
      type: "text",
      "aria-label": "Branch",
      className: "weft-control weft-control--settings",
    });
    expect(toggle.props).toMatchObject({
      type: "button",
      role: "switch",
      "aria-checked": true,
      "aria-label": "Watch run",
    });
  });

  it("embeds the complete stylesheet for CSS-import-free workflow views", () => {
    const child = Button({ variant: "secondary", size: "small", children: "Review" });
    const theme = WeftTheme({ children: child });
    const children = (theme.props as { children: ReactElement[] }).children;

    expect(isValidElement(theme)).toBe(true);
    expect(children[0]?.type).toBe("style");
    expect(children[0]?.props).toMatchObject({
      "data-weft-design-system": "",
      children: weftStyles,
    });
    expect(weftStyles).toContain("--color-accent:#cc785c");
    expect(weftStyles).toContain(".weft-button--primary");
    expect(children[1]).toBe(child);
  });
});
