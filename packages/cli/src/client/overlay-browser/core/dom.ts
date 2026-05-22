// Lightweight DOM creation helpers for overlay browser modules.

export function el(
  tag: string,
  props?: Record<string, string> | null,
  ...children: (HTMLElement | Text | string | null | undefined)[]
): HTMLElement {
  const node = document.createElement(tag);
  if (props) {
    for (const key of Object.keys(props)) {
      if (key === 'className') node.className = props[key];
      else if (key === 'placeholder') (node as HTMLInputElement).placeholder = props[key];
      else if (key === 'type') (node as HTMLInputElement).type = props[key];
      else if (key === 'value') (node as HTMLInputElement).value = props[key];
      else node.setAttribute(key, props[key]);
    }
  }
  for (const child of children) {
    if (child == null) continue;
    node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

export function kbd(text: string): HTMLElement {
  return el('kbd', null, text);
}

export function span(cls: string, text: string): HTMLElement {
  return el('span', { className: cls }, text);
}
