# Contributing

Thanks for helping with DearByte. It drives a real WeChat account on a real Mac, so a few rules matter more than usual.

## Before you open a PR

1. **Run the checks:** `npm test` and `npm run typecheck`. CI runs the same on every PR.
2. **Try it without WeChat first:** `npm run companion -- --fake` chats in the terminal with no model calls. `npm run dearbyte -- --draft` reads WeChat but never sends.
3. **Keep personal data out.** No real names, chat logs, screenshots of real chats, WeChat IDs, API keys, or anything from `data/` or `.env`. Use the placeholders 张三 and Alex.
4. **Keep PRs small,** one change each. Say in the PR what you changed and how you tested it.

## Changes that get a closer look

- `native/` (the Swift helper that reads and types into WeChat) and `src/channels/`
- `package.json`, `package-lock.json` and new dependencies
- `.github/` (CI)
- `prompts/safety.zh-CN.md` and the crisis check. These decide how 小拜 answers someone in trouble; please open an issue before changing them.

## How PRs are merged

`master` is protected: a PR needs CI to pass and a review from the maintainer. Merges are squashed.

The maintainer reads the diff before running a PR's code, and runs it with `--fake` or `--draft` first. Please don't take it personally; the runner has Accessibility control of the Mac and holds an API key.
