import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import { MarkdownEditableField } from "../MarkdownEditableField";

/**
 * `container` is the overlay's isolation contract (P7): the `#` mention
 * dropdown used to portal to `document.body` unconditionally, so inside a
 * shadow root it rendered OUTSIDE the root and lost every token. The failure
 * is silent — the dropdown still appears, just unstyled and detached.
 */
describe("MarkdownEditableField container (P14.4)", () => {
  const props = {
    value: "",
    onChange: vi.fn(),
    showPreview: false,
    setShowPreview: vi.fn(),
    previewId: "p",
    textareaId: "t",
    placeholder: "Type",
    mentionTasks: [{ id: "abc123", title: "A task" }],
  };

  it("portals the mention dropdown into the supplied container", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = host.attachShadow({ mode: "open" });
    const mount = document.createElement("div");
    root.appendChild(mount);

    // Controlled field: the harness owns the value, otherwise typing cannot
    // produce a suggestion (the value prop would stay empty).
    function Harness() {
      const [value, setValue] = React.useState("");
      return (
        <MarkdownEditableField
          {...props}
          value={value}
          onChange={setValue}
          container={mount}
          autoFocus
        />
      );
    }
    const { container } = render(<Harness />);
    const textarea = container.querySelector("textarea");
    expect(textarea).not.toBeNull();

    // Open the `#` mention dropdown. The assertion below is unconditional: if
    // the dropdown fails to render at all, the test fails rather than passing
    // on a missing element.
    // userEvent (not fireEvent) so the caret lands at the end of the text:
    // the mention regex reads selectionStart, which fireEvent.change leaves
    // at 0 and therefore never matches.
    await userEvent.type(textarea!, "#ab");

    const inRoot = root.querySelector('[data-task-ref-suggest="true"]');
    const inBody = document.body.querySelector('[data-task-ref-suggest="true"]');
    expect(inBody).toBeNull();
    expect(inRoot).not.toBeNull();
    host.remove();
  });
});
