<script>
  import roman from "@fontsource-variable/newsreader/files/newsreader-latin-wght-normal.woff2?url";
  import italic from "@fontsource-variable/newsreader/files/newsreader-latin-wght-italic.woff2?url";
  import "../app.css";
  import { page } from "$app/state";

  let { data, children } = $props();
  // An essay is inside Essays: the link says so, without claiming to be the page itself.
  const current = (href) => {
    const path = page.url.pathname;
    if (path === href) return "page";
    if (href === "/" && path.startsWith("/essays/")) return "true";
    return undefined;
  };
</script>

<svelte:head>
  <!-- Both faces are on every page (the title is italic); `optional` uses only what arrives in time. -->
  <link rel="preload" href={roman} as="font" type="font/woff2" crossorigin="anonymous" />
  <link rel="preload" href={italic} as="font" type="font/woff2" crossorigin="anonymous" />
</svelte:head>

<a class="skip-link" href="#main">Skip to content</a>

<header class="masthead">
  <a class="title" href="/">{data.identity.title}</a>
  <nav aria-label="Main">
    <a href="/" aria-current={current("/")}>Essays</a>
    <a href="/about/" aria-current={current("/about/")}>About</a>
    <a href="#letter">Newsletter</a>
  </nav>
</header>

<main id="main">
  {@render children()}
</main>

<footer class="footer">
  <section class="letter" id="letter" aria-labelledby="letter-heading">
    <h2 id="letter-heading">{data.newsletter.heading}</h2>
    {#if data.newsletter.text}<p>{data.newsletter.text}</p>{/if}
    <form method="POST" action="{data.studio.url}/f/{data.studio.site}/newsletter">
      <label for="letter-email">Email address</label>
      <div class="inline">
        <input id="letter-email" name="email" type="email" autocomplete="email" required />
        <button type="submit">{data.newsletter.button ?? "Subscribe"}</button>
      </div>
      <input type="hidden" name="_redirect" value="/subscribed/" />
    </form>
  </section>
  <p class="colophon">
    <span>{data.identity.title} · {data.identity.author}</span>
    <span>Set in Newsreader, written in Markdown, built by SvelteKit with no JavaScript on the page.</span>
  </p>
</footer>
