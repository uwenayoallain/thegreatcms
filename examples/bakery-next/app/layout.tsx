/** The document and the footer; each page brings its own header through `Shell`, which knows where it is. */

import { GreatcmsPreview } from "@greatcms/reader/next";
import type { Metadata } from "next";
import localFont from "next/font/local";
import type { ReactNode } from "react";
import { content, origin } from "#lib/cms";
import { Lines } from "./parts";
import "./site.css";

// Only the upright face: nothing set in the serif is italic, and every preload competes with the page.
const instrumentSerif = localFont({
  src: "../node_modules/@fontsource/instrument-serif/files/instrument-serif-latin-400-normal.woff2",
  weight: "400",
  style: "normal",
  variable: "--font-serif",
  // Preloaded, so it is normally there for the first paint; if it is late the page keeps the
  // metric-matched fallback in site.css rather than reflowing when it lands.
  display: "optional",
  adjustFontFallback: false,
});

export function generateMetadata(): Metadata {
  const { identity } = content();
  return {
    metadataBase: new URL(origin),
    title: { default: identity.name, template: `%s · ${identity.name}` },
    description: identity.tagline,
    openGraph: { type: "website", images: ["/og.png"] },
    twitter: { card: "summary_large_image" },
  };
}

export default function Layout({ children }: { children: ReactNode }) {
  const { identity, visit } = content();
  return (
    <html lang="en" className={instrumentSerif.variable}>
      <head>
        {/* The studio's preview script under `next dev`; a built page carries none of it. */}
        <GreatcmsPreview />
      </head>
      <body>
        <a className="skip-link" href="#main">
          Skip to content
        </a>
        {children}
        <footer className="footer">
          <div>
            <p className="wordmark">{identity.name}</p>
            <p>{identity.tagline}</p>
          </div>
          <address>
            {identity.address ? <Lines text={identity.address} /> : null}
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
