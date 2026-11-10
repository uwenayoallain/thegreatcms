/** Where the order form sends a visitor after the studio has the order. */

import type { Metadata } from "next";
import { Shell } from "../shell";

export const metadata: Metadata = { title: "Order received", robots: { index: false } };

export default function Thanks() {
  return (
    <Shell>
      <header className="page-head narrow">
        <p className="eyebrow">Order received</p>
        <h1>Thank you. We will be in touch.</h1>
        <p className="lede">
          We confirm every pre-order by email, usually within the hour while the shop is open.
        </p>
        <p>
          <a className="button" href="/menu/">
            Back to the menu
          </a>
        </p>
      </header>
    </Shell>
  );
}
