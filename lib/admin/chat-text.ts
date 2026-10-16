// Display text for an analyst-agent chat message. The agent writes in
// markdown habits (emphasis, bullet markers, headings) that the chat panes
// show as raw characters, since they render text, not markup. This strips
// the markup for display only: the stored message, and what the personas
// read, are unchanged. Pure.

/** The message with markdown emphasis, headings, inline code and link syntax
 * removed, and bullet markers shown as a plain bullet. */
export function plainChatText(text: string): string {
  return text
    .split("\n")
    .map((line) =>
      line
        // "## Heading" -> "Heading"
        .replace(/^(\s*)#{1,6}\s+/, "$1")
        // "- item", "* item", "+ item" -> "• item"
        .replace(/^(\s*)[-*+]\s+/, "$1• ")
        // "> quote" -> "quote"
        .replace(/^(\s*)>\s?/, "$1"),
    )
    .join("\n")
    // [label](url) -> label (url)
    .replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, "$1 ($2)")
    // **bold**, __bold__
    .replace(/(\*\*|__)(?=\S)([^\n]*?\S)\1/g, "$2")
    // *italic*, _italic_ (an underscore inside a word, as in tenure_months,
    // is left alone)
    .replace(/(^|[^\w*])\*(?=\S)([^*\n]*?\S)\*(?![\w*])/g, "$1$2")
    .replace(/(^|[^\w])_(?=\S)([^_\n]*?\S)_(?!\w)/g, "$1$2")
    // `code`
    .replace(/`([^`\n]+)`/g, "$1");
}
