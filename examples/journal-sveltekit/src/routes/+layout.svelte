<script>
  import "@fontsource-variable/newsreader/opsz.css";
  import "@fontsource-variable/newsreader/opsz-italic.css";
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
    {data.identity.title} · {data.identity.author}. Set in Newsreader, written in Markdown, built by
    SvelteKit with no JavaScript on the page.
  </p>
</footer>
