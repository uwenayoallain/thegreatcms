/** The page shell: the notice bar, the masthead and the footer, all from `site.identity`. */

import { PREVIEW_SCRIPT } from "@greatcms/reader/vite";
import type { Metadata } from "next";
import localFont from "next/font/local";
import type { ReactNode } from "react";
import { content, previewing } from "#lib/cms";
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
    // `next dev` does not watch content files, so the studio reloads the preview after each draft.
    <html
      lang="en"
      className={serif.variable}
      {...(previewing ? { "data-greatcms-unwatched": "" } : {})}
    >
      <head>
        {previewing ? (
          // The studio's preview chrome, in development only: a built page carries none of it.
          <script
            type="module"
            data-greatcms-preview
            dangerouslySetInnerHTML={{ __html: PREVIEW_SCRIPT }}
          />
        ) : null}
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
          <p className="small">Rendered by Next.js from files in Git, then served as plain HTML.</p>
        </footer>
      </body>
    </html>
  );
}
