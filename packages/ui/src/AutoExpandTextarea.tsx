import React from "react";

interface Props extends Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, "onChange"> {
  value: string;
  onChange: (value: string) => void;
  baseRows?: number;
  maxRows?: number;
}

export const AutoExpandTextarea = React.forwardRef<HTMLTextAreaElement, Props>(function AutoExpandTextarea({
  value,
  onChange,
  baseRows = 4,
  maxRows,
  style,
  ...rest
}, forwardedRef) {
  const localRef = React.useRef<HTMLTextAreaElement | null>(null);
  const resolvedMaxRows = maxRows ?? baseRows * 2;

  const resize = React.useCallback(() => {
    const el = localRef.current;
    if (!el) return;

    el.style.height = "auto";
    const computed = window.getComputedStyle(el);
    const lineHeight = Number.parseFloat(computed.lineHeight || "0") || 18;
    const verticalPadding =
      Number.parseFloat(computed.paddingTop || "0") + Number.parseFloat(computed.paddingBottom || "0");
    const border =
      Number.parseFloat(computed.borderTopWidth || "0") + Number.parseFloat(computed.borderBottomWidth || "0");
    const minHeight = baseRows * lineHeight + verticalPadding + border;
    const maxHeight = resolvedMaxRows * lineHeight + verticalPadding + border;
    const target = Math.max(minHeight, Math.min(el.scrollHeight, maxHeight));

    el.style.height = `${target}px`;
    el.style.overflowY = el.scrollHeight > maxHeight ? "auto" : "hidden";
  }, [baseRows, resolvedMaxRows]);

  React.useLayoutEffect(() => {
    resize();
  }, [value, resize]);

  return (
    <textarea
      {...rest}
      ref={(el) => {
        localRef.current = el;
        if (typeof forwardedRef === "function") {
          forwardedRef(el);
        } else if (forwardedRef) {
          forwardedRef.current = el;
        }
      }}
      rows={baseRows}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      style={{ ...style, resize: "none" }}
    />
  );
});
