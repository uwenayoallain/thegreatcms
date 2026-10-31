// Every page is plain HTML: no hydration, so no JavaScript reaches a reader.
export const csr = false;
export const prerender = true;
// Each page is a folder with an index.html, so `/essays/x/` works on any static server.
export const trailingSlash = "always";
