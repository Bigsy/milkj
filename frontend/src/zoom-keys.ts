/**
 * Ctrl/Cmd with `+`, `-` or `0` zooms the editor the way a browser tab would. The page only decides
 * which way to go; the IDE owns the zoom percentage (a MilkJ setting applied to every open tab
 * through the browser's native page zoom) and clamps the steps.
 *
 * Wire format (page -> IDE): `zoom:in`, `zoom:out` or `zoom:reset`.
 */
export type ZoomCommand = "in" | "out" | "reset";

export const ZOOM_PREFIX = "zoom:";

export function encodeZoomMessage(command: ZoomCommand): string {
  return `${ZOOM_PREFIX}${command}`;
}

/** The zoom command a keydown asks for, or undefined when it is not a zoom shortcut. */
export function zoomCommandForKey(event: KeyboardEvent): ZoomCommand | undefined {
  if (!(event.metaKey || event.ctrlKey) || event.altKey) {
    return undefined;
  }
  // `+` is Shift+= on most layouts, so Shift is accepted for zooming in only.
  switch (event.key) {
    case "=":
    case "+":
      return "in";
    case "-":
    case "_":
      return event.shiftKey ? undefined : "out";
    case "0":
      return event.shiftKey ? undefined : "reset";
  }
  switch (event.code) {
    case "NumpadAdd":
      return "in";
    case "NumpadSubtract":
      return event.shiftKey ? undefined : "out";
    case "Numpad0":
      return event.shiftKey ? undefined : "reset";
  }
  return undefined;
}

export interface ZoomShortcutOptions {
  send(message: string): void;
  target?: Window | Document | HTMLElement;
}

/** Installs the keyboard handling; returns the function that removes it again. */
export function installZoomShortcuts(options: ZoomShortcutOptions): () => void {
  const target = options.target ?? window;
  const onKeyDown = (event: Event) => {
    if (!(event instanceof KeyboardEvent) || event.defaultPrevented) {
      return;
    }
    const command = zoomCommandForKey(event);
    if (!command) {
      return;
    }
    event.preventDefault();
    options.send(encodeZoomMessage(command));
  };
  target.addEventListener("keydown", onKeyDown);
  return () => target.removeEventListener("keydown", onKeyDown);
}
