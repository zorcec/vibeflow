// @vitest-environment jsdom
/**
 * ChatPanel contract (ticket 0847833f): presentational only — messages,
 * streaming tokens, tool cards, approval cards, degraded states, and
 * input gating. No network, no session: every interaction is a prop
 * callback the host container wires to WS/REST.
 */
import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { ChatPanel, type ChatPanelProps } from "../ChatPanel";

afterEach(cleanup);

function baseProps(overrides?: Partial<ChatPanelProps>): ChatPanelProps {
  return {
    messages: [],
    streamingText: "",
    approvals: [],
    status: "ready",
    onSend: vi.fn(),
    onApprove: vi.fn(),
    onDeny: vi.fn(),
    onAbort: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
}

function renderPanel(props: ChatPanelProps) {
  return render(<ChatPanel {...props} />);
}

describe("ChatPanel", () => {
  it("renders messages by role with tool cards", () => {
    renderPanel(
      baseProps({
        messages: [
          { id: "u1", role: "user", text: "annotate this" },
          {
            id: "a1",
            role: "assistant",
            text: "on it",
            toolCalls: [
              {
                toolCallId: "c1",
                toolName: "read_page_dom",
                args: {},
                done: true,
              },
            ],
          },
        ],
      }),
    );
    expect(screen.getByText("annotate this")).toBeInTheDocument();
    expect(screen.getByText("on it")).toBeInTheDocument();
    const card = screen.getByTestId("chat-tool-card");
    expect(card).toHaveAttribute("data-tool-name", "read_page_dom");
    expect(card).toHaveAttribute("data-done", "true");
  });

  it("shows streaming text with the caret while streaming", () => {
    renderPanel(baseProps({ streamingText: "partial…" }));
    const el = screen.getByTestId("chat-streaming");
    expect(el).toHaveTextContent("partial…");
  });

  it("renders approval cards with working approve/deny", () => {
    const onApprove = vi.fn();
    const onDeny = vi.fn();
    renderPanel(
      baseProps({
        approvals: [{ approvalId: "ap1", toolName: "update_task", argsSummary: "{}" }],
        onApprove,
        onDeny,
      }),
    );
    const card = screen.getByTestId("chat-approval");
    expect(card).toHaveAttribute("data-tool-name", "update_task");
    fireEvent.click(screen.getByTestId("chat-approve"));
    expect(onApprove).toHaveBeenCalledWith("ap1");
    fireEvent.click(screen.getByTestId("chat-deny"));
    expect(onDeny).toHaveBeenCalledWith("ap1");
  });

  it("sends on Enter and clears the draft", () => {
    const onSend = vi.fn();
    renderPanel(baseProps({ onSend }));
    const input = screen.getByTestId("chat-input") as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "hello" } });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: false });
    expect(onSend).toHaveBeenCalledWith("hello", []);
    expect(input.value).toBe("");
  });

  it("disables send when the draft is empty and no images", () => {
    renderPanel(baseProps({}));
    expect(screen.getByTestId("chat-send")).toBeDisabled();
  });

  it("shows the abort button only while busy and calls onAbort", () => {
    const onAbort = vi.fn();
    const { rerender } = renderPanel(baseProps({ status: "ready", onAbort }));
    expect(screen.queryByTestId("chat-abort")).not.toBeInTheDocument();
    rerender(<ChatPanel {...baseProps({ status: "busy", onAbort })} />);
    fireEvent.click(screen.getByTestId("chat-abort"));
    expect(onAbort).toHaveBeenCalledTimes(1);
  });

  it("renders degraded states with the right copy and locked input", () => {
    renderPanel(baseProps({ status: "no-pi" }));
    const banner = screen.getByTestId("chat-degraded");
    expect(banner).toHaveAttribute("data-status", "no-pi");
    expect(banner).toHaveTextContent("install pi");
    expect(screen.getByTestId("chat-input")).toBeDisabled();
    expect(screen.getByTestId("chat-send")).toBeDisabled();
  });

  it("shows error status with the server message", () => {
    renderPanel(baseProps({ status: "error", statusMessage: "boom" }));
    expect(screen.getByTestId("chat-degraded")).toHaveTextContent("boom");
  });

  it("calls onClose from the close button", () => {
    const onClose = vi.fn();
    renderPanel(baseProps({ onClose }));
    fireEvent.click(screen.getByTestId("chat-close"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("collects pasted images into previews and sends them as Files", () => {
    // jsdom has no object URLs at all — define the pair the panel uses.
    URL.createObjectURL = vi.fn(() => "blob:preview");
    URL.revokeObjectURL = vi.fn();
    const onSend = vi.fn();
    const { container } = renderPanel(baseProps({ onSend }));
    expect(
      container.querySelector('[data-testid="chat-previews"]'),
    ).not.toBeInTheDocument();
    const file = new File(["x"], "shot.png", { type: "image/png" });
    const input = screen.getByTestId("chat-input");
    fireEvent.paste(input, {
      clipboardData: {
        items: [{ kind: "file", type: "image/png", getAsFile: () => file }],
      },
    });
    expect(screen.getByTestId("chat-previews")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("chat-send"));
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend.mock.calls[0]?.[1]).toHaveLength(1);
    expect(
      container.querySelector('[data-testid="chat-previews"]'),
    ).not.toBeInTheDocument();
  });
});
