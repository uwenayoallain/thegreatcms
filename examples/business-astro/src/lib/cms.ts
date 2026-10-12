import { createReader } from "@greatcms/reader";

// The build runs from the site's folder, which holds .cms/. A path built from
// import.meta.url breaks as soon as the bundler moves this file into dist/.
export const cms = createReader();
