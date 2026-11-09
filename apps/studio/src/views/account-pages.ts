/** Signing in, opening a share link, and managing the people who can edit. */

import { html } from "hono/html";
import type { Editor, Site } from "../db.js";
import { brandMark, flashNotice, page, type PageOptions, themeSwitch } from "./layout.js";
import { personAvatar, pixelWord } from "./pixel.js";

export function signInPage(
  options: { error?: string; next?: string; email?: string; editors?: boolean } = {},
): string {
  // A `next` that is a full address is a sibling host, such as the preview, asking us to vouch.
  const onward = options.next?.startsWith("/") === false ? new URL(options.next).host : null;
  return page(
    {
      title: "Sign in",
      chrome: false,
    },
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
        <section class="sign-in-form">
          ${options.error ? flashNotice({ kind: "error", message: options.error }) : ""}
          <div class="page-head">
            <h1>Sign in</h1>
            <p class="lede">
              ${
                onward
                  ? html`One password for the studio and the preview. You will continue to
                      <code>${onward}</code>.`
                  : html`Edit the sites connected to this studio. Content stays in their
                    repositories.`
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
          ${themeSwitch()}
        </section>
      </div>
    `,
  );
}

export function sharePage(options: { site: Site; url: string }): string {
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
          Anyone with this link sees the preview of ${site.name}, unpublished edits included, for
          seven days. It opens nothing in the studio. Changing the studio password revokes every
          link.
        </p>
      </div>
      <div class="field">
        <label for="share-url">Link</label>
        <input type="text" id="share-url" value="${url}" readonly />
      </div>
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
            />
          </div>
          <div class="field">
            <label for="token-value">Token</label>
            <input
              type="password"
              id="token-value"
              name="token"
              autocomplete="off"
              required
              ${tokenError ? html`aria-describedby="token-error" aria-invalid="true"` : ""}
            />
            ${tokenError ? html`<p class="error-text" id="token-error">${tokenError}</p>` : ""}
          </div>
          <div class="field">
            <label for="token-user">User name <span class="tag">optional</span></label>
            <input
              type="text"
              id="token-user"
              name="username"
              autocomplete="off"
              spellcheck="false"
              aria-describedby="token-user-hint"
            />
            <span class="hint" id="token-user-hint"
              >Known for GitHub, GitLab and Bitbucket. Other hosts: the account the token belongs
              to.</span
            >
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
