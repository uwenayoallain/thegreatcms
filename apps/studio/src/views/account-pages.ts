/** Signing in, opening a share link, and managing the people who can edit. */

import { html } from "hono/html";
import type { Editor, Site } from "../db.js";
import { brandMark, flashNotice, page, type PageOptions, themeSwitch } from "./layout.js";
import { icon } from "./icons.js";
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

/** For someone signed in who can open none of the sites: GitHub lets them push to none, or none was given to them. */
export function noAccessPage(options: { name: string; login?: string }): string {
  return outside(
    "No sites to edit",
    html`
      <div class="page-head">
        <h1>No sites to edit</h1>
        <p class="lede">
          ${
            options.login
              ? html`You are signed in as ${options.name} (<code>${options.login}</code> on GitHub),
                  and that account cannot push to the repository of any site connected to this
                  studio.`
              : html`You are signed in as ${options.name}, and no site in this studio has been given
                to you to edit.`
          }
        </p>
      </div>
      <p>
        ${
          options.login
            ? `Access here follows GitHub. Ask whoever owns the site's repository to give your account
        write access to it, then open this page again: the site appears within a couple of minutes.`
            : "Ask whoever runs this studio to choose your sites, then open this page again."
        }
      </p>
      <form method="POST" action="/sign-out">
        <div class="actions"><button class="secondary" type="submit">Sign out</button></div>
      </form>
    `,
  );
}

export function signInPage(
  options: {
    error?: string;
    next?: string;
    email?: string;
    editors?: boolean;
    /** Whether the studio's GitHub App can sign people in. */
    github?: boolean;
  } = {},
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
      ${
        options.github
          ? html`<p class="sign-in-github">
                <a
                  class="button secondary"
                  href="/sign-in/github${options.next ? `?next=${encodeURIComponent(options.next)}` : ""}"
                  >${icon("github")} Continue with GitHub</a
                >
              </p>
              <p class="sign-in-or"><span>or with a password</span></p>`
          : ""
      }
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
          <strong>Taking it back.</strong> Stop sharing ends this link and every other link made for
          ${site.name}, at once. Links to other sites keep working; changing the studio's password
          ends those too, along with every session.
        </li>
      </ul>
      <div class="form-actions">
        <a class="button secondary" href="/sites/${site.id}">Back to ${site.name}</a>
        ${stopSharing(site)}
      </div>
    `,
  );
}

/** One button that ends a site's preview links, asked for twice like anything that cannot be undone. */
export function stopSharing(site: Site) {
  return html`<details class="inline-confirm">
    <summary>Stop sharing</summary>
    <form method="POST" action="/sites/${site.id}/share/stop">
      <button class="danger" type="submit">Confirm: end every link to ${site.name}</button>
    </form>
  </details>`;
}

/** One checkbox per site, and one for every site, as a group a plain form posts. */
function siteTicks(
  id: string,
  legend: string,
  sites: Site[],
  chosen: { allSites: boolean; sites: string[] },
) {
  return html`<fieldset class="site-ticks">
    <legend>${legend}</legend>
    <div class="checkbox">
      <input
        type="checkbox"
        id="${id}-all"
        name="all"
        value="1"
        ${chosen.allSites ? "checked" : ""}
      />
      <label for="${id}-all">Every site, and any connected later</label>
    </div>
    ${sites.map(
      (site, index) => html`<div class="checkbox">
        <input
          type="checkbox"
          id="${id}-${index}"
          name="sites"
          value="${site.id}"
          ${chosen.sites.includes(site.id) ? "checked" : ""}
        />
        <label for="${id}-${index}">${site.name}</label>
      </div>`,
    )}
  </fieldset>`;
}

export function editorsPage(options: {
  editors: Editor[];
  sites: Site[];
  flash?: PageOptions["flash"];
  values?: { name?: string; email?: string; allSites?: boolean; sites?: string[] };
}): string {
  const { editors, sites, values = {} } = options;
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
          People who sign in as themselves, and open only the sites ticked for them. Their publishes
          are committed under their name; sites and people stay yours to change.
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
                  <form method="POST" action="/editors/${editor.id}/sites" class="editor-sites">
                    ${siteTicks(`sites-${editor.id}`, `Sites ${editor.name} can open`, sites, editor)}
                    <button class="secondary" type="submit">Save sites</button>
                  </form>
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
        ${siteTicks("sites-new", "Sites they can open", sites, {
          allSites: values.allSites ?? false,
          sites: values.sites ?? [],
        })}
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
  /** Signing people in through the app: whether it can, where GitHub returns them, who is an owner. */
  signIn?: { ready: boolean; callback: string; owners: string[] };
}

/** Who may sign in with GitHub, or what an app made before sign-in existed still needs. */
function githubSignInSection(github: GitHubView) {
  const signIn = github.signIn;
  if (!signIn) return "";
  if (signIn.ready) {
    return html`<h3 id="github-sign-in">Signing in with GitHub</h3>
      <p>
        Anyone GitHub lets push to a connected site's repository can sign in with their GitHub
        account and edit that site, and only that site. Take their access away on GitHub and it ends
        here within two minutes, and at once for publishing.
        ${
          signIn.owners.length > 0
            ? html`Owners of this studio:
              ${signIn.owners.map(
                (login, index) => html`${index > 0 ? ", " : ""}<code>${login}</code>`,
              )}.`
            : html`No GitHub account is an owner of this studio: set
                <code>STUDIO_GITHUB_OWNERS</code> to name some.`
        }
      </p>`;
  }
  return html`<h3 id="github-sign-in">Signing in with GitHub</h3>
    <p>
      This app was made before the studio could sign people in with GitHub, so it is missing two
      things. Copying and pushing keep working as they are. To turn sign-in on without making the
      app again:
    </p>
    <ol class="steps">
      <li>
        Open
        ${
          github.settingsUrl
            ? html`<a href="${github.settingsUrl}">the app's settings on GitHub</a>`
            : "the app's settings on GitHub"
        }.
      </li>
      <li>Under Callback URL, add <code>${signIn.callback}</code> and save.</li>
      <li>Under Client secrets, generate a new client secret and copy it.</li>
      <li>Paste it here. It is kept beside the app's key and never shown again.</li>
    </ol>
    <form method="POST" action="/git-access/github/secret" class="card-form">
      <div class="field">
        <label for="client-secret">Client secret</label>
        <input type="password" id="client-secret" name="secret" autocomplete="off" required />
      </div>
      <div class="form-actions"><button type="submit">Turn on sign-in</button></div>
    </form>
    <p class="hint">
      Or disconnect GitHub below and connect it again: a new app has both from the start, and you
      choose its repositories again.
    </p>`;
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
    ${githubSignInSection(github)}
    <details class="danger-confirm">
      <summary>Disconnect GitHub</summary>
      <p>
        Uninstalls the app from every account and forgets it here. Copies already made stay, but
        nothing is pushed to GitHub until it is connected again, and everyone who signed in with
        GitHub is signed out.
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
