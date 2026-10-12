import { html } from "hono/html";

export function removeBlockControl(label: string, action: string) {
  return html`
    <details class="block-remove-confirm">
      <summary aria-label="Remove ${label}">Remove</summary>
      <div class="block-remove-panel">
        <p><strong>Remove ${label}?</strong></p>
        <p>Its content will be removed from this edit. Publish to save the change.</p>
        <button
          type="submit"
          name="action"
          value="${action}"
          aria-label="Confirm remove ${label}"
          formnovalidate
        >
          Confirm remove
        </button>
        <span class="hint">Close “Remove” to keep it.</span>
      </div>
    </details>
  `;
}
