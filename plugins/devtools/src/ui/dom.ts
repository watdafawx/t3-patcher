type Child = Node | string | null | undefined | false;

export interface Props {
  class?: string;
  text?: string;
  title?: string;
  placeholder?: string;
  value?: string;
  type?: string;
  data?: Record<string, string>;
  attrs?: Record<string, string>;
  on?: Partial<{ [K in keyof HTMLElementEventMap]: (ev: HTMLElementEventMap[K]) => void }>;
}

/** Tiny element builder. No innerHTML anywhere: log and chunk text is always textContent. */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props.class) el.className = props.class;
  if (props.text !== undefined) el.textContent = props.text;
  if (props.title) el.title = props.title;
  if (props.type) el.setAttribute("type", props.type);
  if (props.attrs) for (const [k, v] of Object.entries(props.attrs)) el.setAttribute(k, v);
  if (tag === "input" || tag === "textarea") {
    const field = el as unknown as HTMLInputElement | HTMLTextAreaElement;
    if (props.placeholder) field.placeholder = props.placeholder;
    if (props.value !== undefined) field.value = props.value;
  }
  if (props.data) for (const [k, v] of Object.entries(props.data)) el.dataset[k] = v;
  if (props.on) for (const [type, fn] of Object.entries(props.on)) el.addEventListener(type, fn as EventListener);
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    el.append(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return el;
}

export function clear(el: Element): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

/** Text with its leading/trailing whitespace visible enough to read in a snippet. */
export function shorten(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}... [${text.length - max} more chars]`;
}
