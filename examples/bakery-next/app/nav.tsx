"use client";

/** The one client component: which page you are on is known in the browser, not in the layout. */

import { usePathname } from "next/navigation";

export function Nav() {
  const path = usePathname();
  return (
    <nav aria-label="Main">
      <ul>
        <li>
          <a href="/menu/" aria-current={path.startsWith("/menu") ? "page" : undefined}>
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
  );
}
