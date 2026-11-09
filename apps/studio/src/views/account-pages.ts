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

/** The studio's own key and tokens, so it can copy and push private repositories. */
export function gitAccessPage(options: {
  publicKey: string | null;
  tokens: Array<{ host: string; username: string }>;
  flash?: PageOptions["flash"];
  tokenError?: string;
  host?: string;
}): string {
  const { publicKey, tokens, tokenError } = options;
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
          publishing. Every site shares it. Use either one: an SSH key, or a token per host.
        </p>
      </div>

      <section class="connect-section" aria-labelledby="ssh-key">
        <h2 id="ssh-key">SSH key</h2>
        ${
          publicKey
            ? html`<p>
                  Add this public key where the repositories are: to your GitHub or GitLab account,
                  or a machine account, to reach every repository it can; or as a deploy key on one
                  repository, with write access if publishes are pushed. Then copy with the SSH
                  address, such as <code>git@github.com:you/site.git</code>.
                </p>
                <pre class="public-key">${publicKey}</pre>
                <details class="danger-confirm">
                  <summary>Remove this key</summary>
                  <p>Repositories reached with it stop working until another key is added.</p>
                  <form method="POST" action="/git-access/key/delete">
                    <button class="danger" type="submit">Confirm remove the key</button>
                  </form>
                </details>`
            : html`<p>
                  The studio makes its own key pair and keeps the private half in its data folder.
                  You add the public half to the host.
                </p>
                <form method="POST" action="/git-access/key">
                  <button type="submit">Create a key</button>
                </form>`
        }
      </section>

      <section class="connect-section" aria-labelledby="tokens">
        <h2 id="tokens">Access tokens</h2>
        <p>
          For https addresses. On GitHub, a fine-grained token with read and write access to
          Contents on the repositories this studio manages. Tokens are never shown again.
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
              placeholder="github.com"
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
