/** The notice bar, the masthead and the main column. A page says which link is its own, so no script has to work it out. */

import type { ReactNode } from "react";
import { content } from "#lib/cms";

export function Shell({ current, children }: { current?: "menu"; children: ReactNode }) {
  const { identity } = content();
  return (
    <>
      <header>
        {identity.notice ? <p className="notice">{identity.notice}</p> : null}
        <div className="masthead">
          <a className="wordmark" href="/">
            {identity.name}
          </a>
          <nav aria-label="Main">
            <ul>
              <li>
                <a href="/menu/" aria-current={current === "menu" ? "page" : undefined}>
                  Menu
                </a>
              </li>
              <li>
                <a href="/#visit">Visit</a>
              </li>
              <li>
                <a className="pill" href="/#order">
                  Pre-order
                </a>
              </li>
            </ul>
          </nav>
        </div>
      </header>
      <main id="main">{children}</main>
    </>
  );
}
