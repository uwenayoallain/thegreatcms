---
title: Managing content
summary: A site's owner and editors, day to day in the studio, and what each button becomes in Git.
order: 33
---

The studio is where the people who look after a site change its words and
images without opening a code editor or a terminal. Everything it does ends as
files in the site's repository, so this page follows a day's work from the
screen to the commit. Installing it is covered in
[Running the studio](/docs/running-the-studio/).

## Connecting a site

On your own machine `npx greatcms studio`, run in the site's folder, opens the
studio with that site already connected. On a shared studio, connecting is the
owner's job, done once per site from **Connect a site**:

- **In the sites folder.** Folders in the studio's sites folder are listed;
  one with a schema connects with a click.
- **From GitHub.** Once GitHub is connected on **Git access**, the
  repositories you allowed are listed and each copies with a click.
- **Copy from Git.** Paste any https or SSH address. Only files are fetched:
  no hooks, no submodules.
- **By path.** Any other folder on the machine.

A folder with no `.cms/schema.yaml` offers **Set up**: choose one of the
`greatcms init` starters, and the studio commits `.cms/schema.yaml` and
`.cms/config.yaml` in one commit and connects the site, changing nothing else.
The variables behind each way are in
[Connecting a site](/docs/running-the-studio/#connecting-a-site).

## A site at a glance

![The Paraline site in the studio: its working copy, a running live preview, publishing as one commit, and cards for each page region and collection with who edited it last.](/screens/studio-site.webp)

A site's page is where editors start. It says where the working copy is,
whether the live preview is running, and where a publish goes: one commit, or
one commit pushed to the branch's upstream. Below that, every **page region**
(one part of the site, such as the home page's hero) and every **collection**
(a list of entries, such as projects or posts) is a card saying who changed it
last. Further down are recent changes from Git, unsaved edits nobody has
published, publishes scheduled for later and, on a server with the builder,
what is live.

The sidebar holds the same list, plus **Search content**, which finds words in
every region and entry, unpublished drafts included, and opens the field that
holds them. Press `/` to jump to it.

## Editing a region or an entry

The form is built from the site's schema: one control per field, labelled and
described the way the schema describes it, with the limits it sets. A list
grows by filling its empty row. An image takes an upload or one already on the
site, and will not save without alt text unless the field allows an empty one.
A field of sections offers **Add a section**, with arrows to reorder and
**Remove** on each one.

Every one of those actions is an ordinary form post. With JavaScript switched
off the editor still adds, reorders and publishes; the script only makes it
quicker. Content is checked against the schema before anything is written, and
a field that fails says why beside it.

Entries in a collection are added from the collection's page, or the **Add**
link on its card, and each entry's file name comes from the field the schema
names, usually its title. Creating one never
replaces another: if the name is taken, the studio asks for a different title.

## The visual editor

![Editing the body of a project in the visual editor: bold, italic, two heading levels, paragraph, lists, quote, code and link in the toolbar, and the new paragraph already on the page in the live preview beside it.](/screens/studio-richtext.webp)

A rich-text field opens in a visual editor built on ProseMirror: bold, italic,
two heading levels, paragraphs, bulleted and numbered lists, quotes, code and
links, with `Ctrl` or `Cmd` and `B`, `I` and `Z` doing what they usually do. It
deliberately stops there: this edits web copy, and the site's own design does
the rest.

What it stores is plain HTML, so any language can render it without a library.
Underneath it is a real textarea holding that HTML, and the form submits the
textarea. If the editor's script is blocked or fails, the textarea is simply
shown and editing carries on. Only screens with a rich-text field load the
script at all.

The body of an MDX entry is code the site's build runs, so only the owner
changes it; an editor sees it and cannot alter it. See
[People](/docs/running-the-studio/#people).

## The live preview

![The Home hero region with Select switched on: the third headline line changed to "move" in the form already reads that way in the preview, and pointing at the paragraph under the headline outlines it with its field name, Lede.](/screens/studio-region.webp)

When a site has a dev server, the editor frames it beside the form. It is the
real site, rendered by its own components, not an imitation of it. As you type,
each change is written to `.cms/draft/` in the working copy a moment later, the
dev server reloads, and the page shows content nobody has published. Drafts
never reach a build, and publishing clears them.

The buttons above the frame:

- **Select** turns the page into a map of the form. Point at a heading,
  paragraph or image and it is outlined with its field's name; click it and that
  field opens in the form, focused. Going the other way, landing in a field
  scrolls the page to where it renders.
- **Sections** outlines every section on the page at once.
- **Desktop** and **phone** width, **reload**, **open in a new tab**, and
  **share a preview link**, which anyone can open for seven days without an
  account (see [Sharing the preview](/docs/self-hosting/#sharing-the-preview)).

Leave the editor with unpublished edits and they are still there when you come
back, with a notice saying so. **Discard unsaved edits** throws them away and
puts the preview back to what is published. More on this, including how to
point the inspector at a value the site transforms, in
[Previewing](/docs/previewing/).

## Publishing

**Publish** writes everything in the form, and any images it uploaded, as one
commit in the site's working copy, or nothing at all if anything fails. An
editor's publish is committed under their own name and email, so `git log`
says who changed what. `Ctrl` or `Cmd` with `Enter` does the same.

If the same content was published by someone else since you opened it, your
publish is refused rather than overwriting theirs. **Publish later** keeps the
form as it is and publishes it at the time you choose, through the same path;
the site's page lists what is waiting and lets you cancel it.

With **Push after every publish** on in the site's settings, each commit is
pushed to the branch's upstream, and the host deploys it as it deploys any
push. Details, and what happens when a push fails, are in
[Publishing](/docs/publishing/).

## History and rollback

Every region and entry has a **History** link listing the commits that changed
it, with the author, the date and the commit. **Restore this version** opens that version
in the editor as an unsaved edit: it shows in the preview first, and publishing
it makes one new commit. Nothing in Git is rewritten.

On a server where the builder deploys the site, the site's page also shows what
is live, any build that failed with its log, and the releases kept on disk.
**Put this back live** returns the site to one of them until the next publish;
see [The builder](/docs/self-hosting/#the-builder).

## People

The owner signs in with the studio password and is the only one who connects
sites, changes their settings and manages people. From **Editors** the owner
adds each person with a name, an email and a password of their own. Editors
change content: regions, entries, images, drafts and publishes. When two
people have the same content open, each sees the other's name.

Form submissions from the site land in the **Inbox**, separate from content;
see [Forms and submissions](/docs/forms-and-submissions/).

## Branches and review on GitHub

By default a publish lands on the branch the working copy has checked out. To
keep publishes off the live site until someone has looked at them, type a new
name into **Branch** in the site's settings. The studio starts that branch from
the current one, or picks it up from the remote if it is already there, and
every publish is committed on it and, with pushing on, pushed to the branch of
the same name.

When the remote is on GitHub, the site's page then links **Review and merge on
GitHub**, the comparison between that branch and the repository's main one.
Review, comment and merge there, and the host deploys the merge. Switching
branches is refused while the folder has changes that are not committed, so
nobody's work is carried across by accident.

## Git access

**Git access** is where the owner lets the studio reach repositories it does
not already have credentials for.

- **GitHub.** The studio creates its own GitHub App in two clicks, and you
  choose which repositories it may use. Each copy and each push gets a token
  that lasts an hour, passed only to that one Git command, so no credential is
  written into a repository or onto a command line.
- **Other hosts.** For GitLab, Bitbucket or your own server, save an access
  token for the host. It is kept in Git's own credential store and used for
  copying and for pushing after a publish alike.

Whichever way a repository arrives, the studio never runs anything from it:
not a build, not a hook. Previews are the site's own dev server, and checks
belong in CI.
