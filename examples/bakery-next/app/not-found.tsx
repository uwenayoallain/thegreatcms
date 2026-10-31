/** Exported as `404.html`, which a static host serves for any missing page. */

import type { Metadata } from "next";

export const metadata: Metadata = { title: "Not found" };

export default function NotFound() {
  return (
    <header className="page-head narrow">
      <p className="eyebrow">404</p>
      <h1>That page has sold out.</h1>
      <p className="lede">Or it was never on the counter. The menu is a safer bet.</p>
      <p>
        <a className="button" href="/menu/">
          See the menu
        </a>
      </p>
    </header>
  );
}
