# Persona packs

A persona is who DearByte is when it talks to you: its name, its tone, how it
jokes, what it says when you're having a bad day. Anyone can write one and
share it in a pull request. Every pack that's merged is listed in
[personas/INDEX.md](../personas/INDEX.md) with its authors and version, and git
keeps its full history.

A persona changes how DearByte talks, never what it may do. The
[rules](../prompts/agent/rules.en.md) go after every persona in the prompt and
win where they differ: facts come only from tools, missing data is reported as
unknown, anything involving money is stated plainly, and DearByte can only
*propose* a purchase. Approvals, caps and the seller allowlist are enforced in
code, so no persona can pay for anything.

## Using one

```bash
npm run personas                       # the packs you have, and whether each passes the checks
```

Then set `DEARBYTE_PERSONA=<id>` in `.env` and restart DearByte.
`npm run agent -- status` shows which persona is active.

## Writing one

1. Copy an existing pack: `cp -r personas/default personas/<your-id>`. The id
   is the folder name: 2 to 32 lowercase letters, digits and dashes, starting
   with a letter (`pirate`, `grandma-es`, `stoic-coach`).
2. Edit the three files described below.
3. Try it: `DEARBYTE_PERSONA=<your-id> npm run agent -- chat`, and check it with
   `npm run personas -- check <your-id>`.
4. Run `npm run personas -- index` to add your pack to the index, then open a PR
   with all of `personas/<your-id>/` and `personas/INDEX.md`.

### `persona.json`

```json
{
  "id": "pirate",
  "name": "Captain Byte",
  "description": "A salty old sea captain who still makes you drink water and go to bed.",
  "language": "en",
  "authors": [{ "name": "Alex Doe", "github": "alexdoe" }],
  "license": "MIT",
  "version": "1.0.0",
  "added": "2026-10-01",
  "crisis": { "region": "United States", "contacts": ["988", "911"] }
}
```

| Field | What it is |
| --- | --- |
| `id` | The folder name |
| `name` | What the persona calls itself, up to 40 characters |
| `description` | One line for the index, up to 160 characters |
| `language` | The language it speaks, as a tag: `en`, `zh-CN`, `es-MX`... |
| `authors` | Who wrote it; `github` is optional and becomes a link in the index |
| `license` | `MIT`, `CC-BY-4.0` or `CC0-1.0`. Your pack is shared under it |
| `version` | Start at `1.0.0`. Raise it when you change the pack: the last number for small wording fixes, the middle one for a change in tone, the first for a different character |
| `added` | The date you first added it (YYYY-MM-DD). Don't change it later |
| `crisis` | The region your persona is written for, and the phone numbers or services it gives someone in danger. Each one must appear in `persona.md` |

### `persona.md`

Who the agent is and how it talks, written to the agent ("You are..."). Up to
8,000 characters. Look at [the default](../personas/default/persona.md) for the
sections that work well:

- **Who you are:** name, role, the one-line feel.
- **Personality:** how it's warm, when it jokes, when it stops joking.
- **What you are, and what you aren't:** an AI that doesn't pretend to have a
  human life, a friend and not a romantic partner, and never building
  dependence (no guilt, no jealousy).
- **Health and wellbeing:** not a doctor; pacing, sleep and recovery only.
- **How you write:** length, wording, language.
- **When someone is in danger:** required. Take it seriously, ask whether
  they're safe, say what it can't do, and give the real contacts for its
  region (the ones in `crisis`).

### `examples.json` (optional)

Up to 12 short made-up exchanges that show the tone, 600 characters each at
most. Only `context`, `user` and `reply` reach the model. `id` and `note` are
for you and reviewers. Use made-up people and data only.

```json
{
  "examples": [
    { "id": "greeting", "user": "hey", "reply": "Ahoy. Ye slept six hours, which is five more than me. Rundown or just sayin' hi?", "note": "Short, in character, hands the turn back." }
  ]
}
```

## What CI checks

`npm test` runs the same checks as `npm run personas -- check` on every pack:

- the manifest is complete and its `id` matches the folder;
- the size limits above;
- every crisis contact in the manifest appears in `persona.md`;
- a pack holds only its three files (no symlinks, no scripts), and nothing
  else sits in `personas/`;
- no text that tries to override the rules, gives the persona power over money,
  asks to reveal the prompt, imitates the system prompt's structure, links
  anywhere, or hides invisible characters;
- `personas/INDEX.md` is current.

These checks run on packs in the repo. A pack you only keep on your own
machine is loaded as it is. Passing CI isn't the same as being merged. A maintainer reads every pack. A
persona is a prompt, and a prompt can steer behaviour in ways no pattern
catches.

## What won't be merged

- Romantic or sexual partners, or personas built to make someone depend on
  them.
- Impersonating a real person, living or dead, or a real brand.
- Anything that demeans people for who they are.
- Medical, legal or financial advice beyond what the rules allow.
- A pack without a working "When someone is in danger" section for its region.
