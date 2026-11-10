/** Signing in, opening a share link, and managing the people who can edit. */

import { html } from "hono/html";
import type { Editor, Site } from "../db.js";
import { brandMark, flashNotice, page, type PageOptions, themeSwitch } from "./layout.js";
import { when } from "./locale.js";
import { personAvatar, pixelWord } from "./pixel.js";

/** The screen someone without a session sees: the studio's name on one side, what to do on the other. */
function outside(title: string, body: ReturnType<typeof html>): string {
  return page(
    { title, chrome: false },
    html`
      <div class="sign-in">
        <section class="sign-in-art" aria-label="GreatCMS Studio">
          <p class="brand">
            ${brandMark()}
            <span>GreatCMS <small>Studio</small></span>
          </p>
          <div class="sign-in-word">
            ${pixelWord("GreatCMS", { face: "#f3f3f3", shadow: "#12a37a", label: "GreatCMS" })}
            <p>Your sites are folders in Git. What you publish here is one commit in them.</p>
          </div>
          <p class="pixel-rule" aria-hidden="true"></p>
        </section>
        <section class="sign-in-form">${body} ${themeSwitch()}</section>
      </div>
    `,
  );
}

/** What someone sees when a preview link does not open: what happened, and what to ask for. */
export function shareProblemPage(): string {
  return outside(
    "Preview link",
    html`
      <div class="page-head">
        <h1>This preview link no longer works</h1>
        <p class="lede">
          Preview links open for seven days, and whoever runs the studio can withdraw them sooner.
          This one has run out, was withdrawn, or was not copied whole.
        </p>
      </div>
      <p>Ask the person who sent it for a new link. Nothing is wrong on your side.</p>
      <p class="hint">Have an account on this studio? <a href="/sign-in">Sign in</a> instead.</p>
    `,
  );
}

/**
 * What a chat app draws when the link is pasted into it: that this is a private preview and of
 * what, with none of the site's unpublished content and nothing from the link itself.
 */
export function shareCard(siteName: string, open: string): string {
  const title = `Preview of ${siteName}`;
  const about = "A private preview of work in progress, shared from GreatCMS. The link opens it.";
  return html`<!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="robots" content="noindex, nofollow" />
        <title>${title}</title>
        <meta name="description" content="${about}" />
        <meta property="og:title" content="${title}" />
        <meta property="og:description" content="${about}" />
        <meta property="og:site_name" content="GreatCMS" />
        <meta property="og:type" content="website" />
        <meta name="twitter:card" content="summary" />
      </head>
      <body>
        <h1>${title}</h1>
        <p>${about}</p>
        <p><a href="${open}" rel="nofollow">Open the preview</a></p>
      </body>
    </html>`.toString();
}

export function signInPage(
  options: { error?: string; next?: string; email?: string; editors?: boolean } = {},
): string {
  // A `next` that is a full address is a sibling host, such as the preview, asking us to vouch.
  const onward = options.next?.startsWith("/") === false ? new URL(options.next).host : null;
  return outside(
    "Sign in",
    html`
      ${options.error ? flashNotice({ kind: "error", message: options.error }) : ""}
      <div class="page-head">
        <h1>Sign in</h1>
        <p class="lede">
          ${
            onward
              ? html`<code>${onward}</code> is a private preview. Sign in to the studio to see it.`
              : html`Edit the sites connected to this studio. Content stays in their repositories.`
          }
        </p>
      </div>
      <form method="POST" action="/sign-in">
        ${options.next ? html`<input type="hidden" name="next" value="${options.next}" />` : ""}
        ${
          options.editors
            ? html`<div class="field">
                <label for="email">Email</label>
                <span class="hint" id="email-hint">Leave empty to sign in as the owner.</span>
                <input
                  type="email"
                  id="email"
                  name="email"
                  autocomplete="username"
                  aria-describedby="email-hint"
                  value="${options.email ?? ""}"
                />
              </div>`
            : ""
        }
        <div class="field">
          <label for="password">Password</label>
          <input
            type="password"
            id="password"
            name="password"
            autocomplete="current-password"
            required
            autofocus
          />
        </div>
        <div class="actions"><button type="submit">Sign in</button></div>
      </form>
      ${
        onward
          ? html`<p class="hint outsider">
              Sent here by a preview link? It has run out: ask the person who shared it for a new
              one.
            </p>`
          : ""
      }
    `,
  );
}

export function sharePage(options: { site: Site; url: string; until: string }): string {
  const { site, url } = options;
  return page(
    {
      title: "Preview link",
      section: "sites",
      crumbs: [
        { href: "/", label: "Sites" },
        { href: `/sites/${site.id}`, label: site.name },
      ],
    },
    html`
      <div class="page-head">
        <h1>Preview link</h1>
        <p class="lede">
          Send this to someone without an account. It opens the preview of ${site.name} and nothing
          in the studio.
        </p>
      </div>
      <div class="field share-link">
        <label for="share-url">Link to copy</label>
        <input
          type="text"
          id="share-url"
          class="source"
          value="${url}"
          readonly
          autofocus
          spellcheck="false"
          aria-describedby="share-url-hint"
        />
        <span class="hint" id="share-url-hint">
          Select it all and copy, or
          <a href="${url}" target="_blank" rel="noopener noreferrer">open it yourself</a> to see
          what they will.
        </span>
      </div>
      <ul class="share-terms">
        <li>
          <strong>What it shows.</strong> The site as the preview has it now, unpublished edits
          included, and every page of it, not only this one.
        </li>
        <li>
          <strong>How long.</strong> Seven days, until ${when(options.until)}. Anyone the link is
          passed on to can open it until then.
        </li>
        <li>
          <strong>Taking it back.</strong> Changing the studio's password ends every preview link at
          once, along with every session. One link cannot be withdrawn on its own.
        </li>
      </ul>
      <p><a class="button secondary" href="/sites/${site.id}">Back to ${site.name}</a></p>
    `,
  );
}

export function editorsPage(options: {
  editors: Editor[];
  flash?: PageOptions["flash"];
  values?: { name?: string; email?: string };
}): string {
  const { editors, values = {} } = options;
  return page(
    {
      title: "Editors",
      section: "editors",
      flash: options.flash,
    },
    html`
      <div class="page-head">
        <h1>Editors</h1>
        <p class="lede">
          People who sign in as themselves. Their publishes are committed under their name; sites
          and people stay yours to change.
        </p>
      </div>

      ${
        editors.length > 0
          ? html`<ul class="editors" role="list">
              ${editors.map(
                (editor) => html`<li>
                  ${personAvatar(editor.name)}
                  <div>
                    <strong>${editor.name}</strong>
                    <span class="muted">${editor.email}</span>
                  </div>
                  <details class="inline-confirm">
                    <summary>New password</summary>
                    <form method="POST" action="/editors/${editor.id}/password" class="row-form">
                      <label class="visually-hidden" for="password-${editor.id}"
                        >New password for ${editor.name}</label
                      >
                      <input
                        type="password"
                        id="password-${editor.id}"
                        name="password"
                        minlength="12"
                        autocomplete="new-password"
                        required
                      />
                      <button class="secondary" type="submit">Set</button>
                    </form>
                  </details>
                  <details class="inline-confirm">
                    <summary>Remove</summary>
                    <form method="POST" action="/editors/${editor.id}/delete">
                      <button class="danger" type="submit">Confirm remove ${editor.name}</button>
                    </form>
                  </details>
                </li>`,
              )}
            </ul>`
          : html`<div class="empty compact">
              <h2>Only you, so far</h2>
              <p>Add someone below and they sign in with their own email and password.</p>
            </div>`
      }

      <form method="POST" action="/editors" class="card-form">
        <h2>Add an editor</h2>
        <div class="row">
          <div class="field">
            <label for="name">Name</label>
            <input type="text" id="name" name="name" required value="${values.name ?? ""}" />
          </div>
          <div class="field">
            <label for="email">Email</label>
            <input
              type="email"
              id="email"
              name="email"
              required
              autocomplete="off"
              value="${values.email ?? ""}"
            />
          </div>
        </div>
        <div class="field">
          <label for="password">Password</label>
          <span class="hint" id="password-hint"
            >At least 12 characters. Give it to them directly.</span
          >
          <input
            type="password"
            id="password"
            name="password"
            minlength="12"
            autocomplete="new-password"
            aria-describedby="password-hint"
            required
          />
        </div>
        <div class="form-actions"><button type="submit">Add editor</button></div>
      </form>
    `,
  );
}

/** What the Git access page shows about GitHub. */
export interface GitHubView {
  config: { slug: string; owner: string; htmlUrl: string } | null;
  installUrl: string | null;
  settingsUrl: string | null;
  state:
    | { connected: false }
    | {
        connected: true;
        error?: string;
        installations?: Array<{ id: number; account: string }>;
        repositories?: Array<{ fullName: string }>;
      };
}

/** How the studio signs in to Git hosts: GitHub through its own app, other hosts by token. */
export function gitAccessPage(options: {
  tokens: Array<{ host: string; username: string }>;
  github?: GitHubView;
  flash?: PageOptions["flash"];
  tokenError?: string;
  host?: string;
}): string {
  const { tokens, tokenError, github } = options;
  const wrong = !tokenError
    ? ""
    : /host name/.test(tokenError)
      ? "host"
      : /user name/.test(tokenError)
        ? "user"
        : "value";
  const tokenProblem = (field: string) =>
    wrong === field ? html`<p class="error-text" id="token-error">${tokenError}</p>` : "";
  const invalid = (field: string) =>
    wrong === field ? html`aria-describedby="token-error" aria-invalid="true"` : "";
  return page(
    {
      title: "Git access",
      section: "sites",
      crumbs: [
        { href: "/", label: "Sites" },
        { href: "/git-access", label: "Git access" },
      ],
      flash: options.flash,
    },
    html`
      <div class="page-head">
        <h1>Git access</h1>
        <p class="lede">
          How this studio signs in to Git hosts, to copy private repositories and to push after
          publishing. Every site shares it.
        </p>
      </div>

      ${github ? githubSection(github) : ""}
      <section class="connect-section" aria-labelledby="tokens">
        <h2 id="tokens">Other Git hosts</h2>
        <p>
          GitLab, Bitbucket, or a Git server of your own: save an access token that can read and
          write the repositories this studio manages. Tokens are never shown again.
        </p>
        ${
          tokens.length
            ? html`<ul class="folders" role="list">
                ${tokens.map(
                  (token) => html`<li>
                    <div>
                      <strong>${token.host}</strong>
                      <span class="muted">as ${token.username}</span>
                    </div>
                    <form method="POST" action="/git-access/token/delete">
                      <input type="hidden" name="host" value="${token.host}" />
                      <button class="secondary" type="submit">
                        Remove<span class="visually-hidden"> the token for ${token.host}</span>
                      </button>
                    </form>
                  </li>`,
                )}
              </ul>`
            : ""
        }
        <form method="POST" action="/git-access/token" class="card-form">
          <div class="field">
            <label for="token-host">Host</label>
            <input
              type="text"
              id="token-host"
              name="host"
              value="${options.host ?? ""}"
              placeholder="gitlab.com"
              autocomplete="off"
              spellcheck="false"
              required
              ${invalid("host")}
            />
            ${tokenProblem("host")}
          </div>
          <div class="field">
            <label for="token-value">Token</label>
            <input
              type="password"
              id="token-value"
              name="token"
              autocomplete="off"
              required
              ${invalid("value")}
            />
            ${tokenProblem("value")}
          </div>
          <div class="field">
            <label for="token-user">User name</label>
            <input
              type="text"
              id="token-user"
              name="username"
              autocomplete="off"
              spellcheck="false"
              aria-describedby="token-user-hint${wrong === "user" ? " token-error" : ""}"
              ${wrong === "user" ? html`aria-invalid="true"` : ""}
            />
            <span class="hint" id="token-user-hint"
              >Leave empty for GitHub, GitLab and Bitbucket. Any other host needs the account the
              token belongs to.</span
            >
            ${tokenProblem("user")}
          </div>
          <div class="form-actions">
            <button type="submit">Save token</button>
          </div>
        </form>
      </section>
    `,
  );
}

function githubSection(github: GitHubView) {
  const { config, state } = github;
  if (!config) {
    return html`<section class="connect-section" aria-labelledby="github">
      <h2 id="github">GitHub</h2>
      <p>
        The studio makes a GitHub App of its own, in two clicks on GitHub. You then choose the
        repositories it may use, and it asks GitHub for a sign-in that lasts an hour each time it
        copies or pushes: no password or key is kept. It can read and write those repositories'
        files, and nothing else.
      </p>
      <form method="POST" action="/git-access/github" class="card-form">
        <div class="field">
          <label for="organization">Organization <span class="tag">optional</span></label>
          <input
            type="text"
            id="organization"
            name="organization"
            autocomplete="off"
            spellcheck="false"
            aria-describedby="organization-hint"
          />
          <span class="hint" id="organization-hint"
            >Empty to own the app with your own account. An organization's owners can make it belong
            to the organization instead.</span
          >
        </div>
        <div class="form-actions">
          <button type="submit">Connect GitHub</button>
        </div>
      </form>
    </section>`;
  }
  const accounts = state.connected ? (state.installations ?? []) : [];
  const repositories = state.connected ? (state.repositories ?? []) : [];
  return html`<section class="connect-section" aria-labelledby="github">
    <h2 id="github">GitHub</h2>
    <p>
      Connected through the app <a href="${config.htmlUrl}">${config.slug}</a>${
        config.owner ? html`, owned by ${config.owner}` : ""
      }.
      ${
        state.connected && state.error
          ? html`<span class="error-text">${state.error}</span>`
          : accounts.length
            ? html`It reaches ${repositories.length}
              ${repositories.length === 1 ? "repository" : "repositories"} in
              ${accounts.map((entry) => entry.account).join(", ")}.`
            : html`It is not installed anywhere yet, so it reaches no repositories.`
      }
    </p>
    <div class="form-actions">
      ${
        github.installUrl
          ? html`<a class="button" href="${github.installUrl}">Choose repositories on GitHub</a>`
          : ""
      }
      <form method="POST" action="/git-access/github/refresh">
        <button class="secondary" type="submit">Check again</button>
      </form>
    </div>
    ${
      github.settingsUrl
        ? html`<div class="app-logo">
            <img src="/greatcms-logo.png" alt="" width="56" height="56" />
            <p>
              GitHub takes an app's logo only by upload. To show the GreatCMS mark wherever GitHub
              lists the app,
              <a href="/greatcms-logo.png" download="greatcms-logo.png">download the logo</a>, then
              add it under Display information in
              <a href="${github.settingsUrl}">the app's settings</a>.
            </p>
          </div>`
        : ""
    }
    <details class="danger-confirm">
      <summary>Disconnect GitHub</summary>
      <p>
        Uninstalls the app from every account and forgets it here. Copies already made stay, but
        nothing is pushed to GitHub until it is connected again.
      </p>
      <form method="POST" action="/git-access/github/delete">
        <button class="danger" type="submit">Confirm disconnect GitHub</button>
      </form>
    </details>
  </section>`;
}

/** One step on GitHub's own page: the manifest goes there, and GitHub makes the app. */
export function githubCreatePage(options: {
  action: string;
  manifest: string;
  organization: string;
}): string {
  return page(
    {
      title: "Connect GitHub",
      section: "sites",
      crumbs: [
        { href: "/", label: "Sites" },
        { href: "/git-access", label: "Git access" },
        { href: "/git-access", label: "Connect GitHub" },
      ],
    },
    html`
      <div class="page-head">
        <h1>Connect GitHub</h1>
        <p class="lede">
          GitHub opens with the app filled
          in${options.organization ? html` for ${options.organization}` : ""}: you may rename it,
          then create it. GitHub brings you back here, and on to choosing which repositories it may
          use.
        </p>
      </div>
      <form method="POST" action="${options.action}" class="page-form">
        <input type="hidden" name="manifest" value="${options.manifest}" />
        <div class="form-actions">
          <button type="submit">Continue to GitHub</button>
          <a class="button secondary" href="/git-access">Cancel</a>
        </div>
      </form>
    `,
  );
}
