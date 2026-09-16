// Font overrides from Settings | Tools | MilkJ. Crepe takes its typography from three custom
// properties that each editor theme defines on `.milkdown` (see the theme rules in main.ts). A
// chosen family is layered on top through a more specific rule, so a blank setting falls straight
// back to the theme's own font stack.

export interface FontFamilies {
  text?: string;
  heading?: string;
  code?: string;
}

export interface FontOverrides {
  apply(fonts: FontFamilies): void;
}

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/g;
// Settings come from the IDE's font picker, but the settings file can be edited by hand.
const MAX_FAMILY_LENGTH = 200;

/** Quotes a font family name for CSS, or undefined for a blank or unusable value. */
export function cssFontFamily(name: string | undefined): string | undefined {
  const cleaned = (name ?? "").replace(CONTROL_CHARACTERS, "").trim();
  if (!cleaned || cleaned.length > MAX_FAMILY_LENGTH) {
    return undefined;
  }
  return `"${cleaned.replace(/["\\]/g, "\\$&")}"`;
}

export function fontOverrideCss(fonts: FontFamilies): string {
  const declarations: string[] = [];
  const text = cssFontFamily(fonts.text);
  if (text) {
    declarations.push(`--crepe-font-default: ${text}, system-ui, sans-serif;`);
  }
  const heading = cssFontFamily(fonts.heading);
  if (heading) {
    declarations.push(`--crepe-font-title: ${heading}, system-ui, sans-serif;`);
  }
  const code = cssFontFamily(fonts.code);
  if (code) {
    declarations.push(`--crepe-font-code: ${code}, ui-monospace, monospace;`);
  }
  if (declarations.length === 0) {
    return "";
  }
  // Outranks every per-theme `:root[data-theme][data-editor-theme] .milkdown` rule in main.ts by
  // specificity, so it does not depend on where this style element sits in the document head.
  return `:root[data-theme][data-editor-theme] body .milkdown {\n  ${declarations.join("\n  ")}\n}\n`;
}

/** Installs one style element that survives Crepe rebuilding the editor DOM. */
export function installFontOverrides(page: Document = document): FontOverrides {
  const style = page.createElement("style");
  style.className = "milkj-fonts";
  page.head.append(style);
  return {
    apply(fonts) {
      style.textContent = fontOverrideCss(fonts);
    },
  };
}
