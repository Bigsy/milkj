***

title: MilkJ Smoke Test
tags:

* milkj

* markdown

* smoke-test
  status: draft

***

# MilkJ Smoke Test

This file is a compact fixture for testing MilkJ rendering, editing, syncing, and round-trip
Markdown behavior.

Edit freely. Save it, switch to the native Markdown editor, edit there, then switch back to MilkJ.

## Project File Links

Hold Ctrl on Windows/Linux or Cmd on macOS while clicking these links in MilkJ:

> When testing with `./gradlew runIde`, open the MilkJ repository directory as the sandbox IDE's
> project before opening this file. Opening only this Markdown file leaves the repository outside
> the sandbox project's content roots, so path-bearing links are intentionally rejected.

Bare paths produced by tools or LLMs are linkified without changing their Markdown. Modifier-click
these as well:

../src/main/kotlin/com/hedworth/milkj/navigation/ProjectFileLinkResolver.kt#L35

`/frontend/src/project-links.ts#L13-L40`

* [Bridge implementation — relative to this file](../src/main/kotlin/com/hedworth/milkj/bridge/MilkJBridge.kt#L169)

* [Project link click handler — project-root-relative range](/frontend/src/project-links.ts#L10-L35)

* [Project file resolver — relative path](../src/main/kotlin/com/hedworth/milkj/navigation/ProjectFileLinkResolver.kt#L35)

* [README — no line fragment, so line 1](../README.md)

* [This smoke test — current-file line-only link](#L1)

The following links exercise safe failure behavior. They should leave MilkJ open and show a warning:

* [Missing file](../src/main/kotlin/com/hedworth/milkj/navigation/DoesNotExist.kt#L1)

* [Directory instead of file](../src/main/kotlin/com/hedworth/milkj/navigation)

* [Valid file but line outside its range](../README.md#L99999)

This web link should be suppressed on modifier-click without being sent to the IDE or navigating
JCEF: [Milkdown website](https://milkdown.dev).

## Inline Formatting

Plain text with **bold**, _italic_, _**bold italic**_, ~~strikethrough~~, `inline code`, and a
[link to Milkdown](https://milkdown.dev).

Reference links should survive too: [JetBrains](https://www.jetbrains.com).

## Lists

<br />

* First bullet

* Second bullet

  * Nested bullet

  * Another nested bullet with `code`

* Third bullet

1. First ordered item
2. Second ordered item

   1. Nested ordered item
   2. Another nested ordered item
3. Third ordered item

## Task List

```
test
more test
```

* [x] Open this file in MilkJ

* [x] Toggle light and dark mode

* [ ] Edit this checkbox in MilkJ

* [ ] Edit this file from the native Markdown tab

* [ ] Edit this file from a terminal while MilkJ is open

## Blockquote

> A blockquote with **formatting**.
>
> * Quoted list item
>
> * Another quoted item

## Table

| Feature  | Expected | Notes                                |
| -------- | -------: | ------------------------------------ |
| Headings |      Yes | H1/H2/H3 render cleanly              |
| Tables   |      Yes | Alignment should round-trip          |
| Tasks    |      Yes | GFM task list                        |
| Mermaid  |      Yes | Diagram preview plus fenced Markdown |

## Code Fence

```kotlin
fun greet(name: String): String {
    return "Hello, $name"
}

println(greet("MilkJ"))
```

## Mermaid

```Mermaid
flowchart TD
    A[Open Markdown file] --> B{Choose editor tab}
    B -->|MilkJ| C[Edit WYSIWYG]
    B -->|Built-in| D[Edit raw Markdown]
    C --> E[Sync to IntelliJ Document]
    D --> E
    E --> F[Save to disk]
```

```mermaid
sequenceDiagram
    participant User
    participant MilkJ
    participant IDE
    participant Disk

    User->>MilkJ: Type rich text
    MilkJ->>IDE: Debounced Markdown update
    IDE->>Disk: Save
    Disk-->>IDE: External file change
    IDE-->>MilkJ: Push refreshed Markdown
```

## Math

Inline math: $E = mc^2$.

Block math:

$$
\int_0^1 x^2 dx = \frac{1}{3}
$$

## Images

Select each rendered image by clicking it or moving the caret onto it. MilkJ should reveal a
Markdown source field with the image URL selected. Change the URL and press Enter; press Escape to
cancel. The local and remote examples should both render.

Project-local image (resolved relative to this Markdown file):

![1.00](../src/main/resources/META-INF/pluginIcon.svg "Local MilkJ plugin icon")

Remote image:

![1.00](https://raw.githubusercontent.com/Bigsy/milkj/main/src/main/resources/META-INF/pluginIcon.svg "Remote MilkJ plugin icon")

Embedded data URL image:

![1.00](data:image/svg+xml,%3Csvg%20xmlns=%22http://www.w3.org/2000/svg%22%20width=%22320%22%20height=%22120%22%20viewBox=%220%200%20320%20120%22%3E%3Crect%20width=%22320%22%20height=%22120%22%20rx=%2212%22%20fill=%22%2337618e%22/%3E%3Ccircle%20cx=%2270%22%20cy=%2260%22%20r=%2234%22%20fill=%22%23fdfcff%22/%3E%3Ctext%20x=%22125%22%20y=%2268%22%20font-family=%22Arial%2CHelvetica%2Csans-serif%22%20font-size=%2232%22%20font-weight=%22700%22%20fill=%22%23fdfcff%22%3EMilkJ%3C/text%3E%3C/svg%3E)

## Hard Breaks

This line ends with two spaces.\
This should appear directly underneath it.

This line uses a backslash.\
This should also appear directly underneath it.

## HTML Passthrough

<details>
<summary>HTML details block</summary>

Markdown inside HTML blocks can be tricky. This should at least preserve without being destroyed.

</details>

## Nested Stress Case

1. Parent ordered item

   * Mixed nested bullet

     > Quote inside a nested list
     >
     > ```text
     > quoted code fence
     > ```
2. Next ordered item

## Horizontal Rule

***

## Final Edit Area

Use this section for quick manual sync testing.

* MilkJ edit:

* Native editor edit:

* Terminal edit:
