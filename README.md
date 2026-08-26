# MilkJ Markdown

[Install MilkJ Markdown from JetBrains Marketplace](https://plugins.jetbrains.com/plugin/32518-milkj)

MilkJ Markdown is a WYSIWYG Markdown editor for JetBrains IDEs. It adds a rich-text editor tab for `.md` and `.markdown` files while keeping the built-in Markdown source editor available alongside it.

Use it for README files, documentation, project notes, and AI-generated plans without leaving your IDE. Open a Markdown file and switch to the **MilkJ** tab to edit visually; switch back to the native tab whenever you want direct access to the source.

## Install

1. Open `Settings` -> `Plugins` -> `Marketplace` in your JetBrains IDE.
2. Search for **MilkJ Markdown**.
3. Select **Install**, restart the IDE if prompted, and open a Markdown file
4. Select the **MilkJ** editor tab.

You can also install it directly from the [JetBrains Marketplace listing](https://plugins.jetbrains.com/plugin/32518-milkj).

## Features

* WYSIWYG rich-text Markdown editing powered by Milkdown and Crepe.

* Native JetBrains editor tab integration for `.md` and `.markdown` files.

* Two-way sync with the IntelliJ document model, so edits flow between MilkJ and the built-in Markdown editor.

* Source-preserving round-trips apply only rich-text changes back to the original Markdown, protecting frontmatter, raw HTML, custom extensions, and existing formatting.

* Clicking a web link (`https`, `http`, or `mailto`) opens it in the system's default browser.

* Project-aware Markdown links and bare paths open in the JetBrains editor with Ctrl-click (Windows/Linux) or Cmd-click (macOS), including one-based references such as `src/main/kotlin/example/Bridge.kt#L151`.

* Relative links resolve from the Markdown file and then the project root; a leading `/` is project-root-relative inside MilkJ, for example `[Frontend](/frontend/src/main.ts#L127-L190)`.

* <br />

* Mermaid diagram previews for `mermaid` fenced code blocks.

* Mermaid language support in the code-block language picker.

* Math rendering via Crepe's built-in LaTeX support.

* Remote and project-local image rendering, with caret-aware Markdown source editing for selected images.

* Tables, task lists, headings, links, images, blockquotes, code blocks, and common Markdown formatting.

* Code blocks with syntax highlighting and language selection.

* Configurable default Markdown editor: open Markdown files with the built-in editor first, or with MilkJ first.

* Theme settings:

  * Follow IDE, Light, or Dark mode.

  * Editor themes: Nord, Classic, and Frame.

  * Mermaid themes: Auto, Default, Dark, Forest, Neutral, and Base.

| <br />                                                                                                                               | <br />                                                                                                                               |
| ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| <img width="1261" height="1260" alt="image" src="https://github.com/user-attachments/assets/42fa8fc0-da56-40a9-bd24-5da29c609f24" /> | <img width="1259" height="1267" alt="image" src="https://github.com/user-attachments/assets/fb2370b5-10c3-4e2e-9501-1d39b7889bf8" /> |
| <img width="1267" height="1264" alt="image" src="https://github.com/user-attachments/assets/5b34ecfb-d884-409a-809a-2618150c3fdb" /> | <img width="1300" height="1251" alt="image" src="https://github.com/user-attachments/assets/55f1bdd9-f922-485f-9b25-a5eab17fe4b6" /> |

## Settings

MilkJ settings are available under:

`Settings` -> `Tools` -> `MilkJ`

From there you can choose the default Markdown editor, editor theme, Mermaid theme, and light/dark behavior. You can also manage individual custom-dictionary entries and import, enable, disable, or remove Harper `.weirpack` archives.

## Feedback and support

- [Report a bug or request a feature](https://github.com/Bigsy/milkj/issues)
- [View the source code](https://github.com/Bigsy/milkj)
- [JetBrains Marketplace listing](https://plugins.jetbrains.com/plugin/32518-milkj)

## Release builds

Prepare the leading entry in `src/main/resources/META-INF/plugin.xml` for the new release, then run:

```shell
make mint
```

This increments the patch component of `pluginVersion`, runs the frontend and plugin checks, and writes the Marketplace ZIP to `build/distributions/`. Use `make release` to rebuild the current version without incrementing it again.

## Notes

MilkJ is designed to live alongside the built-in JetBrains Markdown editor rather than replace it. You can move between the rich-text MilkJ tab and the native Markdown editor whenever you need direct source editing.

## License

MilkJ is available under the MIT License.
