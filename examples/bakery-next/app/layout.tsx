/** The page shell: the notice bar, the masthead and the footer, all from `site.identity`. */

import { GreatcmsPreview } from "@greatcms/reader/next";
import type { Metadata } from "next";
import localFont from "next/font/local";
import type { ReactNode } from "react";
import { content } from "#lib/cms";
import { Nav } from "./nav";
import { Lines } from "./parts";
import "./site.css";

const serif = localFont({
  src: [
    {
      path: "../node_modules/@fontsource/instrument-serif/files/instrument-serif-latin-400-normal.woff2",
      style: "normal",
    },
    {
      path: "../node_modules/@fontsource/instrument-serif/files/instrument-serif-latin-400-italic.woff2",
      style: "italic",
    },
  ],
  weight: "400",
  variable: "--font-serif",
  display: "swap",
});

export function generateMetadata(): Metadata {
  const { identity } = content();
  return {
    title: { default: identity.name, template: `%s · ${identity.name}` },
    description: identity.tagline,
  };
}

export default function Layout({ children }: { children: ReactNode }) {
  const { identity, visit } = content();
  return (
    <html lang="en" className={serif.variable}>
      <head>
        {/* The studio's preview script under `next dev`; a built page carries none of it. */}
        <GreatcmsPreview />
      </head>
      <body>
        <a className="skip-link" href="#main">
          Skip to content
        </a>
        <header>
          {identity.notice ? <p className="notice">{identity.notice}</p> : null}
          <div className="masthead">
            <a className="wordmark" href="/">
              {identity.name}
            </a>
            <Nav />
          </div>
        </header>
        <main id="main">{children}</main>
        <footer className="footer">
          <div>
            <p className="wordmark">{identity.name}</p>
            <p>{identity.tagline}</p>
          </div>
          <address>
            <Lines text={identity.address} />
            {identity.phone ? (
              <>
                <a href={`tel:${identity.phone.replaceAll(" ", "")}`}>{identity.phone}</a>
                <br />
              </>
            ) : null}
            {identity.email ? <a href={`mailto:${identity.email}`}>{identity.email}</a> : null}
          </address>
          {visit.hours?.length ? (
            <dl className="footer-hours">
              {visit.hours.map((row) => (
                <div key={row.days}>
                  <dt>{row.days}</dt>
                  <dd>{row.open}</dd>
                </div>
              ))}
            </dl>
          ) : null}
          <details className="colophon">
            <summary>How this site is built</summary>
            <ul>
              <li>The notice, the home page and the opening hours are edited in GreatCMS.</li>
              <li>Each menu item is a file of its own; the menu page groups them by category.</li>
              <li>
                Pre-orders arrive in the studio&apos;s inbox, with no form service in between.
              </li>
              <li>Next.js writes every page as plain HTML when the site is built.</li>
            </ul>
          </details>
        </footer>
      </body>
    </html>
  );
}
